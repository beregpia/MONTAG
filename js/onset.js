/* ============ Детект «моментов контакта» (шаги / руки / предметы) ============
 * Spectral-flux анализ моно-сигнала: рост энергии спектра между кадрами =
 * удар, шаг, щелчок, шум ткани. Пики с адаптивным порогом дают события,
 * классифицированные по диапазону (низкий — шаги/туду, высокий — клики/ткань).
 */

import { fft, hannWindow } from './fft.js';

const LOW_HZ = 160;
const HIGH_HZ = 1500;

/**
 * @param {Float32Array} mono       моно-семплы
 * @param {number} sampleRate
 * @param {object} opts
 *   sensitivity 0.2..3   — выше = больше событий
 *   minGap      секунды  — минимальный интервал между событиями
 *   maxEvents             — ограничение сверху
 * @returns {{time:number, strength:number, band:'low'|'mid'|'high'}[]}
 */
export function detectOnsets(mono, sampleRate, opts = {}) {
  const {
    sensitivity = 1,
    minGap = 0.12,
    maxEvents = 400,
    frameSize = 1024,
    hop = 512,
  } = opts;

  const n = mono.length;
  if (n < frameSize * 4 || sampleRate <= 0) return [];

  const win = hannWindow(frameSize);
  const bins = frameSize / 2 + 1;
  const binHz = sampleRate / frameSize;
  const lowBinMax = Math.max(1, Math.floor(LOW_HZ / binHz));
  const highBinMin = Math.min(bins - 1, Math.ceil(HIGH_HZ / binHz));

  const frames = Math.floor((n - frameSize) / hop) + 1;
  const fluxAll = new Float32Array(frames);
  const fluxLow = new Float32Array(frames);
  const fluxHigh = new Float32Array(frames);
  const times = new Float32Array(frames);

  const re = new Float32Array(frameSize);
  const im = new Float32Array(frameSize);
  let prev = new Float32Array(bins);

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < frameSize; i++) re[i] = mono[off + i] * win[i];
    im.fill(0);
    fft(re, im);

    let all = 0;
    let low = 0;
    let high = 0;
    for (let k = 1; k < bins; k++) {
      const m = Math.hypot(re[k], im[k]);
      const d = Math.max(0, m - prev[k]);
      all += d;
      if (k <= lowBinMax) low += d;
      else if (k >= highBinMin) high += d;
      prev[k] = m;
    }
    fluxAll[f] = all;
    fluxLow[f] = low;
    fluxHigh[f] = high;
    times[f] = (off + frameSize / 2) / sampleRate;
  }

  const medAll = median(fluxAll);
  const p90 = percentile(fluxAll, 0.9);
  const p95 = percentile(fluxAll, 0.95);
  const medLow = median(fluxLow) || 1e-9;
  const medHigh = median(fluxHigh) || 1e-9;
  const maxFlux = Math.max(1e-9, ...fluxAll);

  // адаптивный порог: медиана + доля разброса до 90-го процентиля
  const thr = medAll + sensitivity * Math.max(p90 - medAll, maxFlux * 0.01);
  const floor = Math.max(maxFlux * 0.04, medAll * 1.5);

  const events = [];
  let lastKept = -Infinity;
  for (let f = 1; f < frames - 1; f++) {
    const v = fluxAll[f];
    if (v < thr || v < floor) continue;
    if (v <= fluxAll[f - 1] || v < fluxAll[f + 1]) continue; // локальный максимум
    const t = times[f];
    if (t - lastKept < minGap) continue;

    const lowN = fluxLow[f] / medLow;
    const highN = fluxHigh[f] / medHigh;
    let band = 'mid';
    if (lowN > 1.6 * highN) band = 'low';
    else if (highN > 1.6 * lowN) band = 'high';

    events.push({
      time: t,
      band,
      strength: clamp01((v - medAll) / Math.max(p95 - medAll, 1e-9)),
    });
    lastKept = t;
    if (events.length >= maxEvents) break;
  }

  return events;
}

/** Микширование каналов (массивов Float32Array) в моно. */
export function mixToMono(channels, length) {
  const out = new Float32Array(length);
  if (!channels.length) return out;
  for (const ch of channels) {
    for (let i = 0; i < length; i++) out[i] += ch[i];
  }
  if (channels.length > 1) {
    const k = 1 / channels.length;
    for (let i = 0; i < length; i++) out[i] *= k;
  }
  return out;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  const idx = clampInt(Math.floor(p * (s.length - 1)), 0, s.length - 1);
  return s[idx];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampInt = (v, a, b) => (v < a ? a : v > b ? b : v);
