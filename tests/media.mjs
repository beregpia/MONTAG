/* Тест импорта медиа: фильтр форматов, журнал, ошибки кодеков, добавление на таймлайн. */
import { setupDom, reporter, appConsole } from './helpers.mjs';

const { window, document, silenceConsole } = await setupDom({ videoError: 4 });
silenceConsole();
const { check, done } = reporter();

const BASE = new URL('../js/', import.meta.url);
const state = await import(new URL('state.js', BASE).href);
const media = await import(new URL('media.js', BASE).href);
const demo = await import(new URL('demo.js', BASE).href);

/* ---------- сценарий демо ---------- */
const script = demo.demoScript();
check('демо: длительность 8 с', script.duration === 8);
check('демо: шаги каждую секунду', script.steps.length === 7, `шагов ${script.steps.length}`);
check('демо: шаги чередуются сильный/слабый',
  script.steps.every((s, i) => s.strong === (i % 2 === 0)), script.steps.map((s) => (s.strong ? 'S' : 's')).join(''));
check('демо: есть щелчки', script.clicks.length === 3);
check('демо: все события внутри длительности',
  [...script.steps.map((s) => s.time), ...script.clicks.map((c) => c.time)].every((t) => t > 0 && t < script.duration));

/* ---------- маппинг ошибок видео ---------- */
check('ошибка 4 = кодек', media.describeVideoError({ code: 4 }).includes('кодек'));
check('ошибка 3 = декодирование', media.describeVideoError({ code: 3 }).includes('декодирования'));
check('неизвестная ошибка обрабатывается', media.describeVideoError({}) === 'неизвестная ошибка');
check('подсказка о кодекках упоминает mp4/webm', /mp4/.test(media.CODEC_HINT) && /webm/.test(media.CODEC_HINT));

/* ---------- фильтр форматов ---------- */
const res1 = await media.importFiles([
  { name: 'photo.jpg', type: 'image/jpeg' },
  { name: 'notes.txt', type: 'text/plain' },
]);
check('не-видео файлы отклоняются', res1.length === 0);
check('журнал фиксирует отказ', media.importLog[0].ok === false && media.importLog[0].message.includes('не видеофайлы'));

/* ---------- ошибка кодека ---------- */
appConsole.error.length = 0;
const res2 = await media.importFiles([{ name: 'scene.mkv', type: 'video/x-matroska' }]);
check('неподдерживаемый файл даёт 0 элементов', res2.length === 0);
check('ошибка пишется в консоль, а не только в тост', appConsole.error.length === 1, appConsole.error[0]?.slice(0, 50));
check('журнал фиксирует ошибку кодека',
  media.importLog[0].name === 'scene.mkv' && media.importLog[0].ok === false && /кодек/.test(media.importLog[0].message),
  media.importLog[0].message.slice(0, 60));
check('сообщение об ошибке содержит подсказку о конвертации', /HandBrake|ffmpeg/.test(media.importLog[0].message));

/* ---------- рендер журнала ---------- */
media.renderMediaList();
check('журнал отрисован в панели', document.querySelectorAll('#media-list .import-log-entry').length >= 2);
check('неудачная запись помечена классом bad',
  document.querySelector('#media-list .import-log-entry.bad') !== null);
check('медиатека пуста — подсказка про демо',
  document.getElementById('media-list').textContent.includes('Демо-клип'));

/* ---------- добавление всех на таймлайн ---------- */
state.state.media.push(
  { id: 'm1', name: 'a.mp4', url: 'blob:a', duration: 4, width: 640, height: 360, thumb: '' },
  { id: 'm2', name: 'b.webm', url: 'blob:b', duration: 6, width: 1280, height: 720, thumb: '' },
);
const added = media.appendAllToTimeline();
check('добавлены оба клипа', added === 2 && state.state.clips.length === 2);
check('длительность клипа = длительности файла',
  state.state.clips[0].out === 4 && state.state.clips[1].out === 6);
check('имена клипов без расширения',
  state.state.clips[0].name === 'a' && state.state.clips[1].name === 'b');
state.state.media = [];
check('пустая медиатека не ломает кнопку', media.appendAllToTimeline() === 0);

/* ---------- клип из медиа ---------- */
state.state.media.push({ id: 'm3', name: 'c.mp4', url: 'blob:c', duration: 9, width: 100, height: 100, thumb: '' });
const clip = media.makeClipFromMedia('m3');
check('makeClipFromMedia берёт весь файл', clip && clip.out === 9 && clip.in === 0 && clip.mediaId === 'm3');

process.exitCode = done('Импорт и медиатека') ? 0 : 1;
