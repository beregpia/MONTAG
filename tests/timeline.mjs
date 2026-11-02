/* ============ Тесты линейки таймлайна: подписи должны соответствовать позиции ============
 *
 * Инвариант: подпись, стоящая на X пикселях от начала линейки, показывает время
 * X / pps. И подписи идут по возрастанию. Если это нарушается, монтажёр врёт
 * о позиции — а на нём строят всю расстановку фоли.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, SOURCE_STARTS } from './helpers.mjs';
import { readFile } from 'node:fs/promises';

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
  const labels = [...document.querySelectorAll('#foley-track .foley-row .tl-gutter-name')].map((n) => n.textContent);
  assert.deepEqual(labels, ['steps 02.L', 'steps 03.L'], 'подписи — имена дорожек без расширения');
  assert.equal(document.querySelectorAll('#foley-track .foley-clip').length, 3);
  assert.equal(
    document.querySelectorAll('#foley-track .foley-row')[0].querySelectorAll('.foley-clip').length, 2,
    'оба дубля первой дорожки в одной строке');
});

test('оригинальные шаги из звука клипа встают по шкале таймлайна', () => {
  // Шкала у этой строки ОБЩАЯ с расстановкой: звук клипа синхронен с картинкой.
  // Если отметить шаг по его локальному времени, а не по времени монтажа,
  // отметка разойдётся с фоли ровно на смещение клипа — и сравнивать нечего.
  addClip(10);
  state.setVideoAudio({
    name: 'v.mp4',
    steps: [{ time: 1.0, duration: 0.2 }, { time: 2.0, duration: 0.2 }],
    dropped: [{ time: 3.0 }], wave: [0.1, 0.5, 1, 0.4, 0.2], duration: 10,
    offset: 4, error: '',
  });
  state.setPlacements([{
    id: 'p1', time: 5.02, duration: 0.2, category: 'steps',
    file: 'steps 02.L.wav', cutFrom: 1, cutTo: 1.2,
  }]);
  timeline.render();

  const rows = [...document.querySelectorAll('#foley-track .foley-row')];
  const orig = rows.find((r) => r.querySelector('.orig-step'));
  assert.ok(orig, 'строки оригинальных шагов нет');
  assert.match(orig.querySelector('.tl-gutter-name').textContent, /Оригинал/);
  const ticks = [...orig.querySelectorAll('.orig-step')];
  assert.equal(ticks.length, 2, 'отметка на каждый найденный шаг');
  // локальное 1.0 + смещение 4 = 5.0 на таймлайне
  const pps = timeline.timelinePps();
  assert.ok(Math.abs(parseFloat(ticks[0].style.left) - 5.0 * pps) < 0.5,
    `первая отметка должна стоять на ${5.0 * pps}, а не на ${ticks[0].style.left}`);
  // цвет — результат сравнения: совпало / пропущено
  assert.equal(ticks[0].className, 'orig-step ok', 'шаг на 5.0 закрыт дублем на 5.02');
  assert.equal(ticks[1].className, 'orig-step miss', 'шаг на 6.0 никем не закрыт');
  // состояние звука клипа не должно перетекать в следующие тесты: строка
  // оригинальных шагов иначе появляется там, где её не ждут
  state.setVideoAudio({ name: '', steps: [], dropped: [], wave: [], duration: 0, error: '' });
  state.setPlacements([]);
  timeline.render();
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
  // клип лежит в координатах своей полосы, playhead — всего таймлайна:
  // между ними колонка заголовков. Сравниваем положения, а не сырые left.
  assert.equal(parseFloat(clip.style.left) + timeline.timelineGutter(), expect,
    'левый край клипа должен совпадать с playhead на том же времени');

  // подпись строки не должна сдвигать полосу с клипами
  const row = document.querySelector('#foley-track .foley-row');
  const head = row.querySelector('.tl-gutter');
  const lane = row.querySelector('.foley-lane');
  assert.ok(head, 'у дорожки есть колонка заголовка');
  assert.equal(lane.getBoundingClientRect().left - row.getBoundingClientRect().left, 0,
    'полоса клипов начинается там же, где и ряд');
});

const bank = await import(new URL('../js/audio-bank.js', import.meta.url).href);
const foley = await import(new URL('../js/foley.js', import.meta.url).href);

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
const SRC = 'steps 02.L.wav';
const putSrc = () => state.setSourceTrack({
  name: SRC, category: 'steps', pass: '02', duration: 20, events: SRC_EVENTS,
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
  assert.match(document.querySelector('.foley-src-head').textContent, /на шкале видео/,
    'заголовок честно говорит, что дорожки стоят на шкале видео');

  const rows = document.querySelectorAll('#foley-track .foley-row.src');
  assert.equal(rows.length, 1, 'строка исходника отрисовалась');
  assert.equal(rows[0].querySelector('.tl-gutter-name').textContent, 'steps 02.L',
    'подпись — имя дорожки без расширения');
  // Ради чего всё: полоса исходника стоит в одной столбик с видео, линейкой и
  // размещением. Раньше здесь был якорь нулевой ширины с подписью поверх
  // полосы — и полоса уезжала на 152 px левее видео.
  assert.ok(rows[0].querySelector('.tl-gutter.tl-gutter-foley'),
    'колонка заголовка такая же, как у дорожек');
  assert.ok(!rows[0].querySelector('.foley-row-anchor'),
    'якоря нулевой ширины больше нет — он и сдвигал полосу');
  // Сравнивать getBoundingClientRect в jsdom бессмысленно: все прямоугольники
  // там нулевые, и проверка проходила бы вхолостую. Выравнивание держится на
  // том, что ПЕРВЫЙ элемент строки — одна и та же колонка заголовка, а полоса
  // идёт после неё. Поэтому сравниваем состав детей, а не геометрию.
  const kids = (row) => Array.from(row.children).map((c) => c.className);
  assert.equal(kids(rows[0]).filter((c) => c.includes('tl-gutter')).length, 1,
    'колонка заголовка в строке РОВНО ОДНА: две уводят полосу на её ширину, '
    + 'и выравнивание пропадает — этот баг уже был однажды');
  assert.ok(kids(rows[0])[0].includes('tl-gutter'),
    'первый элемент строки исходника — колонка заголовка, а не сама полоса');
  assert.ok(kids(rows[0]).at(-1).includes('foley-lane'),
    'последний элемент — полоса: между колонкой и полосой ничего нет');
  const clipRow = document.querySelector('#foley-track .foley-row:not(.src)');
  assert.ok(kids(clipRow)[0].includes('tl-gutter'),
    'у строки размещения та же колонка — значит полосы начинаются вместе');
  assert.ok(document.querySelector('#foley-track .foley-src-wave svg path'),
    'волформа исходной дорожки нарисована');
  assert.equal(document.querySelectorAll('#foley-track .foley-src-tick').length, 3,
    'отметка на каждый найденный шаг');
});

test('исходники: дорожка стоит на шкале видео, а не на своей', () => {
  srcScene();
  putSrc();
  // Строка размещения должна быть в блоке — иначе не с чем сравнивать масштаб,
  // и проверка держалась бы на состоянии, оставленном чужими тестами.
  state.setPlacements([
    { id: 'z1', time: 0.0, duration: 0.33, file: 'steps 02.L.wav', cutFrom: 0, cutTo: 0.33, category: 'steps' },
  ]);
  setSrc(true);
  const row = document.querySelector('#foley-track .foley-row.src');
  const clipRow = document.querySelector('#foley-track .foley-row:not(.src)');
  assert.ok(clipRow, 'строка размещения в блоке есть — с ней и сравниваем');
  // Полоса — во всю ширину таймлайна, как у клипа: иначе шкалы снова разъедутся
  // и playhead не дойдёт до конца дорожки. Раньше здесь была ширина записи
  // (20 с), и полоса заканчивалась на трети таймлайна.
  const srcW = parseFloat(row.querySelector('.foley-lane').style.width);
  const clipW = parseFloat(clipRow.querySelector('.foley-lane').style.width);
  assert.ok(srcW > 0, 'полоса исходника имеет ширину');
  assert.equal(srcW, clipW,
    'полоса исходника занимает тот же масштаб, что видео и размещение');
  // Отметки переводятся на шкалу монтажа через sourceTimeAt. Проверяем отношением:
  // pps внутри модуля неизвестен, а отношение координат от него не зависит.
  const track = state.state.foleyTracks[0];
  const lefts = Array.from(row.querySelectorAll('.foley-src-tick'))
    .map((t) => parseFloat(t.style.left));
  const ats = track.events.map((e) => state.sourceTimeAt(track, e.time));
  assert.equal(lefts.length, ats.length, 'отметка на каждый найденный шаг');
  for (let i = 0; i < lefts.length; i++) {
    assert.equal(lefts[i], ats[i] * (lefts[0] / ats[0]),
      `отметка ${i} лежит на шкале видео, а не на шкале записи`);
  }
});

test('исходники: сдвиг правится кадровыми кнопками', () => {
  srcScene();
  putSrc();
  setSrc(true);
  const track = state.state.foleyTracks[0];
  const fps = state.state.settings.fps;
  const q = () => document.querySelectorAll('#foley-track .foley-row.src .src-nudge');
  assert.equal(q().length, 4,
    'четыре кнопки: на кадр раньше, на кадр позже, подгонка по клипу, сброс');
  assert.equal(track.reg.d, 0, 'без правки сдвига нет');

  // после клика дорожка перерисовывается, поэтому кнопки переспрашиваем
  q()[1].click();
  assert.ok(Math.abs(track.reg.d - 1 / fps) < 1e-9,
    'кнопка сдвигает ровно на кадр, а не на круглую секунду');
  q()[0].click();
  assert.ok(Math.abs(track.reg.d) < 1e-9, 'кнопки симметричны');

  q()[1].click(); q()[1].click();
  assert.ok(Math.abs(track.reg.d - 2 / fps) < 1e-9, 'сдвиг накопился');
  q()[3].click();
  assert.equal(track.reg.d, 0, 'сброс возвращает дорожку к началу видео');
});

test('исходники: дорожка подгоняется по размеру клипа', () => {
  srcScene();
  putSrc();
  // Дорожка 20 с, клип 60 с — без подгонки отметки разъедутся с картинкой
  const track = state.state.foleyTracks[0];
  assert.equal(track.duration, 20, 'в сцене дорожка длиной 20 с');
  assert.equal(track.reg.k, 1, 'без подгонки запись идёт как записана');
  setSrc(true);
  const q = () => document.querySelectorAll('#foley-track .foley-row.src .src-nudge');
  q()[2].click();   // ⤢
  assert.ok(Math.abs(track.reg.k - 3) < 1e-9,
    'подгонка растягивает запись на длину клипа: 60 / 20 = 3');
  // Отметка на 3 с записи после подгонки должна лежать на 9 с таймлайна
  const row = document.querySelector('#foley-track .foley-row.src');
  const lefts = Array.from(row.querySelectorAll('.foley-src-tick'))
    .map((t) => parseFloat(t.style.left));
  const ats = track.events.map((e) => state.sourceTimeAt(track, e.time));
  for (let i = 0; i < lefts.length; i++) {
    assert.equal(lefts[i], ats[i] * (lefts[0] / ats[0]),
      `отметка ${i} лежит там, куда её перевела подгонка`);
  }
  assert.equal(ats[1], 9, 'третья секунда записи после подгонки — девятая таймлайна');
  // Проигрывание выреза идёт по времени записи, поэтому звук не «пищит»
  assert.equal(track.events[1].time, 3, 'время в записи не тронуто');
});

test('sourceTimeAt: запись переводится на шкалу монтажа', () => {
  const t = (reg) => ({ name: 'x', duration: 20, events: [], reg });
  assert.equal(state.sourceTimeAt(t({ k: 1, d: 0 }), 5), 5, 'без правки время то же');
  assert.equal(state.sourceTimeAt(t({ k: 1, d: 0.5 }), 5), 5.5, 'сдвиг прибавляется');
  assert.equal(state.sourceTimeAt(t({ k: 1.01, d: 0 }), 100), 101, 'растяжение умножает');
  assert.equal(state.sourceTimeAt(t({ k: 0.99, d: 0.2 }), 10), 10.1,
    'сдвиг и растяжение вместе');
  // дорожка без регистрации — как записано: setSourceTrack подставляет дефолт,
  // но дорожка могла прийти из сохранённого проекта без него
  assert.equal(state.sourceTimeAt({ duration: 20, events: [] }, 3), 3,
    'без reg время не меняется');
});

test('fitSourceTrackToClip: запись встаёт по размеру клипа', () => {
  const reg = (name) => state.state.foleyTracks.find((x) => x.name === name);
  srcScene();
  putSrc();                       // дорожка длиной 20 с, события [1,3,5,7]
  assert.equal(reg(SRC).duration, 20, 'в сцене дорожка 20 с');
  assert.equal(reg(SRC).reg.k, 1, 'до подгонки запись идёт как записана');

  state.fitSourceTrackToClip(SRC, 60);
  assert.ok(Math.abs(reg(SRC).reg.k - 3) < 1e-9, '60 / 20 = 3');
  assert.equal(reg(SRC).events[1].time, 3,
    'подгонка не трогает время в записи — звук не «пищит»');
  assert.equal(state.sourceTimeAt(reg(SRC), 3), 9,
    'третья секунда записи после подгонки — девятая таймлайна');
  assert.equal(reg(SRC).reg.d, 0, 'сдвиг подгонка не меняет');

  // повторная подгонка считается от текущего размера записи, а не кумулятивно
  state.fitSourceTrackToClip(SRC, 10);
  assert.ok(Math.abs(reg(SRC).reg.k - 0.5) < 1e-9, '10 / 20 = 0.5');

  // нет клипа или нет дорожки — ничего не ломается
  state.fitSourceTrackToClip(SRC, 0);
  assert.ok(Math.abs(reg(SRC).reg.k - 0.5) < 1e-9, 'нулевой клип не подгоняет');
  state.fitSourceTrackToClip(SRC + 'нет', 5);
  assert.equal(state.state.foleyTracks.length, 1, 'несуществующая дорожка игнорируется');
  putSrc();
  state.fitSourceTrackToClip(SRC, 60);
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

/* ---------- мьют и соло дорожек ---------- */
test('мьют/соло: кнопки на строке дорожки', () => {
  srcScene();
  putSrc();
  state.setPlacements([
    { id: 'z1', time: 12.5, duration: 0.3, file: 'steps 02.L.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  timeline.render();
  const btns = document.querySelectorAll('#foley-track .foley-mix-btn');
  assert.equal(btns.length, 2, 'M и S на строке дорожки');
  assert.deepEqual([...btns].map((b) => b.textContent), ['M', 'S']);
  assert.equal(btns[0].dataset.file, 'steps 02.L.wav', 'кнопка знает свою дорожку');
});

test('мьют/соло: нажатие гасит дорожку и метит кнопку', () => {
  srcScene();
  state.setPlacements([
    { id: 'z1', time: 12.5, duration: 0.3, file: 'steps 02.L.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  timeline.render();
  const m = document.querySelector('#foley-track .foley-mix-btn[data-key="mute"]');
  m.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(state.state.mix['steps 02.L.wav'].mute, true, 'состояние запомнилось');
  assert.equal(state.trackAudible('steps 02.L.wav'), false, 'дороже не слышна');
  assert.ok(document.querySelector('#foley-track .foley-row').classList.contains('silent'),
    'строка потухла — по таймлайну видно, что дорожка заглушена');
  const m2 = document.querySelector('#foley-track .foley-mix-btn[data-key="mute"]');
  assert.ok(m2.classList.contains('on'), 'кнопка M подсвечена');
});

test('мьют/соло: соло сильнее мьюта', () => {
  state.state.mix = {};
  state.setPlacements([
    { id: 'z1', time: 1, duration: 0.3, file: 'a.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
    { id: 'z2', time: 2, duration: 0.3, file: 'b.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  timeline.render();
  state.setTrackMute('a.wav', true);
  state.setTrackSolo('a.wav', true);
  state.setTrackSolo('b.wav', false);
  assert.equal(state.trackAudible('a.wav'), false,
    'замьюченная дорожка молчит, даже если она в соло');
  assert.equal(state.trackAudible('b.wav'), false,
    'кто не в соло — молчит, раз соло вообще есть');
  state.setTrackMute('a.wav', false);
  assert.equal(state.trackAudible('a.wav'), true, 'сняли мьют — снова слышна');
});

test('мьют/соло: без соло мьют гасит только свою дорожку', () => {
  state.state.mix = {};
  state.setTrackMute('a.wav', true);
  assert.equal(state.trackAudible('a.wav'), false);
  assert.equal(state.trackAudible('b.wav'), true, 'чужая дорожка не тронута');
});

test('мьют/соло: заглушённая дорожка не звучит в тике', () => {
  state.state.mix = {};
  bank.putTrack('a.wav', { data: new Float32Array(10000).fill(0.5), sampleRate: 1000 });
  state.setPlacements([
    { id: 'z1', time: 1, duration: 0.3, file: 'a.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  state.state.playing = true;
  const before = SOURCE_STARTS.length;
  state.setTrackMute('a.wav', true);
  foley.tick(1 - 1 / 25, 1);
  assert.equal(SOURCE_STARTS.length, before, 'замьюченная дорожка молчит');
  state.setTrackMute('a.wav', false);
  foley.tick(1 - 1 / 25, 1);
  assert.ok(SOURCE_STARTS.length > before, 'сняли мьют — дубль звучит');
});

/* ---------- зум не должен выбрасывать содержимое ---------- */
test('зум: playhead в окне — масштаб якорится на него', () => {
  srcScene();
  const tl = document.getElementById('timeline');
  const viewW = 800;
  Object.defineProperty(tl, 'clientWidth', { configurable: true, get: () => viewW });
  // playhead на 26-й секунде — в окне, значит зум должен держать его
  state.bus.emit(state.EV.TIME, 26);
  const pps = timeline.timelinePps();
  tl.scrollLeft = Math.max(0, Math.round((timeline.timelineGutter() + 26 * pps) - viewW / 2));
  const before = tl.scrollLeft;

  document.getElementById('zoom-in').click();
  const after = timeline.timelinePps();
  assert.ok(after > pps, 'масштаб увеличился');
  const phX = timeline.timelineGutter() + 26 * after;
  assert.ok(phX >= tl.scrollLeft && phX <= tl.scrollLeft + viewW,
    `playhead должен остаться в окне: scrollLeft=${tl.scrollLeft}, playhead=${phX}`);
});

test('зум: playhead за окном — масштаб якорится на центр', () => {
  srcScene();
  const tl = document.getElementById('timeline');
  const viewW = 800;
  Object.defineProperty(tl, 'clientWidth', { configurable: true, get: () => viewW });
  state.bus.emit(state.EV.TIME, 0);          // playhead ушёл влево из вида
  const pps = timeline.timelinePps();
  tl.scrollLeft = 4000;                       // далеко вправо
  const anchorT = (4000 + viewW / 2) / pps;

  document.getElementById('zoom-in').click();
  const after = timeline.timelinePps();
  const nowT = (tl.scrollLeft + viewW / 2) / after;
  assert.ok(Math.abs(nowT - anchorT) < 0.2,
    `время в центре окна не должно уезжать: было ${anchorT.toFixed(2)}, стало ${nowT.toFixed(2)}`);
});

test('зум: playhead остаётся в окне при воспроизведении', () => {
  srcScene();
  const tl = document.getElementById('timeline');
  const viewW = 800;
  Object.defineProperty(tl, 'clientWidth', { configurable: true, get: () => viewW });
  document.getElementById('zoom-in').click();
  document.getElementById('zoom-in').click();
  const pps = timeline.timelinePps();
  // playhead ушёл далеко вправо — таймлайн должен догнать его
  state.state.playing = true;
  state.bus.emit(state.EV.TIME, 40);
  const x = 40 * pps;
  assert.ok(tl.scrollLeft <= x && x <= tl.scrollLeft + viewW,
    `playhead должен быть виден: scrollLeft=${tl.scrollLeft}, x=${x}`);
  state.state.playing = false;
});

/* ---------- кнопки мьют/соло должны быть видимы, а не спрятаны в якоре ---------- */
test('заголовок дорожки: колонка с именем, мьютом, соло и громкостью', () => {
  srcScene();
  state.setPlacements([
    { id: 'z1', time: 12.5, duration: 0.3, file: 'steps 02.L.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  timeline.render();
  const head = document.querySelector('#foley-track .foley-row .tl-gutter');
  assert.ok(head, 'колонка заголовка есть');
  assert.equal(head.querySelector('.tl-gutter-name').textContent, 'steps 02.L',
    'имя дорожки в колонке');
  assert.equal(head.querySelectorAll('.foley-mix-btn').length, 2, 'M и S');
  assert.ok(head.querySelector('.foley-vol'), 'свой ползунок громкости');
  assert.equal(head.querySelector('.foley-vol').value, '1', 'громкость по умолчанию 1');

  // колонка не должна накладываться на волноформу:
  // содержимое дорожки начинается после неё
  const lane = document.querySelector('#foley-track .foley-row .foley-lane');
  assert.ok(lane, 'полоса с клипами на месте');
  assert.equal(head.nextElementSibling, lane,
    'колонка заголовка и полоса — соседи в потоке, а не наложение');
});

test('заголовок дорожки: громкость своя и попадает в звук', () => {
  srcScene();
  bank.putTrack('a.wav', { data: new Float32Array(10000).fill(0.5), sampleRate: 1000 });
  state.setPlacements([
    { id: 'z1', time: 1, duration: 0.3, file: 'a.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  timeline.render();
  const vol = document.querySelector('#foley-track .foley-vol');
  vol.value = '0.5';
  vol.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(state.state.mix['a.wav'].volume, 0.5, 'громкость запомнилась');
  state.state.playing = true;
  const before = SOURCE_STARTS.length;
  foley.tick(1 - 1 / 25, 1);
  assert.ok(SOURCE_STARTS.length > before, 'дубль звучит');
});

test('заголовок дорожки: колонка не сдвигает время', () => {
  srcScene();
  state.setPlacements([
    { id: 'z1', time: 12.5, duration: 0.3, file: 'steps 02.L.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  timeline.render();
  const rulerBody = document.querySelector('#ruler .tl-body');
  assert.ok(rulerBody, 'у линейки своя колонка-заглушка');
  assert.equal(rulerBody.style.width,
    document.querySelector('#foley-track .foley-lane').style.width,
    'ширина содержимого линейки и дорожки совпадает — время не разъедется');
  // ставим playhead на то же время, что и клип, и сравниваем положения
  state.bus.emit(state.EV.TIME, 12.5);
  const playhead = document.getElementById('playhead');
  const clip = document.querySelector('#foley-track .foley-clip');
  assert.equal(parseFloat(playhead.style.left),
    parseFloat(clip.style.left) + timeline.timelineGutter(),
    'playhead и клип стоят над одним временем');
});

test('мьют/соло: кнопки переживают перерисовку таймлайна', () => {
  srcScene();
  state.setPlacements([
    { id: 'z1', time: 12.5, duration: 0.3, file: 'steps 02.L.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  state.bus.emit(state.EV.TIME, 5);
  timeline.render();
  state.bus.emit(state.EV.TIME, 6);
  timeline.render();
  assert.equal(document.querySelectorAll('#foley-track .foley-mix-btn').length, 2,
    'после кадров времени кнопки на месте — таймлайн перерисовывается каждый кадр');
});

test('панель инструментов таймлайна не обрезает кнопки', async () => {
  const bar = document.querySelector('.timeline-toolbar');
  const ids = ['zoom-out', 'zoom-in', 'zoom-fit', 'btn-foley-toggle', 'btn-foley-src'];
  for (const id of ids) {
    assert.ok(bar.contains(document.getElementById(id)),
      `кнопка #${id} живёт в панели инструментов, а не выпадает из неё`);
  }
  // перенос строки — единственный способ не обрезать ряд на узком окне
  const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.timeline-toolbar\s*\{[^}]*flex-wrap:\s*wrap/,
    'панель инструментов должна переноситься, иначе кнопки уезжают за край');
});

/* ---------- целостность CSS ---------- */
test('CSS цел: незакрытый комментарий съел бы все правила после себя', async () => {
  const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
  // Правка выравнивания исходников однажды оставила комментарий незакрытым, и
  // всё, что ниже, ушло в комментарий: правила .foley-src-head и .orig-step
  // перестали существовать. Тесты этого не заметили, потому что CSS они не
  // читают, а сборка на CSS не смотрит вовсе. Баланс проверяется напрямую.
  const open = (css.match(/\/\*/g) || []).length;
  const close = (css.match(/\*\//g) || []).length;
  assert.equal(open, close, `комментариев открыто ${open}, закрыто ${close}`);
  // Ради чего выравнивание: колонка заголовка одна и та же у всех строк
  // таймлайна, и от её ширины зависит, где начинается полоса.
  assert.match(css, /\.tl-gutter\s*\{[^}]*flex:\s*0 0 152px/,
    'колонка заголовка — 152 px, и это общий столбик для видео и исходников');
});

/* ---------- понятно, где фоли звучит ---------- */
test('свёрнутый ряд говорит, на каком участке фоли звучит', () => {
  srcScene();
  state.setPlacements([
    { id: 'z1', time: 0.0, duration: 0.33, file: 'steps 02.L.wav', cutFrom: 0, cutTo: 0.33, category: 'steps' },
    { id: 'z2', time: 0.33, duration: 0.33, file: 'steps 02.L.wav', cutFrom: 0.33, cutTo: 0.67, category: 'steps' },
  ]);
  // свёрнутый вид
  state.bus.emit(state.EV.PLACEMENTS);
  document.getElementById('btn-foley-toggle').click();
  timeline.render();
  const span = document.getElementById('foley-span');
  assert.ok(span, 'подпись диапазона есть');
  assert.match(span.textContent, /звучит 00:00/, 'диапазон назван прямо');
  assert.match(span.textContent, /% длины/, 'и доля от длины клипа');
  assert.match(span.textContent, /1% длины/,
    'два дубля в первую секунду минуты — это ~1%, и это должно быть видно');
});

test('без размещения подпись диапазона не появляется', () => {
  srcScene();
  state.setPlacements([]);
  document.getElementById('btn-foley-toggle').click();
  timeline.render();
  assert.ok(!document.getElementById('foley-span'), 'нечего описывать');
});

/* ---------- зум должен возвращаться ---------- */
// Пользователь трижды: «при масштабировании улетает вправо и не возвращается».
// Кроме якоря зума нашлись три отдельных дефекта прокрутки.
test('зум: «Весь проект» возвращает и масштаб, и вид', () => {
  srcScene();
  const tl = document.getElementById('timeline');
  Object.defineProperty(tl, 'clientWidth', { configurable: true, get: () => 1270 });
  timeline.fitToWindow();                       // подгонка уже при нужной ширине
  const fitPps = timeline.timelinePps();

  document.getElementById('zoom-in').click();
  document.getElementById('zoom-in').click();
  assert.ok(timeline.timelinePps() > fitPps, 'масштаб вырос');
  tl.scrollLeft = 900;                       // вид увели вправо

  document.getElementById('zoom-fit').click();
  assert.equal(timeline.timelinePps(), fitPps, 'масштаб вернулся к подгонке');
  assert.equal(tl.scrollLeft, 0,
    'и вид вернулся к началу — иначе кнопка не возвращает картину');
});

test('зум: когда содержимое помещается в окно, прокрутка сбрасывается', () => {
  srcScene();
  const tl = document.getElementById('timeline');
  Object.defineProperty(tl, 'clientWidth', { configurable: true, get: () => 1270 });
  timeline.fitToWindow();
  tl.scrollLeft = 400;
  timeline.render();
  assert.equal(tl.scrollLeft, 0,
    'прокручивать нечего — сдвиг только мешает');
});

test('полоса фоли той же ширины, что и линейка', () => {
  srcScene();
  state.setPlacements([
    { id: 'z1', time: 12.5, duration: 0.3, file: 'steps 02.L.wav', cutFrom: 0, cutTo: 0.3, category: 'steps' },
  ]);
  timeline.render();
  assert.equal(document.getElementById('foley-track').style.width,
    document.getElementById('ruler').style.width,
    'колонка заголовков + содержимое: иначе дорожки фоли короче линейки');
});

test('keepInView считает playhead с учётом колонки заголовков', () => {
  srcScene();
  const tl = document.getElementById('timeline');
  Object.defineProperty(tl, 'clientWidth', { configurable: true, get: () => 800 });
  timeline.fitToWindow();
  document.getElementById('zoom-in').click();
  document.getElementById('zoom-in').click();
  const pps = timeline.timelinePps();
  state.state.playing = true;
  state.bus.emit(state.EV.TIME, 40);
  const phX = timeline.timelineGutter() + 40 * pps;
  assert.ok(phX >= tl.scrollLeft && phX <= tl.scrollLeft + 800,
    `playhead должен быть виден: scrollLeft=${tl.scrollLeft}, playhead=${phX}`);
  state.state.playing = false;
});
