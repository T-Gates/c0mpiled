// Human Check 통화 — 화면·흐름 (브라우저 전용)
import { DEFAULTS, judgeColorSteps } from '../judge.js';
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
const COLOR_KO = { white: '흰색', red: '빨강', green: '초록', blue: '파랑' };
const STEP_SWATCH = { white: '#fff', red: '#e33', green: '#2c3', blue: '#37f' };
const ERROR_LABEL = '판정 실패 · 다시 시도해 주세요';
const VALID_COLORS = new Set(Object.keys(FLASH_RGB));
const ALIGN_FAIL_LABEL = '얼굴을 맞추지 못해 판정 실패';
const FAR_LABEL = '? 얼굴이 멀어져 판정 불가';
const ALIGN_HINT_KO = {
  no_face: '얼굴이 보이지 않아요',
  closer: '조금 더 가까이 와 주세요',
  farther: '조금만 뒤로 가 주세요',
  center: '얼굴을 가운데로 맞춰 주세요',
  ok: '좋아요, 그대로 계세요',
};
const ALIGN_STATUS_MIN_MS = 100; // align-status 최대 초당 10회
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
// S = { room, peerId, role, hostId, name, es, mesh, peers: Map<peerId, PeerView>, selected, check, flashing, inviteUrl }
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
    setLobbyError('https:// 주소로 들어와 주세요');
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
        ? '카메라·마이크 권한이 거부되었습니다. 브라우저 설정에서 허용한 뒤 새로고침해 주세요'
        : '카메라·마이크를 열 수 없습니다. 다른 앱이 사용 중인지 확인한 뒤 새로고침해 주세요',
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
    setLobbyError('이름을 입력해 주세요');
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
      setLobbyError(r.status === 400 ? '이름을 입력해 주세요' : '방을 만들지 못했습니다. 잠시 후 다시 시도해 주세요');
      return;
    }
    enterCall(r.data, name);
  } catch (e) {
    console.warn(e);
    setLobbyError('서버에 연결할 수 없습니다. 주소를 확인해 주세요');
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
      setLobbyError('초대 주소의 방 코드가 올바르지 않습니다. 초대 주소를 다시 확인해 주세요', { newRoom: true });
      return;
    }
    setLobbyError('방 코드 4글자를 입력해 주세요');
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
          inviteMode ? '방을 찾을 수 없습니다. 이미 끝난 방일 수 있습니다' : '방을 찾을 수 없습니다. 방 코드를 확인해 주세요',
          { newRoom: true },
        );
      else if (r.status === 409) setLobbyError('방이 가득 찼습니다 (최대 3명)', { newRoom: true });
      else if (r.status === 400) setLobbyError('이름을 입력해 주세요');
      else setLobbyError('참여하지 못했습니다. 잠시 후 다시 시도해 주세요', { newRoom: true });
      return;
    }
    enterCall(r.data, name);
  } catch (e) {
    console.warn(e);
    setLobbyError('서버에 연결할 수 없습니다. 주소를 확인해 주세요');
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
    flashing: null,
    aligning: null,
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
        if (S.check && S.check.peerId === peerId && !S.check.done) failCheck('연결이 끊겼습니다');
        if (S.role === 'guest' && peerId === S.hostId) closeAlign();
      }
      renderHostUi();
    },
  });

  // SSE를 먼저 열고(서버가 연결 전 이벤트를 쌓아 둠) 기존 인원에게 offer를 보낸다
  openEvents(S);
  for (const p of info.peers || []) {
    S.mesh.connectTo(p.peerId).catch((e) => console.warn('offer 실패', p.peerId, e));
  }

  if (isHost) {
    ensureFaceModel().then(renderHostUi, renderHostUi);
  }
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
      exitCall('서버와 연결이 끊겼습니다. 다시 참여해 주세요', { notifyServer: false });
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
    exitCall('호스트가 방을 닫았습니다', { notifyServer: false });
  }
}

function removePeer(peerId) {
  if (!S || peerId === S.peerId) return;
  if (S.check && S.check.peerId === peerId && !S.check.done) failCheck('참여자가 나갔습니다');
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
  if (sess.flashing) sess.flashing.cancel();
  if (sess.aligning) clearTimeout(sess.aligning.timer);
  alignEl.classList.remove('on', 'ok');
  alignVideo.srcObject = null;
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
  camoff.textContent = '카메라 꺼짐';
  const badge = document.createElement('div');
  badge.className = 'badge';
  const detail = document.createElement('div');
  detail.className = 'detail';
  const selmark = document.createElement('div');
  selmark.className = 'selmark';
  selmark.textContent = '선택됨';
  const nameEl = document.createElement('div');
  nameEl.className = 'name';
  tile.append(video, camoff, badge, detail, selmark, nameEl);
  grid.append(tile);

  const pv = { peerId, name: name || '참여자', role, self, tile, video, nameEl, badge, detail, mic: true, cam: true };
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
  if (pv.self) label += S && S.role === 'host' ? ' (나 · 호스트)' : ' (나)';
  else if (pv.role === 'host') label += ' (호스트)';
  pv.nameEl.textContent = pv.mic ? label : `${label} 🔇`;
  pv.tile.classList.toggle('camoff', !pv.cam);
}

function renderCount() {
  if (!S) return;
  const n = S.peers.size;
  whoInfo.textContent = `${S.role === 'host' ? '호스트' : '참여자'} · ${n}명`;
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
    case 'flash-start':
      if (S.role === 'guest' && peerId === S.hostId) {
        closeAlign(); // 맞추기 오버레이를 닫고 바로 플래시
        startFlash(peerId, msg);
      }
      break;
    case 'align-start':
      if (S.role === 'guest' && peerId === S.hostId) openAlign(msg);
      break;
    case 'align-status':
      if (S.role === 'guest' && peerId === S.hostId && S.aligning && msg.runId === S.aligning.runId) {
        renderAlign(msg.hint, msg.size);
      }
      break;
    case 'align-cancel':
      if (S.role === 'guest' && peerId === S.hostId && S.aligning && msg.runId === S.aligning.runId) closeAlign();
      break;
    case 'flash-step':
      onFlashStep(peerId, msg);
      break;
    case 'flash-end':
      onFlashEnd(peerId, msg);
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
    ? `얼굴 크기 ${pct}% · 곧 화면 색이 바뀝니다`
    : `얼굴 크기 ${pct}% · ${Math.round(ALIGN.sizeMin * 100)}% 이상이면 시작`;
}

function openAlign(msg) {
  if (!S || S.flashing || typeof msg.runId !== 'string') return;
  closeAlign();
  const sess = S;
  const handle = { runId: msg.runId, timer: null };
  // 호스트가 사라져 align-cancel이 오지 않는 경우를 위한 안전장치
  handle.timer = setTimeout(() => {
    if (sess.aligning === handle) closeAlign();
  }, ALIGN.timeoutMs + 5000);
  sess.aligning = handle;
  alignVideo.srcObject = localStream;
  alignVideo.play().catch(() => {});
  alignMeterMark.style.left = `${(ALIGN.sizeMin / METER_MAX) * 100}%`;
  renderAlign('no_face', null);
  alignEl.classList.add('on');
  layoutAlign();
}

function closeAlign() {
  if (S && S.aligning) {
    clearTimeout(S.aligning.timer);
    S.aligning = null;
  }
  alignEl.classList.remove('on', 'ok');
  alignVideo.srcObject = null;
}

alignVideo.addEventListener('resize', layoutAlign);
alignVideo.addEventListener('loadedmetadata', layoutAlign);
window.addEventListener('resize', layoutAlign);

// ---------- 참여자: 플래시 ----------
function startFlash(hostPeerId, msg) {
  if (S.flashing) return; // 이미 플래시 중이면 무시
  const seq = msg.seq;
  const stepMs = Number(msg.stepMs);
  if (!Array.isArray(seq) || seq.length === 0 || seq.length > 12 || !seq.every((c) => VALID_COLORS.has(c))) return;
  if (!(stepMs >= 100 && stepMs <= 3000)) return;
  const runId = msg.runId;
  const sess = S;
  let raf = 0;
  let cancelled = false;
  const paint = (c) => {
    const [r, g, b] = FLASH_RGB[c];
    flashEl.style.background = `rgb(${r}, ${g}, ${b})`;
  };
  const finish = () => {
    flashEl.classList.remove('on');
    if (sess.flashing === handle) sess.flashing = null;
  };
  const handle = {
    cancel() {
      cancelled = true;
      cancelAnimationFrame(raf);
      finish();
    },
  };
  sess.flashing = handle;

  let t0 = null;
  let cur = -1;
  const tick = (now) => {
    if (cancelled || S !== sess) return;
    if (t0 == null) t0 = now;
    const idx = Math.floor((now - t0) / stepMs);
    if (idx >= seq.length) {
      finish();
      sess.mesh.send(hostPeerId, { type: 'flash-end', runId });
      return;
    }
    if (idx !== cur) {
      cur = idx;
      paint(seq[idx]);
      if (idx === 0) flashEl.classList.add('on');
      const i = idx;
      // 칠한 프레임이 화면에 나간 뒤(다음 프레임)에 알린다
      requestAnimationFrame(() => {
        if (cancelled || S !== sess) return;
        sess.mesh.send(hostPeerId, { type: 'flash-step', runId, i, color: seq[i] });
      });
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
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
  // v1.1: 판정 중에는 "판정 취소" (맞추기 단계에서만 누를 수 있음)
  judgeBtn.textContent = running ? '판정 취소' : '딥페이크 판정';
  judgeBtn.classList.toggle('cancel', running);
  judgeBtn.disabled = running ? S.check.phase !== 'align' : !sel || !face.ready || !open;
  const others = [...S.peers.values()].filter((p) => !p.self);
  let text;
  if (running && S.check.phase === 'align') text = `${S.check.pv.name}${subjectJosa(S.check.pv.name)} 얼굴을 맞추는 중입니다`;
  else if (running) text = '판정 중…';
  else if (face.error) text = '얼굴 인식 모델을 불러오지 못했습니다 · 인터넷 연결을 확인하고 새로고침해 주세요';
  else if (others.length === 0) text = '참여자를 기다리는 중입니다 · 초대 주소를 공유하세요';
  else if (!sel) text = '판정할 참여자 화면을 클릭하세요';
  else if (!face.ready) text = `${sel.name} 선택됨 · 얼굴 인식 모델 불러오는 중…`;
  else if (!open) text = `${sel.name} 선택됨 · 연결 중…`;
  else text = `${sel.name} 선택됨 · 판정을 누르면 ${sel.name} 화면에 얼굴 맞추기 윤곽선이 뜹니다`;
  hint.textContent = text;
}

// ---------- 호스트: 얼굴 모델 ----------
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
      // 첫 추론은 셰이더 컴파일 등으로 오래 걸린다 → 판정 중 메인 스레드가 막혀 flash-step 수신 시각이
      // 밀리지 않도록 버튼을 켜기 전에 한 번 미리 돌려 둔다
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
function newRunId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 이름 끝 글자 받침 유무로 주격 조사 (민지가 / 준형이)
function subjectJosa(name) {
  const c = String(name || '').trim().slice(-1).charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? '이' : '가';
  return '가';
}

function onJudge() {
  if (!S || S.role !== 'host') return;
  if (S.check && !S.check.done) {
    if (S.check.phase === 'align') cancelCheck();
    return;
  }
  if (!S.selected || !face.ready) return;
  const pv = S.peers.get(S.selected);
  if (!pv) return;
  const { stepMs, discardMs } = CALL_FLASH;
  const check = {
    sess: S,
    runId: newRunId(),
    peerId: pv.peerId,
    pv,
    phase: 'align',
    seq: null,
    stepMs,
    discardMs,
    minDelta,
    frames: [],
    detectMs: [],
    stepStarts: null,
    alignStartedAt: performance.now(),
    alignedAt: null,
    okSince: null,
    lastStatusAt: -Infinity,
    alignLog: [],
    startedAt: null,
    done: false,
    timers: [],
    loop: null,
    canvas: null,
    ctx: null,
  };
  const sent = S.mesh.send(pv.peerId, { type: 'align-start', runId: check.runId });
  S.check = check;
  renderAligning(check, null);
  renderHostUi();
  if (!sent) {
    failCheck('연결이 아직 준비되지 않았습니다');
    return;
  }
  check.alignTimeout = setTimeout(
    () => failCheck(`${ALIGN.timeoutMs / 1000}초 안에 얼굴을 맞추지 못했습니다`, ALIGN_FAIL_LABEL),
    ALIGN.timeoutMs,
  );
  check.timers.push(check.alignTimeout);
  startSampling(check);
}

// 맞추기 단계 → 플래시 단계
function beginFlash(check) {
  if (check.done || check.phase !== 'align') return;
  clearTimeout(check.alignTimeout);
  check.phase = 'flash';
  check.alignedAt = performance.now();
  check.seq = makeFlashSequence();
  check.stepStarts = new Array(check.seq.length).fill(null);
  check.startedAt = performance.now();
  const sent = check.sess.mesh.send(check.peerId, {
    type: 'flash-start',
    runId: check.runId,
    seq: check.seq,
    stepMs: check.stepMs,
  });
  renderRunning(check, -1);
  renderHostUi();
  if (!sent) {
    failCheck('연결이 끊겼습니다');
    return;
  }
  check.timeout = setTimeout(() => failCheck('응답 시간 초과'), check.seq.length * check.stepMs + 3000);
  check.timers.push(check.timeout);
}

function startSampling(check) {
  const video = check.pv.video;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  check.canvas = canvas;
  check.ctx = ctx;
  const hasRVFC = typeof video.requestVideoFrameCallback === 'function';
  let lastTime = -1;

  const step = () => {
    if (check.done) return;
    try {
      sampleFrame(check, video, canvas, ctx, hasRVFC, lastTime);
      lastTime = video.currentTime;
    } catch (e) {
      console.warn('프레임 처리 실패', e);
    }
    schedule();
  };
  const schedule = () => {
    if (check.done) return;
    if (hasRVFC) check.loop = { kind: 'rvfc', id: video.requestVideoFrameCallback(step) };
    else check.loop = { kind: 'raf', id: requestAnimationFrame(step) };
  };
  check.stopLoop = () => {
    if (!check.loop) return;
    if (check.loop.kind === 'rvfc') video.cancelVideoFrameCallback(check.loop.id);
    else cancelAnimationFrame(check.loop.id);
    check.loop = null;
  };
  schedule();
}

function sampleFrame(check, video, canvas, ctx, hasRVFC, lastTime) {
  if (video.readyState < 2 || !video.videoWidth) return;
  if (!hasRVFC && video.currentTime === lastTime) return;
  const t = performance.now();
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  ctx.drawImage(video, 0, 0, W, H);
  const d0 = performance.now();
  const res = face.lm.detectForVideo(canvas, nextTs());
  check.detectMs.push(performance.now() - d0);
  const lm = res && res.faceLandmarks && res.faceLandmarks[0] ? res.faceLandmarks[0] : null;
  const a = faceAlignment(lm, W, H, ALIGN);

  if (check.phase === 'align') {
    check.alignLog.push({ t: Math.round(t - check.alignStartedAt), size: a.size, hint: a.hint });
    if (a.aligned) {
      if (check.okSince == null) check.okSince = t;
    } else {
      check.okSince = null;
    }
    const holdDone = check.okSince != null && t - check.okSince >= ALIGN.holdMs;
    if (t - check.lastStatusAt >= ALIGN_STATUS_MIN_MS) {
      check.lastStatusAt = t;
      check.sess.mesh.send(check.peerId, {
        type: 'align-status',
        runId: check.runId,
        hint: a.hint,
        size: a.size == null ? null : Math.round(a.size * 1000) / 1000,
      });
      renderAligning(check, a);
    }
    if (holdDone) beginFlash(check);
    return;
  }

  let rgb = null;
  if (lm) {
    const img = ctx.getImageData(0, 0, W, H);
    rgb = faceMeanRgb({ data: img.data, width: W, height: H }, lm);
  }
  check.frames.push({ t, face: rgb, size: a.size });
}

function onFlashStep(peerId, msg) {
  const check = S && S.check;
  if (!check || check.done || check.phase !== 'flash' || check.peerId !== peerId || msg.runId !== check.runId) return;
  const i = msg.i;
  if (!Number.isInteger(i) || i < 0 || i >= check.seq.length || msg.color !== check.seq[i]) return;
  if (check.stepStarts[i] == null) check.stepStarts[i] = performance.now();
  renderRunning(check, i);
}

function onFlashEnd(peerId, msg) {
  const check = S && S.check;
  if (!check || check.done || check.phase !== 'flash' || check.peerId !== peerId || msg.runId !== check.runId || check.ending) return;
  check.ending = true;
  clearTimeout(check.timeout);
  // 마지막 구간도 다 채우도록 stepMs 동안 프레임을 더 모은 뒤 계산
  check.timers.push(setTimeout(() => finishCheck(check), check.stepMs));
}

function stopCheck(check) {
  check.done = true;
  for (const t of check.timers) clearTimeout(t);
  check.timers = [];
  if (check.stopLoop) check.stopLoop();
}

function summarizeAlign(check) {
  const sizes = check.alignLog.map((x) => x.size).filter((v) => v != null);
  const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  // 시계열은 약 250ms 간격으로 줄여 기록
  const series = [];
  let lastT = -Infinity;
  for (const x of check.alignLog) {
    if (x.t - lastT >= 250) {
      series.push([x.t, r2(x.size), x.hint]);
      lastT = x.t;
    }
  }
  return {
    startedAt: 0,
    alignedAt: check.alignedAt == null ? null : Math.round(check.alignedAt - check.alignStartedAt),
    frames: check.alignLog.length,
    framesWithFace: sizes.length,
    sizeMin: r2(sizes.length ? Math.min(...sizes) : null),
    sizeMedian: r2(median(sizes)),
    sizeMax: r2(sizes.length ? Math.max(...sizes) : null),
    lastHint: check.alignLog.length ? check.alignLog[check.alignLog.length - 1].hint : null,
    series,
  };
}

function finishCheck(check) {
  if (check.done) return;
  stopCheck(check);
  const means = bucketFrames(check.frames, check.stepStarts, { stepMs: check.stepMs, discardMs: check.discardMs });
  const steps = buildFaceSteps(check.seq, means);
  const judge = judgeColorSteps(steps, { ...DEFAULTS, minDelta: check.minDelta });
  let result = classifyResult(steps, judge);
  // v1.1: 플래시 중 얼굴 크기 중앙값이 기준 미만이면 측정 불가
  const flashSizeMedian = median(check.frames.map((f) => f.size));
  if (flashSizeMedian != null && flashSizeMedian < ALIGN.sizeMin) {
    result = { ...result, status: 'unmeasured', label: FAR_LABEL, far: true };
  }
  const withFace = check.frames.filter((f) => f.face).length;
  const debug = {
    runId: check.runId,
    peer: check.pv.name,
    seq: check.seq,
    stepStarts: check.stepStarts.map((s) => (s == null ? null : Math.round(s - check.startedAt))),
    frames: check.frames.length,
    detectMsAvg: check.detectMs.length ? Math.round(check.detectMs.reduce((a, b) => a + b, 0) / check.detectMs.length) : null,
    delegate: face.delegate,
    framesWithFace: withFace,
    means,
    steps,
    judge,
    result,
    minDelta: check.minDelta,
    align: { ...summarizeAlign(check), flashSizeMedian: flashSizeMedian == null ? null : Math.round(flashSizeMedian * 1000) / 1000 },
  };
  console.info('[판정]', debug);
  window.__lastCheck = debug;
  renderResult(check, result, judge, null, flashSizeMedian);
  renderHostUi();
}

function failCheck(reason, label = ERROR_LABEL) {
  const check = S && S.check;
  if (!check || check.done) return;
  if (check.phase === 'align') check.sess.mesh.send(check.peerId, { type: 'align-cancel', runId: check.runId });
  stopCheck(check);
  const debug = { runId: check.runId, peer: check.pv.name, phase: check.phase, reason, align: summarizeAlign(check) };
  console.info('[판정 실패]', reason, debug);
  window.__lastCheck = debug;
  renderResult(check, { status: 'error', label, deltas: null }, null, reason);
  renderHostUi();
}

// 호스트가 맞추기 단계에서 "판정 취소": 결과 없이 원래대로
function cancelCheck() {
  const check = S && S.check;
  if (!check || check.done || check.phase !== 'align') return;
  check.sess.mesh.send(check.peerId, { type: 'align-cancel', runId: check.runId });
  stopCheck(check);
  console.info('[판정 취소]', { runId: check.runId, align: summarizeAlign(check) });
  check.pv.badge.className = 'badge';
  check.pv.badge.textContent = '';
  check.pv.detail.classList.remove('on');
  check.pv.detail.textContent = '';
  renderHostUi();
}

// ---------- 호스트: 판정 표시 ----------
function renderAligning(check, a) {
  const { badge, detail } = check.pv;
  detail.classList.remove('on');
  detail.textContent = '';
  badge.className = 'badge align';
  const pct = a && a.size != null ? `${Math.round(a.size * 100)}%` : '얼굴 없음';
  badge.textContent = `얼굴 맞추는 중 · ${pct}`;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${Math.round(ALIGN.sizeMin * 100)}% 이상 ${ALIGN.holdMs / 1000}초 유지되면 자동으로 플래시 시작 · ${ALIGN.timeoutMs / 1000}초 제한`;
  badge.append(sub);
}

function renderRunning(check, i) {
  const { badge, detail } = check.pv;
  detail.classList.remove('on');
  detail.textContent = '';
  badge.className = 'badge run';
  badge.textContent = i < 0 ? '판정 중 · 시작하는 중' : `판정 중 ${i + 1}/${check.seq.length} · ${COLOR_KO[check.seq[i]]}`;
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
  const line1 = `얼굴 반사 Δ · 빨강 ${fmtDelta(d.red)} · 초록 ${fmtDelta(d.green)} · 파랑 ${fmtDelta(d.blue)}`;
  let line2;
  const th = check.minDelta;
  if (result.far)
    line2 = `플래시 중 얼굴 크기 ${Math.round(flashSizeMedian * 100)}% (기준 ${Math.round(ALIGN.sizeMin * 100)}%) · 화면에 더 가까이 와 주세요`;
  else if (result.status === 'unmeasured') line2 = '얼굴이 화면에 잘 보이게 한 뒤 다시 시도해 주세요';
  else if (judge && judge.matched === judge.total) line2 = `${judge.total}색 모두 기준(${th}) 이상`;
  else if (judge) line2 = `${judge.total}색 중 ${judge.matched}색만 기준(${th}) 이상`;
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
  copyBtn.textContent = ok ? '복사됨' : '복사 실패';
  setTimeout(() => (copyBtn.textContent = '복사'), 1500);
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
