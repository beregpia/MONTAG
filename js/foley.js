/* ============ Foley-движок: анализ, размещение, триггеры ============ */

import { state, EV, bus, uid, clamp, computeLayout, totalDuration, getMedia } from './state.js';
import { detectOnsets, mixToMono } from './onset.js';
import { synthesize, autoSfxFor } from './sfx.js';
import * as player from './player.js';
import { toast } from './ui.js';

let foleyBus = null;
const bufferCache = new Map();

/* ---------- шина фоли ---------- */
export function ensureFoleyBus() {
  const master = player.getMasterGain();
  const ctx = player.audioContext();
  if (!master || !ctx) return null;
  if (foleyBus) return foleyBus;
  foleyBus = ctx.createGain();
  foleyBus.gain.value = state.foleyGain;
  foleyBus.connect(master);
  return foleyBus;
}

export function setFoleyGain(v) {
  state.foleyGain = clamp(v, 0, 2);
  if (foleyBus) foleyBus.gain.value = state.foleyGain;
  bus.emit(EV.FOLEY);
}

/* ---------- буферы звуков ---------- */
export function sfxBuffer(name) {
  const ctx = player.audioContext();
  if (!ctx) return null;
  if (bufferCache.has(name)) return bufferCache.get(name);
  const s = synthesize(name, ctx.sampleRate, 1);
  const buf = ctx.createBuffer(1, s.data.length, ctx.sampleRate);
  buf.copyToChannel(s.data, 0);
  bufferCache.set(name, buf);
  return buf;
}

/* ---------- анализ исходного звука ---------- */
export async function analyzeMedia(mediaId, opts = {}, onStage) {
  const media = getMedia(mediaId);
  if (!media) return [];
  const { sensitivity = 1, minGap = 0.12 } = opts;

  if (media.file && media.file.size > 200 * 1024 * 1024) {
    toast('Файл больше 200 МБ — анализ может занять минуты', { timeout: 8000 });
  }

  try {
    onStage?.('decode');
    const arrayBuffer = await media.file.arrayBuffer();
    const ctx = player.audioContext();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    onStage?.('analyze');
    await new Promise((r) => setTimeout(r, 0)); // дать UI обновиться

    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }
    const mono = mixToMono(channels, audioBuffer.length);
    const events = detectOnsets(mono, audioBuffer.sampleRate, { sensitivity, minGap });

    state.foleyDetected[mediaId] = events;
    bus.emit(EV.FOLEY, { mediaId, stage: 'done', count: events.length });
    return events;
  } catch (err) {
    console.error(err);
    toast(`Не удалось разобрать звук: ${err.message || err}. Формат может не поддерживаться браузером.`, { type: 'error', timeout: 9000 });
    bus.emit(EV.FOLEY, { mediaId, stage: 'error' });
    return [];
  }
}

/* ---------- перенос найденных событий на таймлайн ---------- */
export function applyDetected(mediaId, { autoAssign = true } = {}) {
  const detected = state.foleyDetected[mediaId];
  if (!detected?.length) {
    toast('Сначала проанализируйте аудио', { type: 'error' });
    return 0;
  }
  const layout = computeLayout();
  const total = totalDuration();
  const created = [];
  let i = 0;

  for (const it of layout) {
    if (it.clip.mediaId !== mediaId) continue;
    for (const d of detected) {
      if (d.time < it.clip.in || d.time > it.clip.out) continue;
      const t = it.start + (d.time - it.clip.in);
      if (t < 0 || t > total) continue;
      created.push({
        id: uid('f'),
        time: t,
        sfx: autoAssign ? autoSfxFor(d.band, d.strength, i++) : 'tap',
        gain: 1,
        offset: 0,
        band: d.band,
        strength: d.strength,
        detected: true,
      });
    }
  }

  if (!created.length) {
    toast('Этот файл не используется на таймлайне — добавьте клип из него', { type: 'error' });
    return 0;
  }

  state.foley.push(...created);
  bus.emit(EV.FOLEY);
  toast(`Размещено фоли-событий: ${created.length}`);
  return created.length;
}

/* ---------- триггеры ---------- */
function playSfx(name, when, { drift = 0, gain = 1, seed = null } = {}) {
  const ctx = player.audioContext();
  const busNode = ensureFoleyBus();
  const buf = sfxBuffer(name);
  if (!ctx || !busNode || !buf) return;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  // лёгкая вариация темпа/громкости — шаги не звучат «заедающим» сэмплом
  src.playbackRate = 0.93 + Math.random() * 0.14;

  const g = ctx.createGain();
  g.gain.value = clamp(gain, 0, 4);
  src.connect(g);
  g.connect(busNode);

  const offset = Math.min(Math.max(drift, 0), Math.max(0, buf.duration - 0.005));
  try {
    src.start(when, offset);
  } catch {
    src.start(when);
  }
  src.onended = () => { try { g.disconnect(); } catch { /* ignore */ } };
}

/** Покадровый хук: играет события, пересечённые между кадрами. */
export function tick(prevT, nowT) {
  if (!state.playing || !state.foley.length) return;
  if (!(nowT > prevT) || nowT - prevT > 0.5) return; // перескок (seek) — не сыграть всё подряд
  const ctx = player.audioContext();
  if (!ctx) return;
  const when = ctx.currentTime + 0.02;

  for (const ev of state.foley) {
    const t = ev.time + ev.offset;
    if (t > prevT && t <= nowT) {
      playSfx(ev.sfx, when, {
        drift: nowT - t, // компенсация задержки кадра
        gain: (ev.gain ?? 1) * state.foleyGain,
      });
    }
  }
}

/** Прослушать событие в контексте таймлайна. */
export function auditionEvent(ev) {
  const ctx = player.audioContext();
  if (!ctx) return;
  player.seek(ev.time + ev.offset);
  playSfx(ev.sfx, ctx.currentTime + 0.02, { gain: (ev.gain ?? 1) * state.foleyGain });
}

/** Прослушать звук из библиотеки. */
export function auditionSfx(name) {
  const ctx = player.audioContext();
  if (!ctx) return;
  playSfx(name, ctx.currentTime + 0.02, { gain: state.foleyGain });
}

/** Сдвиг события на N кадров (покадровая подгонка). */
export function nudgeEvent(id, seconds) {
  const ev = state.foley.find((e) => e.id === id);
  if (!ev) return;
  ev.offset = clamp((ev.offset ?? 0) + seconds, -5, 5);
  bus.emit(EV.FOLEY);
}

export const frameSeconds = (fps = state.settings.fps) => 1 / fps;
