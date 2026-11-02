/* ============ Движок превью и воспроизведения ============
 * Каждый клип получает собственный <video>, синхронно подтягиваемый
 * к позиции playhead. Кадры композитятся в canvas (cover-fit + затемнение
 * для переходов), поэтому превью и экспорт используют один и тот же рендер.
 */

import { state, clamp, computeLayout, totalDuration, getMedia, primaryClipAt, setVideoAudio, EV, bus, trackAudible } from './state.js';
import { VIDEO_AUDIO_KEY, stepWindows, gateOpenAt, extractVideoAudio, findOriginalSteps, waveformOf } from './video-audio.js';

let canvas = null;
let ctx = null;
let rafId = null;
let clockBase = 0;     // state.time на момент старта воспроизведения
let clockStart = 0;    // performance.now() на момент старта
let lastFrameT = 0;    // позиция предыдущего кадра (для фоли-триггеров)
let frameHook = null;  // (prevT, t) => void — устанавливает модуль фоли
let fallbackVideo = null; // <video> клипа, встроенный в сцену при неработающем холсте
// Прямой показ: превью показывает сам <video>, а не холст. Включается, когда
// холст не может достать кадр. Элемент, который ДЕЙСТВИТЕЛЬНО нарисован, браузер
// декодирует всегда, а спрятанный в приёмнике (2×2, opacity:0) — не всегда.
// Лучше картинка без переходов, чем чёрный экран с подписью.
let directVideo = false;
let directRetries = 0;   // свой бюджет догона в прямом показе
// Время последней отрисовки. Цикл догона обязан продолжать с НЕГО, а не с
// state.time: renderFrame зовут и с позицией, которой в state ещё нет.
let lastRenderT = 0;

/** Регистрирует покадровый хук (используется движком фоли). */
export function setFrameHook(fn) {
  frameHook = fn;
}

/* ---------- аудиограф ---------- */
let audioCtx = null;
let masterGain = null;
let streamDest = null;

export function ensureAudio() {
  if (audioCtx) return audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  audioCtx = new AC();
  masterGain = audioCtx.createGain();
  masterGain.connect(audioCtx.destination);
  streamDest = audioCtx.createMediaStreamDestination();
  masterGain.connect(streamDest);
  return audioCtx;
}

export function getStreamDestination() {
  ensureAudio();
  return streamDest;
}

export function getMasterGain() {
  ensureAudio();
  return masterGain;
}

export function audioContext() {
  return ensureAudio();
}

export function resumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') return audioCtx.resume();
  return Promise.resolve();
}

/** Подключает звук клипа к мастер-шине (один раз на клип). */
function audioChain(clip) {
  const actx = ensureAudio();
  // Элемент, вложенный в НЕЗАПУЩЕННЫЙ контекст звука, Chrome считает
  // неиграющим: seek не доходит до конца, seeked не приходит, readyState
  // застревает на 1 — сцена чёрная. Хуже того, элемент перестаёт быть
  // заглушённым, и автополитика начинает блокировать тот самый play(), которым
  // толкается декодер. До появления разбора звука клипа этот путь не включался:
  // контекста на паузе ещё не существовало и audioChain выходил сразу.
  // Маршрут создаём, когда звук реально нужен — при «Пуске» контекст оживает.
  if (!actx || actx.state !== 'running' || !clip._video) return null;
  if (clip._gain) return clip._gain;
  if (clip._video.readyState < 1) {
    clip._video.addEventListener('loadeddata', () => audioChain(clip), { once: true });
    return null;
  }
  try {
    const src = actx.createMediaElementSource(clip._video);
    // Ворота: открываются только на найденных шагах. Между источником и
    // громкостью — чтобы мьют/соло и громкость работали независимо от режима
    // «только шаги».
    const gate = actx.createGain();
    gate.gain.value = 1;
    const g = actx.createGain();
    g.gain.value = trackAudible(VIDEO_AUDIO_KEY) ? (clip.volume ?? 1) : 0;
    src.connect(gate);
    gate.connect(g);
    g.connect(masterGain);
    clip._gate = gate;
    clip._gain = g;
    clip._video.muted = false; // звук теперь идёт через граф
    return g;
  } catch (err) {
    console.warn('audio chain failed', err);
    return null;
  }
}

export function setClipVolume(clip) {
  if (clip._gain) clip._gain.gain.value = trackAudible(VIDEO_AUDIO_KEY) ? (clip.volume ?? 1) : 0;
}

/* ---------- видео элементы ---------- */
/**
/*
 * Ставит видео на позицию в своей шкале времени.
 *
 * При воспроизведении подтягиваем только при заметном расхождении — иначе
 * постоянные seek'и дают рывки. Но на паузе шаг в кадр — это 0.04 с, и порог 0.3
 * съедал его целиком: время менялось, а кадр оставался старым.
 *
 * ЗДЕСЬ ЖЕ БЫЛА ПРИЧИНА «В ПАУЗЕ НЕТ ИЗОБРАЖЕНИЯ». Ранний выход при
 * readyState < 1: seek — это тот самый запрос, который заставляет браузер
 * загрузить и декодировать видео. Без него на элементе, который ещё не отдал
 * метаданные, ничего не происходило — currentTime не выставлялся, загрузка не
 * начиналась, readyState не доходил до 2, drawCover молча выходил, и сцена
 * оставалась чёрной с подписью «Кадр ещё не декодировался».
 * Ставить currentTime до метаданных можно: браузер сам выполнит seek, как
 * только они будут. Ошибку диапазона ловим.
 */
/* ---------- ворота звука клипа: «только шаги» ---------- */
// Окна кэшируются по ссылке на массив шагов: пересобирать их на каждом кадре
// незачем, а сравнивать ссылки дешевле, чем сравнивать содержимое.
let gateWindows = null;
let gateWindowsFor = null;

function refreshGateWindows() {
  const va = state.videoAudio;
  if (!va.ready || !va.steps.length) { gateWindows = null; gateWindowsFor = null; return; }
  if (gateWindowsFor !== va.steps) {
    gateWindows = stepWindows(va.steps);
    gateWindowsFor = va.steps;
  }
}

/**
 * Ставит ворота звука клипа в положение для момента local.
 *
 * В режиме «только шаги» звучат только найденные шаги: речь и всё остальное
 * воротами убрано. Плавность в 4 мс — иначе жёсткое переключение на каждом
 * кадре даёт слышимые щелчки.
 */
function updateVideoAudioGate(clip, local) {
  if (!clip._gate) return;
  const va = state.videoAudio;
  let want = 1;
  if (va.ready && va.only) {
    refreshGateWindows();
    want = gateWindows && gateOpenAt(gateWindows, local) ? 1 : 0;
  }
  const now = audioCtx ? audioCtx.currentTime : 0;
  try {
    clip._gate.gain.setTargetAtTime(want, now, 0.004);
  } catch { clip._gate.gain.value = want; }
}

/**
 * Разбирает звук самого видеоклипа: находит оригинальные шаги и отделяет их от
 * речи. Результат лежит в state.videoAudio — его читают ворота звука, строка
 * таймлайна и панель движка.
 *
 * Время шагов хранится в шкале САМОГО КЛИПА: ворота получают позицию внутри
 * клипа, и пересчитывать её было бы ошибкой. Для таймлайна и сравнения добавлено
 * смещение offset — из шкалы клипа в шкалу монтажа.
 */
export async function analyzeClipAudio() {
  const clip = primaryClipAt(state.time) || state.clips[0];
  const media = clip ? getMedia(clip.mediaId) : null;
  if (!clip || !media?.file) {
    setVideoAudio({
      name: media?.name || '', steps: [], dropped: [], wave: [], duration: 0,
      error: 'Файл видео недоступен — переимпортируйте клип',
    });
    return state.videoAudio;
  }
  try {
    const actx = ensureAudio()
      || new (window.AudioContext || window.webkitAudioContext)();
    const buf = await extractVideoAudio(media.file, actx);
    const { steps, dropped, duration } = findOriginalSteps(buf);
    // Смещение из шкалы клипа в шкалу монтажа: локальное время шага плюс него
    // даёт время на таймлайне.
    const layout = computeLayout().find((x) => x.clip.id === clip.id);
    const offset = layout ? layout.start - clip.in : 0;
    setVideoAudio({
      name: media.name, steps, dropped, duration, offset,
      wave: waveformOf(buf, 600, 0, duration) || [], error: '',
    });
  } catch (err) {
    setVideoAudio({
      name: media.name, steps: [], dropped: [], wave: [], duration: 0,
      error: err?.message || String(err),
    });
  }
  refreshGateWindows();
  if (!state.playing) renderFrame(state.time);
  return state.videoAudio;
}

function placeVideo(v, local) {
  // Раньше здесь был ранний выход при readyState < 1 — см. комментарий ниже.
  const drift = Math.abs((v.currentTime || 0) - local);
  if (state.playing && drift <= 0.3) return;
  try {
    // seek на позицию, в которой элемент уже стоит, браузер считает
    // выполненным: события seeked не будет, декодер не запустится, readyState
    // застрянет на 1 — и drawCover молча выйдет, оставив сцену чёрной.
    // Пробник в media.js потому и просит 0.25 с, а не 0. Уводим на миллисекунду
    // и сразу возвращаемся: конечная позиция та же, но seek настоящий.
    // Условие readyState === 1 — ровно застревающее состояние: как только
    // данные для позиции есть, readyState становится 2 и подталкивание
    // прекращается само.
    if (v.readyState === 1 && drift < 1e-6) v.currentTime = local + 0.001;
    v.currentTime = local;
  } catch { /* позиция вне доступного диапазона */ }
}

/**
 * Выбрасывает <video> клипа и заставляет videoFor создать свежий.
 *
 * Пробник в media.js работает у пользователя именно потому, что каждый раз
 * создаёт новый элемент: preload=metadata, элемент в приёмнике, src, seek на
 * 0.25 с. Плеер же держит один элемент в clip._video бесконечно. Застрявший
 * элемент не оживает — каждый следующий seek на нём тоже молчит, readyState
 * остаётся 1, drawCover выходит, сцена чёрная. Это и есть «работало, а потом
 * перестало»: элемент залип один раз, и все последующие seek'и уходят в тот же
 * мёртвый элемент.
 */
function recycleClipVideos(active) {
  for (const it of active) {
    const clip = it.clip;
    const v = clip._video;
    if (!v) continue;
    // Звуковую привязку снимаем вместе с элементом: gain-узлы привязаны к
    // своему источнику, а createMediaElementSource на новом элементе бросил бы
    // InvalidStateError, если старый узел остался висеть.
    try { clip._gain?.disconnect(); } catch {}
    try { clip._gate?.disconnect(); } catch {}
    clip._gain = null;
    clip._gate = null;
    try { v.pause(); } catch {}
    v.removeAttribute('src');
    v.load();
    v.remove();
    clip._video = null;
  }
}

export function videoFor(clip) {
  if (clip._video) return clip._video;
  const media = getMedia(clip.mediaId);
  const v = document.createElement('video');
  // preload = 'metadata', а не 'auto' — ровно как у пробника в media.js, чья
  // миниатюра в браузере пользователя работает. При 'auto' Chrome на большом
  // файле сначала тянет всю дорожку целиком, и readyState способен залипнуть на
  // 1 (метаданные есть, данных для текущей позиции нет) — drawCover молча выходит,
  // сцена чёрная. При 'metadata' загрузка начинается сразу с того, что просит
  // seek, а во время воспроизведения Chrome докачивает данные и сам.
  v.preload = 'metadata';
  v.playsInline = true;
  v.muted = true;
  // Chrome и Edge не декодируют кадры для <video>, которого нет в документе:
  // drawCover молча уходит при readyState < 2, сцена остаётся чёрной, и висит
  // подпись «Кадр ещё не декодировался». При «Пуске» декодер оживает сам,
  // поэтому в воспроизведении картинка была, а на паузе — нет.
  // Держим элемент в документе, но невидимым. Именно opacity, а не
  // display:none: display:none останавливает декодирование полностью.
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;'
    + 'opacity:0;pointer-events:none;';
  // drawCover молча выходит, пока у видео нет кадра (readyState < 2).
  // Без этих слушателей сцена оставалась чёрной: кадр никто не перерисовывал,
  // когда видео наконец декодировалось.
  const repaint = () => { if (!state.playing) renderFrame(state.time); };
  // Прогрев декодера — см. warmUpDecoder.
  v.addEventListener('loadedmetadata', () => warmUpDecoder(v));
  // loadedmetadata, а не только loadeddata: как только известны размеры и
  // длительность, можно выставить currentTime — а до этого placeVideo молча
  // выходит, и seek не выдаётся вообще.
  v.addEventListener('loadedmetadata', repaint);
  v.addEventListener('loadeddata', repaint);
  v.addEventListener('canplay', repaint);
  v.addEventListener('seeked', repaint);
  // файл мог быть перемещён после импорта, или оборвался blob-адрес после
  // перезагрузки проекта — оба случая молчали раньше
  v.addEventListener('error', () => {
    if (state.playing) return;
    showFrameHint(true, v, 'error');
  });
  // Без load(): явный load() после src запускает алгоритм загрузки ВТОРОЙ раз и
  // сбрасывает элемент в readyState 0 — на blob-адресе это могло уводить
  // загрузку в тупик. Пробник в media.js load() не вызывает.
  (document.getElementById('video-sink') || document.body).appendChild(v);
  v.src = media?.url || '';
  clip._video = v;
  return v;
}

/* ---------- инициализация ---------- */

/** Достаёт 2D-контекст. Некоторые браузеры (Opera GX при жёстком ограничении
 *  GPU, а также окно `--app=` без аппаратного ускорения) отдают null — тогда
 *  превью переходит на «сырой» <video>, а не на молчащую шахматку сцены. */
function acquire2d(el) {
  for (const opts of [{ alpha: true }, { alpha: true, willReadFrequently: false }, null]) {
    try {
      const c = el.getContext('2d', opts);
      if (c && typeof c.fillRect === 'function') return c;
    } catch { /* пробуем следующий вариант */ }
  }
  return null;
}

/** Видимое объяснение вместо пустой сцены: что случилось и что делать. */
function showCanvasWarning() {
  const stage = document.getElementById('stage');
  if (!stage || document.getElementById('canvas-warn')) return;
  const box = document.createElement('div');
  box.id = 'canvas-warn';
  box.className = 'canvas-warn';
  box.innerHTML =
    '<b>Превью не рисуется: браузер не отдал 2D-контекст холста.</b>' +
    '<span>Кадры показывает резервный видеослой — монтаж, фоли и экспорт работают, ' +
    'но переходы и наложение не видны.</span>' +
    '<span class="small">Что помогает: нажать «Повторить» (GPU мог не успеть запуститься), ' +
    'включить аппаратное ускорение браузера, обновить браузер, либо открыть приложение ' +
    'обычным файлом <code>MONTAG.bat</code> вместо окна <code>MONTAG-okno.bat</code>.</span>' +
    '<button id="canvas-retry" class="btn" type="button">Повторить</button>';
  stage.appendChild(box);
  document.getElementById('canvas-retry')?.addEventListener('click', () => retryCanvas());
}

/** Снимает резервный режим, если холст всё-таки ожил. */
function clearFallback() {
  document.getElementById('canvas-warn')?.remove();
  if (fallbackVideo?.parentNode) fallbackVideo.parentNode.removeChild(fallbackVideo);
  fallbackVideo = null;
}

/** Повторная попытка получить контекст: GPU-процесс мог подняться позже страницы. */
export function retryCanvas() {
  if (!canvas || ctx) return ctx;
  ctx = acquire2d(canvas);
  if (ctx) {
    clearFallback();
    applyResolution();
    renderFrame(state.time);
  }
  return ctx;
}

export function initPlayer(canvasEl) {
  canvas = canvasEl;
  // Свежий старт: состояние восстановления не должно переживать
  // инициализацию. Без полного сброса счётчик кадрового догона оставался
  // большим, режим прямого показа включался мгновенно, а холст оставался
  // спрятанным.
  resetFrameRetry();
  if (canvas) canvas.style.display = '';
  ctx = acquire2d(canvasEl);
  if (!ctx) {
    console.warn('[MONTAG] 2D-контекст холста недоступен — включаю резервный видеослой');
    showCanvasWarning();
    // браузер мог не успеть поднять GPU — пробуем сами через некоторое время
    for (const delay of [400, 2500]) {
      setTimeout(() => { if (!ctx) retryCanvas(); }, delay);
    }
  }
  applyResolution();
  renderFrame(state.time);
  // Мьют/соло видеодорожки и переключение «только шаги» меняют звук, но не
  // позицию — без этого плеер продолжал бы играть по-старому до следующего
  // seek, и кнопка M выглядела бы неработающей.
  bus.on(EV.MIX, () => {
    for (const clip of state.clips) {
      if (!clip._gain) continue;
      clip._gain.gain.value = trackAudible(VIDEO_AUDIO_KEY) ? (clip.volume ?? 1) : 0;
    }
    if (!state.playing) renderFrame(state.time);
  });
  bus.on(EV.VIDEOAUDIO, () => { if (!state.playing) renderFrame(state.time); });
}

/** true, если холст недоступен и превью идёт через <video>. */
export function canvasBlocked() {
  return !ctx;
}

export function applyResolution() {
  if (!canvas) return;
  canvas.width = state.settings.width;
  canvas.height = state.settings.height;
  renderFrame(state.time);
}

/** Дописывает разрешение клипа в список и выбирает его. */
export function syncResolutionSelect(w = state.settings.width, h = state.settings.height, label = null) {
  const sel = document.getElementById('resolution');
  if (!sel) return;
  const val = `${w}x${h}`;
  if (![...sel.options].some((o) => o.value === val)) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label || `${w} × ${h} (как в клипе)`;
    sel.append(o);
  }
  sel.value = val;
}

/** Подстраивает холст под разрешение клипа, иначе кадр обрезается.
 *  Холст был жёстко 1280×720, а клип 1920×882 — cover-fit отрезал ~22% по
 *  бокам, и монтажёр видел «не тот масштаб». Зовём при добавлении первого
 *  клипа: свой выбор разрешения пользователь делает позже и его не перебьём. */
export function adoptResolution(media) {
  if (!canvas) return;
  const w0 = Math.round(media?.width || 0);
  const h0 = Math.round(media?.height || 0);
  if (!w0 || !h0 || !isFinite(w0) || !isFinite(h0)) return;
  const k = Math.min(1, 1920 / w0); // 4K и больше уменьшаем, пропорции сохраняем
  const w = Math.max(2, Math.round((w0 * k) / 2) * 2);
  const h = Math.max(2, Math.round((h0 * k) / 2) * 2);
  if (w === state.settings.width && h === state.settings.height) return;
  state.settings.width = w;
  state.settings.height = h;
  applyResolution();
  syncResolutionSelect(w, h);
}

/* ---------- рендер кадра ---------- */

/** Подсказка на сцене: клип есть, но кадр ещё не декодировался. */
const FRAME_HINT_WAIT = 'Кадр ещё не декодировался — подождите или нажмите «Пуск»';

/** Ошибки видео по кодам MEDIA_ERR_*. */
const VIDEO_ERR = {
  1: 'загрузка прервана',
  2: 'сеть',
  3: 'не удалось декодировать',
  4: 'формат не поддерживается браузером',
};


/**
 * Подпись на сцене.
 * @param {boolean} show
 * @param {HTMLVideoElement|null} video
 * @param {'wait'|'error'|'state'} kind
 *   wait  — догон ещё не исчерпан, время ещё есть
 *   error — видео не открылось
 *   state — догон исчерпан: показываем факты, чтобы можно было сообщить
 */
function showFrameHint(show, video = null, kind = 'wait') {
  let hint = document.getElementById('frame-hint');
  if (!show) {
    hint?.remove();
    return;
  }
  let msg = FRAME_HINT_WAIT;
  if (kind === 'error') {
    const code = video && video.error ? video.error.code : 0;
    msg = code
      ? `Видео не открылось: ${VIDEO_ERR[code] || `ошибка ${code}`}.`
      : 'Видео не открылось.';
    msg += ' Переимпортируйте клип — файл мог быть перемещен или не поддержан браузером.';
  } else if (kind === 'state' && video) {
    msg = `Кадр так и не отдан (readyState ${video.readyState}, `
      + `ширина ${video.videoWidth || 0}). Нажмите «Пуск»: если картинка появится, `
      + 'дело в декодере на паузе — сообщите эти числа.';
  }
  if (hint) {
    // Показанную ошибку «не открылось» не перебивает более мягкое сообщение
    // из догона — иначе причина снова исчезнет. Замок держится НА ЭЛЕМЕНТЕ,
    // а не отдельным флагом модуля: флаг переживал удаление подписи и запирал
    // её навсегда — диагностика никогда не показывалась.
    const locked = hint.dataset.kind === 'error' && kind !== 'error';
    if (!locked && hint.textContent !== msg) {
      hint.textContent = msg;
      hint.dataset.kind = kind;
    }
    return;
  }
  const stage = document.getElementById('stage');
  if (!stage) return;
  hint = document.createElement('div');
  hint.id = 'frame-hint';
  hint.className = 'frame-hint';
  hint.textContent = msg;
  hint.dataset.kind = kind;
  stage.appendChild(hint);
}

/* ---------- самолечение: декодер мог не успеть ---------- */
// Кадр рисуется только когда readyState >= 2, а до этого placeVideo молча
// выходит. Если событие loadeddata/seeked пропущено (или декодер медленный),
// сцена оставалась чёрной навсегда. Пробуем ещё раз, но ограниченно.
let frameRetries = 0;
let frameRetryTimer = 0;

/**
 * Толчок декодеру. Некоторые браузеры (и Edge в оконном режиме особенно) не
 * начинают декодировать кадры для видео, которое стоит на паузе и не видно на
 * экране: readyState застревает на 1. play() → pause() заставляет декодер
 * отработать хотя бы один кадр. Видео muted, поэтому автополитика не мешает.
 */
let kicked = new Set();
let recycled = false;      // в этом цикле догона элемент уже меняли на свежий
function kickDecoder(v) {
  if (!v || kicked.has(v) || v.readyState >= 2) return;
  kicked.add(v);
  const stop = () => { try { v.pause(); } catch { /* уже стоит */ } };
  v.addEventListener('loadeddata', stop, { once: true });
  v.addEventListener('playing', stop, { once: true });
  setTimeout(stop, 700); // страховка: не оставляем играть
  try {
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(() => { /* автоплей запрещён */ });
  } catch { /* браузер не дал play — подпись скажет почему */ }
}

/**
 * Прогрев декодера для спрятанного и стоящего на паузе <video>.
 *
 * seek на позицию 0, в которой свежий элемент уже стоит, браузер считает
 * выполненным: события seeked не будет, readyState застрянет на 1, drawCover
 * молча выйдет — сцена чёрная. Пробник в media.js получает кадр тем, что
 * просит НЕНУЛЕВУЮ позицию. Повторяем этот приём: после прогрева текущая
 * позиция отличается от нулевой, и обычный seek из placeVideo становится
 * настоящим.
 */
function warmUpDecoder(v) {
  if (!v || v.readyState >= 2 || v.dataset.warm) return;
  v.dataset.warm = '1';
  const target = Math.min(0.25, (isFinite(v.duration) ? v.duration : 1) * 0.1);
  try { v.currentTime = target; } catch { /* длительность ещё не известна */ }
}

/**
 * Сбрасывает догон целиком. Обязательно гасит и висящий таймер: иначе он
 * продержится до своего срока, а scheduleFrameRetry до тех пор молча выходит по
 * проверке frameRetryTimer — новая цепочка не начинается, и сцена остаётся
 * чёрной дольше, чем должна.
 */
function resetFrameRetry() {
  frameRetries = 0;
  kicked = new Set();
  directRetries = 0;
  // Счётчик попыток между тестами и быстрыми seek'ами утекает, поэтому замена
  // заклинившего элемента привязана не к номеру попытки, а к флагу цикла:
  // иначе при старте со счётчиком 5 условие «ровно вторая попытка» не
  // срабатывает никогда, и чёрная сцена остаётся навсегда.
  recycled = false;
  if (canvas) canvas.style.display = '';
  if (directVideo) {
    directVideo = false;
    clearFallback();
  }
  if (frameRetryTimer) {
    clearTimeout(frameRetryTimer);
    frameRetryTimer = 0;
  }
}

function scheduleFrameRetry(active = []) {
  if (frameRetryTimer) return;
  if (frameRetries >= 25) return; // ~5 секунд, дальше только подпись
  frameRetries++;
  frameRetryTimer = setTimeout(() => {
    frameRetryTimer = 0;
    if (state.playing) return;
    // Исключение внутри перерисовки не должно обрывать догон: таймер к этому
    // моменту уже обнулён, и без повтора цепочка замирает навсегда — сцена
    // чёрная, подпись висит, и непонятно почему.
    try {
      renderFrame(state.time);
    } catch (err) {
      console.warn('[MONTAG] перерисовка кадра не удалась:', err?.message || err);
      if (frameRetries < 25) scheduleFrameRetry(active);
    }
  }, 200);
  // толкаем декодер с первой же попытки: ждать трёх значит потерять 0.6 с на
  // том, что решается одним play()
  if (frameRetries === 1) for (const it of active) kickDecoder(videoFor(it.clip));
}

/** Резерв: показываем кадр самим <video> клипа, когда холст не рисует.
 *  object-fit: cover повторяет геометрию drawCover, так что картинка та же. */
function renderFallback(t) {
  lastRenderT = t;
  const stage = document.getElementById('stage');
  if (!stage) return;
  const it = computeLayout().find((x) => t >= x.start && t < x.end);
  if (!it) {
    if (fallbackVideo?.parentNode) fallbackVideo.parentNode.removeChild(fallbackVideo);
    fallbackVideo = null;
    return;
  }
  const v = videoFor(it.clip);
  if (fallbackVideo !== v) {
    if (fallbackVideo?.parentNode) fallbackVideo.parentNode.removeChild(fallbackVideo);
    fallbackVideo = v;
    v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
    stage.appendChild(v);
  }
  // звук клипа идёт через граф — и в прямом показе тоже
  audioChain(it.clip);
  placeVideo(v, clamp(t - it.start + it.clip.in, 0, 1e9));
  if (v.videoWidth && v.readyState >= 2) {
    directRetries = 0;
    // кадр отдан — значит холст теперь сможет его нарисовать, возвращаемся
    if (directVideo) {
      directVideo = false;
      if (canvas) canvas.style.display = '';
      // видеослой надо убрать со сцены: он добавлен позже холста и лёг бы
      // поверх него, закрывая картинку с переходами и наложением
      clearFallback();
      showFrameHint(false);
      renderFrame(t);
    }
    return;
  }
  if (!directVideo) return;
  directRetries++;
  if (directRetries % 5 === 0) kickDecoder(v);
  // Мягкую подпись здесь не показываем: пользователь и так видит видеослой,
  // и «подождите» поверх него только мешает. Факты (readyState, ширина) —
  // когда бюджет догона исчерпан и готовой картинки нет совсем.
  // Диагностику показываем рано — пользователь не должен полминуты смотреть в
  // чёрный экран без объяснения. НО догон из-за этого не прекращаем: кадр может
  // прийти позже, и тогда превью обязано вернуться на холст, иначе переходы и
  // наложение останутся выключенными до конца сессии. Прежняя правка связывала
  // порог диагностики с остановкой догона — и поздний кадр уже не возвращал
  // превью.
  if (directRetries >= 6) showFrameHint(true, v, 'state');
  if (directRetries < 60 && !state.playing) {
    setTimeout(() => { if (directVideo) renderFallback(lastRenderT); }, 200);
  }
}

export function renderFrame(t) {
  lastRenderT = t;
  // Прямой показ: холст спрятан, превью — сам видеослой. Без этой проверки
  // каждый renderFrame снова шёл бы через холст, не мог получить кадр и
  // заново переключался — на каждом seek мигание.
  if (!ctx || directVideo) { renderFallback(t); return; }
  const { width: W, height: H } = state.settings;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const layout = computeLayout();
  const active = layout.filter((it) => t >= it.start && t < it.end);
  const activeIds = new Set();
  let drewFrame = false;

  for (const it of active) {
    const clip = it.clip;
    activeIds.add(clip.id);
    const v = videoFor(clip);
    if (v.videoWidth && v.readyState >= 2) drewFrame = true;
    const local = clamp(t - it.start + clip.in, 0, Math.max(0, (getMedia(clip.mediaId)?.duration || clip.out) - 0.02));

    placeVideo(v, local);
    // сначала граф (в нём создаются ворота), потом их положение: иначе на
    // первом кадре ворот ещё нет и звук звучит как записан
    audioChain(clip);
    updateVideoAudioGate(clip, local);

    let opacity = 1;
    if (clip.transitionIn === 'crossfade' && it !== active[0]) {
      opacity = clamp((t - it.start) / state.settings.crossfade, 0, 1);
    } else if (clip.transitionIn === 'fadeblack') {
      opacity = clamp((t - it.start) / state.settings.crossfade, 0, 1);
    }

    drawCover(v, opacity);
  }

  // всё, что не на экране — стоять на паузе
  for (const clip of state.clips) {
    if (clip._video && !activeIds.has(clip.id) && !clip._video.paused) clip._video.pause();
  }

  const needFrame = active.length > 0 && !drewFrame;
  if (needFrame) {
    // ~0.4 с догона не хватило. Прежде чем показывать элемент на сцене,
    // пробуем главное: выбросить заклинивший элемент и создать свежий — тем
    // самым рецептом, которым пробник в media.js достаёт миниатюру. Без этой
    // замены один застрявший элемент держит чёрную сцену до конца сессии.
    if (frameRetries >= 2 && !recycled) {
      recycled = true;
      recycleClipVideos(active);
      // Сцена могла быть в аварийном режиме — возвращаем холст: свежий элемент
      // снова скрытый, и drawCover снова может нарисовать его.
      if (directVideo) clearFallback();
      scheduleFrameRetry(active);
      showFrameHint(true, null, 'wait');
      return;
    }
    // Ждать шесть попыток (~1.2 с) значит полторы секунды показывать чёрный
    // экран. Нарисованный элемент браузер декодирует всегда — значит на сцену
    // его надо ставить быстро, а не после долгих уговоров.
    if (frameRetries >= 4) {
      // Догон не помог. Холст не получает кадр — показываем сам
      // <video>. Холст прячем: иначе два элемента дерутся за одно место.
      directVideo = true;
      if (canvas) canvas.style.display = 'none';
      showFrameHint(false);
      renderFallback(t);
      return;
    }
    scheduleFrameRetry(active);
    // «Подождите» — только на первую треть секунды. Дальше подпись обязана
    // называть числа (readyState, ширина): без них «кадр не декодировался»
    // нечем починить, и пользователь может только сообщить «не работает».
    showFrameHint(needFrame, active[0] ? videoFor(active[0].clip) : null,
      frameRetries >= 3 ? 'state' : 'wait');
  } else {
    frameRetries = 0;
    if (directVideo) {
      directVideo = false;
      if (canvas) canvas.style.display = '';
      clearFallback();
    }
    // кадр есть — подпись обязана уйти. Без этого она оставалась висеть
    // поверх нарисованной картинки.
    showFrameHint(false);
  }

  // затемнение последнего кадра в самом конце таймлайна
  const total = totalDuration();
  if (total > 0 && t > total - 0.05) {
    ctx.fillStyle = `rgba(0,0,0,${clamp((total - t) / 0.05, 0, 1)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawCover(v, opacity) {
  if (!v.videoWidth || v.readyState < 2) return;
  const { width: W, height: H } = state.settings;
  const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
  const dw = v.videoWidth * scale;
  const dh = v.videoHeight * scale;
  ctx.globalAlpha = opacity;
  try {
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } catch (err) {
    // кадр есть, но отдать его не удалось (защищённый источник, забытый
    // контекст). Молчать нельзя: иначе сцена чёрная без объяснения.
    console.warn('[MONTAG] не удалось нарисовать кадр:', err?.message || err);
  }
  ctx.globalAlpha = 1;
}

/* ---------- воспроизведение ---------- */
export function isPlaying() {
  return state.playing;
}

export function play() {
  const total = totalDuration();
  if (total <= 0) return;
  if (state.time >= total - 0.01) seek(0);
  ensureAudio();
  state.playing = true;
  // Контекст оживает асинхронно, а цепочка строится только для запущенного —
  // иначе элемент опять ушёл бы в чёрный экран. Достраиваем, как только звук
  // пошёл: без этого при «Пуске» было бы видео без оригинального звука.
  resumeAudio().then(() => {
    if (!state.playing) return;
    for (const it of computeLayout()) {
      if (state.time < it.start || state.time >= it.end) continue;
      const clip = it.clip;
      if (!clip._video) continue;
      audioChain(clip);
      updateVideoAudioGate(clip, state.time - it.start + clip.in);
    }
  });
  clockBase = state.time;
  clockStart = performance.now();
  lastFrameT = state.time;
  resetFrameRetry();
  // разбудим клипы, которые должны играть прямо сейчас
  for (const it of computeLayout()) {
    if (state.time >= it.start && state.time < it.end) {
      const v = videoFor(it.clip);
      v.play().catch(() => { /* автоплей может быть ещё не разрешён */ });
    }
  }
  bus.emit(EV.PLAY, true);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

function loop(now) {
  if (!state.playing) return;
  const total = totalDuration();
  const t = clockBase + (now - clockStart) / 1000;
  if (t >= total) {
    state.time = total;
    renderFrame(total);
    pause();
    bus.emit(EV.TIME, state.time);
    return;
  }
  state.time = t;
  renderFrame(t);
  syncPlayback(t);
  if (frameHook) {
    const prev = lastFrameT;
    lastFrameT = t;
    frameHook(prev, t);
  }
  bus.emit(EV.TIME, t);
  rafId = requestAnimationFrame(loop);
}

/** Стартует/останавливает видео элементы согласно позиции t. */
function syncPlayback(t) {
  const active = computeLayout().filter((it) => t >= it.start && t < it.end);
  const activeIds = new Set(active.map((it) => it.clip.id));
  for (const it of active) {
    const v = videoFor(it.clip);
    const local = clamp(t - it.start + it.clip.in, 0, 1e9);
    placeVideo(v, local);
    updateVideoAudioGate(it.clip, local);
    if (v.paused) v.play().catch(() => { /* ignore */ });
  }
  for (const clip of state.clips) {
    if (clip._video && !activeIds.has(clip.id) && !clip._video.paused) clip._video.pause();
  }
}

export function pause() {
  state.playing = false;
  cancelAnimationFrame(rafId);
  for (const clip of state.clips) {
    if (clip._video && !clip._video.paused) clip._video.pause();
  }
  bus.emit(EV.PLAY, false);
}

/**
 * Позиция, с которой началось (или была перемотана) текущее воспроизведение.
 *
 * Нужна фоли: интервал кадра — (prev, now], поэтому событие, лежащее ровно на
 * позиции playhead, не звучит никогда. При ручной отметке это нормально, но
 * при «▶ Пуск» с playhead на контакте дубль должен прозвучать — иначе кажется,
 * что дорожки не звучат вовсе.
 */
export function playbackStart() {
  return lastFrameT;
}

/**
 * Шаг на N кадров с привязкой к кадровой сетке.
 *
 * Без привязки накопление погрешности уводит playhead: после 25 нажатий
 * вправо он оказывался на 0.9999 с вместо 1.0, и номер кадра считался неверно.
 */
export function stepFrames(n) {
  const fps = Number(state.settings.fps) || 25;
  const frame = Math.round(state.time * fps) + n;
  seek(Math.max(0, frame) / fps);
}

export function toggle() {
  state.playing ? pause() : play();
}

export function seek(t) {
  const total = totalDuration();
  state.time = clamp(t, 0, total);
  lastFrameT = state.time;
  // новая позиция — новый шанс получить кадр. Без сброса счётчик догона
  // копится между переходами и на пятом переходе сцена перестаёт добирать
  // кадр совсем, хотя декодер к тому времени мог справиться.
  resetFrameRetry();
  if (state.playing) {
    clockBase = state.time;
    clockStart = performance.now();
    syncPlayback(state.time);
  } else {
    renderFrame(state.time);
  }
  bus.emit(EV.TIME, state.time);
}

/** Разделить клип, попадающий под playhead, на две части. */
export function splitAtPlayhead() {
  const t = state.time;
  const layout = computeLayout();
  const it = layout.find((x) => t > x.start + 0.08 && t < x.end - 0.08);
  if (!it) {
    return { ok: false, reason: 'Поставьте playhead внутрь клипа' };
  }
  const localCut = t - it.start + it.clip.in;
  const first = { ...it.clip, out: localCut };
  const second = { ...it.clip, id: it.clip.id + '_b' + Math.random().toString(36).slice(2, 6), in: localCut, transitionIn: 'none' };
  const idx = state.clips.findIndex((c) => c.id === it.clip.id);
  state.clips.splice(idx, 1, first, second);
  bus.emit(EV.CLIPS);
  return { ok: true };
}
