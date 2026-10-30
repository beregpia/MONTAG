/* ============ Размещение фоли по картинке (движок сопоставления) ============
 *
 * Берёт два входа:
 *   • библиотеку — JSON-индексы записанных дорожек (по одному файлу на
 *     категорию, как в вашей сессии), из tools/foley-library.mjs;
 *   • события на картинке — JSON из видео-детектора.
 *
 * И выдаёт расстановку: в какой кадр вставить и откуда взять звук.
 *
 * Категорий не знает заранее: они приходят из имён дорожек. Новая категория
 * («руки», «дверь», «металл») работает без правок кода — используется общий
 * профиль сопоставления, если для неё нет своего.
 *
 *   node tools/place-foley.mjs --library tools/fixtures/lib \
 *                              --video tools/fixtures/place-video.json \
 *                              [--out placements.json] [--cooldown 4]
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIB = arg('library', 'tools/fixtures/lib');
const VIDEO = arg('video', 'tools/fixtures/place-video.json');
const OUT = arg('out', 'tools/fixtures/placements.json');
const COOLDOWN = Number(arg('cooldown', 4));

if (!existsSync(VIDEO)) { console.error(`Нет ${VIDEO}`); process.exit(1); }
if (!existsSync(LIB)) { console.error(`Нет каталога ${LIB}`); process.exit(1); }

/* ---------- профили категорий ----------
 * Веса дескрипторов и подсказки для видео-детектора. Список открытый:
 * неизвестная категория получает профиль 'default'. */
const PROFILES = {
  steps: { weights: { strength: 0.5, band: 0.2, centroid: 0.15, duration: 0.15 }, minGap: 0.3, visual: 'foot-contact' },
  hands: { weights: { strength: 0.45, band: 0.25, centroid: 0.15, duration: 0.15 }, minGap: 0.12, visual: 'hand-object-contact' },
  cloth: { weights: { strength: 0.35, band: 0.25, centroid: 0.2, duration: 0.2 }, minGap: 0.2, visual: 'motion-region' },
  door: { weights: { strength: 0.5, band: 0.25, centroid: 0.1, duration: 0.15 }, minGap: 0.3, visual: 'impact' },
  default: { weights: { strength: 0.4, band: 0.25, centroid: 0.2, duration: 0.15 }, minGap: 0.15, visual: 'motion-region' },
};
const profileOf = (c) => PROFILES[c] || PROFILES.default;

/* ---------- загрузка библиотеки ---------- */
const library = [];
for (const f of readdirSync(LIB).filter((f) => f.endsWith('.json')).sort()) {
  const idx = JSON.parse(readFileSync(join(LIB, f), 'utf8'));
  const cat = idx.category || f.replace(/\.json$/, '');
  for (const e of idx.events || []) library.push({ ...e, category: e.category || cat, track: idx.track || cat, file: `${LIB}/${cat}.wav` });
}
const video = JSON.parse(readFileSync(VIDEO, 'utf8'));
const FPS = video.fps || 25;
const events = (video.events || []).slice().sort((a, b) => a.time - b.time);
if (!library.length) { console.error('Библиотека пуста'); process.exit(1); }

const BAND = { low: 0, mid: 1, high: 2 };
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/* ---------- расстояние между событием на картинке и дублем ---------- */
function distance(v, a, w) {
  const dStrength = Math.abs((v.strength ?? 0.5) - clamp01((a.peak ?? 0) / 1.5));
  const dBand = Math.abs((BAND[v.band] ?? 1) - (BAND[a.band] ?? 1)) / 2;
  const dCentroid = Math.abs(Math.log((v.centroid ?? 2000) + 1) - Math.log((a.centroid ?? 2000) + 1)) / Math.log(20000);
  const dDur = Math.abs(Math.log((v.duration ?? 0.2) + 0.05) - Math.log((a.duration ?? 0.2) + 0.05)) / Math.log(20);
  return w.strength * dStrength + w.band * dBand + w.centroid * dCentroid + w.duration * dDur;
}

/* ---------- размещение ---------- */
const recent = new Map(); // категория -> массив недавно использованных id
const placements = [];
const usedCount = new Map();

for (const v of events) {
  const w = profileOf(v.category).weights;
  const cands = library.filter((a) => a.category === v.category);
  if (!cands.length) {
    placements.push({
      ...v, targetTimecode: tc(v.time, FPS), audio: null,
      note: `нет дорожки для категории «${v.category}»`,
    });
    continue;
  }
  const used = recent.get(v.category) || [];
  const scored = cands.map((a) => {
    const reuse = used.filter((u) => u === a.id).length;
    // повтор одного и того же дубля подряд — штраф, чтобы не «заедало»
    const penalty = reuse > 0 ? 0.35 * reuse : 0;
    return { a, score: distance(v, a, w) + penalty, raw: distance(v, a, w) };
  }).sort((x, y) => x.score - y.score);
  const best = scored[0];
  const id = best.a.id;
  const arr = recent.get(v.category) || [];
  arr.push(id);
  recent.set(v.category, arr.slice(-COOLDOWN));
  usedCount.set(id, (usedCount.get(id) || 0) + 1);
  placements.push({
    ...v, targetTimecode: tc(v.time, FPS),
    audio: {
      id, file: best.a.file, sourceTime: best.a.time, category: best.a.category,
      duration: best.a.duration, peak: best.a.peak, centroid: best.a.centroid, band: best.a.band,
      cutFrom: Number((best.a.time - 0.05).toFixed(4)),
      cutTo: Number((best.a.time + Math.max(best.a.duration, 0.1) + 0.05).toFixed(4)),
    },
    confidence: Number((1 - best.raw).toFixed(3)),
    review: best.raw > 0.35,
  });
}

/* ---------- вывод ---------- */
const pad = (s, n, r = false) => { s = String(s); return r ? s + ' '.repeat(Math.max(0, n - s.length)) : ' '.repeat(Math.max(0, n - s.length)) + s; };
console.log('='.repeat(112));
console.log(`Размещение фоли: библиотека ${LIB} (${library.length} дублей, ${new Set(library.map((a) => a.category)).size} категорий) · картинка ${events.length} событий · ${FPS} к/с`);
console.log('='.repeat(112));
console.log(`${pad('ТК', 12)} ${pad('категория', 11)} ${pad('кадр', 6)} ${pad('сила', 6)} ${pad('дубль', 8)} ${pad('взять из', 10)} ${pad('длит.', 8)} ${pad('пик', 6)} ${pad('увер.', 7)} ${pad('примечание', 22)}`);
for (const p of placements) {
  if (!p.audio) {
    console.log(`${pad(p.targetTimecode, 12)} ${pad(p.category, 11)} ${pad(p.frame, 6)} ${pad(p.strength.toFixed(2), 6)} ${pad('—', 8)} ${pad('—', 10)} ${pad('—', 8)} ${pad('—', 6)} ${pad('—', 7)} ${pad(p.note, 22)}`);
  } else {
    console.log(`${pad(p.targetTimecode, 12)} ${pad(p.category, 11)} ${pad(p.frame, 6)} ${pad(p.strength.toFixed(2), 6)} `
      + `${pad(p.audio.id, 8)} ${pad(p.audio.sourceTime.toFixed(3) + 'с', 10)} ${pad((p.audio.duration * 1000).toFixed(0) + 'мс', 8)} `
      + `${pad(p.audio.peak.toFixed(2), 6)} ${pad(p.confidence.toFixed(2), 7)} ${pad(p.review ? 'проверить' : '', 22)}`);
  }
}
console.log('='.repeat(112));

/* ---------- сводка по категориям ---------- */
const cats = [...new Set(events.map((e) => e.category))];
console.log('По категориям:');
for (const c of cats) {
  const evs = events.filter((e) => e.category === c);
  const done = placements.filter((p) => p.category === c && p.audio);
  const libN = library.filter((a) => a.category === c).length;
  const unique = new Set(done.map((p) => p.audio.id)).size;
  const repeats = evs.length - unique;
  const note = libN === 0 ? 'ДОРОЖКИ НЕТ — нужна запись'
    : repeats > 0 ? `повторов ${repeats} (дублей ${unique} на ${evs.length} событий)`
      : libN > unique ? 'все события без повторов, дубли остались' : 'все события без повторов, дублей ровно столько';
  console.log(`  ${c.padEnd(10)} событий ${String(evs.length).padStart(3)} · размещено ${String(done.length).padStart(3)} · уникальных дублей ${String(unique).padStart(3)} из ${String(libN).padStart(3)}  ${note}`);
}
const review = placements.filter((p) => p.review).length;
console.log(`Помечено «проверить»: ${review}`);
console.log(`Результат записан: ${OUT}`);

writeFileSync(OUT, `${JSON.stringify({
  fps: FPS,
  placements: placements.map((p) => ({
    frame: p.frame, timecode: p.targetTimecode, category: p.category,
    zone: p.zone, strength: p.strength,
    audio: p.audio ? {
      id: p.audio.id, file: p.audio.file, sourceTime: p.audio.sourceTime,
      cutFrom: p.audio.cutFrom, cutTo: p.audio.cutTo, track: p.audio.category,
    } : null,
    confidence: p.confidence ?? null,
    review: p.review ?? true,
    note: p.note ?? null,
  })),
}, null, 2)}\n`);

function tc(t, fps) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const f = Math.round((t - Math.floor(t)) * fps);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}
