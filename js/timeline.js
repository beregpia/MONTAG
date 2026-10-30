/* ============ Таймлайн: клипы, перетаскивание, плейхед, зум ============ */

import { state, EV, bus, clamp, computeLayout, totalDuration, selectClip, selectFoley, getMedia, removeClip } from './state.js';
import { fmtTime, el } from './ui.js';
import * as player from './player.js';
import { makeClipFromMedia } from './media.js';
import { sfxById } from './sfx.js';
import { auditionEvent } from './foley.js';

let pps = 70; // пикселей на секунду
const MIN_PPS = 16;
const MAX_PPS = 240;

const timelineEl = () => document.getElementById('timeline');
const rulerEl = () => document.getElementById('ruler');
const trackEl = () => document.getElementById('track');
const playheadEl = () => document.getElementById('playhead');

let dragClipId = null;

export function appendMedia(mediaId) {
  const clip = makeClipFromMedia(mediaId);
  if (!clip) return;
  state.clips.push(clip);
  selectClip(clip.id);
  bus.emit(EV.CLIPS);
}

export function initTimeline() {
  bus.on(EV.CLIPS, render);
  bus.on(EV.MEDIA, render);
  bus.on(EV.SELECT, render);
  bus.on(EV.TIME, updatePlayhead);
  bus.on(EV.FOLEY, render);
  window.addEventListener('resize', () => render());

  document.getElementById('zoom-in').addEventListener('click', () => zoom(1.25));
  document.getElementById('zoom-out').addEventListener('click', () => zoom(0.8));

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
  pps = clamp(Math.round(pps * factor), MIN_PPS, MAX_PPS);
  render();
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

/** Дорожка фоли: маркеры событий под клипами. */
function renderFoleyTrack(total, width) {
  const strip = document.getElementById('foley-track');
  if (!strip) return;
  strip.style.width = `${width}px`;
  strip.textContent = '';

  if (!state.foley.length) {
    strip.append(el('div', { class: 'foley-track-empty' }, 'фоли-слой пуст — откройте панель 🎙 Foley'));
    return;
  }

  for (const ev of state.foley) {
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
    strip.append(mark);
  }
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
