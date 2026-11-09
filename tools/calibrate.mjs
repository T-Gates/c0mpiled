#!/usr/bin/env node
// Human Check — 수집 데이터로 판정 기준값(minDelta, minSwingH) 보정 (v1.4)
// 사용법: node tools/calibrate.mjs <dataset.json> [--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  DEFAULTS,
  QUAD_DEFAULTS,
  roundFeatures,
  stepTargetDeltas,
  bestThreshold,
  diagnoseRound,
} from '../src/judge.js';

const LABELS = ['real', 'phone', 'obs', 'block'];
const FAKE = ['phone', 'obs']; // 기준값 보정용 가짜 집합 (block 제외, v1.5)
const DIAG_CODES = ['ok', 'no_reflection', 'screen_blocked', 'color_tampered', 'weak_color', 'flat_object', 'insufficient'];
const FEATURES = ['handDeltaMean', 'faceDeltaMean', 'handMatchRatio', 'faceMatchRatio', 'H', 'V'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const write = args.includes('--write');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('사용법: node tools/calibrate.mjs <dataset.json> [--write]');
  process.exit(2);
}

let records;
try {
  records = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`데이터셋을 읽지 못했습니다: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(records)) {
  console.error('데이터셋은 레코드 배열이어야 합니다.');
  process.exit(1);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// features가 없거나 깨졌으면 원본 단계로 다시 계산
const featuresOf = (r) =>
  r.features && typeof r.features === 'object'
    ? r.features
    : roundFeatures({ handSteps: r.handSteps || [], faceSteps: r.faceSteps || [], quadSteps: r.quadSteps || [] });

const byLabel = Object.fromEntries(LABELS.map((l) => [l, []]));
let skipped = 0;
for (const r of records) {
  if (r && byLabel[r.label]) byLabel[r.label].push(r);
  else skipped++;
}
const n = Object.fromEntries(LABELS.map((l) => [l, byLabel[l].length]));

// ---------- 라벨별 개수 ----------
console.log('== 라벨별 레코드 수 ==');
for (const l of LABELS) console.log(`  ${l.padEnd(6)} ${n[l]}`);
if (skipped) console.log(`  (라벨 없음/알 수 없음으로 제외: ${skipped})`);

// ---------- feature 통계 ----------
const f = (v, d = 4) => (isNum(v) ? v.toFixed(d) : '-');
function stats(vals) {
  const v = vals.filter(isNum);
  if (!v.length) return { n: 0, mean: null, min: null, max: null };
  return { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) };
}
console.log('\n== feature 통계 (mean / min / max, n=유효 개수) ==');
console.log(`  ${'feature'.padEnd(16)}${LABELS.map((l) => l.padEnd(34)).join('')}`);
for (const k of FEATURES) {
  const cells = LABELS.map((l) => {
    const s = stats(byLabel[l].map((r) => featuresOf(r)[k]));
    return `${f(s.mean)} / ${f(s.min)} / ${f(s.max)} (n=${s.n})`.padEnd(34);
  });
  console.log(`  ${k.padEnd(16)}${cells.join('')}`);
}

// ---------- 기준값 ----------
const fakeRate = (vals, t) => {
  const v = vals.filter(isNum);
  return v.length ? v.filter((x) => x > t).length / v.length : null;
};
const pct = (v) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);

function report(name, defVal, posVals, negByLabel) {
  const neg = FAKE.flatMap((l) => negByLabel[l]);
  const r = bestThreshold(posVals, neg);
  console.log(`\n== ${name} (real ${posVals.filter(isNum).length}개 vs 가짜 ${neg.filter(isNum).length}개) ==`);
  if (!r) {
    console.log(`  데이터 부족 — 기본값 유지 (${name}=${defVal})`);
    return null;
  }
  console.log(`  threshold=${r.threshold}  balancedAccuracy=${r.balancedAccuracy.toFixed(3)}  tpr=${r.tpr.toFixed(3)}  tnr=${r.tnr.toFixed(3)}`);
  console.log(`  (기본값 ${defVal})`);
  for (const l of FAKE) {
    const fr = fakeRate(negByLabel[l], r.threshold);
    console.log(`  오탐률 ${l.padEnd(6)} ${pct(fr)}  (${negByLabel[l].filter(isNum).length}개 중 > threshold)`);
  }
  return r;
}

const deltasOf = (recs) =>
  recs.flatMap((r) => [...stepTargetDeltas(r.handSteps || []), ...stepTargetDeltas(r.faceSteps || [])]);
const hOf = (recs) => recs.map((r) => featuresOf(r).H);

const md = report(
  'minDelta',
  DEFAULTS.minDelta,
  deltasOf(byLabel.real),
  Object.fromEntries(FAKE.map((l) => [l, deltasOf(byLabel[l])])),
);
const mh = report(
  'minSwingH',
  QUAD_DEFAULTS.minSwingH,
  hOf(byLabel.real),
  Object.fromEntries(FAKE.map((l) => [l, hOf(byLabel[l])])),
);

// ---------- v1.5 라벨 × 진단 code 교차표 ----------
// 레코드의 diag 대신 원본 단계로 다시 진단 (현재 기준 = 이번 보정 결과, 없으면 기본값)
const diagOpts = {
  minDelta: md ? md.threshold : DEFAULTS.minDelta,
  minSwingH: mh ? mh.threshold : QUAD_DEFAULTS.minSwingH,
};
console.log(`\n== 라벨 × 진단 code (minDelta=${diagOpts.minDelta}, minSwingH=${diagOpts.minSwingH}) ==`);
const cw = Math.max(...DIAG_CODES.map((c) => c.length)) + 2;
console.log(`  ${'label'.padEnd(7)}${DIAG_CODES.map((c) => c.padStart(cw)).join('')}${'합계'.padStart(6)}`);
for (const l of LABELS) {
  const cnt = Object.fromEntries(DIAG_CODES.map((c) => [c, 0]));
  for (const r of byLabel[l]) {
    const d = diagnoseRound(
      { handSteps: r.handSteps || [], faceSteps: r.faceSteps || [], quadSteps: r.quadSteps || [] },
      diagOpts,
    );
    cnt[d.code] = (cnt[d.code] || 0) + 1;
  }
  console.log(`  ${l.padEnd(7)}${DIAG_CODES.map((c) => String(cnt[c]).padStart(cw)).join('')}${String(byLabel[l].length).padStart(8)}`);
}

if (write) {
  const out = {
    minDelta: md ? md.threshold : DEFAULTS.minDelta,
    minSwingH: mh ? mh.threshold : QUAD_DEFAULTS.minSwingH,
    n,
    createdAt: new Date().toISOString(),
  };
  const path = resolve(ROOT, 'calibration.json');
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n저장: ${path}`);
  console.log(JSON.stringify(out));
}
