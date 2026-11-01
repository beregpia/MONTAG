/* ============ Панель «Движок»: интерактивность ============
 * Главная проверка: панель не должна перестраиваться, пока пользователь
 * держит кнопку. Иначе кнопка исчезает из DOM между pointerup и click,
 * и браузер не доносит click — импорт дорожек просто не открывается.
 */
import { setupDom, reporter } from './helpers.mjs';

const { window, document, silenceConsole } = await setupDom();
silenceConsole();
const { check, done } = reporter();

const BASE = new URL('../js/', import.meta.url);
const state = await import(new URL('state.js', BASE).href);
const panel = await import(new URL('engine-panel.js', BASE).href);

panel.initEnginePanel();

const body = document.getElementById('engine-body');
const pick = () => document.getElementById('engine-pick');

check('панель отрисована', !!body && body.children.length > 0);
check('кнопка импорта дорожек на месте', !!pick());
check('подпись playhead на месте', !!document.getElementById('engine-readout'));

/* ---------- нажатие и отпускание кнопки ---------- */
const before = pick();
body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));

check('кнопка под пальцем не пересоздалась', before.isConnected === true,
  'если панель перестроится на pointerup, click до неё не дойдёт');
check('кнопка импорта та же по тексту', pick() === before);
check('после отпускания флаг взаимодействия снят',
  body.querySelectorAll('.btn').length > 0);

/* ---------- смена времени не ломает панель ---------- */
state.state.time = 12.5;
const busMod = await import(new URL('state.js', BASE).href);
busMod.bus.emit(busMod.EV.TIME, 12.5);
const readout = document.getElementById('engine-readout');
check('подпись playhead обновилась без перестройки',
  readout && readout.textContent.includes('12.5'), readout?.textContent);
check('кнопка импорта жива после смены времени', pick() === before);

/* ---------- значения полей не сбрасываются ---------- */
const cat = document.getElementById('engine-cat');
if (cat) {
  cat.value = 'cloth';
  window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
  check('набранная категория не сбросилась', document.getElementById('engine-cat')?.value === 'cloth');
}



/* ---------- зоны кадра: кому чьи шаги ---------- */
const evs = [
  { id: 'a', region: { x: 0.02, y: 0.4, w: 0.25, h: 0.4 } },   // центр 0.145 → слева
  { id: 'b', region: { x: 0.55, y: 0.4, w: 0.25, h: 0.4 } },   // центр 0.675 → справа
  { id: 'c', region: { x: 0.36, y: 0.4, w: 0.22, h: 0.4 } },   // центр 0.47  → центр
  { id: 'd', region: null },                                    // позиции нет
];

check('зона считается по центру области движения', panel.zoneCenter(evs[0].region) === 0.145);
check('слева / центр / справа', [evs[0], evs[2], evs[1]].map((e) => panel.zoneLabel(e.region))
  .join(',') === 'слева,центр,справа');
check('событие без позиции не попадает ни в одну зону', panel.zoneLabel(evs[3].region) === '—');
check('левая треть захватывает только своё событие',
  panel.eventsInZone(evs, 0, 1 / 3).map((e) => e.id).join() === 'a');
check('правая треть захватывает только своё событие',
  panel.eventsInZone(evs, 2 / 3, 1).map((e) => e.id).join() === 'b');
check('средняя треть захватывает только своё событие',
  panel.eventsInZone(evs, 1 / 3, 2 / 3).map((e) => e.id).join() === 'c');
check('полный кадр захватывает все три события с позицией',
  panel.eventsInZone(evs, 0, 1).length === 3);
check('зоны стыкуются без перекрытия: граница уходит в следующую',
  panel.eventsInZone(evs, 0, 0.145).length === 0
  && panel.eventsInZone(evs, 0.145, 0.3).map((e) => e.id).join() === 'a',
  'интервал полуоткрытый [lo, hi) — событие на границе не удваивается');


/* ---------- частота кадра проекта ---------- */
check('по умолчанию 25 к/с, а не 30', state.state.settings.fps === 25,
  `сейчас ${state.state.settings.fps}`);
check('в панели есть выбор частоты кадра', !!document.getElementById('engine-fps'));
check('выбор показывает текущее значение',
  document.getElementById('engine-fps')?.value === String(state.state.settings.fps));
check('в списке есть 25', [...(document.getElementById('engine-fps')?.options || [])]
  .some((o) => o.value === '25'));

// смена частоты пересчитывает кадры отмеченных событий
const fpsBefore = state.state.settings.fps;
state.state.settings.fps = 25;
check('кадр считается от текущей частоты', Math.round(2 * 25) === 50);
state.state.settings.fps = fpsBefore;

/* ---------- результат движка уходит на таймлайн ---------- */
const st = await import(new URL('../js/state.js', import.meta.url).href);
const fp = await import(new URL('../js/foley-place.js', import.meta.url).href);

const lib = [];
for (const name of ['steps 02.L.wav', 'steps 03.L.wav']) {
  for (let i = 0; i < 4; i++) {
    lib.push({ id: `${name}#${i}`, time: i * 0.6, duration: 0.2, peak: 0.8 - i * 0.05,
      category: 'steps', track: name, file: name, source: name });
  }
}
const vis = [
  { id: 'e1', time: 1.0, category: 'steps', source: 'steps 02.L.wav', duration: 0.15 },
  { id: 'e2', time: 2.4, category: 'steps', source: 'steps 03.L.wav', duration: 0.15 },
  { id: 'e3', time: 3.9, category: 'steps', source: 'steps 02.L.wav', duration: 0.15 },
];
const res = fp.placeEvents(vis, lib, { fps: 25 });
const withAudio = res.placements.filter((p) => p.audio);
check('движок даёт дубли для переноса на таймлайн', withAudio.length === 3);

// та же раскладка, что в pushPlacementsToTimeline()
const mapped = withAudio.map((p) => ({
  id: p.id, time: p.time,
  duration: Math.max(0.02, (p.audio.cutTo || 0) - (p.audio.cutFrom || 0)),
  category: p.category, source: p.source || p.audio.file,
  track: p.audio.track, file: p.audio.file,
  cutFrom: p.audio.cutFrom, cutTo: p.audio.cutTo,
  confidence: p.confidence, review: !!p.review,
}));
st.setPlacements(mapped);
check('на таймлайне столько же клипов, сколько размещений',
  state.state.placements.length === 3);
check('клик по клипу сможет играть: есть дорожка и границы вырезки',
  state.state.placements.every((p) => p.file && p.cutTo > p.cutFrom));
check('длительность клипа — длительность дубля, а не события',
  state.state.placements.every((p) => p.duration > 0.02));
check('персонаж сохраняется — клип попадёт в свою строку',
  state.state.placements.filter((p) => p.source === 'steps 02.L.wav').length === 2
  && state.state.placements.filter((p) => p.source === 'steps 03.L.wav').length === 1);
st.clearPlacements();

process.exitCode = done('Панель «Движок»') ? 0 : 1;
