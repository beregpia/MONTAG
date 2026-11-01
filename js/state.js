/* ============ Состояние проекта ============ */

export const state = {
  media: [],          // { id, name, url, file, duration, width, height, thumb }
  clips: [],          // { id, mediaId, in, out, transitionIn, volume, name, _video, _gain }
  foley: [],          // { id, time, sfx, gain, offset, band, strength, detected }
  foleyTracks: [],    // исходные дорожки: { name, category, pass, duration, events }
  // мьют/соло по дорожке размещения: file -> { mute, solo }. Держится в состоянии,
  // потому что звук читает его из foley.tick, а кнопки рисует таймлайн.
  mix: {},
  placements: [],     // размещение движка: { id, time, duration, category, source,
                      //   track, file, cutFrom, cutTo, confidence, review }
  foleyDetected: {},  // mediaId -> [{ time, band, strength }] — найденные моменты контакта
  foleyGain: 0.9,
  selectedFoleyId: null,
  selectedClipId: null,
  settings: { width: 1280, height: 720, fps: 25, crossfade: 0.5 },
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
  PLACEMENTS: 'placements-changed',
  TRACKS: 'tracks-changed',
  MIX: 'mix-changed',
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

/* ---------- размещение движка ---------- */

/** Полная замена слоя размещения (движок пересчитывает его целиком). */
export function setPlacements(list) {
  state.placements = list.map((p) => ({ ...p }));
  bus.emit(EV.PLACEMENTS);
}

export function clearPlacements() {
  if (!state.placements.length) return;
  state.placements = [];
  bus.emit(EV.PLACEMENTS);
}

/**
 * Исходная дорожка: что реально лежит в записи. Держится в состоянии, а не в
 * панели, потому что её читает и таймлайн, и любой другой потребитель — панель
 * несёт ещё и состояние интерфейса (статус разбора, ошибки).
 */
export function setSourceTrack(t) {
  const i = state.foleyTracks.findIndex((x) => x.name === t.name);
  if (i === -1) state.foleyTracks.push({ ...t });
  else state.foleyTracks[i] = { ...t };
  bus.emit(EV.TRACKS);
}

export function dropSourceTrack(name) {
  const i = state.foleyTracks.findIndex((x) => x.name === name);
  if (i === -1) return;
  state.foleyTracks.splice(i, 1);
  bus.emit(EV.TRACKS);
}

/**
 * Мьют/соло дорожки. Соло сильнее мьюта: если хоть одна дорожка в соло,
 * звучат только она — как в любой DAW, иначе кнопка соло ничего не значит.
 */
export function setTrackMute(file, v) { setMix(file, 'mute', v); }
export function setTrackSolo(file, v) { setMix(file, 'solo', v); }

/**
 * Громкость дорожки, 0..1.5. Своя на дорожку, а не одна общая: шаги одного
 * персонажа могут оказаться громче другого, и общая громкость фоли их не разводит.
 */
export function setTrackVolume(file, v) {
  const m = state.mix[file] || (state.mix[file] = { mute: false, solo: false, volume: 1 });
  m.volume = clamp(Number(v) || 0, 0, 1.5);
  bus.emit(EV.MIX);
}

function setMix(file, key, v) {
  const m = state.mix[file] || (state.mix[file] = { mute: false, solo: false, volume: 1 });
  m[key] = !!v;
  bus.emit(EV.MIX);
}

/** Слышна ли дорожка с учётом мьютов и соло. */
export function trackAudible(file) {
  const anySolo = Object.values(state.mix).some((m) => m.solo);
  const m = state.mix[file];
  if (!m) return !anySolo;
  if (anySolo) return m.solo && !m.mute;
  return !m.mute;
}

/** Сдвиг одного размещения на N секунд (покадровая подгонка). */
export function nudgePlacement(id, seconds) {
  const p = state.placements.find((x) => x.id === id);
  if (!p) return;
  p.time = Math.max(0, p.time + seconds);
  bus.emit(EV.PLACEMENTS);
}

/** Снятие одного размещения со слоя. */
export function removePlacement(id) {
  const i = state.placements.findIndex((x) => x.id === id);
  if (i === -1) return;
  state.placements.splice(i, 1);
  bus.emit(EV.PLACEMENTS);
}

/**
 * Индексы размещений, чьё время перешёл playhead между кадрами.
 * Один и тот же подсчёт нужен и звуку (foley.tick), и подсветке строки
 * в панели движка — иначе предпросмотр и обычное воспроизведение разойдутся.
 */
/**
 * Размещения, попавшие в интервал кадра.
 *
 * Интервал полуоткрытый (prev, now] — иначе событие на стыке двух кадров
 * прозвучало бы дважды. Но первый кадр после «Пуск» или перемотки должен
 * включать левую границу: если playhead стоит точно на контакте, дубль обязан
 * звучать. Без этого нажал «▶» на контакте — и ничего не услышал.
 */
export function placementsInFrame(placements, prevT, nowT, includeLeft = false, done = new Set()) {
  if (!placements?.length || !(nowT > prevT) || nowT - prevT > 0.5) return [];
  const out = [];
  for (let i = 0; i < placements.length; i++) {
    const t = placements[i].time;
    const inLeft = includeLeft ? t >= prevT - 1e-9 : t > prevT;
    if (inLeft && t <= nowT && !done.has(i)) out.push(i);
  }
  return out;
}

/** Индекс строки, которая звучит прямо сейчас (последнее прошедшее размещение). */
export function currentPreviewRow(placements, nowT) {
  if (!placements?.length) return -1;
  let cur = -1;
  for (let i = 0; i < placements.length; i++) if (placements[i].time <= nowT + 1e-6) cur = i;
  return cur;
}
