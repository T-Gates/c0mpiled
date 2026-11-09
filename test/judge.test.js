// Unit tests for src/judge.js, written against CONTRACT.md only (not the implementation).
// Run: node --test test/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import {
  POSES,
  DEFAULTS,
  chroma,
  fingerAngles,
  fingerStates,
  poseMatches,
  pickPoseSequence,
  judgeColorSteps,
  checkTransition,
  finalVerdict,
} from '../src/judge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

function approx(actual, expected, tol = 1e-6, msg = '') {
  assert.equal(typeof actual, 'number', `${msg} expected a number, got ${actual}`);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} expected ${expected} ± ${tol}, got ${actual}`,
  );
}

function approxArray(actual, expected, tol = 1e-6, msg = '') {
  assert.ok(Array.isArray(actual), `${msg} expected an array, got ${actual}`);
  assert.equal(actual.length, expected.length, `${msg} length`);
  expected.forEach((e, i) => approx(actual[i], e, tol, `${msg}[${i}]`));
}

// Synthetic 21-landmark hand (MediaPipe indexing):
//   0 wrist | 1-4 thumb (CMC, MCP, IP, TIP) | 5-8 index | 9-12 middle | 13-16 ring | 17-20 pinky
// Geometry (image coords, y grows downward):
//   wrist (0.5, 0.8), finger MCPs at y = 0.6, so hand size |p0 - p9| (2D) = 0.2 exactly.
//   Each finger's PIP sits SEG above its MCP. The DIP/TIP leave the PIP at angle θ relative to
//   the PIP→MCP direction, bending in the y-z plane (θ = 180 → straight/collinear, θ = 90 → bent
//   into +z). The thumb does the same at its IP joint (point 3), bending in the x-z plane.
//   Bending into z means the bend is only visible in 3D, and 2D landmark motion stays small.
const SEG = 0.03;
const HAND_SIZE = 0.2;
const FINGER_BASE = { index: 5, middle: 9, ring: 13, pinky: 17 };
const FINGER_MCP_X = { index: 0.44, middle: 0.5, ring: 0.56, pinky: 0.62 };

/**
 * @param {Partial<Record<'thumb'|'index'|'middle'|'ring'|'pinky', number>>} angles joint angle in degrees (default 180)
 * @param {{dx?: number, dy?: number}} offset 2D translation applied to every point
 */
function makeHand(angles = {}, { dx = 0, dy = 0 } = {}) {
  const a = { thumb: 180, index: 180, middle: 180, ring: 180, pinky: 180, ...angles };
  const pts = new Array(21);
  const P = (x, y, z = 0) => ({ x: x + dx, y: y + dy, z });

  pts[0] = P(0.5, 0.8);

  // Thumb: 2 → 3 runs along -x; angle measured at 3 between (3→2) = +x and (3→4).
  pts[1] = P(0.42, 0.76);
  pts[2] = P(0.39, 0.72);
  const ipX = 0.39 - SEG;
  pts[3] = P(ipX, 0.72);
  const tt = a.thumb * DEG;
  pts[4] = P(ipX + SEG * Math.cos(tt), 0.72, SEG * Math.sin(tt));

  // Other fingers: MCP → PIP runs along -y; angle at PIP between (PIP→MCP) = +y and (PIP→TIP).
  for (const f of ['index', 'middle', 'ring', 'pinky']) {
    const b = FINGER_BASE[f];
    const x = FINGER_MCP_X[f];
    const pipY = 0.6 - SEG;
    const th = a[f] * DEG;
    const cy = Math.cos(th);
    const sz = Math.sin(th);
    pts[b] = P(x, 0.6);
    pts[b + 1] = P(x, pipY);
    pts[b + 2] = P(x, pipY + SEG * cy, SEG * sz);
    pts[b + 3] = P(x, pipY + 2 * SEG * cy, 2 * SEG * sz);
  }
  return pts;
}

/** Hand whose fingers are straight (180°) where states[i] is true and bent (90°) where false. */
function handFromStates(states, offset) {
  const angles = {};
  FINGERS.forEach((f, i) => {
    angles[f] = states[i] ? 180 : 90;
  });
  return makeHand(angles, offset);
}

/** Turn an array of (landmarks|null) into frames with evenly spaced t. */
function framesFrom(list, stepMs = 50, t0 = 0) {
  return list.map((landmarks, i) => ({ t: t0 + i * stepMs, landmarks }));
}

/** Deterministic PRNG returning [0,1). */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function assertValidSequence(seq, n) {
  assert.ok(Array.isArray(seq), 'sequence must be an array');
  assert.equal(seq.length, n, 'sequence length');
  const keys = Object.keys(POSES);
  for (const k of seq) assert.ok(keys.includes(k), `unknown pose key: ${k}`);
  for (let i = 1; i < seq.length; i++) {
    assert.notEqual(seq[i], seq[i - 1], `consecutive duplicate at ${i - 1},${i}: ${seq}`);
  }
}

// Run pickPoseSequence in a child process so that a non-terminating implementation
// (e.g. rejection sampling with a constant rand) fails the test instead of hanging the suite.
const JUDGE_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/judge.js'),
).href;

function pickIsolated(randSrc, n, timeoutMs = 5000) {
  const code =
    `const m = await import(${JSON.stringify(JUDGE_URL)});` +
    `const rand = ${randSrc};` +
    `process.stdout.write(JSON.stringify(m.pickPoseSequence(${n}, rand)));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    timeout: timeoutMs,
    encoding: 'utf8',
  });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) {
    assert.fail(`pickPoseSequence(${n}, ${randSrc}) did not terminate within ${timeoutMs}ms`);
  }
  assert.equal(r.status, 0, `child process failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const CHANNEL = { red: 0, green: 1, blue: 2 };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('POSES / DEFAULTS', () => {
  test('POSES has the contract shapes', () => {
    assert.deepEqual(POSES, {
      open: [true, true, true, true, true],
      fist: [false, false, false, false, false],
      point: [false, true, false, false, false],
      peace: [false, true, true, false, false],
      three: [false, true, true, true, false],
      rock: [false, true, false, false, true],
    });
  });

  test('DEFAULTS has the contract values', () => {
    assert.deepEqual(DEFAULTS, {
      minDelta: 0.004,
      passRatio: 0.8,
      extendedDeg: 160,
      thumbExtendedDeg: 150,
      maxGapMs: 200,
      maxAngleJumpDeg: 70,
      maxLandmarkJump: 0.5,
    });
  });
});

// ---------------------------------------------------------------------------
// chroma
// ---------------------------------------------------------------------------

describe('chroma', () => {
  test('normalizes by R+G+B', () => {
    approxArray(chroma([10, 20, 30]), [1 / 6, 2 / 6, 3 / 6], 1e-12);
    approxArray(chroma([255, 0, 0]), [1, 0, 0], 1e-12);
    approxArray(chroma([0, 255, 0]), [0, 1, 0], 1e-12);
    approxArray(chroma([0, 0, 255]), [0, 0, 1], 1e-12);
    approxArray(chroma([255, 255, 255]), [1 / 3, 1 / 3, 1 / 3], 1e-12);
  });

  test('result sums to 1 for arbitrary non-zero input', () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 200; i++) {
      const rgb = [rand() * 255, rand() * 255, rand() * 255];
      const c = chroma(rgb);
      approx(c[0] + c[1] + c[2], 1, 1e-9, `sum for ${rgb}`);
      c.forEach((v) => assert.ok(v >= 0 && v <= 1, `component out of [0,1]: ${v}`));
    }
  });

  test('is brightness invariant (scaling RGB does not change chroma)', () => {
    approxArray(chroma([60, 45, 30]), chroma([120, 90, 60]), 1e-12);
  });

  test('zero input → [1/3, 1/3, 1/3]', () => {
    approxArray(chroma([0, 0, 0]), [1 / 3, 1 / 3, 1 / 3], 1e-12);
  });
});

// ---------------------------------------------------------------------------
// fingerAngles / fingerStates
// ---------------------------------------------------------------------------

describe('fingerAngles', () => {
  test('returns an object with the five finger keys', () => {
    const r = fingerAngles(makeHand());
    for (const f of FINGERS) assert.equal(typeof r[f], 'number', `${f} angle`);
  });

  test('straight (collinear) joints → ~180°', () => {
    const r = fingerAngles(makeHand());
    for (const f of FINGERS) approx(r[f], 180, 1e-4, f);
  });

  test('bent joints → ~90°', () => {
    const r = fingerAngles(makeHand({ thumb: 90, index: 90, middle: 90, ring: 90, pinky: 90 }));
    for (const f of FINGERS) approx(r[f], 90, 1e-4, f);
  });

  test('each finger angle is measured at its own joint (mixed angles)', () => {
    const angles = { thumb: 135, index: 170, middle: 45, ring: 120, pinky: 100 };
    const r = fingerAngles(makeHand(angles));
    for (const f of FINGERS) approx(r[f], angles[f], 1e-4, f);
  });

  test('uses 3D vectors (bend only along z is detected)', () => {
    // makeHand bends purely into z; a 2D-only computation would report ~180 here.
    const r = fingerAngles(makeHand({ index: 90 }));
    approx(r.index, 90, 1e-4, 'index');
  });

  test('is translation invariant', () => {
    const angles = { thumb: 140, index: 100, middle: 165, ring: 90, pinky: 175 };
    const a = fingerAngles(makeHand(angles));
    const b = fingerAngles(makeHand(angles, { dx: 0.17, dy: -0.11 }));
    for (const f of FINGERS) approx(b[f], a[f], 1e-6, f);
  });

  test('angles stay within [0, 180]', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const angles = {};
      for (const f of FINGERS) angles[f] = rand() * 180;
      const r = fingerAngles(makeHand(angles));
      for (const f of FINGERS) {
        assert.ok(r[f] >= 0 && r[f] <= 180, `${f} out of range: ${r[f]}`);
      }
    }
  });
});

describe('fingerStates', () => {
  for (const [name, shape] of Object.entries(POSES)) {
    test(`synthetic POSES.${name} hand → states equal POSES.${name}`, () => {
      assert.deepEqual(fingerStates(handFromStates(shape)), shape);
    });
  }

  test('peace shape explicitly: index+middle extended, others bent', () => {
    assert.deepEqual(fingerStates(handFromStates(POSES.peace)), [false, true, true, false, false]);
  });

  test('fist shape explicitly: all bent', () => {
    assert.deepEqual(fingerStates(handFromStates(POSES.fist)), [false, false, false, false, false]);
  });

  test('default opts equal passing DEFAULTS explicitly', () => {
    const hand = makeHand({ thumb: 155, index: 165, middle: 155, ring: 100, pinky: 179 });
    assert.deepEqual(fingerStates(hand), fingerStates(hand, DEFAULTS));
  });

  test('thumb uses thumbExtendedDeg (150), not extendedDeg (160)', () => {
    // 155° is above the thumb threshold but below the finger threshold.
    assert.equal(fingerStates(makeHand({ thumb: 155 }))[0], true);
    assert.equal(fingerStates(makeHand({ thumb: 145 }))[0], false);
  });

  test('index..pinky use extendedDeg (160)', () => {
    for (let i = 1; i < 5; i++) {
      const f = FINGERS[i];
      assert.equal(fingerStates(makeHand({ [f]: 165 }))[i], true, `${f} at 165`);
      assert.equal(fingerStates(makeHand({ [f]: 155 }))[i], false, `${f} at 155`);
    }
  });

  test('custom thresholds from opts are honored', () => {
    const hand = makeHand({ thumb: 110, index: 120, middle: 90, ring: 120, pinky: 90 });
    const opts = { ...DEFAULTS, extendedDeg: 100, thumbExtendedDeg: 100 };
    assert.deepEqual(fingerStates(hand, opts), [true, true, false, true, false]);
  });

  test('returns 5 booleans', () => {
    const s = fingerStates(makeHand());
    assert.equal(s.length, 5);
    s.forEach((v) => assert.equal(typeof v, 'boolean'));
  });
});

// ---------------------------------------------------------------------------
// poseMatches
// ---------------------------------------------------------------------------

describe('poseMatches', () => {
  test('identical states match', () => {
    for (const shape of Object.values(POSES)) {
      assert.equal(poseMatches([...shape], shape), true);
    }
  });

  test('ignoreThumb defaults to true: thumb mismatch is ignored', () => {
    const states = [true, true, true, false, false]; // thumb out
    assert.equal(poseMatches(states, POSES.peace), true);
    assert.equal(poseMatches(states, POSES.peace, {}), true);
    assert.equal(poseMatches(states, POSES.peace, { ignoreThumb: true }), true);
  });

  test('ignoreThumb false: thumb mismatch fails, thumb match passes', () => {
    assert.equal(poseMatches([true, true, true, false, false], POSES.peace, { ignoreThumb: false }), false);
    assert.equal(poseMatches([false, true, true, false, false], POSES.peace, { ignoreThumb: false }), true);
  });

  test('any non-thumb mismatch fails regardless of ignoreThumb', () => {
    for (let i = 1; i < 5; i++) {
      const states = [...POSES.three];
      states[i] = !states[i];
      assert.equal(poseMatches(states, POSES.three), false, `flip index ${i}`);
      assert.equal(poseMatches(states, POSES.three, { ignoreThumb: false }), false, `flip index ${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// pickPoseSequence
// ---------------------------------------------------------------------------

describe('pickPoseSequence', () => {
  test('returns n valid keys with no consecutive duplicates (default rand)', () => {
    for (let i = 0; i < 300; i++) assertValidSequence(pickPoseSequence(3), 3);
  });

  test('seeded rand, many iterations and lengths', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rand = mulberry32(seed);
      const n = 1 + (seed % 10);
      assertValidSequence(pickPoseSequence(n, rand), n);
    }
  });

  test('cyclic rand that repeats values back-to-back still yields no consecutive duplicates', () => {
    const cycle = [0, 0, 0, 0.5, 0.5, 0.5, 0.99, 0.99, 0.99];
    for (let start = 0; start < cycle.length; start++) {
      let i = start;
      const rand = () => cycle[i++ % cycle.length];
      assertValidSequence(pickPoseSequence(6, rand), 6);
    }
  });

  test('constant rand () => 0 still yields a valid sequence and terminates', () => {
    assertValidSequence(pickIsolated('() => 0', 6), 6);
  });

  test('constant rand near 1 still yields a valid sequence and terminates', () => {
    assertValidSequence(pickIsolated('() => 0.9999999999', 6), 6);
  });

  test('is deterministic given the same rand sequence', () => {
    for (let seed = 1; seed <= 50; seed++) {
      assert.deepEqual(pickPoseSequence(5, mulberry32(seed)), pickPoseSequence(5, mulberry32(seed)));
    }
  });
});

// ---------------------------------------------------------------------------
// judgeColorSteps
// ---------------------------------------------------------------------------

describe('judgeColorSteps', () => {
  const BASE = [100, 100, 100];

  test('red sample that raises r-chroma beyond minDelta and is the max → matched', () => {
    const r = judgeColorSteps([{ color: 'red', baseline: BASE, sample: [120, 100, 100] }]);
    assert.equal(r.total, 1);
    assert.equal(r.matched, 1);
    assert.equal(r.passed, true);
    assert.equal(r.details.length, 1);
    assert.equal(r.details[0].color, 'red');
    assert.equal(r.details[0].matched, true);
    // chroma([120,100,100]) = [0.375, 0.3125, 0.3125]; baseline = 1/3 each
    approxArray(r.details[0].delta, [0.375 - 1 / 3, 0.3125 - 1 / 3, 0.3125 - 1 / 3], 1e-9);
  });

  test('green and blue map to channels 1 and 2', () => {
    const r = judgeColorSteps([
      { color: 'green', baseline: BASE, sample: [100, 120, 100] },
      { color: 'blue', baseline: BASE, sample: [100, 100, 120] },
      { color: 'green', baseline: BASE, sample: [100, 100, 120] }, // wrong channel rose
    ]);
    assert.deepEqual(r.details.map((d) => d.matched), [true, true, false]);
    assert.equal(r.matched, 2);
    assert.equal(r.total, 3);
  });

  test('delta below minDelta → not matched', () => {
    // chroma r = 101/301 ≈ 0.33555 → delta ≈ 0.0022 < 0.004
    const r = judgeColorSteps([{ color: 'red', baseline: BASE, sample: [101, 100, 100] }]);
    assert.ok(r.details[0].delta[0] > 0 && r.details[0].delta[0] < DEFAULTS.minDelta);
    assert.equal(r.details[0].matched, false);
    assert.equal(r.matched, 0);
    assert.equal(r.passed, false);
  });

  test('custom minDelta in opts is honored', () => {
    const steps = [{ color: 'red', baseline: BASE, sample: [101, 100, 100] }];
    const r = judgeColorSteps(steps, { ...DEFAULTS, minDelta: 0.001 });
    assert.equal(r.details[0].matched, true);
  });

  test('target channel delta above minDelta but not the max → not matched', () => {
    // chroma([120,140,60]) = [0.375, 0.4375, 0.1875]: dr ≈ +0.042, dg ≈ +0.104 (max)
    const r = judgeColorSteps([{ color: 'red', baseline: BASE, sample: [120, 140, 60] }]);
    const d = r.details[0].delta;
    assert.ok(d[CHANNEL.red] > DEFAULTS.minDelta);
    assert.ok(d[CHANNEL.green] > d[CHANNEL.red]);
    assert.equal(r.details[0].matched, false);
  });

  test('null baseline or null sample → not matched, delta null', () => {
    const r = judgeColorSteps([
      { color: 'red', baseline: null, sample: [200, 50, 50] },
      { color: 'green', baseline: BASE, sample: null },
      { color: 'blue', baseline: null, sample: null },
    ]);
    assert.equal(r.total, 3);
    assert.equal(r.matched, 0);
    assert.equal(r.passed, false);
    assert.equal(r.details.length, 3);
    for (const d of r.details) {
      assert.equal(d.matched, false);
      assert.equal(d.delta, null);
    }
    assert.deepEqual(r.details.map((d) => d.color), ['red', 'green', 'blue']);
  });

  test('brightness-only change (sample = baseline × 0.5) → not matched', () => {
    const baseline = [120, 90, 60];
    const sample = baseline.map((v) => v * 0.5);
    const r = judgeColorSteps(
      ['red', 'green', 'blue'].map((color) => ({ color, baseline, sample })),
    );
    for (const d of r.details) {
      assert.equal(d.matched, false, d.color);
      approxArray(d.delta, [0, 0, 0], 1e-12, d.color);
    }
    assert.equal(r.passed, false);
  });

  // Build a step that matches or not, for ratio tests.
  const hit = (color) => {
    const sample = [100, 100, 100];
    sample[CHANNEL[color]] = 140;
    return { color, baseline: BASE, sample };
  };
  const miss = (color) => ({ color, baseline: BASE, sample: [100, 100, 100] });

  test('passRatio boundary: 5 of 6 passes at 0.8 (ceil(4.8) = 5)', () => {
    const steps = [hit('red'), hit('green'), hit('blue'), hit('red'), hit('green'), miss('blue')];
    const r = judgeColorSteps(steps);
    assert.equal(r.total, 6);
    assert.equal(r.matched, 5);
    assert.equal(r.passed, true);
  });

  test('passRatio boundary: 4 of 6 fails at 0.8', () => {
    const steps = [hit('red'), hit('green'), hit('blue'), hit('red'), miss('green'), miss('blue')];
    const r = judgeColorSteps(steps);
    assert.equal(r.total, 6);
    assert.equal(r.matched, 4);
    assert.equal(r.passed, false);
  });

  test('3 of 3 passes, 2 of 3 fails at 0.8 (ceil(2.4) = 3)', () => {
    assert.equal(judgeColorSteps([hit('red'), hit('green'), hit('blue')]).passed, true);
    assert.equal(judgeColorSteps([hit('red'), hit('green'), miss('blue')]).passed, false);
  });

  test('custom passRatio in opts is honored', () => {
    const steps = [hit('red'), hit('green'), miss('blue')];
    assert.equal(judgeColorSteps(steps, { ...DEFAULTS, passRatio: 0.5 }).passed, true);
  });

  test('empty steps → passed false, total 0, details []', () => {
    const r = judgeColorSteps([]);
    assert.equal(r.passed, false);
    assert.equal(r.total, 0);
    assert.equal(r.matched, 0);
    assert.deepEqual(r.details, []);
  });

  test('details length equals steps length and preserves order/color', () => {
    const steps = [hit('blue'), miss('red'), { color: 'green', baseline: null, sample: BASE }, hit('green')];
    const r = judgeColorSteps(steps);
    assert.equal(r.details.length, steps.length);
    assert.deepEqual(r.details.map((d) => d.color), ['blue', 'red', 'green', 'green']);
    assert.equal(r.details[2].delta, null);
    assert.ok(Array.isArray(r.details[0].delta) && r.details[0].delta.length === 3);
  });
});

// ---------------------------------------------------------------------------
// checkTransition
// ---------------------------------------------------------------------------

describe('checkTransition', () => {
  const still = () => makeHand();

  test('returns { ok, reason, maxGapMs, maxJump, maxAngleJump }', () => {
    const r = checkTransition(framesFrom([still(), still(), still()]));
    for (const k of ['ok', 'reason', 'maxGapMs', 'maxJump', 'maxAngleJump']) {
      assert.ok(Object.hasOwn(r, k), `missing key ${k}`);
    }
    assert.equal(typeof r.ok, 'boolean');
    assert.equal(typeof r.maxGapMs, 'number');
    assert.equal(typeof r.maxJump, 'number');
    assert.equal(typeof r.maxAngleJump, 'number');
  });

  test('smooth gradual change → ok, reason null', () => {
    // 30 frames @33ms: translate 0.003/frame (1.5% of hand size), index bends 2.4°/frame.
    const list = [];
    for (let i = 0; i < 30; i++) list.push(makeHand({ index: 180 - i * 2.4 }, { dx: i * 0.003 }));
    const r = checkTransition(framesFrom(list, 33));
    assert.equal(r.ok, true, `reason: ${r.reason}`);
    assert.equal(r.reason, null);
  });

  test('failure has a non-empty string reason', () => {
    const r = checkTransition(framesFrom([still()]));
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0);
  });

  test('null gap of 250ms (first null t → next non-null t) → fail', () => {
    // non-null @0,50,100 ; null @150..350 ; non-null @400,450  → gap = 400 - 150 = 250
    const list = [still(), still(), still(), null, null, null, null, null, still(), still()];
    const r = checkTransition(framesFrom(list, 50));
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
  });

  test('null gap of 150ms → ok', () => {
    // non-null @0,50,100 ; null @150,200,250 ; non-null @300,350  → gap = 300 - 150 = 150
    const list = [still(), still(), still(), null, null, null, still(), still()];
    const r = checkTransition(framesFrom(list, 50));
    assert.equal(r.ok, true, `reason: ${r.reason}`);
    assert.equal(r.reason, null);
  });

  test('trailing nulls beyond maxGapMs (measured to last frame t) → fail', () => {
    // non-null @0,50,100 ; null @150..400 → 400 - 150 = 250 > 200
    const list = [still(), still(), still(), null, null, null, null, null, null];
    const r = checkTransition(framesFrom(list, 50));
    assert.equal(r.ok, false);
  });

  test('trailing nulls within maxGapMs → ok', () => {
    // non-null @0,50,100 ; null @150,200,250 → 250 - 150 = 100
    const list = [still(), still(), still(), null, null, null];
    const r = checkTransition(framesFrom(list, 50));
    assert.equal(r.ok, true, `reason: ${r.reason}`);
  });

  test('custom maxGapMs in opts is honored', () => {
    const list = [still(), still(), still(), null, null, null, null, null, still(), still()];
    const r = checkTransition(framesFrom(list, 50), { ...DEFAULTS, maxGapMs: 300 });
    assert.equal(r.ok, true, `reason: ${r.reason}`);
  });

  test('single-frame landmark teleport (shift by 1× hand size) → fail', () => {
    const list = [];
    for (let i = 0; i < 10; i++) list.push(i === 5 ? makeHand({}, { dx: HAND_SIZE }) : still());
    const r = checkTransition(framesFrom(list, 33));
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
  });

  test('teleport across an intervening null frame is not an adjacent pair → ok', () => {
    // Jump is only checked between adjacent non-null frames with no null between them.
    const list = [still(), still(), null, makeHand({}, { dx: HAND_SIZE }), makeHand({}, { dx: HAND_SIZE })];
    const r = checkTransition(framesFrom(list, 50));
    assert.equal(r.ok, true, `reason: ${r.reason}`);
  });

  test('single-frame finger angle jump > 70° (index straight → bent) → fail', () => {
    // Bend is into z, so 2D motion is 0.06 / 0.2 = 0.3 of hand size (< 0.5): isolates the angle rule.
    const list = [];
    for (let i = 0; i < 10; i++) list.push(i === 5 ? makeHand({ index: 90 }) : still());
    const r = checkTransition(framesFrom(list, 33));
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
  });

  test('single-frame finger angle change of 60° (< 70°) → ok', () => {
    const list = [];
    for (let i = 0; i < 10; i++) list.push(i >= 5 ? makeHand({ index: 120 }) : still());
    const r = checkTransition(framesFrom(list, 33));
    assert.equal(r.ok, true, `reason: ${r.reason}`);
  });

  test('fewer than 2 non-null frames → fail', () => {
    assert.equal(checkTransition([]).ok, false, 'empty');
    assert.equal(checkTransition(framesFrom([still()])).ok, false, 'single frame');
    assert.equal(checkTransition(framesFrom([null, still(), null], 30)).ok, false, 'one non-null among nulls');
    assert.equal(checkTransition(framesFrom([null, null], 30)).ok, false, 'all null');
  });

  // The contract lists maxGapMs / maxJump / maxAngleJump as return keys without defining them.
  // These tests assume they report the measured maxima (see ambiguity notes).
  describe('reported metrics (assumes measured maxima)', () => {
    test('maxGapMs reports the longest null gap', () => {
      const list = [still(), still(), still(), null, null, null, null, null, still(), still()];
      approx(checkTransition(framesFrom(list, 50)).maxGapMs, 250, 1e-9);
      const list2 = [still(), still(), still(), null, null, null, still(), still()];
      approx(checkTransition(framesFrom(list2, 50)).maxGapMs, 150, 1e-9);
    });

    test('maxJump reports the max landmark displacement / hand size', () => {
      const list = [still(), makeHand({}, { dx: HAND_SIZE }), makeHand({}, { dx: HAND_SIZE })];
      approx(checkTransition(framesFrom(list, 33)).maxJump, 1, 1e-6);
    });

    test('maxAngleJump reports the max finger angle change in degrees', () => {
      const list = [still(), makeHand({ index: 90 }), makeHand({ index: 90 })];
      approx(checkTransition(framesFrom(list, 33)).maxAngleJump, 90, 1e-4);
    });
  });
});

// ---------------------------------------------------------------------------
// finalVerdict
// ---------------------------------------------------------------------------

describe('finalVerdict', () => {
  const colorOk = () => ({ passed: true, matched: 3, total: 3, details: [] });
  const colorBad = () => ({ passed: false, matched: 1, total: 3, details: [] });
  const good = () => ({
    poses: [
      { name: 'peace', matched: true },
      { name: 'fist', matched: true },
      { name: 'rock', matched: true },
    ],
    transitions: [
      { ok: true, reason: null },
      { ok: true, reason: null },
    ],
    colorHand: colorOk(),
    colorFace: colorOk(),
  });

  function assertFailed(r) {
    assert.equal(r.passed, false);
    assert.ok(Array.isArray(r.reasons));
    assert.ok(r.reasons.length >= 1, 'at least one reason');
    for (const s of r.reasons) {
      assert.equal(typeof s, 'string');
      assert.ok(s.length > 0, 'non-empty reason');
      assert.match(s, /[가-힣]/, `reason should be Korean: ${s}`);
    }
  }

  test('all good → passed true, reasons []', () => {
    const r = finalVerdict(good());
    assert.equal(r.passed, true);
    assert.deepEqual(r.reasons, []);
  });

  test('one pose not matched → fail', () => {
    const input = good();
    input.poses[1].matched = false;
    assertFailed(finalVerdict(input));
  });

  test('one transition not ok → fail', () => {
    const input = good();
    input.transitions[0] = { ok: false, reason: 'gap' };
    assertFailed(finalVerdict(input));
  });

  test('colorHand not passed → fail', () => {
    const input = good();
    input.colorHand = colorBad();
    assertFailed(finalVerdict(input));
  });

  test('colorFace not passed → fail', () => {
    const input = good();
    input.colorFace = colorBad();
    assertFailed(finalVerdict(input));
  });

  test('two different failing conditions → at least two reasons', () => {
    const input = good();
    input.colorHand = colorBad();
    input.colorFace = colorBad();
    const r = finalVerdict(input);
    assertFailed(r);
    assert.ok(r.reasons.length >= 2, `expected >= 2 reasons, got ${r.reasons.length}`);
  });

  test('works with real judgeColorSteps results', () => {
    const base = [100, 100, 100];
    const pass = judgeColorSteps([
      { color: 'red', baseline: base, sample: [140, 100, 100] },
      { color: 'green', baseline: base, sample: [100, 140, 100] },
      { color: 'blue', baseline: base, sample: [100, 100, 140] },
    ]);
    const fail = judgeColorSteps([]);
    assert.equal(finalVerdict({ ...good(), colorHand: pass, colorFace: pass }).passed, true);
    assertFailed(finalVerdict({ ...good(), colorHand: pass, colorFace: fail }));
  });
});
