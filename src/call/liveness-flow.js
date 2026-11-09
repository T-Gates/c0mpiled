import { CHECK, LIGHT_RGB, randomSequence, evaluateCheck } from './liveness.js';
import { faceRegions } from './roi.js';

// Host owns sequence, timing and verdict. Guest messages are display ACKs only.
export function startHostCheck({ video, detect, send, onProgress, onResult, minDelta }) {
  const runId = crypto.randomUUID(), sequence = randomSequence();
  const frames = [], starts = [];
  let done = false, expected = -1, waiting = true, pulseStart = null, pulseEnd = null;
  let timeout, next, frameCallback, watchdog, lastVideoTime = -1, lastFrameAt = performance.now(), dimensions = null;
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rvfc = typeof video.requestVideoFrameCallback === 'function';
  const stop = () => {
    done = true; clearTimeout(timeout); clearTimeout(next); clearInterval(watchdog);
    if (frameCallback != null) rvfc ? video.cancelVideoFrameCallback(frameCallback) : cancelAnimationFrame(frameCallback);
    send({ type: 'check-stop', version: CHECK.version, runId });
  };
  const fail = reason => {
    if (done) return;
    stop(); onResult({ status: 'insufficient', label: '측정 불충분', reason, humanVerified: false, deepfakeVerified: false });
  };
  const issue = () => {
    if (done) return;
    if (expected === sequence.length) {
      stop();
      const result = evaluateCheck({ frames, pulseStart, pulseEnd, sequence, starts, minDelta });
      onResult(result);
      return;
    }
    waiting = true;
    timeout = setTimeout(() => fail('상대 화면 응답 시간 초과 · 양쪽 앱을 새로고침하세요'), 2500);
    const packet = expected < 0 ? { type: 'check-start', version: CHECK.version, runId } : { type: 'check-light', version: CHECK.version, runId, i: expected, color: sequence[expected] };
    if (!send(packet)) fail('데이터 채널 연결 끊김');
  };
  const receive = msg => {
    if (done || msg.runId !== runId || msg.version !== CHECK.version) return;
    if (msg.type === 'check-abort') { fail('상대가 검사를 중지했거나 화면이 숨겨졌습니다'); return; }
    if (msg.type !== 'check-ack' || !waiting || msg.i !== expected) return;
    const color = expected < 0 ? 'white' : sequence[expected];
    if (msg.color !== color) { fail('조명 ACK 불일치'); return; }
    waiting = false; clearTimeout(timeout);
    const now = performance.now();
    if (expected < 0) {
      pulseStart = now; onProgress({ phase: 'pulse', seconds: 32 });
      next = setTimeout(() => { pulseEnd = performance.now(); expected = 0; issue(); }, CHECK.pulseMs);
    } else {
      starts[expected] = now; onProgress({ phase: 'light', index: expected, total: sequence.length, color });
      next = setTimeout(() => { expected++; issue(); }, CHECK.stepMs);
    }
  };
  const sample = () => {
    if (done) return;
    if (video.readyState >= 2 && video.videoWidth && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const t = performance.now(), w = video.videoWidth, h = video.videoHeight;
      if (dimensions && (dimensions[0] !== w || dimensions[1] !== h)) { fail('수신 영상 해상도 변경 · 다시 측정하세요'); return; }
      dimensions = [w, h];
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      try {
        ctx.drawImage(video, 0, 0, w, h);
        const faces = detect(canvas).faceLandmarks || [];
        const roi = faces.length === 1 ? faceRegions(ctx.getImageData(0, 0, w, h), faces[0]) : null;
        frames.push({ t, faceCount: faces.length, ...roi }); lastFrameAt = t;
      } catch { fail('수신 영상 처리 오류'); return; }
    }
    frameCallback = rvfc ? video.requestVideoFrameCallback(sample) : requestAnimationFrame(sample);
  };
  const startedAt = performance.now();
  watchdog = setInterval(() => {
    const now = performance.now();
    if (now - startedAt > CHECK.timeoutMs) fail('전체 검사 시간 초과');
    else if (now - lastFrameAt > 2000) fail('수신 영상 frame 정지');
    else if (pulseStart && pulseEnd == null) onProgress({ phase: 'pulse', seconds: Math.max(0, Math.ceil((pulseStart + CHECK.pulseMs - now) / 1000)) });
  }, 500);
  onProgress({ phase: 'starting' });
  frameCallback = rvfc ? video.requestVideoFrameCallback(sample) : requestAnimationFrame(sample);
  issue();
  return { runId, receive, cancel: reason => fail(reason || '검사를 중지했습니다'), stop };
}

export function createGuestCheck({ send, show, hide }) {
  let runId = null, index = -1, timer, raf1, raf2;
  const stop = (notify = false) => {
    if (notify && runId) send({ type: 'check-abort', version: CHECK.version, runId });
    clearTimeout(timer); cancelAnimationFrame(raf1); cancelAnimationFrame(raf2);
    runId = null; index = -1; hide();
  };
  const paint = (color, i) => {
    const id = runId;
    show(LIGHT_RGB[color], i < 0 ? 'pulse 측정 중 · 얼굴을 편하게 고정해 주세요 (약 32초)' : `조명 응답 측정 중 · ${i + 1}/12`);
    raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => {
      if (runId === id) send({ type: 'check-ack', version: CHECK.version, runId, i, color });
    }); });
  };
  return {
    receive(msg) {
      if (msg.version !== CHECK.version) return;
      if (msg.type === 'check-start') {
        if (runId || typeof msg.runId !== 'string' || msg.runId.length > 80 || !msg.runId) return;
        runId = msg.runId; index = -1;
        timer = setTimeout(() => stop(true), CHECK.timeoutMs); paint('white', -1);
      } else if (runId && msg.runId === runId) {
        if (msg.type === 'check-stop') stop();
        else if (msg.type === 'check-light') {
          if (!Number.isInteger(msg.i) || msg.i !== index + 1 || msg.i >= 12 || !Object.hasOwn(LIGHT_RGB, msg.color)) { stop(true); return; }
          index = msg.i; paint(msg.color, index);
        }
      }
    },
    cancel: () => stop(true),
    stop: () => stop(),
  };
}
