# Human Check 통화 — 계약 (call v2: pulse + light)

## 활성 변경사항 — 2026-11-09 사용자 승인

기존 딥페이크 판정 버튼을 `rPPG → 무작위 조명 응답 → 추적 연속성` 흐름으로 교체한다.
입체·parallax 검사는 제외한다. 아래 v1 본문은 이전 계약을 보존한 참고이며,
검사 로직·protocol·결과 문구·시간·테스트 관련 내용은 이 절과 `docs/RPPG-LIGHT.md`가 대체한다.
방/시그널링/WebRTC 연결·다크 갤러리와 기존 index.html 앱은 유지한다.

- 호스트가 수신한 영상으로만 계산. 참여자는 색을 표시하고 ACK만 보낸다.
- 32초 일정한 조명(첫2초 제외), 12단계 ×1.2초의 무작위 색 challenge. 전 구간 얼굴 추적.
- 새 `check-*`, version2 protocol. 전체 sequence는 호스트에만 있고, 한 단계씩 보낸다.
- 결과: `검사 조건 충족 / 조명 응답 불일치 / 측정 불충분`. 사람/피부 진위·딥페이크 부재를 보장하지 않는다.
- Esc/중지/탭 숨김/연결 끊김/시간 초과 때 중단. 영상은 저장하지 않는다.
- 사용자 승인 개발계획에 따라 기존 tests에 pure-signal 양성·음성 대조 및 protocol tests를 추가한다.
- 호스트와 참여자 모두 같은 version2 코드를 새로고침해야 한다. 이전 client는 timeout으로 보류한다.
- 실제 WebRTC 얼굴 pulse, 오수락/거부율, 딥페이크 검출 성능은 아직 미검증이다.

## 이전 v1 계약 (아래 내용은 변경 전 기록)

같은 Wi-Fi에 있는 최대 3명이 브라우저로 화상통화를 한다. 호스트(방을 만든 사람)는 참여자를 골라 "딥페이크 판정"을 누를 수 있다. 누르는 즉시 그 참여자의 화면 전체에 색 플래시가 뜬다. 호스트는 **자기가 받은 참여자 영상**에서 얼굴의 색 반사를 측정해 판정한다.

- 승인된 시안: `drafts/call-a.html` (다크 갤러리). 화면이 시안과 다르면 결함으로 본다.
- 기존 Human Check(`index.html`, `src/app.js`, `src/judge.js`)는 수정하지 않는다. `src/judge.js`는 import해서 재사용만 한다.

## 결정 사항

| 항목 | 결정 | 이유 |
|---|---|---|
| 연결 방식 | 브라우저 기본 WebRTC, 3인 mesh(각자 나머지 2명과 직접 연결) | 3명이면 미디어 서버가 필요 없음 |
| 시그널링 서버 | 별도 서버 없음. 내 맥에서 페이지를 띄우는 Node 프로세스 1개(지금의 `python3 -m http.server` 자리)가 연결 정보 중계까지 겸함. Node 표준 라이브러리만 사용 | 사용자 결정(내 맥에서 데모용 최소 구성). npm 의존 없음, 현장 인터넷 없어도 동작 |
| 오픈소스 | 쓰지 않음 (PeerJS도 결국 별도 서버 또는 공용 인터넷 서버 필요) | 위와 같음 |
| HTTPS | mkcert로 `localhost`·`127.0.0.1`·현재 LAN IP 인증서 생성. `mkcert -install`은 하지 않음 → 모든 기기에서 인증서 경고를 한 번 "계속"으로 통과 | 카메라는 보안 컨텍스트에서만 동작 |
| STUN/TURN | 없음 (같은 LAN 전제) | 범위 밖 |
| 판정 위치 | 호스트 브라우저가 수신 영상으로 판정 | 참여자가 결과를 위조할 수 없음 |
| 판정 내용 | 색 플래시 + **얼굴** 반사만 (손·사분면·손 모양 없음) | 사용자 결정. 첫 실측에서 휴대폰 공격은 얼굴 색만으로 갈림 |
| 플래시 시간 | 6구간 × 600ms = 3.6초, 각 구간 앞 300ms 버림 | 기존 500/200보다 길게: 데이터 채널과 영상 사이 지연 흡수 (가정, 실측으로 조정) |

## 파일 구조

```
call.html                 통화 UI (시안 A). 로비 + 통화 + 참여자 플래시 오버레이
src/call/main.js          화면·흐름 (브라우저 전용)
src/call/mesh.js          RTCPeerConnection·데이터 채널 관리 (브라우저 전용)
src/call/flashplan.js     순수 함수: 플래시 순서, 프레임 구간 나누기, 판정 결과 분류 (node import 가능, DOM 금지)
src/call/roi.js           순수 함수: RGBA 버퍼 + 얼굴 랜드마크 → 얼굴 ROI 평균 RGB (node import 가능, DOM 금지)
server/call-server.mjs    Node 표준 라이브러리만 사용. 정적 파일 + 방 API + SSE
tools/make-cert.sh        mkcert로 certs/cert.pem, certs/key.pem 생성 (현재 LAN IP 포함)
certs/                    .gitignore 대상
```

실행: `tools/make-cert.sh && node server/call-server.mjs` → `https://<LAN IP>:8443/call.html`
테스트: `node --test` (기존 테스트 포함 전부 통과해야 함)

## 서버 (`server/call-server.mjs`)

```js
export function createCallHandler({ root, maxPeers = 3, lanIps = autoDetect, port = 8443 }) // → (req, res) => void
export function startCallServer({ port = 8443, http = false, root }) // CLI 진입점이 사용
```

- CLI: `node server/call-server.mjs [--port 8443] [--http]`. `--http`가 없으면 `certs/cert.pem`, `certs/key.pem`으로 HTTPS. 파일이 없으면 `tools/make-cert.sh`를 실행하라고 안내하고 exit 1. 바인딩은 `0.0.0.0`. 시작 시 접속 주소(`https://<LAN IP>:<port>/call.html`)를 출력한다.
- 정적 파일: `root` 아래 파일만 GET으로 제공. `/` → `call.html`. 경로 탈출(`..`)은 404. MIME: html, js, mjs, json, css, png, svg.
- 모든 API 응답은 JSON(`content-type: application/json`), 요청 본문도 JSON. 잘못된 JSON은 400 `{error:'bad_request'}`.
- `peerId`는 무작위 16 hex. 방 코드는 `[a-z0-9]` 4글자, 서버가 생성(겹치지 않게).

| 요청 | 성공 | 실패 |
|---|---|---|
| `GET /api/info` | 200 `{ urls: ["https://<ip>:<port>/call.html", ...] }` (IPv4, 내부 주소 제외) | |
| `POST /api/rooms` `{name}` | 201 `{ room, peerId, role:'host', hostId:peerId, peers:[] }` | name 없음/빈 문자열 → 400 |
| `POST /api/rooms/:room/join` `{name}` | 200 `{ room, peerId, role:'guest', hostId, peers:[{peerId,name,role}] }` (본인 제외 기존 인원) | 방 없음 → 404 `{error:'room_not_found'}`, 이미 maxPeers명 → 409 `{error:'room_full'}`, name 없음 → 400 |
| `GET /api/rooms/:room/events?peer=<peerId>` | 200 SSE (`text/event-stream`), 이벤트마다 `data: <json>\n\n` | 방·peer 모름 → 404 |
| `POST /api/rooms/:room/signal` `{from, to, payload}` | 204, `to`의 SSE로 `{type:'signal', from, payload}` 전달 | 방 없음 → 404, from 또는 to가 방에 없음 → 403 |
| `POST /api/rooms/:room/leave` `{peerId}` | 204 | 방 없음 → 404 |

SSE 이벤트:
- 참여 시 기존 인원 모두에게 `{type:'peer-joined', peerId, name, role}`
- 퇴장 시(leave 또는 SSE 연결 끊김) 남은 인원에게 `{type:'peer-left', peerId}`
- 호스트 퇴장 시 남은 인원에게 `{type:'room-closed'}`를 보내고 방 삭제
- SSE 연결 전에 생긴 이벤트는 peer별로 쌓아 두었다가 연결 시 순서대로 보낸다.
- 15초마다 `: ping\n\n` 주석 줄을 보낸다(연결 유지).

## 연결 (`src/call/mesh.js`)

- 새로 들어온 사람이 기존 인원 각각에게 offer를 보낸다. 기존 인원은 offer를 받아 answer한다. signal `payload`: `{kind:'offer'|'answer', sdp}` 또는 `{kind:'ice', candidate}`.
- offer를 만드는 쪽이 연결마다 데이터 채널 `ctl`(ordered)을 만든다.
- 카메라는 `getUserMedia({ video:{ width:640, height:480 }, audio:true })`를 연결 전에 호출한다(Chrome이 실제 LAN IP 후보를 쓰게 하려는 목적도 있음).
- 데이터 채널 메시지(JSON):
  - 모두 → 모두 `{type:'media-state', mic, cam}` (연결 직후 1회 + 토글할 때마다)
  - 호스트 → 참여자 `{type:'flash-start', runId, seq, stepMs}`
  - 참여자 → 호스트 `{type:'flash-step', runId, i, color}` (i번째 색을 화면에 칠한 직후 다음 프레임에서 전송)
  - 참여자 → 호스트 `{type:'flash-end', runId}`
- 참여자는 `hostId`의 연결에서 온 `flash-start`만 따른다. 이미 플래시 중이면 무시한다.

## 플래시와 판정

참여자 쪽: `flash-start`를 받으면 화면 전체(통화 UI 위)를 `seq` 순서대로 `stepMs`씩 칠한다. RGB: white `[255,255,255]`, red `[255,0,0]`, green `[0,255,0]`, blue `[0,0,255]`. 하단에 "호스트가 사람 확인 중입니다 · 화면을 바라봐 주세요" 알약을 띄운다. 끝나면 원래 화면으로 돌아온다.

호스트 쪽:
1. 참여자 화면을 클릭해 선택 → "딥페이크 판정" 활성. 판정 중에는 비활성.
2. 누르면 `seq = makeFlashSequence()`로 `flash-start` 전송.
3. 판정 중에만 그 참여자의 `<video>`에 FaceLandmarker(`@mediapipe/tasks-vision@0.10.14`, VIDEO 모드, numFaces 1)를 매 프레임 돌린다. 프레임마다 `{t: performance.now(), face: [r,g,b] | null}`을 기록한다(얼굴 없으면 null).
4. `flash-step`을 받은 시각(`performance.now()`)을 i번째 구간 시작으로 기록한다.
5. `flash-end`를 받으면 `stepMs` 동안 프레임을 더 모은 뒤 계산한다(마지막 구간도 다 채우려는 목적). 구간 나누기 → 단계 만들기 → `judgeColorSteps(steps, { ...DEFAULTS, minDelta })` → `classifyResult`.
   - `minDelta`: 루트의 `calibration.json`에 `minDelta`가 있으면 그 값, 없으면 `DEFAULTS.minDelta`.
6. `flash-start` 후 `seq.length × stepMs + 3000`ms 안에 `flash-end`가 안 오거나 그 참여자가 나가면 `error`.

### `src/call/flashplan.js` (순수 함수)

```js
export const CALL_FLASH = { stepMs: 600, discardMs: 300 };
export const FLASH_RGB = { white:[255,255,255], red:[255,0,0], green:[0,255,0], blue:[0,0,255] };

// → ['white', c1, 'white', c2, 'white', c3], c1~c3은 red/green/blue의 순열.
// rand: () => [0,1) 실수. 기본값은 crypto.getRandomValues 기반.
export function makeFlashSequence(rand)

// frames: [{t, face:[r,g,b]|null}], stepStarts: 길이 n의 구간 시작 시각(오름차순, 누락은 null)
// i번째 구간 = [stepStarts[i] + discardMs, end_i), end_i = stepStarts[i+1] ?? stepStarts[i] + stepMs (다음 시작이 null이어도 stepStarts[i] + stepMs)
// 구간 안의 face가 null이 아닌 프레임 평균 RGB. 샘플 0개 또는 stepStarts[i]가 null이면 null.
// → 길이 n 배열
export function bucketFrames(frames, stepStarts, { stepMs, discardMs })

// seq(6) + means(6) → [{color:c1, baseline:means[0], sample:means[1]}, {color:c2, baseline:means[2], sample:means[3]}, {color:c3, baseline:means[4], sample:means[5]}]
export function buildFaceSteps(seq, means)

// judge = judgeColorSteps 결과
// → { status, label, deltas }
//   status: 'human'(judge.passed) | 'unmeasured'(baseline 또는 sample이 null인 단계가 하나라도 있음) | 'suspect'(그 외 불통과)
//   'unmeasured' 판단이 'suspect'보다 우선. judge.passed가 true면 무조건 'human'.
//   label: human '✓ 사람 확인됨' | suspect '✕ 반사 없음 · 딥페이크 의심' | unmeasured '? 얼굴이 잘 안 보여 판정 불가'
//   deltas: { red, green, blue } — 각 색 단계의 목표 채널 chroma Δ (judge.details[k].delta[채널]), 측정 불가면 null
export function classifyResult(steps, judge)
```

`error` 상태(시간 초과·퇴장)는 `main.js`가 직접 만든다: label `'판정 실패 · 다시 시도해 주세요'`.

### `src/call/roi.js` (순수 함수)

```js
export const FACE_ROI_IDX = [50, 280, 151];
export const FACE_ROI_RADIUS = 0.06;
// frame: { data: Uint8ClampedArray(RGBA), width, height }, landmarks: [{x,y}] 정규화 좌표(468개 이상)
// 원 3개: 중심 = landmarks[50|280|151] × (width, height), 반지름 = (랜드마크 전체 x의 max−min) × width × 0.06
// 세 원 중 하나라도 안에 드는 픽셀(픽셀 중심 x+0.5, y+0.5 기준, 경계 포함)의 평균 [r,g,b]. 화면 밖은 잘라냄. 픽셀 0개면 null.
export function faceMeanRgb(frame, landmarks)
```

(기존 `src/app.js`의 `faceMean`과 같은 정의. app.js는 건드리지 않고 같은 규칙을 새로 구현한다.)

## 화면 (`call.html`, 시안 A)

- **로비**: 내 카메라 미리보기(마이크·카메라 토글), 이름 입력, "방 만들기 (호스트)", 방 코드 입력 + "참여하기", 광과민성 안내. URL에 `?room=ab12`가 있으면 코드 칸을 채운다.
- **통화**: 위 줄에 방 코드, 초대 주소(`/api/info`의 첫 주소 + `?room=`), "복사", 인원 수, 내 역할. 가운데 타일 최대 3개(내 영상은 좌우 반전 + 음소거 재생). 아래 바: 마이크, 카메라, (호스트만) 딥페이크 판정, 나가기. 호스트만 아래 안내 줄을 본다.
  - 화면 폭 700px 미만이면 타일을 한 줄에 1개로 쌓는다.
  - 상대가 마이크를 끄면 이름표에 🔇, 카메라를 끄면 타일에 "카메라 꺼짐".
- **호스트 전용**: 참여자 타일 클릭 → 파란 테두리 + "선택됨". 판정 중에는 타일 왼쪽 위에 "판정 중 i/6 · 색이름" + 6칸 진행 막대. 끝나면 결과 배지(human 초록, suspect 빨강, unmeasured·error 회색 계열)와 상세 줄 "얼굴 반사 Δ · 빨강 0.012 · 초록 0.010 · 파랑 0.007". 결과 배지는 다음 판정 전까지 유지.
- **참여자**: 선택·판정 UI 없음. 플래시 중 전체 화면 색 + 알약.
- **오류 문구**: 보안 컨텍스트 아님("https:// 주소로 들어와 주세요"), 카메라 거부, 방 없음, 방 가득 참, 호스트가 방을 닫음.

## 비범위

TURN/STUN, 4명 이상, 로그인·인증, 녹화, 화면 공유, 채팅, 손·사분면·손 모양 판정, 판정 데이터 저장/다운로드, `mkcert -install`.

## 완료 기준

1. 테스트 코드는 작성하지 않는다(사용자 결정, 해커톤 속도 우선). 기존 `node --test`는 계속 통과해야 한다. 검증은 실제 실행으로 한다.
2. 헤드리스 Chrome 3개(가짜 카메라)로 연결 확인: 호스트가 방을 만들고 2명이 참여하면 셋 다 타일 3개가 보인다. 호스트가 판정을 누르면 참여자 화면이 6단계로 바뀌고, 호스트에 결과 배지가 뜬다(가짜 카메라에는 얼굴이 없으므로 `unmeasured`가 정상).
3. 실제 기기 확인(사용자): 같은 Wi-Fi 3대로 진짜 얼굴은 `human`, 휴대폰 영상 재생은 `suspect`가 나오는지 확인. 영상 압축 뒤에도 색 Δ가 남는지 여기서 처음 검증된다.

## 위험

- **영상 압축**: WebRTC 압축과 해상도 자동 조절 때문에 얼굴 Δ(실측 0.007~0.014)가 줄 수 있다. 미검증.
- **지연 정렬**: 데이터 채널 메시지와 영상의 지연 차이가 300ms를 넘으면 구간이 섞인다. 실측 후 `CALL_FLASH`를 조정한다.
- **현장 Wi-Fi 기기 간 차단**: 막혀 있으면 휴대폰 핫스팟을 쓴다.
- **LAN IP 변경**: Wi-Fi가 바뀌면 `tools/make-cert.sh`를 다시 실행해야 한다.
