/* ============ Таймлайн: клипы, перетаскивание, плейхед, зум ============ */

import { state, EV, bus, clamp, computeLayout, totalDuration, selectClip, selectFoley, getMedia, removeClip } from './state.js';
import { fmtTime, el } from './ui.js';
import * as player from './player.js';
import { makeClipFromMedia } from './media.js';
import { sfxById } from './sfx.js';
import { auditionEvent, auditionPlacement } from './foley.js';
import * as bank from './audio-bank.js';

let pps = 70; // пикселей на секунду
const MIN_PPS = 16;
const MAX_PPS = 240;

// Дорожки фоли развёрнуты по умолчанию, когда есть что показать: иначе
// размещение выполнилось, а на таймлайне по-прежнему ничего не видно.
// Свёрнутый ряд остаётся escape-hatch'ом — таймлайн не должен отнимать место
// у картинки без спроса.
let foleyExpanded = true;

// Пока монтажёр сам не трогал зум, таймлайн держит весь проект в окне.
// Иначе 60-секундный клип при 70 px/с даёт 4240 px содержимого в окне ~1270 px,
// и приходится отзумивать браузер до 25%, чтобы увидеть картинку.
let userZoomed = false;

const timelineEl = () => document.getElementById('timeline');
const rulerEl = () => document.getElementById('ruler');
const trackEl = () => document.getElementById('track');
const playheadEl = () => document.getElementById('playhead');

let dragClipId = null;

export function appendMedia(mediaId) {
  const clip = makeClipFromMedia(mediaId);
  if (!clip) return;
  const wasEmpty = state.clips.length === 0;
  state.clips.push(clip);
  selectClip(clip.id);
  bus.emit(EV.CLIPS);
  // первый клип задаёт пропорции холста, чтобы кадр не обрезался
  if (wasEmpty) player.adoptResolution(getMedia(mediaId));
}

export function initTimeline() {
  bus.on(EV.CLIPS, render);
  bus.on(EV.MEDIA, render);
  bus.on(EV.SELECT, render);
  bus.on(EV.TIME, (t) => { updatePlayhead(t); highlightPlayingClip(t); });
  bus.on(EV.FOLEY, render);
  bus.on(EV.PLACEMENTS, render);
  window.addEventListener('resize', () => render());

  document.getElementById('zoom-in').addEventListener('click', () => zoom(1.25));
  document.getElementById('zoom-out').addEventListener('click', () => zoom(0.8));
  document.getElementById('zoom-fit').addEventListener('click', () => fitToWindow());
  document.getElementById('btn-foley-toggle').addEventListener('click', () => {
    foleyExpanded = !foleyExpanded;
    syncFoleyToggle();
    render();
  });

  /* --- скраб по линейке --- */
  const seekFromEvent = (e) => {
    const rect = rulerEl().getBoundingClientRect();
    const t = (e.clientX - rect.left) / pps;
    player.seek(t);
  };
  rulerEl().addEventListener('pointerdown', (e) => {
    seekFromEvent(e);
    const move = (ev) => seekFromEvent(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  /* --- клик по фону дорожки снимает выделение --- */
  trackEl().addEventListener('pointerdown', (e) => {
    if (e.target === trackEl()) selectClip(null);
  });

  /* --- перетаскивание в конец дорожки --- */
  trackEl().addEventListener('dragover', (e) => {
    if (!dragClipId) return;
    e.preventDefault();
    const layout = computeLayout();
    const last = layout[layout.length - 1];
    showDropMarker(last ? last.end * pps : 0);
  });
  trackEl().addEventListener('drop', (e) => {
    if (!dragClipId) return;
    e.preventDefault();
    const x = e.clientX - trackEl().getBoundingClientRect().left + timelineEl().scrollLeft;
    moveClipTo(dragClipId, indexForX(x));
    clearMarker();
  });

  render();
}

function zoom(factor) {
  userZoomed = true;
  pps = clamp(Math.round(pps * factor), MIN_PPS, MAX_PPS);
  render();
}

/** Подгоняет зум так, чтобы весь проект был виден без горизонтальной прокрутки. */
export function fitToWindow() {
  const total = totalDuration();
  const w = timelineEl().clientWidth - 40;
  if (total > 0 && w > 0) {
    pps = clamp(Math.round(w / total), MIN_PPS, MAX_PPS);
  }
  userZoomed = false;
  render();
}

/** true, если проект сейчас виден целиком (зум не увеличен вручную). */
export function isFitted() {
  return !userZoomed;
}

/** Индекс вставки по X-координате дорожки. */
function indexForX(x) {
  const layout = computeLayout();
  let index = layout.length;
  for (let i = 0; i < layout.length; i++) {
    const mid = (layout[i].start + layout[i].dur / 2) * pps;
    if (x < mid) { index = i; break; }
  }
  return index;
}

export function render() {
  const layout = computeLayout();
  const total = totalDuration();
  // автоподгонка: содержимое не должно быть шире окна, иначе «уезжает вправо»
  if (!userZoomed && total > 0) {
    const w = timelineEl().clientWidth - 40;
    if (w > 0) pps = clamp(Math.round(w / total), MIN_PPS, MAX_PPS);
  }
  const width = Math.max(total * pps + 40, timelineEl().clientWidth - 2);

  rulerEl().style.width = `${width}px`;
  trackEl().style.width = `${width}px`;

  renderRuler(total, width);
  renderTrack(layout);
  renderFoleyTrack(total, width);
  updatePlayhead(state.time);

  document.getElementById('timeline-info').textContent =
    `${state.clips.length} клип(ов) · ${fmtTime(total)}`;
  document.getElementById('stage-empty').classList.toggle('hidden', state.clips.length > 0);
}

function renderRuler(total, width) {
  const ruler = rulerEl();
  ruler.textContent = '';
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let step = steps.find((s) => s * pps >= 70) || 300;
  // не даём линейке разрастись до тысяч узлов на длинных проектах
  while (total / step > 400) step *= 2;
  const upTo = Math.max(total, width / pps) + step;
  for (let t = 0; t <= upTo; t += step) {
    ruler.append(
      el('div', { class: 'ruler-tick major', style: `left:${t * pps}px` }),
      el('div', { class: 'ruler-label', style: `left:${t * pps + 4}px` }, fmtTime(t, false)),
    );
    for (let k = 1; k < 4; k++) {
      const minor = t + (step * k) / 4;
      if (minor * pps > width) break;
      ruler.append(el('div', { class: 'ruler-tick', style: `left:${minor * pps}px` }));
    }
  }
}

function renderTrack(layout) {
  const track = trackEl();
  track.textContent = '';
  clearMarker();

  layout.forEach((it, index) => {
    const clip = it.clip;
    const media = getMedia(clip.mediaId);
    const node = el('div', {
      class: `clip${clip.id === state.selectedClipId ? ' selected' : ''}`,
      style: `left:${it.start * pps}px;width:${Math.max(18, it.dur * pps)}px`,
      draggable: 'true',
      title: `${clip.name}\n${fmtTime(clip.in)} → ${fmtTime(clip.out)} (длит. ${fmtTime(it.dur)})`,
    });
    if (media?.thumb) node.style.backgroundImage = `url(${media.thumb})`;
    node.dataset.clipId = clip.id;

    const badge = clip.transitionIn !== 'none'
      ? el('div', {
          class: 'clip-badge',
          title: clip.transitionIn === 'crossfade' ? 'Кроссфейд' : 'Через чёрный',
        }, clip.transitionIn === 'crossfade' ? '⇄' : '◐')
      : el('div');

    node.append(
      el('div', { class: 'clip-veil' }),
      el('div', { class: 'clip-dur' }, fmtTime(it.dur)),
      badge,
      el('div', { class: 'clip-label' }, clip.name || `Клип ${index + 1}`),
    );

    node.addEventListener('click', (e) => {
      e.stopPropagation();
      selectClip(clip.id);
    });
    node.addEventListener('dblclick', () => {
      player.seek(it.start);
      player.play();
    });
    node.addEventListener('dragstart', (e) => {
      dragClipId = clip.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', clip.id);
      setTimeout(() => node.classList.add('dragging'), 0);
    });
    node.addEventListener('dragend', () => {
      dragClipId = null;
      node.classList.remove('dragging');
      clearMarker();
    });
    node.addEventListener('dragover', (e) => {
      if (!dragClipId) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = node.getBoundingClientRect();
      const x = (e.clientX > rect.left + rect.width / 2 ? rect.right : rect.left) - trackEl().getBoundingClientRect().left;
      showDropMarker(x);
    });
    node.addEventListener('drop', (e) => {
      if (!dragClipId) return;
      e.preventDefault();
      e.stopPropagation();
      const x = e.clientX - trackEl().getBoundingClientRect().left + timelineEl().scrollLeft;
      moveClipTo(dragClipId, indexForX(x));
      clearMarker();
    });

    track.append(node);
  });
}

function showDropMarker(x) {
  clearMarker();
  trackEl().append(el('div', { class: 'clip-drop-marker', style: `left:${x}px` }));
}

function clearMarker() {
  trackEl().querySelectorAll('.clip-drop-marker').forEach((n) => n.remove());
}

function moveClipTo(clipId, targetIndex) {
  if (!clipId) return;
  const from = state.clips.findIndex((c) => c.id === clipId);
  if (from === -1) return;
  const [clip] = state.clips.splice(from, 1);
  const adjusted = targetIndex > from ? targetIndex - 1 : targetIndex;
  state.clips.splice(clamp(adjusted, 0, state.clips.length), 0, clip);
  bus.emit(EV.CLIPS);
}

/** Дорожка фоли: размещение движка (клипы по персонажам) + метки SFX. */
function renderFoleyTrack(total, width) {
  const strip = document.getElementById('foley-track');
  if (!strip) return;
  strip.style.width = `${width}px`;
  strip.textContent = '';
  syncFoleyToggle();

  const placed = state.placements.filter((p) => p.file);
  const marks = state.foley;
  if (!placed.length && !marks.length) {
    strip.classList.remove('rows');
    strip.append(el('div', { class: 'foley-track-empty' }, 'фоли-слой пуст — откройте панель 🎙 Foley'));
    return;
  }

  // Один свёрнутый ряд вместо всех: таймлайн не должен расти и отнимать место
  // у картинки, пока монтажёр не попросит развернуть.
  if (!foleyExpanded && placed.length) {
    strip.classList.remove('rows');
    const bar = el('div', { class: 'foley-collapsed' },
      el('span', { class: 'foley-collapsed-title' }, 'Фоли на таймлайне'),
      el('span', { class: 'muted small' },
        `${placed.length} дубл. · ${rowGroups(placed).length} дорож.`),
      el('button', { class: 'btn ghost tiny', id: 'foley-expand', title: 'Показать дорожки фоли' }, '▾ Развернуть'));
    bar.querySelector('#foley-expand').addEventListener('click', (e) => {
      e.stopPropagation();
      foleyExpanded = true;
      render();
    });
    strip.append(bar);
    return;
  }

  strip.classList.add('rows');

  /* --- размещение движка: строка на каждую дорожку-персонажа --- */
  for (const g of rowGroups(placed)) {
    const row = el('div', { class: 'foley-row' });
    row.append(el('div', { class: 'foley-row-anchor' },
      el('div', { class: 'foley-row-label', title: g.label }, g.label)));
    const lane = el('div', { class: 'foley-lane' });
    for (const p of g.items) {
      if (p.time * pps > width) continue;
      lane.append(foleyClip(p));
    }
    row.append(lane);
    strip.append(row);
  }

  /* --- синтезированные SFX из панели «Foley»: остаются метками --- */
  if (marks.length) {
    const row = el('div', { class: 'foley-row' });
    row.append(el('div', { class: 'foley-row-anchor' },
      el('div', { class: 'foley-row-label' }, 'SFX')));
    const lane = el('div', { class: 'foley-lane' });
    for (const ev of marks) {
      const t = ev.time + (ev.offset ?? 0);
      if (t * pps > width) continue;
      const meta = sfxById(ev.sfx);
      const mark = el('div', {
        class: `foley-mark${ev.id === state.selectedFoleyId ? ' selected' : ''}${ev.detected ? ' detected' : ''}`,
        style: `left:${t * pps}px`,
        title: `${meta.label} · ${fmtTime(t)} · сдвиг ${Math.round((ev.offset ?? 0) * 1000)} мс`,
      }, meta.icon);
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        selectFoley(ev.id);
        player.seek(t);
        auditionEvent(ev);
      });
      lane.append(mark);
    }
    row.append(lane);
    strip.append(row);
  }
}

/** Кнопка «▾ Фоли»: подпись отражает состояние и есть ли что показывать. */
function syncFoleyToggle() {
  const btn = document.getElementById('btn-foley-toggle');
  if (!btn) return;
  const has = state.placements.length > 0;
  btn.textContent = has && !foleyExpanded ? '▸ Фоли' : '▾ Фоли';
  btn.title = !has
    ? 'Дорожек фоли на таймлайне нет'
    : (foleyExpanded ? 'Свернуть дорожки фоли' : 'Развернуть дорожки фоли');
}

/** Подсветка клипа, который звучит прямо сейчас. */
function highlightPlayingClip(t) {
  const strip = document.getElementById('foley-track');
  if (!strip || !state.placements.length) return;
  const clips = strip.querySelectorAll('.foley-clip');
  if (!clips.length) return;
  let playingId = null;
  for (const p of state.placements) {
    if (t >= p.time && t <= p.time + Math.max(0.02, p.duration || 0)) { playingId = p.id; break; }
  }
  clips.forEach((c) => c.classList.toggle('playing', c.dataset.pid === playingId));
}

/** Группировка размещения по дорожке: своя строка на каждого персонажа. */
function rowGroups(placed) {  const byFile = new Map();
  for (const p of placed) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }
  return [...byFile.entries()].map(([file, items]) => ({
    file,
    label: shortTrackName(file),
    items: items.sort((a, b) => a.time - b.time),
  }));
}

/** Короткое имя дорожки для подписи строки. */
function shortTrackName(name) {
  return String(name || '').replace(/\.[^.]+$/, '').slice(0, 22) || 'дорожка';
}

/** Клип размещения: ширина = длительность дубля, внутри — мини-волформа. */
function foleyClip(p) {
  const dur = Math.max(0.02, p.duration || (p.cutTo - p.cutFrom) || 0.12);
  const w = Math.max(3, dur * pps);
  const clip = el('div', {
    class: `foley-clip${p.review ? ' review' : ''}`,
    style: `left:${p.time * pps}px;width:${w}px`,
    dataset: { pid: p.id },
    title: `${p.category || 'звук'} · ${shortTrackName(p.file)} · ${fmtTime(p.time)}`
      + `\nдубль из ${fmtTime(p.cutFrom)}…${fmtTime(p.cutTo)} дорожки`
      + (p.review ? '\nнизкая уверенность — стоит проверить' : ''),
  });
  // точек вдвое больше, чем пикселей: иначе на широком клипе волформа
  // превращается в треугольник
  const points = Math.max(24, Math.min(200, Math.round(w * 2)));
  const wave = bank.waveform(p.file, points, p.cutFrom, p.cutTo);
  if (wave && w >= 10) clip.append(waveformSvg(wave, w));
  clip.append(el('span', { class: 'foley-clip-label' }, p.category || 'звук'));
  clip.addEventListener('click', (e) => {
    e.stopPropagation();
    player.seek(p.time);
    auditionPlacement(p);
  });
  return clip;
}

/**
 * Мини-волформа клипа: зеркальная залитая фигура, как в NLE.
 * Одна половина сверху выглядела бы графиком, а не звуком — по нему не понять,
 * где пик и где полка.
 */
function waveformSvg(wave, w) {
  const h = 100;                 // в безразмерных единицах viewBox
  const mid = h / 2;
  const step = w / Math.max(1, wave.length - 1);
  let d = '';
  for (let i = 0; i < wave.length; i++) {
    const x = (i * step).toFixed(2);
    d += `${i ? 'L' : 'M'}${x} ${(mid - wave[i] * (mid - 2)).toFixed(2)}`;
  }
  for (let i = wave.length - 1; i >= 0; i--) {
    const x = (i * step).toFixed(2);
    d += `L${x} ${(mid + wave[i] * (mid - 2)).toFixed(2)}`;
  }
  const wrap = el('div', { class: 'foley-wave' });
  wrap.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`
    + `<path d="${d}Z"/></svg>`;
  return wrap;
}

function updatePlayhead(t) {
  playheadEl().style.left = `${t * pps}px`;
  const total = totalDuration();
  const scrub = document.getElementById('scrub');
  scrub.value = total > 0 ? String(Math.round((t / total) * 1000)) : '0';
  document.getElementById('time-display').textContent = `${fmtTime(t)} / ${fmtTime(total)}`;
}

export function deleteSelected() {
  if (state.selectedClipId) {
    removeClip(state.selectedClipId);
    return true;
  }
  return false;
}
