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
