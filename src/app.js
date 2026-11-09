// Human Check — 카메라, MediaPipe, 진행 흐름, 렌더링
import {
  FilesetResolver,
  HandLandmarker,
  FaceLandmarker,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
import {
  POSES,
  DEFAULTS,
  chroma,
  fingerAngles,
  fingerStates,
  poseMatches,
  pickPoseSequence,
  judgeColorSteps,
  judgeQuadrants,
  QUAD_DEFAULTS,
  finalVerdict,
  roundFeatures,
  diagnoseRound,
} from './judge.js';

// ---------- 상수 ----------
const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const N_POSES = 3;
const HOLD_MS = 500;          // 모양 단계: 연속 일치 시 "인식됨" (시간 제한 없음 — '다음'으로 진행)
const STEP_MS = 500;          // 색 단계: 각 구간 길이
const DISCARD_MS = 200;       // 각 구간 앞부분 버림
const HOLD_FAIL_RATIO = 0.5;  // 색 단계 중 불일치 프레임 비율이 이 이상이면 실패

const COLOR_RGB = {
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
};
const COLOR_EN = { white: 'White', red: 'Red', green: 'Green', blue: 'Blue' };
const CHANNEL_KO = { red: 'R', green: 'G', blue: 'B' };
const CHANNEL_IDX = { red: 0, green: 1, blue: 2 };
const POSE_EN = {
  open: 'Open hand (all five fingers)',
  fist: 'Fist',
  point: 'Index finger only',
  peace: 'Peace (index + middle)',
  three: 'Three (index, middle, ring)',
  rock: 'Rock (index + pinky)',
};
const FINGER_EN = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const PALM_IDX = [0, 1, 5, 9, 13, 17];
const FACE_ROI_IDX = [50, 280, 151];
const FACE_ROI_RADIUS = 0.06;
// v1.3 입체 단계: 2×2 사분면 중 하나만 흰색, 4개 셔플 × 2회, 각 STEP_MS
const QUADS = ['TL', 'TR', 'BL', 'BR'];
const QUAD_REPEAT = 2;
const QUAD_EN = { TL: 'top-left', TR: 'top-right', BL: 'bottom-left', BR: 'bottom-right' };
const QUAD_LM = { cheekA: 50, cheekB: 280, T: 151, B: 152 };
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const bg = $('bg');
const previewBox = $('preview');
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const perfEl = $('perf');
const hud = $('hud');
const hudStep = $('hudStep');
const hudTitle = $('hudTitle');
const hudDetail = $('hudDetail');
const errorBox = $('error');
const hudVerdict = $('hudVerdict');
const hudLog = $('hudLog');
const rawJson = $('rawJson');
const nextBtn = $('nextBtn');
const nextLbl = $('nextLbl');
const restartBtn = $('restartBtn');
const lblFace = $('lblFace');
const lblHand = $('lblHand');
const quadLit = $('quadLit');
const startScreen = $('startScreen');
const startBtn = $('startBtn');
const loadStatus = $('loadStatus');

const labelSel = $('labelSel');
const dataCounts = $('dataCounts');
const dlBtn = $('dlBtn');
const clearBtn = $('clearBtn');
const calibStatus = $('calibStatus');

const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });

// ---------- 유틸 ----------
function cryptoRand() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(cryptoRand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const rgbCss = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 4) => (v == null || !Number.isFinite(v) ? '–' : (v >= 0 ? '+' : '') + v.toFixed(d));

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add('show');
}
function clearError() {
  errorBox.textContent = '';
  errorBox.classList.remove('show');
}

// ---------- 모델 ----------
let handLm = null;
let faceLm = null;
let delegates = {};
let modelsPromise = null;

async function createWithFallback(Cls, vision, options, key) {
  try {
    const lm = await Cls.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'GPU' },
    });
    delegates[key] = 'GPU';
    return lm;
  } catch (e) {
    console.warn(`${key}: GPU delegate 실패, CPU로 재시도`, e);
    const lm = await Cls.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' },
    });
    delegates[key] = 'CPU';
    return lm;
  }
}

async function loadModels() {
  loadStatus.textContent = 'Loading models…';
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
  [handLm, faceLm] = await Promise.all([
    createWithFallback(
      HandLandmarker,
      vision,
      { baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: 'VIDEO', numHands: 1 },
      'hand',
    ),
    createWithFallback(
      FaceLandmarker,
      vision,
      { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: 'VIDEO', numFaces: 1 },
      'face',
    ),
  ]);
  loadStatus.textContent = `Models ready (hand: ${delegates.hand}, face: ${delegates.face})`;
}

function ensureModels() {
  if (!modelsPromise) {
    modelsPromise = loadModels().catch((e) => {
      modelsPromise = null; // 다음 시도에서 재시도
      loadStatus.textContent = 'Failed to load models';
      throw e;
    });
  }
  return modelsPromise;
}

// ---------- 카메라 ----------
let stream = null;

async function ensureCamera() {
  if (stream && stream.getVideoTracks().some((t) => t.readyState === 'live')) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera is not available in this browser. Open this page via http://localhost or https.');
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      throw new Error('Camera permission was denied. Allow camera access in the browser address bar and try again.');
    }
    if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) {
      throw new Error('No camera was found.');
    }
    if (e && e.name === 'NotReadableError') {
      throw new Error('Could not open the camera. Check whether another app is using it.');
    }
    throw new Error(`Failed to start camera: ${e && e.message ? e.message : e}`);
  }
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((res) => video.addEventListener('loadedmetadata', res, { once: true }));
  }
  sizeOverlay(); // 첫 프레임 전에도 미리보기 박스 비율이 맞도록
}


// ---------- 판정 기준 (v1.4: calibration.json으로 덮어쓰기) ----------
const TH = { minDelta: DEFAULTS.minDelta, minSwingH: QUAD_DEFAULTS.minSwingH, calibrated: false };
const colorOpts = () => ({ ...DEFAULTS, minDelta: TH.minDelta });
const quadOpts = () => ({ ...QUAD_DEFAULTS, minSwingH: TH.minSwingH });
const diagOpts = () => ({ minDelta: TH.minDelta, minSwingH: TH.minSwingH }); // v1.5: 보정 기준 적용, 나머지는 DIAG_DEFAULTS

function renderCalibStatus() {
  calibStatus.textContent = TH.calibrated
    ? `Calibrated thresholds: minDelta=${TH.minDelta}, minSwingH=${TH.minSwingH}`
    : 'Default thresholds';
  calibStatus.classList.toggle('on', TH.calibrated);
}

async function loadCalibration() {
  try {
    const res = await fetch('./calibration.json', { cache: 'no-store' });
    if (!res.ok) return;
    const c = await res.json();
    let applied = false;
    if (c && typeof c.minDelta === 'number' && Number.isFinite(c.minDelta)) {
      TH.minDelta = c.minDelta;
      applied = true;
    }
    if (c && typeof c.minSwingH === 'number' && Number.isFinite(c.minSwingH)) {
      TH.minSwingH = c.minSwingH;
      applied = true;
    }
    TH.calibrated = applied;
  } catch (e) {
    console.warn('calibration.json 읽기 실패 — 기본 기준 사용', e);
  } finally {
    renderCalibStatus();
    if (S) renderLog();
  }
}

// ---------- 데이터 수집 (v1.4) ----------
const DATASET_KEY = 'humancheck.dataset';
const LABELS = ['real', 'phone', 'obs', 'block'];
let dataset = [];

function loadDataset() {
  try {
    const raw = localStorage.getItem(DATASET_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    dataset = Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('저장된 데이터셋을 읽지 못했습니다', e);
    dataset = [];
  }
}
function saveDataset() {
  try {
    localStorage.setItem(DATASET_KEY, JSON.stringify(dataset));
  } catch (e) {
    console.warn('데이터셋 저장 실패 (메모리에만 보관)', e);
  }
}
function renderCounts() {
  const n = { real: 0, phone: 0, obs: 0, block: 0 };
  for (const r of dataset) if (r && n[r.label] !== undefined) n[r.label]++;
  dataCounts.textContent = `Real ${n.real} · Phone ${n.phone} · OBS ${n.obs} · Blocked ${n.block}`;
}
function currentLabel() {
  return LABELS.includes(labelSel.value) ? labelSel.value : 'real';
}
// judge 입력 형식으로 정규화 (앱 내부 단계 객체의 부가 필드 제거) — roundFeatures·diagnoseRound 공용
function judgeInputs() {
  return {
    handSteps: S.handSteps.map(({ color, baseline, sample }) => ({ color, baseline, sample })),
    faceSteps: S.faceSteps.map(({ color, baseline, sample }) => ({ color, baseline, sample })),
    quadSteps: S.quadSteps.map(({ quad, rois }) => ({ quad, rois })),
  };
}
// 라운드 완료 시 1건 기록.
function recordRound() {
  const { handSteps, faceSteps, quadSteps } = judgeInputs();
  const rec = {
    label: currentLabel(),
    ts: new Date().toISOString(),
    features: roundFeatures({ handSteps, faceSteps, quadSteps }),
    diag: diagnoseRound({ handSteps, faceSteps, quadSteps }, diagOpts()),
    handSteps,
    faceSteps,
    quadSteps,
  };
  dataset.push(rec);
  saveDataset();
  renderCounts();
  return rec;
}
function datasetFilename(d = new Date()) {
  const p = (v) => String(v).padStart(2, '0');
  return `humancheck-dataset-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}
function downloadDataset() {
  const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = datasetFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function clearDataset() {
  if (!confirm(`Delete all ${dataset.length} collected records? This cannot be undone.`)) return;
  dataset = [];
  try {
    localStorage.removeItem(DATASET_KEY);
  } catch (e) {
    console.warn('저장소 비우기 실패', e);
  }
  renderCounts();
}
// 스모크·디버그용 읽기 전용 접근
Object.defineProperty(window, '__humanCheckDataset', { get: () => dataset });

// ---------- 진행 상태 ----------
// 수동 테스트 모드: 시간 제한 없음. 한 화면(미리보기 + HUD)에서 '다음'(또는 Space)으로 진행.
// phase: 'pose' → (다음) → 'color'(3초) → 'quad'(입체 4초, 자동) → 다음 pose 'pose' … 3번째 입체 단계 후 'done' → (다음) 새 라운드
let S = null;

function newRun(round = 1) {
  const seq = pickPoseSequence(N_POSES, cryptoRand);
  return {
    round,
    phase: 'pose',
    seq,
    poseIdx: 0,
    poses: seq.map((name) => ({
      name,
      latched: false, // poseMatches 연속 HOLD_MS → "인식됨" (이후 유지)
      latchT: null,
      matched: false, // = latched && 색 단계 중 유지
      done: false, // 색 단계까지 끝났는지
      holdTotal: 0,
      holdMiss: 0,
      failStage: null,
      failReason: null,
      quad: null, // judgeQuadrants 결과 (이 pose의 입체 단계 8개)
    })),
    poseStart: null,
    matchStart: null,
    // 색 단계
    colorStart: null,
    colorSeq: null,
    acc: null,
    holdTotal: 0,
    holdMiss: 0,
    colorPhases: [],
    handSteps: [],
    faceSteps: [],
    stepMeta: [],
    // 입체 단계
    quadStart: null,
    quadSeq: null,
    quadAcc: null,
    quadSteps: [], // 모든 pose의 입체 단계 누적 [{ pose, poseIdx, quad, rois, frames, kept, faceN }]
  };
}

function newQuadAcc() {
  const z = () => ({ sum: 0, n: 0 });
  return { frames: 0, kept: 0, faceN: 0, L: z(), R: z(), T: z(), B: z() };
}
const ymean = (a) => (a.n > 0 ? a.sum / a.n : null);

function newAcc() {
  return {
    frames: 0,
    kept: 0,
    faceAl: 0, // 얼굴 가이드 정렬 프레임 수
    handAl: 0, // 손 가이드 정렬 프레임 수
    hand: { sum: [0, 0, 0], n: 0 },
    face: { sum: [0, 0, 0], n: 0 },
  };
}
function accMean(a) {
  return a.n > 0 ? [a.sum[0] / a.n, a.sum[1] / a.n, a.sum[2] / a.n] : null;
}
function accAdd(a, rgb) {
  a.sum[0] += rgb[0];
  a.sum[1] += rgb[1];
  a.sum[2] += rgb[2];
  a.n++;
}

// ---------- 흐름 ----------
async function startRun() {
  clearError();
  startBtn.disabled = true;
  try {
    loadStatus.textContent = 'Preparing camera and models…';
    await Promise.all([ensureModels(), ensureCamera()]);
  } catch (e) {
    console.error(e);
    showError(e && e.message ? e.message : String(e));
    startBtn.disabled = false;
    startScreen.classList.remove('hidden');
    return;
  }
  startBtn.disabled = false;
  startScreen.classList.add('hidden');
  document.body.classList.add('running');
  previewBox.classList.add('show');
  hud.classList.add('show');
  bg.classList.add('dark');
  bg.style.background = '';
  S = newRun(1);
  renderLog();
  setNextBtn();
  startLoop();
}

// 새 라운드 (카메라·모델·루프 재사용)
function restartRun() {
  if (!S) return;
  S = newRun(S.round + 1);
  setQuadVisual(null);
  setMeasuring(false);
  bg.style.background = '';
  renderLog();
  setNextBtn();
}

function nowTs() {
  let t = Math.round(performance.now());
  if (t <= lastTs) t = lastTs + 1;
  lastTs = t;
  return t;
}

// '다음' 버튼 / Space
function onNext() {
  if (!S || !looping) return;
  if (S.phase === 'pose') {
    if (S.poseStart == null) return; // 첫 프레임 전
    beginColor(nowTs());
  } else if (S.phase === 'done') {
    restartRun();
  }
  // 'color'/'quad' 단계(측정 중)에서는 무시
}

function beginPose(t) {
  S.phase = 'pose';
  S.poseStart = t;
  S.matchStart = null;
  setNextBtn();
}

function beginColor(t) {
  S.phase = 'color';
  S.colorStart = t;
  const order = shuffle(['red', 'green', 'blue']);
  S.colorSeq = ['white', order[0], 'white', order[1], 'white', order[2]];
  S.acc = S.colorSeq.map(() => newAcc());
  S.holdTotal = 0;
  S.holdMiss = 0;
  setMeasuring(true);
  setNextBtn();
  renderColorHud(t, null);
  requestAnimationFrame(colorTick);
}

// 화면 색은 타임스탬프 기준으로 rAF에서 갱신 (setTimeout 누적 오차 없음)
function colorTick() {
  if (!S || S.phase !== 'color') return;
  const k = Math.floor((performance.now() - S.colorStart) / STEP_MS);
  if (k >= S.colorSeq.length) {
    bg.style.background = '';
    return;
  }
  if (k >= 0) bg.style.background = rgbCss(COLOR_RGB[S.colorSeq[k]]);
  requestAnimationFrame(colorTick);
}

function endColor(t) {
  const pose = S.poses[S.poseIdx];
  const missRatio = S.holdTotal > 0 ? S.holdMiss / S.holdTotal : 1;
  const held = S.holdTotal > 0 && missRatio < HOLD_FAIL_RATIO;
  pose.holdTotal = S.holdTotal;
  pose.holdMiss = S.holdMiss;
  pose.matched = pose.latched && held;
  pose.done = true;
  if (!pose.latched) {
    pose.failStage = 'pose';
    pose.failReason = 'Moved on before the pose was recognized (0.5s hold)';
  } else if (!held) {
    pose.failStage = 'color';
    pose.failReason = `Pose not held during color check (${Math.round(missRatio * 100)}% mismatch)`;
  }

  const stepsOut = [];
  for (let i = 0; i < 3; i++) {
    const w = S.acc[2 * i];
    const c = S.acc[2 * i + 1];
    const color = S.colorSeq[2 * i + 1];
    const hs = { color, baseline: accMean(w.hand), sample: accMean(c.hand) };
    const fs = { color, baseline: accMean(w.face), sample: accMean(c.face) };
    // 정렬은 안내용 — 판정에 쓰지 않고 원본 데이터로만 남김 (white+색 구간 프레임의 과반 정렬이면 true)
    const fr = w.frames + c.frames;
    const faceAligned = fr > 0 && (w.faceAl + c.faceAl) / fr >= 0.5;
    const handAligned = fr > 0 && (w.handAl + c.handAl) / fr >= 0.5;
    S.handSteps.push(hs);
    S.faceSteps.push(fs);
    S.stepMeta.push({ pose: pose.name, poseIdx: S.poseIdx, color, faceAligned, handAligned });
    stepsOut.push({
      color,
      faceAligned,
      handAligned,
      white: { frames: w.frames, kept: w.kept, handN: w.hand.n, faceN: w.face.n, faceAlignedFrames: w.faceAl, handAlignedFrames: w.handAl, hand: hs.baseline, face: fs.baseline },
      colored: { frames: c.frames, kept: c.kept, handN: c.hand.n, faceN: c.face.n, faceAlignedFrames: c.faceAl, handAlignedFrames: c.handAl, hand: hs.sample, face: fs.sample },
    });
  }
  S.colorPhases.push({
    pose: pose.name,
    sequence: S.colorSeq,
    startT: S.colorStart,
    endT: t,
    holdTotal: S.holdTotal,
    holdMiss: S.holdMiss,
    steps: stepsOut,
  });

  bg.style.background = '';
  // 색 단계 직후 자동으로 입체 단계 (v1.3)
  beginQuad(t);
  renderLog();
}

// ---------- 입체 단계 (v1.3) ----------
// 사분면 이름은 사용자가 화면을 보는 기준 (화면은 미러링 없음 → 화면 왼쪽 위 = TL)
// 색·입체 측정 중: 레이아웃은 그대로 두고 패널·미리보기만 흐리게 (빛이 거의 그대로 비치도록)
function setMeasuring(on) {
  document.body.classList.toggle('measuring', !!on);
}

function setQuadVisual(q) {
  if (!q) {
    quadLit.style.display = 'none';
    return;
  }
  bg.style.background = '#000';
  quadLit.style.display = 'block';
  quadLit.style.left = q[1] === 'L' ? '0' : '50%';
  quadLit.style.top = q[0] === 'T' ? '0' : '50%';
}

function beginQuad(t) {
  S.phase = 'quad';
  S.quadStart = t;
  S.quadSeq = [];
  for (let r = 0; r < QUAD_REPEAT; r++) S.quadSeq.push(...shuffle(QUADS));
  S.quadAcc = S.quadSeq.map(() => newQuadAcc());
  setNextBtn();
  setQuadVisual(S.quadSeq[0]);
  renderQuadHud(t, null);
  requestAnimationFrame(quadTick);
}

function quadTick() {
  if (!S || S.phase !== 'quad') return;
  const k = Math.floor((performance.now() - S.quadStart) / STEP_MS);
  if (k >= S.quadSeq.length) return; // 정리는 endQuad에서
  if (k >= 0) setQuadVisual(S.quadSeq[k]);
  requestAnimationFrame(quadTick);
}

function handleQuad(t, hand, face, align) {
  const el = t - S.quadStart;
  const k = Math.floor(el / STEP_MS);
  if (k >= S.quadSeq.length) {
    endQuad(t);
    if (S.phase === 'pose') handlePose(t, hand, align);
    else if (S.phase === 'done') renderDoneHud(hand, align);
    return;
  }
  const acc = S.quadAcc[k];
  acc.frames++;
  const keep = el - k * STEP_MS >= DISCARD_MS;
  if (keep) acc.kept++;
  if (keep && face) {
    const W = video.videoWidth;
    const H = video.videoHeight;
    if (grab.width !== W || grab.height !== H) {
      grab.width = W;
      grab.height = H;
    }
    gctx.drawImage(video, 0, 0, W, H);
    const rois = faceQuadLuma(face, W, H);
    if (rois) {
      acc.faceN++;
      for (const key of ['L', 'R', 'T', 'B']) {
        if (rois[key] != null) {
          acc[key].sum += rois[key];
          acc[key].n++;
        }
      }
    }
  }
  renderQuadHud(t, !!face);
}

function endQuad(t) {
  const pose = S.poses[S.poseIdx];
  const steps = S.quadSeq.map((quad, i) => {
    const a = S.quadAcc[i];
    const rois = { L: ymean(a.L), R: ymean(a.R), T: ymean(a.T), B: ymean(a.B) };
    const any = Object.values(rois).some((v) => v != null);
    return { pose: pose.name, poseIdx: S.poseIdx, quad, rois: any ? rois : null, frames: a.frames, kept: a.kept, faceN: a.faceN };
  });
  S.quadSteps.push(...steps);
  pose.quad = judgeQuadrants(steps, quadOpts());
  pose.quadStart = S.quadStart;
  pose.quadEnd = t;
  setQuadVisual(null);
  setMeasuring(false);
  bg.style.background = '';

  S.poseIdx++;
  if (S.poseIdx >= S.seq.length) {
    S.phase = 'done';
    recordRound();
    setNextBtn();
    renderLog();
    return;
  }
  // 바로 다음 손 모양으로 (대기 화면 없음 — 결과는 HUD 로그에 누적)
  beginPose(t);
  renderLog();
}

// 지금까지 모인 데이터로 finalVerdict (색 단계까지 끝난 pose만 포함).
// 전환 검사(checkTransition)는 실제 손에서 오탐이 커서 제외 — transitions: [] 고정.
function verdictSoFar() {
  const done = S.poses.filter((p) => p.done);
  const colorHand = judgeColorSteps(S.handSteps, colorOpts());
  const colorFace = judgeColorSteps(S.faceSteps, colorOpts());
  // 입체 단계: 지금까지 모인 모든 단계를 합쳐 판정 (아직 없으면 판정에서 제외)
  const quadFace = S.quadSteps.length > 0 ? judgeQuadrants(S.quadSteps, quadOpts()) : undefined;
  const verdict = finalVerdict({
    poses: done.map((p) => ({ name: p.name, matched: p.matched })),
    transitions: [],
    colorHand,
    colorFace,
    quadFace,
  });
  return { doneCount: done.length, verdict, colorHand, colorFace, quadFace };
}

// ---------- 프레임 루프 ----------
let looping = false;
let lastTs = -1;
let lastVideoTime = -1;
// pose/완료 단계에서는 얼굴 추론을 N프레임마다 한 번만 (color 단계는 매 프레임 — 얼굴 ROI 필요)
const FACE_EVERY = 3;
let frameNo = 0;
let lastFace = null;
// 성능 표시 (미리보기 구석)
let fpsEma = 0;
let handMs = 0;
let faceMs = 0;
let lastFrameAt = 0;
let lastPerfPaint = 0;
const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

function startLoop() {
  if (looping) return;
  looping = true;
  frameNo = 0;
  lastFace = null;
  lastFrameAt = 0;
  fpsEma = 0;
  scheduleNext();
}
function stopLoop() {
  looping = false;
}
function scheduleNext() {
  if (!looping) return;
  if (hasRVFC) video.requestVideoFrameCallback(onFrame);
  else requestAnimationFrame(onFrame);
}

function onFrame() {
  if (!looping) return;
  try {
    processFrame();
  } catch (e) {
    console.error(e);
    stopLoop();
    showError(`Tracking error: ${e && e.message ? e.message : e}`);
    hud.classList.remove('show');
    bg.classList.remove('dark');
    bg.style.background = '';
    document.body.classList.remove('running');
    startScreen.classList.remove('hidden');
    previewBox.classList.remove('show');
    setQuadVisual(null);
    setMeasuring(false);
    if (S) S.phase = 'idle';
    return;
  }
  scheduleNext();
}

function processFrame() {
  if (video.readyState < 2 || !video.videoWidth) return;
  if (!hasRVFC) {
    if (video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
  }
  // detectForVideo용 단조 증가 타임스탬프(ms 정수)
  const t = nowTs();

  // 추론할 프레임을 먼저 미리보기 canvas에 그리고, 바로 그 canvas로 추론한다.
  // (화면에 보이는 프레임 == 랜드마크를 구한 프레임 → 스켈레톤이 손가락에 붙는다)
  sizeOverlay();
  const W = overlay.width;
  const H = overlay.height;
  octx.drawImage(video, 0, 0, W, H);

  const runFace = (S && (S.phase === 'color' || S.phase === 'quad')) || frameNo % FACE_EVERY === 0;
  frameNo++;
  const t0 = performance.now();
  const handRes = handLm.detectForVideo(overlay, t);
  const hand = handRes && handRes.landmarks && handRes.landmarks[0] ? handRes.landmarks[0] : null;
  const t1 = performance.now();
  let face = lastFace;
  if (runFace) {
    const faceRes = faceLm.detectForVideo(overlay, t);
    face = faceRes && faceRes.faceLandmarks && faceRes.faceLandmarks[0] ? faceRes.faceLandmarks[0] : null;
    lastFace = face;
  }
  const t2 = performance.now();

  const align = computeAlign(hand, face, W, H);
  drawGuides(align, W, H); // 비디오 프레임 위, 스켈레톤 아래
  drawOverlay(hand, face);
  updateGuideLabels(align);
  updatePerf(t2, t1 - t0, runFace ? t2 - t1 : null);

  if (!S) return;
  if (S.phase === 'pose') {
    if (S.poseStart == null) beginPose(t);
    handlePose(t, hand, align);
  } else if (S.phase === 'color') {
    handleColor(t, hand, face, align);
  } else if (S.phase === 'quad') {
    handleQuad(t, hand, face, align);
  } else if (S.phase === 'done') {
    renderDoneHud(hand, align);
  }
}

function handlePose(t, hand, align) {
  const pose = S.poses[S.poseIdx];
  const target = POSES[pose.name];
  const angles = hand ? fingerAngles(hand) : null;
  const states = hand ? fingerStates(hand, DEFAULTS) : null;
  const match = states ? poseMatches(states, target) : false;

  if (match) {
    if (S.matchStart == null) S.matchStart = t;
  } else {
    S.matchStart = null;
  }
  const holdMs = S.matchStart != null ? t - S.matchStart : 0;

  if (!pose.latched && match && holdMs >= HOLD_MS) {
    pose.latched = true;
    pose.latchT = t;
    renderLog();
  }
  renderPoseHud(pose, target, states, angles, match, holdMs, align);
}

function handleColor(t, hand, face, align) {
  const el = t - S.colorStart;
  const k = Math.floor(el / STEP_MS);
  if (k >= S.colorSeq.length) {
    endColor(t);
    if (S.phase === 'pose') handlePose(t, hand, align);
    else if (S.phase === 'done') renderDoneHud(hand, align);
    return;
  }
  // 손 모양 유지 확인
  S.holdTotal++;
  const target = POSES[S.seq[S.poseIdx]];
  const states = hand ? fingerStates(hand, DEFAULTS) : null;
  const match = !!states && poseMatches(states, target);
  if (!match) S.holdMiss++;

  const acc = S.acc[k];
  acc.frames++;
  if (align.faceAligned) acc.faceAl++;
  if (align.handAligned) acc.handAl++;
  const keep = el - k * STEP_MS >= DISCARD_MS; // 각 구간 처음 200ms 프레임은 버림
  if (keep) acc.kept++;
  if (keep && (hand || face)) {
    const W = video.videoWidth;
    const H = video.videoHeight;
    if (grab.width !== W || grab.height !== H) {
      grab.width = W;
      grab.height = H;
    }
    gctx.drawImage(video, 0, 0, W, H);
    if (hand) {
      const rgb = palmMean(hand, W, H);
      if (rgb) accAdd(acc.hand, rgb);
    }
    if (face) {
      const rgb = faceMean(face, W, H);
      if (rgb) accAdd(acc.face, rgb);
    }
  }
  renderColorHud(t, match);
}

// ---------- 정렬 가이드 ----------
// 정규화된 원본(비미러) 비디오 좌표. 미리보기는 CSS로 좌우반전되므로 화면 x = 1 - x.
// 화면 기준: 얼굴 타원은 화면 중앙(화면 x=0.50), 손바닥은 오른쪽(화면 x≈0.80), 같은 높이.
const GUIDE = {
  face: { cx: 0.5, cy: 0.47, rx: 0.13, ry: 0.27 }, // rx: 너비 비율, ry: 높이 비율
  hand: { cx: 0.2, cy: 0.47, h: 0.27 * 2 * 0.7 }, // h: 높이 비율 (얼굴 타원 높이의 70%)
};
const HAND_ASPECT = 0.78; // 손 가이드 너비/높이 (px 기준)
const HAND_SIZE_RANGE = [0.25, 0.75]; // (점0~점9 거리) / 손 가이드 높이 허용 범위
const FACE_SIZE_RANGE = [0.7, 1.3]; // 얼굴 bbox 높이 / 타원 높이

function handBox(W, H) {
  const h = GUIDE.hand.h * H;
  const w = h * HAND_ASPECT;
  return { x: GUIDE.hand.cx * W - w / 2, y: GUIDE.hand.cy * H - h / 2, w, h };
}

function computeAlign(hand, face, W, H) {
  let faceAligned = false;
  let handAligned = false;
  if (face) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of face) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const g = GUIDE.face;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const inside = ((cx - g.cx) / g.rx) ** 2 + ((cy - g.cy) / g.ry) ** 2 <= 1;
    const hr = (maxY - minY) / (2 * g.ry);
    faceAligned = inside && hr >= FACE_SIZE_RANGE[0] && hr <= FACE_SIZE_RANGE[1];
  }
  if (hand) {
    const ids = [0, 5, 9, 13, 17];
    let px = 0, py = 0;
    for (const i of ids) {
      px += hand[i].x;
      py += hand[i].y;
    }
    px = (px / ids.length) * W;
    py = (py / ids.length) * H;
    const b = handBox(W, H);
    const inside = px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
    const size = Math.hypot((hand[9].x - hand[0].x) * W, (hand[9].y - hand[0].y) * H) / b.h;
    handAligned = inside && size >= HAND_SIZE_RANGE[0] && size <= HAND_SIZE_RANGE[1];
  }
  return { faceAligned, handAligned };
}

// 펼친 손바닥 실루엣 (손가락 위, 엄지는 +x 쪽 = 미러 화면에서 얼굴 쪽)
function handGuidePath(ctx, b) {
  const P = (u, v) => [b.x + u * b.w, b.y + v * b.h];
  const fu = 0.062; // 손가락 반폭(u 단위)
  const r = fu * b.w; // 손가락 끝 반지름(px)
  const fingers = [
    // [중심 u, 끝 원 중심 v]  새끼 → 약지 → 중지 → 검지
    [0.18, 0.27],
    [0.34, 0.12],
    [0.5, 0.08],
    [0.66, 0.14],
  ];
  ctx.beginPath();
  ctx.moveTo(...P(0.22, 1.0));
  ctx.quadraticCurveTo(...P(fingers[0][0] - fu, 1.0), ...P(fingers[0][0] - fu, 0.82));
  fingers.forEach(([cu, tv], i) => {
    ctx.lineTo(...P(cu - fu, tv));
    const [cx, cy] = P(cu, tv);
    ctx.arc(cx, cy, r, Math.PI, Math.PI * 2);
    if (i < fingers.length - 1) {
      ctx.lineTo(...P(cu + fu, 0.43));
      ctx.lineTo(...P((cu + fu + fingers[i + 1][0] - fu) / 2, 0.46));
    } else {
      ctx.lineTo(...P(cu + fu, 0.56)); // 검지 바깥 → 엄지 갈래
    }
  });
  // 엄지: 바닥 B → 끝 T 캡슐
  const [bx, by] = P(0.72, 0.8);
  const [tx, ty] = P(0.93, 0.47);
  const len = Math.hypot(tx - bx, ty - by);
  const dx = (tx - bx) / len;
  const dy = (ty - by) / len;
  const rt = 0.08 * b.w;
  const nx = dy, ny = -dx; // d를 -90° 회전 (위-왼쪽)
  ctx.lineTo(tx + nx * rt, ty + ny * rt);
  const a = Math.atan2(dy, dx);
  ctx.arc(tx, ty, rt, a - Math.PI / 2, a + Math.PI / 2);
  ctx.lineTo(bx - nx * rt, by - ny * rt);
  ctx.quadraticCurveTo(...P(0.74, 0.97), ...P(0.64, 1.0));
  ctx.closePath();
}

function drawGuides(align, W, H) {
  const lw = Math.max(2, W / 240);
  const style = (ok) => {
    octx.lineWidth = lw;
    octx.strokeStyle = ok ? '#4ade80' : 'rgba(255,255,255,0.9)';
    octx.setLineDash(ok ? [] : [lw * 4, lw * 3]);
  };
  octx.save();
  octx.shadowColor = 'rgba(0,0,0,0.6)';
  octx.shadowBlur = 3;
  const g = GUIDE.face;
  style(align.faceAligned);
  octx.beginPath();
  octx.ellipse(g.cx * W, g.cy * H, g.rx * W, g.ry * H, 0, 0, Math.PI * 2);
  octx.stroke();
  style(align.handAligned);
  handGuidePath(octx, handBox(W, H));
  octx.stroke();
  octx.restore();
}

// HTML 라벨은 미러링되지 않으므로 화면 x = 1 - x 로 배치
function placeGuideLabels() {
  const g = GUIDE.face;
  lblFace.style.left = `${(1 - g.cx) * 100}%`;
  lblFace.style.top = `${(g.cy - g.ry) * 100}%`;
  lblHand.style.left = `${(1 - GUIDE.hand.cx) * 100}%`;
  lblHand.style.top = `${(GUIDE.hand.cy - GUIDE.hand.h / 2) * 100}%`;
}
let lastAlignKey = '';
function updateGuideLabels(align) {
  const key = `${align.faceAligned}|${align.handAligned}`;
  if (key === lastAlignKey) return;
  lastAlignKey = key;
  lblFace.classList.toggle('ok', align.faceAligned);
  lblHand.classList.toggle('ok', align.handAligned);
}

// ---------- ROI (원본=비미러 좌표) ----------
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function clampBox(minX, minY, maxX, maxY, W, H) {
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(W, Math.ceil(maxX));
  const y1 = Math.min(H, Math.ceil(maxY));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

function palmMean(lm, W, H) {
  const poly = PALM_IDX.map((i) => ({ x: lm[i].x * W, y: lm[i].y * H }));
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const box = clampBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), W, H);
  if (!box) return null;
  const data = gctx.getImageData(box.x0, box.y0, box.w, box.h).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < box.h; y++) {
    const py = box.y0 + y + 0.5;
    for (let x = 0; x < box.w; x++) {
      if (!pointInPoly(box.x0 + x + 0.5, py, poly)) continue;
      const o = (y * box.w + x) * 4;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
      n++;
    }
  }
  return n > 0 ? [r / n, g / n, b / n] : null;
}

function faceCircles(lm, W, H) {
  let minX = Infinity, maxX = -Infinity;
  for (const p of lm) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  const radius = (maxX - minX) * W * FACE_ROI_RADIUS;
  return FACE_ROI_IDX.map((i) => ({ x: lm[i].x * W, y: lm[i].y * H, r: radius }));
}

function faceMean(lm, W, H) {
  const circles = faceCircles(lm, W, H);
  const r0 = circles[0].r;
  if (!(r0 > 0)) return null;
  const box = clampBox(
    Math.min(...circles.map((c) => c.x - c.r)),
    Math.min(...circles.map((c) => c.y - c.r)),
    Math.max(...circles.map((c) => c.x + c.r)),
    Math.max(...circles.map((c) => c.y + c.r)),
    W,
    H,
  );
  if (!box) return null;
  const data = gctx.getImageData(box.x0, box.y0, box.w, box.h).data;
  const r2 = r0 * r0;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < box.h; y++) {
    const py = box.y0 + y + 0.5;
    for (let x = 0; x < box.w; x++) {
      const px = box.x0 + x + 0.5;
      let inside = false;
      for (const c of circles) {
        const dx = px - c.x, dy = py - c.y;
        if (dx * dx + dy * dy <= r2) { inside = true; break; }
      }
      if (!inside) continue;
      const o = (y * box.w + x) * 4;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
      n++;
    }
  }
  return n > 0 ? [r / n, g / n, b / n] : null;
}

// 원 1개 내부 평균 RGB (grab canvas = 원본 비디오 프레임)
function circleMean(cx, cy, rad, W, H) {
  const box = clampBox(cx - rad, cy - rad, cx + rad, cy + rad, W, H);
  if (!box) return null;
  const data = gctx.getImageData(box.x0, box.y0, box.w, box.h).data;
  const r2 = rad * rad;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < box.h; y++) {
    const dy = box.y0 + y + 0.5 - cy;
    for (let x = 0; x < box.w; x++) {
      const dx = box.x0 + x + 0.5 - cx;
      if (dx * dx + dy * dy > r2) continue;
      const o = (y * box.w + x) * 4;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
      n++;
    }
  }
  return n > 0 ? [r / n, g / n, b / n] : null;
}
const luma = (rgb) => (rgb ? 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] : null);

// 입체 단계 얼굴 ROI 4개 휘도. 원본(비미러) 영상에서 x가 큰 뺨 = 사용자 왼쪽 뺨 L.
function faceQuadLuma(lm, W, H) {
  let minX = Infinity, maxX = -Infinity;
  for (const p of lm) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  const rad = (maxX - minX) * W * FACE_ROI_RADIUS;
  if (!(rad > 0)) return null;
  const at = (i) => luma(circleMean(lm[i].x * W, lm[i].y * H, rad, W, H));
  const a = lm[QUAD_LM.cheekA];
  const b = lm[QUAD_LM.cheekB];
  const [li, ri] = a.x >= b.x ? [QUAD_LM.cheekA, QUAD_LM.cheekB] : [QUAD_LM.cheekB, QUAD_LM.cheekA];
  return { L: at(li), R: at(ri), T: at(QUAD_LM.T), B: at(QUAD_LM.B) };
}

// ---------- 오버레이 그리기 (원본 좌표, CSS로 미러링) ----------
// canvas 고유 크기 = 비디오 해상도 (CSS width 100%, height auto로 박스 비율 결정)
function sizeOverlay() {
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (W && H && (overlay.width !== W || overlay.height !== H)) {
    overlay.width = W;
    overlay.height = H;
  }
}

// fps = 처리한 프레임 수/초(EMA), hand/face = 마지막 추론 시간(ms). 얼굴은 건너뛴 프레임이면 직전 값 유지.
function updatePerf(now, hMs, fMs) {
  if (lastFrameAt) {
    const dt = now - lastFrameAt;
    if (dt > 0) fpsEma = fpsEma ? fpsEma * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
  }
  lastFrameAt = now;
  handMs = hMs;
  if (fMs != null) faceMs = fMs;
  if (now - lastPerfPaint < 250) return;
  lastPerfPaint = now;
  perfEl.textContent = `${fpsEma.toFixed(1)} fps · hand ${handMs.toFixed(1)}ms · face ${faceMs.toFixed(1)}ms`;
}

// 현재 canvas에는 추론한 비디오 프레임이 그려져 있음 — 그 위에 랜드마크만 덧그린다
function drawOverlay(hand, face) {
  const W = overlay.width;
  const H = overlay.height;
  const lw = Math.max(1.5, W / 320);

  if (face) {
    octx.fillStyle = 'rgba(180, 220, 255, 0.55)';
    for (let i = 0; i < face.length; i += 2) {
      octx.fillRect(face[i].x * W - 1, face[i].y * H - 1, 2, 2);
    }
    octx.strokeStyle = '#ffd34d';
    octx.lineWidth = lw;
    for (const c of faceCircles(face, W, H)) {
      octx.beginPath();
      octx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      octx.stroke();
    }
  }

  if (hand) {
    const P = (i) => [hand[i].x * W, hand[i].y * H];
    // 손바닥 다각형
    octx.beginPath();
    PALM_IDX.forEach((i, k) => {
      const [x, y] = P(i);
      if (k === 0) octx.moveTo(x, y);
      else octx.lineTo(x, y);
    });
    octx.closePath();
    octx.fillStyle = 'rgba(255, 211, 77, 0.25)';
    octx.fill();
    octx.strokeStyle = '#ffd34d';
    octx.lineWidth = lw;
    octx.stroke();
    // 연결선
    octx.strokeStyle = 'rgba(120, 255, 170, 0.9)';
    octx.lineWidth = lw;
    octx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const [x1, y1] = P(a);
      const [x2, y2] = P(b);
      octx.moveTo(x1, y1);
      octx.lineTo(x2, y2);
    }
    octx.stroke();
    octx.fillStyle = '#ff5c7a';
    for (let i = 0; i < 21; i++) {
      const [x, y] = P(i);
      octx.beginPath();
      octx.arc(x, y, lw * 1.6, 0, Math.PI * 2);
      octx.fill();
    }
  }
}

// ---------- HUD ----------
const ANGLE_KEYS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const ALIGN_HINT = 'Fit your face in the oval and your palm in the hand outline';

function angleChips(angles) {
  return FINGER_EN.map((nm, i) => {
    if (!angles) return `<span class="chip ang">${nm} –°</span>`;
    const deg = angles[ANGLE_KEYS[i]];
    const thr = i === 0 ? DEFAULTS.thumbExtendedDeg : DEFAULTS.extendedDeg;
    return `<span class="chip ang ${deg > thr ? 'on' : ''} ${i === 0 ? 'skip' : ''}">${nm} ${Math.round(deg)}°</span>`;
  }).join('');
}

function alignLine(align) {
  if (align.faceAligned && align.handAligned) return '<div class="hint ok">Aligned — face and palm are inside the guides</div>';
  return `<div class="hint al">${ALIGN_HINT} (face ${align.faceAligned ? '✓' : '✗'} · palm ${align.handAligned ? '✓' : '✗'})</div>`;
}

function renderPoseHud(pose, target, states, angles, match, holdMs, align) {
  hudStep.textContent = `Round ${S.round} · Hand pose ${S.poseIdx + 1} / ${S.seq.length}`;
  hudTitle.textContent = `Make this pose: ${POSE_EN[pose.name]}`;
  const targetChips = target
    .map((v, i) => `<span class="chip ${v ? 'on' : ''} ${i === 0 ? 'skip' : ''}">${FINGER_EN[i]} ${v ? 'extend' : 'fold'}</span>`)
    .join('');
  const liveChips = FINGER_EN.map((nm, i) => {
    if (!states) return `<span class="chip">${nm} ?</span>`;
    const v = states[i];
    const cls = i === 0 ? 'skip' : v === target[i] ? 'ok' : 'ng';
    return `<span class="chip ${v ? 'on' : ''} ${cls}">${nm} ${v ? 'extended' : 'folded'}</span>`;
  }).join('');
  const live = !states
    ? '<span class="live none">No hand</span>'
    : match
      ? '<span class="live yes">Matching now</span>'
      : '<span class="live no">Not matching</span>';
  const latch = pose.latched
    ? '<span class="badge ok">Recognized ✓</span>'
    : '<span class="badge wait">Waiting</span>';
  const holdPct = Math.min(100, (holdMs / HOLD_MS) * 100);
  hudDetail.innerHTML = `
    <div class="fingers"><span class="lbl">Goal</span>${targetChips}</div>
    <div class="fingers"><span class="lbl">Live</span>${liveChips}</div>
    <div class="fingers"><span class="lbl">Angle</span>${angleChips(angles)}</div>
    <div class="statusrow">${latch}${live}<span class="thr">Extended if &gt; ${DEFAULTS.extendedDeg}° (thumb &gt; ${DEFAULTS.thumbExtendedDeg}°, not scored)</span></div>
    ${pose.latched ? '' : `<div class="bar"><div style="width:${holdPct}%"></div></div>`}
    ${alignLine(align)}
    <div class="hint">${pose.latched ? 'Recognized — ' : ''}Press Next (Space) to start the color check (3s).</div>`;
}

function renderColorHud(t, match) {
  const el = t - S.colorStart;
  const k = Math.min(S.colorSeq.length - 1, Math.max(0, Math.floor(el / STEP_MS)));
  const remain = Math.max(0, (STEP_MS * S.colorSeq.length - el) / 1000).toFixed(1);
  hudStep.textContent = `Round ${S.round} · Hand pose ${S.poseIdx + 1} / ${S.seq.length} · Color check`;
  hudTitle.textContent = `Measuring color — hold the pose (${remain}s)`;
  const c = S.colorSeq[k];
  hudDetail.innerHTML = `<div class="statusrow"><span class="chip"><span class="swatch" style="background:${rgbCss(COLOR_RGB[c])}"></span>${COLOR_EN[c]} (${k + 1}/${S.colorSeq.length})</span>${
    match == null ? '' : match ? '<span class="live yes">Matching now</span>' : '<span class="live no">Not matching</span>'
  }</div>`;
}

function renderQuadHud(t, faceOk) {
  const el = t - S.quadStart;
  const k = Math.min(S.quadSeq.length - 1, Math.max(0, Math.floor(el / STEP_MS)));
  const remain = Math.max(0, (STEP_MS * S.quadSeq.length - el) / 1000).toFixed(1);
  hudStep.textContent = `Hand pose ${S.poseIdx + 1}/${S.seq.length} · 3D check ${k + 1}/${S.quadSeq.length} (${QUAD_EN[S.quadSeq[k]]})`;
  hudTitle.textContent = `Keep your face still · ${remain}s${faceOk === false ? ' · No face' : ''}`;
  hudDetail.innerHTML = '';
}

function renderDoneHud(hand, align) {
  const { verdict } = verdictSoFar();
  hudStep.textContent = `Round ${S.round} complete`;
  hudTitle.textContent = `Final verdict: ${verdict.passed ? 'Pass ✓' : 'Fail ✗'}`;
  hudDetail.innerHTML = `
    <div class="fingers"><span class="lbl">Angle</span>${angleChips(hand ? fingerAngles(hand) : null)}</div>
    ${alignLine(align)}
    <div class="hint">Press Next (Space) to start a new round (3 new hand poses).</div>`;
}

function setNextBtn() {
  if (!S) return;
  const isLast = S.poseIdx >= S.seq.length - 1;
  if (S.phase === 'pose') {
    nextLbl.textContent = 'Next → color check';
    nextBtn.disabled = false;
  } else if (S.phase === 'color' || S.phase === 'quad') {
    nextLbl.textContent = isLast ? 'Measuring… (final verdict next)' : 'Measuring… (next pose follows)';
    nextBtn.disabled = true; // 측정 중(색 3초 + 입체 4초)에는 무시
  } else if (S.phase === 'done') {
    nextLbl.textContent = 'Next → new round';
    nextBtn.disabled = false;
  }
}

// 누적 로그 + 현재까지 판정 + 원본 JSON — 데이터가 바뀔 때만 갱신 (details 열림 상태 유지)
function renderLog() {
  const so = verdictSoFar();
  const { verdict, doneCount } = so;
  const final = S.phase === 'done';
  // v1.5 반사 패턴 진단: 지금까지 모인 모든 단계, 보정 기준 적용. 항상 한 줄(레이아웃 고정)
  const diag = diagnoseRound(judgeInputs(), diagOpts());
  const diagLine = `<div class="diagline ${diag.code === 'ok' ? 'd-ok' : 'd-warn'}" data-code="${diag.code}" title="${esc(diag.message)}">Diagnosis: ${esc(diag.message)}</div>`;
  if (doneCount === 0) {
    hudVerdict.innerHTML = `<div class="vline">Verdict so far: <span class="muted">no data yet</span></div>${diagLine}`;
  } else {
    hudVerdict.innerHTML = `<div class="vline ${verdict.passed ? 'pass' : 'fail'}">${final ? 'Final verdict' : `Verdict so far (${doneCount}/${S.seq.length})`}: ${
      verdict.passed ? 'Pass ✓' : 'Fail ✗'
    }</div>${diagLine}${verdict.reasons.length ? `<ul class="reasons">${verdict.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}`;
  }

  const yn = (b) => (b ? '<span class="g">✓</span>' : '<span class="r">✗</span>');
  const blocks = [];
  S.poses.forEach((p, i) => {
    const started = i < S.poseIdx || (i === S.poseIdx && S.phase !== 'done');
    if (!started && !p.done) return;
    const holdTxt = p.done ? ` · hold mismatch ${p.holdMiss}/${p.holdTotal}` : '';
    const res = p.done ? (p.matched ? ' <span class="g">Passed</span>' : ' <span class="r">Failed</span>') : ' <span class="muted">In progress</span>';
    let table = '';
    if (p.done) {
      const idxs = [];
      S.stepMeta.forEach((m, j) => {
        if (m.poseIdx === i) idxs.push(j);
      });
      // 이 pose의 3단계만 따로 판정 (표시용)
      const jh = judgeColorSteps(idxs.map((j) => S.handSteps[j]), colorOpts());
      const jf = judgeColorSteps(idxs.map((j) => S.faceSteps[j]), colorOpts());
      const rows = idxs
        .map((j, r) => {
          const m = S.stepMeta[j];
          const ch = CHANNEL_IDX[m.color];
          const hd = jh.details[r];
          const fd = jf.details[r];
          return `<tr><td><span class="swatch" style="background:${rgbCss(COLOR_RGB[m.color])}"></span>${COLOR_EN[m.color]} (${CHANNEL_KO[m.color]})</td>
            <td class="num">${hd.delta ? fmt(hd.delta[ch]) : '–'}</td><td>${yn(hd.matched)}</td>
            <td class="num">${fd.delta ? fmt(fd.delta[ch]) : '–'}</td><td>${yn(fd.matched)}</td>
            <td class="muted">${m.faceAligned ? 'Face○' : 'Face×'} ${m.handAligned ? 'Palm○' : 'Palm×'}</td></tr>`;
        })
        .join('');
      table = `<table class="steps"><thead><tr><th>Color</th><th class="num">Palm Δ</th><th></th><th class="num">Face Δ</th><th></th><th>Aligned</th></tr></thead>
        <tbody>${rows}</tbody><tfoot><tr><td>Palm ${jh.matched}/${jh.total} · Face ${jf.matched}/${jf.total}</td><td colspan="5"></td></tr></tfoot></table>`;
      const q = p.quad;
      table += q
        ? `<div class="quadrow">3D H <b>${fmt(q.H, 3)}</b> · V ${fmt(q.V, 3)} ${yn(q.passed)} <span class="muted">(threshold H &gt; ${TH.minSwingH})</span></div>`
        : `<div class="quadrow muted">3D check in progress…</div>`;
    }
    blocks.push(`<div class="logpose"><div class="loghead"><b>${i + 1}. ${esc(POSE_EN[p.name])}</b> · ${
      p.latched ? '<span class="g">Recognized ✓</span>' : '<span class="r">Not recognized</span>'
    }${holdTxt} ·${res}</div>${table}</div>`);
  });
  hudLog.innerHTML = blocks.reverse().join('') || ''; // 최신 손 모양이 맨 위

  const raw = {
    config: { mode: 'manual', DEFAULTS, QUAD_DEFAULTS, applied: { minDelta: TH.minDelta, minSwingH: TH.minSwingH, calibrated: TH.calibrated }, QUAD_REPEAT, HOLD_MS, STEP_MS, DISCARD_MS, HOLD_FAIL_RATIO, N_POSES, GUIDE, HAND_SIZE_RANGE, FACE_SIZE_RANGE },
    env: { delegates, video: { width: video.videoWidth, height: video.videoHeight }, userAgent: navigator.userAgent },
    round: S.round,
    phase: S.phase,
    verdictSoFar: verdict,
    poses: S.poses,
    colorHand: so.colorHand,
    colorFace: so.colorFace,
    stepMeta: S.stepMeta,
    handSteps: S.handSteps.map((s) => ({
      ...s,
      chromaBaseline: s.baseline && chroma(s.baseline),
      chromaSample: s.sample && chroma(s.sample),
    })),
    faceSteps: S.faceSteps.map((s) => ({
      ...s,
      chromaBaseline: s.baseline && chroma(s.baseline),
      chromaSample: s.sample && chroma(s.sample),
    })),
    colorPhases: S.colorPhases,
    quadFace: so.quadFace ?? null,
    quadSteps: S.quadSteps,
  };
  rawJson.textContent = JSON.stringify(
    raw,
    (k, val) => (typeof val === 'number' && !Number.isInteger(val) ? Math.round(val * 1e5) / 1e5 : val),
    2,
  );
  window.__humanCheckLast = raw;
}

// ---------- 이벤트 ----------
startBtn.addEventListener('click', startRun);
nextBtn.addEventListener('click', () => {
  nextBtn.blur(); // 이후 Space가 버튼 클릭으로 중복 처리되지 않도록
  onNext();
});
restartBtn.addEventListener('click', () => {
  restartBtn.blur();
  restartRun();
});
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (!hud.classList.contains('show')) return;
  if (e.target && e.target.tagName === 'SUMMARY') return; // 원본 JSON 토글은 그대로
  if (e.target && e.target.tagName === 'SELECT') return; // 라벨 선택 조작은 그대로
  e.preventDefault();
  if (!e.repeat) onNext();
});
labelSel.addEventListener('change', () => labelSel.blur());
dlBtn.addEventListener('click', () => {
  dlBtn.blur();
  downloadDataset();
});
clearBtn.addEventListener('click', () => {
  clearBtn.blur();
  clearDataset();
});
placeGuideLabels();
loadDataset();
renderCounts();
renderCalibStatus();
loadCalibration();

if (!window.isSecureContext) {
  showError('The camera only works in a secure context. Open this page via http://localhost:8000 or https.');
}
ensureModels().catch((e) => {
  console.error(e);
  showError(`Could not load the models. Check your network connection and press "Start" again.\n(${e && e.message ? e.message : e})`);
});
