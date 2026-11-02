/* ============ Фильтр «похоже на шаг» ============
 *
 * Детектор движения видит движение вообще: шаг, взмах руки, поворот головы,
 * дрожь камеры, блик на стекле. Категорию монтажёр назначал сам, и в списке
 * событий лезло всё подряд — «детектор отдаёт движение вообще».
 *
 * Шаг узнаётся по четырём признакам. Все считаются по данным, которые детектор
 * и так уже посчитал, — новых проходов по видео не надо:
 *
 *   1. каденция ~0.6 с  — пауза между шагами. Рука машет когда угодно,
 *                         а шаги выдерживают ритм.
 *   2. низкая частота   — удар ступни тяжёлый и короткий: событие не
 *                         мгновенный блеск (ткань) и не залившийся жест.
 *   3. уровень пола     — «горячая» область в нижней части кадра: ступни.
 *   4. шаг вперёд       — идущий человек смещает область по горизонтали;
 *                         жест на месте её не двигает.
 *
 * Чередование левый-правый по этой сетке не различить: ступни стоят в
 * нескольких сантиметрах друг от друга, а ячейка сетки — уже грубая площадь
 * кадра. Поэтому вместо «какая нода» смотрим на смещение области: шаг идущего
 * её двигает, жест — нет. Сторона кадра (`stepSide`) остаётся как справка.
 *
 * Оценка 0..1 на событие. Оценка НЕ выкидывает события молча: панель
 * показывает, сколько отобрано, и фильтр можно выключить флажком.
 */

/** Идеальная каденция шага, с. Ходьба человека — 0.5..0.7. */
export const STEP_CADENCE = 0.6;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Гладкий колокол: 1 в центре, 0 на границе окна и за ней.
 * @param {number} x
 * @param {number} center
 * @param {number} half ширина полуокна; <=0 → всегда 0
 */
function bell(x, center, half) {
  if (!(half > 0) || !isFinite(x)) return 0;
  const d = Math.abs(x - center) / half;
  if (d >= 1) return 0;
  return Math.cos((d * Math.PI) / 2) ** 2;
}

/** Плавный порог: 0 ниже `lo`, 1 выше `hi`. */
function ramp(v, lo, hi) {
  if (!isFinite(v)) return 0;
  if (!(hi > lo)) return v >= hi ? 1 : 0;
  if (v <= lo) return 0;
  if (v >= hi) return 1;
  const t = (v - lo) / (hi - lo);
  return t * t * (3 - 2 * t);   // smoothstep
}

/** Медиана списка без нулей; пустой список → 0. */
function medianOf(arr) {
  const a = arr.filter((v) => isFinite(v) && v !== 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const cy = (r) => (r ? (Number(r.y) + (Number(r.h) || 0) / 2) : null);
const cx = (r) => (r ? (Number(r.x) + (Number(r.w) || 0) / 2) : null);

/**
 * Оценить, насколько каждое событие похоже на шаг.
 *
 * @param {Array<{time:number,duration?:number,region?:object|null,
 *                strength?:number}>} events в хронологическом порядке
 * @param {object} [opts]
 * @param {number} [opts.cadence=0.6] идеальная пауза между шагами, с
 * @param {number} [opts.threshold=0.45] с какой оценки событие считается шагом
 * @returns {{events:Array, kept:number, dropped:number, alternations:number}}
 *   events — те же объекты, каждому дописаны:
 *     step     0..1 — оценка «похожести на шаг»
 *     stepSide 'L'|'R'|null — в какой половине кадра движение
 *     stepWhy  короткая причина для подсказки
 *   alternations — сколько раз принятые шаги сменили половину кадра
 */
export function stepScore(events, opts = {}) {
  const { cadence = STEP_CADENCE, threshold = 0.45 } = opts;
  const list = Array.isArray(events) ? events.slice() : [];

  let lastStep = null;      // {t, x, y} предыдущего ПРИНЯТОГО шага
  const strides = [];       // на сколько область смещалась у принятых шагов
  let prevSide = null;
  let alternations = 0;

  for (const e of list) {
    /* 1. каденция: пауза до предыдущего принятого шага */
    let cad = null;
    let cadTxt = '';
    if (lastStep) {
      const gap = e.time - lastStep.t;
      cad = bell(gap, cadence, cadence * 0.6);
      cadTxt = `пауза ${gap.toFixed(2)} с`;
    }

    /* 2. низкая частота: удар ступни короткий и заметный */
    const dur = Number(e.duration);
    let heavy = null;
    if (isFinite(dur) && dur > 0) {
      heavy = Math.max(
        bell(dur, 0.22, 0.18),        // сам удар ~0.2 с
        bell(dur, 0.35, 0.25) * 0.6,  // перенос тела длиннее, но тоже шаг
      );
    }

    /* 3. уровень пола: область в нижней части кадра */
    const yy = cy(e.region);
    const floor = yy === null ? null : ramp(yy, 0.32, 0.72);

    /* 4. шаг вперёд: смещение области согласовано с обычным шагом.
     *
     * Сравнивать «сместился ли вообще» бесполезно: жест в другом месте кадра
     * тоже смещён и получал бесплатные баллы — на смеси шагов и взмаха рук
     * фильтр пропускал часть взмаха (замер: 13 из 20 вместо 10). Сравниваем с
     * тем, на сколько обычно смещается область у ПРИНЯТЫХ шагов: идущий
     * человек шагает примерно на одно и то же расстояние, жест — как угодно.
     * Идущий на месте (область не ездит) признак просто выключается. */
    const xx = cx(e.region);
    let fwd = null;
    if (xx !== null && lastStep && strides.length) {
      const stride = medianOf(strides);
      if (stride > 0.005) fwd = bell((xx - lastStep.x) / stride, 1, 0.85);
    }

    /* Среднее по тем признакам, которые вообще есть. Событие без области не
     * штрафуется за отсутствие геометрии — за неё отвечает каденция. */
    let w = 0;
    let s = 0;
    const why = [];
    if (cad !== null) {
      w += 0.35; s += 0.35 * cad;
      if (cad > 0.5) why.push(cadTxt);
    }
    if (floor !== null) {
      w += 0.3; s += 0.3 * floor;
      if (floor > 0.5) why.push('низ кадра');
    }
    if (heavy !== null) {
      w += 0.15; s += 0.15 * heavy;
      if (heavy > 0.5) why.push('удар ступни');
    }
    if (fwd !== null) {
      w += 0.2; s += 0.2 * fwd;
      if (fwd > 0.5) why.push('смещение вперёд');
    }

    const step = w > 0 ? clamp01(s / w) : 0;
    const side = xx === null ? null : (xx < 0.5 ? 'L' : 'R');
    e.step = step;
    e.stepSide = side;
    e.stepWhy = why.length ? why.join(', ') : 'ритм или место не те';

    if (step >= threshold) {
      if (lastStep && xx !== null && lastStep.x !== null) {
        strides.push(xx - lastStep.x);
      }
      lastStep = { t: e.time, x: xx, y: yy };
      if (side && prevSide && side !== prevSide) alternations++;
      if (side) prevSide = side;
    }
  }

  const kept = list.filter((e) => e.step >= threshold).length;
  return { events: list, kept, dropped: list.length - kept, alternations };
}

/**
 * Короткая сводка для панели: сколько событий прошли фильтр и почему.
 * @returns {string} человекочитаемая строка, '' если событий нет
 */
export function stepSummary(res, onlySteps) {
  if (!res || !res.events.length) return '';
  if (!onlySteps) {
    return `событий: ${res.events.length} · фильтр «только шаги» выключен`;
  }
  return `похожих на шаги: ${res.kept} из ${res.events.length}`
    + ` (отобрано ${res.dropped}) · смена стороны кадра: ${res.alternations}`;
}
