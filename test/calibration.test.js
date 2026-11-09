// Unit tests for the v1.4 "데이터 수집·기준값 보정" pure functions in src/judge.js,
// written against CONTRACT.md only (not the implementation).
// Run: node --test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  QUAD_DEFAULTS,
  judgeColorSteps,
  judgeQuadrants,
  roundFeatures,
  stepTargetDeltas,
  bestThreshold,
} from '../src/judge.js';

// ---------------------------------------------------------------------------
// Helpers (independent reference implementations of contract formulas)
// ---------------------------------------------------------------------------

function approx(actual, expected, tol = 1e-9, msg = '') {
  assert.equal(typeof actual, 'number', `${msg} expected a number, got ${actual}`);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} expected ${expected} ± ${tol}, got ${actual}`,
  );
}

// chroma per contract: [R/S, G/S, B/S], S===0 → [1/3,1/3,1/3]
function chromaRef([r, g, b]) {
  const s = r + g + b;
  if (s === 0) return [1 / 3, 1 / 3, 1 / 3];
  return [r / s, g / s, b / s];
}

const TARGET = { red: 0, green: 1, blue: 2 };

function targetDeltaRef(step) {
  const t = TARGET[step.color];
  return chromaRef(step.sample)[t] - chromaRef(step.baseline)[t];
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const WHITE = [200, 200, 200];

// ---------------------------------------------------------------------------
// stepTargetDeltas
// ---------------------------------------------------------------------------

describe('stepTargetDeltas', () => {
  test('red/green/blue steps produce the target-channel Δ', () => {
    const steps = [
      { color: 'red', baseline: WHITE, sample: [240, 190, 180] },
      { color: 'green', baseline: [180, 200, 210], sample: [170, 250, 200] },
      { color: 'blue', baseline: [210, 200, 190], sample: [190, 190, 260] },
    ];
    const out = stepTargetDeltas(steps);
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 3);
    steps.forEach((s, i) => approx(out[i], targetDeltaRef(s), 1e-12, `step ${i} (${s.color})`));
    // sanity: these were constructed so each target Δ is positive
    out.forEach((v) => assert.ok(v > 0));
  });

  test('uses the TARGET channel, not the max channel (negative Δ kept as-is)', () => {
    // green step, but the sample is red-shifted → green-channel Δ is negative
    const steps = [{ color: 'green', baseline: WHITE, sample: [260, 180, 180] }];
    const out = stepTargetDeltas(steps);
    assert.equal(out.length, 1);
    const expected = targetDeltaRef(steps[0]);
    assert.ok(expected < 0);
    approx(out[0], expected, 1e-12);
  });

  test('invalid steps (null baseline or null sample) are skipped, order preserved', () => {
    const steps = [
      { color: 'blue', baseline: WHITE, sample: [180, 190, 250] }, // valid #1
      { color: 'red', baseline: null, sample: [250, 180, 180] }, // skip
      { color: 'green', baseline: WHITE, sample: null }, // skip
      { color: 'red', baseline: [190, 200, 210], sample: [255, 190, 200] }, // valid #2
      { color: 'green', baseline: null, sample: null }, // skip
      { color: 'green', baseline: [205, 200, 195], sample: [190, 240, 190] }, // valid #3
    ];
    const out = stepTargetDeltas(steps);
    assert.equal(out.length, 3);
    approx(out[0], targetDeltaRef(steps[0]), 1e-12, 'valid #1 (blue)');
    approx(out[1], targetDeltaRef(steps[3]), 1e-12, 'valid #2 (red)');
    approx(out[2], targetDeltaRef(steps[5]), 1e-12, 'valid #3 (green)');
    out.forEach((v) => assert.equal(typeof v, 'number'));
  });

  test('all steps invalid → []', () => {
    const out = stepTargetDeltas([
      { color: 'red', baseline: null, sample: [1, 2, 3] },
      { color: 'blue', baseline: [1, 2, 3], sample: null },
    ]);
    assert.deepEqual(out, []);
  });

  test('empty → []', () => {
    assert.deepEqual(stepTargetDeltas([]), []);
  });
});

// ---------------------------------------------------------------------------
// roundFeatures
// ---------------------------------------------------------------------------

describe('roundFeatures', () => {
  // Hand: three valid steps with strong target Δ (all should match under DEFAULTS).
  const handSteps = [
    { color: 'red', baseline: WHITE, sample: [255, 180, 180] },
    { color: 'green', baseline: WHITE, sample: [180, 255, 180] },
    { color: 'blue', baseline: WHITE, sample: [180, 180, 255] },
  ];
  // Face: one invalid step, one matching, one non-matching (tiny Δ below minDelta).
  const faceSteps = [
    { color: 'red', baseline: null, sample: [255, 180, 180] },
    { color: 'green', baseline: WHITE, sample: [190, 240, 190] },
    { color: 'blue', baseline: WHITE, sample: [200, 200, 201] },
  ];
  const quadSteps = [
    { quad: 'TL', rois: { L: 120, R: 100, T: 110, B: 100 } },
    { quad: 'TR', rois: { L: 100, R: 120, T: 110, B: 100 } },
    { quad: 'BL', rois: { L: 118, R: 100, T: 100, B: 112 } },
    { quad: 'BR', rois: { L: 100, R: 117, T: 100, B: 111 } },
    { quad: 'TL', rois: null },
    { quad: 'BR', rois: { L: null, R: 100, T: 100, B: 0 } },
  ];

  test('returns all six feature keys', () => {
    const f = roundFeatures({ handSteps, faceSteps, quadSteps });
    for (const k of ['handDeltaMean', 'faceDeltaMean', 'handMatchRatio', 'faceMatchRatio', 'H', 'V']) {
      assert.ok(k in f, `missing key ${k}`);
    }
  });

  test('handDeltaMean / faceDeltaMean = mean of valid target-channel Δ', () => {
    const f = roundFeatures({ handSteps, faceSteps, quadSteps });
    approx(f.handDeltaMean, mean(handSteps.map(targetDeltaRef)), 1e-12, 'handDeltaMean');
    // face: first step invalid → mean over steps[1], steps[2] only
    approx(
      f.faceDeltaMean,
      mean([targetDeltaRef(faceSteps[1]), targetDeltaRef(faceSteps[2])]),
      1e-12,
      'faceDeltaMean',
    );
    // consistent with stepTargetDeltas
    approx(f.handDeltaMean, mean(stepTargetDeltas(handSteps)), 1e-12);
    approx(f.faceDeltaMean, mean(stepTargetDeltas(faceSteps)), 1e-12);
  });

  test('handMatchRatio / faceMatchRatio = matched/total of judgeColorSteps(…, DEFAULTS)', () => {
    const f = roundFeatures({ handSteps, faceSteps, quadSteps });
    const jh = judgeColorSteps(handSteps, DEFAULTS);
    const jf = judgeColorSteps(faceSteps, DEFAULTS);
    approx(f.handMatchRatio, jh.matched / jh.total, 1e-12, 'handMatchRatio');
    approx(f.faceMatchRatio, jf.matched / jf.total, 1e-12, 'faceMatchRatio');
    // sanity on the synthetic data: all hand steps match
    approx(f.handMatchRatio, 1, 1e-12);
    assert.ok(f.faceMatchRatio < 1, 'face has a non-matching step');
  });

  test('H, V equal judgeQuadrants(quadSteps, QUAD_DEFAULTS).H / .V', () => {
    const f = roundFeatures({ handSteps, faceSteps, quadSteps });
    const q = judgeQuadrants(quadSteps, QUAD_DEFAULTS);
    assert.equal(typeof q.H, 'number');
    assert.equal(typeof q.V, 'number');
    approx(f.H, q.H, 1e-12, 'H');
    approx(f.V, q.V, 1e-12, 'V');
  });

  test('H computed, V null when only top quadrants present (mirrors judgeQuadrants)', () => {
    const qs = [
      { quad: 'TL', rois: { L: 120, R: 100, T: 100, B: 100 } },
      { quad: 'TR', rois: { L: 100, R: 120, T: 100, B: 100 } },
    ];
    const f = roundFeatures({ handSteps, faceSteps, quadSteps: qs });
    const q = judgeQuadrants(qs, QUAD_DEFAULTS);
    approx(f.H, 2 * Math.log(1.2), 1e-12, 'H');
    approx(f.H, q.H, 1e-12);
    assert.equal(f.V, null);
    assert.equal(q.V, null);
  });

  test('empty quadSteps → H null, V null', () => {
    const f = roundFeatures({ handSteps, faceSteps, quadSteps: [] });
    assert.equal(f.H, null);
    assert.equal(f.V, null);
  });

  test('no valid color steps → DeltaMean null; MatchRatio follows judgeColorSteps', () => {
    const invalid = [
      { color: 'red', baseline: null, sample: [255, 0, 0] },
      { color: 'green', baseline: WHITE, sample: null },
    ];
    const f = roundFeatures({ handSteps: invalid, faceSteps: invalid, quadSteps });
    assert.equal(f.handDeltaMean, null);
    assert.equal(f.faceDeltaMean, null);
    const j = judgeColorSteps(invalid, DEFAULTS);
    const expectedRatio = j.total === 0 ? null : j.matched / j.total;
    assert.equal(f.handMatchRatio, expectedRatio);
    assert.equal(f.faceMatchRatio, expectedRatio);
  });

  test('empty color steps → DeltaMean null, MatchRatio null (total 0)', () => {
    const f = roundFeatures({ handSteps: [], faceSteps: [], quadSteps: [] });
    assert.equal(f.handDeltaMean, null);
    assert.equal(f.faceDeltaMean, null);
    assert.equal(f.handMatchRatio, null);
    assert.equal(f.faceMatchRatio, null);
    assert.equal(f.H, null);
    assert.equal(f.V, null);
  });
});

// ---------------------------------------------------------------------------
// bestThreshold
// ---------------------------------------------------------------------------

function rates(pos, neg, t) {
  const p = pos.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  const n = neg.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  const tpr = p.filter((v) => v > t).length / p.length;
  const tnr = n.filter((v) => !(v > t)).length / n.length;
  return { tpr, tnr };
}

function assertShape(r) {
  assert.ok(r && typeof r === 'object', `expected object, got ${r}`);
  for (const k of ['threshold', 'balancedAccuracy', 'tpr', 'tnr']) {
    assert.equal(typeof r[k], 'number', `${k} should be a number`);
  }
}

describe('bestThreshold', () => {
  test('perfectly separable → BA 1, tpr 1, tnr 1, threshold = midpoint of the gap', () => {
    const pos = [0.05, 0.06, 0.07];
    const neg = [0.0, 0.001, 0.002];
    const r = bestThreshold(pos, neg);
    assertShape(r);
    approx(r.balancedAccuracy, 1, 1e-12, 'balancedAccuracy');
    approx(r.tpr, 1, 1e-12, 'tpr');
    approx(r.tnr, 1, 1e-12, 'tnr');
    assert.ok(r.threshold > 0.002 && r.threshold < 0.05, `threshold ${r.threshold} not in (0.002, 0.05)`);
    approx(r.threshold, 0.026, 1e-9, 'threshold');
  });

  test('overlapping data → BA < 1, BA = (tpr+tnr)/2, rates use value > t', () => {
    const pos = [0.3, 0.5, 0.7, 0.9];
    const neg = [0.1, 0.4, 0.6];
    // Candidates: 0.1−1e-9, 0.2, 0.35, 0.45, 0.55, 0.65, 0.8, 0.9
    // BA:          .5      .667  .542  .708  .583  .75   .625  .5   → best t=0.65
    const r = bestThreshold(pos, neg);
    assertShape(r);
    assert.ok(r.balancedAccuracy < 1);
    approx(r.balancedAccuracy, (r.tpr + r.tnr) / 2, 1e-12, 'BA = (tpr+tnr)/2');
    const { tpr, tnr } = rates(pos, neg, r.threshold);
    approx(r.tpr, tpr, 1e-12, 'tpr from rule value > t');
    approx(r.tnr, tnr, 1e-12, 'tnr from rule value > t');
    approx(r.threshold, 0.65, 1e-9, 'threshold');
    approx(r.tpr, 0.5, 1e-12);
    approx(r.tnr, 1, 1e-12);
    approx(r.balancedAccuracy, 0.75, 1e-12);
  });

  test('a value exactly equal to t is classified as fake (strict >)', () => {
    const r = bestThreshold([1], [0.5, 1]);
    // values [0.5, 1]; candidates 0.5−1e-9, 0.75, 1
    // t=0.5−1e-9: tpr 1, tnr 0 → .5 ; t=0.75: tpr 1, tnr .5 → .75 ; t=1: tpr 0, tnr 1 → .5
    assertShape(r);
    approx(r.threshold, 0.75, 1e-9);
    approx(r.tpr, 1, 1e-12);
    approx(r.tnr, 0.5, 1e-12);
    approx(r.balancedAccuracy, 0.75, 1e-12);
  });

  test('null / NaN in inputs are ignored', () => {
    const clean = bestThreshold([0.05, 0.06, 0.07], [0.0, 0.001, 0.002]);
    const dirty = bestThreshold([null, 0.05, NaN, 0.06, 0.07, null], [NaN, 0.0, null, 0.001, 0.002]);
    assertShape(dirty);
    approx(dirty.threshold, clean.threshold, 1e-12, 'threshold');
    approx(dirty.balancedAccuracy, 1, 1e-12);
    approx(dirty.tpr, 1, 1e-12, 'tpr (null/NaN must not count in denominator)');
    approx(dirty.tnr, 1, 1e-12, 'tnr (null/NaN must not count in denominator)');
  });

  test('null / NaN ignored in the overlapping case too (denominators use valid count)', () => {
    const r = bestThreshold([0.3, null, 0.5, 0.7, NaN, 0.9], [0.1, NaN, 0.4, null, 0.6]);
    assertShape(r);
    approx(r.threshold, 0.65, 1e-9);
    approx(r.tpr, 0.5, 1e-12);
    approx(r.tnr, 1, 1e-12);
  });

  test('empty pos or empty neg → null', () => {
    assert.equal(bestThreshold([], [0.1, 0.2]), null);
    assert.equal(bestThreshold([0.1, 0.2], []), null);
    assert.equal(bestThreshold([], []), null);
  });

  test('pos or neg empty after filtering null/NaN → null', () => {
    assert.equal(bestThreshold([null, NaN], [0.1]), null);
    assert.equal(bestThreshold([0.1], [NaN, null, NaN]), null);
  });

  test('tie rule: equal max balanced accuracy → smaller t', () => {
    const pos = [10, 20];
    const neg = [0, 15];
    // values [0,10,15,20]; candidates −1e-9, 5, 12.5, 17.5, 20
    // t=−1e-9: tpr 1,  tnr 0  → .5
    // t=5:     tpr 1,  tnr .5 → .75   ← tie
    // t=12.5:  tpr .5, tnr .5 → .5
    // t=17.5:  tpr .5, tnr 1  → .75   ← tie
    // t=20:    tpr 0,  tnr 1  → .5
    const r = bestThreshold(pos, neg);
    assertShape(r);
    approx(r.balancedAccuracy, 0.75, 1e-12);
    approx(r.threshold, 5, 1e-9, 'smaller tied candidate must win');
    approx(r.tpr, 1, 1e-12);
    approx(r.tnr, 0.5, 1e-12);
  });

  test('tie rule is independent of input order', () => {
    const r = bestThreshold([20, 10], [15, 0]);
    assertShape(r);
    approx(r.threshold, 5, 1e-9);
  });

  test('all equal values (pos [1,1], neg [1,1]) → object, BA 0.5, smaller candidate (min − 1e-9)', () => {
    // values [1]; candidates: 1−1e-9 (tpr 1, tnr 0) and 1 (tpr 0, tnr 1) → both .5 → smaller wins
    const r = bestThreshold([1, 1], [1, 1]);
    assertShape(r);
    approx(r.balancedAccuracy, 0.5, 1e-12);
    approx(r.threshold, 1 - 1e-9, 1e-12, 'threshold');
    assert.ok(r.threshold < 1);
    approx(r.tpr, 1, 1e-12);
    approx(r.tnr, 0, 1e-12);
  });

  test('threshold is always one of the contract candidates', () => {
    const pos = [0.012, 0.02, 0.008, 0.03, 0.005];
    const neg = [0.001, 0.009, -0.002, 0.004, 0.0];
    const r = bestThreshold(pos, neg);
    assertShape(r);
    const vals = [...new Set([...pos, ...neg])].sort((a, b) => a - b);
    const cands = [vals[0] - 1e-9, vals[vals.length - 1]];
    for (let i = 0; i + 1 < vals.length; i++) cands.push((vals[i] + vals[i + 1]) / 2);
    assert.ok(
      cands.some((c) => Math.abs(c - r.threshold) <= 1e-12),
      `threshold ${r.threshold} is not a candidate`,
    );
    // and it is optimal with the smallest-t tie rule
    const scored = cands
      .map((t) => {
        const { tpr, tnr } = rates(pos, neg, t);
        return { t, ba: (tpr + tnr) / 2 };
      })
      .sort((a, b) => b.ba - a.ba || a.t - b.t);
    approx(r.threshold, scored[0].t, 1e-12, 'best candidate');
    approx(r.balancedAccuracy, scored[0].ba, 1e-12);
  });
});
