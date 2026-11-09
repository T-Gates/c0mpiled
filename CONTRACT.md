# Human Check — 계약 (v1, 해커톤 2시간)

웹캠으로 얼굴+손을 동시에 추적하며, (1) 무작위 손 모양 과제를 연속 수행하고 (2) 각 손 모양을 유지하는 동안 화면 색 빛이 얼굴·손바닥에 반사되는지 확인해 실제 사람인지 판정한다.

## 파일 구조

```
index.html          UI (단일 페이지)
src/judge.js        순수 판정 함수 (ES module, DOM/브라우저 API 의존 금지 — node에서 import 가능해야 함)
src/app.js          카메라, MediaPipe, 진행 흐름, 렌더링 (judge.js를 import)
test/judge.test.js  node --test 단위 테스트
```

실행: `python3 -m http.server 8000` → http://localhost:8000
테스트: `node --test` (Node 26에서는 `node --test test/`가 디렉터리를 모듈로 해석해 실패)
외부 의존: `@mediapipe/tasks-vision@0.10.14` (jsDelivr CDN, ES module import). 빌드 도구·npm 의존 없음.

## 흐름

> **v1.2 (현재 동작, 아래 v1.1보다 우선)** — 사용자 실사용 피드백 반영.
> - 결과 페이지 없음. 한 화면(카메라 미리보기 + 패널)에서 전부 보여준다. 손 모양 → "다음"/Space → 색 단계 3초 → 곧바로 다음 손 모양. 결과는 패널 아래 기록에 쌓이고 "현재까지 판정"이 실시간으로 갱신된다. 3번째 이후 "다음"은 새 라운드, "처음부터"는 언제든 재시작.
> - 시간 제한 없음. 손가락별 실시간 각도, "인식됨 ✓"(500ms 유지 시 고정) 표시.
> - **전환 연속성 판정 제외**: 실제 손에서 오탐(이동 0.53~0.68×손크기, 각도 101~110°). `finalVerdict`에는 `transitions: []`를 넘긴다. `checkTransition`은 judge.js에 남아 있지만 사용하지 않는다.
> - 얼굴 타원·손바닥 윤곽 정렬 가이드(안내용, 판정에 영향 없음, 색 단계마다 정렬 여부를 원본 데이터에 기록).

1. 시작 화면: 안내문(화면 밝기 최대, 어두운 곳 권장, **"화면 색이 0.5초 간격으로 바뀝니다 — 광과민성 주의"**) + 시작 버튼.
2. 카메라 허용 → HandLandmarker(numHands 1) + FaceLandmarker(numFaces 1), runningMode VIDEO, 매 프레임 추적. 얼굴·손 랜드마크를 미리보기 위에 그린다.
3. `pickPoseSequence(3)`로 손 모양 3개를 정한다. **수동 테스트 모드(v1.1): 시간 제한 없음, 사용자가 "다음" 버튼으로 진행.** 각 손 모양마다:
   a. **모양 단계**: 목표 손 모양을 텍스트+손가락 상태로 표시. 시간 제한 없음. `poseMatches`가 연속 500ms 참이면 "인식됨 ✓" 표시(이후 유지, `matched:true`). "다음" 버튼은 항상 누를 수 있으며, 인식 전에 누르면 `matched:false`로 기록하고 진행.
   b. **색 단계**: 화면 전체(미리보기 제외 배경 전체 오버레이)를 `W, C1, W, C2, W, C3` 순서로 각 **500ms**씩 표시. C1~C3은 red/green/blue를 무작위 순서로(`crypto.getRandomValues`). 각 500ms 구간에서 **처음 200ms 프레임은 버리고** 나머지 프레임의 ROI 평균 RGB를 기록. 색 단계 동안 손 모양이 유지되지 않으면(프레임의 50% 이상 불일치) 해당 pose를 실패로 기록.
   b-2. 색 단계가 끝나면 **해당 pose의 색 결과**(색별 손/얼굴 Δ, 일치 여부)를 보여주고 "다음"을 기다린다.
   c. 다음 손 모양으로 가는 **전환 구간**(색 결과 화면에서 "다음"을 누른 시점 ~ 다음 pose 인식 시점)의 프레임 `{t, landmarks|null}`을 기록해 `checkTransition`에 넘긴다.
4. 결과 화면: `finalVerdict` 결과(통과/실패 + reasons) + 단계별 표(색, 기대 채널, 손/얼굴 chroma 변화량, 일치 여부) + 간단한 그래프(canvas: 단계별 손·얼굴의 기대 채널 delta 막대).
5. 다시 하기 버튼.

색 표시용 RGB: white `[255,255,255]`, red `[255,0,0]`, green `[0,255,0]`, blue `[0,0,255]`.

## ROI (색 측정 영역)

비디오 프레임을 오프스크린 canvas에 그려 픽셀 평균 RGB를 구한다(미러링 여부와 무관하게 원본 좌표 기준).
- **손바닥**: 손 랜드마크 0,1,5,9,13,17 다각형 내부 픽셀 평균.
- **얼굴**: 얼굴 랜드마크 50(왼뺨), 280(오른뺨), 151(이마) 중심, 반지름 = 얼굴 bbox 너비 × 0.06 원 3개 내부 픽셀 평균.
- 해당 프레임에 손/얼굴 미검출이면 그 ROI 샘플 없음. 구간에 샘플이 하나도 없으면 그 값은 `null`.

## judge.js API (정확히 이 이름·시그니처로 export)

```js
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
  minDelta: 0.004,        // chroma 변화 최소량
  passRatio: 0.8,         // 색 단계 통과 비율
  extendedDeg: 160,       // 검지~새끼 PIP 각도 기준
  thumbExtendedDeg: 150,  // 엄지 IP 각도 기준
  maxGapMs: 200,          // 전환 중 손 미검출 허용 최대 연속 시간
  maxAngleJumpDeg: 70,    // 연속 두 프레임 간 손가락 각도 최대 변화
  maxLandmarkJump: 0.5,   // 연속 두 프레임 간 랜드마크 최대 이동 / 손 크기
};

export function chroma(rgb)
// rgb: [R,G,B] (0~255). 반환 [R/S, G/S, B/S], S=R+G+B. S===0이면 [1/3,1/3,1/3].

export function fingerAngles(landmarks)
// landmarks: 21개 {x,y,z}. 반환 {thumb,index,middle,ring,pinky} 각도(도, 0~180).
// thumb = 점 2-3-4에서 3의 각도, index = 5-6-8에서 6, middle = 9-10-12에서 10,
// ring = 13-14-16에서 14, pinky = 17-18-20에서 18. 3D(x,y,z) 벡터 사이 각도.

export function fingerStates(landmarks, opts = DEFAULTS)
// 반환 [thumb,index,middle,ring,pinky] boolean. 엄지는 thumbExtendedDeg 초과면 true,
// 나머지는 extendedDeg 초과면 true.

export function poseMatches(states, target, { ignoreThumb = true } = {})
// states, target: boolean[5]. ignoreThumb면 index 0 비교 생략. 나머지가 모두 같으면 true.

export function pickPoseSequence(n, rand = Math.random)
// POSES 키 중 n개 배열. 연속된 두 개는 서로 달라야 함. rand()는 [0,1) 반환 함수.

export function judgeColorSteps(steps, opts = DEFAULTS)
// steps: [{ color: 'red'|'green'|'blue', baseline: [R,G,B]|null, sample: [R,G,B]|null }]
//   baseline = 직전 white 구간 평균, sample = 해당 색 구간 평균.
// 각 step: delta = chroma(sample) - chroma(baseline) (채널별).
//   target 채널 = red→0, green→1, blue→2.
//   matched = baseline·sample 둘 다 non-null && delta[target] > minDelta
//             && delta[target]가 세 채널 delta 중 최댓값.
// 반환 { passed, matched, total, details: [{ color, delta: [dr,dg,db]|null, matched }] }
//   passed = total > 0 && matched >= Math.ceil(total * passRatio).

export function checkTransition(frames, opts = DEFAULTS)
// frames: [{ t: ms, landmarks: 21개|null }] (t 오름차순).
// 실패 조건:
//   - 연속 null 구간 길이(첫 null 프레임 t ~ 다음 non-null 프레임 t)가 maxGapMs 초과
//     (끝까지 null이면 마지막 프레임 t까지로 계산, 그 값이 maxGapMs 초과면 실패)
//   - 연속된 두 non-null 프레임(사이에 null 없이 인접)에서 랜드마크 21개 중 최대 이동거리(x,y 2D)
//     / 손 크기(이전 프레임의 점0~점9 2D 거리) > maxLandmarkJump
//   - 같은 인접 쌍에서 fingerAngles 다섯 중 최대 절댓값 변화 > maxAngleJumpDeg
//   - non-null 프레임이 2개 미만
// 반환 { ok, reason: string|null, maxGapMs, maxJump, maxAngleJump }

export function finalVerdict({ poses, transitions, colorHand, colorFace })
// poses: [{ name, matched: bool }], transitions: [{ ok, reason }],
// colorHand, colorFace: judgeColorSteps 결과.
// passed = 모든 pose matched && 모든 transition ok && colorHand.passed && colorFace.passed.
// 반환 { passed, reasons: string[] }  — 실패한 각 조건마다 사람이 읽을 한국어 사유 1개. 통과면 [].
```

## 비범위

서버 재판정, 토큰 발급, 위젯 SDK, 머신러닝 분류기, 모바일 최적화.

## v1.3 — 4분할 빛 입체 판정 (종이 사진 대응)

원리: 화면 한 구역만 켜면 빛 방향이 바뀐다. 진짜 얼굴(곡면)은 빛 쪽 뺨이 밝아지고, 평평한 종이는 거의 균일하게 밝아진다(거리 차이로 인한 약한 기울기만 생김).

### 흐름 추가 (app)
각 손 모양의 색 단계가 끝나면 이어서 **입체 단계**를 실행한다(다음 손 모양으로 넘어가기 전, 자동):
- 화면을 2×2 사분면으로 나눈다. 한 사분면만 흰색 `[255,255,255]`, 나머지 세 개는 검정. 사분면 이름은 **사용자가 화면을 바라보는 기준**: `TL, TR, BL, BR` (화면 자체는 미러링 없음 → 화면 왼쪽 위 = TL).
- 순서: TL·TR·BL·BR를 `crypto.getRandomValues`로 섞은 4개를 **2회 반복**(총 8단계), 각 500ms, 처음 200ms 프레임은 버린다. (총 4초)
- 각 단계에서 얼굴 ROI 4개의 평균 **휘도** `Y = 0.299R + 0.587G + 0.114B`를 측정한다(원 반지름 = 얼굴 bbox 너비 × 0.06, 원본 비디오 프레임에서 샘플):
  - 뺨 2개: 랜드마크 50, 280. **원본(비미러) 영상에서 x가 더 큰 쪽이 사용자의 왼쪽 뺨 `L`**, 작은 쪽이 오른쪽 뺨 `R`.
  - 이마 `T`: 랜드마크 151. 턱 `B`: 랜드마크 152.
- 패널(진행 중 HUD)과 미리보기를 가리지 않도록, 입체 단계 동안 HUD 패널은 반투명 축소(또는 숨김) 처리해도 된다. 색 단계와 동일하게 "다음" 비활성.

### judge.js 추가 API

```js
export const QUAD_DEFAULTS = { minSwingH: 0.05 };

export function judgeQuadrants(steps, opts = QUAD_DEFAULTS)
// steps: [{ quad: 'TL'|'TR'|'BL'|'BR', rois: { L, R, T, B } | null }]  (각 값은 휘도 number, 없으면 null)
// 단계별: hx = ln(L/R), vy = ln(T/B)  (L,R 중 하나라도 null 또는 <= 0 이면 hx=null; T,B 마찬가지로 vy=null; rois null이면 둘 다 null)
// H = mean(hx | quad ∈ {TL,BL}) − mean(hx | quad ∈ {TR,BR})   (null 제외)
// V = mean(vy | quad ∈ {TL,TR}) − mean(vy | quad ∈ {BL,BR})   (null 제외)
// 왼쪽 그룹·오른쪽 그룹 중 하나라도 유효 hx가 0개면 H = null. V도 동일.
// passed = H !== null && H > minSwingH   (V는 보고만, 판정에 미사용)
// 반환 { passed, H, V, details: [{ quad, hx, vy }] }

// finalVerdict 확장 (하위호환): 인자에 선택적 quadFace(judgeQuadrants 결과)를 받는다.
// quadFace가 주어졌고 passed가 false면 한국어 사유 1개 추가 + passed=false. 주어지지 않으면 기존과 동일.
```

### 표시 (app, 한 화면 유지)
기록 표에 손 모양별 입체 결과 1줄: `H`(소수 3자리), `V`, ✓/✗. "현재까지 판정"에 모든 입체 단계를 합친 `judgeQuadrants` 결과를 반영. 원본 JSON에 단계별 rois 포함.

## v1.4 — 확정 요구사항 + 데이터 수집·기준값 보정 (사용자 확정 2026-11-09)

### 확정 사항
- R1 한 화면, "다음"/Space 수동 진행, 시간 제한 없음, 결과 페이지 없음.
- R2 정렬 가이드: 얼굴 타원 화면 중앙, 손바닥 오른쪽(안내용).
- R3 무작위 손 모양 3개, 실시간 각도, 500ms 유지 시 "인식됨 ✓".
- R4 색 단계(흰-색-흰 ×3, 500ms) — 손·얼굴 chroma Δ.
- R5 전환 판정 제외.
- R6 4분할 빛 입체 판정(v1.3) 유지 — 얼굴 H.
- R7 **최종 통과 = 손 모양 전부 ✓ AND 손 색 ✓ AND 얼굴 색 ✓ AND 얼굴 입체 ✓** (finalVerdict + quadFace).
- R8 데모 공격 = **휴대폰 화면 사진, OBS 가상 카메라**. 데이터 라벨: `real`(실제 사람), `phone`(휴대폰 화면), `obs`(OBS 가상 카메라).
- R9 데이터 수집 + 단순 기준값 보정(아래).

### judge.js 추가 API (순수 함수)

```js
export function roundFeatures({ handSteps, faceSteps, quadSteps })
// handSteps/faceSteps: judgeColorSteps 입력 형식, quadSteps: judgeQuadrants 입력 형식.
// 반환 {
//   handDeltaMean: 유효 단계(baseline·sample non-null)의 목표 채널 Δ 평균, 유효 0개면 null,
//   faceDeltaMean: 동일(얼굴),
//   handMatchRatio, faceMatchRatio: judgeColorSteps(…, DEFAULTS)의 matched/total (total 0이면 null),
//   H, V: judgeQuadrants(quadSteps, QUAD_DEFAULTS)의 H, V
// }

export function stepTargetDeltas(steps)
// judgeColorSteps 입력 형식 → 유효 단계의 목표 채널 Δ 값 배열(number[]), 순서 유지.

export function bestThreshold(pos, neg)
// pos: 진짜 값 배열, neg: 가짜 값 배열 (null/NaN은 제외하고 계산). 규칙: value > t 이면 진짜.
// 후보 t: 두 배열 합친 값을 정렬·중복 제거한 뒤 인접 값의 중점들 + (최솟값 − 1e-9) + (최댓값).
// balancedAccuracy = (TPR + TNR) / 2 가 최대인 t. 동률이면 더 작은 t.
// pos 또는 neg가(유효값 기준) 비어 있으면 null.
// 반환 { threshold, balancedAccuracy, tpr, tnr }
```

### app 추가
- 패널에 **라벨 선택**(실제 사람 / 휴대폰 화면 / OBS 가상 카메라, 기본 실제 사람)과 라벨별 수집 개수 표시.
- 라운드(손 모양 3개 + 각 색·입체 단계)가 끝날 때마다 레코드 `{ label, ts, features: roundFeatures(...), handSteps, faceSteps, quadSteps }` 를 메모리 배열 + `localStorage['humancheck.dataset']`(try/catch, 실패해도 동작)에 추가.
- 버튼: **"데이터 다운로드"**(`humancheck-dataset-YYYYMMDD-HHMM.json`, 레코드 배열), **"데이터 비우기"**(confirm 후).
- 시작 시 `./calibration.json`을 fetch(없으면 무시). 있으면 `{ minDelta, minSwingH }` 값으로 판정 기준을 덮어쓰고, 패널에 "보정 기준 적용됨: minDelta=…, minSwingH=…" 표시. 없으면 "기본 기준".

### tools/calibrate.mjs (node, 의존성 없음, judge.js import)
`node tools/calibrate.mjs <dataset.json> [--write]`
- 라벨별 레코드 수, 각 feature의 평균/최소/최대 표 출력.
- **minDelta**: real 레코드의 손+얼굴 `stepTargetDeltas` 전부 vs 가짜(phone+obs) 전부 → `bestThreshold`.
- **minSwingH**: real 레코드의 `features.H` vs 가짜의 `features.H` → `bestThreshold`.
- 각 결과(threshold, balancedAccuracy, tpr, tnr)와 라벨별(phone/obs 각각) 오탐률 출력. 어느 쪽이 null이면 "데이터 부족"으로 출력하고 기본값 유지.
- `--write`면 저장소 루트 `calibration.json`에 `{ minDelta, minSwingH, n: {real, phone, obs}, createdAt }` 저장(null인 항목은 기본값 사용).

## v1.5 — 반사 패턴 진단 (변조·가림 탐지, 사용자 확정 2026-11-09)

원칙: 소프트웨어 감지(포커스·전체화면·화면공유 대조)는 하지 않는다. Interview Coder/Cluely류 오버레이는 소프트웨어로 감지할 수 없지만, 화면 빛을 바꾸는 모든 변조는 **얼굴에 닿는 반사**에 드러난다. 실패 원인을 반사 패턴으로 진단한다(판정 통과/실패 조건 R7은 그대로, 진단은 설명용).

### judge.js 추가 API

```js
export const DIAG_DEFAULTS = {
  minDelta: 0.004,     // 색 반응 유효 기준 (앱은 보정값 적용)
  minSwingH: 0.05,     // 입체 기준 (앱은 보정값 적용)
  quadSpreadMin: 0.02, // 사분면 간 얼굴 밝기 변동 최소 (이하이면 사분면 빛에 반응 없음)
  blockDrop: 0.08,     // 가장 어두운 사분면이 나머지 평균보다 이 비율 이상 낮으면 가림
  skewFactor: 3,       // 가장 강한 색 반응이 minDelta × skewFactor 이상인데 약한 색이 있으면 색 변조
};

export function diagnoseRound({ handSteps, faceSteps, quadSteps }, opts = DIAG_DEFAULTS)
// colorStrength[c] (c ∈ red, green, blue): 손+얼굴 단계 중 color===c 인 유효 단계의 목표 채널 Δ 평균
//   (stepTargetDeltas와 같은 정의). 해당 색 유효 단계 0개면 null.
// quadLuma[q] (q ∈ TL,TR,BL,BR): quad===q 이고 rois의 L,R,T,B가 모두 number>0 인 단계들의 (L+R+T+B)/4 평균. 없으면 null.
// quadSpread = (max − min) / mean  (non-null quadLuma가 4개일 때만, 아니면 null)
// quadMin: non-null quadLuma가 4개일 때 가장 작은 사분면 q와 ratio = quadLuma[q] / mean(나머지 3개). 아니면 null.
// H = judgeQuadrants(quadSteps, { minSwingH }).H
// 판정 순서(처음 맞는 것):
//  1. colorStrength 전부 null AND quadLuma 전부 null           → code 'insufficient'
//  2. (colorStrength non-null 값의 최댓값 ≤ minDelta 또는 전부 null)
//     AND (quadSpread === null 또는 quadSpread < quadSpreadMin) → 'no_reflection'
//  3. quadMin !== null AND quadMin.ratio < 1 − blockDrop        → 'screen_blocked' (evidence에 사분면)
//  4. colorStrength non-null 최댓값 ≥ minDelta × skewFactor AND
//     non-null 중 minDelta 이하인 색이 1개 이상                  → 'color_tampered' (약한 색 목록)
//  5. H === null 또는 H ≤ minSwingH                              → 'flat_object'
//  6. 그 외                                                      → 'ok'
// 반환 { code, message, evidence: { colorStrength, quadLuma, quadSpread, quadMin, H, weakColors } }
//   message: 한국어 한 줄. 예) 'screen_blocked' → "화면 일부 가림 의심: 왼쪽 위 사분면 반응 약함 (−12%)",
//   'no_reflection' → "반사 없음: 가상 카메라·녹화 영상 의심", 'color_tampered' → "화면 색 변조 의심(필터·야간 모드): 파랑 반응 없음",
//   'flat_object' → "평면 물체 의심: 빛 방향에 따른 입체 반응 없음", 'insufficient' → "측정 데이터 부족: 얼굴/손 미검출", 'ok' → "정상 반사".
//   사분면 한국어: TL 왼쪽 위, TR 오른쪽 위, BL 왼쪽 아래, BR 오른쪽 아래. 색: red 빨강, green 초록, blue 파랑.
```

### app
- "현재까지 판정" 바로 아래 고정 영역에 진단 한 줄(`message`)을 표시(지금까지 모인 모든 단계로 계산, 보정 기준 적용). code별 색: ok 초록, 그 외 주황.
- 데이터 라벨에 **`block`(화면 가림)** 추가. 레코드에 `diag: diagnoseRound(...)` 포함.
- tools/calibrate.mjs: minDelta·minSwingH 계산의 가짜 집합은 계속 phone+obs(block 제외). 추가로 **라벨 × 진단 code 교차표** 출력.

### v1.5 보정 (오케스트레이터 결정, 테스트 작성 중 발견된 모호점)
- `evidence.quadMin` 필드명은 **`{ quad, ratio }`** 로 확정 (`q` 아님).
- 판정 순서 수정:
  - 4번 다음에 **4b**: colorStrength non-null 최댓값 ≤ minDelta (색 반응 전부 약함) 이고 앞 규칙에 안 걸림 → **`'weak_color'`**, message "색 반사 약함: 화면 밝기 최대·주변 조명 줄이기 확인".
  - 5번: **H === null 이면 `'insufficient'`**(message "입체 측정 데이터 부족: 얼굴 미검출"), H ≤ minSwingH 이면 `'flat_object'`.
- `weakColors`는 항상 배열(해당 없으면 `[]`).
- opts는 부분 객체를 받으면 DIAG_DEFAULTS와 병합.

## v1.6-en — 화면·판정 문구 영어화 (사용자 결정 2026-11-09, 영어 발표)

사용자에게 보이는 모든 문구(`index.html`, `src/app.js`의 화면 텍스트, `src/judge.js`가 만드는 reasons·message)는 영어로 바꾼다. 코드 주석·콘솔 로그는 예외. `<html lang="en">`. 판정 로직·코드값(code, evidence)은 바꾸지 않는다.

`judge.js` 문구 (테스트가 검사하는 부분은 정확히 이대로):
- `finalVerdict` reasons
  - `Hand pose task failed: ${names}`
  - `Hand pose transition looked unnatural${detail ? `: ${detail}` : ''}`
  - `Screen color reflection not confirmed on palm (${m})`
  - `Screen color reflection not confirmed on face (${m})`
  - `No 3D face response to light direction (H=${h}, threshold > ${thr})`
- `diagnoseRound` message (code별)
  - insufficient(검출 없음) `Not enough data: face/hand not detected`
  - no_reflection `No reflection: possible virtual camera or recorded video`
  - screen_blocked `Possible partial screen block: weak response in the ${QUAD_EN[q]} quadrant (−N%)` — `QUAD_EN = { TL:'top-left', TR:'top-right', BL:'bottom-left', BR:'bottom-right' }`
  - color_tampered `Possible color tampering (filter/night mode): no response to ${weak.map(c => COLOR_EN[c]).join(' · ')}` — `COLOR_EN = { red:'red', green:'green', blue:'blue' }`
  - weak_color `Weak color reflection: maximize screen brightness and reduce ambient light`
  - insufficient(입체) `Not enough 3D data: face not detected`
  - flat_object `Possible flat object: no 3D response to light direction`
  - ok `Normal reflection`
- `checkTransition` 등 나머지 문구도 같은 톤의 영어로.
- 테스트의 "문구가 한국어인지" 검사는 "영어인지(라틴 문자 포함, 한글 없음)" 검사로 바꾼다.
