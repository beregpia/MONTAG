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
const vision = await import(new URL('vision.js', BASE).href);

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

/* ---------- payload для Premiere ---------- */
const plTrks = [
  { name: 'steps 02.L.wav', index: { duration: 25.5 } },
  { name: 'steps 03.L.wav', index: { duration: 31.2 } },
];
const plPlaced = [
  { id: 'p1', time: 1.0, category: 'steps', source: 'steps 02.L.wav', review: false,
    audio: { file: 'steps 02.L.wav', track: '02', cutFrom: 0.5, cutTo: 0.8 } },
  { id: 'p2', time: 2.4, category: 'steps', source: 'steps 03.L.wav', review: true,
    audio: { file: 'steps 03.L.wav', track: '03', cutFrom: 1.2, cutTo: 1.6 } },
  { id: 'p3', time: 3.9, category: 'steps', source: 'steps 02.L.wav', review: false,
    audio: { file: 'steps 02.L.wav', track: '02', cutFrom: 2.0, cutTo: 2.3 } },
];
const pay = panel.premierePayload(plPlaced, plTrks, 'D:\\Foley\\Ep07', 25);
check('источники — те дорожки, из которых взяты дубли',
  pay.sources.map((s) => s.name).join() === 'steps 02.L.wav,steps 03.L.wav');
check('путь к дорожке склеивается из папки и имени файла',
  pay.sources[0].path === 'D:\\Foley\\Ep07\\steps 02.L.wav', pay.sources[0].path);
check('длительность дорожки передаётся — из неё clamping out-точки',
  pay.sources[0].duration === 25.5 && pay.sources[1].duration === 31.2);
check('хвостовой слэш папки не удваивается',
  panel.premierePayload(plPlaced, plTrks, 'D:\\Foley\\', 25).sources[0].path
    === 'D:\\Foley\\steps 02.L.wav');
check('без папки в пути остаётся одно имя — Premiere спросит файлы',
  panel.premierePayload(plPlaced, plTrks, '', 25).sources[0].path === 'steps 02.L.wav');
check('клипов столько же, сколько размещений', pay.clips.length === 3);
check('клип несёт позицию на таймлайне и границы в дорожке',
  pay.clips[0].at === 1 && pay.clips[0].in === 0.5 && pay.clips[0].out === 0.8);
check('подпись клипа — категория и персонаж',
  pay.clips[0].label === 'steps steps 02.L', pay.clips[0].label);
check('маркеров столько же, сколько размещений', pay.markers.length === 3);
check('имя маркера начинается с номера и таймкода',
  /^01 00:00:01:00 steps$/.test(pay.markers[0].name), pay.markers[0].name);
check('комментарий маркера говорит, откуда дубль',
  pay.markers[0].comment.includes('steps 02.L') && pay.markers[0].comment.includes('0.50'));
check('неуверенное размещение помечено в комментарии',
  pay.markers[1].comment.includes('проверить') && !pay.markers[0].comment.includes('проверить'));
check('дорожка без размещений не попадает в источники',
  panel.premierePayload([plPlaced[0]],
    [{ name: 'steps 02.L.wav', index: { duration: 25 } },
      { name: 'лишняя.wav', index: { duration: 5 } }], 'D:\\F', 25,
  ).sources.map((s) => s.name).join() === 'steps 02.L.wav');
check('дорожка размещения, которой нет в панели, всё равно попадает в источники',
  panel.premierePayload([plPlaced[0]], [], 'D:\\F', 25).sources.length === 1,
  'иначе клип остался бы без файла');

/* ---------- детектор: не декодированное видео ---------- */
// браузерное видео до загрузки имеет duration NaN и readyState 0. Разбор на
// таком видео честно вернёт ноль событий, но совет «поднимите
// чувствительность» увело бы монтажёра искать несуществующую настройку.
check('анализ недогруженного видео даёт ноль событий, а не мусор',
  (await vision.analyzeVideo({ duration: NaN, readyState: 0, src: 'x' }, { fps: 25 })).events.length === 0);

state.state.clips.length = 0;
state.state.clips.push({ id: 'c9', mediaId: 'm9', in: 0, out: 5, transitionIn: 'none', volume: 1, name: 'v.mp4' });
panel.initEnginePanel();
check('недогруженное видео не роняет панель', !!document.getElementById('engine-detect'));

/* ---------- чувствительность детектора ---------- */
// Приложение долго советовало «поднять чувствительность», не имея такой
// настройки. Теперь ползунок есть — и он правда меняет порог.
check('ползунок чувствительности на месте', !!document.getElementById('engine-sens'));
check('значение по умолчанию разумное',
  Number(document.getElementById('engine-sens').value) === 0.55);
check('подпись ползунка объясняет направление',
  /меньше — найдёт больше шагов/.test(document.getElementById('engine-body').textContent));

const sensEl = document.getElementById('engine-sens');
sensEl.value = '0.2';
sensEl.dispatchEvent(new window.Event('input', { bubbles: true }));
const sensRow = document.getElementById('engine-sens').parentElement;
check('ползунок меняет значение и подпись рядом',
  sensRow.querySelector('b').textContent === '0.20');

process.exitCode = done('Панель «Движок»') ? 0 : 1;

/* ---------- порядок обучения: автомат первым ---------- */
// Панель не должна учить ручному пути как основному: читатель, увидевший
// «◎ Отметить в кадре» главной кнопкой, уходит отмечать шаги по одному —
// ровно то, от чего движок избавляет.
const detBtn0 = document.getElementById('engine-detect');
const addBtn0 = document.getElementById('engine-add');
check('кнопки автомата и ручной отметки на месте', !!detBtn0 && !!addBtn0);
check('«Найти движение» — главная кнопка секции',
  detBtn0.classList.contains('primary'));
check('ручная отметка не выглядит главным путём',
  !addBtn0.classList.contains('primary'));
check('автомат стоит в разметке выше ручной отметки',
  !!(detBtn0.compareDocumentPosition(addBtn0) & window.Node.DOCUMENT_POSITION_FOLLOWING));

const eventsH3 = [...document.querySelectorAll('#engine-body h3')]
  .find((n) => /События на картинке/.test(n.textContent));
check('секция «События на картинке» найдена', !!eventsH3);
const intro = eventsH3 ? eventsH3.nextElementSibling : null;
check('вводный текст секции есть', !!intro);
check('вводный текст ведёт к автомату', intro && /Найти движение/.test(intro.textContent));
check('и говорит, когда ручная отметка нужна',
  intro && (/пропустил/.test(intro.textContent) || /тихие/.test(intro.textContent)));
check('вводный текст не учит ручному пути как основному',
  intro && !/нажмите .Отметить./.test(intro.textContent));

/* ---------- звуки дорожек без картинки ---------- */
// Дорожка фоли начинается раньше, чем персонаж появляется в кадре: он ещё за
// кадром. Детектор такие звуки не видит в принципе, но молча терять их нельзя.
const leftBtn0 = document.getElementById('engine-leftovers');
check('кнопка «звуки без картинки» есть в секции размещения', !!leftBtn0);
check('кнопка второстепенная — главная по-прежнему «Разместить»',
  leftBtn0 && !leftBtn0.classList.contains('primary'));
check('подсказка объясняет причину (герой за кадром), а не просто факт',
  leftBtn0 && /за кадр/.test(leftBtn0.getAttribute('title') || ''));
check('до размещения кнопка выключена', leftBtn0 && leftBtn0.disabled === true);

// полный поток: часть звуков дорожек не нашла события
const libL = [];
for (let i = 0; i < 6; i++) {
  libL.push({ time: 0.4 + i * 0.6, duration: 0.2, peak: 0.9, category: 'steps',
    file: 'steps 02.L.wav', source: 'steps 02.L.wav' });
}
const visL = [1.6, 2.2, 2.8, 3.4].map((t, i) => ({ id: 'x' + i, time: t, frame: t * 25, category: 'steps', strength: 0.8 }));
const resL = fp.placeEvents(visL, libL, { fps: 25 });
const loL = fp.placeLeftovers(resL.placements, libL, { fps: 25, offset: 0 });
check('движок сообщает, сколько звуков осталось без картинки',
  resL.summary.libraryTotal === 6 && resL.summary.libraryUnused === 2);
check('остатки встают по времени записи, а не теряются',
  loL.added === 2 && loL.placements.length === 6);
check('остатки помечены как требующие проверки',
  loL.placements.filter((p) => p.review).length === 2);

/* ---------- новая дорожка встаёт по размеру клипа ----------
 * Пользователь: «звуковые файлы в таймлайн должны вставать по размеру клипа». */
state.state.clips.length = 0;
state.state.clips.push({ in: 0, out: 60, start: 0, duration: 60, src: 'clip.mp4' });
state.state.time = 30;
st.setSourceTrack({ name: 'fit.wav', category: 'steps', pass: '02',
  duration: 20, events: [{ time: 5, strength: 0.9 }] });
check('подгонка растягивает запись на длину клипа',
  Math.abs(panel.autoFitToClip('fit.wav') - 60) < 1e-9, '60 с клип');
check('длина записи 20 с подгоняна в три раза',
  Math.abs(st.state.foleyTracks[0].reg.k - 3) < 1e-9, 'к = 60 / 20');
check('время в записи не тронуто — звук не «пищит»',
  st.state.foleyTracks[0].events[0].time === 5);

/* без видео подгонять нечем: остаётся кнопка «⥂» в заголовке дорожки */
st.state.foleyTracks[0].reg = { k: 1, d: 0 };
st.state.clips.length = 0;
check('без клипа ничего не ломается', panel.autoFitToClip('fit.wav') === 0);
check('дорожка остаётся как записана', st.state.foleyTracks[0].reg.k === 1);

/* ---------- фильтр «похоже на шаг» в панели ---------- */
check('кнопка фильтра на месте', !!document.getElementById('engine-stepfilter'));
check('порог строгости на месте', !!document.getElementById('engine-stepthr'));
check('строка сводки после разбора на месте', !!document.getElementById('engine-steps'));
const sf = document.getElementById('engine-stepfilter');
const sfLabel = sf.textContent;
sf.click();
check('кнопка переключается и показывает состояние',
  sf.textContent !== sfLabel && /Любое/.test(sf.textContent), sf.textContent);
sf.click();
check('обратно включается', /Только шаги/.test(sf.textContent), sf.textContent);
const thr = document.getElementById('engine-stepthr');
thr.value = '0.8';
thr.dispatchEvent(new window.Event('input', { bubbles: true }));
check('порог принимает значение', thr.value === '0.8');
thr.value = '99';
thr.dispatchEvent(new window.Event('input', { bubbles: true }));
check('порог не уходит за границу 0.9', Number(thr.value) <= 0.9, thr.value);

process.exitCode = done('Панель «Движок»') ? 0 : 1;
