import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHostCheck, createGuestCheck } from '../src/call/liveness-flow.js';
import { CHECK } from '../src/call/liveness.js';

test('host/guest protocol runs pulse then 12 just-in-time colors; empty video cannot pass', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const original = { document: globalThis.document, raf: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  const callbacks = new Map(); let rafId = 0;
  globalThis.requestAnimationFrame = cb => { callbacks.set(++rafId, cb); return rafId; };
  globalThis.cancelAnimationFrame = id => callbacks.delete(id);
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
  t.after(() => { globalThis.document = original.document; globalThis.requestAnimationFrame = original.raf; globalThis.cancelAnimationFrame = original.cancel; });
  const flushPaint = () => {
    for (let round = 0; round < 2; round++) {
      const current = [...callbacks.values()]; callbacks.clear(); current.forEach(cb => cb());
    }
  };
  let host, result, visible = false;
  const packets = [], phases = [];
  const guest = createGuestCheck({ send: p => { host.receive(p); return true; }, show: () => { visible = true; }, hide: () => { visible = false; } });
  host = startHostCheck({ video: { requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {} }, detect: () => ({}),
    send: p => { packets.push(p); guest.receive(p); return true; }, onProgress: p => phases.push(p.phase), onResult: r => { result = r; } });
  assert.equal(packets[0].type, 'check-start');
  assert.equal('seq' in packets[0], false);
  flushPaint(); assert.equal(phases.at(-1), 'pulse');
  t.mock.timers.tick(CHECK.pulseMs);
  for (let i = 0; i < 12; i++) {
    const packet = packets.at(-1);
    assert.equal(packet.type, 'check-light'); assert.equal(packet.i, i);
    flushPaint(); t.mock.timers.tick(CHECK.stepMs);
  }
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
