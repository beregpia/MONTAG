/* ============ Размещение фоли по картинке (браузерная версия) ============
 *
 * Порт tools/place-foley.mjs на ES-модули приложения: сопоставляет события на
 * картинке с дублями из библиотеки и выдаёт расстановку «кадр → откуда резать».
 *
 * Категорий не знает заранее — они приходят из имён дорожек. Неизвестная
 * категория работает на общем профиле.
 *
 * Чистые функции: работают и в браузере, и в Node (тесты).
 */

/* Профили категорий: веса дескрипторов и порог сегментации. Список открытый. */
export const PROFILES = {
  steps: { weights: { strength: 0.5, band: 0.2, centroid: 0.15, duration: 0.15 }, minGap: 0.3 },
  hands: { weights: { strength: 0.45, band: 0.25, centroid: 0.15, duration: 0.15 }, minGap: 0.12 },
  cloth: { weights: { strength: 0.35, band: 0.25, centroid: 0.2, duration: 0.2 }, minGap: 0.2 },
  door: { weights: { strength: 0.5, band: 0.25, centroid: 0.1, duration: 0.15 }, minGap: 0.3 },
  default: { weights: { strength: 0.4, band: 0.25, centroid: 0.2, duration: 0.15 }, minGap: 0.15 },
};

export function profileOf(category) {
  return PROFILES[category] || PROFILES.default;
}

const BAND = { low: 0, mid: 1, high: 2 };
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function distance(v, a, w) {
  const dStrength = Math.abs((v.strength ?? 0.5) - clamp01((a.peak ?? 0) / 1.5));
  const dBand = Math.abs((BAND[v.band] ?? 1) - (BAND[a.band] ?? 1)) / 2;
  const dCentroid = Math.abs(Math.log((v.centroid ?? 2000) + 1) - Math.log((a.centroid ?? 2000) + 1)) / Math.log(20000);
  const dDur = Math.abs(Math.log((v.duration ?? 0.2) + 0.05) - Math.log((a.duration ?? 0.2) + 0.05)) / Math.log(20);
  return w.strength * dStrength + w.band * dBand + w.centroid * dCentroid + w.duration * dDur;
}

/**
 * @param {Array} videoEvents  события на картинке: {frame, time, category, strength?, duration?, band?, centroid?}
 * @param {Array} library      дубли: {id, time, peak, duration, band?, centroid?, category, track, file}
 * @param {{fps?:number, cooldown?:number, usageWeight?:number, handles?:number}} opts
 * @returns {{placements:Array, summary:Object}}
 */
export function placeEvents(videoEvents, library, opts = {}) {
  const {
    fps = 25, cooldown = 4, usageWeight = 0.12, handles = 0.05,
  } = opts;

  const events = (videoEvents || []).slice().sort((a, b) => a.time - b.time);
  const recent = new Map();
  const usedCount = new Map();
  const placements = [];

  for (const v of events) {
    const w = profileOf(v.category).weights;
    const cands = library.filter((a) => a.category === v.category);
    if (!cands.length) {
      placements.push({
        ...v, audio: null,
        note: `нет дорожки для категории «${v.category}»`,
      });
      continue;
    }
    const used = recent.get(v.category) || [];
    const scored = cands.map((a) => {
      const raw = distance(v, a, w);
      const recentUses = used.filter((u) => u === a.id).length;
      const totalUses = usedCount.get(a.id) || 0;
      // Повтор одного и того же дубля — штраф, чтобы шаги не «заедали».
      const penalty = 0.35 * recentUses + usageWeight * totalUses;
      return { a, raw, score: raw + penalty };
    }).sort((x, y) => x.score - y.score);

    const best = scored[0];
    const id = best.a.id;
    const arr = recent.get(v.category) || [];
    arr.push(id);
    recent.set(v.category, arr.slice(-cooldown));
    usedCount.set(id, (usedCount.get(id) || 0) + 1);

    placements.push({
      ...v,
      audio: {
        id,
        file: best.a.file || null,
        track: best.a.track || best.a.category,
        sourceTime: best.a.time,
        duration: best.a.duration,
        peak: best.a.peak,
        centroid: best.a.centroid,
        band: best.a.band,
        cutFrom: Number((best.a.time - handles).toFixed(4)),
        cutTo: Number((best.a.time + Math.max(best.a.duration, 0.1) + handles).toFixed(4)),
      },
      confidence: Number((1 - best.raw).toFixed(3)),
      review: best.raw > 0.35,
    });
  }

  /* сводка по категориям */
  const cats = [...new Set(events.map((e) => e.category))];
  const summary = { total: events.length, placed: 0, missing: 0, byCategory: {} };
  for (const c of cats) {
    const evs = events.filter((e) => e.category === c);
    const done = placements.filter((p) => p.category === c && p.audio);
    const libN = library.filter((a) => a.category === c).length;
    const unique = new Set(done.map((p) => p.audio.id)).size;
    summary.byCategory[c] = {
      events: evs.length, placed: done.length, unique, library: libN,
      repeats: evs.length - unique,
      noTrack: libN === 0,
    };
    summary.placed += done.length;
  }
  summary.missing = summary.total - summary.placed;

  return { placements, summary };
}
