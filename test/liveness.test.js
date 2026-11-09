import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePulse } from '../src/call/rppg.js';
import { CHECK, analyzeLight, continuity, evaluateCheck, randomSequence } from '../src/call/liveness.js';
import { faceRegions } from '../src/call/roi.js';

function trace(mode = 'pulse', duration = 30, fps = 30) {
  return Array.from({ length: duration * fps }, (_, i) => {
    const t = i / fps, pulse = Math.sin(2 * Math.PI * 1.2 * t);
    const regions = [0, 1, 2].map(region => {
      const p = mode === 'incoherent' ? Math.sin(2 * Math.PI * (1 + region * .5) * t) : pulse;
      return [150, 110, 80].map((v, c) => mode === 'flat' ? v : mode === 'light' ? v * (1 + .03 * p) : v * (1 + [.002, .01, .001][c] * p));
    });
    return { t: t * 1000, faceCount: 1, regions, face: regions[0], clipped: 0, box: { x: .5, y: .5, w: .3, h: .4 } };
  });
}
function lightTrace(sequence, offset = 32000) {
  const starts = sequence.map((_, i) => offset + i * CHECK.stepMs);
  const frames = sequence.flatMap((color, i) => Array.from({ length: 36 }, (_, k) => {
    const rgb = [100, 90, 80];
    if (color !== 'white') rgb[['red', 'green', 'blue'].indexOf(color)] += 15;
    return { t: starts[i] + k * 1000 / 30, face: rgb, regions: [rgb, rgb, rgb], clipped: 0, faceCount: 1, box: { x: .5, y: .5, w: .3, h: .4 } };
  }));
  return { frames, starts };
}
test('known chromatic pulse is recovered in multiple ROI, not just a returned BPM', () => {
  const result = analyzePulse(trace());
  assert.equal(result.passed, true);
  assert.ok(Math.abs(result.bpm - 72) <= 2);
  assert.equal(result.regions.length, 3);
});
test('flat, common illumination and incoherent regions cannot be pulse positives', () => {
  for (const mode of ['flat', 'light', 'incoherent']) assert.equal(analyzePulse(trace(mode)).passed, false, mode);
});
test('pulse rejects short data, low fps, clipping, timestamp duplicates and missing frames', () => {
  assert.equal(analyzePulse(trace('pulse', 10)).passed, false);
  assert.equal(analyzePulse(trace('pulse', 30, 8)).passed, false);
  assert.equal(analyzePulse(trace().map(f => ({ ...f, clipped: .5 }))).passed, false);
  const duplicate = trace(); duplicate[50].t = duplicate[49].t;
  assert.equal(analyzePulse(duplicate).passed, false);
  assert.equal(analyzePulse(trace().filter((_, i) => i < 150 || i > 180)).passed, false);
  const motion = trace(); motion.forEach((f, i) => { f.box.x += .1 * Math.sin(i / 10); });
  assert.equal(analyzePulse(motion).passed, false);
});
test('right color order passes; wrong order, no light and missing ACK never pass', () => {
  const seq = randomSequence(() => .3), { frames, starts } = lightTrace(seq);
  assert.equal(analyzeLight(frames, seq, starts).passed, true);
  const wrong = seq.map(c => ({ red: 'green', green: 'blue', blue: 'red', white: 'white' })[c]);
  assert.equal(analyzeLight(frames, wrong, starts).passed, false);
  assert.equal(analyzeLight(frames.map(f => ({ ...f, face: [100, 90, 80] })), seq, starts).passed, false);
  assert.equal(analyzeLight(frames, seq, starts.map((s, i) => i === 2 ? null : s)).status, 'insufficient');
});
test('continuity rejects abrupt switching, multiple faces and long gaps', () => {
  const normal = trace(); assert.equal(continuity(normal).passed, true);
  const switched = trace(); switched[150].box.x += .3;
  assert.equal(continuity(switched).passed, false);
  const two = trace(); two[150].faceCount = 2;
  assert.equal(continuity(two).passed, false);
  assert.equal(continuity(normal.filter((_, i) => i < 150 || i > 180)).passed, false);
});
test('combined positive needs both signals and never asserts human/deepfake identity', () => {
  const seq = randomSequence(() => .3), light = lightTrace(seq);
  const input = { frames: [...trace('pulse', 32), ...light.frames], pulseStart: 0, pulseEnd: 32000, sequence: seq, starts: light.starts };
  const result = evaluateCheck(input);
  assert.equal(result.status, 'observed');
  assert.equal(result.humanVerified, false); assert.equal(result.deepfakeVerified, false);
  assert.equal(evaluateCheck({ ...input, frames: [...trace('flat', 32), ...light.frames] }).status, 'insufficient');
});
test('ROI samples actual pixels and refuses off-frame landmarks', () => {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([150, 110, 80, 255], i);
  const lm = Array.from({ length: 468 }, (_, i) => ({ x: i % 2 ? .1 : .9, y: .5 }));
  for (const i of [50, 280, 151]) lm[i] = { x: .5, y: .5 };
  assert.deepEqual(faceRegions({ data, width: 100, height: 100 }, lm).regions[0], [150, 110, 80]);
  assert.equal(faceRegions({ data, width: 100, height: 100 }, lm.map(p => ({ ...p, x: 3 }))), null);
});
