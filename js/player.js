/* ============ Движок превью и воспроизведения ============
 * Каждый клип получает собственный <video>, синхронно подтягиваемый
 * к позиции playhead. Кадры композитятся в canvas (cover-fit + затемнение
 * для переходов), поэтому превью и экспорт используют один и тот же рендер.
 */

import { state, clamp, computeLayout, totalDuration, getMedia, EV, bus } from './state.js';

let canvas = null;
let ctx = null;
let rafId = null;
let clockBase = 0;     // state.time на момент старта воспроизведения
let clockStart = 0;    // performance.now() на момент старта
let lastFrameT = 0;    // позиция предыдущего кадра (для фоли-триггеров)
let frameHook = null;  // (prevT, t) => void — устанавливает модуль фоли
let fallbackVideo = null; // <video> клипа, встроенный в сцену при неработающем холсте

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
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

/** Подключает звук клипа к мастер-шине (один раз на клип). */
function audioChain(clip) {
  const actx = ensureAudio();
  if (!actx || !clip._video) return null;
  if (clip._gain) return clip._gain;
  if (clip._video.readyState < 1) {
    clip._video.addEventListener('loadeddata', () => audioChain(clip), { once: true });
    return null;
  }
  try {
    const src = actx.createMediaElementSource(clip._video);
    const g = actx.createGain();
    g.gain.value = clip.volume ?? 1;
    src.connect(g);
    g.connect(masterGain);
    clip._gain = g;
    clip._video.muted = false; // звук теперь идёт через граф
    return g;
  } catch (err) {
    console.warn('audio chain failed', err);
    return null;
  }
}

export function setClipVolume(clip) {
  if (clip._gain) clip._gain.gain.value = clip.volume ?? 1;
}

/* ---------- видео элементы ---------- */
export function videoFor(clip) {
  if (clip._video) return clip._video;
  const media = getMedia(clip.mediaId);
  const v = document.createElement('video');
  v.src = media?.url || '';
  v.preload = 'auto';
  v.playsInline = true;
  v.muted = true;
  v.addEventListener('seeked', () => {
    if (!state.playing) renderFrame(state.time);
  });
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
function syncResolutionSelect(w, h) {
  const sel = document.getElementById('resolution');
  if (!sel) return;
  const val = `${w}x${h}`;
  if (![...sel.options].some((o) => o.value === val)) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = `${w} × ${h} (как в клипе)`;
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

/** Резерв: показываем кадр самим <video> клипа, когда холст не рисует.
 *  object-fit: cover повторяет геометрию drawCover, так что картинка та же. */
function renderFallback(t) {
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
  const local = clamp(t - it.start + it.clip.in, 0, 1e9);
  if (v.readyState >= 1 && Math.abs(v.currentTime - local) > 0.3) {
    try { v.currentTime = local; } catch { /* ignore */ }
  }
}

export function renderFrame(t) {
  if (!ctx) { renderFallback(t); return; }
  const { width: W, height: H } = state.settings;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const layout = computeLayout();
  const active = layout.filter((it) => t >= it.start && t < it.end);
  const activeIds = new Set();

  for (const it of active) {
    const clip = it.clip;
    activeIds.add(clip.id);
    const v = videoFor(clip);
    const local = clamp(t - it.start + clip.in, 0, Math.max(0, (getMedia(clip.mediaId)?.duration || clip.out) - 0.02));

    // плавный дрейф времени: подтягиваем только при заметном расхождении
    if (v.readyState >= 1 && Math.abs(v.currentTime - local) > 0.3) {
      try { v.currentTime = local; } catch { /* ignore */ }
    }

    let opacity = 1;
    if (clip.transitionIn === 'crossfade' && it !== active[0]) {
      opacity = clamp((t - it.start) / state.settings.crossfade, 0, 1);
    } else if (clip.transitionIn === 'fadeblack') {
      opacity = clamp((t - it.start) / state.settings.crossfade, 0, 1);
    }

    audioChain(clip);
    drawCover(v, opacity);
  }

  // всё, что не на экране — стоять на паузе
  for (const clip of state.clips) {
    if (clip._video && !activeIds.has(clip.id) && !clip._video.paused) clip._video.pause();
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
  ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
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
  resumeAudio();
  state.playing = true;
  clockBase = state.time;
  clockStart = performance.now();
  lastFrameT = state.time;
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
    if (v.readyState >= 1 && Math.abs(v.currentTime - local) > 0.3) {
      try { v.currentTime = local; } catch { /* ignore */ }
    }
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

export function toggle() {
  state.playing ? pause() : play();
}

export function seek(t) {
  const total = totalDuration();
  state.time = clamp(t, 0, total);
  lastFrameT = state.time;
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
