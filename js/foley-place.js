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
    // источник (персонаж): если у события он задан, дубли берутся только из
    // его дорожки — шаг одного персонажа не встаёт на движение другого
    const cands = library.filter((a) => a.category === v.category
      && (!v.source || a.source === v.source));
    if (!cands.length) {
      placements.push({
        ...v, audio: null,
        note: `нет дорожки для категории «${v.category}»`,
      });
      continue;
    }
    const used = recent.get(v.category) || [];
    const scored = cands.map((a) => {
      // Стабильный id дубля. Индексатор даёт событиям порядковый номер `index`,
      // а не `id`. Без этого все дубли получали id === undefined, штраф за повтор
      // был одинаков для всех, и каждый шаг получал один и тот же звук:
      // 4 события на картинке давали четыре одинаковых дубля из 6.
      const aid = a.id != null ? a.id : `${a.file || a.track || a.category || ''}#${a.time}`;
      const raw = distance(v, a, w);
      const recentUses = used.filter((u) => u === aid).length;
      const totalUses = usedCount.get(aid) || 0;
      // Повтор одного и того же дубля — штраф, чтобы шаги не «заедали».
      const penalty = 0.35 * recentUses + usageWeight * totalUses;
      return { a, raw, score: raw + penalty };
    }).sort((x, y) => x.score - y.score);

    const best = scored[0];
    const id = best.a.id != null ? best.a.id : `${best.a.file || best.a.track || best.a.category || ''}#${best.a.time}`;
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
  const summary = { total: events.length, placed: 0, missing: 0, byCategory: {}, bySource: {} };
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
  // Звуки дорожек, для которых не нашлось события на картинке.
  // Это нормально: звукорежиссёр записывает дорожку до того, как персонаж
  // вошёл в кадр. Молча их терять нельзя — поэтому считаем.
  const usedIds = new Set(placements.filter((p) => p.audio).map((p) => p.audio.id));
  summary.libraryTotal = library.length;
  summary.libraryUsed = usedIds.size;
  summary.libraryUnused = library.length - usedIds.size;

  /* сводка по источникам (персонажам): сколько событий закреплено и где разошлись */
  const srcs = [...new Set(events.map((e) => e.source || ''))];
  for (const s of srcs) {
    const evs = events.filter((e) => (e.source || '') === s);
    const done = placements.filter((p) => (p.source || '') === s && p.audio);
    const libN = library.filter((a) => (a.source || '') === s).length;
    const unique = new Set(done.map((p) => p.audio.id)).size;
    summary.bySource[s || '—'] = {
      events: evs.length, placed: done.length, unique, library: libN,
      repeats: evs.length - unique,
      noTrack: s !== '' && libN === 0,
    };
  }

  return { placements, summary };
}

/**
 * Размещает звуки дорожек, для которых не нашлось события на картинке,
 * по их собственному времени со смещением offset.
 *
 * Зачем: дорожка чаще всего начинается РАНЬШЕ, чем персонаж появляется в кадре, — он ещё
 * за кадром. Детектор такие звуки не видит в принципе. Один из них пропадал бы молча.
 *
 * Помечаются review: так видно, что они поставлены не по картинке, а по времени записи.
 *
 * @param {Array} placements результат placeEvents
 * @param {Array} library    те же дубли
 * @param {object} opts {fps, offset, handles, keepUsed?}
 * @returns {{added:number, placements:Array}}
 */
export function placeLeftovers(placements, library, opts = {}) {
  const { fps = 25, offset = 0, handles = 0.05, keepUsed = true } = opts;
  const usedIds = new Set(placements.filter((p) => p.audio).map((p) => p.audio.id));
  const out = placements.slice();
  let added = 0;
  for (const a of library) {
    const aid = a.id != null ? a.id : `${a.file || a.track || a.category || ''}#${a.time}`;
    if (usedIds.has(aid)) continue;
    const t = a.time + offset;
    out.push({
      id: `lo-${aid}`,
      time: t,
      frame: Math.round(t * fps),
      category: a.category,
      source: a.source || '',
      strength: clamp01((a.peak ?? 0) / 1.5),
      duration: a.duration ?? 0.2,
      audio: {
        id: aid,
        file: a.file || null,
        track: a.track || a.category,
        sourceTime: a.time,
        duration: a.duration,
        peak: a.peak,
        centroid: a.centroid,
        band: a.band,
        cutFrom: Number((a.time - handles).toFixed(4)),
        cutTo: Number((a.time + Math.max(a.duration, 0.1) + handles).toFixed(4)),
      },
      review: true,
      note: 'по времени записи — на картинке события не было',
    });
    added++;
  }
  out.sort((x, y) => x.time - y.time);
  return { added, placements: out };
}
