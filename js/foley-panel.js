/* ============ Панель Foley: анализ, список событий, библиотека ============ */

import { state, EV, bus, getMedia, updateFoleyEvent, removeFoleyEvent, clearFoley, selectFoley, totalDuration } from './state.js';
import { fmtTime, el, toast } from './ui.js';
import { analyzeMedia, applyDetected, auditionEvent, auditionSfx, setFoleyGain, nudgeEvent, frameSeconds } from './foley.js';
import { SFX_LIST, sfxById, autoSfxFor } from './sfx.js';
import { buildMarkerMidi } from './midi.js';
import * as player from './player.js';

let suppressRender = false;
let sensitivity = 1;
let minGap = 0.12;
let exportSource = 'detected'; // 'detected' | 'placed'
let exportOffset = 0;          // секунды, для видео не с нуля в проекте
let stage = ''; // '' | 'decode' | 'analyze' | 'done' | 'error'
let lastMediaId = null;
const MAX_ROWS = 150;

export function initFoleyPanel() {
  const body = document.getElementById('foley-body');
  body.addEventListener('pointerdown', () => { suppressRender = true; });
  window.addEventListener('pointerup', () => {
    if (suppressRender) { suppressRender = false; render(); }
  });

  bus.on(EV.FOLEY, () => { if (!suppressRender) render(); });
  bus.on(EV.MEDIA, render);
  bus.on(EV.CLIPS, render);

  document.getElementById('foley-close').addEventListener('click', () => {
    document.getElementById('foley-drawer').classList.add('hidden');
  });

  render();
}

function setStage(s, mediaId) {
  stage = s;
  if (mediaId) lastMediaId = mediaId;
  if (!suppressRender) render();
}

function render() {
  const body = document.getElementById('foley-body');
  if (!body) return;
  body.textContent = '';

  const mediaOptions = state.media.filter((m) => m.duration > 0 || m.file);
  const currentMediaId = lastMediaId && getMedia(lastMediaId) ? lastMediaId : mediaOptions[0]?.id;
  if (currentMediaId && !lastMediaId) lastMediaId = currentMediaId;
  const detected = currentMediaId ? state.foleyDetected[currentMediaId] : null;

  /* ---------- 1. Источник ---------- */
  const srcSelect = el('select', { class: 'select', style: 'width:100%' });
  if (!mediaOptions.length) srcSelect.append(el('option', { value: '' }, '— сначала импортируйте видео —'));
  for (const m of mediaOptions) {
    const opt = el('option', { value: m.id }, `${m.name} (${fmtTime(m.duration, false)})`);
    if (m.id === currentMediaId) opt.selected = true;
    srcSelect.append(opt);
  }
  srcSelect.addEventListener('change', () => {
    lastMediaId = srcSelect.value || null;
    stage = '';
    render();
  });

  const analyzeBtn = el('button', { class: 'btn primary', style: 'width:100%' },
    stage === 'decode' || stage === 'analyze' ? '⏳ Анализ…' : '🔍 Анализировать аудио');
  analyzeBtn.disabled = !currentMediaId || stage === 'decode' || stage === 'analyze';
  analyzeBtn.addEventListener('click', async () => {
    if (!currentMediaId) return;
    setStage('decode', currentMediaId);
    await analyzeMedia(currentMediaId, { sensitivity, minGap }, (s) => setStage(s, currentMediaId));
  });

  const stat = el('div', { class: 'foley-stat small muted' });
  if (stage === 'decode') stat.textContent = 'Декодирую звуковую дорожку…';
  else if (stage === 'analyze') stat.textContent = 'Ищу моменты контакта…';
  else if (stage === 'error') stat.textContent = 'Ошибка анализа (см. подсказку ниже)';
  else if (detected?.length) {
    const low = detected.filter((d) => d.band === 'low').length;
    const mid = detected.filter((d) => d.band === 'mid').length;
    const high = detected.filter((d) => d.band === 'high').length;
    stat.textContent = `Найдено ${detected.length}: низких (шаги/предметы) ${low} · средних ${mid} · высоких ${high}`;
  } else stat.textContent = 'Анализ не запускался';

  body.append(
    section('1 · Источник звука', srcSelect, analyzeBtn, stat),
  );

  /* ---------- чувствительность ---------- */
  const sensLabel = el('b', {}, sensitivity.toFixed(1));
  const sens = slider(0.2, 3, 0.1, sensitivity, (v) => {
    sensitivity = v;
    sensLabel.textContent = v.toFixed(1);
    debounceReanalyze(currentMediaId);
  });
  const gapLabel = el('b', {}, `${Math.round(minGap * 1000)} мс`);
  const gap = slider(0.04, 0.5, 0.02, minGap, (v) => {
    minGap = v;
    gapLabel.textContent = `${Math.round(v * 1000)} мс`;
    debounceReanalyze(currentMediaId);
  });

  body.append(
    section('Чувствительность и плотность',
      el('div', { class: 'insp-label' }, 'Порог детекта', sensLabel), sens,
      el('div', { class: 'insp-label' }, 'Мин. интервал', gapLabel), gap,
    ),
  );

  /* ---------- 2. Перенос на таймлайн ---------- */
  const applyBtn = el('button', { class: 'btn', style: 'width:100%' }, '⬇ Перенести события на таймлайн');
  applyBtn.disabled = !detected?.length;
  applyBtn.addEventListener('click', () => {
    if (currentMediaId) applyDetected(currentMediaId, { autoAssign: true });
  });
  const clearBtn = el('button', { class: 'btn ghost danger', style: 'width:100%' }, 'Очистить фоли-слой');
  clearBtn.disabled = !state.foley.length;
  clearBtn.addEventListener('click', () => {
    if (confirm('Удалить все фоли-события?')) clearFoley();
  });
  body.append(section('2 · Размещение', applyBtn, clearBtn));

  /* ---------- 3. События ---------- */
  const listWrap = el('div', { class: 'foley-events' });
  if (!state.foley.length) {
    listWrap.append(el('div', { class: 'muted small' }, 'Событий нет. Проанализируйте аудио и перенесите найденные моменты.'));
  } else {
    const shown = state.foley.slice(0, MAX_ROWS);
    for (const ev of shown) listWrap.append(eventRow(ev));
    if (state.foley.length > MAX_ROWS) {
      listWrap.append(el('div', { class: 'muted small' }, `…и ещё ${state.foley.length - MAX_ROWS}`));
    }
  }
  body.append(section(`3 · События фоли (${state.foley.length})`, listWrap));

  /* ---------- 4. Библиотека ---------- */
  const lib = el('div', { class: 'foley-lib' });
  for (const s of SFX_LIST) {
    const b = el('button', { class: 'btn ghost foley-lib-btn', title: `Прослушать: ${s.label}` },
      el('span', { class: 'foley-lib-icon' }, s.icon),
      el('span', { class: 'small' }, s.label),
    );
    b.addEventListener('click', () => auditionSfx(s.id));
    lib.append(b);
  }
  body.append(section('4 · Библиотека фоли', lib));

  /* ---------- 5. Микшер ---------- */
  const gainLabel = el('b', {}, `${Math.round(state.foleyGain * 100)}%`);
  /* ---------- экспорт маркеров в DAW ---------- */
  // состояние секции живёт вне render(), иначе перерисовка панели сбрасывала бы выбор
  const offsetInput = el('input', {
    type: 'number', class: 'select', value: String(exportOffset), step: '0.001', style: 'width:100%',
    title: 'Смещение маркеров в секундах — если видео в проекте стоит не с нуля',
  });
  const offsetLabel = el('b', {}, String(exportOffset));
  offsetInput.addEventListener('input', () => {
    exportOffset = parseFloat(offsetInput.value) || 0;
    offsetLabel.textContent = offsetInput.value;
  });
  const sourceSelect = el('select', { class: 'select', style: 'width:100%' });
  for (const [value, label] of [['detected', 'Найденные события источника'], ['placed', 'Размещённые фоли-события']]) {
    const opt = el('option', { value }, label);
    if (exportSource === value) opt.selected = true;
    sourceSelect.append(opt);
  }
  sourceSelect.addEventListener('change', () => { exportSource = sourceSelect.value; });
  const exportBtn = el('button', { class: 'btn primary', style: 'width:100%' }, '⇩ Экспорт маркеров в MIDI (.mid)');
  exportBtn.addEventListener('click', () => {
    const offset = exportOffset;
    const markers = exportSource === 'placed'
      ? state.foley.map((ev, i) => ({
          time: ev.time + (ev.offset ?? 0) + offset,
          name: `${String(i + 1).padStart(2, '0')} ${ev.sfx}`,
        }))
      : (detected || []).map((d, i) => ({
          time: d.time + offset,
          // ASCII-имена: SMF-текст маркера должен быть ASCII, иначе DAW покажет «???»
          name: `${String(i + 1).padStart(2, '0')} ${d.time.toFixed(2)}s ${d.band} ${autoSfxFor(d.band, d.strength, i)}`,
        }));
    if (!markers.length) {
      toast('Нет событий для экспорта — сначала проанализируйте аудио или разместите фоли', { type: 'error' });
      return;
    }
    const data = buildMarkerMidi(markers);
    const blob = new Blob([data], { type: 'audio/midi' });
    const a = document.createElement('a');
    const name = `montag-markers-${(getMedia(currentMediaId)?.name || 'project').replace(/\.[^.]+$/, '')}.mid`;
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast(`${markers.length} маркеров → ${name}. В Cubase: File → Import → MIDI File (включите Import Markers в настройках)`);
  });
  body.append(
    section('Экспорт маркеров в DAW',
      sourceSelect,
      offsetInput,
      el('div', { class: 'insp-label' }, 'Смещение, с', offsetLabel),
      offsetInput,
      exportBtn,
      el('div', { class: 'muted small' },
        'Маркеры пишутся в Standard MIDI File с точностью 1 мс — Cubase, Nuendo, ' +
        'Reaper, Ableton и Logic импортируют их как маркеры проекта для привязки клипов.'),
    ),
  );

  body.append(
    section('5 · Микшер',
      el('div', { class: 'insp-label' }, 'Общая громкость фоли', gainLabel),
      slider(0, 2, 0.05, state.foleyGain, (v) => {
        setFoleyGain(v);
        gainLabel.textContent = `${Math.round(v * 100)}%`;
      }),
    ),
  );
}

function eventRow(ev) {
  const meta = sfxById(ev.sfx);
  const row = el('div', { class: `foley-event${ev.id === state.selectedFoleyId ? ' selected' : ''}` });

  const time = el('div', { class: 'foley-event-time' },
    el('b', {}, fmtTime(ev.time + (ev.offset ?? 0))),
    el('span', { class: 'muted small' }, `${BAND_ICON[ev.band] ?? '•'} ${Math.round((ev.strength ?? 0) * 100)}%`),
  );

  const sfxSelect = el('select', { class: 'select tiny-select' });
  for (const s of SFX_LIST) {
    const opt = el('option', { value: s.id }, `${s.icon} ${s.label}`);
    if (s.id === ev.sfx) opt.selected = true;
    sfxSelect.append(opt);
  }
  sfxSelect.addEventListener('change', () => updateFoleyEvent(ev.id, { sfx: sfxSelect.value }));
  sfxSelect.addEventListener('click', (e) => e.stopPropagation());

  const frame = frameSeconds();
  const offsetLabel = el('span', { class: 'muted small' }, `${Math.round((ev.offset ?? 0) * 1000)} мс`);
  const nudge = el('div', { class: 'foley-nudge' },
    nudgeBtn('−1к', () => { nudgeEvent(ev.id, -frame); offsetLabel.textContent = `${Math.round((ev.offset ?? 0) * 1000)} мс`; }),
    nudgeBtn('+1к', () => { nudgeEvent(ev.id, frame); offsetLabel.textContent = `${Math.round((ev.offset ?? 0) * 1000)} мс`; }),
    offsetLabel,
  );

  const gain = el('input', { type: 'range', min: '0', max: '1.5', step: '0.05', value: String(ev.gain ?? 1), class: 'foley-gain' });
  gain.addEventListener('input', () => updateFoleyEvent(ev.id, { gain: parseFloat(gain.value) }));
  gain.addEventListener('click', (e) => e.stopPropagation());

  const play = el('button', { class: 'btn ghost tiny', title: 'Прослушать в таймлайне' }, '▶');
  play.addEventListener('click', (e) => { e.stopPropagation(); auditionEvent(ev); });

  const del = el('button', { class: 'btn ghost tiny danger', title: 'Удалить' }, '✕');
  del.addEventListener('click', (e) => { e.stopPropagation(); removeFoleyEvent(ev.id); });

  row.append(time, sfxSelect, nudge, gain, play, del);
  row.addEventListener('click', () => {
    selectFoley(ev.id);
    player.seek(ev.time + (ev.offset ?? 0));
  });
  return row;
}

const BAND_ICON = { low: '👟', mid: '👕', high: '🖱️' };

function nudgeBtn(label, fn) {
  const b = el('button', { class: 'btn ghost tiny', title: 'Сдвиг на кадр' }, label);
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}

function section(title, ...children) {
  return el('div', { class: 'foley-section' },
    el('div', { class: 'foley-section-title' }, title),
    ...children,
  );
}

function slider(min, max, step, value, onInput) {
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), style: 'width:100%' });
  input.addEventListener('input', () => onInput(parseFloat(input.value)));
  return input;
}

let reanalyzeTimer = null;
function debounceReanalyze(mediaId) {
  clearTimeout(reanalyzeTimer);
  reanalyzeTimer = setTimeout(() => {
    if (mediaId) analyzeMedia(mediaId, { sensitivity, minGap }, (s) => setStage(s, mediaId));
  }, 350);
}
