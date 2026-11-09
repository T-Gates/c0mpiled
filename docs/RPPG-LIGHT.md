# 통화 pulse·무작위 조명 검사

## 동작

호스트가 상대 타일을 선택하고 기존 **딥페이크 판정** 버튼을 누른다.
v1.1 얼굴 정렬 UI에서 호스트 수신 영상의 얼굴 위치·크기를 확인한다.
기존 기준을0.8초 유지하면 시작하며20초 안에 맞추지 못하면 보류한다.
상대 화면은 먼저 일정한 밝기로 32초 유지된다. 첫2초를 버린 수신 영상의
이마·양 볼 RGB로 POS pulse 후보를 추출한다. 이후 white/color 쌍을 6번
(RGB 순열2회, 총12단계 ×1.2초) 실행한다. 전체 약47초+네트워크 시간이다.
색 변화와 pulse는 같은 시간에 분석하지 않는다. 정렬 시간은 검사 시간에 추가된다.

호스트는 다음 색을 한 단계씩 보낸다. 참여자가 보낸 pulse·판정값은 사용하지 않는다.
참여자 ACK는 표시 진행 정보일 뿐, 물리적 출력의 인증 근거가 아니다.
두 browser 모두 이 버전으로 새로고침해야 한다.

## 모듈

- `src/call/rppg.js`: 실제 frame 시각으로 resampling, 1.6초 window POS,
  선형 detrend/Hann periodogram, 45–180 BPM 후보 band, ROI/시간 구간 일치.
- `src/call/roi.js`: 이마·양 볼별 RGB, clipping 비율, 얼굴 bounding box.
- `src/call/liveness.js`: 두 차례 색순서 확인, 추적 연속성, 종합 판정.
- `src/call/liveness-flow.js`: 호스트의 수신 영상 sampling 및 guest 색 출력 protocol.
- `src/call/main.js`: 기존 통화 버튼·결과 배지·중단 UI에 연결.

POS 수식 근거: Wang et al., *Algorithmic Principles of Remote PPG*,
IEEE TBME 2017, https://doi.org/10.1109/TBME.2016.2609282 .
채널 시간평균으로 정규화 후 `a=G-B`, `b=-2R+G+B`,
`h=a+std(a)/std(b)*b`를 window별 중심화해 overlap-average한다.
공개 rPPG-Toolbox POS 구현을 확인했지만 이 JS 구현은 별도로 작성했으며,
원본의 smoothness-prior detrend/Butterworth와 동일한 구현은 아니다.
신호 전체에 band-pass를 적용했다고 주장하지 않고, periodogram 후보 band를 제한한다.

## 품질 gate와 한계

현재 값들은 실측으로 선택된 보안 threshold가 아니라 exploratory 품질 gate다.

- 유효 pulse frame 비율95%, 최소25초/12fps, 최대 frame 간격250ms.
- 포화/암부 pixel3% 미만, 움직임 표준편차/얼굴 너비8% 이하.
- POS amplitude >0.00005, 후보 peak ±6BPM concentration ≥0.4.
- 한 ROI의 앞/뒤 구간 후보차8BPM 이하, 2개 이상 ROI의 후보차8BPM 이하.
- 조명 ACK 후450ms부터 단계 끝150ms 전까지 사용. 구간마다5frame 이상.
- 목표 채널 chroma 변화와 다른 채널 대비 우위가 모두 minDelta 이상이어야 한다.
  기존 `calibration.json`의 minDelta는 [.001,.1] 안일 때만 적용한다.
  기본값은 기존 `DEFAULTS.minDelta`다. 새 색의 세기가 달라 재검증이 필요하다.
- 추적은 큰 위치·크기 변화, 다중 얼굴, 영상/얼굴 상실을 검사한다.
  Identity embedding이나 deepfake detector가 아니다.

WebRTC 압축·자동 노출/WB·조명·움직임은 pulse를 없애거나 가짜 주기를 만들 수 있다.
데이터 채널과 영상 지연 차이가 sampling guard를 넘는 환경은 미검증이다.
화면 재생에 pulse가 남거나 실제 얼굴 교체에 두 신호가 전달될 수 있다.
색 반사는 3D 검사도, 피부 재질 검사도 아니다.

## 결과

`observed`: 두 신호 및 추적 gate 충족. 화면 문구는 **검사 조건 충족**.
`mismatch`: pulse/추적 품질은 충족했지만 조명 응답이 불일치.
`insufficient`: pulse/추적/조명 sampling 품질 부족 또는 runtime 오류.
모든 결과의 `humanVerified`, `deepfakeVerified`는 false.

현재 결과 metrics만 `window.__lastCheck`에 남긴다. 원본 영상·이름·기기 ID는
새 판정 로그에 저장하지 않는다. 생체인증 token을 발급하지 않는다.

## 검증과 실행

```sh
node --test
node --check src/call/main.js
node --check src/call/liveness-flow.js
node server/call-server.mjs --http --port 5191
```

localhost는 단일 기기 개발용이다. 다른 기기의 camera는 기존 HTTPS 실행 구성을 사용한다.
새 npm dependency/build 단계는 없다.

기존180 tests 대비 총189 tests. 새9개는 알려진72BPM 검출, 공통 밝기 변화/정지/
ROI 불일치/움직임/누락 frame 거부, 올바른/잘못된 색순서, 실제 pixel ROI,
종합 결과, host/guest protocol 순서와 취소를 확인한다.
Protocol tests는 mock timer/video를 사용하며 실제 WebRTC E2E가 아니다.
원격 main의 abea52c 얼굴 정렬 UI와 상태 전이를 병합한 뒤 전체 suite를 다시 실행했다.
Chrome에서 로비·수정 안내가 표시되는 것을 확인했다. 실제 두 기기 통화와
실제 얼굴/replay/실시간 얼굴 교체 성능은 아직 시험하지 않았다.

실측 순서: 실제 얼굴 반복 → 정지 사진 → 휴대폰 재생 → 가상 camera 녹화
→ 실시간 얼굴 교체. 각 결과의 pulse/light/track 이유를 함께 비교한다.
threshold 조정 자료와 확인용 자료는 분리한다. 같은 녹화의 frame을 독립 표본으로 세지 않는다.
