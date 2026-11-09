// Unit tests for the v1.5 "반사 패턴 진단" additions to src/judge.js
// (DIAG_DEFAULTS, diagnoseRound), written against CONTRACT.md only
// (not the implementation).
// Run: node --test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DIAG_DEFAULTS, diagnoseRound, judgeQuadrants } from '../src/judge.js';

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

const TARGET = { red: 0, green: 1, blue: 2 };
const BASE = [100, 100, 100]; // chroma = [1/3, 1/3, 1/3]

// Build a color step whose target-channel chroma delta is exactly `d`
// (up to float error) relative to a neutral [100,100,100] baseline.
// Only the target channel is raised, so for d > 0 the target delta is the
// largest of the three; d === 0 gives sample === baseline (Δ = [0,0,0]).
function colorStep(color, d) {
  const x = (300 * d) / (2 / 3 - d); // solves (100+x)/(300+x) = 1/3 + d
  const sample = [...BASE];
  sample[TARGET[color]] = 100 + x;
  return { color, baseline: [...BASE], sample };
}

function invalidColorStep(color) {
  return { color, baseline: null, sample: [120, 100, 100] };
}

// Hand + face color steps, one per color each, with the given target Δ.
// Pass `null` for a color to omit it entirely.
function colorSteps({ red = 0.03, green = 0.03, blue = 0.03 } = {}) {
  const handSteps = [];
  const faceSteps = [];
  for (const [c, d] of [['red', red], ['green', green], ['blue', blue]]) {
    if (d === null) continue;
    handSteps.push(colorStep(c, d));
    faceSteps.push(colorStep(c, d));
  }
  return { handSteps, faceSteps };
}

// One quadrant step with mean ROI luma Y = (L+R+T+B)/4.
// `swing` > 0 makes the lit side's cheek brighter: for left quads (TL, BL)
// L = Y+swing, R = Y-swing; for right quads (TR, BR) the reverse.
// swing = 0 → L/R ratio constant (flat object).
function quadStep(quad, Y, swing = 0) {
  const left = quad === 'TL' || quad === 'BL';
  return {
    quad,
    rois: {
      L: left ? Y + swing : Y - swing,
      R: left ? Y - swing : Y + swing,
      T: Y,
      B: Y,
    },
  };
}

// All four quadrants twice (8 steps, like the app), with per-quad luma.
function quadSteps(lumas, swing = 10) {
  const order = ['TL', 'TR', 'BL', 'BR'];
  const steps = [];
  for (let rep = 0; rep < 2; rep++) {
    for (const q of order) steps.push(quadStep(q, lumas[q], swing));
  }
  return steps;
}

const BALANCED = { TL: 120, TR: 120, BL: 120, BR: 120 };
// spread = 6/117 ≈ 0.051 (> 0.02), min BR ratio = 114/118 ≈ 0.966 (not blocked)
const VARIED = { TL: 120, TR: 118, BL: 116, BR: 114 };
// TL ratio = 100/120 ≈ 0.833 (< 0.92 → blocked)
const TL_BLOCKED = { TL: 100, TR: 120, BL: 120, BR: 120 };

function round({ colors, quads }) {
  return { ...colors, quadSteps: quads };
}

const HANGUL = /[가-힣]/;

function assertMessage(r) {
  assert.equal(typeof r.message, 'string');
  assert.ok(r.message.trim().length > 0, 'message must be non-empty');
  assert.ok(HANGUL.test(r.message), `message should be Korean, got "${r.message}"`);
}

// v1.5 보정: weakColors is always an array ([] when none).
function assertWeakColorsArray(r) {
  assert.ok(Array.isArray(r.evidence.weakColors), `weakColors must be an array for code ${r.code}, got ${r.evidence.weakColors}`);
}

// ---------------------------------------------------------------------------
// DIAG_DEFAULTS
// ---------------------------------------------------------------------------

describe('DIAG_DEFAULTS', () => {
  test('has the contract values', () => {
    assert.deepEqual(DIAG_DEFAULTS, {
      minDelta: 0.004,
      minSwingH: 0.05,
      quadSpreadMin: 0.02,
      blockDrop: 0.08,
      skewFactor: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// Sanity check of the synthetic step builders (guards the fixtures, not src)
// ---------------------------------------------------------------------------

describe('fixture sanity', () => {
  test('colorStep produces the requested target chroma delta', () => {
    for (const c of ['red', 'green', 'blue']) {
      const s = colorStep(c, 0.03);
      const S = s.sample[0] + s.sample[1] + s.sample[2];
      approx(s.sample[TARGET[c]] / S - 1 / 3, 0.03, 1e-12, c);
    }
  });
});

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

describe('diagnoseRound evidence', () => {
  test('evidence has all contract fields with the right shapes', () => {
    const r = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(BALANCED) }));
    assert.equal(typeof r.code, 'string');
    assertMessage(r);
    const e = r.evidence;
    assert.ok(e && typeof e === 'object');
    for (const k of ['colorStrength', 'quadLuma', 'quadSpread', 'quadMin', 'H', 'weakColors']) {
      assert.ok(Object.hasOwn(e, k), `evidence.${k} missing`);
    }
    assert.deepEqual(Object.keys(e.colorStrength).sort(), ['blue', 'green', 'red']);
    assert.deepEqual(Object.keys(e.quadLuma).sort(), ['BL', 'BR', 'TL', 'TR']);
  });

  test('colorStrength = mean target Δ over valid hand+face steps per color', () => {
    const handSteps = [colorStep('red', 0.02), colorStep('green', 0.01), invalidColorStep('red')];
    const faceSteps = [colorStep('red', 0.04), { color: 'green', baseline: [...BASE], sample: null }];
    const r = diagnoseRound({ handSteps, faceSteps, quadSteps: quadSteps(BALANCED) });
    approx(r.evidence.colorStrength.red, 0.03, 1e-12, 'red');
    approx(r.evidence.colorStrength.green, 0.01, 1e-12, 'green');
    assert.equal(r.evidence.colorStrength.blue, null, 'blue has no steps → null');
  });

  test('colorStrength[c] is null when every step of that color is invalid', () => {
    const handSteps = [colorStep('red', 0.03), invalidColorStep('green')];
    const faceSteps = [colorStep('blue', 0.03), { color: 'green', baseline: null, sample: null }];
    const r = diagnoseRound({ handSteps, faceSteps, quadSteps: quadSteps(BALANCED) });
    assert.equal(r.evidence.colorStrength.green, null);
    approx(r.evidence.colorStrength.red, 0.03, 1e-12);
    approx(r.evidence.colorStrength.blue, 0.03, 1e-12);
  });

  test('quadLuma averages (L+R+T+B)/4 over valid steps; excludes rois with null/0', () => {
    const qs = [
      { quad: 'TL', rois: { L: 110, R: 130, T: 120, B: 120 } }, // 120
      { quad: 'TL', rois: { L: 100, R: 100, T: 100, B: 100 } }, // 100
      { quad: 'TL', rois: { L: 500, R: 500, T: 0, B: 500 } }, // excluded (T=0)
      { quad: 'TR', rois: { L: 90, R: 110, T: 100, B: 100 } }, // 100
      { quad: 'TR', rois: { L: null, R: 900, T: 900, B: 900 } }, // excluded (L null)
      { quad: 'BL', rois: { L: 80, R: 80, T: 80, B: 80 } }, // 80
      { quad: 'BL', rois: null }, // excluded
      { quad: 'BR', rois: null }, // BR has no valid step
    ];
    const r = diagnoseRound({ ...colorSteps(), quadSteps: qs });
    approx(r.evidence.quadLuma.TL, 110, 1e-9, 'TL');
    approx(r.evidence.quadLuma.TR, 100, 1e-9, 'TR');
    approx(r.evidence.quadLuma.BL, 80, 1e-9, 'BL');
    assert.equal(r.evidence.quadLuma.BR, null, 'BR');
    // fewer than 4 non-null quadLuma → spread / min null
    assert.equal(r.evidence.quadSpread, null);
    assert.equal(r.evidence.quadMin, null);
  });

  test('quadSpread = (max−min)/mean and quadMin = {quad, ratio vs mean of other 3}', () => {
    const r = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(VARIED) }));
    approx(r.evidence.quadSpread, (120 - 114) / ((120 + 118 + 116 + 114) / 4), 1e-9, 'spread');
    assert.equal(r.evidence.quadMin.quad, 'BR');
    approx(r.evidence.quadMin.ratio, 114 / ((120 + 118 + 116) / 3), 1e-9, 'ratio');
  });

  test('H equals judgeQuadrants(quadSteps).H', () => {
    const qs = quadSteps(VARIED, 10);
    const r = diagnoseRound(round({ colors: colorSteps(), quads: qs }));
    const expectedH = judgeQuadrants(qs, { minSwingH: DIAG_DEFAULTS.minSwingH }).H;
    approx(r.evidence.H, expectedH, 1e-12);
    // hand-computed cross-check
    const hx = (Y, s) => Math.log((Y + s) / (Y - s));
    const left = (hx(120, 10) + hx(116, 10)) / 2;
    const right = (-hx(118, 10) + -hx(114, 10)) / 2;
    approx(r.evidence.H, left - right, 1e-12);
  });

  test('H is null when there are no quad steps', () => {
    const r = diagnoseRound({ ...colorSteps(), quadSteps: [] });
    assert.equal(r.evidence.H, null);
    assert.equal(r.evidence.quadSpread, null);
    assert.equal(r.evidence.quadMin, null);
  });
});

// ---------------------------------------------------------------------------
// codes
// ---------------------------------------------------------------------------

describe("diagnoseRound code 'insufficient'", () => {
  test('all color steps invalid and all quad rois null', () => {
    const r = diagnoseRound({
      handSteps: [invalidColorStep('red'), invalidColorStep('green')],
      faceSteps: [{ color: 'blue', baseline: [...BASE], sample: null }],
      quadSteps: [
        { quad: 'TL', rois: null },
        { quad: 'TR', rois: null },
        { quad: 'BL', rois: { L: null, R: null, T: null, B: null } },
        { quad: 'BR', rois: { L: 0, R: 100, T: 100, B: 100 } }, // not all > 0
      ],
    });
    assert.equal(r.code, 'insufficient');
    assertMessage(r);
    assert.deepEqual(r.evidence.colorStrength, { red: null, green: null, blue: null });
    assert.deepEqual(r.evidence.quadLuma, { TL: null, TR: null, BL: null, BR: null });
  });

  test('empty step arrays', () => {
    const r = diagnoseRound({ handSteps: [], faceSteps: [], quadSteps: [] });
    assert.equal(r.code, 'insufficient');
    assertMessage(r);
    assertWeakColorsArray(r);
    assert.deepEqual([...r.evidence.weakColors], []);
  });

  // v1.5 보정 rule 5: H === null → 'insufficient' (was flat_object)
  test('strong color but no quad data (H null) → insufficient', () => {
    const r = diagnoseRound({ ...colorSteps(), quadSteps: [] });
    assert.equal(r.evidence.H, null);
    assert.equal(r.code, 'insufficient');
    assertMessage(r);
  });

  test('strong color but every quad step invalid (H null) → insufficient', () => {
    const r = diagnoseRound({
      ...colorSteps(),
      quadSteps: ['TL', 'TR', 'BL', 'BR'].map((quad) => ({ quad, rois: null })),
    });
    assert.equal(r.evidence.H, null);
    assert.equal(r.code, 'insufficient');
  });

  test('H null insufficient message differs from the all-null insufficient message', () => {
    const allNull = diagnoseRound({ handSteps: [], faceSteps: [], quadSteps: [] });
    const noQuad = diagnoseRound({ ...colorSteps(), quadSteps: [] });
    assert.equal(allNull.code, 'insufficient');
    assert.equal(noQuad.code, 'insufficient');
    assert.notEqual(allNull.message, noQuad.message);
  });
});

describe("diagnoseRound code 'no_reflection'", () => {
  test('all color Δ = 0 and quad lumas equal (spread 0)', () => {
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0, green: 0, blue: 0 }),
      quads: quadSteps(BALANCED, 0),
    }));
    assert.equal(r.code, 'no_reflection');
    assertMessage(r);
    approx(r.evidence.quadSpread, 0, 1e-12);
  });

  test('color steps only (quadSpread null) and Δ ≈ 0', () => {
    const r = diagnoseRound({ ...colorSteps({ red: 0, green: 0, blue: 0 }), quadSteps: [] });
    assert.equal(r.code, 'no_reflection');
    assert.equal(r.evidence.quadSpread, null);
    assertMessage(r);
  });

  test('color Δ small but positive (≤ minDelta) with flat quads', () => {
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0.003, green: 0.002, blue: 0.001 }),
      quads: quadSteps(BALANCED, 0),
    }));
    assert.equal(r.code, 'no_reflection');
  });

  test('no valid color steps but quads present with spread 0', () => {
    const r = diagnoseRound({
      handSteps: [invalidColorStep('red')],
      faceSteps: [],
      quadSteps: quadSteps(BALANCED, 0),
    });
    assert.equal(r.code, 'no_reflection');
  });

  test('color Δ ≈ 0 but quad spread ≥ quadSpreadMin → not no_reflection', () => {
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0, green: 0, blue: 0 }),
      quads: quadSteps(VARIED, 10),
    }));
    assert.notEqual(r.code, 'no_reflection');
  });
});

// v1.5 보정 rule 4b
describe("diagnoseRound code 'weak_color'", () => {
  test('zero color reflection + strong quad reaction (spread ≥ min, good H, no block) → weak_color', () => {
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0, green: 0, blue: 0 }),
      quads: quadSteps(VARIED, 10),
    }));
    assert.equal(r.code, 'weak_color');
    assert.ok(r.evidence.H > DIAG_DEFAULTS.minSwingH);
    assert.ok(r.evidence.quadSpread >= DIAG_DEFAULTS.quadSpreadMin);
    assertMessage(r);
    assertWeakColorsArray(r);
  });

  test('small positive color Δ (all ≤ minDelta) + strong quad reaction → weak_color', () => {
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0.003, green: 0.002, blue: 0.001 }),
      quads: quadSteps(VARIED, 10),
    }));
    assert.equal(r.code, 'weak_color');
  });

  test('strongest color just above minDelta (0.01) is not weak_color', () => {
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0.01, green: 0.003, blue: 0.003 }),
      quads: quadSteps(VARIED, 10),
    }));
    assert.notEqual(r.code, 'weak_color');
    assert.equal(r.code, 'ok');
  });
});

describe("diagnoseRound code 'screen_blocked'", () => {
  test('TL much darker (ratio 0.833 < 0.92) with good color and H', () => {
    const r = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(TL_BLOCKED, 10) }));
    assert.equal(r.code, 'screen_blocked');
    assert.equal(r.evidence.quadMin.quad, 'TL');
    approx(r.evidence.quadMin.ratio, 100 / 120, 1e-9);
    assertMessage(r);
    assert.ok(r.message.includes('왼쪽 위'), `message should name 왼쪽 위: "${r.message}"`);
  });

  const QUAD_KO = { TL: '왼쪽 위', TR: '오른쪽 위', BL: '왼쪽 아래', BR: '오른쪽 아래' };
  for (const [q, ko] of Object.entries(QUAD_KO)) {
    test(`blocked quadrant ${q} is reported as ${ko}`, () => {
      const lumas = { TL: 120, TR: 120, BL: 120, BR: 120, [q]: 100 };
      const r = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(lumas, 10) }));
      assert.equal(r.code, 'screen_blocked');
      assert.equal(r.evidence.quadMin.quad, q);
      assert.ok(r.message.includes(ko), `message should include ${ko}: "${r.message}"`);
    });
  }

  test('boundary: ratio 0.95 (≥ 0.92) is not blocked', () => {
    const lumas = { TL: 114, TR: 120, BL: 120, BR: 120 }; // 114/120 = 0.95
    const r = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(lumas, 10) }));
    assert.notEqual(r.code, 'screen_blocked');
    assert.equal(r.code, 'ok');
    approx(r.evidence.quadMin.ratio, 0.95, 1e-9);
  });

  test('opts.blockDrop override (0.2) makes the 0.833 case not blocked', () => {
    const r = diagnoseRound(
      round({ colors: colorSteps(), quads: quadSteps(TL_BLOCKED, 10) }),
      { ...DIAG_DEFAULTS, blockDrop: 0.2 },
    );
    assert.notEqual(r.code, 'screen_blocked');
    assert.equal(r.code, 'ok');
  });

  // v1.5 보정: partial opts are merged with DIAG_DEFAULTS
  test('partial opts {blockDrop: 0.2} is merged with defaults', () => {
    const input = round({ colors: colorSteps(), quads: quadSteps(TL_BLOCKED, 10) });
    const r = diagnoseRound(input, { blockDrop: 0.2 });
    assert.equal(r.code, 'ok');
    assertMessage(r);
    // other thresholds still behave as defaults: flat quads with partial opts → flat_object
    const flat = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(VARIED, 0) }), { blockDrop: 0.2 });
    assert.equal(flat.code, 'flat_object');
    // and the color rules still use default minDelta/skewFactor
    const tampered = diagnoseRound(
      round({ colors: colorSteps({ red: 0.03, green: 0.03, blue: 0 }), quads: quadSteps(BALANCED, 10) }),
      { blockDrop: 0.2 },
    );
    assert.equal(tampered.code, 'color_tampered');
  });
});

describe("diagnoseRound code 'color_tampered'", () => {
  test('red/green Δ 0.03, blue Δ 0 → color_tampered with weakColors [blue]', () => {
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0.03, green: 0.03, blue: 0 }),
      quads: quadSteps(BALANCED, 10),
    }));
    assert.equal(r.code, 'color_tampered');
    assert.ok(Array.isArray(r.evidence.weakColors));
    assert.ok(r.evidence.weakColors.includes('blue'));
    assert.ok(!r.evidence.weakColors.includes('red'));
    assert.ok(!r.evidence.weakColors.includes('green'));
    assertMessage(r);
    assert.ok(r.message.includes('파랑'), `message should name 파랑: "${r.message}"`);
  });

  test('weak red is reported as 빨강', () => {
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0.001, green: 0.03, blue: 0.03 }),
      quads: quadSteps(BALANCED, 10),
    }));
    assert.equal(r.code, 'color_tampered');
    assert.deepEqual([...r.evidence.weakColors], ['red']);
    assert.ok(r.message.includes('빨강'));
  });

  test('null colors are not counted as weak', () => {
    // blue has no valid steps at all → colorStrength.blue null, not weak
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0.03, green: 0.03, blue: null }),
      quads: quadSteps(BALANCED, 10),
    }));
    assert.equal(r.evidence.colorStrength.blue, null);
    assert.notEqual(r.code, 'color_tampered');
    assert.equal(r.code, 'ok');
  });

  test('strongest color below minDelta × skewFactor is not tampered', () => {
    // max 0.01 < 0.004*3 = 0.012, blue weak
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0.01, green: 0.01, blue: 0 }),
      quads: quadSteps(BALANCED, 10),
    }));
    assert.notEqual(r.code, 'color_tampered');
    assert.equal(r.code, 'ok');
  });
});

describe("diagnoseRound code 'flat_object'", () => {
  test('good color, quad spread above min, no block, constant L/R ratio → H ≈ 0', () => {
    const r = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(VARIED, 0) }));
    assert.equal(r.code, 'flat_object');
    approx(r.evidence.H, 0, 1e-12);
    assert.ok(r.evidence.quadSpread >= DIAG_DEFAULTS.quadSpreadMin);
    assertMessage(r);
  });

  test('good color but no quad data (H null) → insufficient, not flat_object (v1.5 보정)', () => {
    const r = diagnoseRound({ ...colorSteps(), quadSteps: [] });
    assert.equal(r.evidence.H, null);
    assert.notEqual(r.code, 'flat_object');
    assert.equal(r.code, 'insufficient');
  });

  test('H exactly 0 (≤ minSwingH) is flat_object, not insufficient', () => {
    const r = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(VARIED, 0) }));
    assert.equal(typeof r.evidence.H, 'number');
    assert.equal(r.code, 'flat_object');
  });

  test('opts.minSwingH override: small H passes when threshold lowered', () => {
    // swing 1 on Y≈117 → H ≈ 2*ln(121/119)... ≈ 0.034 (< 0.05 default)
    const qs = quadSteps(VARIED, 1);
    const H = judgeQuadrants(qs, { minSwingH: 0.05 }).H;
    assert.ok(H > 0.01 && H < 0.05, `fixture H should be in (0.01, 0.05), got ${H}`);
    const base = round({ colors: colorSteps(), quads: qs });
    assert.equal(diagnoseRound(base).code, 'flat_object');
    assert.equal(diagnoseRound(base, { ...DIAG_DEFAULTS, minSwingH: 0.01 }).code, 'ok');
  });
});

describe("diagnoseRound code 'ok'", () => {
  test('good color, L brighter under left-lit, R brighter under right-lit, balanced quads', () => {
    const r = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(BALANCED, 10) }));
    assert.equal(r.code, 'ok');
    assert.ok(r.evidence.H > DIAG_DEFAULTS.minSwingH);
    assertMessage(r);
  });

  test('ok with varied (but unblocked) quads', () => {
    const r = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(VARIED, 10) }));
    assert.equal(r.code, 'ok');
  });
});

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

describe('diagnoseRound ordering', () => {
  test('no_reflection before screen_blocked (quadSpreadMin raised so both conditions hold)', () => {
    // spread = 20/115 ≈ 0.174 < 0.5, TL ratio 0.833 < 0.92
    const r = diagnoseRound(
      round({ colors: colorSteps({ red: 0, green: 0, blue: 0 }), quads: quadSteps(TL_BLOCKED, 10) }),
      { ...DIAG_DEFAULTS, quadSpreadMin: 0.5 },
    );
    assert.equal(r.code, 'no_reflection');
  });

  test('screen_blocked before color_tampered', () => {
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0.03, green: 0.03, blue: 0 }),
      quads: quadSteps(TL_BLOCKED, 10),
    }));
    assert.equal(r.code, 'screen_blocked');
  });

  test('screen_blocked before flat_object', () => {
    const r = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(TL_BLOCKED, 0) }));
    assert.equal(r.code, 'screen_blocked');
  });

  test('color_tampered before flat_object', () => {
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0.03, green: 0.03, blue: 0 }),
      quads: quadSteps(VARIED, 0),
    }));
    assert.equal(r.code, 'color_tampered');
  });

  test('screen_blocked before weak_color', () => {
    // Δ = 0 but TL_BLOCKED spread ≈ 0.174 ≥ 0.02, so no_reflection does not apply
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0, green: 0, blue: 0 }),
      quads: quadSteps(TL_BLOCKED, 10),
    }));
    assert.equal(r.code, 'screen_blocked');
  });

  test('weak_color before flat_object', () => {
    const r = diagnoseRound(round({
      colors: colorSteps({ red: 0, green: 0, blue: 0 }),
      quads: quadSteps(VARIED, 0),
    }));
    assert.equal(r.code, 'weak_color');
  });

  test('color_tampered before H-null insufficient', () => {
    const r = diagnoseRound({ ...colorSteps({ red: 0.03, green: 0.03, blue: 0 }), quadSteps: [] });
    assert.equal(r.evidence.H, null);
    assert.equal(r.code, 'color_tampered');
  });

  test('insufficient before no_reflection', () => {
    const r = diagnoseRound({ handSteps: [invalidColorStep('red')], faceSteps: [], quadSteps: [{ quad: 'TL', rois: null }] });
    assert.equal(r.code, 'insufficient');
  });
});

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

describe('diagnoseRound message', () => {
  test('every code yields a non-empty Korean message and an array weakColors', () => {
    const cases = [
      ['insufficient', { handSteps: [], faceSteps: [], quadSteps: [] }],
      ['insufficient', { ...colorSteps(), quadSteps: [] }], // H null variant
      ['no_reflection', round({ colors: colorSteps({ red: 0, green: 0, blue: 0 }), quads: quadSteps(BALANCED, 0) })],
      ['screen_blocked', round({ colors: colorSteps(), quads: quadSteps(TL_BLOCKED, 10) })],
      ['color_tampered', round({ colors: colorSteps({ red: 0.03, green: 0.03, blue: 0 }), quads: quadSteps(BALANCED, 10) })],
      ['weak_color', round({ colors: colorSteps({ red: 0, green: 0, blue: 0 }), quads: quadSteps(VARIED, 10) })],
      ['flat_object', round({ colors: colorSteps(), quads: quadSteps(VARIED, 0) })],
      ['ok', round({ colors: colorSteps(), quads: quadSteps(BALANCED, 10) })],
    ];
    const seen = new Set();
    for (const [code, input] of cases) {
      const r = diagnoseRound(input);
      assert.equal(r.code, code, `fixture for ${code}`);
      assertMessage(r);
      assertWeakColorsArray(r);
      seen.add(r.message);
    }
    assert.equal(seen.size, cases.length, 'each case should have a distinct message');
  });

  test('weakColors is [] for ok', () => {
    const r = diagnoseRound(round({ colors: colorSteps(), quads: quadSteps(BALANCED, 10) }));
    assert.deepEqual([...r.evidence.weakColors], []);
  });
});
