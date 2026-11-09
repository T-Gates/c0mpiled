// Unit tests for the v1.3 "4분할 빛 입체 판정" additions to src/judge.js,
// written against CONTRACT.md only (not the implementation).
// Run: node --test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { QUAD_DEFAULTS, judgeQuadrants, finalVerdict } from '../src/judge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function approx(actual, expected, tol = 1e-9, msg = '') {
  assert.equal(typeof actual, 'number', `${msg} expected a number, got ${actual}`);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} expected ${expected} ± ${tol}, got ${actual}`,
  );
}

const LEFT_QUADS = new Set(['TL', 'BL']);
const TOP_QUADS = new Set(['TL', 'TR']);

// Build one step whose L/R depend on whether the lit quadrant is on the user's
// left, and T/B on whether it is on top.
function step(quad, { litL, litR, unlitL, unlitR, top = 100, bottom = 100, topLitT, topLitB, botLitT, botLitB }) {
  const left = LEFT_QUADS.has(quad);
  const isTop = TOP_QUADS.has(quad);
  const T = isTop ? (topLitT ?? top) : (botLitT ?? top);
  const B = isTop ? (topLitB ?? bottom) : (botLitB ?? bottom);
  return {
    quad,
    rois: {
      L: left ? litL : unlitL,
      R: left ? litR : unlitR,
      T,
      B,
    },
  };
}

// App-like sequence: two shuffled repetitions of the 4 quadrants (8 steps).
const SEQ8 = ['TR', 'BL', 'TL', 'BR', 'BL', 'TL', 'BR', 'TR'];
const SEQ4 = ['TL', 'TR', 'BL', 'BR'];

// "Real face": light from the left brightens the left cheek and vice versa.
function realFaceSteps(seq = SEQ8) {
  return seq.map((q) =>
    step(q, { litL: 120, litR: 80, unlitL: 80, unlitR: 120 }),
  );
}

const H_REAL = Math.log(120 / 80) - Math.log(80 / 120); // ≈ 0.811

// ---------------------------------------------------------------------------
// QUAD_DEFAULTS
// ---------------------------------------------------------------------------

describe('QUAD_DEFAULTS', () => {
  test('minSwingH is 0.05', () => {
    assert.equal(QUAD_DEFAULTS.minSwingH, 0.05);
  });
});

// ---------------------------------------------------------------------------
// judgeQuadrants
// ---------------------------------------------------------------------------

describe('judgeQuadrants', () => {
  test('return shape: { passed, H, V, details }', () => {
    const r = judgeQuadrants(realFaceSteps());
    assert.equal(typeof r.passed, 'boolean');
    assert.ok('H' in r);
    assert.ok('V' in r);
    assert.ok(Array.isArray(r.details));
  });

  test('real face (8 steps, 2×4 quads): H = ln(1.5) − ln(1/1.5) ≈ 0.811 → passed', () => {
    const r = judgeQuadrants(realFaceSteps(SEQ8));
    approx(r.H, H_REAL, 1e-9, 'H');
    approx(r.H, 0.811, 1e-3, 'H (rounded)');
    assert.equal(r.passed, true);
  });

  test('real face (4 steps) → passed, same H', () => {
    const r = judgeQuadrants(realFaceSteps(SEQ4));
    approx(r.H, H_REAL, 1e-9, 'H');
    assert.equal(r.passed, true);
  });

  test('default opts equal QUAD_DEFAULTS (omitting opts uses minSwingH 0.05)', () => {
    const steps = realFaceSteps();
    assert.deepEqual(judgeQuadrants(steps), judgeQuadrants(steps, QUAD_DEFAULTS));
  });

  test('per-step hx = ln(L/R), vy = ln(T/B)', () => {
    const steps = [
      { quad: 'TL', rois: { L: 120, R: 80, T: 90, B: 60 } },
      { quad: 'BR', rois: { L: 50, R: 100, T: 40, B: 80 } },
    ];
    const r = judgeQuadrants(steps);
    approx(r.details[0].hx, Math.log(120 / 80), 1e-12, 'hx[0]');
    approx(r.details[0].vy, Math.log(90 / 60), 1e-12, 'vy[0]');
    approx(r.details[1].hx, Math.log(50 / 100), 1e-12, 'hx[1]');
    approx(r.details[1].vy, Math.log(40 / 80), 1e-12, 'vy[1]');
  });

  test('H uses group means (unequal per-step values averaged within group)', () => {
    const steps = [
      { quad: 'TL', rois: { L: 130, R: 100, T: 100, B: 100 } },
      { quad: 'BL', rois: { L: 110, R: 100, T: 100, B: 100 } },
      { quad: 'TL', rois: { L: 120, R: 100, T: 100, B: 100 } },
      { quad: 'TR', rois: { L: 100, R: 125, T: 100, B: 100 } },
      { quad: 'BR', rois: { L: 100, R: 105, T: 100, B: 100 } },
    ];
    const leftMean = (Math.log(1.3) + Math.log(1.1) + Math.log(1.2)) / 3;
    const rightMean = (Math.log(100 / 125) + Math.log(100 / 105)) / 2;
    const r = judgeQuadrants(steps);
    approx(r.H, leftMean - rightMean, 1e-12, 'H');
    assert.equal(r.passed, true);
  });

  test('flat paper: identical L/R ratio across quads → H = 0 → not passed', () => {
    const steps = SEQ8.map((q) => ({ quad: q, rois: { L: 101, R: 100, T: 100, B: 100 } }));
    const r = judgeQuadrants(steps);
    approx(r.H, 0, 1e-12, 'H');
    assert.equal(r.passed, false);
  });

  test('flat paper: tiny swing (101/100 vs 100/101) → H ≈ 0.0199 < 0.05 → not passed', () => {
    const steps = SEQ8.map((q) =>
      step(q, { litL: 101, litR: 100, unlitL: 100, unlitR: 101 }),
    );
    const r = judgeQuadrants(steps);
    approx(r.H, 2 * Math.log(1.01), 1e-12, 'H');
    assert.ok(r.H < QUAD_DEFAULTS.minSwingH);
    assert.equal(r.passed, false);
  });

  test('reversed (left-lit brightens R) → H negative → not passed', () => {
    const steps = SEQ8.map((q) =>
      step(q, { litL: 80, litR: 120, unlitL: 120, unlitR: 80 }),
    );
    const r = judgeQuadrants(steps);
    approx(r.H, -H_REAL, 1e-9, 'H');
    assert.ok(r.H < 0);
    assert.equal(r.passed, false);
  });

  test('V = mean(vy | TL,TR) − mean(vy | BL,BR)', () => {
    const steps = SEQ8.map((q) =>
      step(q, {
        litL: 100, litR: 100, unlitL: 100, unlitR: 100,
        topLitT: 150, topLitB: 100, botLitT: 100, botLitB: 150,
      }),
    );
    const r = judgeQuadrants(steps);
    approx(r.V, Math.log(1.5) - Math.log(100 / 150), 1e-12, 'V');
  });

  test('huge V but H below threshold → not passed (V does not affect verdict)', () => {
    const steps = SEQ8.map((q) =>
      step(q, {
        litL: 100, litR: 100, unlitL: 100, unlitR: 100,
        topLitT: 250, topLitB: 50, botLitT: 50, botLitB: 250,
      }),
    );
    const r = judgeQuadrants(steps);
    assert.ok(r.V > 3, `V should be large, got ${r.V}`);
    approx(r.H, 0, 1e-12, 'H');
    assert.equal(r.passed, false);
  });

  test('H above threshold with negative V → passed (V does not affect verdict)', () => {
    const steps = SEQ8.map((q) =>
      step(q, {
        litL: 120, litR: 80, unlitL: 80, unlitR: 120,
        topLitT: 50, topLitB: 250, botLitT: 250, botLitB: 50,
      }),
    );
    const r = judgeQuadrants(steps);
    assert.ok(r.V < 0, `V should be negative, got ${r.V}`);
    approx(r.H, H_REAL, 1e-9, 'H');
    assert.equal(r.passed, true);
  });

  test('details preserve length, order, and quad', () => {
    const steps = realFaceSteps(SEQ8);
    const r = judgeQuadrants(steps);
    assert.equal(r.details.length, 8);
    assert.deepEqual(r.details.map((d) => d.quad), SEQ8);
    for (const d of r.details) {
      assert.ok('hx' in d);
      assert.ok('vy' in d);
    }
  });

  test('empty steps → passed false, H null, V null, details []', () => {
    const r = judgeQuadrants([]);
    assert.equal(r.passed, false);
    assert.equal(r.H, null);
    assert.equal(r.V, null);
    assert.deepEqual(r.details, []);
  });

  // ---- null handling ----

  test('rois null → hx and vy null in details, step excluded from H/V', () => {
    const steps = realFaceSteps(SEQ8);
    steps.push({ quad: 'TL', rois: null });
    steps.push({ quad: 'BR', rois: null });
    const r = judgeQuadrants(steps);
    assert.equal(r.details.length, 10);
    assert.equal(r.details[8].quad, 'TL');
    assert.equal(r.details[8].hx, null);
    assert.equal(r.details[8].vy, null);
    assert.equal(r.details[9].quad, 'BR');
    assert.equal(r.details[9].hx, null);
    assert.equal(r.details[9].vy, null);
    approx(r.H, H_REAL, 1e-9, 'H (nulls excluded)');
    assert.equal(r.passed, true);
  });

  test('L or R null → hx null (vy still computed)', () => {
    const r = judgeQuadrants([
      { quad: 'TL', rois: { L: null, R: 100, T: 120, B: 100 } },
      { quad: 'TR', rois: { L: 100, R: null, T: 120, B: 100 } },
    ]);
    assert.equal(r.details[0].hx, null);
    assert.equal(r.details[1].hx, null);
    approx(r.details[0].vy, Math.log(1.2), 1e-12, 'vy[0]');
    approx(r.details[1].vy, Math.log(1.2), 1e-12, 'vy[1]');
  });

  test('L or R <= 0 → hx null', () => {
    const r = judgeQuadrants([
      { quad: 'TL', rois: { L: 0, R: 100, T: 100, B: 100 } },
      { quad: 'BL', rois: { L: 100, R: 0, T: 100, B: 100 } },
      { quad: 'TR', rois: { L: -5, R: 100, T: 100, B: 100 } },
      { quad: 'BR', rois: { L: 100, R: -1, T: 100, B: 100 } },
    ]);
    for (const d of r.details) assert.equal(d.hx, null, `hx for ${d.quad}`);
    assert.equal(r.H, null);
    assert.equal(r.passed, false);
  });

  test('T or B null or <= 0 → vy null (hx still computed)', () => {
    const r = judgeQuadrants([
      { quad: 'TL', rois: { L: 120, R: 80, T: null, B: 100 } },
      { quad: 'TR', rois: { L: 80, R: 120, T: 100, B: null } },
      { quad: 'BL', rois: { L: 120, R: 80, T: 0, B: 100 } },
      { quad: 'BR', rois: { L: 80, R: 120, T: 100, B: -3 } },
    ]);
    for (const d of r.details) assert.equal(d.vy, null, `vy for ${d.quad}`);
    approx(r.details[0].hx, Math.log(1.5), 1e-12, 'hx[0]');
    assert.equal(r.V, null);
    approx(r.H, H_REAL, 1e-9, 'H');
    assert.equal(r.passed, true, 'V null must not block a passing H');
  });

  test('only left-group (TL,BL) has valid hx → H null, passed false', () => {
    const r = judgeQuadrants([
      { quad: 'TL', rois: { L: 200, R: 50, T: 100, B: 100 } },
      { quad: 'BL', rois: { L: 200, R: 50, T: 100, B: 100 } },
      { quad: 'TR', rois: null },
      { quad: 'BR', rois: { L: null, R: 100, T: 100, B: 100 } },
    ]);
    assert.equal(r.H, null);
    assert.equal(r.passed, false);
  });

  test('only right-group (TR,BR) has valid hx → H null, passed false', () => {
    const r = judgeQuadrants([
      { quad: 'TR', rois: { L: 50, R: 200, T: 100, B: 100 } },
      { quad: 'BR', rois: { L: 50, R: 200, T: 100, B: 100 } },
      { quad: 'TL', rois: { L: 100, R: 0, T: 100, B: 100 } },
    ]);
    assert.equal(r.H, null);
    assert.equal(r.passed, false);
  });

  test('only top-group (TL,TR) has valid vy → V null (H unaffected)', () => {
    const r = judgeQuadrants([
      { quad: 'TL', rois: { L: 120, R: 80, T: 150, B: 100 } },
      { quad: 'TR', rois: { L: 80, R: 120, T: 150, B: 100 } },
      { quad: 'BL', rois: { L: 120, R: 80, T: null, B: 100 } },
      { quad: 'BR', rois: { L: 80, R: 120, T: 100, B: 0 } },
    ]);
    assert.equal(r.V, null);
    approx(r.H, H_REAL, 1e-9, 'H');
    assert.equal(r.passed, true);
  });

  test('only bottom-group (BL,BR) has valid vy → V null', () => {
    const r = judgeQuadrants([
      { quad: 'BL', rois: { L: 120, R: 80, T: 100, B: 150 } },
      { quad: 'BR', rois: { L: 80, R: 120, T: 100, B: 150 } },
      { quad: 'TL', rois: null },
    ]);
    assert.equal(r.V, null);
  });

  test('all rois null → H null, V null, passed false, details all null', () => {
    const steps = SEQ8.map((q) => ({ quad: q, rois: null }));
    const r = judgeQuadrants(steps);
    assert.equal(r.H, null);
    assert.equal(r.V, null);
    assert.equal(r.passed, false);
    assert.equal(r.details.length, 8);
    for (const d of r.details) {
      assert.equal(d.hx, null);
      assert.equal(d.vy, null);
    }
  });

  // ---- threshold / opts ----

  test('custom opts.minSwingH is honored (above H → fail, below H → pass)', () => {
    const steps = realFaceSteps();
    assert.equal(judgeQuadrants(steps, { minSwingH: 1.0 }).passed, false);
    assert.equal(judgeQuadrants(steps, { minSwingH: 0.5 }).passed, true);

    const paper = SEQ8.map((q) => step(q, { litL: 101, litR: 100, unlitL: 100, unlitR: 101 }));
    assert.equal(judgeQuadrants(paper).passed, false);
    assert.equal(judgeQuadrants(paper, { minSwingH: 0.01 }).passed, true);
  });

  test('threshold is strict: H === minSwingH → not passed', () => {
    const steps = realFaceSteps();
    const { H } = judgeQuadrants(steps);
    assert.equal(judgeQuadrants(steps, { minSwingH: H }).passed, false);
  });
});

// ---------------------------------------------------------------------------
// finalVerdict — backward compatibility & quadFace
// ---------------------------------------------------------------------------

describe('finalVerdict with quadFace', () => {
  const colorOk = () => ({ passed: true, matched: 3, total: 3, details: [] });
  const colorBad = () => ({ passed: false, matched: 1, total: 3, details: [] });
  const base = () => ({
    poses: [
      { name: 'peace', matched: true },
      { name: 'fist', matched: true },
      { name: 'rock', matched: true },
    ],
    transitions: [],
    colorHand: colorOk(),
    colorFace: colorOk(),
  });
  const quadOk = () => ({ passed: true, H: 0.811, V: 0.1, details: [] });
  const quadBad = () => ({ passed: false, H: 0.01, V: 0.1, details: [] });
  const HANGUL = /[가-힣]/;

  test('without quadFace: all-good → passed true, reasons []', () => {
    const r = finalVerdict(base());
    assert.equal(r.passed, true);
    assert.deepEqual(r.reasons, []);
  });

  test('without quadFace: failing colorFace still fails as before', () => {
    const input = base();
    input.colorFace = colorBad();
    const r = finalVerdict(input);
    assert.equal(r.passed, false);
    assert.ok(r.reasons.length >= 1);
  });

  test('quadFace passed true + all-good → passed true, reasons []', () => {
    const r = finalVerdict({ ...base(), quadFace: quadOk() });
    assert.equal(r.passed, true);
    assert.deepEqual(r.reasons, []);
  });

  test('quadFace passed false + all-good → passed false, exactly one Korean reason', () => {
    const without = finalVerdict(base());
    const r = finalVerdict({ ...base(), quadFace: quadBad() });
    assert.equal(r.passed, false);
    assert.equal(r.reasons.length, without.reasons.length + 1);
    assert.equal(r.reasons.length, 1);
    assert.equal(typeof r.reasons[0], 'string');
    assert.match(r.reasons[0], HANGUL);
  });

  test('quadFace with H null (passed false) → passed false, one reason', () => {
    const r = finalVerdict({ ...base(), quadFace: { passed: false, H: null, V: null, details: [] } });
    assert.equal(r.passed, false);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0], HANGUL);
  });

  test('quadFace failure adds exactly one reason on top of other failures', () => {
    const input = base();
    input.colorHand = colorBad();
    const without = finalVerdict(input);
    const r = finalVerdict({ ...input, quadFace: quadBad() });
    assert.equal(without.passed, false);
    assert.equal(r.passed, false);
    assert.equal(r.reasons.length, without.reasons.length + 1);
  });

  test('quadFace passed true does not mask other failures', () => {
    const input = base();
    input.poses[0].matched = false;
    const without = finalVerdict(input);
    const r = finalVerdict({ ...input, quadFace: quadOk() });
    assert.equal(r.passed, false);
    assert.deepEqual(r.reasons, without.reasons);
  });

  test('real judgeQuadrants output wires into finalVerdict', () => {
    const good = finalVerdict({ ...base(), quadFace: judgeQuadrants(realFaceSteps()) });
    assert.equal(good.passed, true);
    assert.deepEqual(good.reasons, []);

    const paperSteps = SEQ8.map((q) => ({ quad: q, rois: { L: 100, R: 100, T: 100, B: 100 } }));
    const bad = finalVerdict({ ...base(), quadFace: judgeQuadrants(paperSteps) });
    assert.equal(bad.passed, false);
    assert.equal(bad.reasons.length, 1);
  });
});
