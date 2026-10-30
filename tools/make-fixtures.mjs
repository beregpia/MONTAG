/* ============ Генератор эталонных треков для эксперимента по фоли ============
 *
 * Создаёт «видео-дорожку» с заведомо известными моментами контакта и несколько
 * имитаций выходов нейросети V2A с разной точностью синхронизации. По ним видно,
 * что означают цифры De-Sync из FoleyBench в привычных кадрах.
 *
 *   node tools/make-fixtures.mjs
 *
 * Результат (не коммитится): tools/fixtures/*.wav + ground-truth.json
 */
import { writeWav } from './lib/wav.mjs';

const SR = 44100;
const DUR = 8;

/* ---------- элементарные звуки ---------- */
function addThump(out, t, { freq = 60, dur = 0.22, amp = 0.85, sr = SR }) {
  const start = Math.round(t * sr);
  const n = Math.round(dur * sr);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= out.length) continue;
    const tt = i / sr;
    const env = Math.exp(-tt / 0.045) * (1 - Math.exp(-tt / 0.0015));
    phase += (2 * Math.PI * freq * (1 - 0.45 * (tt / dur))) / sr; // небольшой спад высоты
    out[idx] += amp * env * Math.sin(phase);
  }
}

function addClick(out, t, { freq = 2100, dur = 0.05, amp = 0.55, sr = SR }) {
  const start = Math.round(t * sr);
  const n = Math.round(dur * sr);
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= out.length) continue;
    const tt = i / sr;
    const env = Math.exp(-tt / 0.006);
    out[idx] += amp * env * (Math.sin(2 * Math.PI * freq * tt) + 0.35 * (Math.random() * 2 - 1));
  }
}

function addNoiseFloor(out, { amp = 0.006, sr = SR }) {
  for (let i = 0; i < out.length; i++) out[i] += amp * (Math.random() * 2 - 1);
}

/** Медленно «дышащий» эмбиент — как room tone у сгенерированной дорожки. */
function addAmbience(out, { amp = 0.05, sr = SR }) {
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    lp += 0.002 * ((Math.random() * 2 - 1) - lp);
    const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * 0.35 * i) / sr);
    out[i] += amp * swell * lp;
  }
}

/* ---------- сценарий (как в демо-клипе приложения) ---------- */
const events = [];
for (let i = 0, t = 1.0; t <= 7.0; t += 1.0, i++) {
  events.push({ time: t, kind: i % 2 === 0 ? 'step-strong' : 'step-weak', freq: i % 2 === 0 ? 58 : 78, amp: i % 2 === 0 ? 0.9 : 0.5 });
}
for (const t of [2.5, 5.5, 6.5]) events.push({ time: t, kind: 'click', freq: 2100, amp: 0.6 });
events.sort((a, b) => a.time - b.time);

/** «Оригинальная» звуковая дорожка видео: шаги + щелчки + тихий шумовой пол. */
function buildGroundTruth() {
  const out = new Float32Array(DUR * SR);
  for (const e of events) {
    if (e.kind === 'click') addClick(out, e.time, { freq: e.freq, amp: e.amp });
    else addThump(out, e.time, { freq: e.freq, amp: e.amp });
  }
  addNoiseFloor(out, {});
  return out;
}

/** Имитация выхода V2A-модели: те же события, но со сдвигом/дрожанием/эмбиентом. */
function buildModelVariant(kind) {
  const out = new Float32Array(DUR * SR);
  const delayed = [];
  for (const e of events) {
    let t = e.time;
    let amp = e.amp;
    if (kind === 'perfect') { /* как есть */ }
    else if (kind === 'late-400ms') t = e.time + 0.4; // ≈ De-Sync 0.447 у MMAudio
    else if (kind === 'late-150ms') t = e.time + 0.15;
    else if (kind === 'jitter') { t = e.time + (Math.random() * 2 - 1) * 0.15; amp *= 0.9; }
    else if (kind === 'ambient') { t = e.time + 0.12; amp *= 0.8; }
    delayed.push({ time: t, kind: e.kind, freq: e.freq, amp });
  }
  for (const e of delayed) {
    if (e.kind === 'click') addClick(out, e.time, { freq: e.freq, amp: e.amp });
    else addThump(out, e.time, { freq: e.freq, amp: e.amp, dur: e.kind === 'step-strong' ? 0.22 : 0.18 });
  }
  if (kind === 'ambient' || kind === 'jitter') addAmbience(out, {});
  addNoiseFloor(out, {});
  return out;
}

/* ---------- запись ---------- */
const gt = buildGroundTruth();
writeWav('tools/fixtures/ground-truth.wav', { sampleRate: SR, channels: [gt] });

const variants = ['perfect', 'late-150ms', 'late-400ms', 'jitter', 'ambient'];
for (const v of variants) {
  const data = buildModelVariant(v);
  writeWav(`tools/fixtures/model-${v}.wav`, { sampleRate: SR, channels: [data] });
}

// стерео-вариант: проверить, что harness микширует каналы
const stereo = buildModelVariant('perfect');
writeWav('tools/fixtures/model-perfect-stereo.wav', {
  sampleRate: SR,
  channels: [stereo, stereo.map((v) => v * 0.95)],
});

const groundTruth = {
  description: 'Моменты контакта, заложенные при синтезе (ground truth)',
  sampleRate: SR,
  duration: DUR,
  events: events.map((e) => ({ time: e.time, kind: e.kind })),
};
const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('tools/fixtures', { recursive: true });
writeFileSync('tools/fixtures/ground-truth.json', `${JSON.stringify(groundTruth, null, 2)}\n`);

console.log(`✓ tools/fixtures/ground-truth.wav — эталон (${events.length} событий, ${DUR} с, ${SR} Гц)`);
for (const v of variants) console.log(`✓ tools/fixtures/model-${v}.wav — имитация выхода V2A (${v})`);
console.log('✓ tools/fixtures/model-perfect-stereo.wav — стерео-проверка микширования');
console.log(`\nСобытия эталона: ${events.map((e) => `${e.time.toFixed(2)}с/${e.kind}`).join(', ')}`);
