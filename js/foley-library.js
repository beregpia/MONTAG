/* ============ Индексатор фоли-дорожек (браузерная версия) ============
 *
 * Порт tools/foley-library.mjs на ES-модули приложения: берёт декодированный
 * моно-сигнал дорожки и возвращает индекс событий — позиция, длительность,
 * пик, атака, затухание, шумность (ZCR), спектральный центроид, стопа, темп.
 *
 * Чистые функции: работают и в браузере, и в Node (тесты).
 */

import { detectOnsets } from './onset.js';
import { fft, hannWindow } from './fft.js';

/* Порог сегментации по смыслу имени дорожки: у рук события чаще, чем у шагов. */
export const GAP_HINTS = [
  [/step|шаг|foot|walk|ног|ходьб/i, 0.30],
  [/hand|heand|рук/i, 0.12],
  [/cloth|ткан|rustl|шурш|coat/i, 0.20],
  [/door|двер|impact|удар|boom|slam/i, 0.30],
  [/prop|реквиз|key|money|cup|chair/i, 0.18],
];

export function gapFor(name) {
  for (const [re, g] of GAP_HINTS) if (re.test(name)) return g;
  return 0.15;
}

/* «steps 02» → категория «steps», проход «02».
 * Три прохода шагов складываются в одну категорию, и движок выбирает между ними. */
export function splitTrackName(name) {
  const m = String(name).match(/^(.*?)[\s_-]+(\d{1,3})$/);
  if (m && m[1].trim()) return { category: m[1].trim(), pass: m[2] };
  return { category: String(name).trim(), pass: '' };
}

const FRAME = 256;
const HOP = 128;

function envelope(samples, from, to) {
  const n = Math.max(0, to - from);
  const frames = Math.floor(n / HOP);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = from + f * HOP;
    let sum = 0;
    for (let i = 0; i < FRAME; i++) { const v = samples[off + i] || 0; sum += v * v; }
    env[f] = Math.sqrt(sum / FRAME);
  }
  return env;
}

function zcr(samples, from, n) {
  let crossings = 0;
  let prev = samples[from] || 0;
  for (let i = 1; i < n; i++) {
    const v = samples[from + i] || 0;
    if ((v >= 0) !== (prev >= 0)) crossings++;
    prev = v;
  }
  return crossings / Math.max(1, n - 1);
}

function centroidAt(samples, at, sampleRate) {
  const N = 1024;
  const off = Math.max(0, Math.min(samples.length - N, at - (N >> 1)));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const win = hannWindow(N);
  for (let i = 0; i < N; i++) re[i] = (samples[off + i] || 0) * win[i];
  fft(re, im);
  let num = 0;
  let den = 0;
  const bins = N / 2;
  for (let k = 1; k < bins; k++) {
    const m = Math.hypot(re[k], im[k]);
    num += m * ((k * sampleRate) / N);
    den += m;
  }
  return den > 0 ? num / den : 0;
}

/** Время атаки до отсчёта: детектор даёт время кадра анализа (шаг 11.6 мс).
 *  Ищем по скользящему RMS, а не по сырому сигналу: на шумном шаге (гравий)
 *  |x| пересекает нуль каждые полпериода, и требование «N отсчётов подряд выше
 *  порога» невыполнимо. */
export function refineAttack(mono, sampleRate, t) {
  const center = Math.round(t * sampleRate);
  const from = Math.max(0, center - Math.round(0.03 * sampleRate));
  const end = Math.min(mono.length, from + Math.round(0.3 * sampleRate));
  const W = 128; // ~2.9 мс при 44.1 кГц
  const rmsAt = (i) => {
    let sum = 0;
    for (let k = -W; k <= 0; k++) { const v = mono[i + k] || 0; sum += v * v; }
    return Math.sqrt(sum / (W + 1));
  };
  let peakE = 0;
  for (let i = from + W; i < end; i++) { const r = rmsAt(i); if (r > peakE) peakE = r; }
  if (peakE <= 0) return t;
  const thr = peakE * 0.15;
  for (let i = from + W; i < end; i++) if (rmsAt(i) >= thr) return (i - (W >> 1)) / sampleRate;
  return t;
}


function describe(i, t, nextT, mono, sampleRate) {
  const pre = Math.round(0.02 * sampleRate);
  const start = Math.max(0, Math.round(t * sampleRate) - pre);
  const maxLen = Math.min(mono.length, start + Math.round((nextT ? Math.min(nextT - t, 1.2) : 1.2) * sampleRate));
  const win = mono.subarray(start, maxLen);
  if (win.length < FRAME * 2) return null;

  let peak = 0;
  let peakIdx = 0;
  for (let k = 0; k < win.length; k++) {
    const a = Math.abs(win[k]);
    if (a > peak) { peak = a; peakIdx = k; }
  }
  const env = envelope(win, 0, win.length);
  const envT = (f) => (f * HOP) / sampleRate;
  const thr20 = peak * 0.1;
  const thr30 = peak * 0.0316;
  let attack = 0;
  for (let f = 0; f < env.length; f++) if (env[f] >= peak * 0.9) { attack = envT(f); break; }
  let decay20 = envT(env.length - 1);
  let decay30 = envT(env.length - 1);
  const fromPeak = Math.floor((peakIdx / sampleRate) * (sampleRate / HOP));
  for (let f = fromPeak; f < env.length; f++) { if (env[f] < thr20) { decay20 = envT(f); break; } }
  for (let f = fromPeak; f < env.length; f++) { if (env[f] < thr30) { decay30 = envT(f); break; } }
  let sum = 0;
  for (let k = 0; k < win.length; k++) sum += win[k] * win[k];
  const rms = Math.sqrt(sum / win.length);

  return {
    index: i,
    time: t,
    duration: Math.max(0.02, decay30),
    peak,
    rms,
    attack,
    decay20,
    zcr: zcr(mono, start + Math.max(0, peakIdx - 200), 1024),
    centroid: centroidAt(mono, start + peakIdx, sampleRate),
  };
}

/** Классификация по дескрипторам — только когда категория неизвестна. */
export function classifyEvent(e, band) {
  const { centroid, zcr, duration, band: b } = e;
  if (b === 'high' && duration < 0.16) return 'click';
  if (b === 'mid' && zcr > 0.06 && duration > 0.2) return 'cloth/rustle';
  if (b === 'low' && duration > 0.35) return 'door/boom';
  if (b === 'low' && zcr > 0.03) return 'step-gravel';
  if (b === 'low') return 'step-hard';
  if (zcr > 0.05) return 'prop-mid';
  return 'other';
}

/**
 * Индексирует дорожку.
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {{category?:string, pass?:string, minGap?:number, sensitivity?:number}} opts
 */
export function indexTrack(mono, sampleRate, opts = {}) {
  const {
    category = '', pass = '', minGap = 0.15, sensitivity = 1,
  } = opts;
  const onsets = detectOnsets(mono, sampleRate, { sensitivity, minGap, maxEvents: 5000 });
  const refined = onsets.map((o) => refineAttack(mono, sampleRate, o.time));

  const events = [];
  for (let i = 0; i < refined.length; i++) {
    const d = describe(i, refined[i], i + 1 < refined.length ? refined[i + 1] : null, mono, sampleRate);
    if (!d) continue;
    d.band = onsets[i].band;
    d.strength = onsets[i].strength;
    d.category = category || classifyEvent(d, onsets[i].band);
    d.id = `${pass || category || 'mixed'}#${i}`;
    events.push(d);
  }

  /* чередование стоп и темп — только для шагов */
  const steps = events.filter((e) => /step|шаг|foot/i.test(e.category));
  if (steps.length > 3) {
    const gaps = steps.slice(1).map((e, i) => e.time - steps[i].time);
    const cadence = gaps.reduce((s, v) => s + v, 0) / gaps.length;
    steps.forEach((e, i) => { e.foot = i % 2 === 0 ? 'L' : 'R'; e.cadence = cadence; });
  }

  return {
    category: category || 'mixed',
    pass,
    sampleRate,
    duration: mono.length / sampleRate,
    events: events.map((e) => ({
      id: e.id,
      time: Number(e.time.toFixed(4)),
      duration: Number(e.duration.toFixed(4)),
      peak: Number(e.peak.toFixed(4)),
      rms: Number(e.rms.toFixed(4)),
      attack: Number(e.attack.toFixed(4)),
      decay20: Number(e.decay20.toFixed(4)),
      zcr: Number(e.zcr.toFixed(4)),
      centroid: Number(e.centroid.toFixed(1)),
      band: e.band,
      strength: e.strength,
      category: e.category,
      foot: e.foot || null,
      cadence: e.cadence ? Number(e.cadence.toFixed(4)) : null,
    })),
  };
}
