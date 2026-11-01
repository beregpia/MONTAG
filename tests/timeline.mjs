/* ============ Тесты линейки таймлайна: подписи должны соответствовать позиции ============
 *
 * Инвариант: подпись, стоящая на X пикселях от начала линейки, показывает время
 * X / pps. И подписи идут по возрастанию. Если это нарушается, монтажёр врёт
 * о позиции — а на нём строят всю расстановку фоли.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, SOURCE_STARTS } from './helpers.mjs';

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

const bank = await import(new URL('../js/audio-bank.js', import.meta.url).href);

test('волформа клипа зеркальная и заполненная', () => {
  const data = new Float32Array(4000);
  for (let i = 0; i < 2000; i++) data[i] = 0.9;   // громко
  for (let i = 2000; i < 4000; i++) data[i] = 0.1; // тихо
  bank.putTrack('wf.wav', { data, sampleRate: 1000 });
  state.setPlacements([
    { id: 'w1', time: 1, duration: 2, file: 'wf.wav', cutFrom: 0, cutTo: 2, category: 'steps' },
  ]);
  timeline.render();
  const wave = document.querySelector('#foley-track .foley-wave svg path');
  assert.ok(wave, 'волформа нарисована');
  const d = wave.getAttribute('d');
  assert.ok(d.endsWith('Z'), 'фигура замкнута — заливается, а не просто штрихуется');
  // путь должен уходить и вверх, и вниз от середины: иначе это график, не звук
  const ys = [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]));
  assert.ok(Math.min(...ys) < 50 && Math.max(...ys) > 50,
    'волформа должна быть зеркальной относительно середины');
  // ширина клипа задаёт плотность точек: на широком клипе их больше
  assert.ok(ys.length >= 24, `точек ${ys.length}`);
  bank.clearBank();
});

test('ширина клипа задаёт плотность волформы', () => {
  const data = new Float32Array(10000).fill(0.5);
  bank.putTrack('wf2.wav', { data, sampleRate: 1000 });
  const count = (dur) => {
    state.setPlacements([
      { id: `q${dur}`, time: 0, duration: dur, file: 'wf2.wav', cutFrom: 0, cutTo: dur, category: 'steps' },
    ]);
    timeline.render();
    const d = document.querySelector('#foley-track .foley-wave svg path')?.getAttribute('d') || '';
    return [...d.matchAll(/[ML]/g)].length;
  };
  const narrow = count(0.1);
  const wide = count(4);
  assert.ok(wide > narrow, `широкий клип должен иметь больше точек: ${narrow} -> ${wide}`);
  bank.clearBank();
});

/* ---------- исходные дорожки ---------- */
const { FakeAudioContext } = await import(new URL('./helpers.mjs', import.meta.url).href);

/** Дорожка с четырьмя отчётливыми ударами — индексатор найдёт их как шаги. */
function walkingTrack() {
  const SR = 48000;
  const len = SR * 20;
  const data = new Float32Array(len);
  for (const t of [1, 3, 5, 7]) {
    const s = Math.floor(t * SR);
    for (let i = 0; i < 0.05 * SR && s + i < len; i++) {
      data[s + i] += 0.9 * Math.exp(-i / (0.01 * SR)) * Math.sin((2 * Math.PI * 90 * i) / SR);
    }
  }
  return { numberOfChannels: 1, length: len, sampleRate: SR, getChannelData: () => data };
}

/* ---------- исходные дорожки ---------- */

/* Исходные дорожки проверяем на обычном монтаже: минута картинки, подгонка
 * под окно. Иначе зум от предыдущих тестов сделает pps огромным, и волформа
 * исходника честно не влезет в окно — тест бы проверял зумирование, а не блок. */
function srcScene() {
  // в банке: предыдущие тесты вызывают clearBank(), поэтому кладём заново
  bank.putTrack('steps 02.L.wav', {
    data: (() => { const d = new Float32Array(20000); for (let i = 0; i < d.length; i++) d[i] = Math.sin(i / 20); return d; })(),
    sampleRate: 1000,
  });
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  stubWidth(1600);
  timeline.fitToWindow();
  timeline.render();
}

/* Свернуть/развернуть исходники в известное состояние: тесты не должны
 * зависеть от того, в каком состоянии их оставил предыдущий. */
function setSrc(on) {
  const btn = document.getElementById('btn-foley-src');
  const open = btn.textContent.startsWith('▾');
  if (open !== on) btn.click();
  timeline.render();
}

/* Дорожка в банке (для волформы) и в состоянии (для отметок шагов). */
const SRC_EVENTS = [
  { time: 1, duration: 0.2, peak: 0.9, strength: 0.8 },
  { time: 3, duration: 0.2, peak: 0.8, strength: 0.7 },
  { time: 5, duration: 0.2, peak: 0.7, strength: 0.6 },
];
const putSrc = () => state.setSourceTrack({
  name: 'steps 02.L.wav', category: 'steps', pass: '02', duration: 20, events: SRC_EVENTS,
});

test('исходники: дорожка в состоянии несёт длительность и шаги', () => {
  putSrc();
  assert.equal(state.state.foleyTracks.length, 1);
  assert.equal(state.state.foleyTracks[0].duration, 20);
  assert.equal(state.state.foleyTracks[0].events.length, 3);
  // повторная запись той же дорожки заменяет, а не дублирует
  state.setSourceTrack({ name: 'steps 02.L.wav', category: 'steps', pass: '02', duration: 21, events: [] });
  assert.equal(state.state.foleyTracks.length, 1);
  assert.equal(state.state.foleyTracks[0].duration, 21);
  putSrc();
  state.setSourceTrack({ name: 'steps 03.L.wav', category: 'steps', pass: '03', duration: 31, events: [] });
  assert.equal(state.state.foleyTracks.length, 2);
  state.dropSourceTrack('steps 03.L.wav');
  assert.equal(state.state.foleyTracks.length, 1);
});

test('исходники: блок рисуется с волформой и отметками шагов', () => {
  srcScene();
  putSrc();
  setSrc(true);

  assert.ok(document.querySelector('.foley-src-head'), 'заголовок блока есть');
  assert.match(document.querySelector('.foley-src-head').textContent, /своя шкала/,
    'шкала исходников честно названа своей, а не таймлайна');

  const rows = document.querySelectorAll('#foley-track .foley-row.src');
  assert.equal(rows.length, 1, 'строка исходника отрисовалась');
  assert.equal(rows[0].querySelector('.foley-row-label').textContent, 'steps 02.L',
    'подпись — имя дорожки без расширения');
  assert.ok(document.querySelector('#foley-track .foley-src-wave svg path'),
    'волформа исходной дорожки нарисована');
  assert.equal(document.querySelectorAll('#foley-track .foley-src-tick').length, 3,
    'отметка на каждый найденный шаг');
});

test('исходники: шкала исходников не равна таймлайну', () => {
  srcScene();
  putSrc();
  setSrc(true);
  const row = document.querySelector('#foley-track .foley-row.src');
  const clipRow = document.querySelector('#foley-track .foley-row:not(.src)');
  // у исходной дорожки своя ширина (20 с записи), у размещения — своя
  const srcW = parseFloat(row.querySelector('.foley-lane').style.width);
  const total = timeline.timelineWidth ? timeline.timelineWidth() : 0;
  assert.ok(srcW > 0, 'полоса исходника имеет ширину');
  assert.ok(srcW < total || total === 0,
    'запись короче монтажа: 20 с исходника против 60 с таймлайна');
  assert.ok(!document.querySelector('#foley-track .src-playhead'),
    'playhead по исходникам не идёт — шкалы не совпадают, и это не баг');
});

test('исходники: отметка шага прослушивает тейк', () => {
  srcScene();
  putSrc();
  setSrc(true);
  const tick = document.querySelector('#foley-track .foley-src-tick');
  assert.ok(tick, 'отметка есть');
  assert.match(tick.title, /сила/, 'подсказка показывает силу шага');
  const before = SOURCE_STARTS.length;
  tick.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(SOURCE_STARTS.length > before, 'клик по отметке запускает звук');
  assert.ok(SOURCE_STARTS[SOURCE_STARTS.length - 1].buffer,
    'звучит буфер, а не пустой запуск');
});

test('исходники: кнопка гаснет без дорожек и работает с ними', () => {
  srcScene();
  putSrc();
  setSrc(true);
  const btn = document.getElementById('btn-foley-src');
  assert.equal(btn.disabled, false, 'дорожка есть — кнопка активна');
  state.state.foleyTracks.length = 0;
  timeline.render();
  assert.equal(btn.disabled, true, 'без дорожек показывать нечего');
  assert.match(btn.title, /не импортировано/);
  putSrc();
  timeline.render();
  assert.equal(btn.disabled, false);
});

test('исходники: свёрнутый блок не добавляет высоты', () => {
  srcScene();
  putSrc();
  setSrc(false);
  timeline.render();
  assert.equal(document.querySelectorAll('.foley-src-head').length, 0, 'заголовка нет');
  assert.equal(document.querySelectorAll('#foley-track .foley-row.src').length, 0,
    'строк исходников в DOM нет — они не висят свёрнутыми');
  assert.equal(document.getElementById('btn-foley-src').textContent, '▸ Исходники');
});

test('исходники и размещение не мешают друг другу', () => {
  srcScene();
  putSrc();
  state.setPlacements([
    { id: 'z1', time: 12.5, duration: 0.3, file: 'steps 02.L.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  setSrc(true);
  assert.equal(document.querySelectorAll('#foley-track .foley-clip').length, 1, 'клип размещения на месте');
  assert.equal(document.querySelectorAll('#foley-track .foley-row.src').length, 1,
    'строка исходника на месте');
  assert.ok(document.querySelector('#foley-track .foley-src-wave svg path'),
    'волформа исходника не перекрыта клипами размещения');
  assert.ok(document.querySelectorAll('#foley-track .foley-src-tick').length === 3,
    'отметки исходника не потерялись');
});
