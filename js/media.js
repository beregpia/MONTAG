/* ============ Импорт медиафайлов ============ */

import { state, uid, EV, bus } from './state.js';
import { toast } from './ui.js';

export let selectedMediaId = null;

/** Журнал импорта: видимые результаты вместо мимолётных тостов. */
export const importLog = [];

const VIDEO_ERRORS = {
  1: 'загрузка прервана',
  2: 'сетевая ошибка',
  3: 'ошибка декодирования',
  4: 'формат или кодек не поддерживается браузером',
};

export function describeVideoError(err) {
  return VIDEO_ERRORS[err?.code] || 'неизвестная ошибка';
}

/** Что браузеры реально открывают — показываем подсказку при неудаче. */
export const CODEC_HINT =
  'Браузеры открывают mp4 (H.264 + AAC) и webm (VP8/VP9). '
  + 'mkv, ProRes, HEVC и avi нужно конвертировать (HandBrake или ffmpeg).';

function logImport(name, ok, message) {
  importLog.unshift({ name, ok, message, at: Date.now() });
  if (importLog.length > 6) importLog.pop();
  bus.emit(EV.MEDIA);
}

export async function importFiles(fileList) {
  const files = [...fileList].filter((f) => {
    const type = f.type || '';
    return type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv|ogg|ogv)$/i.test(f.name || '');
  });
  if (!files.length) {
    toast('Нужны видеофайлы (mp4, webm, mov…)', { type: 'error' });
    logImport('—', false, 'выбраны не видеофайлы');
    return [];
  }
  const items = [];
  for (const file of files) {
    try {
      const item = await loadMedia(file);
      items.push(item);
      logImport(file.name, true, `ок · ${fmtDur(item.duration)}${item.width ? ` · ${item.width}×${item.height}` : ''}`);
    } catch (err) {
      console.error(err);
      logImport(file.name, false, err.message || String(err));
      toast(`Не удалось прочитать «${file.name}»: ${err.message || err}`, { type: 'error', timeout: 9000 });
    }
  }
  if (items.length) {
    state.media.push(...items);
    bus.emit(EV.MEDIA);
    toast('Добавлено в медиатеку. Теперь добавьте на таймлайн — кнопка «На таймлайн» или двойной клик по файлу.');
  }
  return items;
}

/** Добавляет все файлы медиатеки на таймлайн (весь файл целиком). */
export function appendAllToTimeline() {
  if (!state.media.length) {
    toast('Медиатека пуста — сначала импортируйте видео', { type: 'error' });
    return 0;
  }
  let added = 0;
  for (const media of state.media) {
    state.clips.push({
      id: uid('c'),
      mediaId: media.id,
      name: media.name.replace(/\.[^.]+$/, ''),
      in: 0,
      out: media.duration > 0 ? media.duration : 5,
      transitionIn: 'none',
      volume: 1,
    });
    added++;
  }
  bus.emit(EV.CLIPS);
  if (added) toast(`На таймлайн добавлено клипов: ${added}`);
  return added;
}

function loadMedia(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted = true;
    probe.src = url;

    const fail = (msg) => {
      probe.removeAttribute('src');
      URL.revokeObjectURL(url);
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('таймаут чтения метаданных'), 15000);

    probe.addEventListener('error', () => {
      clearTimeout(timer);
      const code = probe.error?.code;
      const reason = describeVideoError(probe.error);
      fail(code === 4 ? `${reason}. ${CODEC_HINT}` : reason);
    });

    probe.addEventListener('loadedmetadata', async () => {
      clearTimeout(timer);
      let duration = probe.duration;
      if (!isFinite(duration)) {
        // Некоторые webm не отдают длительность сразу — ждём durationchange
        duration = await new Promise((res) => {
          const t = setTimeout(() => res(0), 2500);
          probe.addEventListener('durationchange', () => {
            if (isFinite(probe.duration)) {
              clearTimeout(t);
              res(probe.duration);
            }
          });
          probe.currentTime = 1e101; // частая уловка для webm
          setTimeout(() => {
            try { probe.currentTime = 0; } catch { /* ignore */ }
          }, 300);
        });
      }
      const item = {
        id: uid('m'),
        name: file.name,
        url,
        file,
        duration: isFinite(duration) && duration > 0 ? duration : 0,
        width: probe.videoWidth || 0,
        height: probe.videoHeight || 0,
        thumb: '',
      };
      item.thumb = await makeThumb(probe);
      probe.removeAttribute('src');
      resolve(item);
    });
  });
}

function makeThumb(video) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const target = Math.min(0.25, (isFinite(video.duration) ? video.duration : 1) * 0.1);
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      try {
        const c = document.createElement('canvas');
        const w = 160;
        const h = Math.max(1, Math.round((video.videoHeight || 90) * (w / (video.videoWidth || 160))));
        c.width = w; c.height = h;
        const cx = c.getContext('2d');
        cx.drawImage(video, 0, 0, w, h);
        done(c.toDataURL('image/jpeg', 0.65));
      } catch {
        done('');
      }
    };
    video.addEventListener('seeked', onSeeked);
    try { video.currentTime = target; } catch { done(''); }
    setTimeout(() => done(''), 5000);
  });
}

/** Создаёт клип из медиа (весь файл) и добавляет на таймлайн. */
export function makeClipFromMedia(mediaId, at = state.clips.length) {
  const media = state.media.find((m) => m.id === mediaId);
  if (!media) return null;
  const dur = media.duration > 0 ? media.duration : 5;
  return {
    id: uid('c'),
    mediaId,
    name: media.name.replace(/\.[^.]+$/, ''),
    in: 0,
    out: dur,
    transitionIn: 'none',
    volume: 1,
  };
}

export function selectMedia(id) {
  selectedMediaId = id;
  bus.emit(EV.MEDIA);
}

export function renderMediaList() {
  const list = document.getElementById('media-list');
  list.textContent = '';
  document.getElementById('media-count').textContent = String(state.media.length);

  /* журнал импорта — виден всегда, даже если медиатека пуста */
  for (const entry of importLog.slice(0, 4)) {
    const li = document.createElement('li');
    li.className = 'import-log-entry' + (entry.ok ? ' ok' : ' bad');
    li.title = entry.message;
    const mark = document.createElement('span');
    mark.className = 'import-log-mark';
    mark.textContent = entry.ok ? '✓' : '✕';
    const body = document.createElement('div');
    body.className = 'import-log-body';
    const name = document.createElement('div');
    name.className = 'import-log-name';
    name.textContent = entry.name;
    const msg = document.createElement('div');
    msg.className = 'import-log-msg';
    msg.textContent = entry.message;
    body.append(name, msg);
    li.append(mark, body);
    list.append(li);
  }

  if (!state.media.length) {
    const empty = document.createElement('li');
    empty.className = 'muted small';
    empty.style.padding = '4px 6px';
    empty.textContent = 'Медиатека пуста. Нет своего видео? Нажмите «Демо-клип».';
    list.append(empty);
    return;
  }

  for (const m of state.media) {
    const li = document.createElement('li');
    li.className = 'media-item' + (m.id === selectedMediaId ? ' selected' : '');
    li.title = `${m.name} — двойной клик, чтобы добавить на таймлайн`;

    const img = document.createElement('img');
    img.className = 'media-thumb';
    img.src = m.thumb;
    img.alt = '';
    if (!m.thumb) img.style.background = '#22262f';

    const meta = document.createElement('div');
    meta.className = 'media-meta';
    const name = document.createElement('div');
    name.className = 'media-name';
    name.textContent = m.name;
    const sub = document.createElement('div');
    sub.className = 'media-sub';
    sub.textContent = `${fmt(m.duration)}${m.width ? ` · ${m.width}×${m.height}` : ''}`;
    meta.append(name, sub);

    const add = document.createElement('button');
    add.className = 'media-add';
    add.title = 'Добавить на таймлайн';
    add.textContent = '＋';
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      import('./timeline.js').then((tl) => tl.appendMedia(m.id));
    });

    li.append(img, meta, add);
    li.addEventListener('click', () => selectMedia(m.id));
    li.addEventListener('dblclick', () => {
      import('./timeline.js').then((tl) => tl.appendMedia(m.id));
    });
    list.append(li);
  }
}

function fmt(sec) {
  if (!isFinite(sec) || sec <= 0) return 'длительность неизвестна';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Короткая длительность для журнала импорта. */
function fmtDur(sec) {
  if (!isFinite(sec) || sec <= 0) return 'длит. неизвестна';
  return `${sec.toFixed(1)} с`;
}
