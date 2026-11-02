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
  assert.ok(r.events[0].step >= r.events[3].step - 0.15,
    `первый шаг ${r.events[0].step.toFixed(2)} против ${r.events[3].step.toFixed(2)} `
    + 'в середине — считается по тем признакам, которые есть');
  assert.ok(r.events[0].step > 0.45, 'первый шаг проходит порог');
});

test('фильтр: шаги за предметом проходят', () => {
  // «Шаги могут ходить за предметами»: ступни за стулом, машиной, прилавком не
  // видны, и движется только верхняя часть человека. Область уходит высоко в
  // кадр — и такой шаг обязан пройти: иначе фильтр теряет настоящие шаги.
  const hidden = walking(10).map((e, i) => ({
    ...e, region: { x: 0.2 + i * 0.04, y: 0.3, w: 0.2, h: 0.18 },
  }));
  const r = stepScore(hidden);
  assert.equal(r.kept, 10, `шаги за предметом: ${r.kept} из ${r.events.length}`);
  assert.ok(r.events[2].step >= 0.45,
    `шаг с областью на уровне груди: ${r.events[2].step.toFixed(2)}`);
  assert.match(r.events[2].stepWhy, /ступни за предметом/,
    'причина объясняет, почему шаг принят без низа кадра');
});

test('фильтр: без геометрии вовсе шаги тоже проходят', () => {
  // Крайний случай «за предметом»: hotRegions не нашёл области — персонажа
  // закрыло целиком, только движение по сетке осталось. Каденция и удар ещё
  // работают, и оба говорят «шаг».
  const r = stepScore(walking(6).map((e) => ({ ...e, region: null })));
  assert.equal(r.kept, 6, 'шаги без области проходят по ритму и удару');
});

test('фильтр: ровный такт сцены — свой у каждой', () => {
  // Медленная, но РОВНАЯ ходьба: пауза 1.4 с. Это шаги, просто человек идёт
  // не спеша. Фильтр берёт такт у принятых шагов сцены, поэтому ровный ритм
  // не штрафуется за то, что он не 0.6 с.
  const slow = walking(8).map((e, i) => ({ ...e, time: 1 + i * 1.4 }));
  const r = stepScore(slow);
  assert.equal(r.kept, 8, 'ровная медленная ходьба проходит вся');
  assert.ok(r.events[3].step > 0.9, `свой такт признан: ${r.events[3].step.toFixed(2)}`);
});

test('фильтр: событие вне такта сцены отбрасывается', () => {
  // Шаги идут ровно через 0.6 с. Жест, случайно уложившийся в полушага после
  // шага, получал те же баллы за каденцию, что и настоящий шаг — и проходил.
  // Такт берётся у принятых шагов, поэтому «между шагами» — уже не шаг.
  const scene = [];
  for (let i = 0; i < 8; i++) {
    scene.push({ time: 1 + i * 0.6, duration: 0.2, strength: 0.8,
      region: { x: 0.12 + i * 0.05, y: 0.66, w: 0.16, h: 0.24 } });
  }
  for (let i = 0; i < 6; i++) {
    scene.push({ time: 1.05 + i * 0.6 + 0.3, duration: 0.45, strength: 0.75,
      region: { x: 0.52, y: 0.24, w: 0.1, h: 0.12 } });
  }
  scene.sort((a, b) => a.time - b.time);
  const r = stepScore(scene);
  assert.equal(r.kept, 8, `оставлены только шаги: ${r.kept} из ${r.events.length}`);
  for (const e of r.events) {
    if (e.step >= 0.45) assert.ok(e.region.y > 0.4, 'оставленное — из низа кадра');
  }
});

test('фильтр: пропущенный шаг не рвёт цепочку', () => {
  // Детектор может не заметить один шаг — пауза тогда вдвое длиннее обычной.
  // Следующий настоящий шаг обязан пройти, иначе один промах съедает всю
  // оставшуюся дорожку.
  const times = [1, 1.6, 2.2, 3.4, 4.0, 4.6];   // между 2.2 и 3.4 — промах
  const r = stepScore(times.map((t, i) => ({
    time: t, duration: 0.2, strength: 0.8,
    region: { x: 0.1 + i * 0.06, y: 0.64, w: 0.16, h: 0.24 },
  })));
  assert.equal(r.kept, 6, 'все шаги прошли, включая идущие после промаха');
  assert.ok(r.events[3].step >= 0.45,
    `шаг после промаха: ${r.events[3].step.toFixed(2)}`);
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
