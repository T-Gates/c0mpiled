// Human Check — 순수 판정 함수 (DOM/브라우저 API 의존 없음, node에서 import 가능)

export const POSES = {
  open:  [true,  true,  true,  true,  true ],
  fist:  [false, false, false, false, false],
  point: [false, true,  false, false, false],
  peace: [false, true,  true,  false, false],
  three: [false, true,  true,  true,  false],
  rock:  [false, true,  false, false, true ],
};
// 순서: [thumb, index, middle, ring, pinky]

export const DEFAULTS = {
  minDelta: 0.004,
  passRatio: 0.8,
  extendedDeg: 160,
  thumbExtendedDeg: 150,
  maxGapMs: 200,
  maxAngleJumpDeg: 70,
  maxLandmarkJump: 0.5,
};

const COLOR_CHANNEL = { red: 0, green: 1, blue: 2 };
const FINGER_JOINTS = {
  thumb:  [2, 3, 4],
  index:  [5, 6, 8],
  middle: [9, 10, 12],
  ring:   [13, 14, 16],
  pinky:  [17, 18, 20],
};
const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];

function withDefaults(opts) {
  return { ...DEFAULTS, ...(opts || {}) };
}

export function chroma(rgb) {
  const [r, g, b] = rgb;
  const s = r + g + b;
  if (s === 0) return [1 / 3, 1 / 3, 1 / 3];
  return [r / s, g / s, b / s];
}

// 점 a-b-c에서 b의 각도(도). 3D 벡터 사이 각도.
function angleAt(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v1z = (a.z || 0) - (b.z || 0);
  const v2x = c.x - b.x, v2y = c.y - b.y, v2z = (c.z || 0) - (b.z || 0);
  const n1 = Math.hypot(v1x, v1y, v1z);
  const n2 = Math.hypot(v2x, v2y, v2z);
  if (n1 === 0 || n2 === 0) return 0; // 퇴화 입력: 각도 정의 불가 → 0(굽힘)으로 처리
  let cos = (v1x * v2x + v1y * v2y + v1z * v2z) / (n1 * n2);
  if (cos > 1) cos = 1;
  if (cos < -1) cos = -1;
  return (Math.acos(cos) * 180) / Math.PI;
}

export function fingerAngles(landmarks) {
  const out = {};
  for (const name of FINGER_NAMES) {
    const [a, b, c] = FINGER_JOINTS[name];
    out[name] = angleAt(landmarks[a], landmarks[b], landmarks[c]);
  }
  return out;
}

export function fingerStates(landmarks, opts = DEFAULTS) {
  const o = withDefaults(opts);
  const ang = fingerAngles(landmarks);
  return [
    ang.thumb > o.thumbExtendedDeg,
    ang.index > o.extendedDeg,
    ang.middle > o.extendedDeg,
    ang.ring > o.extendedDeg,
    ang.pinky > o.extendedDeg,
  ];
}

export function poseMatches(states, target, { ignoreThumb = true } = {}) {
  for (let i = ignoreThumb ? 1 : 0; i < 5; i++) {
    if (Boolean(states[i]) !== Boolean(target[i])) return false;
  }
  return true;
}

export function pickPoseSequence(n, rand = Math.random) {
  const keys = Object.keys(POSES);
  const out = [];
  for (let i = 0; i < n; i++) {
    const pool = i === 0 ? keys : keys.filter((k) => k !== out[i - 1]);
    let idx = Math.floor(rand() * pool.length);
    if (!(idx >= 0)) idx = 0;
    if (idx > pool.length - 1) idx = pool.length - 1;
    out.push(pool[idx]);
  }
  return out;
}

export function judgeColorSteps(steps, opts = DEFAULTS) {
  const o = withDefaults(opts);
  const details = [];
  let matched = 0;
  for (const step of steps || []) {
    const { color, baseline, sample } = step;
    let delta = null;
    let ok = false;
    if (baseline != null && sample != null) {
      const cs = chroma(sample);
      const cb = chroma(baseline);
      delta = [cs[0] - cb[0], cs[1] - cb[1], cs[2] - cb[2]];
      const t = COLOR_CHANNEL[color];
      if (t !== undefined) {
        const d = delta[t];
        ok = d > o.minDelta && d >= delta[0] && d >= delta[1] && d >= delta[2];
      }
    }
    if (ok) matched++;
    details.push({ color, delta, matched: ok });
  }
  const total = details.length;
  const passed = total > 0 && matched >= Math.ceil(total * o.passRatio);
  return { passed, matched, total, details };
}

function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function checkTransition(frames, opts = DEFAULTS) {
  const o = withDefaults(opts);
  const fr = frames || [];
  let maxGap = 0;
  let maxJump = 0;
  let maxAngleJump = 0;
  let nonNull = 0;
  let gapStart = null;

  for (let i = 0; i < fr.length; i++) {
    const f = fr[i];
    if (f.landmarks == null) {
      if (gapStart === null) gapStart = f.t;
      continue;
    }
    nonNull++;
    if (gapStart !== null) {
      maxGap = Math.max(maxGap, f.t - gapStart);
      gapStart = null;
    }
    const prev = i > 0 ? fr[i - 1] : null;
    if (prev && prev.landmarks != null) {
      const a = prev.landmarks;
      const b = f.landmarks;
      const size = dist2D(a[0], a[9]);
      let disp = 0;
      for (let k = 0; k < 21; k++) disp = Math.max(disp, dist2D(a[k], b[k]));
      const jump = size > 0 ? disp / size : (disp > 0 ? Infinity : 0);
      maxJump = Math.max(maxJump, jump);
      const angA = fingerAngles(a);
      const angB = fingerAngles(b);
      for (const name of FINGER_NAMES) {
        maxAngleJump = Math.max(maxAngleJump, Math.abs(angB[name] - angA[name]));
      }
    }
  }
  if (gapStart !== null && fr.length > 0) {
    maxGap = Math.max(maxGap, fr[fr.length - 1].t - gapStart);
  }

  let reason = null;
  if (nonNull < 2) {
    reason = '전환 구간에서 손이 거의 검출되지 않았습니다';
  } else if (maxGap > o.maxGapMs) {
    reason = `손이 ${Math.round(maxGap)}ms 동안 사라졌습니다 (허용 ${o.maxGapMs}ms)`;
  } else if (maxJump > o.maxLandmarkJump) {
    reason = `손 위치가 비정상적으로 순간 이동했습니다 (${maxJump.toFixed(2)} > ${o.maxLandmarkJump})`;
  } else if (maxAngleJump > o.maxAngleJumpDeg) {
    reason = `손가락 각도가 한 프레임에 ${Math.round(maxAngleJump)}° 변했습니다 (허용 ${o.maxAngleJumpDeg}°)`;
  }
  return { ok: reason === null, reason, maxGapMs: maxGap, maxJump, maxAngleJump };
}

// ---------- v1.3 4분할 빛 입체 판정 ----------
export const QUAD_DEFAULTS = { minSwingH: 0.05 };

const QUAD_LEFT = new Set(['TL', 'BL']);
const QUAD_RIGHT = new Set(['TR', 'BR']);
const QUAD_TOP = new Set(['TL', 'TR']);
const QUAD_BOTTOM = new Set(['BL', 'BR']);

function logRatio(a, b) {
  if (a == null || b == null || !(a > 0) || !(b > 0)) return null;
  return Math.log(a / b);
}

function groupMeanDiff(details, key, groupA, groupB) {
  let sa = 0, na = 0, sb = 0, nb = 0;
  for (const d of details) {
    const v = d[key];
    if (v == null) continue;
    if (groupA.has(d.quad)) { sa += v; na++; }
    else if (groupB.has(d.quad)) { sb += v; nb++; }
  }
  if (na === 0 || nb === 0) return null;
  return sa / na - sb / nb;
}

export function judgeQuadrants(steps, opts = QUAD_DEFAULTS) {
  const o = { ...QUAD_DEFAULTS, ...(opts || {}) };
  const details = (steps || []).map((s) => {
    const r = s && s.rois;
    return {
      quad: s ? s.quad : null,
      hx: r ? logRatio(r.L, r.R) : null,
      vy: r ? logRatio(r.T, r.B) : null,
    };
  });
  const H = groupMeanDiff(details, 'hx', QUAD_LEFT, QUAD_RIGHT);
  const V = groupMeanDiff(details, 'vy', QUAD_TOP, QUAD_BOTTOM);
  return { passed: H !== null && H > o.minSwingH, H, V, details, threshold: o.minSwingH };
}

export function finalVerdict({ poses, transitions, colorHand, colorFace, quadFace }) {
  const reasons = [];
  const failedPoses = (poses || []).filter((p) => !p.matched);
  if (failedPoses.length > 0) {
    reasons.push(`손 모양 과제 실패: ${failedPoses.map((p) => p.name).join(', ')}`);
  }
  const failedTr = (transitions || []).filter((t) => !t.ok);
  if (failedTr.length > 0) {
    const detail = failedTr.map((t) => t.reason).filter(Boolean).join(' / ');
    reasons.push(`손 모양 전환이 자연스럽지 않음${detail ? `: ${detail}` : ''}`);
  }
  if (!colorHand || !colorHand.passed) {
    const m = colorHand ? `${colorHand.matched}/${colorHand.total}` : '0/0';
    reasons.push(`손바닥에서 화면 색 반사가 충분히 확인되지 않음 (${m})`);
  }
  if (!colorFace || !colorFace.passed) {
    const m = colorFace ? `${colorFace.matched}/${colorFace.total}` : '0/0';
    reasons.push(`얼굴에서 화면 색 반사가 충분히 확인되지 않음 (${m})`);
  }
  if (quadFace && !quadFace.passed) {
    const h = quadFace.H == null ? '측정 불가' : quadFace.H.toFixed(3);
    const thr = Number.isFinite(quadFace.threshold) ? quadFace.threshold : QUAD_DEFAULTS.minSwingH;
    reasons.push(`빛 방향에 따른 얼굴 입체 반응이 확인되지 않음 (H=${h}, 기준 > ${thr})`);
  }
  return { passed: reasons.length === 0, reasons };
}


// ---------- v1.4 데이터 수집·기준값 보정 ----------

// judgeColorSteps 입력 형식 → 유효 단계(baseline·sample non-null, 알려진 색)의 목표 채널 Δ 배열 (순서 유지)
export function stepTargetDeltas(steps) {
  const out = [];
  for (const step of steps || []) {
    if (!step || step.baseline == null || step.sample == null) continue;
    const t = COLOR_CHANNEL[step.color];
    if (t === undefined) continue;
    out.push(chroma(step.sample)[t] - chroma(step.baseline)[t]);
  }
  return out;
}

function meanOrNull(arr) {
  if (!arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

export function roundFeatures({ handSteps, faceSteps, quadSteps } = {}) {
  const jh = judgeColorSteps(handSteps || [], DEFAULTS);
  const jf = judgeColorSteps(faceSteps || [], DEFAULTS);
  const q = judgeQuadrants(quadSteps || [], QUAD_DEFAULTS);
  return {
    handDeltaMean: meanOrNull(stepTargetDeltas(handSteps)),
    faceDeltaMean: meanOrNull(stepTargetDeltas(faceSteps)),
    handMatchRatio: jh.total > 0 ? jh.matched / jh.total : null,
    faceMatchRatio: jf.total > 0 ? jf.matched / jf.total : null,
    H: q.H,
    V: q.V,
  };
}

const validNums = (arr) => (arr || []).filter((v) => typeof v === 'number' && !Number.isNaN(v));

// 규칙: value > t 이면 진짜. balancedAccuracy 최대 t (동률이면 더 작은 t).
export function bestThreshold(pos, neg) {
  const P = validNums(pos);
  const N = validNums(neg);
  if (P.length === 0 || N.length === 0) return null;
  const uniq = [...new Set([...P, ...N])].sort((a, b) => a - b);
  const cands = [uniq[0] - 1e-9];
  for (let i = 0; i + 1 < uniq.length; i++) cands.push((uniq[i] + uniq[i + 1]) / 2);
  cands.push(uniq[uniq.length - 1]);
  cands.sort((a, b) => a - b);
  let best = null;
  for (const t of cands) {
    let tp = 0, tn = 0;
    for (const v of P) if (v > t) tp++;
    for (const v of N) if (!(v > t)) tn++;
    const tpr = tp / P.length;
    const tnr = tn / N.length;
    const ba = (tpr + tnr) / 2;
    if (best === null || ba > best.balancedAccuracy) {
      best = { threshold: t, balancedAccuracy: ba, tpr, tnr };
    }
  }
  return best;
}

// ---------- v1.5 반사 패턴 진단 (설명용, 판정 R7에는 영향 없음) ----------
export const DIAG_DEFAULTS = {
  minDelta: 0.004,
  minSwingH: 0.05,
  quadSpreadMin: 0.02,
  blockDrop: 0.08,
  skewFactor: 3,
};

const DIAG_COLORS = ['red', 'green', 'blue'];
const DIAG_QUADS = ['TL', 'TR', 'BL', 'BR'];
const COLOR_KO = { red: '빨강', green: '초록', blue: '파랑' };
const QUAD_KO = { TL: '왼쪽 위', TR: '오른쪽 위', BL: '왼쪽 아래', BR: '오른쪽 아래' };

const posNum = (v) => typeof v === 'number' && v > 0;

export function diagnoseRound({ handSteps, faceSteps, quadSteps } = {}, opts = DIAG_DEFAULTS) {
  const o = { ...DIAG_DEFAULTS, ...(opts || {}) };
  const colorSteps = [...(handSteps || []), ...(faceSteps || [])];

  const colorStrength = {};
  for (const c of DIAG_COLORS) {
    colorStrength[c] = meanOrNull(stepTargetDeltas(colorSteps.filter((s) => s && s.color === c)));
  }

  const quadLuma = {};
  for (const q of DIAG_QUADS) {
    const vals = [];
    for (const s of quadSteps || []) {
      if (!s || s.quad !== q || !s.rois) continue;
      const { L, R, T, B } = s.rois;
      if (posNum(L) && posNum(R) && posNum(T) && posNum(B)) vals.push((L + R + T + B) / 4);
    }
    quadLuma[q] = meanOrNull(vals);
  }

  let quadSpread = null;
  let quadMin = null;
  const lumaVals = DIAG_QUADS.map((q) => quadLuma[q]);
  if (lumaVals.every((v) => v !== null)) {
    const mean = lumaVals.reduce((a, b) => a + b, 0) / 4;
    quadSpread = mean > 0 ? (Math.max(...lumaVals) - Math.min(...lumaVals)) / mean : null;
    let minQ = DIAG_QUADS[0];
    for (const q of DIAG_QUADS) if (quadLuma[q] < quadLuma[minQ]) minQ = q;
    const rest = DIAG_QUADS.filter((q) => q !== minQ).map((q) => quadLuma[q]);
    const restMean = rest.reduce((a, b) => a + b, 0) / rest.length;
    quadMin = { quad: minQ, ratio: restMean > 0 ? quadLuma[minQ] / restMean : null };
    if (quadMin.ratio === null) quadMin = null;
  }

  const H = judgeQuadrants(quadSteps || [], { minSwingH: o.minSwingH }).H;

  const strengths = DIAG_COLORS.map((c) => colorStrength[c]).filter((v) => v !== null);
  const maxStrength = strengths.length ? Math.max(...strengths) : null;
  const weakColors = DIAG_COLORS.filter((c) => colorStrength[c] !== null && colorStrength[c] <= o.minDelta);

  let code;
  let message;
  if (strengths.length === 0 && lumaVals.every((v) => v === null)) {
    code = 'insufficient';
    message = '측정 데이터 부족: 얼굴/손 미검출';
  } else if ((maxStrength === null || maxStrength <= o.minDelta) && (quadSpread === null || quadSpread < o.quadSpreadMin)) {
    code = 'no_reflection';
    message = '반사 없음: 가상 카메라·녹화 영상 의심';
  } else if (quadMin !== null && quadMin.ratio < 1 - o.blockDrop) {
    code = 'screen_blocked';
    message = `화면 일부 가림 의심: ${QUAD_KO[quadMin.quad]} 사분면 반응 약함 (−${Math.round((1 - quadMin.ratio) * 100)}%)`;
  } else if (maxStrength !== null && maxStrength >= o.minDelta * o.skewFactor && weakColors.length > 0) {
    code = 'color_tampered';
    message = `화면 색 변조 의심(필터·야간 모드): ${weakColors.map((c) => COLOR_KO[c]).join('·')} 반응 없음`;
  } else if (maxStrength !== null && maxStrength <= o.minDelta) {
    code = 'weak_color';
    message = '색 반사 약함: 화면 밝기 최대·주변 조명 줄이기 확인';
  } else if (H === null) {
    code = 'insufficient';
    message = '입체 측정 데이터 부족: 얼굴 미검출';
  } else if (H <= o.minSwingH) {
    code = 'flat_object';
    message = '평면 물체 의심: 빛 방향에 따른 입체 반응 없음';
  } else {
    code = 'ok';
    message = '정상 반사';
  }

  return { code, message, evidence: { colorStrength, quadLuma, quadSpread, quadMin, H, weakColors } };
}
