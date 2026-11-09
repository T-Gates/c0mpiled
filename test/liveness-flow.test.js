import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHostCheck, createGuestCheck } from '../src/call/liveness-flow.js';
import { CHECK } from '../src/call/liveness.js';

test('host aligns received face, then pulse and 12 just-in-time colors; flat video cannot pass', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const original = { document: globalThis.document, raf: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  const callbacks = new Map(); let rafId = 0;
  globalThis.requestAnimationFrame = cb => { callbacks.set(++rafId, cb); return rafId; };
  globalThis.cancelAnimationFrame = id => callbacks.delete(id);
  const data = new Uint8ClampedArray(100 * 100 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([150, 110, 80, 255], i);
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data, width: 100, height: 100 }) }) }) };
  t.after(() => { globalThis.document = original.document; globalThis.requestAnimationFrame = original.raf; globalThis.cancelAnimationFrame = original.cancel; });
  const flushPaint = () => {
    for (let round = 0; round < 2; round++) {
      const current = [...callbacks.values()]; callbacks.clear(); current.forEach(cb => cb());
    }
  };
  const landmarks = Array.from({ length: 468 }, (_, i) => ({ x: i % 2 ? .25 : .75, y: i % 2 ? .22 : .72 }));
  for (const i of [50, 280, 151]) landmarks[i] = { x: .5, y: .47 };
  let host, result, visible = false, pendingFrame;
  const packets = [], phases = [];
  const guest = createGuestCheck({ send: p => { host.receive(p); return true; }, show: () => { visible = true; }, hide: () => { visible = false; } });
  const video = { videoWidth: 100, videoHeight: 100, readyState: 2, currentTime: 0,
    requestVideoFrameCallback: cb => { pendingFrame = cb; return 1; }, cancelVideoFrameCallback: () => { pendingFrame = null; } };
  host = startHostCheck({ video, detect: () => ({ faceLandmarks: [landmarks] }),
    send: p => { packets.push(p); guest.receive(p); return true; }, onProgress: p => phases.push(p.phase), onResult: r => { result = r; } });
  assert.equal(packets[0].type, 'align-start');
  for (let tick = 0; tick < 500 && !result; tick++) {
    now += 100; video.currentTime = now / 1000; pendingFrame?.();
    flushPaint(); t.mock.timers.tick(100);
  }
  assert.ok(phases.includes('align')); assert.ok(phases.includes('pulse')); assert.ok(phases.includes('light'));
  const light = packets.filter(p => p.type === 'check-light');
  assert.equal(light.length, 12);
  light.forEach((p, i) => { assert.equal(p.i, i); assert.equal('seq' in p, false); });
  assert.equal(result.status, 'insufficient');
  assert.equal(visible, false);
  assert.equal(packets.at(-1).type, 'check-stop');
});

test('guest rejects skipped stages and aborts; foreign versions never display', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame];
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
  t.after(() => { [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = saved; });
  let shown = 0, hidden = 0; const sent = [];
  const guest = createGuestCheck({ send: p => sent.push(p), show: () => shown++, hide: () => hidden++ });
  guest.receive({ type: 'check-start', runId: 'test', version: 1 }); assert.equal(shown, 0);
  guest.receive({ type: 'check-start', runId: 'test', version: 2 }); assert.equal(shown, 1);
  guest.receive({ type: 'check-light', runId: 'foreign', version: 2, i: 0, color: 'white' }); assert.equal(shown, 1);
  guest.receive({ type: 'check-light', runId: 'test', version: 2, i: 2, color: 'red' });
  assert.equal(sent.at(-1).type, 'check-abort'); assert.equal(hidden, 1);
});
