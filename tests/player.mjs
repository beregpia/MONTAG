/* ============ Тесты плеера: холст должен рисовать или честно говорить почему нет ============
 *
 * Баг, из-за которого пользователь видел шахматку сцены вместо картинки:
 * `getContext('2d')` вернул null, а `renderFrame` молча выходил — приложение
 * выглядело работающим (импорт, таймлайн, время), но кадров не было.
 * Тесты закрепляют оба пути: холст рисует И холст не рисует, но тогда
 * появляется объяснение и резервный видеослой.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers.mjs';

const { document, window } = await setupDom();

const player = await import(new URL('../js/player.js', import.meta.url).href);
const state = await import(new URL('../js/state.js', import.meta.url).href);

function addClip(dur = 10) {
  state.state.media.push({ id: 'm1', name: 'v.mp4', duration: dur, url: 'blob:fake', width: 1920, height: 882 });
  state.state.clips.push({
    id: 'c1', mediaId: 'm1', in: 0, out: dur, transitionIn: 'none', volume: 1, name: 'v.mp4',
  });
}

function stageVideos() {
  return [...document.getElementById('stage').querySelectorAll('video')];
}

test('холст недоступен: приложение честно об этом сообщает', () => {
  addClip();
  player.initPlayer(document.getElementById('canvas'));
  assert.equal(player.canvasBlocked(), true, 'должно быть распознано, что холст не рисует');
  const warn = document.getElementById('canvas-warn');
  assert.ok(warn, 'на сцене нет объяснения — пользователь снова увидит шахматку без причины');
  assert.match(warn.textContent, /2D-контекст/);
  assert.match(warn.textContent, /MONTAG\.bat/, 'в подсказке должен быть рабочий выход');
});

test('холст недоступен: кадр всё равно показывается резервным видеослоем', () => {
  addClip();
  player.initPlayer(document.getElementById('canvas'));
  player.renderFrame(1);
  const vids = stageVideos();
  assert.equal(vids.length, 1, 'резервный видеослой не показан');
  assert.equal(vids[0].style.objectFit, 'cover', 'резервный слой должен повторять cover-fit холста');
  assert.equal(vids[0].style.position, 'absolute');
});

test('холст недоступен: вне клипа видеослой убирается', () => {
  addClip(10);
  player.initPlayer(document.getElementById('canvas'));
  player.renderFrame(50);
  assert.equal(stageVideos().length, 0, 'видеослой остался висеть вне клипа');
});

test('холст работает: рисуется чёрный фон и объяснения на сцене нет', () => {
  // объяснение от предыдущих проверок в том же документе убираем
  document.getElementById('canvas-warn')?.remove();
  const fills = [];
  const fake = {
    fillStyle: '',
    globalAlpha: 1,
    fillRect: (...a) => fills.push(a),
    drawImage: () => {},
    save() {}, restore() {}, translate() {}, scale() {},
  };
  window.HTMLCanvasElement.prototype.getContext = () => fake;
  addClip();
  player.initPlayer(document.getElementById('canvas'));
  assert.equal(player.canvasBlocked(), false, 'холст считается рабочим');
  assert.equal(document.getElementById('canvas-warn'), null, 'предупреждение не должно появляться');
  player.renderFrame(1);
  assert.ok(fills.length >= 1, 'кадр не залит — сцена останется прозрачной');
  assert.equal(fills[0][0], 0);
  assert.equal(fills[0][2], state.state.settings.width);
  assert.equal(fills[0][3], state.state.settings.height);
  assert.equal(stageVideos().length, 0, 'при живом холсте резервный слой не нужен');
});

test('разрешение холста переключается вместе с настройками проекта', () => {
  const canvas = document.getElementById('canvas');
  window.HTMLCanvasElement.prototype.getContext = () => null;
  player.initPlayer(canvas);
  state.state.settings.width = 1920;
  state.state.settings.height = 1080;
  player.applyResolution();
  assert.equal(canvas.width, 1920);
  assert.equal(canvas.height, 1080);
  state.state.settings.width = 1280;
  state.state.settings.height = 720;
});

test('холст оживает: повторная попытка снимает объяснение и резервный слой', async () => {
  window.HTMLCanvasElement.prototype.getContext = () => null;
  addClip();
  player.initPlayer(document.getElementById('canvas'));
  assert.equal(player.canvasBlocked(), true);
  player.renderFrame(1);
  assert.equal(stageVideos().length, 1);

  // «GPU поднялся» — контекст наконец отдан
  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: '', globalAlpha: 1, fillRect() {}, drawImage() {},
    save() {}, restore() {}, translate() {}, scale() {},
  });
  const got = player.retryCanvas();
  assert.ok(got, 'повторная попытка не взяла контекст');
  assert.equal(player.canvasBlocked(), false);
  assert.equal(document.getElementById('canvas-warn'), null, 'объяснение осталось висеть');
  assert.equal(stageVideos().length, 0, 'резервный видеослой не убран');
  player.renderFrame(1);
  assert.equal(stageVideos().length, 0, 'после оживания холста слой не должен возвращаться');
});

test('холст подстраивается под пропорции клипа: 1920×882 не режется', () => {
  window.HTMLCanvasElement.prototype.getContext = () => null;
  player.initPlayer(document.getElementById('canvas'));
  state.state.settings.width = 1280;
  state.state.settings.height = 720;
  player.adoptResolution({ width: 1920, height: 882 });
  assert.equal(state.state.settings.width, 1920, 'ширина не приняла пропорции клипа');
  assert.equal(state.state.settings.height, 882, 'высота не приняла пропорции клипа');
  assert.equal(document.getElementById('canvas').width, 1920);
  assert.equal(document.getElementById('canvas').height, 882);
  const sel = document.getElementById('resolution');
  assert.equal(sel.value, '1920x882', 'в списке разрешений не выбрано «как в клипе»');
  assert.ok([...sel.options].some((o) => o.value === '1920x882'), 'варианта «как в клипе» нет в списке');
});

test('4K уменьшается вдвое, но пропорции сохраняются', () => {
  player.adoptResolution({ width: 3840, height: 2160 });
  assert.equal(state.state.settings.width, 1920);
  assert.equal(state.state.settings.height, 1080);
});

test('без размеров клипа разрешение не трогаем', () => {
  const w = state.state.settings.width;
  const h = state.state.settings.height;
  player.adoptResolution({});
  player.adoptResolution({ width: 0, height: 0 });
  player.adoptResolution(null);
  assert.equal(state.state.settings.width, w);
  assert.equal(state.state.settings.height, h);
});

test('кадр не готов: на сцени появляется подсказка, а не молчаливый чёрный экран', () => {
  document.getElementById('frame-hint')?.remove();
  // холст рабочий, но кадр видео ещё не декодировался
  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: '', globalAlpha: 1, fillRect() {}, drawImage() {},
    save() {}, restore() {}, translate() {}, scale() {},
  });
  addClip(10);
  player.initPlayer(document.getElementById('canvas'));
  player.renderFrame(1);
  const hint = document.getElementById('frame-hint');
  assert.ok(hint, 'подсказки нет — пользователь видит чёрный экран без объяснения');
  assert.match(hint.textContent, /Кадр ещё не декодировался/);
});

test('кадр готов: подсказка убирается', () => {
  document.getElementById('frame-hint')?.remove();
  // видео с готовым кадром: videoWidth задан и readyState достаточный
  const clip = state.state.clips[0];
  const v = document.createElement('video');
  Object.defineProperty(v, 'videoWidth', { get: () => 640 });
  Object.defineProperty(v, 'videoHeight', { get: () => 360 });
  Object.defineProperty(v, 'readyState', { get: () => 4 });
  clip._video = v;
  player.renderFrame(1);
  assert.equal(document.getElementById('frame-hint'), null, 'подсказка осталась при готовом кадре');
});

/* ---------- покадровое перемещение ---------- */
// Пользователь: «видео по кадрам не перемещает». Причина: порог подтягивания
// видео был 0.3 с, а шаг в кадр — 0.04 с. Время менялось, currentTime видео
// нет, кадр оставался старым. Порог был в трёх местах.
function fakeVideo(clip, sets) {
  const v = {
    src: 'blob:fake', videoWidth: 1920, readyState: 4, paused: true,
    currentTime: 0, style: {},
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get() { return this._t || 0; },
    set(x) { this._t = x; sets.push(x); },
  });
  clip._video = v;
  return v;
}

test('шаг в кадр двигает и время, и само видео', () => {
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  state.state.settings.fps = 25;
  state.state.playing = false;
  const sets = [];
  const v = fakeVideo(state.state.clips[0], sets);

  player.seek(10);
  const before = sets.length;
  player.stepFrames(1);
  assert.equal(state.state.time, 10.04, 'время сдвинулось на кадр');
  assert.ok(sets.length > before, 'видео получило новую позицию — иначе кадр старый');
  assert.equal(v.currentTime, 10.04, 'currentTime видео совпадает со временем');
});

test('шаг в кадр не накапливает погрешность', () => {
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  state.state.settings.fps = 25;
  state.state.playing = false;
  fakeVideo(state.state.clips[0], []);
  player.seek(10);
  for (let i = 0; i < 25; i++) player.stepFrames(1);
  assert.equal(state.state.time, 11, '25 шагов вправо — ровно секунда, без дрейфа');
  player.stepFrames(-25);
  assert.equal(state.state.time, 10, 'и обратно тоже точно');
});

test('шаг в кадр учитывает fps проекта', () => {
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  state.state.settings.fps = 30;
  state.state.playing = false;
  fakeVideo(state.state.clips[0], []);
  player.seek(5);
  player.stepFrames(1);
  assert.ok(Math.abs(state.state.time - (5 + 1 / 30)) < 1e-9, 'шаг равен 1/30 с');
});

test('при воспроизведении частые seek не дергают видео', () => {
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  state.state.settings.fps = 25;
  state.state.playing = true;
  const sets = [];
  fakeVideo(state.state.clips[0], sets);
  player.seek(10);
  const before = sets.length;
  player.stepFrames(1);
  assert.equal(sets.length, before,
    'на ходу видео и так играет — лишний seek дал бы рывки');
  // без сброса флаг утекает в следующие тесты и ломает им условия
  state.state.playing = false;
});

/* ---------- кадр на паузе: видео должно быть в документе ---------- */
// Пользователь: «в паузе нет изображения». Сцена чёрная, подпись «Кадр ещё не
// декодировался».
//
// Причина: Chrome и Edge не декодируют кадры для <video>, которого нет в
// документе. drawCover молча уходит при readyState < 2, placeVideo молча выходит
// при readyState < 1 — и никто не просит декодер поработать. При «Пуске»
// play() оживляет его сам, поэтому в воспроизведении картинка была, а на паузе
// нет. Ровно этот симптом и описал пользователь.
function freshClip(dur = 10) {
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(dur);
  return state.state.clips[0];
}

test('видео клипа попадает в документ — иначе Chrome не декодирует кадры', () => {
  const clip = freshClip();
  const v = player.videoFor(clip);
  assert.ok(v.parentNode, 'видео вне документа — на паузе кадра не будет');
  assert.ok(document.getElementById('video-sink').contains(v),
    'видео должно лежать в приёмнике, а не болтаться вне DOM');
});

test('видео скрыто непрозрачностью, а не display:none', () => {
  // display:none останавливает декодирование полностью — лечило бы «чёрный
  // экран», сломав всё остальное.
  const v = player.videoFor(freshClip());
  assert.match(v.style.cssText, /opacity:\s*0/, 'элемент должен быть невидим');
  assert.ok(!/display:\s*none/.test(v.style.cssText),
    'display:none остановит декодирование — кадра не будет никогда');
  assert.match(v.style.cssText, /pointer-events:\s*none/, 'скрытое видео не должно ловить клики');
});

test('на паузе элемент клипа не вкладывается в незапущенный контекст звука', () => {
  // Регрессия из ветки звука клипа: разбор звука создаёт аудио-контекст при
  // импорте, и он остаётся зависшим (жест пользователя к тому времени уже не в
  // цепочке вызовов). audioChain вкладывал в него элемент — после этого Chrome
  // считает элемент неиграющим: seek не доходит до конца, seeked не приходит,
  // readyState застревает на 1, сцена чёрная. Элемент при этом перестаёт быть
  // заглушённым, и автополитика блокирует тот самый play(), которым дёргается
  // декодер. До появления разбора звука этот путь не включался: контекста на
  // паузе ещё не существовало.
  const clip = freshClip();
  const v = player.videoFor(clip);
  // readyState обязан быть 1+: ниже audioChain выходит раньше проверки
  // контекста, и тест проходил бы по неверной причине
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => 1 });
  const actx = player.ensureAudio();
  assert.ok(actx, 'контекст звука не поднялся');
  const prev = actx.state;
  actx.state = 'suspended';
  try {
    player.renderFrame(0);
    assert.equal(clip._gain, undefined,
      'на паузе элемент не должен вкладываться в зависший контекст');
    assert.equal(v.muted, true,
      'пока контекст не запущен, элемент обязан остаться заглушённым');
  } finally {
    actx.state = prev;
    delete clip._gain;
    delete clip._gate;
  }
});

test('при запущенном контексте цепочка звука строится как обычно', () => {
  // Обратная сторона той же проверки: guarding не должен отнимать у клипа
  // оригинальный звук, когда звук реально идёт.
  const clip = freshClip();
  const v = player.videoFor(clip);
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => 1 });
  const actx = player.ensureAudio();
  actx.state = 'running';
  try {
    player.renderFrame(0);
    assert.ok(clip._gain, 'цепочка не построилась — оригинального звука не будет');
    assert.equal(v.muted, false, 'звук должен идти через граф, а не напрямую');
  } finally {
    actx.state = 'running';
    delete clip._gain;
    delete clip._gate;
  }
});

test('видео создаётся по рецепту пробника, который в браузере работает', () => {
  // Пробник в media.js делает миниатюру клипа, и она РАБОТАЕТ у пользователя:
  // на таймлайне виден живой кадр. Значит этот рецепт браузер принимает.
  // Что важно сохранить: элемент попадает в документ ДО назначения src (у
  // пробника именно так), и load() НЕ вызывается. Явный load() после src
  // запускает алгоритм загрузки второй раз и сбрасывает элемент в readyState 0.
  const loads = [];
  const origLoad = window.HTMLVideoElement.prototype.load;
  window.HTMLVideoElement.prototype.load = function () { loads.push(this); };
  const sink = document.getElementById('video-sink');
  const order = [];
  const origAppend = sink.appendChild.bind(sink);
  sink.appendChild = (el) => {
    order.push(el.src ? 'src-уже-стоит' : 'src-ещё-нет');
    return origAppend(el);
  };
  try {
    const clip = freshClip();
    const v = player.videoFor(clip);
    assert.equal(loads.length, 0, 'load() сбрасывает загрузку — его быть не должно');
    assert.equal(v.src, 'blob:fake', 'источник не назначен');
    assert.equal(v.preload, 'metadata',
      'preload=metadata, а не auto — ровно как у пробника: при auto Chrome на '
      + 'большом файле тянет всю дорожку, и readyState залипает на 1');
    assert.ok(v.parentNode, 'элемент в документе');
    assert.deepEqual(order, ['src-ещё-нет'],
      'элемент должен быть в документе ДО src: загрузка, начавшаяся у элемента '
      + 'вне документа, для Chrome и Edge декодирования не обеспечивает');
  } finally {
    window.HTMLVideoElement.prototype.load = origLoad;
    sink.appendChild = origAppend;
  }
});

test('прогрев декодера просит НЕНУЛЕВУЮ позицию', () => {
  // Это и есть корень «в паузе нет изображения». seek на позицию 0, в которой
  // свежий элемент уже стоит, браузер считает выполненным: события seeked не
  // будет, декодер не запустится, readyState застрянет на 1, drawCover молча
  // выйдет — сцена чёрная. Пробник в media.js потому и просит 0.25 с.
  const clip = freshClip();
  const v = player.videoFor(clip);
  assert.equal(v.currentTime, 0, 'до метаданных позиция нулевая');
  v.dispatchEvent(new window.Event('loadedmetadata'));
  assert.ok(v.currentTime > 0,
    `прогрев должен увести позицию с нуля, иначе seek из placeVideo останется
     вымышленным (получили ${v.currentTime})`);
  assert.equal(v.dataset.warm, '1', 'прогрев одноразовый');
  // повторное событие греть не должно
  v.currentTime = 0;
  v.dispatchEvent(new window.Event('loadedmetadata'));
  assert.equal(v.currentTime, 0, 'второй прогрев снова увёл бы позицию');
});

test('placeVideo добивает seek, если позиция та же, а кадра нет', () => {
  // readyState 1 и запрошенная позиция равна текущей: без подталкивания
  // assign currentTime ничего не делает и кадр никогда не декодируется.
  const clip = freshClip();
  const v = player.videoFor(clip);
  let ct = 0;
  const seen = [];
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get: () => ct,
    set: (x) => { seen.push(x); ct = x; },
  });
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => 1 });
  state.state.time = 0;
  player.renderFrame(0);
  assert.ok(seen.includes(0.001),
    `без увода на миллисекунду seek остается вымышленным (присвоения: ${seen})`);
  assert.equal(seen[seen.length - 1], 0, 'конечная позиция должна быть запрошенной');
});

test('как только известны метаданные, кадр перерисовывается', () => {
  // placeVideo молча выходит при readyState < 1: до метаданных seek не выдаётся.
  // Без слушателя loadedmetadata сцена оставалась чёрной, хотя кадр уже рядом.
  const clip = freshClip();
  const v = player.videoFor(clip);
  const seen = [];
  v.addEventListener('loadedmetadata', () => seen.push('loadedmetadata'));
  v.dispatchEvent(new window.Event('loadedmetadata'));
  assert.deepEqual(seen, ['loadedmetadata'], 'слушателя loadedmetadata нет');
});

test('медленный декодер: сцена добирает кадр сама', async () => {
  // Событие loadeddata/seeked могло не прийти (или декодер медленный).
  // Раньше сцена оставалась чёрной навсегда — теперь есть ограниченная догон.
  document.getElementById('frame-hint')?.remove();
  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: '', globalAlpha: 1, fillRect() {}, drawImage() {},
    save() {}, restore() {}, translate() {}, scale() {},
  });
  state.state.playing = false;
  const clip = freshClip();
  const v = document.createElement('video');
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => v._rs || 0 });
  Object.defineProperty(v, 'videoWidth', { configurable: true, get: () => (v._rs >= 2 ? 640 : 0) });
  Object.defineProperty(v, 'videoHeight', { configurable: true, get: () => (v._rs >= 2 ? 360 : 0) });
  v.pause = () => {};
  clip._video = v;

  player.initPlayer(document.getElementById('canvas'));
  player.renderFrame(1);
  assert.ok(document.getElementById('frame-hint'), 'подсказка должна быть при неготовом кадре');

  // декодер наконец отдал кадр, но событие мы не получили
  v._rs = 4;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(document.getElementById('frame-hint'), null,
    'сцена не добирала кадр — чёрный экран остаётся навсегда');
});

test('видео не открылось: подпись говорит почему, а не молчит', async () => {
  document.getElementById('frame-hint')?.remove();
  state.state.playing = false;
  const clip = freshClip();
  const v = player.videoFor(clip);
  v.dispatchEvent(new window.Event('error'));
  await new Promise((r) => setTimeout(r, 0));
  const hint = document.getElementById('frame-hint');
  assert.ok(hint, 'ошибка загрузки промолчала — пользователь видит чёрный экран без причины');
  assert.match(hint.textContent, /не открылось/);
  assert.match(hint.textContent, /импорт/i, 'должен быть рабочий выход — переимпорт');
});

test('удаление клипа убирает его видео из документа', () => {
  const clip = freshClip();
  const v = player.videoFor(clip);
  assert.ok(v.parentNode, 'видео в документе');
  state.removeClip(clip.id);
  assert.equal(v.parentNode, null, 'видео осталось в документе — утечка');
});

/* ---------- «в паузе нет изображения»: вторая волна ---------- */
// Первая правка (видео в документе) не добила картину. Найдена вторая причина:
// placeVideo выходил при readyState < 1, а seek — это и есть запрос, который
// заставляет браузер загрузить и декодировать видео. Без него на элементе,
// не отдавшем метаданные, ничего не происходило.

test('seek запрашивается даже до метаданных — иначе декодер не запустится', () => {
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  state.state.playing = false;
  const sets = [];
  const v = fakeVideo(state.state.clips[0], sets);
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => 0 });
  player.seek(7);
  assert.equal(sets.length, 1, 'currentTime не выставлен — загрузка не начнётся');
  assert.equal(sets[0], 7, 'позиция не та');
});

test('декодеру дан толчок, если кадр не пришёл сам', async () => {
  document.getElementById('frame-hint')?.remove();
  state.state.playing = false;
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  const played = [];
  // Настоящий <video>, а не заглушка-объект: резервный путь (холст не отдал
  // контекст) делает stage.appendChild(v), и объект не-Node роняет рендер.
  const v = document.createElement('video');
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => 0 });
  Object.defineProperty(v, 'videoWidth', { configurable: true, get: () => 0 });
  Object.defineProperty(v, 'videoHeight', { configurable: true, get: () => 0 });
  let standing = true;
  v.play = () => { played.push(1); standing = false; return Promise.resolve(); };
  v.pause = () => { standing = true; };
  state.state.clips[0]._video = v;
  player.seek(3);
  // Опрос, а не жёсткие ожидания: между тестами висят чужие таймеры догона,
  // и точный момент толчка зависит от того, сколько их накопилось.
  const until = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  assert.ok(await until(() => played.length >= 1, 4000),
    'декодеру не дан толчок — на паузе кадра может не появиться вовсе');
  assert.ok(await until(() => standing === true, 3000),
    'после толчка видео должно встать на паузу');
});

test('подпись не пугает числами, пока догон не исчерпан', async () => {
  document.getElementById('frame-hint')?.remove();
  state.state.playing = false;
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  const v = fakeVideo(state.state.clips[0], []);
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => 0 });
  Object.defineProperty(v, 'videoWidth', { configurable: true, get: () => 0 });
  player.seek(2);
  const hint = document.getElementById('frame-hint');
  assert.ok(hint, 'подписи нет');
  assert.match(hint.textContent, /Кадр ещё не декодировался/,
    'сразу показывать числа рано — догон ещё идёт');
  await new Promise((r) => setTimeout(r, 300));
  assert.match(document.getElementById('frame-hint').textContent,
    /Кадр ещё не декодировался/, 'через 300 мс догон ещё жив');
});

test('когда догон исчерпан, подпись показывает факты', async () => {
  document.getElementById('frame-hint')?.remove();
  state.state.playing = false;
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  const v = document.createElement('video');
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => 0 });
  Object.defineProperty(v, 'videoWidth', { configurable: true, get: () => 0 });
  Object.defineProperty(v, 'videoHeight', { configurable: true, get: () => 0 });
  v.play = () => Promise.resolve();
  v.pause = () => {};
  state.state.clips[0]._video = v;
  player.seek(2);
  // бюджет: 6 попыток на холсте (1.2 с) + 12 в прямом показе (2.4 с)
  await new Promise((r) => setTimeout(r, 5000));
  const hint = document.getElementById('frame-hint');
  assert.ok(hint, 'подписи нет');
  assert.match(hint.textContent, /readyState 0/,
    'без чисел пользователь не может ничего сообщить, а мы — диагностировать');
  assert.match(hint.textContent, /«Пуск»/, 'должен быть предложен способ проверить');
});

/* ---------- прямой показ: холст не достал кадр — показываем само видео ---------- */
// Пользователь трижды присылал чёрную сцену с подписью «Кадр ещё не
// декодировался», хотя миниатюра клипа на таймлайне — живой кадр из того же
// файла. Значит видео декодируется, но спрятанный в приёмнике элемент (2×2,
// opacity:0) браузер кадром не обеспечивает. Элемент, который ДЕЙСТВИТЕЛЬНО
// нарисован, декодируется всегда — на него и переключаемся.
function stubbedCanvas() {
  window.HTMLCanvasElement.prototype.getContext = () => ({
    fillStyle: '', globalAlpha: 1, fillRect() {}, drawImage() {},
    save() {}, restore() {}, translate() {}, scale() {},
  });
}

function neverReadyVideo() {
  state.state.playing = false;
  const clip = freshClip();
  const v = document.createElement('video');
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => 0 });
  Object.defineProperty(v, 'videoWidth', { configurable: true, get: () => 0 });
  Object.defineProperty(v, 'videoHeight', { configurable: true, get: () => 0 });
  v.pause = () => {};
  clip._video = v;
  return { clip, v };
}

test('холст не даёт кадр: превью переключается на само видео', async () => {
  document.getElementById('frame-hint')?.remove();
  stubbedCanvas();
  const { clip } = neverReadyVideo();
  player.initPlayer(document.getElementById('canvas'));
  player.renderFrame(1);
  // ~0.4 с элемент меняют на свежий (заклинивший не оживает), потом на сцену
  // встаёт уже новый. Берём именно текущий, а не тот, что был в начале.
  await new Promise((r) => setTimeout(r, 1500));
  const v = player.videoFor(clip);
  assert.ok(v.parentNode, 'видео нигде не оказалось');
  assert.equal(v.parentNode.id, 'stage',
    `видео должно быть показано на сцене, а не спрятано (родитель: ${v.parentNode.id})`);
  assert.match(v.style.cssText, /object-fit:\s*cover/, 'видео занимает сцену');
  assert.equal(document.getElementById('canvas').style.display, 'none',
    'холст должен быть спрятан — иначе два элемента дерутся за одно место');
  // Мягкая подпись не нужна: пользователь и так видит видеослой. Диагностика
  // с числами — другое дело, она появляется позже и по делу.
  const hint = document.getElementById('frame-hint');
  assert.ok(!hint || hint.dataset.kind === 'state',
    'мягкая подпись поверх видеослоя только мешает');
});

test('элемент, не отдавший кадр, заменяется свежим, а не мучит до конца сессии', async () => {
  document.getElementById('frame-hint')?.remove();
  stubbedCanvas();
  const { clip, v } = neverReadyVideo();
  player.initPlayer(document.getElementById('canvas'));
  player.renderFrame(1);
  // ~0.4 с на быстрый путь, потом замена
  await new Promise((r) => setTimeout(r, 500));
  assert.notEqual(player.videoFor(clip), v,
    'застрявший элемент не оживает: все последующие переходы уходят в тот же '
    + 'мертвый элемент, и сцена черная до конца сессии');
  assert.equal(v.parentNode, null, 'старый элемент убран из документа');
});

test('прямой показ: когда кадр наконец отдан, превью возвращается на холст', async () => {
  document.getElementById('frame-hint')?.remove();
  stubbedCanvas();
  const { clip } = neverReadyVideo();
  player.initPlayer(document.getElementById('canvas'));
  player.renderFrame(1);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(document.getElementById('canvas').style.display, 'none', 'холст спрятан');

  // декодер ожил — на том элементе, который сейчас в деле
  const v = player.videoFor(clip);
  Object.defineProperty(v, 'readyState', { configurable: true, get: () => 4 });
  Object.defineProperty(v, 'videoWidth', { configurable: true, get: () => 1920 });
  Object.defineProperty(v, 'videoHeight', { configurable: true, get: () => 882 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(document.getElementById('canvas').style.display, '',
    'холст должен вернуться — transitions и наложение снова работают');
  assert.equal(v.parentNode, null, 'видео убрано со сцены');
});

test('прямой показ тоже не дал кадра: подпись показывает факты', async () => {
  document.getElementById('frame-hint')?.remove();
  stubbedCanvas();
  const { v } = neverReadyVideo();
  player.initPlayer(document.getElementById('canvas'));
  player.renderFrame(1);
  await new Promise((r) => setTimeout(r, 6200));
  const hint = document.getElementById('frame-hint');
  assert.ok(hint, 'и прямой показ не помог — подписи нет, пользователь не знает почему');
  assert.match(hint.textContent, /readyState/, 'должны быть факты для сообщения о баге');
  assert.match(hint.textContent, /ширина/);
});
