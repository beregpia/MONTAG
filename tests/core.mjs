/* Проверка FFT и детектора событий на синтетике (без DOM). */
import { fft, magnitudeSpectrum } from '../js/fft.js';
import { detectOnsets, mixToMono } from '../js/onset.js';

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fails++;
};

/* ---------- FFT ---------- */
const SR = 48000;
const N = 1024;

{
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = Math.sin((2 * Math.PI * 8 * i) / N);
  fft(re, im);
  let peak = 0, peakK = -1;
  for (let k = 0; k < N / 2; k++) {
    const m = Math.hypot(re[k], im[k]);
    if (m > peak) { peak = m; peakK = k; }
  }
  check('FFT: синус на бине 8 даёт пик на бине 8', peakK === 8, `peakK=${peakK}`);
  check('FFT: амплитуда пика ≈ N/2', Math.abs(peak - N / 2) < 0.5, `peak=${peak.toFixed(2)}`);
}

{
  const frame = new Float32Array(N);
  frame[0] = 1;
  const mag = magnitudeSpectrum(frame, null);
  let ok = true;
  for (let k = 0; k < mag.length; k++) if (Math.abs(mag[k] - 1) > 1e-4) ok = false;
  check('FFT: импульс даёт плоский спектр', ok);
}

{
  const re = new Float32Array(N), im = new Float32Array(N);
  let energy = 0;
  for (let i = 0; i < N; i++) { re[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 0.11); energy += re[i] ** 2; }
  fft(re, im);
  let spec = 0;
  for (let k = 0; k < N; k++) spec += re[k] ** 2 + im[k] ** 2;
  check('FFT: равенство Парсеваля', Math.abs(spec / N - energy) < 1e-3, `${(spec / N).toFixed(4)} vs ${energy.toFixed(4)}`);
}

{
  let threw = false;
  try { fft(new Float32Array(6), new Float32Array(6)); } catch { threw = true; }
  check('FFT: отклоняет нечётные длины', threw);
}

/* ---------- Детектор ---------- */
function makeSignal(durationS, hitTimes) {
  const len = Math.floor(durationS * SR);
  const out = new Float32Array(len);
  for (const [t, type] of hitTimes) {
    const start = Math.floor(t * SR);
    const dur = type === 'low' ? 0.2 : 0.05;
    const n = Math.floor(dur * SR);
    for (let i = 0; i < n && start + i < len; i++) {
      const env = Math.exp(-i / (0.02 * SR));
      if (type === 'low') out[start + i] += 0.9 * env * Math.sin((2 * Math.PI * 70 * i) / SR);
      else out[start + i] += 0.7 * env * (Math.random() * 2 - 1);
    }
  }
  for (let i = 0; i < len; i++) out[i] += 0.002 * (Math.random() * 2 - 1);
  return out;
}

const truth = [[0.5, 'low'], [1.3, 'high'], [2.1, 'low'], [3.7, 'high'], [5.0, 'low']];
const sig = makeSignal(7, truth);
const ev = detectOnsets(sig, SR, { sensitivity: 1, minGap: 0.12 });

check('Детект: найдено >= 4 событий', ev.length >= 4, `найдено ${ev.length}`);
const tol = 0.06;
const matched = truth.filter(([t]) => ev.some((e) => Math.abs(e.time - t) < tol));
check('Детект: все 5 ударов найдены в пределах 60 мс', matched.length === 5,
  `совпало ${matched.length}/5: ${ev.map((e) => e.time.toFixed(2)).join(', ')}`);

const lowBands = ev.filter((e) => truth.some(([t]) => Math.abs(e.time - t) < tol && e.band === 'low'));
check('Детект: низкие удары классифицированы как low', lowBands.length >= 2,
  ev.map((e) => `${e.time.toFixed(2)}:${e.band}`).join(' '));

check('Детект: тишина не даёт событий', detectOnsets(new Float32Array(SR * 3), SR, {}).length === 0);

{
  const tone = new Float32Array(SR * 3);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / SR);
  check('Детект: ровный тон даёт мало событий', detectOnsets(tone, SR, {}).length <= 2);
}

{
  const lo = detectOnsets(sig, SR, { sensitivity: 0.2, minGap: 0.12 }).length;
  const hi = detectOnsets(sig, SR, { sensitivity: 3, minGap: 0.12 }).length;
  check('Детект: чувствительность монотонна', hi >= lo, `sens0.2=${lo} sens3=${hi}`);
}

{
  const many = [];
  for (let t = 0.3; t < 3; t += 0.05) many.push([t, 'high']);
  const s2 = makeSignal(4, many);
  const a = detectOnsets(s2, SR, { minGap: 0.05 }).length;
  const b = detectOnsets(s2, SR, { minGap: 0.3 }).length;
  check('Детект: minGap сокращает число событий', b < a, `gap0.05=${a} gap0.3=${b}`);
}

{
  const l = new Float32Array([1, 0, -1]);
  const r = new Float32Array([0, 1, 0]);
  const mono = mixToMono([l, r], 3);
  check('mixToMono усредняет каналы', Math.abs(mono[0] - 0.5) < 1e-6 && Math.abs(mono[2] + 0.5) < 1e-6, mono.join(','));
}

console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nЯдро (FFT + детектор) работает');
process.exitCode = fails ? 1 : 0;
