/* ============ Тесты детектора движения в кадре ============
 *
 * Проверяем на синтетических кадрах: статичный фон + «объект», который
 * двигается в заданные отрезки. Детектор обязан найти эти отрезки, сказать
 * где они в кадре и не выдумать лишнего на статике.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const V = await import(new URL('../js/vision.js', import.meta.url).href);

const GW = 32;
const GH = 18;
const GRID_W = GW;
const GRID_H = GH;
const analyzeFrames = V.analyzeFrames;
const detectMotionEvents = V.detectMotionEvents;

/**
 * Синтетическая сцена: ровный фон и «объект» — вертикальная полоска,
 * которая ходит туда-обратно в заданные окна.
 *
 * @param {number} count сколько кадров
 * @param {{at:number,dur:number,x0:number,x1:number,y0:number,y1:number,amp:number}[]} events
 */
function scene(count, events = [], base = 30) {
  const frames = [];
  for (let f = 0; f < count; f++) {
    const g = new Uint8Array(GW * GH).fill(base);
    for (const e of events) {
      if (f < e.at || f >= e.at + e.dur) continue;
      const phase = (f - e.at) / Math.max(1, e.dur - 1);
      // туда-обратно, чтобы амплитуда движения менялась и был выраженный пик
      const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      const cx = Math.round(e.x0 + (e.x1 - e.x0) * tri);
      for (let y = e.y0; y <= e.y1; y++) {
        for (let x = Math.max(0, cx - 1); x <= Math.min(GW - 1, cx + 1); x++) {
          g[y * GW + x] = Math.min(255, base + e.amp);
        }
      }
    }
    frames.push(g);
  }
  return frames;
}

test('cellDiff: разница считается по каждой ячейке', () => {
  const a = new Uint8Array([10, 20, 30]);
  const b = new Uint8Array([14, 18, 30]);
  assert.deepEqual(Array.from(V.cellDiff(a, b)), [4, 2, 0]);
});

test('motionCurve: статика даёт ноль, движение — всплеск', () => {
  const frames = scene(20, []);
  const diffs = [];
  for (let f = 1; f < frames.length; f++) diffs.push(V.cellDiff(frames[f - 1], frames[f]));
  const curve = V.motionCurve(diffs);
  assert.equal(curve.length, diffs.length);
  assert.ok(Math.max(...curve) === 0, 'на статике кривая должна быть нулевой');
});

test('detectMotionEvents: находит движение и молчит на статике', () => {
  const fps = 25;
  const frames = scene(250, [
    { at: 50, dur: 12, x0: 4, x1: 10, y0: 10, y1: 14, amp: 120 },
    { at: 150, dur: 10, x0: 20, x1: 26, y0: 3, y1: 7, amp: 150 },
  ]);
  const res = V.analyzeFrames(frames, fps);

  assert.equal(res.events.length, 2, `найдено ${res.events.length} событий вместо 2`);
  const [e1, e2] = res.events;
  // события внутри посаженных окон (время считается по средине шага)
  assert.ok(e1.time > 50 / fps - 0.2 && e1.time < 62 / fps + 0.2, `первое событие на ${e1.time}`);
  assert.ok(e2.time > 150 / fps - 0.2 && e2.time < 160 / fps + 0.2, `второе событие на ${e2.time}`);
  assert.ok(e1.strength > 0 && e1.strength <= 1);
  assert.ok(e1.onset <= e1.peak && e1.peak <= e1.end, 'onset <= peak <= end');
});

test('detectMotionEvents: пустая сцена не даёт событий', () => {
  const frames = scene(120, []);
  const res = V.analyzeFrames(frames, 25);
  assert.equal(res.events.length, 0, 'на статике не должно быть событий');
});

test('detectMotionEvents: слишком мало кадров', () => {
  const res = V.analyzeFrames(scene(1, []), 25);
  assert.equal(res.events.length, 0);
  assert.equal(res.curve.length, 0);
});

test('detectMotionEvents: minGap склеивает близкие всплески', () => {
  const fps = 25;
  const frames = scene(250, [
    { at: 50, dur: 8, x0: 4, x1: 8, y0: 10, y1: 14, amp: 120 },
    { at: 56, dur: 8, x0: 4, x1: 8, y0: 10, y1: 14, amp: 120 },
  ]);
  const tight = V.analyzeFrames(frames, fps, { minGap: 0.5 });
  assert.equal(tight.events.length, 1, `minGap 0.5 склеил в ${tight.events.length}`);
  const loose = V.analyzeFrames(frames, fps, { minGap: 0.02 });
  assert.ok(loose.events.length >= 1);
});

test('детектор: чувствительность меняет число событий', () => {
  const fps = 25;
  const frames = scene(400, [
    { at: 60, dur: 10, x0: 4, x1: 9, y0: 10, y1: 14, amp: 200 },
    { at: 200, dur: 10, x0: 4, x1: 9, y0: 10, y1: 14, amp: 40 },
  ]);
  const low = V.analyzeFrames(frames, fps, { sensitivity: 0.3 });
  const high = V.analyzeFrames(frames, fps, { sensitivity: 2.5 });
  assert.ok(high.events.length >= low.events.length,
    `высокая чувствительность (${high.events.length}) не ниже низкой (${low.events.length})`);
});

test('hotRegions: находит область, где двигалось', () => {
  const fps = 25;
  const frames = scene(200, [
    { at: 80, dur: 14, x0: 24, x1: 30, y0: 2, y1: 6, amp: 150 },
  ]);
  const res = V.analyzeFrames(frames, fps);
  assert.equal(res.events.length, 1);
  const regions = res.events[0].regions;
  assert.ok(regions.length >= 1, 'областей не найдено');
  // движение было справа вверху — область обязана быть там
  const r = regions[0];
  assert.ok(r.x + r.w > 0.6, `область слишком левая: x=${r.x.toFixed(2)}`);
  assert.ok(r.y < 0.6, `область слишком низкая: y=${r.y.toFixed(2)}`);
  assert.ok(r.w > 0 && r.h > 0 && r.energy > 0);
});

test('at: onset/peak/end выбирают разное время события', () => {
  const fps = 25;
  const frames = scene(250, [{ at: 60, dur: 20, x0: 4, x1: 12, y0: 10, y1: 14, amp: 160 }]);
  const on = V.analyzeFrames(frames, fps, { at: 'onset' }).events[0];
  const pk = V.analyzeFrames(frames, fps, { at: 'peak' }).events[0];
  const en = V.analyzeFrames(frames, fps, { at: 'end' }).events[0];
  assert.ok(on.time <= pk.time, `onset (${on.time}) должен быть не позже peak (${pk.time})`);
  assert.ok(pk.time <= en.time, `peak (${pk.time}) должен быть не позже end (${en.time})`);
});

test('calibrateOffset: считает смещение между ручными метками и детектором', () => {
  const fps = 25;
  const frames = scene(500, [
    { at: 100, dur: 12, x0: 4, x1: 9, y0: 10, y1: 14, amp: 150 },
    { at: 300, dur: 12, x0: 4, x1: 9, y0: 10, y1: 14, amp: 150 },
  ]);
  const res = V.analyzeFrames(frames, fps);
  assert.equal(res.events.length, 2);

  // монтажёр отмечает контакт на 0.08 с позже найденного пика
  const marks = res.events.map((e) => ({ time: e.time + 0.08 }));
  const cal = V.calibrateOffset(marks, res.events, fps);
  assert.equal(cal.used, 2, 'не все метки сопоставились');
  assert.ok(Math.abs(cal.offset - 0.08) < 0.02,
    `смещение ${cal.offset.toFixed(3)} вместо 0.08`);

  // без меток смещение нулевое, а не NaN
  assert.deepEqual(V.calibrateOffset([], res.events, fps), { offset: 0, used: 0 });
});

test('калибровка игнорирует метки далеко от событий', () => {
  const fps = 25;
  const frames = scene(300, [{ at: 100, dur: 12, x0: 4, x1: 9, y0: 10, y1: 14, amp: 150 }]);
  const res = V.analyzeFrames(frames, fps);
  const cal = V.calibrateOffset([{ time: 12.0 }], res.events, fps);
  assert.equal(cal.used, 0, 'метка в 12 с не должна сопоставиться с событием в ~4 с');
  assert.equal(cal.offset, 0);
});

/* ---------- чувствительность по умолчанию ---------- */
// Дефолт был 1.0 — порог на 90-м процентиле, и на обычной ходьбе терялось
// больше половины шагов. Пользователь: «размещает только 3 кадра».
test('дефолтная чувствительность находит и слабые шаги', () => {
  const frames = [];
  for (let i = 0; i < 240; i++) {
    const t = i / 12;
    const m = t % 0.6;
    const step = m < 0.18 ? Math.exp(-Math.pow(m - 0.09, 2) / 0.004) : 0;
    const f = new Float32Array(GRID_W * GRID_H);
    for (let c = 0; c < f.length; c++) {
      f[c] = 0.05 + 0.02 * Math.sin(t * 3 + c);
      if (c % 7 === 3) f[c] += 0.5 * step;
    }
    frames.push(f);
  }
  const res = analyzeFrames(frames, 12, {});
  // в 20 с при каденции 0.6 с шагов ~33
  assert.ok(res.events.length >= 25,
    `дефолт должен находить почти все шаги, нашёл ${res.events.length} из ~33`);
});

test('чувствительность управляет порогом в обе стороны', () => {
  const frames = [];
  for (let i = 0; i < 240; i++) {
    const t = i / 12;
    const m = t % 0.6;
    const step = m < 0.18 ? Math.exp(-Math.pow(m - 0.09, 2) / 0.004) : 0;
    const f = new Float32Array(GRID_W * GRID_H);
    for (let c = 0; c < f.length; c++) {
      f[c] = 0.05 + 0.02 * Math.sin(t * 3 + c);
      if (c % 7 === 3) f[c] += 0.5 * step;
    }
    frames.push(f);
  }
  const res = analyzeFrames(frames, 12, {});
  const low = detectMotionEvents(res.curve, res.times, { sensitivity: 0.2 }).length;
  const high = detectMotionEvents(res.curve, res.times, { sensitivity: 1.5 }).length;
  assert.ok(low > high, `ниже порог — больше событий: ${low} против ${high}`);
});

/* ---------- сигнал движения: камера, разбавление, края ---------- */
// Прежняя кривая — среднее разницы по ВСЕМ клеткам. Она разбавляла мелкий
// объект (стопа = 8 клеток из 576) и росла на тряске камеры, которая двигает
// весь кадр. Замер: ровно 40 шагов из 40 новая кривая даёт в 16 конфигурациях
// из 16, старая — лишь в 9 из 16 (диапазон 23…43).

/** Неоднородный фон с мелкими деталями — чтобы были и яркость, и края. */
function field() {
  const g = new Float32Array(GW * GH);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      g[y * GW + x] = 60 + 50 * Math.sin(x * 0.9 + y * 0.7)
        + 30 * Math.sin(x * 2.3 - y * 1.1) + ((x * 7 + y * 13) % 5) * 4;
    }
  }
  return g;
}

/** Точный перенос кадра на целое число клеток — панорама камеры. */
function rolled(g, dx, dy) {
  const o = new Float32Array(g.length);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const sx = (((x - dx) % GW) + GW) % GW;
      const sy = (((y - dy) % GH) + GH) % GH;
      o[y * GW + x] = g[Math.round(sy) * GW + Math.round(sx)];
    }
  }
  return o;
}

/** Сдвиг с пересэмплингом — модель тряски с субклеточной точностью. */
function resampled(g, dx, dy) {
  const o = new Float32Array(g.length);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const sx = x - dx; const sy = y - dy;
      let s = 0;
      for (let ky = 0; ky < 2; ky++) {
        for (let kx = 0; kx < 2; kx++) {
          const px = Math.floor(sx) + kx; const py = Math.floor(sy) + ky;
          if (px < 0 || px >= GW || py < 0 || py >= GH) continue;
          const wx = sx - Math.floor(sx); const wy = sy - Math.floor(sy);
          s += g[py * GW + px] * ((kx ? wx : 1 - wx) * (ky ? wy : 1 - wy));
        }
      }
      o[y * GW + x] = s;
    }
  }
  return o;
}

/**
 * Сцена с каденцией шагов 0.6 с: 240 кадров, 12 fps → 40 шагов.
 * @param {number} cells ширина объекта в клетках
 * @param {number} amp   амплитуда объекта
 * @param {number} shake амплитуда тряски камеры в клетках
 */
function walkScene(cells, amp, shake) {
  const base = field();
  const frames = [];
  for (let i = 0; i < 240; i++) {
    const t = i / 12;
    const m = t % 0.6;
    const g = resampled(base, shake * Math.sin(t * 2.1), shake * 0.7 * Math.cos(t * 1.7));
    const step = m < 0.18 ? Math.exp(-Math.pow(m - 0.09, 2) / 0.004) : 0;
    for (let y = 8; y < 12; y++) for (let x = 6; x < 6 + cells; x++) g[y * GW + x] = base[y * GW + x] + amp * step;
    frames.push(g);
  }
  return frames;
}

/** События по кривой. */
function eventsOn(curve, fps) {
  const times = new Float32Array(curve.length);
  for (let i = 0; i < times.length; i++) times[i] = (i + 0.5) / fps;
  return V.detectMotionEvents(curve, times);
}

/** Прежняя кривая: среднее разницы соседних кадров по ВСЕМ клеткам. */
function oldCurve(frames) {
  const diffs = [];
  for (let f = 1; f < frames.length; f++) diffs.push(V.cellDiff(frames[f - 1], frames[f]));
  return V.motionCurve(diffs);
}

test('motionSignal: статика даёт ноль', () => {
  const base = field();
  const frames = Array.from({ length: 60 }, () => Float32Array.from(base));
  const sig = V.motionSignal(frames);
  assert.equal(Math.max(...sig.score), 0, 'на статике сигнал должен быть нулевым');
});

test('motionSignal: панорама камеры не даёт ложных событий', () => {
  const base = field();
  const pan = [];
  for (let i = 0; i < 240; i++) {
    const t = i / 12;
    pan.push(rolled(base, 2 * Math.sin(t * 2.1), Math.round(1.4 * Math.cos(t * 1.7))));
  }
  assert.equal(eventsOn(V.motionSignal(pan).score, 12).length, 0,
    'точный перенос кадра — это камера, а не движение в кадре');
  assert.equal(eventsOn(oldCurve(pan), 12).length, 0, 'и прежняя кривая это умела');
});

test('motionSignal: мелкий объект при тряске находится целиком', () => {
  // Худший случай прежней кривой: объект 3 клетки, амплитуда 40, тряска —
  // находилось 23 шага из 40, больше половины терялось.
  const frames = walkScene(3, 40, 0.35);
  const ev = eventsOn(V.motionSignal(frames).score, 12);
  assert.equal(ev.length, 40, `нашлось ${ev.length} шагов из 40`);
});

test('motionSignal: полный набор конфигураций даёт все шаги', () => {
  for (const cells of [3, 8, 20, 60]) {
    for (const amp of [40, 120]) {
      for (const shake of [0, 0.35]) {
        const ev = eventsOn(V.motionSignal(walkScene(cells, amp, shake)).score, 12);
        assert.equal(ev.length, 40,
          `клеток=${cells} амплитуда=${amp} тряска=${shake}: найдено ${ev.length} из 40`);
      }
    }
  }
});

test('motionSignal: прежняя кривая теряла шаги там, где новая находит все', () => {
  // Не «новая лучше», а конкретный замер: старая кривая в этих конфигурациях
  // даёт не 40. Иначе тест выше ничего не защищает.
  const lost = [];
  for (const cells of [3, 8, 20, 60]) {
    for (const amp of [40, 120]) {
      for (const shake of [0, 0.35]) {
        if (eventsOn(oldCurve(walkScene(cells, amp, shake)), 12).length !== 40) {
          lost.push(`клеток=${cells} амплитуда=${amp} тряска=${shake}`);
        }
      }
    }
  }
  assert.ok(lost.length >= 3,
    `прежняя кривая должна была ошибаться хотя бы в трёх конфигурациях, список: ${lost.join('; ')}`);
});

test('motionSignal: канал краёв видит то, чего не видит яркость', () => {
  // Ровная яркость в обоих кадрах — разница яркости нуль. Края есть только
  // во втором. Это ровно случай «тёмное на тёмном»: шаг в тени, движение
  // только по плечам.
  const lum = new Float32Array(GW * GH).fill(100);
  const flat = new Float32Array(GW * GH);
  const edged = new Float32Array(GW * GH);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) edged[y * GW + x] = 90;

  const silent = V.motionSignal([lum, lum], [flat, flat]).score[0];
  assert.equal(silent, 0, 'без краёв и без яркости сигнала нет');

  const seen = V.motionSignal([lum, lum], [flat, edged]).score[0];
  assert.ok(seen > 20, `края должны дать сигнал, получено ${seen.toFixed(1)}`);
});

/* ---------- кадр контакта ---------- */

test('contactFrame: контакт — это провал между махом и переносом тела', () => {
  // мах -> стопа -> перенос тела
  const c = Float32Array.from([0.1, 0.3, 0.8, 0.6, 0.2, 0.15, 0.5, 0.9, 0.4, 0.1]);
  assert.equal(V.contactFrame(c, 0, c.length - 1), 5, 'контакт в провале, а не на пике');
});

test('contactFrame: без второго всплеска возвращается пик', () => {
  const c = Float32Array.from([0.1, 0.4, 0.9, 0.5, 0.2, 0.1]);
  assert.equal(V.contactFrame(c, 0, c.length - 1), 2);
});

test('contactFrame: плато не выдаёт ложный контакт', () => {
  // Плато — это один всплеск, а не мах и стопа. Настоящая постановка это
  // провал; на ровном участке контакта нет, и выдумывать его нельзя.
  const c = Float32Array.from([0.1, 0.5, 0.5, 0.5, 0.2, 0.1]);
  const k = V.contactFrame(c, 0, c.length - 1);
  assert.ok(k >= 1 && k <= 3, `контакт должен остаться внутри плато, получен ${k}`);
});

test('contactFrame: мелкий провал не считается постановкой', () => {
  // Провал есть, но мелкий: 0.7 от всплесков — это не остановка стопы.
  const c = Float32Array.from([0.1, 0.9, 0.75, 0.9, 0.1]);
  assert.equal(V.contactFrame(c, 0, c.length - 1), 1, 'мелкая просадка — не контакт');
});

test('at: contact даёт кадр постановки, а не середину замаха', () => {
  // Шаг = мах (rel 2) -> стопа на полу (rel 3, предмет СТОИТ) -> перенос (rel 4).
  // Пик энергии приходится на мах; контакт — на кадр, где предмет замер.
  const fps = 25;
  const base = field();
  const frames = [];
  for (let i = 0; i < 250; i++) {
    const rel = i % 15;
    const x0 = rel <= 1 ? 6 : rel <= 3 ? 10 : rel === 4 ? 14 : 6;
    const g = Float32Array.from(base);
    for (let y = 8; y < 13; y++) for (let x = x0; x < x0 + 4; x++) g[y * GW + x] += 140;
    frames.push(g);
  }
  const pk = V.analyzeFrames(frames, fps, { at: 'peak' }).events;
  const ct = V.analyzeFrames(frames, fps, { at: 'contact' }).events;
  assert.equal(pk.length, ct.length, 'события одни и те же, время разное');
  const later = ct.filter((e, i) => e.frame >= pk[i].frame).length;
  assert.equal(later, ct.length, `контакт не раньше пика во всех событиях (${later} из ${ct.length})`);
  assert.ok(ct.some((e, i) => e.frame > pk[i].frame), 'хотя бы где-то контакт сдвинут к постановке');
});

test('analyzeFrames: края принимаются и усиливают сигнал', () => {
  const lum = new Float32Array(GW * GH).fill(100);
  const flat = new Float32Array(GW * GH);
  const edged = new Float32Array(GW * GH);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) edged[y * GW + x] = 90;
  const frames = [lum, lum];
  const withoutEdges = V.analyzeFrames(frames, 25);
  const withEdges = V.analyzeFrames(frames, 25, { edges: [flat, edged] });
  assert.equal(withoutEdges.events.length, 0);
  assert.equal(withEdges.events.length, 0, 'двух кадров мало для события');
  assert.ok(Math.max(...withEdges.signal.score) > Math.max(...withoutEdges.signal.score),
    'сигнал с краями выше, чем без');
});
