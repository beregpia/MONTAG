/* ============ Состояние проекта ============ */

export const state = {
  media: [],          // { id, name, url, file, duration, width, height, thumb }
  clips: [],          // { id, mediaId, in, out, transitionIn, volume, name, _video, _gain }
  foley: [],          // { id, time, sfx, gain, offset, band, strength, detected }
  foleyDetected: {},  // mediaId -> [{ time, band, strength }] — найденные моменты контакта
  foleyGain: 0.9,
  selectedFoleyId: null,
  selectedClipId: null,
  settings: { width: 1280, height: 720, fps: 30, crossfade: 0.5 },
  time: 0,
  playing: false,
};

export const TRANSITIONS = {
  none: 'Без перехода',
  crossfade: 'Кроссфейд',
  fadeblack: 'Через чёрный',
};

let counter = 0;
export const uid = (p = 'id') =>
  `${p}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* Простейшая шина событий, чтобы модули не ссылались друг на друга по кругу */
export const bus = {
  _map: new Map(),
  on(evt, fn) {
    if (!this._map.has(evt)) this._map.set(evt, new Set());
    this._map.get(evt).add(fn);
  },
  emit(evt, data) {
    (this._map.get(evt) || []).forEach((fn) => fn(data));
  },
};

export const EV = {
  MEDIA: 'media-changed',
  CLIPS: 'clips-changed',
  SELECT: 'selection-changed',
  TIME: 'time-changed',
  PLAY: 'play-changed',
  FOLEY: 'foley-changed',
};

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Раскладка таймлайна: абсолютные start/end для каждого клипа.
 * При кроссфейде клип «въезжает» на crossfade-секунд внутрь предыдущего.
 */
export function computeLayout() {
  const xf = state.settings.crossfade;
  const layout = [];
  let cursor = 0;
  for (const clip of state.clips) {
    const dur = Math.max(0.05, clip.out - clip.in);
    let start = cursor;
    if (clip.transitionIn === 'crossfade' && layout.length > 0) {
      start = Math.max(0, cursor - xf);
    }
    const end = start + dur;
    layout.push({ clip, start, end, dur });
    cursor = end;
  }
  return layout;
}

export const totalDuration = () => {
  const l = computeLayout();
  return l.length ? l[l.length - 1].end : 0;
};

export const getClip = (id) => state.clips.find((c) => c.id === id) || null;
export const getMedia = (id) => state.media.find((m) => m.id === id) || null;

export function layoutAt(t) {
  return computeLayout().filter((it) => t >= it.start && t < it.end);
}

export function primaryClipAt(t) {
  const active = layoutAt(t);
  return active.length ? active[active.length - 1].clip : null;
}

/** Вставка клипа в таймлайн (в конец или по индексу). */
export function insertClip(clip, index = state.clips.length) {
  state.clips.splice(clamp(index, 0, state.clips.length), 0, clip);
  bus.emit(EV.CLIPS);
}

export function removeClip(id) {
  const i = state.clips.findIndex((c) => c.id === id);
  if (i === -1) return;
  const [clip] = state.clips.splice(i, 1);
  if (clip._video) {
    clip._video.pause();
    clip._video.removeAttribute('src');
    clip._video.load();
  }
  if (state.selectedClipId === id) selectClip(null);
  bus.emit(EV.CLIPS);
}

export function selectClip(id) {
  state.selectedClipId = id;
  bus.emit(EV.SELECT, id);
}

/* ---------- фоли-слой ---------- */
export function selectFoley(id) {
  state.selectedFoleyId = id;
  bus.emit(EV.FOLEY, id);
}

export function addFoleyEvent(ev) {
  state.foley.push(ev);
  bus.emit(EV.FOLEY);
}

export function updateFoleyEvent(id, patch) {
  const ev = state.foley.find((e) => e.id === id);
  if (!ev) return;
  Object.assign(ev, patch);
  bus.emit(EV.FOLEY);
}

export function removeFoleyEvent(id) {
  const i = state.foley.findIndex((e) => e.id === id);
  if (i !== -1) state.foley.splice(i, 1);
  if (state.selectedFoleyId === id) state.selectedFoleyId = null;
  bus.emit(EV.FOLEY);
}

export function clearFoley() {
  state.foley = [];
  state.selectedFoleyId = null;
  bus.emit(EV.FOLEY);
}
