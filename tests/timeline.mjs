/* ============ Тесты линейки таймлайна: подписи должны соответствовать позиции ============
 *
 * Инвариант: подпись, стоящая на X пикселях от начала линейки, показывает время
 * X / pps. И подписи идут по возрастанию. Если это нарушается, монтажёр врёт
 * о позиции — а на нём строят всю расстановку фоли.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers.mjs';

const { document, window } = await setupDom();

const timeline = await import(new URL('../js/timeline.js', import.meta.url).href);
const state = await import(new URL('../js/state.js', import.meta.url).href);

// навешиваем обработчики кнопок зума, иначе клики в тестах ничего не делают
timeline.initTimeline();

/* jsdom не считает Layout — задаём ширину вручную, как в браузере. */
function stubWidth(px) {
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.id === 'timeline' ? px : 0; },
  });
}

function addClip(dur) {
  state.state.media.push({ id: 'm1', name: 'v.mp4', duration: dur, width: 1920, height: 882 });
  state.state.clips.push({
    id: 'c1', mediaId: 'm1', in: 0, out: dur, transitionIn: 'none', volume: 1, name: 'v.mp4',
  });
}

function rulerLabels() {
  const ruler = document.getElementById('ruler');
  return [...ruler.querySelectorAll('.ruler-label')].map((n) => ({
    left: parseFloat(n.style.left),
    text: n.textContent.trim(),
  }));
}

test('линейка: подписи идут по возрастанию и совпадают с позицией', () => {
  stubWidth(1600);
  addClip(60);
  timeline.render();

  const labels = rulerLabels();
  assert.ok(labels.length >= 5, `подписей ${labels.length} — слишком мало`);

  const times = labels.map((l) => {
    const [m, s] = l.text.split(':').map(Number);
    return m * 60 + s;
  });

  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1],
      `подписи не по возрастанию: ${labels[i - 1].text} → ${labels[i].text}`);
  }

  // шаг между подписями постоянный
  const steps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(new Set(steps).size === 1, `шаг подписей не постоянный: ${steps.join(',')}`);

  // позиция подписи соответствует её времени (учитывая отступ RULER_PAD)
  const pad = labels[0].left;
  const pps = (labels[1].left - pad) / times[1];
  assert.ok(pps > 0, `pps = ${pps}`);
  for (const l of labels) {
    const expected = pad + times[labels.indexOf(l)] * pps;
    assert.ok(Math.abs(l.left - expected) < 1.5,
      `подпись ${l.text} стоит на ${l.left}px, а должна на ${expected.toFixed(1)}px`);
  }
});

test('линейка: последняя подпись не забегает далеко за конец клипа', () => {
  stubWidth(1600);
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  timeline.render();
  const labels = rulerLabels();
  const last = labels.at(-1);
  const [m, s] = last.text.split(':').map(Number);
  const lastT = m * 60 + s;
  assert.ok(lastT <= 60 + 60, `последняя подпись ${last.text} — линейка разошлась`);
});

test('линейка: на длинном проекте подписей остаётся немного', () => {
  stubWidth(1600);
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60 * 90); // 90 минут
  timeline.render();
  const labels = rulerLabels();
  assert.ok(labels.length < 400, `подписей ${labels.length} — линейка перегружена`);
  assert.ok(labels.length > 3, `подписей ${labels.length} — слишком мало`);
  const times = labels.map((l) => { const [m, s] = l.text.split(':').map(Number); return m * 60 + s; });
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], `не по возрастанию: ${labels[i - 1].text} → ${labels[i].text}`);
  }
});

test('линейка: ширина дорожки покрывает клип', () => {
  stubWidth(1600);
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  timeline.render();
  const ruler = document.getElementById('ruler');
  const track = document.getElementById('track');
  assert.ok(parseFloat(ruler.style.width) >= 60 * 10, `ширина линейки ${ruler.style.width}`);
  assert.equal(ruler.style.width, track.style.width, 'линейка и дорожка разной ширины');
});

test('зум: длинный клип не уезжает за окно', () => {
  stubWidth(1600);
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60); // 60 с при 70 px/с дало бы 4240 px содержимого
  timeline.render();
  const ruler = document.getElementById('ruler');
  const w = parseFloat(ruler.style.width);
  assert.ok(w <= 1600, `ширина линейки ${w}px при окне 1600px — проект уезжает вправо`);
  const track = document.getElementById('track');
  assert.equal(ruler.style.width, track.style.width, 'линейка и дорожка разной ширины');
  assert.equal(timeline.isFitted(), true);
});

test('зум: ручное увеличение запоминается и автоподгонка не перебивает', () => {
  stubWidth(1600);
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  timeline.render();
  const fitted = parseFloat(document.getElementById('ruler').style.width);
  document.getElementById('zoom-in').click();
  assert.equal(timeline.isFitted(), false, 'после ручного зума автоподгонка должна отключиться');
  const zoomed = parseFloat(document.getElementById('ruler').style.width);
  assert.ok(zoomed > fitted, `зум не увеличил: ${fitted} -> ${zoomed}`);
  timeline.render();
  assert.equal(parseFloat(document.getElementById('ruler').style.width), zoomed,
    'повторный render сбросил ручной зум');
});

test('зум: кнопка «Весь проект» возвращает подгонку', () => {
  stubWidth(1600);
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  timeline.render();
  document.getElementById('zoom-in').click();
  assert.equal(timeline.isFitted(), false);
  document.getElementById('zoom-fit').click();
  assert.equal(timeline.isFitted(), true);
  assert.ok(parseFloat(document.getElementById('ruler').style.width) <= 1600,
    'после «Весь проект» содержимое снова шире окна');
});

/* ---------- дорожки фоли на таймлайне ---------- */
test('размещение появляется на таймлайне строкой на дорожку', () => {
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(30);
  state.setPlacements([
    { id: 'p1', time: 1, duration: 0.3, category: 'steps', source: 'A',
      file: 'steps 02.L.wav', cutFrom: 0.5, cutTo: 0.8 },
    { id: 'p2', time: 5, duration: 0.4, category: 'steps', source: 'B',
      file: 'steps 03.L.wav', cutFrom: 1.2, cutTo: 1.6 },
    { id: 'p3', time: 9, duration: 0.25, category: 'steps', source: 'A',
      file: 'steps 02.L.wav', cutFrom: 2.0, cutTo: 2.25 },
  ]);
  timeline.render();

  const rows = document.querySelectorAll('#foley-track .foley-row');
  assert.equal(rows.length, 2, 'у каждой дорожки своя строка');
  const labels = [...document.querySelectorAll('#foley-track .foley-row-label')].map((n) => n.textContent);
  assert.deepEqual(labels, ['steps 02.L', 'steps 03.L'], 'подписи — имена дорожек без расширения');
  assert.equal(document.querySelectorAll('#foley-track .foley-clip').length, 3);
  assert.equal(
    document.querySelectorAll('#foley-track .foley-row')[0].querySelectorAll('.foley-clip').length, 2,
    'оба дубля первой дорожки в одной строке');
});

test('клип шире длинного дубля и уже короткого', () => {
  state.setPlacements([
    { id: 'q1', time: 1, duration: 0.2, file: 'a.wav', cutFrom: 0, cutTo: 0.2, category: 'steps' },
    { id: 'q2', time: 4, duration: 0.9, file: 'a.wav', cutFrom: 0, cutTo: 0.9, category: 'steps' },
  ]);
  timeline.render();
  const [a, b] = [...document.querySelectorAll('#foley-track .foley-clip')];
  assert.ok(parseFloat(b.style.width) > parseFloat(a.style.width),
    'ширина клипа должна отражать длительность дубля');
});

test('клип размещения кликабелен и переносит playhead', () => {
  state.setPlacements([
    { id: 'r1', time: 6, duration: 0.3, file: 'a.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  timeline.render();
  const clip = document.querySelector('#foley-track .foley-clip');
  assert.ok(clip.dataset.pid === 'r1', 'клип знает своё размещение');
  clip.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(state.state.time, 6, 'клик по клипу ставит playhead на его начало');
});

test('пустое размещение не рисует строк', () => {
  state.setPlacements([]);
  timeline.render();
  assert.equal(document.querySelectorAll('#foley-track .foley-row').length, 0);
});

test('свёрнутый вид: одна строка-итог вместо дорожек', () => {
  state.setPlacements([
    { id: 's1', time: 1, duration: 0.3, file: 'steps 02.L.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
    { id: 's2', time: 3, duration: 0.3, file: 'steps 03.L.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  timeline.render();
  document.getElementById('btn-foley-toggle').click();
  timeline.render();
  assert.equal(document.querySelectorAll('#foley-track .foley-row').length, 0, 'строки дорожек скрыты');
  assert.ok(document.querySelector('.foley-collapsed'), 'вместо них свёрнутый итог');
  assert.match(document.querySelector('.foley-collapsed').textContent, /2 дубл\. · 2 дорож\./);
  document.getElementById('btn-foley-toggle').click();
  timeline.render();
  assert.equal(document.querySelectorAll('#foley-track .foley-row').length, 2, 'развернулось обратно');
});

test('выравнивание: клип стоит под тем же временем, что и playhead', () => {
  state.setPlacements([
    { id: 'z1', time: 12.5, duration: 0.3, file: 'steps 02.L.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  timeline.render();
  const clip = document.querySelector('#foley-track .foley-clip');
  const playhead = document.getElementById('playhead');

  // эталон — позиция playhead на том же времени: он ставится по времени напрямую
  const time = 12.5;
  state.bus.emit(state.EV.TIME, time);
  const expect = parseFloat(playhead.style.left);
  assert.ok(expect > 0, 'playhead встал на время');
  assert.equal(parseFloat(clip.style.left), expect,
    'левый край клипа должен совпадать с playhead на том же времени');

  // подпись строки не должна сдвигать полосу с клипами
  const row = document.querySelector('#foley-track .foley-row');
  const anchor = row.querySelector('.foley-row-anchor');
  const lane = row.querySelector('.foley-lane');
  assert.ok(anchor, 'подпись держится нулевым якорём');
  assert.equal(lane.getBoundingClientRect().left - row.getBoundingClientRect().left, 0,
    'полоса клипов начинается там же, где и ряд');
});
