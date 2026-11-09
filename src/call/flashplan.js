// Human Check 통화 — 플래시 순서·프레임 구간 나누기·판정 결과 분류 (순수 함수, DOM 금지, node import 가능)

export const CALL_FLASH = { stepMs: 600, discardMs: 300 };
export const FLASH_RGB = {
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
};

const CHANNEL = { red: 0, green: 1, blue: 2 };

export const RESULT_LABELS = {
  human: '✓ 사람 확인됨',
  suspect: '✕ 반사 없음 · 딥페이크 의심',
  unmeasured: '? 얼굴이 잘 안 보여 판정 불가',
};

function cryptoRand() {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0] / 4294967296;
}

function pickIndex(rand, n) {
  let i = Math.floor(rand() * n);
  if (!(i >= 0)) i = 0;
  if (i > n - 1) i = n - 1;
  return i;
}

// → ['white', c1, 'white', c2, 'white', c3], c1~c3은 red/green/blue의 순열
export function makeFlashSequence(rand = cryptoRand) {
  const colors = ['red', 'green', 'blue'];
  for (let i = colors.length - 1; i > 0; i--) {
    const j = pickIndex(rand, i + 1);
    [colors[i], colors[j]] = [colors[j], colors[i]];
  }
  return ['white', colors[0], 'white', colors[1], 'white', colors[2]];
}

// i번째 구간 = [stepStarts[i] + discardMs, end_i), end_i = stepStarts[i+1] ?? stepStarts[i] + stepMs
// 구간 안 face가 null이 아닌 프레임의 평균 RGB. 샘플 0개 또는 stepStarts[i]가 null이면 null.
export function bucketFrames(frames, stepStarts, { stepMs, discardMs }) {
  const fr = frames || [];
  const starts = stepStarts || [];
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    if (s == null) {
      out.push(null);
      continue;
    }
    const from = s + discardMs;
    const to = starts[i + 1] ?? s + stepMs;
    let r = 0, g = 0, b = 0, n = 0;
    for (const f of fr) {
      if (!f || f.face == null) continue;
      if (f.t >= from && f.t < to) {
        r += f.face[0];
        g += f.face[1];
        b += f.face[2];
        n++;
      }
    }
    out.push(n > 0 ? [r / n, g / n, b / n] : null);
  }
  return out;
}

// seq(6) + means(6) → 색 단계 3개 [{color, baseline, sample}]
export function buildFaceSteps(seq, means) {
  const m = means || [];
  return [1, 3, 5].map((i) => ({
    color: seq[i],
    baseline: m[i - 1] ?? null,
    sample: m[i] ?? null,
  }));
}

// judge = judgeColorSteps 결과 → { status, label, deltas }
export function classifyResult(steps, judge) {
  const unmeasured = (steps || []).some((s) => !s || s.baseline == null || s.sample == null);
  let status;
  if (judge && judge.passed) status = 'human';
  else if (unmeasured) status = 'unmeasured';
  else status = 'suspect';

  const deltas = { red: null, green: null, blue: null };
  const details = (judge && judge.details) || [];
  for (const color of Object.keys(deltas)) {
    const d = details.find((x) => x && x.color === color);
    if (d && Array.isArray(d.delta)) {
      const v = d.delta[CHANNEL[color]];
      deltas[color] = Number.isFinite(v) ? v : null;
    }
  }
  return { status, label: RESULT_LABELS[status], deltas };
}
