// POS projection (Wang et al., IEEE TBME 2017), independently implemented.
// All thresholds are exploratory quality gates, not validated PAD thresholds.
const avg = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const sd = (a) => { const m = avg(a); return Math.sqrt(avg(a.map(x => (x - m) ** 2))); };
const finiteRGB = (a) => Array.isArray(a) && a.length === 3 && a.every(x => Number.isFinite(x) && x > 2 && x < 250);

export function pos(rgb, fs) {
  const n = rgb.length, win = Math.ceil(1.6 * fs);
  const sum = Array(n).fill(0), weights = Array(n).fill(0);
  for (let start = 0; start + win <= n; start++) {
    const block = rgb.slice(start, start + win);
    const means = [0, 1, 2].map(c => avg(block.map(x => x[c])));
    if (means.some(x => x < 1)) continue;
    const a = [], b = [];
    for (const row of block) {
      const [r, g, blue] = row.map((v, c) => v / means[c]);
      a.push(g - blue); b.push(-2 * r + g + blue);
    }
    const denom = sd(b);
    if (denom < 1e-10) continue;
    const alpha = sd(a) / denom;
    const h = a.map((v, i) => v + alpha * b[i]), mean = avg(h);
    h.forEach((v, i) => { sum[start + i] += v - mean; weights[start + i]++; });
  }
  return sum.map((v, i) => weights[i] ? v / weights[i] : 0);
}

// Hann-window periodogram. A frequency band is selected for pulse candidates;
// this is not a claim of physiological or clinical heart-rate accuracy.
export function spectrum(signal, fs) {
  const n = signal.length, m = avg(signal), mid = (n - 1) / 2;
  let xy = 0, xx = 0;
  signal.forEach((v, i) => { xy += (i - mid) * (v - m); xx += (i - mid) ** 2; });
  const slope = xy / Math.max(xx, 1);
  const centered = signal.map((v, i) => v - m - slope * (i - mid));
  const x = centered.map((v, i) => v * (.5 - .5 * Math.cos(2 * Math.PI * i / Math.max(1, n - 1))));
  const bins = [];
  for (let bpm = 45; bpm <= 180; bpm++) {
    let re = 0, im = 0;
    x.forEach((v, i) => { const angle = 2 * Math.PI * bpm / 60 * i / fs; re += v * Math.cos(angle); im += v * Math.sin(angle); });
    bins.push({ bpm, power: (re * re + im * im) / Math.max(1, n * n) });
  }
  const peak = bins.reduce((a, b) => b.power > a.power ? b : a);
  const total = bins.reduce((s, b) => s + b.power, 0);
  const near = bins.filter(b => Math.abs(b.bpm - peak.bpm) <= 6).reduce((s, b) => s + b.power, 0);
  return { bpm: peak.bpm, concentration: total ? near / total : 0, amplitude: sd(centered) };
}

function interpolate(rows, roi, fs) {
  const out = [], first = rows[0].t, last = rows.at(-1).t;
  let j = 0;
  for (let t = first; t <= last; t += 1000 / fs) {
    while (j + 1 < rows.length - 1 && rows[j + 1].t < t) j++;
    const a = rows[j], b = rows[j + 1];
    const p = (t - a.t) / (b.t - a.t);
    out.push(a.regions[roi].map((v, c) => v + (b.regions[roi][c] - v) * p));
  }
  return out;
}

export function analyzePulse(frames) {
  const unavailable = (reason) => ({ passed: false, status: 'insufficient', reason, bpm: null, regions: [] });
  if (!Array.isArray(frames) || frames.length < 300) return unavailable('pulse frame 부족');
  if (frames.some((f, i) => !Number.isFinite(f.t) || (i && f.t <= frames[i - 1].t))) return unavailable('frame timestamp 불연속');
  const rows = frames.filter(f => f.regions?.length === 3 && f.regions.every(finiteRGB) && f.clipped < .03 && f.faceCount === 1);
  if (rows.length / frames.length < .95 || rows.length < 300) return unavailable('얼굴 ROI 품질 부족');
  const duration = (rows.at(-1).t - rows[0].t) / 1000;
  if (duration < 25) return unavailable('pulse 측정 시간 부족');
  const fs = (rows.length - 1) / duration;
  if (fs < 12) return unavailable('pulse frame rate 부족');
  if (rows.some((f, i) => i && f.t - rows[i - 1].t > 250)) return unavailable('pulse frame 간격 불안정');
  if (rows.some(f => !f.box || !Number.isFinite(f.box.w) || f.box.w <= 0)) return unavailable('얼굴 추적 정보 부족');
  const width = avg(rows.map(f => f.box.w));
  if (sd(rows.map(f => f.box.x)) / width > .08 || sd(rows.map(f => f.box.y)) / width > .08 || sd(rows.map(f => f.box.w)) / width > .08) return unavailable('pulse 측정 중 얼굴 움직임 과다');
  const sampleRate = Math.min(30, fs);
  const regions = [0, 1, 2].map(roi => {
    const wave = pos(interpolate(rows, roi, sampleRate), sampleRate);
    const trim = Math.ceil(sampleRate * 1.6), signal = wave.slice(trim, -trim);
    const full = spectrum(signal, sampleRate);
    const half = Math.floor(signal.length / 2);
    const first = spectrum(signal.slice(0, half), sampleRate), second = spectrum(signal.slice(half), sampleRate);
    return { ...full, driftBpm: Math.abs(first.bpm - second.bpm), passed: full.amplitude > .00005 && full.concentration >= .4 && Math.abs(first.bpm - second.bpm) <= 8 };
  });
  const good = regions.filter(r => r.passed);
  const matched = good.length >= 2 && Math.max(...good.map(r => r.bpm)) - Math.min(...good.map(r => r.bpm)) <= 8;
  return { passed: matched, status: matched ? 'observed' : 'insufficient', reason: matched ? '여러 ROI에서 안정된 pulse 후보 관측' : 'pulse 주기·ROI 일치 부족', bpm: matched ? Math.round(avg(good.map(r => r.bpm))) : null, regions, fps: fs, duration };
}
