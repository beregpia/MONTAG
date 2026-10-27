/* Интеграционный тест Foley-подсистемы: анализ, размещение, триггеры, экспорт маркеров. */
import { setupDom, reporter, SOURCE_STARTS, FakeAudioContext } from './helpers.mjs';

const { window, document } = await setupDom();
const { check, done } = reporter();

const BASE = new URL('../js/', import.meta.url);
const state = await import(new URL('state.js', BASE).href);
const foley = await import(new URL('foley.js', BASE).href);
const panel = await import(new URL('foley-panel.js', BASE).href);
const timeline = await import(new URL('timeline.js', BASE).href);
const { parseMarkerMidi } = await import(new URL('midi.js', BASE).href);

/* ---- синтетический звук с известными ударами ---- */
const SR = 48000;
function makeSignal(hits) {
  const len = SR * 6;
  const out = new Float32Array(len);
  for (const [t, type] of hits) {
    const start = Math.floor(t * SR);
    const n = Math.floor((type === 'low' ? 0.2 : 0.05) * SR);
    for (let i = 0; i < n && start + i < len; i++) {
      const env = Math.exp(-i / (0.02 * SR));
      out[start + i] += type === 'low'
        ? 0.9 * env * Math.sin((2 * Math.PI * 70 * i) / SR)
        : 0.7 * env * (Math.random() * 2 - 1);
    }
  }
  for (let i = 0; i < len; i++) out[i] += 0.002 * (Math.random() * 2 - 1);
  return out;
}

const HITS = [[0.6, 'low'], [1.4, 'high'], [2.2, 'low'], [3.9, 'high']];
const signal = makeSignal(HITS);

const fakeFile = { size: 5000, arrayBuffer: async () => new ArrayBuffer(16) };
FakeAudioContext.nextDecode = {
  numberOfChannels: 1,
  length: signal.length,
  sampleRate: SR,
  getChannelData: () => signal,
};

state.state.media.push(
  { id: 'm1', name: 'walk.mp4', url: 'blob:a', file: fakeFile, duration: 6, width: 640, height: 480, thumb: '' },
  { id: 'm2', name: 'hands.mp4', url: 'blob:b', file: fakeFile, duration: 6, width: 640, height: 480, thumb: '' },
);

/* ---- 1. анализ ---- */
const events = await foley.analyzeMedia('m1', { sensitivity: 1, minGap: 0.12 }, () => {});
check('анализ нашёл события', events.length >= 4, `найдено ${events.length}`);
const tol = 0.07;
check('все 4 удара найдены с точностью 70 мс',
  HITS.filter(([t]) => events.some((e) => Math.abs(e.time - t) < tol)).length === 4,
  events.map((e) => e.time.toFixed(2)).join(', '));
check('результат закеширован в state', state.state.foleyDetected.m1?.length === events.length);
check('события имеют диапазоны', events.every((e) => ['low', 'mid', 'high'].includes(e.band)));

/* ---- 2. перенос на таймлайн ---- */
state.state.clips.push({
  id: 'c1', mediaId: 'm1', name: 'walk', in: 1, out: 5, transitionIn: 'none', volume: 1,
});
const created = foley.applyDetected('m1', { autoAssign: true });
check('события размещены на таймлайне', created > 0, `создано ${created}`);
const first = state.state.foley[0];
const nearestDetected = state.state.foleyDetected.m1.find((d) => d.time > 1 && d.time < 2);
check('время скорректировано по in-точке клипа',
  Math.abs(first.time - (nearestDetected.time - 1)) < 1e-6, `time=${first.time}`);
check('время события внутри клипа', first.time >= 0 && first.time <= 4);
check('всем событиям назначен звук из библиотеки',
  state.state.foley.every((e) => typeof e.sfx === 'string' && e.sfx.length > 0));

const before = state.state.foley.length;
state.state.clips.push({ id: 'c2', mediaId: 'm2', name: 'hands', in: 0, out: 6, transitionIn: 'none', volume: 1 });
foley.applyDetected('m1', {});
check('повторный перенос не дублирует без изменений', state.state.foley.length === before + created);

/* ---- 3. CRUD ---- */
const ev0 = state.state.foley[0];
state.updateFoleyEvent(ev0.id, { sfx: 'thud', gain: 0.5 });
check('updateFoleyEvent применяется', state.state.foley[0].sfx === 'thud' && state.state.foley[0].gain === 0.5);
foley.nudgeEvent(ev0.id, 1 / 30);
check('nudgeEvent сдвигает на кадр', Math.abs(state.state.foley[0].offset - 1 / 30) < 1e-9);
const idToRemove = state.state.foley[1].id;
state.removeFoleyEvent(idToRemove);
check('removeFoleyEvent удаляет', !state.state.foley.some((e) => e.id === idToRemove));
state.clearFoley();
check('clearFoley очищает слой', state.state.foley.length === 0);
foley.applyDetected('m1', {});
check('после очистки слой наполняется заново', state.state.foley.length > 0);

/* ---- 4. триггеры ---- */
SOURCE_STARTS.length = 0;
state.state.playing = true;
const evA = state.state.foley[0];
const tA = evA.time + evA.offset;

foley.tick(tA - 0.02, tA - 0.01);
check('до события триггер не срабатывает', SOURCE_STARTS.length === 0);
foley.tick(tA - 0.005, tA + 0.005);
check('на событии триггер срабатывает', SOURCE_STARTS.length === 1);
const started = SOURCE_STARTS[0].started;
check('дрейф кадра компенсируется смещением в буфере',
  Math.abs(started.offset - 0.005) < 1e-6, `offset=${started.offset}`);

SOURCE_STARTS.length = 0;
foley.tick(tA + 0.001, tA + 2.0);
check('перескок (seek) не запускает звуки', SOURCE_STARTS.length === 0);
SOURCE_STARTS.length = 0;
foley.tick(tA + 0.01, tA + 0.02);
check('повторно событие не проигрывается', SOURCE_STARTS.length === 0);

foley.setFoleyGain(0.5);
check('setFoleyGain меняет общую громкость', state.state.foleyGain === 0.5);
foley.setFoleyGain(1);
state.state.playing = false;

/* ---- 5. панель и дорожка ---- */
panel.initFoleyPanel();
const body = document.getElementById('foley-body');
check('панель отрисована', body.children.length >= 5, `секций: ${body.children.length}`);
check('в панели есть строки событий', body.querySelectorAll('.foley-event').length === state.state.foley.length);
check('в панели есть библиотека звуков', body.querySelectorAll('.foley-lib-btn').length === 10);
check('у события есть ползунок громкости',
  body.querySelectorAll('.foley-event input[type=range]').length === state.state.foley.length);

timeline.initTimeline();
check('дорожка фоли показывает маркеры',
  document.querySelectorAll('#foley-track .foley-mark').length === state.state.foley.length);
document.querySelector('#foley-track .foley-mark')
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('клик по маркеру выбирает событие', state.state.selectedFoleyId === state.state.foley[0].id,
  `выбрано ${state.state.selectedFoleyId}`);

/* ---- 6. экспорт маркеров в MIDI ---- */
const downloads = [];
window.HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, download: this.download }); };
const blobs = [];
window.URL.createObjectURL = (b) => { blobs.push(b); return `blob:fake-${blobs.length}`; };

const exportBtn = [...body.querySelectorAll('button')].find((b) => b.textContent.includes('Экспорт маркеров'));
check('кнопка экспорта маркеров присутствует', !!exportBtn);
exportBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('инициировано скачивание .mid', downloads.length === 1 && /\.mid$/.test(downloads[0].download || ''), downloads[0]?.download);
const midiBlob = blobs[blobs.length - 1];
check('blob имеет MIDI-тип', midiBlob?.type === 'audio/midi', midiBlob?.type);
const parsed = parseMarkerMidi(new Uint8Array(await midiBlob.arrayBuffer()));
const detectedCount = state.state.foleyDetected.m1.length;
check('в .mid столько же маркеров, сколько найдено', parsed.markers.length === detectedCount, `${parsed.markers.length} vs ${detectedCount}`);
check('позиции маркеров совпадают с найденными (1 мс)',
  parsed.markers.every((m, i) => Math.abs(m.time - state.state.foleyDetected.m1[i].time) < 0.002),
  parsed.markers.map((m) => m.time.toFixed(2)).join(', '));
check('имена маркеров содержат диапазон (ASCII)',
  parsed.markers.every((m) => /low|mid|high/.test(m.name)), parsed.markers[0]?.name);

// экспорт размещённых событий + проверка учёта offset
const srcSelect = [...body.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'placed'));
srcSelect.value = 'placed';
srcSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
const nudged = state.state.foley[0];
foley.nudgeEvent(nudged.id, 1 / 30);
const exportBtn2 = [...body.querySelectorAll('button')].find((b) => b.textContent.includes('Экспорт маркеров'));
exportBtn2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const parsed2 = parseMarkerMidi(new Uint8Array(await blobs[blobs.length - 1].arrayBuffer()));
check('экспорт размещённых событий даёт маркеры фоли',
  parsed2.markers.length === state.state.foley.length, `${parsed2.markers.length} vs ${state.state.foley.length}`);
check('учтён сдвиг offset у размещённого события',
  parsed2.markers.some((m) => Math.abs(m.time - (nudged.time + (nudged.offset ?? 0))) < 0.002),
  parsed2.markers.map((m) => m.time.toFixed(3)).join(', '));

process.exitCode = done('Foley-подсистема') ? 0 : 1;
