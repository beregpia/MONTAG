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

/**
 * Сигнал движения: разница соседних кадров, из которой убрана глобальная
 * (камерная) составляющая и которая не разбавляется средним.
 *
 * Две правки против прежней кривой «среднее разницы соседних кадров».
 *
 * 1. РОБАСТНАЯ АГРЕГАЦИЯ. Прежнее среднее по ВСЕМ 576 ячейкам разбавляло
 *    маленький объект: стопа занимает 8 ячеек, и её вклад тонет в 48 раз.
 *    Берём среднее по верхним 1% ячеек (6 из 576) — объект любой величины
 *    попадает в них целиком, а не размазанный.
 *
 * 2. ВЫЧИТАНИЕ КАМЕРЫ. Тряска или панорама двигает ВСЕ ячейки, поэтому
 *    медиана разницы — это и есть движение камеры. Локальное движение =
 *    «сильные ячейки минус медиана».
 *
 * ЗАМЕР (/tmp/cmp2.mjs, 240 кадров, 12 fps, каденция 0.6 с, 40 шагов,
 * размер объекта 3/8/20/60 клеток × амплитуда 40/120 × тряска 0/0.35):
 *   новая кривая — ровно 40 шагов в 16 конфигурациях из 16
 *   старая кривая — ровно 40 лишь в 9 из 16, диапазон 23…43
 * Худший случай старой: объект 3 клетки, амплитуда 40, тряска — 23 шага
 * из 40, то есть больше половины потерь.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Первая версия считала разницу со скользящим фоном
 * (экспоненциальное среднее). Это правильно для «предмет присутствует», но
 * ломает детекцию СОБЫТИЙ: предмет, который остаётся в кадре, даёт ровный
 * сигнал, кривая выходит выше половины максимума на 100% времени, и
 * адаптивный порог перестаёт находиться — 40 шагов превращались в 0–1
 * событие. Для фоли нужен момент, а не присутствие, поэтому база — соседний
 * кадр.
 *
 * @param {Array<Uint8Array|Float32Array>} frames яркость по сетке
 * @param {Array<Uint8Array|Float32Array>|null} edges края по сетке
 * @param {object} opts
 *   topFrac    0..1 — доля самых сильных ячеек = локальное движение
 *   edgeWeight       — вес канала краёв
 * @returns {{score:Float32Array, global:Float32Array, edge:Float32Array}}
 *   массивы длины frames.length-1 (по шагам между кадрами)
 */
export function motionSignal(frames, edges = null, opts = {}) {
  const {
    // 1% = ~6 ячеек из 576. Замер на сцене «тряска + медленный шаг»:
    // p99−медиана даёт 67 для шага и 8 для тряски (8:1), а среднее по верхним
    // 15% — 11 против 5 (2:1), шаг тонет.
    topFrac = 0.01,
    edgeWeight = 0.6,
  } = opts;

  const n = frames.length;
  const steps = Math.max(0, n - 1);
  const out = {
    score: new Float32Array(steps),
    global: new Float32Array(steps),
    edge: new Float32Array(steps),
  };
  const cells = frames[0] ? frames[0].length : 0;
  if (steps <= 0 || cells <= 0) return out;
  const hasEdges = Array.isArray(edges) && edges.length === n && !!edges[0];

  const buf = new Float32Array(cells);
  const topK = Math.max(1, Math.round(cells * topFrac));

  for (let i = 1; i < n; i++) {
    const cur = frames[i];
    const prev = frames[i - 1];
    const curE = hasEdges ? edges[i] : null;
    const prevE = hasEdges ? edges[i - 1] : null;
    for (let c = 0; c < cells; c++) {
      const d = Math.abs(cur[c] - prev[c]);
      buf[c] = curE && prevE ? d + edgeWeight * Math.abs(curE[c] - prevE[c]) : d;
    }
    const sorted = Float32Array.from(buf).sort();
    // глобальная составляющая: камера сдвигает все ячейки, поэтому медиана
    const g = sorted[cells >> 1];
    // локальная: сильные клетки МиНУС медиана. Вычитание медианы и есть
    // подавление камеры: тряска поднимает все клетки разом, предмет — несколько.
    let top = 0;
    for (let k = cells - topK; k < cells; k++) top += sorted[k];
    top = Math.max(0, top / topK - g);

    const idx = i - 1;
    out.global[idx] = g;
    out.edge[idx] = curE && prevE ? top : 0;
    out.score[idx] = top;
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
    edges = null,
    ...detectOpts
  } = opts;

  // соседние кадры — только для «где в кадре»: разница с фоном шире по
  // времени и размазывает область
  const diffs = [];
  for (let f = 1; f < frames.length; f++) diffs.push(cellDiff(frames[f - 1], frames[f]));

  // а «когда» считаем по скользящему фону без камеры
  const sig = motionSignal(frames, edges, detectOpts);
  const curve = sig.score;
  const times = new Float32Array(diffs.length);
  for (let f = 0; f < diffs.length; f++) times[f] = (f + 0.5) / fps;

  const raw = detectMotionEvents(curve, times, detectOpts);

  const events = raw.map((e) => {
    const from = Math.max(0, e.index - Math.round(0.25 * fps));
    const to = Math.min(diffs.length - 1, e.index + Math.round(0.25 * fps));
    // «контакт» — не третье название пика, а отдельная точка: провал между
    // махом и переносом тела. Для фоли это и есть кадр, куда ставить дубль.
    const ci = at === 'contact' ? contactFrame(curve, from, to) : e.index;
    const t = times[ci];
    return {
      ...e,
      time: at === 'onset' ? e.onset : at === 'end' ? e.end : t,
      frame: Math.round((at === 'onset' ? e.onset : at === 'end' ? e.end : t) * fps),
      contactIndex: ci,
      duration: Math.max(0.04, e.end - e.onset),
      regions: hotRegions(diffs, from, to, gridW, gridH, frac),
    };
  });

  return { events, curve, times, diffs, gridW, gridH, signal: sig };
}

/**
 * Кадр контакта внутри отрезка движения.
 *
 * Пик кривой — это середина замаха, а не касание. У шага энергия внутри
 * отрезка выглядит как «всплеск → провал → всплеск»: мах ногой, постановка
 * стопы, перенос тела. Контакт — это провал между двумя всплесками: стопа
 * касается пола и на мгновение замирает.
 *
 * Если всплеск один (короткое движение без выраженной остановки), возвращаем
 * пик. Догадывать нечем, а калибровка по ручным меткам уточнит и его.
 *
 * @param {Float32Array} curve огибающая движения
 * @param {number} from индекс начала отрезка
 * @param {number} to   индекс конца отрезка
 * @returns {number} индекс кадра контакта
 */
export function contactFrame(curve, from, to) {
  if (!curve || to <= from) return from;
  // локальные максимумы; соседи, отстоящие меньше чем на 2 шага, — это
  // плато, а не второй всплеск
  const peaks = [];
  for (let i = from; i <= to; i++) {
    if (curve[i] <= 0) continue;
    const l = i > from ? curve[i - 1] : -Infinity;
    const r = i < to ? curve[i + 1] : -Infinity;
    if (curve[i] >= l && curve[i] >= r && (!peaks.length || i - peaks[peaks.length - 1] >= 2)) {
      peaks.push(i);
    }
  }
  if (peaks.length >= 2) {
    let c = peaks[0];
    for (let i = peaks[0]; i <= peaks[1]; i++) if (curve[i] < curve[c]) c = i;
    // Провал обязан быть настоящим. Плато между двумя «всплесками» — это
    // один всплеск, а не мах и стопа: городить на нём контакт значило бы
    // выдумать постановку там, где движение просто не менялось.
    const dip = Math.min(curve[peaks[0]], curve[peaks[1]]);
    if (curve[c] < 0.7 * dip) return c;
  }
  let p = from;
  for (let i = from; i <= to; i++) if (curve[i] > curve[p]) p = i;
  return p;
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

/**
 * Магнитуда краёв (Собел) по промежуточному холсту, приведённая к сетке.
 *
 * Зачем второй канал: яркость не видит тёмное на тёмном. Тёмная одежда на
 * тёмном фоне, шаг в тени, движение «только по плечам» дают почти нулевую
 * разницу яркости — и огромную разницу краёв. Именно этот случай и есть
 * «герой начался за кадром, шаг виден по плечам».
 *
 * Считаем на промежуточном холсте (160×90), а не на сетке: сжатие до 32×18
 * стирает тонкие края до алиасинга.
 *
 * @param {Uint8ClampedArray} data RGBA промежуточного холста
 * @returns {Float32Array} магнитуда 0..255 по клеткам сетки
 */
function sobelGrid(data, mw, mh, gridW, gridH) {
  const lum = new Float32Array(mw * mh);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  const mag = new Float32Array(mw * mh);
  for (let y = 1; y < mh - 1; y++) {
    for (let x = 1; x < mw - 1; x++) {
      const i = y * mw + x;
      const tl = lum[i - mw - 1]; const t = lum[i - mw]; const tr = lum[i - mw + 1];
      const l = lum[i - 1]; const r = lum[i + 1];
      const bl = lum[i + mw - 1]; const b = lum[i + mw]; const br = lum[i + mw + 1];
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      mag[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  // среднее по клетке: клетка сетки — это блок midW/gridW пикселей
  const out = new Float32Array(gridW * gridH);
  const cw = mw / gridW;
  const ch = mh / gridH;
  for (let gy = 0; gy < gridH; gy++) {
    const y0 = Math.floor(gy * ch);
    const y1 = Math.min(mh, Math.max(y0 + 1, Math.ceil((gy + 1) * ch)));
    for (let gx = 0; gx < gridW; gx++) {
      const x0 = Math.floor(gx * cw);
      const x1 = Math.min(mw, Math.max(x0 + 1, Math.ceil((gx + 1) * cw)));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) { sum += mag[y * mw + x]; n++; }
      }
      out[gy * gridW + gx] = n ? sum / n : 0;
    }
  }
  // к шкале яркости: максимум Собела — 4*255
  for (let c = 0; c < out.length; c++) out[c] = Math.min(255, out[c] / 4);
  return out;
}

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
  const edges = [];
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
      // второй канал: края. Видит движение, которого не видит яркость.
      const e = sobelGrid(mctx.getImageData(0, 0, mid.width, mid.height).data,
        mid.width, mid.height, gridW, gridH);
      frames.push(g);
      edges.push(e);
      times.push(t);
    } catch {
      // кадр не отдался — пропускаем, разрыв переживёт
    }

    if (onProgress && (i % 5 === 0 || i === n - 1)) onProgress((i + 1) / n);
  }

  return { frames, edges, times, fps };
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
    // контакт, а не пик: пик — середина замаха. Для фоли важен кадр,
    // в который стопа касается пола.
    at = 'contact',
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

  const coarseRes = analyzeFrames(scan.frames, coarse, {
    gridW, gridH, at, edges: scan.edges, ...detectOpts,
  });

  // уточнение: пересканируем вокруг каждого грубого события
  const win = 0.3;
  // Разогрев. Фон — экспоненциальное среднее, и в окне ровно ±0.3 с первые
  // ~8 шагов уходят на его раскрутку: кривая в них занижена, порог считается
  // по нерасскрученному участку. Берём с запасом и используем только середину.
  const pad = 0.4;
  const fineFrames = [];
  const fineEdges = [];
  const spans = [];
  for (const e of coarseRes.events) {
    const t0 = Math.max(0, e.time - win - pad);
    const t1 = e.time + win + pad;
    const r = await scanFrames(video, {
      fps, t0, t1, gridW, gridH, signal,
      onProgress: (p) => onProgress?.({
        phase: 'refine',
        ratio: (spans.length + p) / Math.max(1, coarseRes.events.length),
      }),
    });
    if (r.frames.length >= 2) {
      spans.push({
        base: fineFrames.length, offset: r.times[0], fps, count: r.frames.length, around: e.time,
      });
      for (const f of r.frames) fineFrames.push(f);
      if (r.edges?.length === r.frames.length) for (const g of r.edges) fineEdges.push(g);
      else for (let k = 0; k < r.frames.length; k++) fineEdges.push(null);
    }
  }

  if (!spans.length) return coarseRes;

  // разбор каждого уточнённого окна отдельно и склейка
  const events = [];
  for (const s of spans) {
    const slice = fineFrames.slice(s.base, s.base + s.count);
    const eSlice = fineEdges.slice(s.base, s.base + s.count);
    const r = analyzeFrames(slice, s.fps, {
      gridW, gridH, at, edges: eSlice.some((x) => x) ? eSlice : null, ...detectOpts,
    });
    for (const e of r.events) {
      const t = e.time + s.offset;
      // за пределами ±win от грубого события не берём: разогрев дан запасом,
      // а не лицензией находить новые события в чужом окне
      if (Math.abs(t - s.around) > win + 0.05) continue;
      events.push({ ...e, time: t, frame: e.frame + Math.round(s.offset * s.fps) });
    }
  }
  events.sort((a, b) => a.time - b.time);

  return { ...coarseRes, events };
}
