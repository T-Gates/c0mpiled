import { analyzePulse } from './rppg.js';

export const CHECK = Object.freeze({ version: 2, pulseMs: 32000, warmupMs: 2000, stepMs: 1200, settleMs: 450, tailMs: 150, timeoutMs: 65000 });
export const LIGHT_RGB = Object.freeze({ white: [220, 220, 220], red: [220, 90, 90], green: [90, 220, 90], blue: [90, 90, 220] });
const colors = ['red', 'green', 'blue'];
const mean = a => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
const chroma = a => { const total = a?.reduce((s, x) => s + x, 0); return total > 0 ? a.map(x => x / total) : null; };

export function randomSequence(rand = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 2 ** 32; }) {
  const out = [];
  for (let round = 0; round < 2; round++) {
    const c = [...colors];
    for (let i = 2; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
    c.forEach(color => out.push('white', color));
  }
  return out;
}

export function continuity(frames) {
  if (frames.length < 2) return { passed: false, reason: '영상 부족' };
  let previous = null, missingSince = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!Number.isFinite(f.t) || (i && (f.t <= frames[i - 1].t || f.t - frames[i - 1].t > 500))) return { passed: false, reason: '영상 frame 불연속' };
    if (f.faceCount !== 1 || !f.box) {
      missingSince ??= f.t;
      if (f.faceCount > 1 || f.t - missingSince > 500) return { passed: false, reason: '얼굴 상실 또는 여러 얼굴' };
      continue;
    }
    if (previous) {
      const shift = Math.hypot(f.box.x - previous.x, f.box.y - previous.y) / Math.max(.01, previous.w);
      const ratio = f.box.w / Math.max(.01, previous.w);
      if (shift > .35 || ratio > 1.4 || ratio < .7) return { passed: false, reason: '얼굴 위치·크기의 큰 불연속' };
    }
    previous = f.box; missingSince = null;
  }
  const coverage = frames.filter(f => f.faceCount === 1 && f.box).length / frames.length;
  return { passed: coverage >= .95, reason: coverage >= .95 ? '추적 연속성 유지 (identity 인증 아님)' : '얼굴 추적 coverage 부족', coverage };
}

export function analyzeLight(frames, sequence, starts, minDelta = .004) {
  const no = reason => ({ passed: false, status: 'insufficient', reason, deltas: [] });
  if (sequence.length !== 12 || starts.length !== 12 || starts.some((s, i) => !Number.isFinite(s) || (i && s <= starts[i - 1]))) return no('조명 단계 누락');
  const rows = sequence.map((_, i) => frames.filter(f => f.t >= starts[i] + CHECK.settleMs && f.t < starts[i] + CHECK.stepMs - CHECK.tailMs));
  if (rows.some(r => r.length < 5 || r.some(f => !f.face || f.faceCount !== 1 || f.clipped >= .03))) return no('조명 frame 품질 부족');
  const samples = rows.map(r => chroma([0, 1, 2].map(c => mean(r.map(f => f.face[c])))));
  if (samples.some(r => !r || r.some(x => !Number.isFinite(x)))) return no('조명 RGB 오류');
  const deltas = [];
  for (let i = 1; i < sequence.length; i += 2) {
    const target = colors.indexOf(sequence[i]);
    if (sequence[i - 1] !== 'white' || target < 0) return no('조명 순서 오류');
    const delta = samples[i].map((v, c) => v - samples[i - 1][c]);
    const off = Math.max(...delta.filter((_, c) => c !== target));
    deltas.push({ color: sequence[i], delta, passed: delta[target] >= minDelta && delta[target] - off >= minDelta });
  }
  const passed = deltas.every(d => d.passed);
  return { passed, status: passed ? 'matched' : 'mismatch', reason: passed ? '두 차례 무작위 색 응답 일치' : '요청한 색과 얼굴 반응 불일치', deltas };
}

export function evaluateCheck({ frames, pulseStart, pulseEnd, sequence, starts, minDelta }) {
  const track = continuity(frames);
  const pulse = analyzePulse(frames.filter(f => f.t >= pulseStart + CHECK.warmupMs && f.t < pulseEnd));
  const light = analyzeLight(frames, sequence, starts, minDelta);
  const status = !track.passed || !pulse.passed || light.status === 'insufficient' ? 'insufficient' : light.passed ? 'observed' : 'mismatch';
  return { status, label: status === 'observed' ? '검사 조건 충족' : status === 'mismatch' ? '조명 응답 불일치' : '측정 불충분', pulse, light, track, humanVerified: false, deepfakeVerified: false };
}
