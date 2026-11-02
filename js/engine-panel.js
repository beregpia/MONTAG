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

import { state, EV, bus, uid, primaryClipAt, setPlacements, setSourceTrack, currentPreviewRow, setVideoAudioOnly } from './state.js';
import { el, toast, fmtTime } from './ui.js';
import { indexTrack, splitTrackName, gapFor } from './foley-library.js';
import { placeEvents, placeLeftovers } from './foley-place.js';
import { buildMarkerMidi } from './midi.js';
import { analyzeVideo, calibrateOffset } from './vision.js';
import * as player from './player.js';
import * as bank from './audio-bank.js';
import { buildFcp7Xml } from './premiere-export.js';

/** @type {Array<{id,name,category,pass,minGap,status,index,error}>} */
let tracks = [];
/** @type {Array<{id,frame,time,category,strength,duration}>} */
let events = [];
/** ручные метки «здесь настоящее касание» — для калибровки смещения детектора */
let calMarks = [];
/** медианное смещение «касание − пик движения», с */
let calOffset = 0;
/** предпросмотр размещения: играем картинку и вставляем звук из дорожек */
/** папка с дорожками на диске — для путей в XML Premiere */
let prFolder = '';
let previewing = false;
let previewRow = -1;      // какая строка таблицы звучит сейчас
let lastPreviewT = 0;
let result = null;
// последняя собранная библиотека дублей — нужна, чтобы добавить звуки без картинки
let lastLibrary = [];
// события уже сдвинуты на смещение — добавлять его повторно нельзя
let calApplied = false;
// смещение дорожки относительно картинки, считанное по меткам касаний
let suppress = false;

export function initEnginePanel() {
  const body = document.getElementById('engine-body');
  if (!body) return;

  /* Пока пользователь держит панель, её нельзя перестраивать: кнопка под
     пальцем исчезнет из DOM, и браузер не отправит на неё click — импорт
     дорожек просто не открывался. Набранное в полях тоже сбросится. */
  body.addEventListener('pointerdown', () => { suppress = true; });
  const endInteract = () => {
    if (!suppress) return;
    suppress = false;
    refreshReadouts();
  };
  window.addEventListener('pointerup', endInteract);
  window.addEventListener('pointercancel', endInteract);

  document.getElementById('engine-close')?.addEventListener('click', () => {
    document.getElementById('engine-drawer')?.classList.add('hidden');
  });

  const input = document.getElementById('engine-files');
  input?.addEventListener('change', () => {
    importTracks(input.files);
    input.value = '';
  });

  bus.on(EV.MEDIA, () => { if (!suppress) render(); });
  bus.on(EV.PLAY, () => { if (!suppress) refreshReadouts(); });
  bus.on(EV.TIME, (t) => { if (!suppress) refreshReadouts(); previewTick(t); });
  bus.on(EV.PLAY, (on) => { if (!on && previewing) stopPreview(); });
  // Сверка с оригиналом меняется при размещении, режим — по кнопке. Подпись
  // обновляем точечно: перестройка панели сбросила бы набранное в полях.
  bus.on(EV.PLACEMENTS, () => { if (!suppress) refreshVideoAudio(); });
  bus.on(EV.VIDEOAUDIO, () => { if (!suppress) refreshVideoAudio(); });
  render();
}

/** Обновляет только зависящие от playhead подписи — без перестройки панели. */
function refreshReadouts() {
  const node = document.getElementById('engine-readout');
  if (!node) return;
  const fps = Number(state.settings.fps) || 25;
  node.textContent = `playhead: ${fmtTime(state.time || 0)}`
    + ` · кадр ${Math.round((state.time || 0) * fps)} · fps ${state.settings.fps}`;
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
      if (t) {
        t.status = 'done';
        t.index = idx;
        // дорожка остаётся в банке, чтобы её дубли можно было и вырезать,
        // и проиграть во время воспроизведения
        t.banked = bank.putTrack(f.name, { data: mono, sampleRate: buf.sampleRate });
        // исходная дорожка уходит в состояние: её читает и таймлайн
        setSourceTrack({
          name: f.name, category: t.category, pass: t.pass || '',
          duration: idx.duration, events: idx.events,
        });
      }
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

/* ---------- детектор движения в картинке ---------- */
let scanning = false;
// Чувствительность детектора: правда влияет на порог. Раньше приложение
// советовало её «поднять», а настройки не было — теперь она есть и видна.
let sensitivity = 0.55;
let scanAbort = null;

/**
 * Разбор картинки: грубый проход по всем кадрам + уточнение каждого события.
 * Движение — это ещё не «шаг»: детектор даёт время и место, категорию задаёт
 * монтажёр (или он правит её в списке ниже). Точный кадр контакта получается
 * калибровкой по нескольким ручным отметкам — пик движения приходится на
 * середину замаха, а не на касание.
 */
async function detectMotionInClip() {
  if (scanning) { scanAbort?.abort(); return; }

  const clip = primaryClipAt(state.time) || state.clips[0];
  if (!clip) { toast('Сначала добавьте видео на таймлайн', { type: 'error' }); return; }
  const video = player.videoFor(clip);
  if (!video || !video.src) { toast('Видео клипа ещё не загрузилось', { type: 'error' }); return; }
  // Без этой проверки разбор честно вернёт ноль событий, но совет будет
  // «поднимите чувствительность» — и монтажёр пойдёт искать настройку,
  // которой нет, вместо того чтобы просто дождаться кадра.
  //
  // Признак «кадр есть» — известные размеры, а НЕ readyState >= 2. Chrome
  // отдаёт кадр на холст уже при readyState 1 (метаданные плюс один
  // декодированный кадр): именно на этом выросла целая правка чёрной сцены,
  // см. research/video-frame-pitfalls.md, причина 3. Прежняя проверка
  // отказывала детектору при живой картинке и советовала нажать «Пуск»,
  // который ничего не меняет — пользователь видел «не находит шаги».
  if (!isFinite(video.duration) || !video.videoWidth) {
    toast('Кадр ещё не декодировался. Нажмите «Пуск», дождитесь картинки, '
      + 'затем «🔍 Найти движение»', { type: 'warn', timeout: 9000 });
    return;
  }

  const catInput = document.getElementById('engine-cat');
  const category = (catInput?.value || '').trim() || 'steps';
  const fps = Number(state.settings.fps) || 25;

  scanning = true;
  scanAbort = new AbortController();
  const btn = document.getElementById('engine-detect');
  const label = btn ? btn.textContent : '';
  if (btn) {
    btn.textContent = '⏳ разбор… 0%';
    // Разбор идёт десятками секунд, а прервать его можно только повторным
    // нажатием этой же кнопки — об этом надо сказать прямо, иначе кнопка
    // выглядит мёртвой, и пользователь ждёт, не понимая что делать.
    btn.title = 'Идёт разбор. Нажмите, чтобы отменить.';
  }

  // разбор идёт через seek — на паузе, иначе позиция прыгает
  player.pause();

  try {
    const res = await analyzeVideo(video, {
      fps,
      sensitivity,
      signal: scanAbort.signal,
      onProgress: (p) => {
        if (!btn) return;
        // Процент одинаков для обеих фаз. Раньше уточнение считало
        // 100 + ratio, а Math.min(100, …) срезал это до ровно 100% — и вся
        // фаза показывала застывшее «уточнение 100%», хотя разбор шёл.
        // Выглядело как зависание, и монтажёр не понимал, ждать или отменять.
        const r = p.ratio * 100;
        btn.textContent = `⏳ ${p.phase === 'refine' ? 'уточнение' : 'разбор'} ${Math.min(100, Math.round(r))}%`;
      },
    });

    if (!res.events.length) {
      toast('Движение не найдено. Уменьшите чувствительность в панели — '
        + 'или отметьте шаги вручную кнопкой «◎ Отметить в кадре».', { type: 'warn', timeout: 9000 });
      return;
    }

    for (const e of res.events) {
      events.push({
        id: uid('ev'),
        frame: Math.round(e.time * fps),
        time: e.time,
        category,
        strength: Number((e.strength ?? 0.7).toFixed(2)),
        duration: Number((e.duration || 0.2).toFixed(2)),
        // где в кадре произошло движение — по этому зоны привязывают к персонажам
        region: e.regions?.[0] ? {
          x: e.regions[0].x, y: e.regions[0].y,
          w: e.regions[0].w, h: e.regions[0].h,
        } : null,
        source: '',
      });
    }
    events.sort((a, b) => a.time - b.time);
    const withRegion = events.filter((e) => e.region).length;
    toast(`Найдено событий: ${res.events.length}`
      + ` (с позицией в кадре: ${withRegion}). Проверьте категорию — детектор видит движение, а не «шаг».`);
  } catch (err) {
    if (scanAbort?.signal.aborted) toast('Разбор отменён');
    else toast(`Не удалось разобрать картинку: ${err.message || err}`, { type: 'error', timeout: 8000 });
  } finally {
    scanning = false;
    scanAbort = null;
    if (btn) {
      btn.textContent = label;
      btn.title = '';
    }
    render();
  }
}

/* ---------- предпросмотр размещения ---------- */

/**
 * Покадрово: ведёт подсветку строки, которая звучит сейчас, и сам
 * останавливается после последнего дубля. Сам звук играет foley.tick() —
 * один источник на предпросмотр и на обычное воспроизведение, иначе дубль
 * звучал бы дважды.
 */
function previewTick(nowT) {
  if (!previewing) return;
  const prev = lastPreviewT;
  lastPreviewT = nowT;
  if (!(nowT > prev) || nowT - prev > 0.5) return;   // перескок — не дёргать подсветку
  const current = currentPreviewRow(result?.placements || [], nowT);
  if (current !== previewRow) {
    previewRow = current;
    highlightPreviewRow();
  }
  const last = result?.placements.length
    ? result.placements[result.placements.length - 1].time : 0;
  // render() уничтожает узлы панели — из кадра анимации его звать нельзя,
  // иначе обработчики событий могут потерять свои кнопки на середине клика.
  if (nowT >= last + 0.6) { stopPreview(false); queueMicrotask(render); }
}

/** Подсветка строки, которая звучит прямо сейчас. */
function highlightPreviewRow() {
  const rows = document.querySelectorAll('#engine-results tr[data-row]');
  rows.forEach((tr) => {
    const on = Number(tr.dataset.row) === previewRow;
    tr.classList.toggle('preview-now', on);
    if (on) tr.scrollIntoView({ block: 'nearest' });
  });
}

function startPreview() {
  if (!result?.placements.length) return;
  // если слой таймлайна пуст (например, его очистили) — кладём размещение снова,
  // иначе звук играть будет некому
  if (!state.placements.length) pushPlacementsToTimeline();
  const ps = result.placements;
  const first = ps[0].time;
  const last = ps[ps.length - 1].time;
  previewing = true;
  previewRow = -1;
  // если playhead уже за последним дублем — начнём сначала
  if (state.time > last || state.time < first - 0.5) player.seek(Math.max(0, first - 0.4));
  lastPreviewT = state.time;
  player.ensureAudio?.();
  player.play();
  render();
}

/** @param {boolean} updateUi false — когда зовём из кадра анимации. */
function stopPreview(updateUi = true) {
  previewing = false;
  previewRow = -1;
  player.pause();
  if (updateUi) render();
}

/* ---------- размещение ---------- */
function runPlacement() {
  const indexed = tracks.filter((t) => t.status === 'done' && t.index);
  if (!indexed.length) { toast('Сначала импортируйте и проиндексируйте дорожки', { type: 'error' }); return; }
  if (!events.length) { toast('Нет событий на картинке — отметьте хотя бы одно', { type: 'error' }); return; }

  const library = [];
  for (const t of indexed) {
    for (const e of t.index.events) {
      library.push({ ...e, track: t.index.pass || t.index.category, file: t.name,
        category: t.index.category, source: t.name });
    }
  }
  // Смещение дорожки относительно картинки: звукорежиссёр пишет дорожку до того,
  // как персонаж вошёл в кадр. Это нормально — и именно поэтому считаем неиспользованные
  // звуки и предлагаем доставить их по времени записи.
  lastLibrary = library;
  result = placeEvents(events, library, { fps: Number(state.settings.fps) || 25 });
  render();
  const s = result.summary;
  const nPlaced = pushPlacementsToTimeline();
  toast(`Размещено ${s.placed} из ${s.total}`
    + (s.missing ? `, без дублей ${s.missing}` : '')
    + (s.libraryUnused
      ? ` · звуков без картинки: ${s.libraryUnused} из ${s.libraryTotal}`
      : '')
    + (nPlaced ? ` · на таймлайн добавлено дублей: ${nPlaced}` : ''));
}

/**
 * Достаёт звуки дорожек, для которых не нашлось события на картинке.
 * Пользователь: «если вначале записанных файлов начинается раньше, возможно герой за кадром
 * двигается».
 */
function runLeftovers() {
  if (!result || !lastLibrary.length) {
    toast('Сначала нажмите «Разместить»', { type: 'warn' });
    return;
  }
  const s = result.summary;
  if (!s.libraryUnused) { toast('Неиспользованных звуков нет', { type: 'ok' }); return; }
  const r = placeLeftovers(result.placements, lastLibrary, {
    fps: Number(state.settings.fps) || 25,
    // если пользователь нажал «Применить», события уже сдвинуты — смещение будет применено дважды
    offset: calApplied ? 0 : (Number(calOffset) || 0),
  });
  result = { ...result, placements: r.placements };
  const nPlaced = pushPlacementsToTimeline();
  toast(`Добавлено по времени записи: ${r.added}`
    + (nPlaced ? ` · на таймлайн: ${nPlaced}` : ''));
}
/**
 * Кладёт размещение на таймлайн отдельным слоем клипов: строка на персонажа,
 * ширина клипа — длительность дубля. Слой заменяется целиком, поэтому ручные
 * события панели «Foley» (state.foley) он не задевает.
 *
 * @returns {number} сколько дублей ушло на таймлайн
 */
function pushPlacementsToTimeline() {
  if (!result?.placements.length) { setPlacements([]); return 0; }
  const list = result.placements.filter((p) => p.audio).map((p) => ({
    id: p.id || uid('pl'),
    time: p.time,
    duration: Math.max(0.02, (p.audio.cutTo || 0) - (p.audio.cutFrom || 0)),
    category: p.category || '',
    source: p.source || p.audio.file || '',
    track: p.audio.track || '',
    file: p.audio.file || '',
    cutFrom: p.audio.cutFrom || 0,
    cutTo: p.audio.cutTo || 0,
    confidence: p.confidence ?? null,
    review: !!p.review,
  }));
  setPlacements(list);
  return list.length;
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
  const rows = [['кадр', 'таймкод', 'категория', 'персонаж', 'сила', 'зона', 'дорожка', 'файл', 'взять из (с)', 'вырез с', 'вырез по', 'уверенность', 'проверить']];
  for (const p of result.placements) {
    rows.push([
      p.frame, tc(p.time, fps), p.category, p.source ? shortName(p.source) : '',
      p.strength, zoneLabel(p.region),
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
      frame: p.frame, timecode: tc(p.time, fps), category: p.category,
      source: p.source ? shortName(p.source) : null,
      zone: p.region ? zoneLabel(p.region) : null,
      strength: p.strength,
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

/* ---------- Premiere Pro ---------- */
/**
 * Раскладка размещения в поля FCP7 XML. Отдельная функция, чтобы проверять маппинг без кликов по кнопкам.
 *
 * @param {Array} placed  размещения с заполненным audio
 * @param {Array} trks     дорожки панели
 * @param {string} folder  папка дорожек на диске (может быть пустой)
 * @param {number} fps
 * @returns {{sources: Array, clips: Array, markers: Array}}
 */
export function premierePayload(placed, trks, folder, fps) {
  const join = (name) => (folder ? `${folder.replace(/[\\/]+$/, '')}\\${name}` : name);

  // длительность дорожки: out-точка за концом файла ломает весь импорт
  const sources = trks
    .filter((t) => placed.some((p) => p.audio.file === t.name))
    .map((t) => ({ name: t.name, path: join(t.name), duration: t.index?.duration || 0 }));
  const known = new Set(sources.map((s) => s.name));
  for (const p of placed) {
    if (known.has(p.audio.file)) continue;
    known.add(p.audio.file);
    sources.push({ name: p.audio.file, path: join(p.audio.file), duration: 0 });
  }

  return {
    sources,
    clips: placed.map((p) => ({
      file: p.audio.file,
      at: p.time,
      in: p.audio.cutFrom,
      out: p.audio.cutTo,
      label: `${p.category || ''} ${p.source ? shortName(p.source) : ''}`.trim(),
    })),
    markers: placed.map((p, i) => ({
      at: p.time,
      name: `${String(i + 1).padStart(2, '0')} ${tc(p.time, fps)} ${p.category || ''}`.trim(),
      comment: `${shortName(p.audio.file)} · дубль с ${p.audio.cutFrom.toFixed(2)} `
        + `до ${p.audio.cutTo.toFixed(2)}` + (p.review ? ' · проверить' : ''),
    })),
  };
}

/**
 * FCP7 XML (единственный interchange, который Premiere открывает):
 * клипы на звуковых дорожках — строка на персонажа, плюс маркеры.
 */
function exportPremiere() {
  if (!result?.placements.length) { toast('Сначала выполните размещение', { type: 'error' }); return; }
  const fps = Number(state.settings.fps) || 25;
  const placed = result.placements.filter((p) => p.audio);
  if (!placed.length) { toast('Нет размещённых дублей', { type: 'error' }); return; }

  const payload = premierePayload(placed, tracks, prFolder, fps);
  const { xml, summary } = buildFcp7Xml({
    name: `MONTAG фоли ${tc(placed[0].time, fps)}`,
    fps, width: state.settings.width, height: state.settings.height,
    ...payload,
  });
  download('montag-premiere.xml', new Blob([xml], { type: 'application/xml' }));
  toast(`XML готов: ${summary.clips} клипов на ${summary.audioTracks} дорожках, `
    + `${summary.markers} маркеров. Premiere: File → Import`
    + (prFolder ? '' : '. Путь к дорожкам не указан — клипы приедут офлайн, Premiere спросит файлы'));
}

/* ---------- рендер ---------- */
/** Смещение со знаком: +0.048 / −0.120 / 0.000 */
function signed(v) {
  const r = Math.abs(v) < 5e-4 ? 0 : v;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(3)}`;
}

/** Короткое имя дорожки без расширения — для подписей. */
function shortName(s) {
  return String(s || '').replace(/\.[^.]+$/, '');
}

/** Центр области движения по горизонтали, 0..1, или null если позиции нет. */
export function zoneCenter(region) {
  if (!region || !Number.isFinite(region.x) || !Number.isFinite(region.w)) return null;
  return region.x + region.w / 2;
}

/** «слева / центр / справа» по центру области движения. */
export function zoneLabel(region) {
  const cx = zoneCenter(region);
  if (cx == null) return '—';
  if (cx < 1 / 3) return 'слева';
  if (cx < 2 / 3) return 'центр';
  return 'справа';
}

/** События, чья область движения попала в полосу [lo, hi]. */
export function eventsInZone(events, lo, hi) {
  return events.filter((e) => {
    const cx = zoneCenter(e.region);
    return cx != null && cx >= lo && cx < hi;
  });
}

/** Привязывает все события из полосы [lo, hi] к дорожке-персонажу. */
function bindZone(source, lo, hi) {
  const hit = eventsInZone(events, lo, hi);
  for (const e of hit) e.source = source;
  return hit.length;
}

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

  /* --- частота кадра проекта --- */
  const fpsNow = Number(state.settings.fps) || 25;
  const fpsSel = el('select', { class: 'select', id: 'engine-fps', title: 'Кадров в секунду в проекте — от неё номера кадров и таймкоды' });
  for (const v of [24, 25, 30, 50, 60]) {
    if (!fpsSel.querySelector(`option[value="${v}"]`)) {
      fpsSel.append(el('option', { value: String(v) }, `${v} к/с`));
    }
  }
  if (![...fpsSel.options].some((o) => Number(o.value) === fpsNow)) {
    fpsSel.append(el('option', { value: String(fpsNow) }, `${fpsNow} к/с`));
  }
  fpsSel.value = String(fpsNow);
  fpsSel.addEventListener('change', () => {
    const v = Number(fpsSel.value);
    if (!(v > 0)) return;
    state.settings.fps = v;
    // кадры событий пересчитываем сразу, иначе таймкоды разойдутся с позицией
    for (const e of events) e.frame = Math.round(e.time * v);
    toast(`Частота кадра: ${v}. Номера кадров и таймкоды пересчитаны.`);
    render();
  });
  body.append(el('div', { class: 'row' },
    el('span', { class: 'muted small' }, 'Частота кадра:'), fpsSel,
    el('span', { class: 'muted small' }, 'от неё номера кадров и таймкоды')));

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
  // Порядок важен: автомат первый, ручная отметка — исключение. Раньше здесь
  // первым шёл ручной путь, и читатель уходил отмечать шаги руками, хотя
  // «Найти движение» разбирает клип целиком одним нажатием.
  body.append(el('p', { class: 'muted small' },
    'Нажмите ', el('b', {}, '«🔍 Найти движение»'),
    ' — движок разберёт картинку клипа под playhead целиком и сам расставит все события. ',
    'Ручная отметка одного кадра нужна только тогда, когда детектор ',
    el('b', {}, 'что-то пропустил'), ' или когда события ',
    el('b', {}, 'тихие'), ' — ткань, бумага, ключи: их по картинке не видно в принципе.'));
  const cats = [...new Set(tracks.filter((t) => t.index).map((t) => t.index.category))];
  const catInput = el('input', { class: 'input', id: 'engine-cat', placeholder: 'категория', list: 'engine-cat-list', value: cats[0] || 'steps' });
  const dl = el('datalist', { id: 'engine-cat-list' });
  for (const c of cats) dl.append(el('option', { value: c }));
  const strInput = el('input', { class: 'input tiny', id: 'engine-strength', type: 'number', min: '0', max: '1', step: '0.1', value: '0.7', title: 'Сила события 0..1' });
  const durInput = el('input', { class: 'input tiny', id: 'engine-duration', type: 'number', min: '0.01', step: '0.01', value: '0.2', title: 'Ожидаемая длительность, с' });
  // главная кнопка секции — автомат: клип разбирается целиком, ни одного
  // шага вручную. Ручная отметка стоит рядом, но не главнее.
  const detBtn = el('button', { class: 'btn primary', id: 'engine-detect' }, '🔍 Найти движение');
  detBtn.title = 'Разобрать картинку клипа и отметить все моменты, где что-то двинулось';
  detBtn.addEventListener('click', detectMotionInClip);

  const addBtn = el('button', { class: 'btn', id: 'engine-add' }, '◎ Отметить в кадре');
  addBtn.title = 'Только для пропусков и тихих событий: один кадр под playhead';
  addBtn.addEventListener('click', addEventAtPlayhead);

  body.append(el('div', { class: 'row' }, detBtn, addBtn,
    el('span', { class: 'muted small' },
      'движок отметит весь клип · ручная отметка — для промахов и тихого')));
  body.append(el('div', { class: 'row' }, catInput, strInput, durInput,
    el('span', { class: 'muted small' }, 'категория, сила и длина для ручной отметки')));

  /* Чувствительность детектора. Раньше приложение советовало «поднять
   * чувствительность», а настройки не существовало — монтажёр шёл искать то,
   * чего нет. Ползунок есть, и он правда меняет порог. */
  const sens = el('input', {
    class: 'input tiny', id: 'engine-sens', type: 'range',
    min: '0.1', max: '1.5', step: '0.05', value: String(sensitivity),
    title: 'Чувствительность детектора: ниже — больше событий, выше — только '
      + 'самые заметные. Если шагов мало, уменьшите.',
  });
  const sensOut = el('b', {}, sensitivity.toFixed(2));
  sens.addEventListener('input', () => {
    sensitivity = Number(sens.value);
    sensOut.textContent = sensitivity.toFixed(2);
  });
  body.append(el('div', { class: 'row' }, sens, sensOut,
    el('span', { class: 'muted small' },
      'чувствительность: меньше — найдёт больше шагов')));
  body.append(el('div', { class: 'muted small', id: 'engine-readout' },
    `playhead: ${fmtTime(state.time || 0)} · кадр ${Math.round((state.time || 0) * (state.settings.fps || 25))} · fps ${state.settings.fps}`));

  /* --- калибровка: пик движения против настоящего касания --- */
  if (events.length) {
    const fps0 = Number(state.settings.fps) || 25;
    const markBtn = el('button', { class: 'btn', id: 'engine-mark', title: 'Запомнить позицию playhead как настоящее касание' }, '◎ Касание здесь');
    markBtn.addEventListener('click', () => {
      calMarks.push({ time: Math.max(0, state.time || 0) });
      calMarks.sort((a, b) => a.time - b.time);
      toast(`Метка касания: ${fmtTime(state.time || 0)}`);
      render();
    });
    const calBtn = el('button', { class: 'btn', id: 'engine-cal', title: 'Медианное смещение между метками касаний и найденными событиями' }, '⇔ Смещение');
    calBtn.addEventListener('click', () => {
      const r = calibrateOffset(calMarks, events, fps0);
      if (!r.used) {
        toast('Ни одной пары: поставьте playhead на настоящее касание и нажмите «Касание здесь»', { type: 'warn' });
        return;
      }
      calOffset = r.offset;
      toast(`Смещение ${signed(calOffset)} с по ${r.used} парам`);
      render();
    });
    const applyBtn = el('button', { class: 'btn', id: 'engine-cal-apply', title: 'Сдвинуть все отмеченные события на вычисленное смещение' }, 'Применить');
    applyBtn.disabled = !calMarks.length;
    applyBtn.addEventListener('click', () => {
      if (!calMarks.length) return;
      for (const e of events) {
        e.time = Math.max(0, e.time + calOffset);
        e.frame = Math.round(e.time * fps0);
      }
      events.sort((a, b) => a.time - b.time);
      calApplied = true;
      toast(`События сдвинуты на ${signed(calOffset)} с`);
      render();
    });
    const clearCalBtn = el('button', { class: 'btn ghost tiny danger', title: 'Удалить метки касаний' }, '✕');
    clearCalBtn.addEventListener('click', () => { calMarks = []; calOffset = 0; render(); });

    body.append(el('div', { class: 'row' }, markBtn, calBtn, applyBtn, clearCalBtn,
      el('span', { class: 'muted small' },
        calMarks.length ? `меток ${calMarks.length}, смещение ${signed(calOffset)} с` : 'меток нет')));
    body.append(el('div', { class: 'muted small' },
      'Детектор отмечает пик замаха, а не касание. Поставьте playhead на 2–3 настоящих касания, ',
      'нажмите «Касание здесь», затем «⇔ Смещение» и «Применить».'));
  }

  if (events.length) {
    const list = el('div', { class: 'mini-list' });
    for (const e of events) {
      const del = el('button', { class: 'btn ghost tiny danger', title: 'Удалить' }, '✕');
      del.addEventListener('click', () => { events = events.filter((x) => x.id !== e.id); render(); });
      list.append(el('div', { class: 'mini-row' },
        el('span', { class: 'mono' }, tc(e.time, state.settings.fps || 25)),
        el('span', {}, e.category),
        el('span', { class: 'muted' }, `сила ${e.strength}`),
        el('span', { class: 'muted', title: 'где в кадре произошло движение' }, zoneLabel(e.region)),
        el('span', { class: e.source ? '' : 'muted', title: 'чьи шаги' },
          e.source ? shortName(e.source) : '— персонаж'),
        del));
    }
    const clearBtn = el('button', { class: 'btn ghost tiny danger', title: 'Удалить все отмеченные события' }, 'Очистить');
    clearBtn.addEventListener('click', () => { events = []; render(); });
    body.append(el('div', { class: 'row' }, el('b', {}, `Отмечено: ${events.length}`), clearBtn));
    body.append(list);
  }

  /* --- привязка зон кадра к персонажам --- */
  if (events.length && tracks.some((t) => t.status === 'done')) {
    body.append(el('h3', {}, 'Чьи шаги: зоны кадра'));
    body.append(el('div', { class: 'muted small' },
      'Детектор не различает персонажей — он видит, что в кадре сдвинулось, и где. ',
      'Укажите для каждой дорожки горизонтальную полосу кадра: все события из неё ',
      'получат этого персонажа, и «Разместить» возьмёт дубли только из его дорожки.'));

    const bound = events.filter((e) => e.source).length;
    if (bound) {
      body.append(el('div', { class: 'muted small' },
        `с персонажем: ${bound} из ${events.length}`,
        events.length - bound ? `, без персонажа: ${events.length - bound}` : ''));
    }

    const rows = [[0, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 1]];
    for (const [a, b] of rows) {
      const sel = el('select', { class: 'select', id: 'zone-track' });
      for (const t of tracks.filter((x) => x.status === 'done')) {
        sel.append(el('option', { value: t.name }, t.name));
      }
      const from = el('input', { class: 'input tiny', type: 'number', min: '0', max: '1', step: '0.01', value: a.toFixed(2), title: 'от (0 — левый край, 1 — правый)' });
      const to = el('input', { class: 'input tiny', type: 'number', min: '0', max: '1', step: '0.01', value: b.toFixed(2), title: 'до (0 — левый край, 1 — правый)' });
      const go = el('button', { class: 'btn', id: 'zone-apply' }, 'Привязать');
      go.addEventListener('click', () => {
        const track = sel.value;
        const lo = Math.max(0, Math.min(1, Number(from.value) || 0));
        const hi = Math.max(0, Math.min(1, Number(to.value) || 0));
        const n = bindZone(track, Math.min(lo, hi), Math.max(lo, hi));
        toast(n
          ? `Персонажу ${shortName(track)} привязано событий: ${n}`
          : 'В этой полосу нет событий с позицией в кадре', { type: n ? 'ok' : 'warn' });
        render();
      });
      body.append(el('div', { class: 'row' }, sel, from, to, go));
    }
    if (bound) {
      const reset = el('button', { class: 'btn ghost tiny danger' }, 'Сбросить привязку');
      reset.addEventListener('click', () => {
        for (const e of events) e.source = '';
        toast('Привязка зон сброшена — движок снова берёт дубли из всех дорожек');
        render();
      });
      body.append(el('div', { class: 'row' }, reset));
    }
  }

  /* --- 3. расстановка --- */
  body.append(el('h3', {}, '3. Размещение'));
  const runBtn = el('button', { class: 'btn primary', id: 'engine-run' }, '▶ Разместить');
  runBtn.addEventListener('click', runPlacement);
  const prevBtn = el('button', {
    class: 'btn', id: 'engine-preview',
    title: 'Играет картинка, и в моменты размещения звучит вырезанный дубль из вашей дорожки',
  }, previewing ? '⏸ Стоп' : '🔊 Прослушать');
  prevBtn.disabled = !result?.placements.length;
  prevBtn.addEventListener('click', () => (previewing ? stopPreview() : startPreview()));
  // Достать звуки дорожек, для которых не нашлось события на картинке. Второстепенная
  // кнопка, а не первая: путем по умолчанию идёт «Разместить».
  const leftBtn = el('button', {
    class: 'btn', id: 'engine-leftovers',
    title: 'Звуки дорожек, для которых не нашлось события на картинке, '
      + 'вставляются по времени записи со смещением. '
      + 'Полезно, когда персонаж ещё за кадром',
  }, '⇨ Звуки без картинки');
  leftBtn.disabled = !result?.summary?.libraryUnused;
  leftBtn.addEventListener('click', runLeftovers);
  body.append(el('div', { class: 'row' }, runBtn, prevBtn, leftBtn));
  if (result?.summary?.libraryUnused) {
    body.append(el('div', { class: 'muted small' },
      'Дорожка чаще всего начинается раньше, чем персонаж появляется в кадре — он ещё за кадром. ',
      'Такие звуки детектор не видит в принципе. Кнопка достаёт их по времени записи — ',
      'они попадут на таймлайн помеченными как «нужна проверка».'));
  }
  if (result?.placements.length) {
    body.append(el('div', { class: 'muted small' },
      'Нажмите «Прослушать»: playhead идёт по таймлайну, и в момент каждого размещения ',
      'звучит дубль, вырезанный из вашей дорожки. В таблице ниже подсвечивается строка, ',
      'которая звучит сейчас.'));
    body.append(el('div', { class: 'muted small' },
      'Те же дубли легли на таймлайн внизу — строкой на каждую дорожку, ',
      'чтобы было видно, чей шаг куда встал. Клик по клипу прослушает его.'));
  }

  if (result) {
    const s = result.summary;
    body.append(el('p', {}, `Размещено ${s.placed} из ${s.total}` + (s.missing ? `, без дублей: ${s.missing}` : '')));
    const table = el('table', { class: 'mini-table', id: 'engine-results' });
    table.append(el('tr', {}, el('th', {}, 'таймкод'), el('th', {}, 'категория'), el('th', {}, 'дорожка'),
      el('th', {}, 'взять из'), el('th', {}, 'вырез'), el('th', {}, 'увер.'), el('th', {}, '')));
    result.placements.forEach((p, i) => {
      const note = p.audio ? (p.review ? 'проверить' : '') : (p.note || 'нет дубля');
      table.append(el('tr', { dataset: { row: String(i) } },
        el('td', { class: 'mono' }, tc(p.time, state.settings.fps || 25)),
        el('td', {}, p.category),
        el('td', {}, p.audio ? p.audio.track : '—'),
        el('td', {}, p.audio ? `${p.audio.sourceTime.toFixed(3)} с` : '—'),
        el('td', {}, p.audio ? `${p.audio.cutFrom.toFixed(2)}–${p.audio.cutTo.toFixed(2)}` : '—'),
        el('td', {}, p.audio ? p.audio.confidence.toFixed(2) : '—'),
        el('td', { class: note ? 'warn' : '' }, note)));
    });
    body.append(table);

    for (const [c, v] of Object.entries(s.byCategory)) {
      body.append(el('div', { class: 'muted small' },
        `${c}: событий ${v.events}, размещено ${v.placed}, уникальных дублей ${v.unique} из ${v.library}`
        + (v.noTrack ? ' — ДОРОЖКИ НЕТ, нужна запись' : v.repeats > 0 ? `, повторов ${v.repeats}` : ', без повторов')));
    }

    if (s.bySource && Object.keys(s.bySource).length > 1) {
      for (const [src, v] of Object.entries(s.bySource)) {
        body.append(el('div', { class: 'muted small' },
          `${src === '—' ? 'без персонажа' : src}: событий ${v.events}, размещено ${v.placed}`
          + `, уникальных дублей ${v.unique} из ${v.library}`
          + (v.noTrack ? ' — ДОРОЖКИ НЕТ, нужна запись'
            : v.repeats > 0 ? `, повторов ${v.repeats}` : ', без повторов')));
      }
    }

    body.append(el('div', { class: 'row' },
      el('button', { class: 'btn', id: 'engine-csv' }, '⇩ CSV (EdiMarker / Excel)'),
      el('button', { class: 'btn ghost', id: 'engine-json' }, '⇩ JSON'),
      el('button', { class: 'btn ghost', id: 'engine-midi' }, '⇩ .mid маркеры (Cubase/Nuendo)'),
      el('button', { class: 'btn ghost', id: 'engine-prxml' }, '⇩ Premiere Pro (.xml)')));
    document.getElementById('engine-csv').addEventListener('click', exportCsv);
    document.getElementById('engine-json').addEventListener('click', exportJson);
    document.getElementById('engine-midi').addEventListener('click', exportMidi);
    document.getElementById('engine-prxml').addEventListener('click', exportPremiere);

    /* Premiere ищет дорожки по полному пути, а браузер отдаёт только имя файла.
       Поэтому папку монтажёр указывает сам — иначе клипы приедут офлайн. */
    body.append(el('div', { class: 'row' },
      el('span', { class: 'muted small' }, 'папка дорожек на диске:'),
      el('input', {
        class: 'input', id: 'engine-prpath', placeholder: 'D:\\Foley\\Ep07',
        title: 'Полный путь к папке, где лежат WAV дорожек. '
          + 'Без него Premiere спросит, где файлы, при импорте.',
      })));
    const prPath = document.getElementById('engine-prpath');
    prPath.value = prFolder;
    prPath.addEventListener('change', () => { prFolder = prPath.value.trim(); });
    body.append(el('div', { class: 'muted small' },
      'XML открывается в Premiere через File → Import: появляется '
      + 'последовательность с фоли на звуковых дорожках '
      + '(строка на персонажа) и маркерами по кадрам.'));
  }

  videoAudioSection(body);
}

/**
 * Звук самого клипа: оригинальные шаги и сверка с ними расстановки.
 *
 * Секция живёт последней: сравнивать есть смысец только после того, как фоли
 * расставлено. Перестройку не делает — только подпись, иначе набранное в полях
 * выше сбрасывалось бы на каждое размещение.
 */
function videoAudioSection(body) {
  const va = state.videoAudio;
  body.append(el('h3', {}, '4. Оригинал в звуке клипа'));
  body.append(el('p', { class: 'muted small' },
    'В съёмочной записи шаги уже есть — вместе с репликами. Движок читает звук ',
    'клипа, находит в нём шаги и ', el('b', {}, 'убирает всё остальное'),
    ': речь и прочее воротами не звучит вовсе. Шаги остаются — с ними ',
    'сверяется расстановка.'));

  const runBtn = el('button', { class: 'btn', id: 'va-run' }, '🔊 Разобрать звук клипа');
  runBtn.title = 'Прочитать звуковую дорожку клипа и найти в ней шаги';
  runBtn.addEventListener('click', async () => {
    const readout = document.getElementById('va-readout');
    runBtn.disabled = true;
    if (readout) readout.textContent = 'Читаю звук клипа…';
    await player.analyzeClipAudio();
    runBtn.disabled = false;
    refreshVideoAudio();
  });

  const onlyBtn = el('button', {
    class: `btn${va.only ? '' : ' ghost'}`, id: 'va-only',
    title: 'Что звучит из клипа: только найденные шаги или запись как есть',
  }, va.only ? '◉ Только шаги' : '○ Как записано');
  onlyBtn.addEventListener('click', () => setVideoAudioOnly(!state.videoAudio.only));

  body.append(el('div', { class: 'row' }, runBtn, onlyBtn,
    el('span', { class: 'muted small' }, 'речь и прочее воротами убираются')));
  body.append(el('div', { class: 'muted small', id: 'va-readout' }, videoAudioReadout()));
}

/** Подпись секции: что нашли и как расстановка сходится с оригиналом. */
function videoAudioReadout() {
  const va = state.videoAudio;
  if (va.error) return va.error;
  if (!va.ready) return 'Звук клипа ещё не разобран.';
  let out = `Шагов в оригинале: ${va.steps.length}`;
  if (va.dropped.length) out += `, отброшено как не шаги: ${va.dropped.length}`;
  const c = va.cmp;
  if (!c) return out + '.';
  const parts = [`совпало ${c.ok}`];
  if (c.early) parts.push(`фоли раньше ${c.early}`);
  if (c.late) parts.push(`фоли позже ${c.late}`);
  if (c.miss) parts.push(`пропущено ${c.miss}`);
  if (c.extra) parts.push(`лишних дублей ${c.extra}`);
  return `${out}. Сверка: ${parts.join(' · ')}.`;
}

/** Обновляет подпись и кнопку режима — без перестройки секции. */
function refreshVideoAudio() {
  const readout = document.getElementById('va-readout');
  if (readout) readout.textContent = videoAudioReadout();
  const onlyBtn = document.getElementById('va-only');
  if (onlyBtn) {
    const only = state.videoAudio.only;
    onlyBtn.textContent = only ? '◉ Только шаги' : '○ Как записано';
    onlyBtn.classList.toggle('ghost', !only);
  }
}
