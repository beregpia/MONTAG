/**
 * Звук самого видеоклипа: оригинальные шаги.
 *
 * В производственной записи есть и шаги, и речь. Речь монтажёру не нужна — ему
 * нужны шаги, чтобы сравнивать с ними свою расстановку. Поэтому звук клипа
 * пропускается через ворота, которые открываются только на найденных шагах:
 * всё остальное, включая реплики, не звучит вовсе.
 *
 * Разбор переиспользует движок индексатора фоли-библиотеки: тот же детектор
 * ударов, та же классификация по дескрипторам. Отдельного «распознавания речи»
 * здесь нет и быть не может — голос из микса не выделяется. Оставляется только
 * то, что по своим признакам похоже на шаг; что отброшено, видно в отчёте.
 */
import { indexTrack } from './foley-library.js';
import { mixToMono } from './onset.js';

/** Ключ дорожки в state.mix — своя строка микшера, как у дорожек фоли. */
export const VIDEO_AUDIO_KEY = '◆видео';

/**
 * Категории, которые считаются шагами.
 *
 * Решение по объёму (2026-11): пока отбираются ТОЛЬКО шаги. Двери, ткань и
 * речь — потом, отдельной работой. Поэтому здесь единственный фильтр, а не
 * набор категорий: когда дойдёт до остального, расширять надо именно здесь —
 * findOriginalSteps() делит события на steps/dropped через isStep, и весь
 * остальной путь (сверка, отметки на таймлайне, ворота звука) работает с тем,
 * что вернул этот фильтр. Слушать запись целиком можно и сейчас — кнопкой
 * «○ Как записано», она не зависит от этого фильтра.
 */
const STEP_RE = /step|шаг|foot/i;

export const isStep = (e) => STEP_RE.test(e?.category || '');

/**
 * Достаёт звуковую дорожку из файла видео.
 *
 * Chrome и Edge декодируют AAC из MP4 через decodeAudioData — отдельного
 * демультиплексора не нужно. Если у файла нет звука или кодек не поддержан,
 * бросает с внятным текстом: молчаливая ошибка здесь означала бы «оригинальных
 * шагов нет», хотя они есть.
 *
 * @param {File} file
 * @param {AudioContext} audioCtx
 * @returns {Promise<AudioBuffer>}
 */
export async function extractVideoAudio(file, audioCtx) {
  if (!file) throw new Error('Нет файла видео');
  if (!audioCtx?.decodeAudioData) throw new Error('Аудио-контекст не поднят');
  let buf;
  try {
    buf = await audioCtx.decodeAudioData(await file.arrayBuffer());
  } catch (err) {
    throw new Error(`Не удалось прочесть звук из видео: ${err?.message || err}. `
      + 'Если в файле нет звуковой дорожки или кодек экзотический — '
      + 'оригинальных шагов не будет.');
  }
  if (!buf || !buf.length || buf.numberOfChannels < 1) {
    throw new Error('В видео нет звуковой дорожки');
  }
  return buf;
}

/**
 * Ищет шаги в звуке клипа и отделяет их от всего остального.
 *
 * @param {AudioBuffer} buffer
 * @param {{sensitivity?: number, minGap?: number}} opts
 */
export function findOriginalSteps(buffer, opts = {}) {
  const { sensitivity = 0.8, minGap = 0.18 } = opts;
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const mono = mixToMono(channels, buffer.length);
  const idx = indexTrack(mono, buffer.sampleRate, { category: '', sensitivity, minGap });
  return {
    steps: idx.events.filter(isStep),
    dropped: idx.events.filter((e) => !isStep(e)),
    duration: idx.duration,
    sampleRate: idx.sampleRate,
  };
}

/**
 * Огибающая звука клипа для мини-волформы: пиковые значения по сегментам.
 * Нормировка по пику всей записи — иначе тихий шаг выглядел бы таким же
 * громким, как сильный. Повторяет правило audio-bank.waveform.
 */
export function waveformOf(buffer, points = 48, from = 0, to = Infinity) {
  if (!buffer || !buffer.length) return null;
  const ch = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.min(ch.length, Math.round(from * sr)));
  const b = Math.max(a, Math.min(ch.length, Math.round(
    Number.isFinite(to) ? to * sr : ch.length,
  )));
  const len = b - a;
  if (len <= 0) return null;
  let peak = 0;
  for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
  if (peak <= 0) return null;
  const seg = Math.max(1, Math.floor(len / points));
  const out = [];
  for (let i = a; i < b; i += seg) {
    let m = 0;
    for (let k = i; k < Math.min(i + seg, b); k++) {
      const v = Math.abs(ch[k]);
      if (v > m) m = v;
    }
    out.push(m / peak);
  }
  return out;
}

/**
 * Окна, в которых звук клипа должен звучать: вокруг каждого шага.
 * Всё остальное — речь и прочее — ворота закрывают.
 */
export function stepWindows(steps, pre = 0.12, post = 0.3) {
  return steps.map((s) => [
    Math.max(0, s.time - pre),
    s.time + (s.duration || 0.2) + post,
  ]);
}

/** Открыты ли ворота в момент t. */
export function gateOpenAt(windows, t) {
  for (const [a, b] of windows) if (t >= a && t <= b) return true;
  return false;
}

/**
 * Сравнение оригинальных шагов с расстановкой.
 *
 * Допуск — полтора кадра: расхождение меньше одного кадра на слух и на глаз не
 * читается, а считать его ошибкой значит получить стену «раньше/позже» на
 * ровной работе.
 *
 * Радиус поиска — половина секунды. Дальше «ближайший дубль» уже ничего не
 * значит: шаг на 2.0 с при дубле на 1.0 с не «сделан раньше», он не сделан
 * вовсе. Без этого порога сравнение показывало бы десятки «раньше/позже» там,
 * где фоли просто нет.
 *
 * @param {Array} steps найденные в звуке клипа шаги
 * @param {Array} placements размещение: { time }
 * @param {number} fps
 */
export function compareSteps(steps, placements, fps = 25) {
  const tol = 1.5 / fps;
  const reach = 0.5;
  const sorted = placements
    .map((p) => p?.time)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  const rows = steps.map((s) => {
    let best = null;
    for (const t of sorted) {
      if (best === null || Math.abs(t - s.time) < Math.abs(best - s.time)) best = t;
    }
    if (best === null || Math.abs(best - s.time) > reach) {
      return { time: s.time, kind: 'miss', offset: null, nearest: best };
    }
    const off = best - s.time;
    if (Math.abs(off) <= tol) return { time: s.time, kind: 'ok', offset: off, nearest: best };
    return { time: s.time, kind: off < 0 ? 'early' : 'late', offset: off, nearest: best };
  });
  // Размещение, которому не нашлось оригинала: лишний дубль или шаг не того
  // персонажа. Это тоже стоит показать — иначе сравнение однобокое.
  const extra = sorted.filter(
    (t) => !steps.some((s) => Math.abs(s.time - t) <= tol),
  ).length;
  return {
    rows,
    extra,
    ok: rows.filter((r) => r.kind === 'ok').length,
    early: rows.filter((r) => r.kind === 'early').length,
    late: rows.filter((r) => r.kind === 'late').length,
    miss: rows.filter((r) => r.kind === 'miss').length,
  };
}
