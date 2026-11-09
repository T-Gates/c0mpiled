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

function shuffled(rand, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = pickIndex(rand, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// v1.1: 흰색 없이 색만. 길이 6 = red/green/blue 순열 2개를 이어 붙임.
// 두 번째 순열은 "첫 색 ≠ 첫 순열의 마지막 색"인 4개 순열 중에서 균등하게 고른다
// (첫 색을 허용된 2색 중에서 고르고 나머지 2색을 섞음 → 거절 표본추출 없이 항상 끝남).
export function makeFlashSequence(rand = cryptoRand) {
  const colors = ['red', 'green', 'blue'];
  const first = shuffled(rand, colors);
  const last = first[first.length - 1];
  const allowed = colors.filter((c) => c !== last);
  const head = allowed[pickIndex(rand, allowed.length)];
  const second = [head, ...shuffled(rand, colors.filter((c) => c !== head))];
  return [...first, ...second];
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

function meanRgb(list) {
  const xs = list.filter((v) => v != null);
  if (xs.length === 0) return null;
  const out = [0, 0, 0];
  for (const v of xs) for (let k = 0; k < 3; k++) out[k] += v[k];
  return out.map((x) => x / xs.length);
}

// v1.1: seq(6) + means(6) → red, green, blue 순서로 단계 1개씩
//   sample = 그 색 구간들 평균의 평균, baseline = 다른 두 색(각 색의 구간 평균)의 평균. null은 빼고, 없으면 null.
export function buildFaceSteps(seq, means) {
  const m = means || [];
  const perColor = {};
  for (const c of ['red', 'green', 'blue']) {
    perColor[c] = meanRgb((seq || []).map((sc, i) => (sc === c ? m[i] ?? null : null)));
  }
  return ['red', 'green', 'blue'].map((c) => ({
    color: c,
    sample: perColor[c],
    baseline: meanRgb(['red', 'green', 'blue'].filter((o) => o !== c).map((o) => perColor[o])),
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

// ---------- v1.1 얼굴 맞추기 ----------
export const ALIGN = { cy: 0.47, ry: 0.27, aspect: 0.64, sizeMin: 0.7, sizeMax: 1.3, holdMs: 800, timeoutMs: 20000 };

// 타원: 중심 (0.5·W, cy·H), 반높이 ry·H(px), 반너비 = 반높이(px) × aspect
// size = 얼굴 bbox 높이(px) / 타원 높이(2·ry·H), inside = bbox 중심이 타원 안
// → { found, aligned, size, inside, hint: 'no_face'|'closer'|'farther'|'center'|'ok' }
export function faceAlignment(landmarks, W, H, align = ALIGN) {
  if (!landmarks || landmarks.length === 0 || !(W > 0) || !(H > 0)) {
    return { found: false, aligned: false, size: null, inside: false, hint: 'no_face' };
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const ryPx = align.ry * H;
  const rxPx = ryPx * align.aspect;
  const size = ((maxY - minY) * H) / (2 * ryPx);
  const dx = ((minX + maxX) / 2) * W - 0.5 * W;
  const dy = ((minY + maxY) / 2) * H - align.cy * H;
  const inside = (dx / rxPx) ** 2 + (dy / ryPx) ** 2 <= 1;
  let hint;
  if (size < align.sizeMin) hint = 'closer';
  else if (size > align.sizeMax) hint = 'farther';
  else if (!inside) hint = 'center';
  else hint = 'ok';
  return { found: true, aligned: hint === 'ok', size, inside, hint };
}

// 숫자 배열의 중앙값 (빈 배열이면 null)
export function median(values) {
  const xs = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
