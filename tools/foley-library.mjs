/* ============ Индексатор фоли-библиотеки: «где какой звук на дорожке» ============
 *
 * Берёт записанный дубль (даже часовой, где подряд идут десятки шагов и ударов)
 * и выдаёт таблицу событий с параметрами: время, длительность, полоса, громкость,
 * атака, затухание, «шумность» (ZCR) и спектральный центроид. По этим параметрам
 * определяется, ЧТО это за звук (гравий/дерево/щелчок/ткань/дверь), а также
 * какая это стопа (чередование сильный/слабый) и темп шага.
 *
 * Использование:
 *   node tools/foley-library.mjs --track path.wav [--category шаги] [--slice dir]
 *
 * Опции:
 *   --sensitivity N   чувствительность детектора (0.2..3, по умолчанию 1)
 *   --min-gap S       минимальный интервал между событиями (по умолчанию 0.08)
 *   --slice DIR       нарезать события в отдельные WAV с хендлами
 *   --handles S       хендлы вокруг события (по умолчанию 0.05)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { detectOnsets } from '../js/onset.js';
import { fft, hannWindow } from '../js/fft.js';
import { readWav, toMono, writeWav } from './lib/wav.mjs';

/* ---------- аргументы ---------- */
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const TRACK = arg('track', 'tools/fixtures/library-pass.wav');
const SENS = Number(arg('sensitivity', 1));
const MIN_GAP = Number(arg('min-gap', 0.08));
const SLICE = arg('slice', '');
const HANDLES = Number(arg('handles', 0.05));
const CATEGORY = arg('category', '');

if (!existsSync(TRACK)) {
  console.error(`Нет файла ${TRACK}. Сгенерируйте демо-дубль: node tools/make-library-fixture.mjs`);
  process.exit(1);
}

const wav = readWav(TRACK);
const mono = toMono(wav);
const SR = wav.sampleRate;

/* ---------- 1. сегментация: наш проверенный детектор ---------- */
const onsets = detectOnsets(mono, SR, { sensitivity: SENS, minGap: MIN_GAP, maxEvents: 5000 });

/* ---------- 2. дескрипторы каждого события ---------- */
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

function centroidAt(samples, at) {
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
    num += m * ((k * SR) / N);
    den += m;
  }
  return den > 0 ? num / den : 0;
}

function describe(i, t, nextT) {
  const pre = Math.round(0.02 * SR);
  const start = Math.max(0, Math.round(t * SR) - pre);
  const maxLen = Math.min(mono.length, start + Math.round((nextT ? Math.min(nextT - t, 1.2) : 1.2) * SR));
  const win = mono.subarray(start, maxLen);
  if (win.length < FRAME * 2) return null;

  // пик и огибающая
  let peak = 0;
  let peakIdx = 0;
  for (let k = 0; k < win.length; k++) {
    const a = Math.abs(win[k]);
    if (a > peak) { peak = a; peakIdx = k; }
  }
  const env = envelope(win, 0, win.length);
  const envT = (f) => (f * HOP) / SR;
  const thr20 = peak * 0.1;   // −20 дБ
  const thr30 = peak * 0.0316; // −30 дБ
  let attack = 0;
  for (let f = 0; f < env.length; f++) if (env[f] >= peak * 0.9) { attack = envT(f); break; }
  let decay20 = envT(env.length - 1);
  let decay30 = envT(env.length - 1);
  for (let f = Math.floor((peakIdx / SR) * (SR / HOP)); f < env.length; f++) {
    if (env[f] < thr20) { decay20 = envT(f); break; }
  }
  for (let f = Math.floor((peakIdx / SR) * (SR / HOP)); f < env.length; f++) {
    if (env[f] < thr30) { decay30 = envT(f); break; }
  }
  let sum = 0;
  for (let k = 0; k < win.length; k++) sum += win[k] * win[k];
  const rms = Math.sqrt(sum / win.length);
  const z = zcr(mono, start + Math.max(0, peakIdx - 200), 1024);
  const centroid = centroidAt(mono, start + peakIdx);

  return {
    index: i,
    time: t,
    band: onsets[i].band,
    strength: onsets[i].strength,
    duration: Math.max(0.02, decay30),
    peak,
    rms,
    attack,
    decay20,
    zcr: z,
    centroid,
  };
}

const events = [];
for (let i = 0; i < onsets.length; i++) {
  const d = describe(i, onsets[i].time, i + 1 < onsets.length ? onsets[i + 1].time : null);
  if (d) events.push(d);
}

/* ---------- 3. классификация по дескрипторам ---------- */
function classify(e) {
  const { centroid, zcr, duration, band, peak } = e;
  if (band === 'high' && duration < 0.16) return 'click';
  if (band === 'mid' && zcr > 0.06 && duration > 0.2) return 'cloth/rustle';
  if (band === 'low' && duration > 0.35) return 'door/boom';
  if (band === 'low' && zcr > 0.03) return 'step-gravel';
  if (band === 'low') return 'step-hard';
  if (zcr > 0.05) return 'prop-mid';
  return 'other';
}
for (const e of events) { e.category = classify(e); e.gain = Math.min(1, e.peak); }

/* ---------- 4. чередование стоп и темп (для шагов) ---------- */
const steps = events.filter((e) => e.category.startsWith('step'));
if (steps.length > 3) {
  const gaps = steps.slice(1).map((e, i) => e.time - steps[i].time);
  const cadence = gaps.reduce((s, v) => s + v, 0) / gaps.length;
  steps.forEach((e, i) => {
    e.foot = i % 2 === 0 ? 'L' : 'R';
    e.cadence = cadence;
  });
  events.forEach((e) => { if (e.category.startsWith('step')) e.foot = steps.find((s) => s.index === e.index).foot; });
}

/* ---------- 5. вывод ---------- */
const pad = (s, n, r = false) => { s = String(s); return r ? s + ' '.repeat(Math.max(0, n - s.length)) : ' '.repeat(Math.max(0, n - s.length)) + s; };
const ms = (v) => `${(v * 1000).toFixed(0)}мс`;

console.log('='.repeat(104));
console.log(`Индекс фоли-дубля: ${TRACK}`);
console.log(`${SR} Гц · ${(mono.length / SR).toFixed(1)} с · детектор sensitivity=${SENS} minGap=${MIN_GAP}`);
console.log('='.repeat(104));
console.log(`${pad('#', 3)} ${pad('время', 9)} ${pad('категория', 14)} ${pad('стопа', 5)} ${pad('длит.', 8)} ${pad('пик', 6)} ${pad('атака', 7)} ${pad('затух.', 7)} ${pad('ZCR', 6)} ${pad('центр,Гц', 9)}`);
for (const e of events) {
  console.log(
    `${pad(e.index, 3)} ${pad(e.time.toFixed(3) + 'с', 9)} ${pad(e.category, 14)} ${pad(e.foot || '—', 5)} `
    + `${pad(ms(e.duration), 8)} ${pad(e.peak.toFixed(2), 6)} ${pad(ms(e.attack), 7)} ${pad(ms(e.decay20), 7)} `
    + `${pad(e.zcr.toFixed(3), 6)} ${pad(e.centroid.toFixed(0), 9)}`,
  );
}
console.log('='.repeat(104));

const byCat = {};
for (const e of events) byCat[e.category] = (byCat[e.category] || 0) + 1;
console.log(`Событий: ${events.length}`);
for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(16)} ${n}`);
if (steps.length > 3) console.log(`Темп шага: ${(steps[0].cadence * 1000).toFixed(0)} мс на шаг (${(1 / steps[0].cadence).toFixed(1)} шаг/с)`);

/* ---------- 6. нарезка в отдельные файлы ---------- */
if (SLICE) {
  mkdirSync(SLICE, { recursive: true });
  let n = 0;
  for (const e of events) {
    const from = Math.max(0, Math.round((e.time - HANDLES) * SR));
    const to = Math.min(mono.length, Math.round((e.time + Math.max(e.duration, 0.1) + HANDLES) * SR));
    if (to - from < 512) continue;
    const slice = mono.slice(from, to);
    const name = `${String(e.index).padStart(3, '0')}_${e.category.replace(/[^\w-]/g, '')}`
      + `${e.foot ? `_${e.foot}` : ''}_${(e.time * 1000).toFixed(0)}ms.wav`;
    writeWav(`${SLICE}/${name}`, { sampleRate: SR, channels: [slice] });
    n++;
  }
  console.log(`\n✓ Нарезано ${n} файлов в ${SLICE}/ (хендлы ${HANDLES * 1000} мс)`);
}

/* ---------- 7. JSON для программы ---------- */
writeFileSync('tools/fixtures/library-index.json', `${JSON.stringify({
  track: TRACK,
  sampleRate: SR,
  duration: mono.length / SR,
  options: { sensitivity: SENS, minGap: MIN_GAP },
  events: events.map((e) => ({
    id: `${e.index}`,
    time: Number(e.time.toFixed(4)),
    timecode: fmtTC(e.time),
    category: e.category,
    foot: e.foot || null,
    duration: Number(e.duration.toFixed(4)),
    peak: Number(e.peak.toFixed(4)),
    attack: Number(e.attack.toFixed(4)),
    decay20: Number(e.decay20.toFixed(4)),
    zcr: Number(e.zcr.toFixed(4)),
    centroid: Number(e.centroid.toFixed(1)),
    band: e.band,
  })),
}, null, 2)}\n`);
console.log('✓ Индекс записан: tools/fixtures/library-index.json');

function fmtTC(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const f = Math.round((t % 1) * 25);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}
