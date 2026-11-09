// Human Check 통화 — 화면·흐름 (브라우저 전용)
import { DEFAULTS, judgeColorSteps, chroma } from '../judge.js';
import {
  CALL_FLASH,
  FLASH_RGB,
  ALIGN,
  makeFlashSequence,
  bucketFrames,
  buildFaceSteps,
  classifyResult,
  faceAlignment,
  median,
} from './flashplan.js';
import { faceMeanRgb } from './roi.js';
import { createMesh } from './mesh.js';

// ---------- 상수 ----------
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const COLOR_LABEL = { white: 'White', red: 'Red', green: 'Green', blue: 'Blue' };
const STEP_SWATCH = { white: '#fff', red: '#e33', green: '#2c3', blue: '#37f' };
const ERROR_LABEL = 'Check failed · Please try again';
const VALID_COLORS = new Set(Object.keys(FLASH_RGB));
const ALIGN_FAIL_LABEL = "Couldn't align face · Check failed";
const FAR_LABEL = "? Face too far · Can't verify";
const ALIGN_HINT_KO = {
  no_face: "Can't see your face",
  closer: 'Move a little closer',
  farther: 'Move back a little',
  center: 'Center your face',
  ok: 'Great, hold still',
  loading: 'Preparing…', // v1.2: 참여자 기기에서 얼굴 인식 모델을 아직 불러오는 중
};
const METER_MAX = 1.3; // 크기 막대 0~130%

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const screens = { lobby: $('lobby'), call: $('call'), flash: $('flash') };
const lobbyPrev = $('lobbyPrev');
const lobbyVideo = $('lobbyVideo');
const lobbyMic = $('lobbyMic');
const lobbyCam = $('lobbyCam');
const nameInput = $('nameInput');
const codeInput = $('codeInput');
const createBtn = $('createBtn');
const joinBtn = $('joinBtn');
const enterBtn = $('enterBtn');
const inviteRoomEl = $('inviteRoom');
const newRoomLink = $('newRoomLink');
const lobbyErr = $('lobbyErr');
const roomCodeEl = $('roomCode');
const inviteUrlEl = $('inviteUrl');
const copyBtn = $('copyBtn');
const whoInfo = $('whoInfo');
const grid = $('grid');
const micBtn = $('micBtn');
const camBtn = $('camBtn');
const judgeBtn = $('judgeBtn');
const leaveBtn = $('leaveBtn');
const hint = $('hint');
const flashEl = $('flash');
const alignEl = $('align');
const alignStage = $('alignStage');
const alignVideo = $('alignVideo');
const alignGuide = $('alignGuide');
const alignEllipse = $('alignEllipse');
const alignShoulders = $('alignShoulders');
const alignPill = $('alignPill');
const alignMeterFill = $('alignMeterFill');
const alignMeterMark = $('alignMeterMark');
const alignMeterTxt = $('alignMeterTxt');

// ---------- 상태 ----------
let localStream = null;
let insecure = false;
const media = { mic: true, cam: true };
let minDelta = DEFAULTS.minDelta;

/** 통화 세션. 로비에서는 null */
let S = null;
// S = { room, peerId, role, hostId, name, es, mesh, peers: Map<peerId, PeerView>, selected, check(호스트), gcheck(참여자), inviteUrl }
// PeerView = { peerId, name, role, tile, video, nameEl, badge, detail, mic, cam }

// ---------- 화면 전환 ----------
function show(name) {
  for (const [k, el] of Object.entries(screens)) {
    if (k === 'flash') continue;
    el.classList.toggle('on', k === name);
  }
}

// 초대 링크(?room=)로 들어온 경우: 이름 + 입장하기만 보이는 로비
let inviteMode = false;

// newRoom: 초대 로비에서 입장 실패(방 없음·가득 참·방 닫힘 등) 시 "새 방 만들기" 링크도 보여 준다
function setLobbyError(msg, { newRoom = false } = {}) {
  lobbyErr.textContent = msg || '';
  lobbyErr.classList.toggle('on', Boolean(msg));
  newRoomLink.hidden = !(inviteMode && newRoom && msg);
}

// ---------- 카메라 ----------
async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    insecure = true;
    setLobbyError('Please open this page with an https:// address');
    setLobbyBusy(true);
    return false;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true });
  } catch (e) {
    console.warn('getUserMedia 실패', e);
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    setLobbyError(
      denied
        ? 'Camera and mic access was denied. Allow it in your browser settings, then reload.'
        : "Can't open the camera or mic. Check that no other app is using it, then reload.",
    );
    return false;
  }
  lobbyVideo.srcObject = localStream;
  lobbyVideo.play().catch(() => {});
  applyMediaState();
  return true;
}

function applyMediaState() {
  if (localStream) {
    for (const t of localStream.getAudioTracks()) t.enabled = media.mic;
    for (const t of localStream.getVideoTracks()) t.enabled = media.cam;
  }
  for (const btn of [lobbyMic, micBtn]) {
    btn.classList.toggle('off', !media.mic);
    btn.querySelector('.ic').textContent = media.mic ? '🎤' : '🔇';
  }
  for (const btn of [lobbyCam, camBtn]) btn.classList.toggle('off', !media.cam);
  lobbyPrev.classList.toggle('camoff', !media.cam);
  if (S) {
    const self = S.peers.get(S.peerId);
    if (self) {
      self.mic = media.mic;
      self.cam = media.cam;
      renderPeerMedia(self);
    }
  }
}

function toggleMic() {
  media.mic = !media.mic;
  applyMediaState();
  if (S && S.mesh) S.mesh.broadcast({ type: 'media-state', mic: media.mic, cam: media.cam });
}
function toggleCam() {
  media.cam = !media.cam;
  applyMediaState();
  if (S && S.mesh) S.mesh.broadcast({ type: 'media-state', mic: media.mic, cam: media.cam });
}

// ---------- 보정값 ----------
async function loadCalibration() {
  try {
    const res = await fetch('./calibration.json', { cache: 'no-store' });
    if (!res.ok) return;
    const c = await res.json();
    if (c && typeof c.minDelta === 'number' && Number.isFinite(c.minDelta)) minDelta = c.minDelta;
  } catch {
    // 없거나 잘못된 파일은 기본값 사용
  }
}

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = res.status === 204 ? null : await res.json();
  } catch {}
  return { ok: res.ok, status: res.status, data };
}

function sendLeaveBeacon(room, peerId) {
  const url = `/api/rooms/${encodeURIComponent(room)}/leave`;
  const body = JSON.stringify({ peerId });
  let sent = false;
  try {
    sent = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
  } catch {}
  if (!sent) {
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
}

// ---------- 로비 동작 ----------
function readName() {
  const name = nameInput.value.trim();
  if (!name) {
    setLobbyError('Please enter your name');
    nameInput.focus();
    return null;
  }
  try {
    localStorage.setItem('hc-call-name', name);
  } catch {}
  return name;
}

function setLobbyBusy(busy) {
  createBtn.disabled = busy || insecure;
  joinBtn.disabled = busy || insecure;
  enterBtn.disabled = busy || insecure;
}

async function onCreate() {
  setLobbyError('');
  const name = readName();
  if (!name) return;
  setLobbyBusy(true);
  try {
    if (!localStream && !(await startCamera())) return;
    const r = await api('/api/rooms', { name });
    if (!r.ok || !r.data) {
      setLobbyError(r.status === 400 ? 'Please enter your name' : "Couldn't create a room. Please try again shortly.");
      return;
    }
    enterCall(r.data, name);
  } catch (e) {
    console.warn(e);
    setLobbyError("Can't reach the server. Please check the address.");
  } finally {
    setLobbyBusy(false);
  }
}

async function onJoin() {
  setLobbyError('');
  const name = readName();
  if (!name) return;
  const code = codeInput.value.trim().toLowerCase();
  if (!/^[a-z0-9]{4}$/.test(code)) {
    if (inviteMode) {
      setLobbyError('The room code in this invite link is invalid. Please check the link.', { newRoom: true });
      return;
    }
    setLobbyError('Please enter the 4-character room code');
    codeInput.focus();
    return;
  }
  setLobbyBusy(true);
  try {
    if (!localStream && !(await startCamera())) return;
    const r = await api(`/api/rooms/${encodeURIComponent(code)}/join`, { name });
    if (!r.ok || !r.data) {
      if (r.status === 404)
        setLobbyError(
          inviteMode ? 'Room not found. It may have already ended.' : 'Room not found. Please check the room code.',
          { newRoom: true },
        );
      else if (r.status === 409) setLobbyError('This room is full (max 3 people)', { newRoom: true });
      else if (r.status === 400) setLobbyError('Please enter your name');
      else setLobbyError("Couldn't join. Please try again shortly.", { newRoom: true });
      return;
    }
    enterCall(r.data, name);
  } catch (e) {
    console.warn(e);
    setLobbyError("Can't reach the server. Please check the address.");
  } finally {
    setLobbyBusy(false);
  }
}

// ---------- 통화 시작/종료 ----------
function enterCall(info, name) {
  S = {
    room: info.room,
    peerId: info.peerId,
    role: info.role,
    hostId: info.hostId,
    name,
    es: null,
    mesh: null,
    peers: new Map(),
    selected: null,
    check: null,
    gcheck: null,
    inviteUrl: `${location.origin}${location.pathname}?room=${info.room}`,
  };
  const isHost = S.role === 'host';
  for (const el of document.querySelectorAll('[data-host]')) el.hidden = !isHost;
  roomCodeEl.textContent = S.room;
  inviteUrlEl.textContent = S.inviteUrl;
  loadInviteUrl(S);
  grid.textContent = '';

  addTile({ peerId: S.peerId, name: S.name, role: S.role, self: true });
  for (const p of info.peers || []) addTile(p);
  renderCount();

  S.mesh = createMesh({
    localStream,
    sendSignal: (to, payload) => sendSignal(to, payload),
    onTrack: onRemoteTrack,
    onMessage: onPeerMessage,
    onChannelOpen: (peerId) => {
      if (!S) return;
      S.mesh.send(peerId, { type: 'media-state', mic: media.mic, cam: media.cam });
      renderHostUi();
    },
    onPeerState: (peerId, state) => {
      if (!S) return;
      if (state === 'failed' || state === 'closed' || state === 'channel-closed') {
        if (S.check && S.check.peerId === peerId && !S.check.done) failCheck('Connection lost');
        if (S.role === 'guest' && peerId === S.hostId && S.gcheck) stopGuestCheck(S.gcheck);
      }
      renderHostUi();
    },
  });

  // SSE를 먼저 열고(서버가 연결 전 이벤트를 쌓아 둠) 기존 인원에게 offer를 보낸다
  openEvents(S);
  for (const p of info.peers || []) {
    S.mesh.connectTo(p.peerId).catch((e) => console.warn('offer 실패', p.peerId, e));
  }

  // v1.2: 측정은 참여자가 한다 → 참여자가 입장하자마자 얼굴 인식 모델을 미리 불러오고 워밍업 (호스트는 MediaPipe 안 씀)
  if (!isHost) ensureFaceModel().catch(() => {});
  applyMediaState();
  renderHostUi();
  show('call');
  // 참여자만 주소에 방 코드를 남긴다(새로고침하면 초대 로비로 같은 방에 다시 입장). 호스트는 새로고침 시 전체 로비.
  if (!isHost) {
    const u = new URL(location.href);
    u.searchParams.set('room', S.room);
    history.replaceState(null, '', u);
  }
}

async function loadInviteUrl(sess) {
  try {
    const res = await fetch('/api/info', { cache: 'no-store' });
    if (!res.ok) return;
    const d = await res.json();
    if (S !== sess || !d || !Array.isArray(d.urls) || !d.urls[0]) return;
    sess.inviteUrl = `${d.urls[0]}?room=${sess.room}`;
    inviteUrlEl.textContent = sess.inviteUrl;
  } catch {}
}

function openEvents(sess) {
  const es = new EventSource(
    `/api/rooms/${encodeURIComponent(sess.room)}/events?peer=${encodeURIComponent(sess.peerId)}`,
  );
  sess.es = es;
  es.onmessage = (e) => {
    if (S !== sess) return;
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    onServerEvent(ev);
  };
  es.onerror = () => {
    if (S !== sess) return;
    // 자동 재연결을 포기한 경우(서버가 우리를 모름 = 404 등)
    if (es.readyState === EventSource.CLOSED) {
      exitCall('Lost connection to the server. Please join again.', { notifyServer: false });
    }
  };
}

function sendSignal(to, payload) {
  if (!S) return;
  const sess = S;
  api(`/api/rooms/${encodeURIComponent(sess.room)}/signal`, { from: sess.peerId, to, payload })
    .then((r) => {
      if (!r.ok) console.warn('signal 실패', r.status, payload.kind);
    })
    .catch((e) => console.warn('signal 실패', e));
}

function onServerEvent(ev) {
  if (!S || !ev) return;
  if (ev.type === 'signal') {
    S.mesh.handleSignal(ev.from, ev.payload);
  } else if (ev.type === 'peer-joined') {
    if (ev.peerId !== S.peerId && !S.peers.has(ev.peerId)) {
      addTile({ peerId: ev.peerId, name: ev.name, role: ev.role });
      renderCount();
      renderHostUi();
    }
  } else if (ev.type === 'peer-left') {
    removePeer(ev.peerId);
  } else if (ev.type === 'room-closed') {
    exitCall('The host closed the room', { notifyServer: false });
  }
}

function removePeer(peerId) {
  if (!S || peerId === S.peerId) return;
  if (S.check && S.check.peerId === peerId && !S.check.done) failCheck('The participant left');
  S.mesh.remove(peerId);
  const pv = S.peers.get(peerId);
  if (pv) {
    pv.tile.remove();
    S.peers.delete(peerId);
  }
  if (S.selected === peerId) S.selected = null;
  renderCount();
  renderHostUi();
}

function exitCall(message, { notifyServer = true } = {}) {
  if (!S) return;
  const sess = S;
  S = null;
  if (notifyServer) sendLeaveBeacon(sess.room, sess.peerId);
  if (sess.check) stopCheck(sess.check);
  if (sess.gcheck) stopGuestCheck(sess.gcheck);
  closeAlign();
  try {
    sess.es && sess.es.close();
  } catch {}
  sess.mesh && sess.mesh.closeAll();
  for (const pv of sess.peers.values()) {
    if (pv.video) pv.video.srcObject = null;
  }
  grid.textContent = '';
  flashEl.classList.remove('on');
  setLobbyError(message || '', { newRoom: true });
  codeInput.value = sess.role === 'guest' ? sess.room : codeInput.value;
  show('lobby');
  lobbyVideo.play().catch(() => {});
}

// ---------- 타일 ----------
function addTile({ peerId, name, role, self = false }) {
  const tile = document.createElement('div');
  tile.className = 'video tile';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  if (self) {
    video.muted = true;
    video.classList.add('mirror');
    video.srcObject = localStream;
  }
  const camoff = document.createElement('div');
  camoff.className = 'camoff-label';
  camoff.textContent = 'Camera off';
  const badge = document.createElement('div');
  badge.className = 'badge';
  const detail = document.createElement('div');
  detail.className = 'detail';
  const selmark = document.createElement('div');
  selmark.className = 'selmark';
  selmark.textContent = 'Selected';
  const nameEl = document.createElement('div');
  nameEl.className = 'name';
  tile.append(video, camoff, badge, detail, selmark, nameEl);
  grid.append(tile);

  const pv = { peerId, name: name || 'Participant', role, self, tile, video, nameEl, badge, detail, mic: true, cam: true };
  if (self) {
    pv.mic = media.mic;
    pv.cam = media.cam;
    video.play().catch(() => {});
  }
  S.peers.set(peerId, pv);
  if (!self && S.role === 'host') {
    tile.classList.add('pick');
    tile.addEventListener('click', () => selectPeer(peerId));
  }
  renderPeerMedia(pv);
  return pv;
}

function renderPeerMedia(pv) {
  let label = pv.name;
  if (pv.self) label += S && S.role === 'host' ? ' (you · host)' : ' (you)';
  else if (pv.role === 'host') label += ' (host)';
  pv.nameEl.textContent = pv.mic ? label : `${label} 🔇`;
  pv.tile.classList.toggle('camoff', !pv.cam);
}

function renderCount() {
  if (!S) return;
  const n = S.peers.size;
  whoInfo.textContent = `${S.role === 'host' ? 'Host' : 'Participant'} · ${n} ${n === 1 ? 'person' : 'people'}`;
  grid.style.setProperty('--cols', String(Math.max(1, Math.min(3, n))));
}

function onRemoteTrack(peerId, stream) {
  if (!S) return;
  const pv = S.peers.get(peerId);
  if (!pv) return;
  if (pv.video.srcObject !== stream) pv.video.srcObject = stream;
  playWithSound(pv.video);
}

// 소리 자동 재생이 막히면 음소거로 먼저 재생하고, 다음 클릭/터치에서 소리를 켠다
function playWithSound(video) {
  video.muted = false;
  video.play().catch(() => {
    video.muted = true;
    video.play().catch(() => {});
    const unmute = () => {
      video.muted = false;
      video.play().catch(() => {});
    };
    document.addEventListener('pointerdown', unmute, { once: true });
  });
}

// ---------- 데이터 채널 메시지 ----------
function onPeerMessage(peerId, msg) {
  if (!S) return;
  const pv = S.peers.get(peerId);
  switch (msg.type) {
    case 'media-state':
      if (pv && !pv.self) {
        pv.mic = Boolean(msg.mic);
        pv.cam = Boolean(msg.cam);
        renderPeerMedia(pv);
      }
      break;
    // 참여자 ← 호스트
    case 'check-start':
      if (S.role === 'guest' && peerId === S.hostId) onCheckStart(peerId, msg);
      break;
    case 'check-cancel':
      if (S.role === 'guest' && peerId === S.hostId) onCheckCancel(msg);
      break;
    // 호스트 ← 참여자
    case 'check-progress':
      onCheckProgress(peerId, msg);
      break;
    case 'check-result':
      onCheckResult(peerId, msg);
      break;
    case 'check-error':
      onCheckError(peerId, msg);
      break;
  }
}

// ---------- 참여자: 얼굴 맞추기 (v1.1) ----------
// 윤곽선은 내 영상의 실제 콘텐츠 영역 좌표로 그린다: 무대(stage)를 영상과 같은 비율로 맞추고
// SVG viewBox를 "높이 300 단위" 좌표계(너비 = 300·W/H)로 둔다 → 4:3에서는 시안의 400×300과 같다.
// 어깨선은 시안 경로를 타원 반높이(ry) 기준 상대 좌표로 옮긴 것 (세로 영상에서도 사람 모양 유지).
const SHOULDER = [
  // [dx, dy] / ry, 시안: 중심(200,141), ry 81
  [-160, 159], [-148, 107], [-92, 95], [-50, 89], [-24, 85], [-22, 71],
].map(([x, y]) => [x / 81, y / 81]);

function alignVideoSize() {
  let W = alignVideo.videoWidth;
  let H = alignVideo.videoHeight;
  if (!(W > 0 && H > 0) && localStream) {
    const st = localStream.getVideoTracks()[0]?.getSettings?.() || {};
    W = st.width;
    H = st.height;
  }
  if (!(W > 0 && H > 0)) {
    W = 4;
    H = 3;
  }
  return { W, H };
}

function layoutAlign() {
  if (!alignEl.classList.contains('on')) return;
  const { W, H } = alignVideoSize();
  const availW = Math.max(120, window.innerWidth - 32);
  const maxH = Math.min(window.innerHeight * 0.72, 560);
  let h = maxH;
  let w = (h * W) / H;
  if (w > availW) {
    w = availW;
    h = (w * H) / W;
  }
  alignStage.style.width = `${Math.round(w)}px`;
  alignStage.style.height = `${Math.round(h)}px`;
  const vh = 300;
  const vw = (vh * W) / H;
  alignGuide.setAttribute('viewBox', `0 0 ${vw.toFixed(2)} ${vh}`);
  const cx = vw / 2;
  const cy = ALIGN.cy * vh;
  const ry = ALIGN.ry * vh;
  alignEllipse.setAttribute('cx', cx.toFixed(2));
  alignEllipse.setAttribute('cy', cy.toFixed(2));
  alignEllipse.setAttribute('ry', ry.toFixed(2));
  alignEllipse.setAttribute('rx', (ry * ALIGN.aspect).toFixed(2));
  const side = (sx) => {
    const p = SHOULDER.map(([dx, dy]) => `${(cx + sx * dx * ry).toFixed(2)} ${(cy + dy * ry).toFixed(2)}`);
    return `M${p[0]} C ${p[1]}, ${p[2]}, ${p[3]} Q ${p[4]}, ${p[5]}`;
  };
  alignShoulders.setAttribute('d', `${side(1)} ${side(-1)}`);
}

function renderAlign(hint, size) {
  const h = ALIGN_HINT_KO[hint] ? hint : 'no_face';
  const ok = h === 'ok';
  alignEl.classList.toggle('ok', ok);
  alignPill.textContent = ALIGN_HINT_KO[h];
  const sz = typeof size === 'number' && Number.isFinite(size) ? size : 0;
  alignMeterFill.style.width = `${(Math.min(Math.max(sz, 0), METER_MAX) / METER_MAX) * 100}%`;
  const pct = Math.round(sz * 100);
  alignMeterTxt.textContent = ok
    ? `Face size ${pct}% · Colors start soon`
    : `Face size ${pct}% · Starts at ${Math.round(ALIGN.sizeMin * 100)}%`;
}

function showAlignOverlay() {
  alignVideo.srcObject = localStream;
  alignVideo.play().catch(() => {});
  alignMeterMark.style.left = `${(ALIGN.sizeMin / METER_MAX) * 100}%`;
  alignEl.classList.add('on');
  layoutAlign();
}

function closeAlign() {
  alignEl.classList.remove('on', 'ok');
  alignVideo.srcObject = null;
}

alignVideo.addEventListener('resize', layoutAlign);
alignVideo.addEventListener('loadedmetadata', layoutAlign);
window.addEventListener('resize', layoutAlign);

// ---------- 참여자: 측정 (v1.2) ----------
// 참여자가 자기 카메라 원본으로 얼굴 검출·맞추기·ROI 색 평균을 한다.
// 구간 시작 = 그 색을 칠한 다음 rAF 시각, 프레임 시각 = rVFC captureTime(없으면 콜백 시각). 둘 다 performance.now() 기준.
const GUEST_PROGRESS_MIN_MS = 200; // check-progress 최대 초당 5회 (+ 단계가 바뀔 때 1회)
const GUEST_TAIL_MS = 300; // 플래시가 끝난 뒤 늦게 도착하는 카메라 프레임을 더 받는 시간

function mergeAlign(a) {
  const o = { ...ALIGN };
  if (a && typeof a === 'object') {
    for (const k of Object.keys(ALIGN)) if (typeof a[k] === 'number' && Number.isFinite(a[k])) o[k] = a[k];
  }
  return o;
}

function onCheckStart(hostPeerId, msg) {
  const runId = msg.runId;
  if (typeof runId !== 'string') return;
  const reply = (m) => S.mesh.send(hostPeerId, { ...m, runId });
  if (S.gcheck && !S.gcheck.done) {
    reply({ type: 'check-error', reason: 'busy' });
    return;
  }
  const seq = msg.seq;
  const stepMs = Number(msg.stepMs);
  const discardMs = Number(msg.discardMs ?? CALL_FLASH.discardMs);
  if (!Array.isArray(seq) || seq.length === 0 || seq.length > 12 || !seq.every((c) => VALID_COLORS.has(c))) return;
  if (!(stepMs >= 100 && stepMs <= 3000) || !(discardMs >= 0 && discardMs < stepMs)) return;
  if (!localStream || !media.cam) {
    reply({ type: 'check-error', reason: 'camera_off' });
    return;
  }
  const g = {
    sess: S,
    hostPeerId,
    runId,
    seq,
    stepMs,
    discardMs,
    align: mergeAlign(msg.align),
    phase: 'loading',
    done: false,
    frames: [],
    preFrames: [],
    paintStarts: new Array(seq.length).fill(null),
    okSince: null,
    lastProgressAt: -Infinity,
    lastPhaseSent: null,
    timers: [],
    detectMs: [],
    loop: null,
    raf: 0,
    receivedAt: performance.now(),
  };
  S.gcheck = g;
  showAlignOverlay();
  if (face.ready) {
    startGuestAlign(g); // 모델이 이미 준비됨 → "준비 중…" 없이 바로 맞추기
    return;
  }
  renderAlign('loading', null);
  guestProgress(g, { phase: 'loading' });
  ensureFaceModel().then(
    () => {
      if (!g.done && S === g.sess) startGuestAlign(g);
    },
    () => {
      if (!g.done) guestFail(g, 'model_failed');
    },
  );
}

function onCheckCancel(msg) {
  const g = S.gcheck;
  if (!g || g.done || msg.runId !== g.runId) return;
  if (g.phase !== 'loading' && g.phase !== 'align') return; // 플래시 중에는 의미 없음
  stopGuestCheck(g);
}

function guestProgress(g, fields) {
  const now = performance.now();
  const phaseChanged = fields.phase !== g.lastPhaseSent;
  if (!phaseChanged && now - g.lastProgressAt < GUEST_PROGRESS_MIN_MS) return;
  g.lastProgressAt = now;
  g.lastPhaseSent = fields.phase;
  g.sess.mesh.send(g.hostPeerId, { type: 'check-progress', runId: g.runId, ...fields });
}

function startGuestAlign(g) {
  g.phase = 'align';
  g.alignStartedAt = performance.now();
  renderAlign('no_face', null);
  guestProgress(g, { phase: 'align', hint: 'no_face', size: null });
  g.alignTimer = setTimeout(() => guestFail(g, 'align_timeout'), g.align.timeoutMs);
  g.timers.push(g.alignTimer);
  startGuestSampling(g);
}

function startGuestSampling(g) {
  const video = alignVideo;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const hasRVFC = typeof video.requestVideoFrameCallback === 'function';
  let lastTime = -1;
  const step = (_now, meta) => {
    if (g.done) return;
    try {
      if (video.readyState >= 2 && video.videoWidth && (hasRVFC || video.currentTime !== lastTime)) {
        lastTime = video.currentTime;
        guestSampleFrame(g, video, canvas, ctx, meta);
      }
    } catch (e) {
      console.warn('프레임 처리 실패', e);
    }
    schedule();
  };
  const schedule = () => {
    if (g.done) return;
    if (hasRVFC) g.loop = { kind: 'rvfc', id: video.requestVideoFrameCallback(step) };
    else g.loop = { kind: 'raf', id: requestAnimationFrame(step) };
  };
  g.stopLoop = () => {
    if (!g.loop) return;
    if (g.loop.kind === 'rvfc') video.cancelVideoFrameCallback(g.loop.id);
    else cancelAnimationFrame(g.loop.id);
    g.loop = null;
  };
  schedule();
}

function guestSampleFrame(g, video, canvas, ctx, meta) {
  const cbNow = performance.now();
  const t = meta && typeof meta.captureTime === 'number' && meta.captureTime > 0 ? meta.captureTime : cbNow;
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  ctx.drawImage(video, 0, 0, W, H);
  const d0 = performance.now();
  const res = face.lm.detectForVideo(canvas, nextTs());
  g.detectMs.push(performance.now() - d0);
  const lm = res && res.faceLandmarks && res.faceLandmarks[0] ? res.faceLandmarks[0] : null;
  const a = faceAlignment(lm, W, H, g.align);
  let rgb = null;
  if (lm) {
    const img = ctx.getImageData(0, 0, W, H);
    rgb = faceMeanRgb({ data: img.data, width: W, height: H }, lm);
  }

  if (g.phase === 'align') {
    // 플래시 직전 ~1초를 series에 넣으려고 맞추기 단계 프레임도 최근 2초만 남긴다 (판정에는 쓰지 않음)
    if (lm) {
      g.preFrames.push({ t, face: rgb, size: a.size });
      while (g.preFrames.length && t - g.preFrames[0].t > 2000) g.preFrames.shift();
    }
    renderAlign(a.hint, a.size);
    if (a.aligned) {
      if (g.okSince == null) g.okSince = cbNow;
    } else {
      g.okSince = null;
    }
    guestProgress(g, { phase: 'align', hint: a.hint, size: a.size == null ? null : Math.round(a.size * 1000) / 1000 });
    if (g.okSince != null && cbNow - g.okSince >= g.align.holdMs) beginGuestFlash(g);
    return;
  }
  // flash / tail
  g.frames.push({ t, face: rgb, size: a.size });
}

function beginGuestFlash(g) {
  clearTimeout(g.alignTimer);
  g.phase = 'flash';
  g.flashBeganAt = performance.now();
  const { seq, stepMs } = g;
  let t0 = null;
  let cur = -1;
  const tick = (now) => {
    if (g.done || S !== g.sess) return;
    if (t0 == null) t0 = now;
    const idx = Math.floor((now - t0) / stepMs);
    if (idx >= seq.length) {
      flashEl.classList.remove('on');
      g.phase = 'tail';
      g.timers.push(setTimeout(() => finishGuestCheck(g), GUEST_TAIL_MS));
      return;
    }
    if (idx !== cur) {
      cur = idx;
      const [r, gg, b] = FLASH_RGB[seq[idx]];
      flashEl.style.background = `rgb(${r}, ${gg}, ${b})`;
      if (idx === 0) flashEl.classList.add('on');
      const i = idx;
      // 칠한 다음 rAF 시각 = 그 색이 화면에 나간 시각 → 구간 시작
      requestAnimationFrame((paintedAt) => {
        if (g.done || S !== g.sess) return;
        if (g.paintStarts[i] == null) g.paintStarts[i] = paintedAt;
        guestProgress(g, { phase: 'flash', i });
      });
    }
    g.raf = requestAnimationFrame(tick);
  };
  g.raf = requestAnimationFrame(tick);
}

function finishGuestCheck(g) {
  if (g.done) return;
  stopGuestCheck(g);
  const means = bucketFrames(g.frames, g.paintStarts, { stepMs: g.stepMs, discardMs: g.discardMs });
  const flashSizeMedian = median(g.frames.map((f) => f.size));
  const base = g.paintStarts[0] ?? g.flashBeganAt;
  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  const r4 = (v) => Math.round(v * 10000) / 10000;
  const pre = g.preFrames.filter((f) => f.t >= base - 1000);
  const series = [...pre, ...g.frames].map((f) => ({
    t: Math.round(f.t - base),
    c: f.face ? chroma(f.face).map(r4) : null,
    rgb: f.face ? f.face.map(r1) : null,
    size: f.size == null ? null : Math.round(f.size * 1000) / 1000,
  }));
  const result = {
    type: 'check-result',
    runId: g.runId,
    seq: g.seq,
    means: means.map((m) => (m ? m.map(r2) : null)),
    flashSizeMedian: flashSizeMedian == null ? null : Math.round(flashSizeMedian * 1000) / 1000,
    framesWithFace: g.frames.filter((f) => f.face).length,
    frames: g.frames.length,
    detectMsAvg: g.detectMs.length ? Math.round(g.detectMs.reduce((x, y) => x + y, 0) / g.detectMs.length) : null,
    delegate: face.delegate,
    stepStartsRel0: g.paintStarts.map((p) => (p == null || g.paintStarts[0] == null ? null : Math.round(p - g.paintStarts[0]))),
    series,
  };
  g.sess.mesh.send(g.hostPeerId, result);
  // 참여자 쪽 진단 (콘솔): 구간 시작 절대 시각 포함
  window.__lastGuestCheck = { ...result, paintStarts: g.paintStarts, flashBeganAt: g.flashBeganAt, receivedAt: g.receivedAt };
  console.info('[참여자 측정]', window.__lastGuestCheck);
}

// 참여자 측정 중단 (메시지 없음): 오버레이·플래시 정리
function stopGuestCheck(g) {
  if (g.done) return;
  g.done = true;
  for (const t of g.timers) clearTimeout(t);
  g.timers = [];
  cancelAnimationFrame(g.raf);
  if (g.stopLoop) g.stopLoop();
  flashEl.classList.remove('on');
  closeAlign();
}

function guestFail(g, reason) {
  if (g.done) return;
  stopGuestCheck(g);
  g.sess.mesh.send(g.hostPeerId, { type: 'check-error', runId: g.runId, reason });
  console.info('[참여자 측정 실패]', reason);
}

// ---------- 호스트: 선택 ----------
function selectPeer(peerId) {
  if (!S || S.role !== 'host') return;
  if (S.check && !S.check.done) return; // 판정 중에는 선택 고정
  S.selected = peerId;
  for (const pv of S.peers.values()) pv.tile.classList.toggle('sel', pv.peerId === peerId);
  renderHostUi();
}

function renderHostUi() {
  if (!S || S.role !== 'host') return;
  const running = Boolean(S.check && !S.check.done);
  const sel = S.selected ? S.peers.get(S.selected) : null;
  const open = sel ? S.mesh.isOpen(sel.peerId) : false;
  // 판정 중에는 "판정 취소" (플래시 단계에서는 누를 수 없음)
  judgeBtn.textContent = running ? 'Cancel check' : 'Deepfake check';
  judgeBtn.classList.toggle('cancel', running);
  judgeBtn.disabled = running ? S.check.phase === 'flash' : !sel || !open;
  const others = [...S.peers.values()].filter((p) => !p.self);
  let text;
  if (running && S.check.phase === 'align') text = `${S.check.pv.name} is lining up with the outline`;
  else if (running && S.check.phase === 'flash') text = 'Checking…';
  else if (running) text = `Preparing face detection on ${S.check.pv.name}'s device`;
  else if (others.length === 0) text = 'Waiting for participants · Share the invite link';
  else if (!sel) text = 'Click the participant you want to check';
  else if (!open) text = `${sel.name} selected · Connecting…`;
  else text = `${sel.name} selected · Press Deepfake check to show the alignment outline on ${sel.name}'s screen`;
  hint.textContent = text;
}

// ---------- 참여자: 얼굴 모델 (입장 시 미리 불러오고 워밍업) ----------
const face = { lm: null, ready: false, error: null, promise: null, lastTs: 0, delegate: null };

async function createWithFallback(Cls, vision, options) {
  try {
    const lm = await Cls.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'GPU' },
    });
    face.delegate = 'GPU';
    return lm;
  } catch (e) {
    console.warn('face: GPU delegate 실패, CPU로 재시도', e);
    const lm = await Cls.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' },
    });
    face.delegate = 'CPU';
    return lm;
  }
}

function ensureFaceModel() {
  if (!face.promise) {
    face.error = null;
    face.promise = (async () => {
      const { FilesetResolver, FaceLandmarker } = await import(VISION_URL);
      const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
      face.lm = await createWithFallback(FaceLandmarker, vision, {
        baseOptions: { modelAssetPath: FACE_MODEL },
        runningMode: 'VIDEO',
        numFaces: 1,
      });
      // 첫 추론은 셰이더 컴파일 등으로 오래 걸린다 → 측정 중 메인 스레드가 막혀 플래시 칠하기·프레임 샘플링이
      // 밀리지 않도록 입장 직후 미리 두 번 돌려 둔다
      const warm = document.createElement('canvas');
      warm.width = 640;
      warm.height = 480;
      const wctx = warm.getContext('2d');
      wctx.fillStyle = '#808080';
      wctx.fillRect(0, 0, 640, 480);
      const w0 = performance.now();
      face.lm.detectForVideo(warm, nextTs());
      const w1 = performance.now();
      face.lm.detectForVideo(warm, nextTs());
      face.ready = true;
      console.info(
        `얼굴 인식 모델 준비 완료 (${face.delegate}, 첫 추론 ${Math.round(w1 - w0)}ms, 두 번째 ${Math.round(performance.now() - w1)}ms)`,
      );
    })().catch((e) => {
      console.warn('얼굴 인식 모델 불러오기 실패', e);
      face.error = e;
      face.promise = null;
      throw e;
    });
  }
  return face.promise;
}

function nextTs() {
  const t = Math.max(face.lastTs + 1, Math.round(performance.now()));
  face.lastTs = t;
  return t;
}

// ---------- 호스트: 판정 ----------
// ---------- 호스트: 판정 ----------
function newRunId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const GUEST_ERROR_TEXT = {
  model_failed: "Face detection couldn't load on the participant's device",
  camera_off: "The participant's camera is off",
  busy: 'The participant is already in another check',
};

function onJudge() {
  if (!S || S.role !== 'host') return;
  if (S.check && !S.check.done) {
    if (S.check.phase !== 'flash') cancelCheck();
    return;
  }
  if (!S.selected) return;
  const pv = S.peers.get(S.selected);
  if (!pv || !S.mesh.isOpen(pv.peerId)) return;
  const { stepMs, discardMs } = CALL_FLASH;
  const seq = makeFlashSequence();
  const check = {
    sess: S,
    runId: newRunId(),
    peerId: pv.peerId,
    pv,
    phase: 'starting',
    seq,
    stepMs,
    discardMs,
    minDelta,
    sentAt: performance.now(),
    progressLog: [],
    done: false,
    timers: [],
  };
  const sent = S.mesh.send(pv.peerId, { type: 'check-start', runId: check.runId, seq, stepMs, discardMs, align: ALIGN });
  S.check = check;
  renderLoading(check);
  renderHostUi();
  if (!sent) {
    failCheck('The connection is not ready yet');
    return;
  }
  check.timers.push(setTimeout(() => failCheck('No response in time'), ALIGN.timeoutMs + seq.length * stepMs + 10000));
}

function currentCheckFor(peerId, msg) {
  const check = S && S.check;
  if (!check || check.done || check.peerId !== peerId || !msg || msg.runId !== check.runId) return null;
  return check;
}

function onCheckProgress(peerId, msg) {
  const check = currentCheckFor(peerId, msg);
  if (!check) return;
  const prevPhase = check.phase;
  check.progressLog.push({ t: Math.round(performance.now() - check.sentAt), phase: msg.phase, hint: msg.hint, size: msg.size, i: msg.i });
  if (msg.phase === 'loading') {
    check.phase = 'loading';
    renderLoading(check);
  } else if (msg.phase === 'align') {
    check.phase = 'align';
    renderAligning(check, { size: typeof msg.size === 'number' ? msg.size : null });
  } else if (msg.phase === 'flash') {
    check.phase = 'flash';
    const i = Number.isInteger(msg.i) && msg.i >= 0 && msg.i < check.seq.length ? msg.i : -1;
    renderRunning(check, i);
  }
  if (check.phase !== prevPhase) renderHostUi();
}

function validMeans(means, n) {
  return (
    Array.isArray(means) &&
    means.length === n &&
    means.every((m) => m === null || (Array.isArray(m) && m.length === 3 && m.every((v) => typeof v === 'number' && Number.isFinite(v))))
  );
}

function onCheckResult(peerId, msg) {
  const check = currentCheckFor(peerId, msg);
  if (!check) return;
  const sameSeq = Array.isArray(msg.seq) && msg.seq.length === check.seq.length && msg.seq.every((c, i) => c === check.seq[i]);
  if (!sameSeq || !validMeans(msg.means, check.seq.length)) {
    failCheck("Measurements don't match the request", ERROR_LABEL, msg);
    return;
  }
  stopCheck(check);
  const steps = buildFaceSteps(check.seq, msg.means);
  const judge = judgeColorSteps(steps, { ...DEFAULTS, minDelta: check.minDelta });
  let result = classifyResult(steps, judge);
  const fsm = typeof msg.flashSizeMedian === 'number' && Number.isFinite(msg.flashSizeMedian) ? msg.flashSizeMedian : null;
  if (fsm != null && fsm < ALIGN.sizeMin) result = { ...result, status: 'unmeasured', label: FAR_LABEL, far: true };
  const debug = {
    runId: check.runId,
    peer: check.pv.name,
    seq: check.seq,
    result,
    judge,
    steps,
    minDelta: check.minDelta,
    hostElapsedMs: Math.round(performance.now() - check.sentAt),
    progressLog: check.progressLog,
    guest: {
      means: msg.means,
      flashSizeMedian: fsm,
      framesWithFace: msg.framesWithFace ?? null,
      frames: msg.frames ?? null,
      detectMsAvg: msg.detectMsAvg ?? null,
      delegate: msg.delegate ?? null,
      stepStartsRel0: msg.stepStartsRel0 ?? null,
    },
    series: Array.isArray(msg.series) ? msg.series : null,
  };
  console.info('[판정]', debug);
  window.__lastCheck = debug;
  renderResult(check, result, judge, null, fsm);
  renderHostUi();
}

function onCheckError(peerId, msg) {
  const check = currentCheckFor(peerId, msg);
  if (!check) return;
  if (msg.reason === 'align_timeout') {
    failCheck(`Couldn't align within ${ALIGN.timeoutMs / 1000} s`, ALIGN_FAIL_LABEL, msg);
  } else {
    failCheck(GUEST_ERROR_TEXT[msg.reason] || 'Measurement error on the participant side', ERROR_LABEL, msg);
  }
}

function stopCheck(check) {
  check.done = true;
  for (const t of check.timers) clearTimeout(t);
  check.timers = [];
}

function failCheck(reason, label = ERROR_LABEL, guestMsg = null) {
  const check = S && S.check;
  if (!check || check.done) return;
  // 참여자 쪽이 아직 맞추기 중일 수 있으면 닫으라고 알린다 (참여자는 맞추기 중에만 반응)
  if (!guestMsg) check.sess.mesh.send(check.peerId, { type: 'check-cancel', runId: check.runId });
  stopCheck(check);
  const debug = {
    runId: check.runId,
    peer: check.pv.name,
    seq: check.seq,
    phase: check.phase,
    reason,
    guestError: guestMsg && guestMsg.type === 'check-error' ? guestMsg.reason : null,
    hostElapsedMs: Math.round(performance.now() - check.sentAt),
    progressLog: check.progressLog,
  };
  console.info('[판정 실패]', reason, debug);
  window.__lastCheck = debug;
  renderResult(check, { status: 'error', label, deltas: null }, null, reason);
  renderHostUi();
}

// 호스트가 "판정 취소": 결과 없이 원래대로
function cancelCheck() {
  const check = S && S.check;
  if (!check || check.done || check.phase === 'flash') return;
  check.sess.mesh.send(check.peerId, { type: 'check-cancel', runId: check.runId });
  stopCheck(check);
  console.info('[판정 취소]', { runId: check.runId, phase: check.phase });
  check.pv.badge.className = 'badge';
  check.pv.badge.textContent = '';
  check.pv.detail.classList.remove('on');
  check.pv.detail.textContent = '';
  renderHostUi();
}

// ---------- 호스트: 판정 표시 ----------
function renderLoading(check) {
  const { badge, detail } = check.pv;
  detail.classList.remove('on');
  detail.textContent = '';
  badge.className = 'badge align';
  badge.textContent = 'Preparing participant';
}

function renderAligning(check, a) {
  const { badge, detail } = check.pv;
  detail.classList.remove('on');
  detail.textContent = '';
  badge.className = 'badge align';
  const pct = a && a.size != null ? `${Math.round(a.size * 100)}%` : 'No face';
  badge.textContent = `Aligning face · ${pct}`;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `Flash starts after ${Math.round(ALIGN.sizeMin * 100)}%+ for ${ALIGN.holdMs / 1000} s · ${ALIGN.timeoutMs / 1000} s limit`;
  badge.append(sub);
}

function renderRunning(check, i) {
  const { badge, detail } = check.pv;
  detail.classList.remove('on');
  detail.textContent = '';
  badge.className = 'badge run';
  badge.textContent = i < 0 ? 'Checking · Starting' : `Checking ${i + 1}/${check.seq.length} · ${COLOR_LABEL[check.seq[i]]}`;
  const steps = document.createElement('div');
  steps.className = 'steps';
  check.seq.forEach((c, k) => {
    const cell = document.createElement('i');
    // v1.1: 각 칸을 해당 색으로. 아직 안 지난 칸은 흐리게, 현재 칸은 흰 테두리
    cell.style.background = STEP_SWATCH[c];
    if (k > i) cell.style.opacity = '0.35';
    if (k === i) cell.style.outline = '2px solid #fff';
    steps.append(cell);
  });
  badge.append(steps);
}

function fmtDelta(v) {
  return v == null ? '—' : v.toFixed(3);
}

function renderResult(check, result, judge, reason, flashSizeMedian) {
  const { badge, detail } = check.pv;
  const cls = result.status === 'human' ? 'ok' : result.status === 'suspect' ? 'bad' : 'na';
  badge.className = `badge ${cls}`;
  badge.textContent = result.label;
  detail.textContent = '';
  if (result.status === 'error') {
    detail.textContent = reason || '';
    detail.classList.toggle('on', Boolean(reason));
    return;
  }
  const d = result.deltas || {};
  const line1 = `Face reflection Δ · Red ${fmtDelta(d.red)} · Green ${fmtDelta(d.green)} · Blue ${fmtDelta(d.blue)}`;
  let line2;
  const th = check.minDelta;
  if (result.far)
    line2 = `Face size during flash ${Math.round(flashSizeMedian * 100)}% (min ${Math.round(ALIGN.sizeMin * 100)}%) · Please move closer`;
  else if (result.status === 'unmeasured') line2 = 'Keep your face clearly visible and try again';
  else if (judge && judge.matched === judge.total) line2 = `All ${judge.total} colors at or above threshold (${th})`;
  else if (judge) line2 = `Only ${judge.matched} of ${judge.total} colors at or above threshold (${th})`;
  detail.append(line1, document.createElement('br'), line2 || '');
  detail.classList.add('on');
}

// ---------- 진단: WebRTC 통계 (동작 변경 없음, 콘솔에서 호출) ----------
// window.__callStats()          → 상대별 1행 표 (console.table + 반환)
// window.__callStatsWatch(10)   → 1초마다 상대별 한 줄 요약, N초 동안
const statsPrev = new Map(); // `${peerId}:${reportId}:${field}` → { v, ts }

function kbpsDelta(peerId, r, field) {
  if (!r || typeof r[field] !== 'number') return null;
  const key = `${peerId}:${r.id}:${field}`;
  const prev = statsPrev.get(key);
  statsPrev.set(key, { v: r[field], ts: r.timestamp });
  if (!prev || !(r.timestamp > prev.ts)) return null;
  return Math.round(((r[field] - prev.v) * 8) / (r.timestamp - prev.ts)); // bytes/ms*8 = kbps
}
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const res = (r) => (r && r.frameWidth ? `${r.frameWidth}x${r.frameHeight}` : null);

async function collectPeerStats(peerId, pc) {
  const rep = await pc.getStats();
  const byId = new Map();
  rep.forEach((r) => byId.set(r.id, r));
  let inV = null, outV = null, pair = null;
  rep.forEach((r) => {
    const kind = r.kind || r.mediaType;
    if (r.type === 'inbound-rtp' && kind === 'video') inV = r;
    if (r.type === 'outbound-rtp' && kind === 'video' && (!outV || (r.bytesSent || 0) > (outV.bytesSent || 0))) outV = r;
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId) || pair;
  });
  if (!pair) rep.forEach((r) => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
  const remoteInV = outV && outV.remoteId ? byId.get(outV.remoteId) : null;
  const lc = pair ? byId.get(pair.localCandidateId) : null;
  const rc = pair ? byId.get(pair.remoteCandidateId) : null;
  const inCodec = inV && inV.codecId ? byId.get(inV.codecId) : null;
  const outCodec = outV && outV.codecId ? byId.get(outV.codecId) : null;
  const qld = outV && outV.qualityLimitationDurations;
  const pv = S && S.peers.get(peerId);
  return {
    peer: pv ? pv.name : peerId,
    conn: pc.connectionState,
    // 받는 영상 (상대 → 나)
    in_fps: num(inV && inV.framesPerSecond),
    in_res: res(inV),
    in_kbps: kbpsDelta(peerId, inV, 'bytesReceived'),
    in_lost: inV ? inV.packetsLost ?? null : null,
    in_recv: inV ? inV.packetsReceived ?? null : null,
    in_jitter_ms: num(inV && inV.jitter * 1000, 1),
    in_jbuf_ms: inV && inV.jitterBufferEmittedCount ? num((inV.jitterBufferDelay / inV.jitterBufferEmittedCount) * 1000, 0) : null,
    in_freezes: inV ? inV.freezeCount ?? null : null,
    in_freeze_s: num(inV && inV.totalFreezesDuration, 2),
    in_dropped: inV ? inV.framesDropped ?? null : null,
    in_decoded: inV ? inV.framesDecoded ?? null : null,
    in_nack: inV ? inV.nackCount ?? null : null,
    in_pli: inV ? inV.pliCount ?? null : null,
    in_decoder: (inV && inV.decoderImplementation) || null,
    in_codec: inCodec ? inCodec.mimeType : null,
    // 보내는 영상 (나 → 상대)
    out_fps: num(outV && outV.framesPerSecond),
    out_res: res(outV),
    out_limit: (outV && outV.qualityLimitationReason) || null,
    out_limit_s: qld ? `cpu ${num(qld.cpu, 1)} bw ${num(qld.bandwidth, 1)}` : null,
    out_encoder: (outV && outV.encoderImplementation) || null,
    out_codec: outCodec ? outCodec.mimeType : null,
    out_target_kbps: outV && typeof outV.targetBitrate === 'number' ? Math.round(outV.targetBitrate / 1000) : null,
    out_kbps: kbpsDelta(peerId, outV, 'bytesSent'),
    out_remote_lost: remoteInV ? remoteInV.packetsLost ?? null : null,
    // 연결
    rtt_ms: num(pair && pair.currentRoundTripTime * 1000, 1),
    avail_out_kbps: pair && typeof pair.availableOutgoingBitrate === 'number' ? Math.round(pair.availableOutgoingBitrate / 1000) : null,
    local_cand: lc ? `${lc.candidateType}/${lc.protocol}${lc.networkType ? '/' + lc.networkType : ''}` : null,
    remote_cand: rc ? `${rc.candidateType}/${rc.protocol}` : null,
  };
}

async function callStats({ quiet = false } = {}) {
  if (!S || !S.mesh) {
    console.warn('통화 중이 아닙니다');
    return [];
  }
  const rows = await Promise.all(
    [...S.mesh.peers.entries()].map(([peerId, p]) =>
      collectPeerStats(peerId, p.pc).catch((e) => ({ peer: peerId, error: String(e) })),
    ),
  );
  if (!quiet) console.table(rows);
  return rows;
}

function statsLine(r) {
  if (r.error) return `[stats] ${r.peer} error ${r.error}`;
  return (
    `[stats] ${r.peer} | in ${r.in_fps ?? '-'}fps ${r.in_res ?? '-'} ${r.in_kbps ?? '-'}kbps lost ${r.in_lost ?? '-'} ` +
    `jit ${r.in_jitter_ms ?? '-'}ms frz ${r.in_freezes ?? '-'}/${r.in_freeze_s ?? '-'}s drop ${r.in_dropped ?? '-'} ` +
    `| out ${r.out_fps ?? '-'}fps ${r.out_res ?? '-'} ${r.out_kbps ?? '-'}/${r.out_target_kbps ?? '-'}kbps limit=${r.out_limit ?? '-'} ` +
    `| rtt ${r.rtt_ms ?? '-'}ms avail ${r.avail_out_kbps ?? '-'}kbps ${r.local_cand ?? '-'}→${r.remote_cand ?? '-'}`
  );
}

function callStatsWatch(sec = 10) {
  return new Promise((resolve) => {
    let n = 0;
    let last = [];
    callStats({ quiet: true }).then(() => {}); // 첫 호출은 bitrate 기준점
    const id = setInterval(async () => {
      n++;
      last = await callStats({ quiet: true });
      for (const r of last) console.log(statsLine(r));
      if (n >= sec) {
        clearInterval(id);
        resolve(last);
      }
    }, 1000);
  });
}

// 진단: 마지막 판정 기록을 클립보드로 (JSON 한 줄). 바이트 수를 돌려준다.
window.__copyLastCheck = async () => {
  const json = JSON.stringify(window.__lastCheck ?? null);
  const bytes = new Blob([json]).size;
  try {
    await navigator.clipboard.writeText(json);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = json;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    if (!ok) console.warn('클립보드 복사 실패 — window.__lastCheck를 직접 확인하세요', e);
  }
  return bytes;
};
window.__callStats = () => callStats();
window.__callStatsWatch = (sec = 10) => callStatsWatch(sec);

// ---------- 이벤트 연결 ----------
lobbyMic.addEventListener('click', toggleMic);
lobbyCam.addEventListener('click', toggleCam);
micBtn.addEventListener('click', toggleMic);
camBtn.addEventListener('click', toggleCam);
createBtn.addEventListener('click', onCreate);
joinBtn.addEventListener('click', onJoin);
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') onJoin();
});
enterBtn.addEventListener('click', onJoin);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && inviteMode && !enterBtn.disabled) onJoin();
});
judgeBtn.addEventListener('click', onJudge);
leaveBtn.addEventListener('click', () => exitCall(''));
copyBtn.addEventListener('click', async (e) => {
  e.preventDefault();
  if (!S) return;
  const text = S.inviteUrl;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
  }
  copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
});
window.addEventListener('pagehide', () => {
  if (S) sendLeaveBeacon(S.room, S.peerId);
});

// ---------- 시작 ----------
(function init() {
  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || '').trim().toLowerCase();
  if (room) {
    inviteMode = true;
    codeInput.value = room;
    inviteRoomEl.textContent = room;
    for (const el of document.querySelectorAll('[data-full]')) el.hidden = true;
    for (const el of document.querySelectorAll('[data-invite]')) el.hidden = false;
    newRoomLink.href = location.pathname; // 쿼리 없는 전체 로비
  }
  try {
    nameInput.value = localStorage.getItem('hc-call-name') || '';
  } catch {}
  setLobbyBusy(true);
  loadCalibration();
  startCamera().finally(() => setLobbyBusy(false));
})();
