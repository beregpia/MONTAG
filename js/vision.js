/* ============ Детект движения в кадре ============
 *
 * Первое звено конвейера фоли: найти в картинке моменты, когда что-то
 * двинулось, и сказать в каком месте кадра. Без ML и без моделей —
 * покадровая разница по сетке, тот же приём, что и в аудио-детекторе
 * (`js/onset.js`): адаптивный порог + локальные максимумы + min-gap.
 *
 * Почему сетка, а не оптический поток: поток даёт точность до пикселя,
 * но стоит на порядок дороже и требует нормализации. Для расстановки фоли
 * достаточно знать «когда» и «в каком углу кадра» — звук берётся из
 * библиотеки, а не синтезируется из движения.
 *
 * Честное ограничение: детектор находит ДВИЖЕНИЕ, а не «шаг» или «руку».
 * Категорию задаёт человек (или обученный классификатор), а этот модуль
 * даёт время и место. Точный кадр контакта получается калибровкой:
 * монтажёр отмечает несколько кадров вручную, модуль считает смещение.
 */

/** Сетка по умолчанию: 32×18 ≈ 576 ячеек, хватает для «где в кадре». */
export const GRID_W = 32;
export const GRID_H = 18;

/**
 * По-ячейная разница двух соседних кадров.
 * @param {Uint8Array} prev яркость ячеек 0..255
 * @param {Uint8Array} next
 * @returns {Float32Array} |next-prev| по каждой ячейке
 */
export function cellDiff(prev, next) {
  const n = Math.min(prev.length, next.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.abs(next[i] - prev[i]);
  return out;
}

/**
 * Сигнал энергии движения: средняя по сетке разница на каждый шаг.
 * @param {Array<Float32Array|Uint8Array>} diffs
 * @returns {Float32Array} кривая длины diffs.length
 */
export function motionCurve(diffs) {
  const out = new Float32Array(diffs.length);
  for (let f = 0; f < diffs.length; f++) {
    const d = diffs[f];
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i];
    out[f] = d.length ? s / d.length : 0;
  }
  return out;
}

/** Медиана (копия, чтобы не портить исходный массив). */
function median(arr) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Процентиль. */
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
  return s[i];
}

function maxOf(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * События движения: где кривая движения пересекает адаптивный порог.
 *
 * Порог устроен как в аудио-детекторе: медиана + доля разброса до 90-го
 * процентиля. Жёсткий порог не работает — в тихих сценах он не поймает
 * ничего, в шумных — всё подряд.
 *
 * @param {Float32Array} curve  энергия движения на шаг
 * @param {Float32Array} times  время каждого шага, секунды
 * @param {object} opts
 *   sensitivity 0.2..3 — выше = больше событий
 *   minGap      секунды между событиями
 *   maxEvents
 * @returns {{index:number, time:number, onset:number, peak:number, end:number, strength:number}[]}
 */
export function detectMotionEvents(curve, times, opts = {}) {
  const {
    // Порог считается как med + sensitivity * (p90 - med). При 1.0 детектор
    // брал только верхние 10% движения и на обычной ходьбе терял больше половины
    // шагов (замер: 20 событий вместо 33). 0.55 — тот уровень, где находятся и
    // сильные, и слабые шаги, а фоновая нестабильность камеры отсекается.
    sensitivity = 0.55,
    minGap = 0.12,
    maxEvents = 400,
  } = opts;

  const n = curve.length;
  if (n < 3 || !times || times.length < n) return [];

  const med = median(curve);
  const p90 = percentile(curve, 0.9);
  const p95 = percentile(curve, 0.95);
  const mx = maxOf(curve);
  if (mx <= 0) return [];

  const thr = med + sensitivity * Math.max(p90 - med, mx * 0.01);
  const floor = Math.max(mx * 0.04, med * 1.5);

  // границы «выше порога» — отрезки движения
  const spans = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (curve[i] >= thr && start < 0) start = i;
    else if (curve[i] < thr && start >= 0) { spans.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) spans.push([start, n - 1]);

  // Склеиваем отрезки, разделённые коротким провалом. В реальном движении
  // бывает пауза на полушаге (нога останавливается в верхней точке, рука
  // замирает на повороте) — без склейки один жест превращался в два события,
  // и на шахматном шаге это давало ровно вдвое больше маркеров, чем надо.
  const mergeGap = Math.max(minGap, 0.1);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && times[a] - times[last[1]] <= mergeGap) last[1] = b;
    else merged.push([a, b]);
  }

  const events = [];
  let lastKept = -Infinity;
  for (const [a, b] of merged) {
    if (b - a < 0) continue;
    // пик внутри отрезка
    let pi = a;
    for (let i = a; i <= b; i++) if (curve[i] > curve[pi]) pi = i;
    const t = times[pi];
    if (t - lastKept < minGap) continue;
    if (curve[pi] < floor) continue;

    events.push({
      index: pi,
      time: t,
      onset: times[a],
      peak: times[pi],
      end: times[b],
      strength: clamp01((curve[pi] - med) / Math.max(p95 - med, 1e-9)),
    });
    lastKept = t;
    if (events.length >= maxEvents) break;
  }

  return events;
}

/**
 * «Горячие» области кадра за отрезок времени: прямоугольники ячеек,
 * энергия которых выше доли от максимума. Даёт ответ «где двигалось».
 *
 * @param {Array<Float32Array>} diffs пошаговые разницы
 * @param {number} from индекс шага (включительно)
 * @param {number} to   индекс шага (включительно)
 * @param {number} gridW
 * @param {number} gridH
 * @param {number} frac 0..1 — доля от максимальной энергии ячейки
 * @returns {{x:number,y:number,w:number,h:number,energy:number}[]} в долях кадра
 */
export function hotRegions(diffs, from, to, gridW, gridH, frac = 0.5) {
  const cells = gridW * gridH;
  const sum = new Float32Array(cells);
  let count = 0;
  for (let f = Math.max(0, from); f <= Math.min(diffs.length - 1, to); f++) {
    const d = diffs[f];
    if (!d) continue;
    for (let c = 0; c < cells && c < d.length; c++) sum[c] += d[c];
    count++;
  }
  if (!count) return [];

  let mx = 0;
  for (let c = 0; c < cells; c++) if (sum[c] > mx) mx = sum[c];
  if (mx <= 0) return [];

  const limit = mx * frac;
  const on = new Uint8Array(cells);
  for (let c = 0; c < cells; c++) on[c] = sum[c] >= limit ? 1 : 0;

  // связные области по 4 соседям, с простым обходом в глубину
  const seen = new Uint8Array(cells);
  const out = [];
  for (let c = 0; c < cells; c++) {
    if (!on[c] || seen[c]) continue;
    const stack = [c];
    seen[c] = 1;
    let minX = gridW; let maxX = -1;
    let minY = gridH; let maxY = -1;
    let energy = 0;
    let size = 0;
    while (stack.length) {
      const i = stack.pop();
      const x = i % gridW;
      const y = (i - x) / gridW;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      energy += sum[i];
      size++;
      const neigh = [
        x > 0 ? i - 1 : -1,
        x < gridW - 1 ? i + 1 : -1,
        y > 0 ? i - gridW : -1,
        y < gridH - 1 ? i + gridW : -1,
      ];
      for (const j of neigh) {
        if (j >= 0 && on[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (size < 2) continue; // одиночная ячейка — шум
    out.push({
      x: minX / gridW,
      y: minY / gridH,
      w: (maxX - minX + 1) / gridW,
      h: (maxY - minY + 1) / gridH,
      energy: energy / (count * mx),
    });
  }

  out.sort((a, b) => b.energy - a.energy);
  return out;
}

/**
 * Полный размотр кадров → события движения.
 *
 * @param {Array<Uint8Array>} frames яркость по сетке, длина gridW*gridH
 * @param {number} fps
 * @param {object} opts  см. detectMotionEvents + {gridW, gridH, at, frac}
 *   at 'peak'|'onset'|'end' — какое время считать временем события
 * @returns {{events:object[], curve:Float32Array, times:Float32Array,
 *            diffs:Float32Array[], gridW:number, gridH:number}}
 */
export function analyzeFrames(frames, fps, opts = {}) {
  const {
    gridW = GRID_W,
    gridH = GRID_H,
    at = 'peak',
    frac = 0.5,
    ...detectOpts
  } = opts;

  const diffs = [];
  for (let f = 1; f < frames.length; f++) diffs.push(cellDiff(frames[f - 1], frames[f]));

  const curve = motionCurve(diffs);
  const times = new Float32Array(diffs.length);
  for (let f = 0; f < diffs.length; f++) times[f] = (f + 0.5) / fps;

  const raw = detectMotionEvents(curve, times, detectOpts);

  const events = raw.map((e) => {
    const from = Math.max(0, e.index - Math.round(0.25 * fps));
    const to = Math.min(diffs.length - 1, e.index + Math.round(0.25 * fps));
    return {
      ...e,
      time: at === 'onset' ? e.onset : at === 'end' ? e.end : e.peak,
      frame: Math.round((at === 'onset' ? e.onset : at === 'end' ? e.end : e.peak) * fps),
      duration: Math.max(0.04, e.end - e.onset),
      regions: hotRegions(diffs, from, to, gridW, gridH, frac),
    };
  });

  return { events, curve, times, diffs, gridW, gridH };
}

/**
 * Калибровка точного кадра: монтажёр отмечал контакты вручную, детектор
 * нашёл пики рядом. Считаем медианное смещение между отмеченным кадром и
 * тем, что выбрал детектор, — и применяем его ко всем событиям.
 *
 * Без этой поправки детектор систематически ошибается: пик движения — это
 * середина замаха, а не момент касания.
 *
 * @param {{time:number}[]} marks  отмеченные монтажёром моменты, секунды
 * @param {object[]} events        события из analyzeFrames
 * @param {number} fps
 * @returns {{offset:number, used:number}} смещение в секундах
 */
export function calibrateOffset(marks, events, fps) {
  if (!marks?.length || !events?.length) return { offset: 0, used: 0 };
  const diffs = [];
  for (const m of marks) {
    // ближайшее событие по времени
    let best = null;
    let bd = Infinity;
    for (const e of events) {
      const d = Math.abs(e.time - m.time);
      if (d < bd) { bd = d; best = e; }
    }
    if (best && bd <= 0.5) diffs.push(m.time - best.time);
  }
  if (!diffs.length) return { offset: 0, used: 0 };
  return { offset: median(diffs), used: diffs.length };
}

/* ---------- извлечение кадров из видео (браузер) ---------- */

/** Ждём, пока видео встанет на нужную позицию. */
function seekTo(video, t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-3) { resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      resolve();
    };
    video.addEventListener('seeked', finish);
    try { video.currentTime = t; } catch { finish(); return; }
    setTimeout(finish, 3000); // страховка: не подвешиваем разбор
  });
}

/**
 * Вынимает кадры из видео и приводит их к сетке яркости.
 *
 * Двухшаговое уменьшение (видео → промежуточный → сетка): прямое сжатие
 * 1920×882 в 32×18 теряет тонкие быстрые предметы из-за алиасинга.
 *
 * @param {HTMLVideoElement} video
 * @param {object} opts {fps, t0, t1, gridW, gridH, midW, onProgress, signal}
 * @returns {Promise<{frames:Uint8Array[], times:number[], fps:number}>}
 */
export async function scanFrames(video, opts = {}) {
  const {
    fps = 25,
    t0 = 0,
    t1 = null,
    gridW = GRID_W,
    gridH = GRID_H,
    midW = 160,
    onProgress = null,
    signal = null,
  } = opts;

  const dur = isFinite(video.duration) ? video.duration : 0;
  const end = t1 == null ? dur : Math.min(dur, t1);
  const start = Math.max(0, t0);
  if (end <= start) return { frames: [], times: [], fps };

  const n = Math.max(2, Math.floor((end - start) * fps) + 1);

  const mid = document.createElement('canvas');
  mid.width = midW;
  mid.height = Math.max(1, Math.round(midW * gridH / gridW));
  const mctx = mid.getContext('2d', { willReadFrequently: true });

  const grid = document.createElement('canvas');
  grid.width = gridW;
  grid.height = gridH;
  const gctx = grid.getContext('2d', { willReadFrequently: true });

  const frames = [];
  const times = [];

  for (let i = 0; i < n; i++) {
    if (signal?.aborted) break;
    const t = start + i / fps;
    await seekTo(video, t);
    if (signal?.aborted) break;

    try {
      mctx.drawImage(video, 0, 0, mid.width, mid.height);
      gctx.drawImage(mid, 0, 0, gridW, gridH);
      const data = gctx.getImageData(0, 0, gridW, gridH).data;
      const g = new Uint8Array(gridW * gridH);
      for (let c = 0, p = 0; c < g.length; c++, p += 4) {
        g[c] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
      }
      frames.push(g);
      times.push(t);
    } catch {
      // кадр не отдался — пропускаем, разрыв переживёт
    }

    if (onProgress && (i % 5 === 0 || i === n - 1)) onProgress((i + 1) / n);
  }

  return { frames, times, fps };
}

/**
 * Разбор видео целиком: грубый проход по всем кадрам, затем уточнение
 * каждого события в узком окне на полном fps.
 *
 * Грубый проход на низком fps — иначе 60 секунд это 1500 seek'ов и минута
 * ожидания. Уточнение касается только найденного, поэтому стоит копейки.
 *
 * @param {HTMLVideoElement} video
 * @param {object} opts {fps, coarseFps, gridW, gridH, at, onProgress, signal}
 */
export async function analyzeVideo(video, opts = {}) {
  const {
    fps = 25,
    coarseFps = null,
    gridW = GRID_W,
    gridH = GRID_H,
    at = 'peak',
    onProgress = null,
    signal = null,
    ...detectOpts
  } = opts;

  const coarse = coarseFps || Math.max(6, Math.min(fps, 12));

  onProgress?.({ phase: 'scan', ratio: 0 });
  const scan = await scanFrames(video, {
    fps: coarse, gridW, gridH, onProgress: (r) => onProgress?.({ phase: 'scan', ratio: r }), signal,
  });
  if (scan.frames.length < 3) {
    return { events: [], curve: new Float32Array(0), times: new Float32Array(0), diffs: [], gridW, gridH };
  }

  const coarseRes = analyzeFrames(scan.frames, coarse, { gridW, gridH, at, ...detectOpts });

  // уточнение: пересканируем ±0.3 с вокруг каждого грубого события
  const win = 0.3;
  const fineFrames = [];
  const fineTimes = [];
  const spans = [];
  for (const e of coarseRes.events) {
    const t0 = Math.max(0, e.time - win);
    const t1 = e.time + win;
    const r = await scanFrames(video, {
      fps, t0, t1, gridW, gridH, signal,
      onProgress: (p) => onProgress?.({
        phase: 'refine',
        ratio: (spans.length + p) / Math.max(1, coarseRes.events.length),
      }),
    });
    if (r.frames.length >= 2) {
      spans.push({ base: fineFrames.length, offset: r.times[0], fps, count: r.frames.length });
      for (const f of r.frames) fineFrames.push(f);
      for (const t of r.times) fineTimes.push(t);
    }
  }

  if (!spans.length) return coarseRes;

  // разбор каждого уточнённого окна отдельно и склейка
  const events = [];
  for (const s of spans) {
    const slice = fineFrames.slice(s.base, s.base + s.count);
    const r = analyzeFrames(slice, s.fps, { gridW, gridH, at, ...detectOpts });
    for (const e of r.events) {
      events.push({ ...e, time: e.time + s.offset, frame: e.frame + Math.round(s.offset * s.fps) });
    }
  }
  events.sort((a, b) => a.time - b.time);

  return { ...coarseRes, events };
}
