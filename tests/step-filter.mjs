/* ============ Тесты фильтра «похоже на шаг» ============
 *
 * Детектор движения отдаёт «движение вообще»: шаг, взмах руки, поворот
 * головы, дрожь камеры. Фильтр обязан оставить шаги и отсечь остальное —
 * по данным, которые детектор и так уже посчитал.
 *
 * Главная ловушка такого фильтра: научиться пропускать всё подряд (тогда он
 * бесполезен) или не пропускать ничего (тогда монтажёр получает пустой список
 * и не понимает почему). Оба случая проверяются отдельно.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const S = await import(new URL('../js/step-filter.js', import.meta.url).href);
const { stepScore, stepSummary, STEP_CADENCE } = S;

/** Ходьба: шаги через 0.6 с, ступни внизу кадра, человек идёт вправо. */
const walking = (n = 12, from = 1) => Array.from({ length: n }, (_, i) => ({
  time: from + i * STEP_CADENCE,
  duration: 0.2,
  strength: 0.8,
  region: { x: 0.1 + i * 0.05, y: 0.62, w: 0.18, h: 0.25 },
}));

/** Рука машет: то же движение, но высоко в кадре, быстро и без ритма. */
const handWave = (n = 12, from = 1) => Array.from({ length: n }, (_, i) => ({
  time: from + i * 0.23,
  duration: 0.5,
  strength: 0.8,
  region: { x: 0.45, y: 0.2, w: 0.12, h: 0.15 },
}));

/** Камера дрожит: движение везде и сразу,区域 огромная. */
const cameraShake = (n = 12, from = 1) => Array.from({ length: n }, (_, i) => ({
  time: from + i * 0.6,
  duration: 0.02,
  strength: 0.4,
  region: { x: 0, y: 0, w: 1, h: 1 },
}));

test('фильтр: шаги проходят', () => {
  const r = stepScore(walking());
  assert.equal(r.events.length, 12, 'события не потеряны');
  assert.equal(r.kept, 12, 'все шаги признаны шагами');
  assert.equal(r.dropped, 0);
  for (const e of r.events) {
    assert.ok(e.step >= 0.45, `событие ${e.time}: оценка ${e.step.toFixed(2)}`);
    assert.equal(typeof e.stepSide, 'string', 'сторона кадра названа');
    assert.ok(e.stepWhy.length > 0, 'причина названа');
  }
});

test('фильтр: взмах руки не проходит', () => {
  const r = stepScore(handWave());
  assert.equal(r.kept, 0, 'рука машет без ритма и высоко в кадре — не шаг');
  assert.equal(r.dropped, 12);
  assert.equal(r.events[0].stepWhy, 'ритм или место не те',
    'причина объясняет отказ, а не молчит');
});

test('фильтр: дрожь камеры не проходит', () => {
  const r = stepScore(cameraShake());
  assert.equal(r.kept, 0, 'дрожь камеры — не шаг: событие слишком короткое');
});

test('фильтр: шаги без геометрии не штрафуются за её отсутствие', () => {
  // Событие без региона: FILTER не видит ни пол, ни смещение, зато видит
  // каденцию. Если штрафовать за отсутствие — шаги без зон пропадали бы.
  const bare = walking(6).map((e) => ({ ...e, region: null }));
  const r = stepScore(bare);
  assert.equal(r.kept, 6, 'шаги без области проходят по каденции');
  assert.equal(r.events[0].stepSide, null, 'сторона неизвестна');
});

test('фильтр: первый шаг цепочки не наказан за отсутствие паузы', () => {
  const r = stepScore(walking());
  // У первого события нет предыдущего шага, значит нет и признака каденции.
  // Если считать оценку по всем четырём признакам с нулём за отсутствующий,
  // первый шаг получил бы максимум 0.65 и провалился бы при строгом пороге.
  assert.ok(r.events[0].step >= 0.9,
    `первый шаг: ${r.events[0].step.toFixed(2)} — считается по тем признакам, которые есть`);
});

test('фильтр: сбитая каденция роняет оценку', () => {
  // Те же шаги, но пауза 1.4 с вместо 0.6. Отбрасывать такую сцену нельзя —
  // медленная ходьба тоже шаги, — но оценка обязана упасть: ритма нет.
  const slow = walking(8).map((e, i) => ({ ...e, time: 1 + i * 1.4 }));
  const fast = walking(8);
  const rs = stepScore(slow);
  const rf = stepScore(fast);
  assert.ok(rs.events[3].step < rf.events[3].step - 0.25,
    `пауза 1.4 с даёт ${rs.events[3].step.toFixed(2)} против `
    + `${rf.events[3].step.toFixed(2)} в такт`);
  assert.ok(rs.events[3].step > 0, 'оценка не ушла в ноль — сцена ещё живая');
});

test('фильтр: шаги среди прочего движения выделяются', () => {
  // Реальная картина: идут двое, кто-то машет рукой, кто-то вертит головой.
  const scene = [];
  for (let i = 0; i < 10; i++) {
    scene.push({                       // шаги: низ кадра, такт 0.6 с, вперёд
      time: 1 + i * 0.6, duration: 0.2, strength: 0.8,
      region: { x: 0.12 + i * 0.05, y: 0.66, w: 0.16, h: 0.24 },
    });
  }
  for (let i = 0; i < 10; i++) {        // рука: высоко, без такта
    scene.push({
      time: 1.1 + i * 0.31, duration: 0.45, strength: 0.75,
      region: { x: 0.52, y: 0.24, w: 0.1, h: 0.12 },
    });
  }
  scene.sort((a, b) => a.time - b.time);
  const r = stepScore(scene);
  assert.equal(r.events.length, 20, 'ничего не потеряно');
  assert.equal(r.kept, 10, `оставлены только шаги: ${r.kept} из 20`);
  for (const e of r.events) {
    if (e.step >= 0.45) assert.ok(e.region.y > 0.4, 'оставленное — из низа кадра');
  }
});

test('фильтр: порог строгости правда режет', () => {
  const evs = walking(10);
  const strict = stepScore(evs, { threshold: 0.8 });
  const loose = stepScore(evs, { threshold: 0.2 });
  assert.ok(strict.kept <= loose.kept, 'выше порог — меньше шагов');
  assert.ok(loose.kept === 10, 'низкий порог пропускает всю ходьбу');
});

test('фильтр: события не перемешиваются и не теряются', () => {
  const mixed = [...walking(6, 1), ...handWave(6, 1)].sort((a, b) => a.time - b.time);
  const r = stepScore(mixed);
  assert.equal(r.events.length, 12, 'ничего не выкинуто из массива');
  assert.ok(r.kept > 0 && r.kept < 12,
    `смесь: ${r.kept} шагов из 12 — фильтр различает, а не пропускает всё`);
});

test('фильтр: сводка для панели читаема', () => {
  const r = stepScore(walking(8));
  assert.match(stepSummary(r, true), /похожих на шаги: 8 из 8/);
  assert.match(stepSummary(r, false), /фильтр «только шаги» выключен/);
  assert.equal(stepSummary({ events: [] }, true), '', 'пусто — пусто');
});

test('фильтр: мусор на входе не ломает', () => {
  assert.deepEqual(stepScore(null).events, []);
  assert.deepEqual(stepScore(undefined).events, []);
  assert.equal(stepScore([{ time: 1 }]).events[0].step, 0,
    'событие без признаков — не шаг, но и не падение');
  // NaN во времени не должен превратить оценку в NaN
  const bad = stepScore([{ time: NaN, region: { x: 0.1, y: 0.7, w: 0.1, h: 0.1 } }]);
  assert.ok(Number.isFinite(bad.events[0].step), 'оценка осталась числом');
});

test('фильтр: чередование сторон считается по принятым шагам', () => {
  // Идущий через кадр: область переходит из левой половины в правую
  const across = Array.from({ length: 8 }, (_, i) => ({
    time: 1 + i * 0.6, duration: 0.2,
    region: { x: 0.05 + i * 0.12, y: 0.6, w: 0.1, h: 0.25 },
  }));
  const r = stepScore(across);
  assert.ok(r.alternations >= 1, 'смена половины кадра замечена');
  assert.equal(r.events[0].stepSide, 'L');
  assert.equal(r.events[7].stepSide, 'R');
});
