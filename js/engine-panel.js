/* ============ Панель «Движок»: дорожки → индекс → события → расстановка ============
 *
 * Весь конвейер внутри приложения, без загрузки файлов куда-либо:
 *   1) импорт записанных дорожек ( drag & drop или кнопка );
 *   2) индексация каждой — сегментация, дескрипторы, стопа, темп;
 *   3) разметка событий на картинке (клик в текущем кадре);
 *   4) размещение: в какой кадр вставить и откуда взять звук;
 *   5) экспорт: CSV, JSON или SMF-маркеры (Cubase/Nuendo).
 *
 * Категории берутся из имён дорожек — новых в коде не требуется.
 */

import { state, EV, bus, uid } from './state.js';
import { el, toast, fmtTime } from './ui.js';
import { indexTrack, splitTrackName, gapFor } from './foley-library.js';
import { placeEvents } from './foley-place.js';
import { buildMarkerMidi } from './midi.js';
import * as player from './player.js';

/** @type {Array<{id,name,category,pass,minGap,status,index,error}>} */
let tracks = [];
/** @type {Array<{id,frame,time,category,strength,duration}>} */
let events = [];
let result = null;
let suppress = false;

export function initEnginePanel() {
  const body = document.getElementById('engine-body');
  if (!body) return;
  body.addEventListener('pointerdown', () => { suppress = true; });
  window.addEventListener('pointerup', () => { if (suppress) { suppress = false; render(); } });

  document.getElementById('engine-close')?.addEventListener('click', () => {
    document.getElementById('engine-drawer')?.classList.add('hidden');
  });

  const input = document.getElementById('engine-files');
  input?.addEventListener('change', () => {
    importTracks(input.files);
    input.value = '';
  });

  bus.on(EV.MEDIA, render);
  bus.on(EV.PLAY, render);
  render();
}

/* ---------- импорт и индексация дорожек ---------- */
async function importTracks(fileList) {
  const files = [...fileList].filter((f) => /\.(wav|aif|aiff|mp3|ogg|flac|m4a)$/i.test(f.name)
    || /audio\//.test(f.type || ''));
  if (!files.length) {
    toast('Нужны аудиофайлы: WAV, AIFF, MP3, OGG, FLAC, M4A', { type: 'error' });
    return;
  }
  const ctx = player.audioContext();
  for (const f of files) {
    const { category, pass } = splitTrackName(f.name.replace(/\.[^.]+$/, ''));
    const id = uid('trk');
    tracks.push({
      id, name: f.name, category, pass,
      minGap: gapFor(f.name), status: 'decode', index: null, error: null,
    });
    render();
    try {
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      const chans = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      const mono = mixToMono(chans, buf.length);
      const idx = indexTrack(mono, buf.sampleRate, { category, pass, minGap: gapFor(f.name) });
      const t = tracks.find((x) => x.id === id);
      if (t) { t.status = 'done'; t.index = idx; }
    } catch (err) {
      const t = tracks.find((x) => x.id === id);
      if (t) { t.status = 'error'; t.error = err.message || String(err); }
      console.error(err);
      toast(`Не удалось разобрать ${f.name}: ${err.message || err}`, { type: 'error', timeout: 8000 });
    }
    render();
  }
  const ok = tracks.filter((t) => t.status === 'done').length;
  toast(`Дорожек готово: ${ok} из ${tracks.length}`);
}

function mixToMono(channels, length) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(length);
  for (const ch of channels) for (let i = 0; i < length; i++) out[i] += ch[i];
  for (let i = 0; i < length; i++) out[i] /= channels.length;
  return out;
}

function reindex(id) {
  const t = tracks.find((x) => x.id === id);
  if (!t || !t.file) return;
  t.status = 'decode';
  render();
  importTracks([t.file]);
}

/* ---------- события на картинке ---------- */
function addEventAtPlayhead() {
  const catInput = document.getElementById('engine-cat');
  const strInput = document.getElementById('engine-strength');
  const durInput = document.getElementById('engine-duration');
  const category = (catInput?.value || '').trim();
  if (!category) { toast('Укажите категорию (например steps)', { type: 'error' }); return; }
  const fps = Number(state.settings.fps) || 25;
  const t = state.time || 0;
  events.push({
    id: uid('ev'),
    frame: Math.round(t * fps),
    time: t,
    category,
    strength: Number(strInput?.value) || 0.7,
    duration: Number(durInput?.value) || 0.2,
  });
  events.sort((a, b) => a.time - b.time);
  render();
}

/* ---------- размещение ---------- */
function runPlacement() {
  const indexed = tracks.filter((t) => t.status === 'done' && t.index);
  if (!indexed.length) { toast('Сначала импортируйте и проиндексируйте дорожки', { type: 'error' }); return; }
  if (!events.length) { toast('Нет событий на картинке — отметьте хотя бы одно', { type: 'error' }); return; }

  const library = [];
  for (const t of indexed) {
    for (const e of t.index.events) {
      library.push({ ...e, track: t.index.pass || t.index.category, file: t.name, category: t.index.category });
    }
  }
  result = placeEvents(events, library, { fps: Number(state.settings.fps) || 25 });
  render();
  const s = result.summary;
  toast(`Размещено ${s.placed} из ${s.total}` + (s.missing ? `, без дублей ${s.missing}` : ''));
}

/* ---------- экспорт ---------- */
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function exportCsv() {
  if (!result) return;
  const fps = Number(state.settings.fps) || 25;
  const rows = [['кадр', 'таймкод', 'категория', 'сила', 'дорожка', 'файл', 'взять из (с)', 'вырез с', 'вырез по', 'уверенность', 'проверить']];
  for (const p of result.placements) {
    rows.push([
      p.frame, tc(p.time, fps), p.category, p.strength,
      p.audio ? p.audio.track : '', p.audio ? (p.audio.file || '') : '',
      p.audio ? p.audio.sourceTime : '', p.audio ? p.audio.cutFrom : '', p.audio ? p.audio.cutTo : '',
      p.audio ? p.confidence : '', p.audio ? (p.review ? 'да' : '') : (p.note || 'нет дубля'),
    ]);
  }
  const csv = '\uFEFF' + rows.map((r) => r.map((v) => {
    const s = String(v ?? '');
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';')).join('\r\n');
  download('montag-placement.csv', new Blob([csv], { type: 'text/csv' }));
  toast('CSV сохранён. Его понимают Excel, EdiMarker и любой редактор');
}

function exportJson() {
  if (!result) return;
  const fps = Number(state.settings.fps) || 25;
  download('montag-placement.json', new Blob([JSON.stringify({
    fps,
    placements: result.placements.map((p) => ({
      frame: p.frame, timecode: tc(p.time, fps), category: p.category, strength: p.strength,
      audio: p.audio ? {
        id: p.audio.id, track: p.audio.track, file: p.audio.file,
        sourceTime: p.audio.sourceTime, cutFrom: p.audio.cutFrom, cutTo: p.audio.cutTo,
      } : null,
      confidence: p.confidence ?? null, review: p.review ?? true, note: p.note ?? null,
    })),
  }, null, 2)], { type: 'application/json' }));
  toast('JSON сохранён');
}

function exportMidi() {
  if (!result) return;
  const fps = Number(state.settings.fps) || 25;
  const markers = result.placements.filter((p) => p.audio).map((p, i) => ({
    time: p.time, name: `${String(i + 1).padStart(2, '0')} ${tc(p.time, fps)} ${p.category}`,
  }));
  if (!markers.length) { toast('Нет размещённых событий', { type: 'error' }); return; }
  download('montag-markers.mid', new Blob([buildMarkerMidi(markers)], { type: 'audio/midi' }));
  toast(`${markers.length} маркеров → .mid. Cubase/Nuendo: File → Import → MIDI File (включите Import Markers)`);
}

/* ---------- рендер ---------- */
function tc(t, fps) {
  const total = Math.max(0, Math.round(t * fps));
  const f = total % fps;
  const s = Math.floor(total / fps) % 60;
  const m = Math.floor(total / (fps * 60)) % 60;
  const h = Math.floor(total / (fps * 3600));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

function render() {
  const body = document.getElementById('engine-body');
  if (!body) return;
  body.textContent = '';

  /* --- 1. дорожки --- */
  body.append(el('h3', {}, '1. Дорожки фоли'));
  body.append(el('p', { class: 'muted small' },
    'Импортируйте записанные дорожки — по файлу на категорию. Имя файла становится категорией, ',
    'хвостовой номер отделяется в проход: ', el('b', {}, 'steps 02'), ' → категория ', el('b', {}, 'steps'),
    ', проход ', el('b', {}, '02'), '. Новых категорий в коде не требуется.'));

  const fileBtn = el('button', { class: 'btn', id: 'engine-pick' }, '＋ Импорт дорожек');
  fileBtn.addEventListener('click', () => document.getElementById('engine-files').click());
  body.append(el('div', { class: 'row' }, fileBtn,
    el('span', { class: 'muted small' }, `дорожек: ${tracks.length}, проиндексировано: ${tracks.filter((t) => t.status === 'done').length}`)));

  if (tracks.length) {
    const table = el('table', { class: 'mini-table' });
    table.append(el('tr', {}, el('th', {}, 'файл'), el('th', {}, 'категория'), el('th', {}, 'проход'),
      el('th', {}, 'min-gap'), el('th', {}, 'событий'), el('th', {}, 'статус')));
    for (const t of tracks) {
      const st = t.status === 'done' ? '✓ готово'
        : t.status === 'decode' ? '⏳ разбор…'
          : t.status === 'error' ? `✗ ${t.error}` : '—';
      table.append(el('tr', {},
        el('td', {}, t.name),
        el('td', {}, el('b', {}, t.category)),
        el('td', {}, t.pass || '—'),
        el('td', {}, String(t.minGap)),
        el('td', {}, t.index ? String(t.index.events.length) : '—'),
        el('td', {}, st)));
    }
    body.append(table);
  }

  /* --- 2. события на картинке --- */
  body.append(el('h3', {}, '2. События на картинке'));
  body.append(el('p', { class: 'muted small' },
    'Поставьте playhead на кадр, где происходит действие, укажите категорию и нажмите «Отметить». ',
    'Кадр берётся точно — от позиции playhead.'));
  const cats = [...new Set(tracks.filter((t) => t.index).map((t) => t.index.category))];
  const catInput = el('input', { class: 'input', id: 'engine-cat', placeholder: 'категория', list: 'engine-cat-list', value: cats[0] || 'steps' });
  const dl = el('datalist', { id: 'engine-cat-list' });
  for (const c of cats) dl.append(el('option', { value: c }));
  const strInput = el('input', { class: 'input tiny', id: 'engine-strength', type: 'number', min: '0', max: '1', step: '0.1', value: '0.7', title: 'Сила события 0..1' });
  const durInput = el('input', { class: 'input tiny', id: 'engine-duration', type: 'number', min: '0.01', step: '0.01', value: '0.2', title: 'Ожидаемая длительность, с' });
  const addBtn = el('button', { class: 'btn primary', id: 'engine-add' }, '◎ Отметить в кадре');
  addBtn.addEventListener('click', addEventAtPlayhead);
  body.append(el('div', { class: 'row' }, dl, catInput, strInput, durInput, addBtn));
  body.append(el('div', { class: 'muted small' },
    `playhead: ${fmtTime(state.time || 0)} · кадр ${Math.round((state.time || 0) * (state.settings.fps || 25))} · fps ${state.settings.fps}`));

  if (events.length) {
    const list = el('div', { class: 'mini-list' });
    for (const e of events) {
      const del = el('button', { class: 'btn ghost tiny danger', title: 'Удалить' }, '✕');
      del.addEventListener('click', () => { events = events.filter((x) => x.id !== e.id); render(); });
      list.append(el('div', { class: 'mini-row' },
        el('span', { class: 'mono' }, tc(e.time, state.settings.fps || 25)),
        el('span', {}, e.category),
        el('span', { class: 'muted' }, `сила ${e.strength}`),
        del));
    }
    const clearBtn = el('button', { class: 'btn ghost tiny danger', title: 'Удалить все отмеченные события' }, 'Очистить');
    clearBtn.addEventListener('click', () => { events = []; render(); });
    body.append(el('div', { class: 'row' }, el('b', {}, `Отмечено: ${events.length}`), clearBtn));
    body.append(list);
  }

  /* --- 3. расстановка --- */
  body.append(el('h3', {}, '3. Размещение'));
  const runBtn = el('button', { class: 'btn primary', id: 'engine-run' }, '▶ Разместить');
  runBtn.addEventListener('click', runPlacement);
  body.append(runBtn);

  if (result) {
    const s = result.summary;
    body.append(el('p', {}, `Размещено ${s.placed} из ${s.total}` + (s.missing ? `, без дублей: ${s.missing}` : '')));
    const table = el('table', { class: 'mini-table' });
    table.append(el('tr', {}, el('th', {}, 'таймкод'), el('th', {}, 'категория'), el('th', {}, 'дорожка'),
      el('th', {}, 'взять из'), el('th', {}, 'вырез'), el('th', {}, 'увер.'), el('th', {}, '')));
    for (const p of result.placements) {
      const note = p.audio ? (p.review ? 'проверить' : '') : (p.note || 'нет дубля');
      table.append(el('tr', {},
        el('td', { class: 'mono' }, tc(p.time, state.settings.fps || 25)),
        el('td', {}, p.category),
        el('td', {}, p.audio ? p.audio.track : '—'),
        el('td', {}, p.audio ? `${p.audio.sourceTime.toFixed(3)} с` : '—'),
        el('td', {}, p.audio ? `${p.audio.cutFrom.toFixed(2)}–${p.audio.cutTo.toFixed(2)}` : '—'),
        el('td', {}, p.audio ? p.audio.confidence.toFixed(2) : '—'),
        el('td', { class: note ? 'warn' : '' }, note)));
    }
    body.append(table);

    for (const [c, v] of Object.entries(s.byCategory)) {
      body.append(el('div', { class: 'muted small' },
        `${c}: событий ${v.events}, размещено ${v.placed}, уникальных дублей ${v.unique} из ${v.library}`
        + (v.noTrack ? ' — ДОРОЖКИ НЕТ, нужна запись' : v.repeats > 0 ? `, повторов ${v.repeats}` : ', без повторов')));
    }

    body.append(el('div', { class: 'row' },
      el('button', { class: 'btn', id: 'engine-csv' }, '⇩ CSV (EdiMarker / Excel)'),
      el('button', { class: 'btn ghost', id: 'engine-json' }, '⇩ JSON'),
      el('button', { class: 'btn ghost', id: 'engine-midi' }, '⇩ .mid маркеры (Cubase/Nuendo)')));
    document.getElementById('engine-csv').addEventListener('click', exportCsv);
    document.getElementById('engine-json').addEventListener('click', exportJson);
    document.getElementById('engine-midi').addEventListener('click', exportMidi);
  }
}
