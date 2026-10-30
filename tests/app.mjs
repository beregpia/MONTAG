/* Интеграционный тест основного приложения (раскладка, таймлайн, инспектор, разделение). */
import { setupDom, reporter } from './helpers.mjs';

const { window, document } = await setupDom();
const { check, done } = reporter();

const BASE = new URL('../js/', import.meta.url);
const state = await import(new URL('state.js', BASE).href);
const media = await import(new URL('media.js', BASE).href);
const timeline = await import(new URL('timeline.js', BASE).href);
const inspector = await import(new URL('inspector.js', BASE).href);
const player = await import(new URL('player.js', BASE).href);
const project = await import(new URL('project.js', BASE).href);
const ui = await import(new URL('ui.js', BASE).href);

/* ---- 1. состояние и раскладка ---- */
state.state.media.push(
  { id: 'm1', name: 'a.mp4', url: 'blob:a', duration: 10, width: 640, height: 480, thumb: 'data:,' },
  { id: 'm2', name: 'b.mp4', url: 'blob:b', duration: 20, width: 1280, height: 720, thumb: 'data:,' },
);
check('медиа добавлено', state.state.media.length === 2);

const mk = (mediaId, inS, outS, transitionIn = 'none') => ({
  id: Math.random().toString(36).slice(2), mediaId, name: mediaId, in: inS, out: outS, transitionIn, volume: 1,
});
state.state.clips.push(mk('m1', 2, 6), mk('m2', 1, 5, 'crossfade'), mk('m1', 0, 3, 'fadeblack'));

const layout = state.computeLayout();
check('раскладка: 3 клипа', layout.length === 3);
check('первый клип start=0', Math.abs(layout[0].start) < 1e-9);
check('первый клип dur=4', Math.abs(layout[0].dur - 4) < 1e-9);
check('кроссфейд налезает на 0.5с', Math.abs(layout[1].start - 3.5) < 1e-9);
check('общая длительность', Math.abs(state.totalDuration() - 10.5) < 1e-9);
check('fadeblack без перекрытия', Math.abs(layout[2].start - 7.5) < 1e-9);

check('t=3.7 — два активных клипа (кроссфейд)', state.layoutAt(3.7).length === 2);
check('t=3.7 — primary = второй клип', state.primaryClipAt(3.7)?.mediaId === 'm2');
check('t=5 — кроссфейд закончился', state.layoutAt(5).length === 1);
check('t=8.5 — один активный', state.layoutAt(8.5).length === 1);

/* ---- 2. рендер таймлайна ---- */
timeline.initTimeline();
const track = document.getElementById('track');
check('на дорожке 3 клипа', track.querySelectorAll('.clip').length === 3);
check('ширина дорожки > 0', parseFloat(track.style.width) > 0);
check('плейхед позиционирован', document.getElementById('playhead').style.left !== '');
check('инфо-строка таймлайна', document.getElementById('timeline-info').textContent.includes('3'));

state.selectClip(layout[1].clip.id);
check('выделение клипа', document.querySelector('.clip.selected') !== null);

/* ---- 3. инспектор ---- */
inspector.initInspector();
const insp = document.getElementById('inspector-body');
check('инспектор показывает имя клипа', insp.querySelector('.insp-title')?.textContent === 'm2');
check('инспектор: 3 ползунка', insp.querySelectorAll('input[type=range]').length === 3);
check('инспектор: селект переходов', insp.querySelectorAll('select option').length === 3);

const select = insp.querySelector('select');
select.value = 'none';
select.dispatchEvent(new window.Event('change', { bubbles: true }));
check('переход изменён', state.getClip(layout[1].clip.id).transitionIn === 'none');
check('после смены перехода кроссфейд убран', Math.abs(state.computeLayout()[1].start - 4) < 1e-9);

/* ---- 4. разрезание ---- */
state.state.time = 2;
const totalBeforeSplit = state.totalDuration();
const res = player.splitAtPlayhead();
check('разделение выполнено', res.ok === true);
check('стало 4 клипа', state.state.clips.length === 4);
const l2 = state.computeLayout();
check('первая часть заканчивается на 2', Math.abs(l2[0].end - 2) < 1e-6);
check('вторая часть начинается на 2', Math.abs(l2[1].start - 2) < 1e-6);
check('у второй части нет перехода', state.state.clips[1].transitionIn === 'none');
check('суммарная длительность не изменилась', Math.abs(state.totalDuration() - totalBeforeSplit) < 1e-6);

state.state.time = 3.7;
check('разделение в окне кроссфейда', player.splitAtPlayhead().ok === true && state.state.clips.length === 5);
state.state.time = 100;
check('вне клипа разрезание не срабатывает', player.splitAtPlayhead().ok === false);

/* ---- 5. удаление ---- */
const before = state.state.clips.length;
state.selectClip(state.state.clips[0].id);
check('deleteSelected удаляет выбранный клип',
  timeline.deleteSelected() === true && state.state.clips.length === before - 1);
check('deleteSelected без выбора возвращает false', timeline.deleteSelected() === false);

/* ---- 6. проект ---- */
const saved = {
  app: 'montag', version: 1,
  settings: { ...state.state.settings },
  clips: [
    { mediaName: 'a.mp4', in: 0, out: 4, transitionIn: 'crossfade', volume: 0.5, name: 'A' },
    { mediaName: 'b.mp4', in: 1, out: 9, transitionIn: 'none', volume: 1, name: 'B' },
  ],
};
state.state.clips = [];
await project.openProjectFile({ text: async () => JSON.stringify(saved) });
check('проект загружен: 2 клипа', state.state.clips.length === 2);
check('клип привязан к медиа по имени', state.state.clips[0].mediaId === 'm1');
check('параметры восстановлены', state.state.clips[0].transitionIn === 'crossfade' && state.state.clips[0].volume === 0.5);
check('out ограничен длительностью', state.state.clips[1].out === 9);

/* ---- 7. утилиты и плеер ---- */
check('fmtTime', ui.fmtTime(75.4) === '01:15.4' && ui.fmtTime(0) === '00:00.0');
player.initPlayer(document.getElementById('canvas'));
player.seek(0);
player.seek(1.2);
check('seek работает', Math.abs(state.state.time - 1.2) < 1e-9);
check('пауза по умолчанию', player.isPlaying() === false);

/* ---- 8. шина событий ---- */
let fired = 0;
state.bus.on('test-evt', () => fired++);
state.bus.emit('test-evt');
check('шина событий', fired === 1);

process.exitCode = done('Приложение') ? 0 : 1;
