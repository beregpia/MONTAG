/* ============ Измерение точности синхронизации фоли ============
 *
 * Сравнивает, где именно оказываются звуковые события относительно заведомо
 * известных моментов контакта (ground truth). Одинаково умеет мерить:
 *   • наш детектор (js/onset.js) на оригинальной дорожке;
 *   • любую внешнюю дорожку — например, вывод Mirelo / ElevenLabs / MMAudio.
 *
 * Использование:
 *   node tools/foley-compare.mjs                        # все фикстуры из tools/fixtures
 *   node tools/foley-compare.mjs --track path.wav       # своя дорожка (WAV 16/24/32-бит)
 *   node tools/foley-compare.mjs --track a.wav --label "Mirelo SFX 2.0"
 *   node tools/foley-compare.mjs --fps 30 --sensitivity 1.2 --min-gap 0.1
 *
 * Метрика — та же идея, что De-Sync в FoleyBench: насколько далеко (в секундах
 * и в кадрах) каждое событие уезжает от истинного момента контакта.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { detectOnsets } from '../js/onset.js';
import { readWav, toMono } from './lib/wav.mjs';

/* ---------- аргументы ---------- */
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const hasFlag = (name) => argv.includes(`--${name}`);
const FPS = Number(arg('fps', 30));
const SENS = Number(arg('sensitivity', 1));
const MIN_GAP = Number(arg('min-gap', 0.12));
const FRAME = 1 / FPS;

/* ---------- загрузка ground truth ---------- */
const GT_JSON = 'tools/fixtures/ground-truth.json';
if (!existsSync(GT_JSON)) {
  console.error('Нет ground truth. Сначала: node tools/make-fixtures.mjs');
  process.exit(1);
}
const truth = JSON.parse(readFileSync(GT_JSON, 'utf8'));
const truthEvents = truth.events.map((e) => e.time).sort((a, b) => a - b);

/* ---------- выравнивание: каждому истинному событию — ближайший детект ---------- */
function align(truthTimes, detected) {
  const pairs = [];
  for (const t of truthTimes) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < detected.length; i++) {
      const d = Math.abs(detected[i] - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    pairs.push({ truth: t, detected: best >= 0 ? detected[best] : null, error: best >= 0 ? detected[best] - t : null });
  }
  const used = new Set(pairs.map((p) => p.detected).filter((v) => v !== null));
  return { pairs, extra: detected.length - used.size };
}

function stats(pairs) {
  const errs = pairs.map((p) => p.error).filter((e) => e !== null);
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN);
  const within = (limit) => (errs.length ? errs.filter((e) => Math.abs(e) <= limit).length / errs.length : 0);
  return {
    n: errs.length,
    bias: mean(errs),
    meanAbs: mean(abs),
    medianAbs: q(abs, 0.5),
    p90Abs: q(abs, 0.9),
    worst: abs.length ? abs[abs.length - 1] : NaN,
    inFrame1: within(FRAME),
    inFrame2: within(2 * FRAME),
    inFrame5: within(5 * FRAME),
  };
}

function pad(s, n, right = false) {
  s = String(s);
  return right ? s + ' '.repeat(Math.max(0, n - s.length)) : ' '.repeat(Math.max(0, n - s.length)) + s;
}

/* ---------- прогон одной дорожки ---------- */
function runTrack(file, label) {
  const wav = readWav(file);
  const mono = toMono(wav);
  const detected = detectOnsets(mono, wav.sampleRate, {
    sensitivity: SENS,
    minGap: MIN_GAP,
    maxEvents: 400,
  }).map((e) => e.time);
  const { pairs, extra } = align(truthEvents, detected);
  const s = stats(pairs);
  return { file, label, wav, pairs, extra, s, detectedCount: detected.length };
}

function printReport(r) {
  const { s, pairs, extra } = r;
  console.log(`\n── ${r.label}  (${r.file})`);
  console.log(`   обнаружено событий: ${r.detectedCount}, лишних (не из сценария): ${extra}`);
  console.log('   событие      истина   детект    ошибка     в кадрах');
  for (const p of pairs) {
    if (p.detected === null) {
      console.log(`   ${pad(p.truth.toFixed(3) + 'с', 10)} ${pad('—', 9)} ${pad('ПРОПУЩЕНО', 10)}`);
      continue;
    }
    console.log(
      `   ${pad(p.truth.toFixed(3) + 'с', 10)} ${pad(p.detected.toFixed(3) + 'с', 9)} `
      + `${pad((p.error * 1000).toFixed(0) + ' мс', 10)} ${pad((p.error / FRAME).toFixed(1), 8)}`,
    );
  }
  const pct = (v) => `${(v * 100).toFixed(0)}%`;
  console.log(
    `   ИТОГ: смещение ${s.bias >= 0 ? '+' : ''}${(s.bias * 1000).toFixed(0)} мс | `
    + `средняя |ошибка| ${(s.meanAbs * 1000).toFixed(0)} мс (${(s.meanAbs / FRAME).toFixed(1)} кадра) | `
    + `медиана ${(s.medianAbs * 1000).toFixed(0)} мс | p90 ${(s.p90Abs * 1000).toFixed(0)} мс | `
    + `худшая ${(s.worst * 1000).toFixed(0)} мс`,
  );
  console.log(
    `   попаданий в ±1 кадр: ${pct(s.inFrame1)} | ±2 кадра: ${pct(s.inFrame2)} | ±5 кадров: ${pct(s.inFrame5)}`,
  );
}

/* ---------- что сравниваем ---------- */
const tracks = [];
if (hasFlag('track')) {
  tracks.push({ file: arg('track'), label: arg('label', arg('track')) });
} else {
  const dir = 'tools/fixtures';
  const files = readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
  const pretty = {
    'ground-truth.wav': 'ОРИГИНАЛ (наш детектор на дорожке видео)',
    'model-perfect.wav': 'V2A-имитация: идеальная синхронизация',
    'model-perfect-stereo.wav': 'V2A-имитация: идеальная, стерео',
    'model-late-150ms.wav': 'V2A-имитация: +150 мс (5 кадров)',
    'model-late-400ms.wav': 'V2A-имитация: +400 мс (12 кадров, ≈ De-Sync MMAudio)',
    'model-jitter.wav': 'V2A-имитация: разброс ±150 мс + эмбиент',
    'model-ambient.wav': 'V2A-имитация: +120 мс + сильный room tone',
  };
  for (const f of files) tracks.push({ file: `${dir}/${f}`, label: pretty[f] || f });
}

console.log('='.repeat(78));
console.log(`Синхронизация фоли · ${FPS} к/с (кадр = ${(FRAME * 1000).toFixed(1)} мс) · `
  + `детектор: sensitivity=${SENS}, minGap=${MIN_GAP}`);
console.log(`Ground truth: ${truthEvents.length} событий, ${truth.duration} с`);
console.log('='.repeat(78));

const results = tracks.map((t) => runTrack(t.file, t.label));
for (const r of results) printReport(r);

/* ---------- сводная таблица ---------- */
console.log('\n' + '='.repeat(78));
console.log('СВОДКА');
console.log('='.repeat(78));
console.log(`${pad('дорожка', 46)} ${pad('смещ.', 9)} ${pad('|ошибка|', 10)} ${pad('кадров', 7)} ${pad('±1 кадр', 8)}`);
for (const r of results) {
  const s = r.s;
  console.log(
    `${pad(r.label.slice(0, 44), 46)} ${pad((s.bias * 1000).toFixed(0) + 'мс', 9)} `
    + `${pad((s.meanAbs * 1000).toFixed(0) + 'мс', 10)} ${pad((s.meanAbs / FRAME).toFixed(1), 7)} `
    + `${pad((s.inFrame1 * 100).toFixed(0) + '%', 8)}`,
  );
}
console.log('='.repeat(78));
