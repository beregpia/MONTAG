/* ============ Таймлайн: клипы, перетаскивание, плейхед, зум ============ */

import { state, EV, bus, clamp, computeLayout, totalDuration, selectClip, selectFoley, getMedia, removeClip, setTrackMute, setTrackSolo, setTrackVolume, trackAudible } from './state.js';
import { fmtTime, el } from './ui.js';
import * as player from './player.js';
import { makeClipFromMedia } from './media.js';
import { sfxById } from './sfx.js';
import { VIDEO_AUDIO_KEY } from './video-audio.js';
import { auditionEvent, auditionPlacement } from './foley.js';
import * as bank from './audio-bank.js';

let pps = 70; // пикселей на секунду
const MIN_PPS = 16;
const MAX_PPS = 240;

/* Ширина левой колонки заголовков дорожек — как в NLE. Колонка прилипает к
 * левому краю при прокрутке и НЕ накладывается на волформу: содержимое дорожки
 * начинается после неё, поэтому все координаты внутри дорожек сдвинуты на
 * GUTTER. Раньше подпись была абсолютным наложением поверх волформы и закрывала
 * её первые ~130 px. */
const GUTTER = 152;

// Дорожки фоли развёрнуты по умолчанию, когда есть что показать: иначе
// размещение выполнилось, а на таймлайне по-прежнему ничего не видно.
// Свёрнутый ряд остаётся escape-hatch'ом — таймлайн не должен отнимать место
// у картинки без спроса.
let foleyExpanded = true;
// Исходные дорожки свёрнуты по умолчанию: они полезны при выборе материала, но
// стоят вертикального места, а место на таймлайне отбирают у картинки.
let srcExpanded = false;

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
  bus.on(EV.TIME, (t) => {
    updatePlayhead(t);
    highlightPlayingClip(t);
    if (state.playing) keepInView(t);
  });
  bus.on(EV.FOLEY, render);
  bus.on(EV.PLACEMENTS, render);
  bus.on(EV.TRACKS, render);
  bus.on(EV.MIX, render);
  window.addEventListener('resize', () => render());

  document.getElementById('zoom-in').addEventListener('click', () => zoom(1.25));
  document.getElementById('zoom-out').addEventListener('click', () => zoom(0.8));
  document.getElementById('zoom-fit').addEventListener('click', () => fitToWindow());
  document.getElementById('btn-foley-toggle').addEventListener('click', () => {
    foleyExpanded = !foleyExpanded;
    render();
  });
  document.getElementById('btn-foley-src').addEventListener('click', () => {
    srcExpanded = !srcExpanded;
    render();
  });

  /* --- скраб по линейке --- */
  const seekFromEvent = (e) => {
    const rect = rulerEl().getBoundingClientRect();
    // колонка заголовков не является временем: время 0 начинается после неё
    const t = (e.clientX - rect.left - GUTTER) / pps;
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

/** Масштаб таймлайна с клавиатуры (R/T) из панели горячих клавиш. */
export function zoomTimeline(factor) {
  zoom(factor);
}

function zoom(factor) {
  const el0 = timelineEl();
  const viewW = el0.clientWidth;
  // Якорь зума — playhead, если он в окне, иначе центр окна.
  //
  // Якорь по центру был неправильным: при увеличении масштаба картинка
  // менялась посредине экрана, а не там, где работает монтажёр. Если playhead
  // стоит в начале, после зума он казалось бы не двигается — «масштаб не
  // получился».
  const phX = GUTTER + state.time * pps;
  const left = el0.scrollLeft;
  const phVisible = viewW > 0 && phX >= left && phX <= left + viewW;
  const anchorT = viewW <= 0 || phVisible ? state.time : (left + viewW / 2) / pps;
  userZoomed = true;
  pps = clamp(Math.round(pps * factor), MIN_PPS, MAX_PPS);
  render();
  if (viewW > 0) el0.scrollLeft = Math.max(0, Math.round(anchorT * pps - viewW / 2));
}

/**
 * Держит playhead в окне при зуме. Без этого при увеличении он уезжает за
 * правый край на первом же шаге воспроизведения, и смотреть нечего.
 * В подогнанном виде проект виден целиком, и функция ничего не делает.
 */
function keepInView(t) {
  const el0 = timelineEl();
  const viewW = el0.clientWidth;
  if (viewW <= 0) return;
  // та же координата, что у playhead: содержимое дорожек сдвинуто на колонку
  const x = GUTTER + t * pps;
  const left = el0.scrollLeft;
  if (x < left + 40 || x > left + viewW - 40) {
    el0.scrollLeft = Math.max(0, Math.round(x - viewW / 2));
  }
}

/** Подгоняет зум так, чтобы весь проект был виден без горизонтальной прокрутки. */
/** Текущий масштаб, px/с. Нужен тестам: якорь зума проверяется по времени. */
export function timelinePps() { return pps; }

/**
 * Ширина колонки заголовков. Нужна тестам: клип лежит в координатах своей
 * дорожки (от начала полосы), а playhead — в координатах всего таймлайна,
 * и сравнивать их напрямую нельзя без этого сдвига.
 */
export function timelineGutter() { return GUTTER; }

export function fitToWindow() {
  const total = totalDuration();
  const w = timelineEl().clientWidth - GUTTER - 40;
  if (total > 0 && w > 0) {
    pps = clamp(Math.floor(w / total), MIN_PPS, MAX_PPS);
  }
  userZoomed = false;
  render();
  // «Весь проект» — это ещё и «вернись к началу». Без сброса прокрутки вид
  // оставался там, куда его увел зум, и кнопка не возвращала картину.
  timelineEl().scrollLeft = 0;
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
    // x измерен от левого края дорожки, включая колонку заголовков
    if (x - GUTTER < mid) { index = i; break; }
  }
  return index;
}

export function render() {
  const layout = computeLayout();
  const total = totalDuration();
  // автоподгонка: содержимое не должно быть шире окна, иначе «уезжает вправо»
  if (!userZoomed && total > 0) {
    // минус колонка заголовков: она занимает место окна, но не время
    const w = timelineEl().clientWidth - GUTTER - 40;
    // округляем ВНИЗ: при округлении вверх содержимое вылезало за окно
    // на пару пикселей, и таймлайн получал лишнюю прокрутку — отсюда
    // «улетает вправо и не возвращается».
    if (w > 0) pps = clamp(Math.floor(w / total), MIN_PPS, MAX_PPS);
  }
  const width = Math.max(total * pps + 40, timelineEl().clientWidth - GUTTER - 2);

  // строки шире содержимого ровно на колонку заголовков
  rulerEl().style.width = `${GUTTER + width}px`;
  trackEl().style.width = `${GUTTER + width}px`;
  // Когда содержимое помещается в окно, прокрутка бессмысленна — и именно она
  // создавала эффект «улетело и не возвращается». Сбрасываем, иначе после
  // зума вид оставался сдвинутым даже тогда, когда всё уже видно.
  if (GUTTER + width <= timelineEl().clientWidth) timelineEl().scrollLeft = 0;

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
  ruler.append(gutterEl('ruler'));
  const body = el('div', { class: 'tl-body', style: `width:${width}px` });
  ruler.append(body);
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let step = steps.find((s) => s * pps >= 70) || 300;
  // не даём линейке разрастись до тысяч узлов на длинных проектах
  while (total / step > 400) step *= 2;
  const upTo = Math.max(total, width / pps) + step;
  for (let t = 0; t <= upTo; t += step) {
    body.append(
      el('div', { class: 'ruler-tick major', style: `left:${t * pps}px` }),
      el('div', { class: 'ruler-label', style: `left:${t * pps + 4}px` }, fmtTime(t, false)),
    );
    for (let k = 1; k < 4; k++) {
      const minor = t + (step * k) / 4;
      if (minor * pps > width) break;
      body.append(el('div', { class: 'ruler-tick', style: `left:${minor * pps}px` }));
    }
  }
}

/** Пустая колонка заголовков над линейкой — чтобы время начиналось там же. */
function gutterEl(kind) {
  return el('div', { class: `tl-gutter tl-gutter-${kind}` });
}

function renderTrack(layout) {
  const track = trackEl();
  track.textContent = '';
  clearMarker();

  // Колонка заголовка видеодорожки: имя клипа под playhead. Держит ту же
  // ширину, что и у дорожек фоли, иначе время на дорожках разъедется.
  const active = layout.find((it) => state.time >= it.start && state.time < it.end) || layout[0];
  track.append(el('div', { class: 'tl-gutter tl-gutter-track' },
    el('span', { class: 'tl-gutter-name', title: active?.clip?.name || '' },
      active?.clip?.name || 'видео'),
    el('span', { class: 'tl-gutter-tag' }, 'V1')));
  const body = el('div', { class: 'tl-body', style: `width:${Math.max(0, layout.reduce((m, it) => Math.max(m, it.end * pps), 0))}px` });
  track.append(body);

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

    body.append(node);
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
  // та же ширина, что у линейки и видеодорожки: колонка заголовков + содержимое
  strip.style.width = `${GUTTER + width}px`;
  strip.textContent = '';
  syncFoleyToggle();
  syncSrcToggle();

  const placed = state.placements.filter((p) => p.file);
  const marks = state.foley;
  const srcs = state.foleyTracks;
  // Исходники — тоже повод рисовать дорожку: материал часто смотрят до того,
  // как что-либо разместили. Раньше здесь стоял ранний возврат только по
  // размещению и меткам, и блок исходников не появлялся вовсе.
  if (!placed.length && !marks.length && !srcs.length) {
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
      // Диапазон звучания — иначе «неслышно» читается как поломка, хотя фоли
      // просто нет в том месте, где идёт playhead.
      el('span', { class: 'muted small', id: 'foley-span' }, foleySpan(placed)),
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
    if (!trackAudible(g.file)) row.classList.add('silent');
    // Колонка заголовка — настоящая, а не наложение: имя, мьют, соло и
    // громкость живут в ней и не закрывают волформу.
    row.append(trackHead(g.file, g.label, g.items.length));
    const lane = el('div', { class: 'foley-lane', style: `width:${width}px` });
    for (const p of g.items) {
      if (p.time * pps > width) continue;
      lane.append(foleyClip(p));
    }
    row.append(lane);
    strip.append(row);
  }

  /* --- звук самого клипа: оригинальные шаги, шкала таймлайна --- */
  if (state.videoAudio.ready && state.videoAudio.steps.length) {
    strip.append(videoAudioRow(width));
  }

  /* --- исходные дорожки: своя шкала времени --- */
  if (srcExpanded) {
    strip.append(sourceHead());
    for (const t of state.foleyTracks) strip.append(sourceRow(t, width));
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

/**
 * Мьют и соло дорожки — как в DAW, чтобы можно было слушать персонажа
 * отдельно, не выгружая проект. Соло сильнее мьюта.
 *
 * Кнопки не вызывают render() сами: таймлайн перестраивается на каждом
 * кадре времени, и render() сюда приводил бы к миганию и потере фокуса.
 * Смена идёт через шину MIX.
 */
/**
 * Заголовок дорожки фоли — колонка слева, как в NLE: имя, мьют, соло,
 * громкость. Прилипает к левому краю при прокрутке и не накладывается на
 * волформу: содержимое дорожки начинается после колонки.
 *
 * Кнопки не вызывают render() сами: таймлайн перестраивается на каждом кадре
 * времени, и render() сюда приводил бы к миганию и потере фокуса. Смена идёт
 * через шину MIX.
 */
function trackHead(file, label, count) {
  const m = state.mix[file] || { mute: false, solo: false, volume: 1 };
  const anySolo = Object.values(state.mix).some((x) => x.solo);
  const head = el('div', { class: 'tl-gutter tl-gutter-foley' });

  head.append(el('span', {
    class: 'tl-gutter-name',
    title: `${label} \u00b7 ${count} \u0434\u0443\u0431\u043b.`,
  }, label));

  const mk = (key, letter, on, title) => {
    const b = el('button', {
      class: `foley-mix-btn${on ? ' on' : ''}`,
      title,
      'data-file': file,
      'data-key': key,
    }, letter);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const cur = state.mix[file] || { mute: false, solo: false, volume: 1 };
      if (key === 'mute') setTrackMute(file, !cur.mute);
      else setTrackSolo(file, !cur.solo);
    });
    return b;
  };
  head.append(mk('mute', 'M', m.mute, 'Мьют: дорожка не звучит'));
  head.append(mk('solo', 'S', m.solo && !m.mute,
    anySolo ? 'Соло: звучат только помеченные дорожки' : 'Соло этой дорожки'));

  // Громкость дорожки: своя, потому что шаги одного персонажа могут оказаться
  // громче другого, а общая громкость фоли этого не разводит.
  const vol = el('input', {
    class: 'foley-vol',
    type: 'range', min: '0', max: '1.5', step: '0.05',
    value: String(m.volume ?? 1),
    title: 'Громкость дорожки',
    'data-file': file,
  });
  vol.addEventListener('input', () => setTrackVolume(file, Number(vol.value)));
  // ползунок не должен уводить playhead: таймлайн слушает клики по дорожке
  vol.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  vol.addEventListener('click', (ev) => ev.stopPropagation());
  head.append(vol);
  return head;
}

/**
 * Исходная дорожка: волформа всей записи и отметки найденных шагов.
 *
 * Шкала здесь СВОЯ, не таймлайна: время в записи не совпадает со временем
 * монтажа — именно поэтому расстановка и существует. Playhead по этой полосе
 * не идёт, и это не баг. Сама полоса при этом выровнена с видео: колонка
 * заголовка у неё такая же, как у всех остальных строк.
 */
function sourceRow(t, width) {
  const w = Math.max(0, (t.duration || 0) * pps);
  const row = el('div', { class: 'foley-row src' });
  // Колонка заголовка — такая же, как у всех остальных строк: .tl-gutter,
  // 152 px. Раньше здесь был якорь нулевой ширины с подписью поверх полосы, и
  // полоса исходной дорожки начиналась на 152 px ЛЕВЕЕ видео, линейки и
  // размещения — «исходные дорожки должны стоять ровно с видео». Якорь имел
  // смысл, когда у строк фоли колонки не было вовсе; теперь она есть у всех,
  // и исходники остались единственным исключением.
  row.append(el('div', { class: 'tl-gutter tl-gutter-foley' },
    el('span', {
      class: 'tl-gutter-name',
      title: `${t.name} · ${t.events.length} шагов`,
    }, shortTrackName(t.name))));
  const lane = el('div', { class: 'foley-lane', style: `width:${Math.max(w, 1)}px` });
  if (w > 0 && w <= width + 4) {
    const points = Math.max(24, Math.min(240, Math.round(w * 2)));
    const wave = bank.waveform(t.name, points, 0, t.duration);
    if (wave) lane.append(sourceWaveform(wave, w));
  }
  for (const e of t.events) {
    if (e.time * pps > width) continue;
    lane.append(sourceTick(e, t));
  }
  row.append(lane);
  return row;
}

/** Волформа исходной дорожки: та же зеркальная заливка, что у клипа. */
function sourceWaveform(wave, w) {
  const h = 100;
  const mid = h / 2;
  const step = w / Math.max(1, wave.length - 1);
  let d = '';
  for (let i = 0; i < wave.length; i++) {
    const x = (i * step).toFixed(2);
    d += `${i ? 'L' : 'M'}${x} ${(mid - wave[i] * (mid - 3)).toFixed(2)}`;
  }
  for (let i = wave.length - 1; i >= 0; i--) {
    const x = (i * step).toFixed(2);
    d += `L${x} ${(mid + wave[i] * (mid - 3)).toFixed(2)}`;
  }
  const wrap = el('div', { class: 'foley-src-wave' });
  wrap.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`
    + `<line class="axis" x1="0" y1="${mid}" x2="${w}" y2="${mid}"/>`
    + `<path d="${d}Z"/></svg>`;
  return wrap;
}

/** Отметка шага в исходной дорожке. Клик прослушивает тейк. */
function sourceTick(e, t) {
  const tick = el('div', {
    class: 'foley-src-tick',
    style: `left:${e.time * pps}px`,
    title: `${fmtTime(e.time)} · сила ${Math.round((e.strength ?? 0) * 100)}%`
      + ` · длина ${(e.duration || 0).toFixed(2)} с\nклик — прослушать`,
  });
  tick.addEventListener('click', (ev) => {
    ev.stopPropagation();
    bank.playCut(t.name, Math.max(0, e.time - 0.05), e.time + (e.duration || 0.2) + 0.05,
      (player.audioContext()?.currentTime ?? 0) + 0.02,
      { ctx: player.audioContext(), out: player.getMasterGain(), gain: state.foleyGain });
  });
  return tick;
}

/**
 * Звук самого видеоклипа: оригинальные шаги на шкале ТАЙМЛАЙНА.
 *
 * В отличие от исходных дорожек фоли, у этой строки шкала общая: звук клипа
 * синхронен с картинкой, поэтому оригинальный шаг и размещение можно сравнить
 * на одном масштабе. Цвет отметки — результат сравнения: зелёная совпала,
 * жёлтая фоли смещён, красная шаг пропущен.
 */
function videoAudioRow(width) {
  const va = state.videoAudio;
  const row = el('div', { class: 'foley-row' });
  if (!trackAudible(VIDEO_AUDIO_KEY)) row.classList.add('silent');
  // rows[i] соответствует steps[i]: сравнение считается по тем же шагам в том
  // же порядке, поэтому связь по индексу, а не по времени — совпадение времени
  // в плавающей точке тут ни к чему.
  row.append(trackHead(VIDEO_AUDIO_KEY, 'Оригинал', va.steps.length));
  const lane = el('div', { class: 'foley-lane', style: `width:${width}px` });
  // волформа самого звука — видно, где речь (широкие пологие места), а где шаги
  if (va.wave.length > 1) {
    const w = Math.max(width, va.duration ? va.duration * pps : 0);
    lane.append(sourceWaveform(resample(va.wave, Math.max(24, Math.min(240, Math.round(w * 2)))), w));
  }
  for (let i = 0; i < va.steps.length; i++) {
    const t = va.steps[i].time + (Number(va.offset) || 0);
    if (t * pps > width) continue;
    lane.append(origStepTick(t, va.cmp?.rows[i]?.kind, va));
  }
  row.append(lane);
  return row;
}

/** Приведение огибающей к нужному числу точек: в состоянии хранится запас. */
function resample(wave, points) {
  if (wave.length === points) return wave;
  const out = [];
  for (let i = 0; i < points; i++) {
    const a = Math.floor((i * wave.length) / points);
    const b = Math.max(a + 1, Math.floor(((i + 1) * wave.length) / points));
    let m = 0;
    for (let k = a; k < b && k < wave.length; k++) if (wave[k] > m) m = wave[k];
    out.push(m);
  }
  return out;
}

/** Отметка оригинального шага. Клик ставит playhead на шаг — слышно в такт. */
function origStepTick(t, kind, va) {
  const names = { ok: 'совпало', early: 'фоли раньше оригинала', late: 'фоли позже оригинала', miss: 'шаг пропущен' };
  const tick = el('div', {
    class: `orig-step${kind ? ' ' + kind : ''}`,
    style: `left:${t * pps}px`,
    title: `${fmtTime(t)} · оригинальный шаг\n${names[kind] || 'сравнение недоступно'}`,
  });
  tick.addEventListener('click', (ev) => {
    ev.stopPropagation();
    player.seek(t);
  });
  return tick;
}

/** Заголовок блока исходников — чтобы шкала не путалась с таймлайном. */
function sourceHead() {
  // Распорка той же ширины, что колонка дорожек: иначе описание блока
  // начинается на 152 px левее полос, к которым относится.
  return el('div', { class: 'foley-src-head' },
    el('div', { style: 'flex:0 0 152px;width:152px' }),
    el('span', {}, 'исходные дорожки'),
    el('span', { class: 'muted small' }, 'своя шкала времени, не таймлайн — '
      + 'клик по отметке прослушивает тейк'));
}

/** Кнопка «🎞 Исходники»: подпись отражает состояние. */
function syncSrcToggle() {
  const btn = document.getElementById('btn-foley-src');
  if (!btn) return;
  const n = state.foleyTracks.length;
  btn.textContent = srcExpanded ? '▾ Исходники' : '▸ Исходники';
  btn.title = !n
    ? 'Дорожек фоли не импортировано'
    : (srcExpanded ? 'Свернуть исходные дорожки' : `Показать исходные дорожки (${n})`);
  btn.disabled = n === 0;
}

/**
 * Где на таймлайне фоли вообще звучит. Показывает диапазон, а не «есть/нет»:
 * с двумя дублями в первую секунду минуты playhead на 20-й секунде не услышит
 * ничего, и без этой подписи это выглядит как поломка звука.
 */
function foleySpan(placed) {
  if (!placed.length) return '';
  const times = placed.map((p) => p.time).sort((a, b) => a - b);
  const last = times[times.length - 1];
  const lastEnd = placed.reduce((m, p) => Math.max(m, p.time + (p.duration || 0)), 0);
  const cover = lastEnd / Math.max(0.001, totalDuration());
  const pct = Math.round(cover * 100);
  return `звучит ${fmtTime(times[0], false)}–${fmtTime(lastEnd, false)} · ${pct}% длины`;
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
  // Ось нуля — как в Pro Tools: без неё зеркальная фигура читается как
  // «две волны», а не как одна вокруг середины.
  wrap.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`
    + `<line class="axis" x1="0" y1="${mid}" x2="${w}" y2="${mid}"/>`
    + `<path d="${d}Z"/></svg>`;
  return wrap;
}

function updatePlayhead(t) {
  // содержимое дорожек сдвинуто на колонку заголовков — playhead тоже
  playheadEl().style.left = `${GUTTER + t * pps}px`;
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
