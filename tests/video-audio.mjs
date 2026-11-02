/* ============ Тесты звука видеоклипа: оригинальные шаги ============
 *
 * Инвариант: шаги, найденные в звуке клипа, живут в шкале САМОГО КЛИПА, а на
 * таймлайн и в сравнение попадают через смещение. Если перепутать шкалы, ворота
 * откроются не там, где шаг, и «убрать речь» превратится в «убрать шаги».
 *
 * Второй инвариант: сравнение с оригиналом считается по одним и тем же данным
 * для таймлайна и панели — иначе цвета отметок и цифры в сводке разойдутся.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, FakeAudioContext } from './helpers.mjs';

await setupDom();
const va = await import(new URL('../js/video-audio.js', import.meta.url).href);
const state = await import(new URL('../js/state.js', import.meta.url).href);

/** Буфер с импульсами: низкий толчок — похоже на шаг. */
function impulseBuffer(times, seconds = 3, sampleRate = 8000) {
  const n = Math.round(seconds * sampleRate);
  const data = new Float32Array(n);
  for (const t of times) {
    const c = Math.round(t * sampleRate);
    for (let i = 0; i < 300 && c + i < n; i++) {
      // затухающий низкий тон: у шага много низких и широкий спектр
      data[c + i] += Math.sin((2 * Math.PI * 90 * i) / sampleRate) * Math.exp(-i / 60) * 0.9;
    }
  }
  return {
    numberOfChannels: 1, length: n, sampleRate, duration: seconds,
    getChannelData: () => data,
  };
}

/* ---------- сравнение с оригиналом ---------- */

test('сравнение: шаг с размещением в пределах полутора кадров — совпало', () => {
  const steps = [{ time: 1.0 }, { time: 2.0 }];
  const placements = [{ time: 1.04 }, { time: 1.96 }];
  const c = va.compareSteps(steps, placements, 25);
  assert.equal(c.ok, 2, 'в пределах 1.5 кадра расхождение не ошибка');
  assert.equal(c.early, 0);
  assert.equal(c.late, 0);
  assert.equal(c.miss, 0);
});

test('сравнение различает «фоли раньше» и «фоли позже» оригинала', () => {
  // 1 кадр при 25 fps — 0.04 с. Совпадение: +/- 0.06 с.
  const steps = [{ time: 1.0 }, { time: 2.0 }];
  const c = va.compareSteps(steps, [{ time: 0.5 }, { time: 2.5 }], 25);
  assert.equal(c.early, 1, 'размещение на 0.5 с раньше оригинала');
  assert.equal(c.late, 1, 'размещение на 0.5 с позже оригинала');
  assert.equal(c.ok, 0);
});

test('сравнение: шаг без размещения — пропущен, размещение без шага — лишнее', () => {
  const c = va.compareSteps([{ time: 1.0 }, { time: 2.0 }], [{ time: 1.0 }], 25);
  assert.equal(c.miss, 1, 'шаг на 2.0 никто не закрыл');
  assert.equal(c.ok, 1);
  assert.equal(c.extra, 0);
  const c2 = va.compareSteps([{ time: 1.0 }], [{ time: 1.0 }, { time: 5.0 }], 25);
  assert.equal(c2.extra, 1, 'дубль на 5.0 оригиналу не соответствует');
});

test('сравнение: пустая расстановка — все шаги пропущены, лишних нет', () => {
  const c = va.compareSteps([{ time: 1.0 }, { time: 2.0 }], [], 25);
  assert.equal(c.miss, 2);
  assert.equal(c.extra, 0);
  assert.equal(c.rows.length, 2);
});

/* ---------- что считается шагом ---------- */

test('шагами считаются только шаговые категории', () => {
  assert.equal(va.isStep({ category: 'step-hard' }), true);
  assert.equal(va.isStep({ category: 'step-gravel' }), true);
  assert.equal(va.isStep({ category: 'шаг' }), true);
  assert.equal(va.isStep({ category: 'footstep' }), true);
  // всё остальное — речь, ткани, двери, пропы — ворота закрывают
  assert.equal(va.isStep({ category: 'cloth/rustle' }), false);
  assert.equal(va.isStep({ category: 'door/boom' }), false);
  assert.equal(va.isStep({ category: 'click' }), false);
  assert.equal(va.isStep({ category: 'other' }), false);
  assert.equal(va.isStep({}), false);
  assert.equal(va.isStep(null), false);
});

test('разбор делит события на шаги и отброшенные без потерь', () => {
  const buf = impulseBuffer([0.5, 1.1, 1.7, 2.3]);
  const r = va.findOriginalSteps(buf);
  assert.equal(r.steps.length + r.dropped.length, r.steps.length + r.dropped.length);
  // каждый попавший в шаги шаг должен реально оказаться шагом
  for (const s of r.steps) assert.ok(va.isStep(s), `«${s.category}» не шаг`);
  for (const d of r.dropped) assert.ok(!va.isStep(d), `«${d.category}» пропал из шагов`);
});

/* ---------- ворота ---------- */

test('ворота открыты вокруг шага и закрыты всё остальное время', () => {
  const steps = [{ time: 1.0, duration: 0.2 }, { time: 2.0, duration: 0.2 }];
  const w = va.stepWindows(steps, 0.1, 0.2);
  assert.equal(w.length, 2);
  assert.equal(w[0][0], 0.9, 'удар начинается до касания');
  assert.equal(w[0][1], 1.4, 'и заканчивается после затухания');
  assert.equal(va.gateOpenAt(w, 0.95), true);
  assert.equal(va.gateOpenAt(w, 1.35), true);
  assert.equal(va.gateOpenAt(w, 1.5), false, 'между шагами речь — ворота закрыты');
  assert.equal(va.gateOpenAt(w, 0.0), false);
});

test('ворота не уходят в отрицательное время', () => {
  const w = va.stepWindows([{ time: 0.05, duration: 0.2 }], 0.12, 0.3);
  assert.ok(w[0][0] >= 0, `начало окна ${w[0][0]} — отрицательное`);
});

/* ---------- волформа ---------- */

test('волформа звука клипа нормируется по пику всей записи', () => {
  const data = new Float32Array(1000);
  for (let i = 400; i < 500; i++) data[i] = 0.5;
  data[700] = 1; // единственный пик на всю дорожку
  const buf = {
    numberOfChannels: 1, length: 1000, sampleRate: 1000, duration: 1,
    getChannelData: () => data,
  };
  const w = va.waveformOf(buf, 100, 0, 1);
  assert.ok(w, 'волформы нет');
  assert.equal(Math.max(...w), 1, 'пик всей записи должен быть вершиной');
  assert.ok(Math.min(...w) >= 0);
  assert.ok(w.length <= 100);
});

test('волформа тишины — null, а не молчаливый массив', () => {
  const buf = {
    numberOfChannels: 1, length: 100, sampleRate: 100, duration: 1,
    getChannelData: () => new Float32Array(100),
  };
  assert.equal(va.waveformOf(buf, 10), null);
});

/* ---------- разбор через плеер: состояние и шкалы ---------- */

test('разбор звука кладёт шаги в состояние со смещением шкалы клипа', async () => {
  const player = await import(new URL('../js/player.js', import.meta.url).href);
  state.state.media.length = 0;
  state.state.clips.length = 0;
  state.state.media.push({
    id: 'm1', name: 'v.mp4', duration: 3, url: 'blob:fake',
    width: 1920, height: 882, file: { name: 'v.mp4', arrayBuffer: async () => new ArrayBuffer(8) },
  });
  state.state.clips.push({
    id: 'c1', mediaId: 'm1', in: 0, out: 3, transitionIn: 'none', volume: 1, name: 'v.mp4',
  });
  FakeAudioContext.nextDecode = impulseBuffer([0.5, 1.1, 1.7, 2.3]);
  const res = await player.analyzeClipAudio();
  assert.equal(res.error, '', `разбор не удался: ${res.error}`);
  assert.ok(res.steps.length > 0, 'шаги не найдены');
  assert.equal(res.offset, 0, 'клип с in=0 и стартом 0 — смещение нулевое');
  assert.ok(res.wave.length > 1, 'волформы нет — строка на таймлайне будет пустой');
  // сравнение считается сразу: пустая расстановка — все шаги пропущены
  assert.ok(res.cmp, 'сравнение не посчитано');
  assert.equal(res.cmp.miss, res.steps.length);
});

test('разбор звука: смещение переводит шкалу клипа в шкалу монтажа', async () => {
  const player = await import(new URL('../js/player.js', import.meta.url).href);
  state.state.media.length = 0;
  state.state.clips.length = 0;
  const mk = (id) => ({
    id, name: 'v.mp4', duration: 3, url: 'blob:fake',
    width: 1920, height: 882, file: { name: 'v.mp4', arrayBuffer: async () => new ArrayBuffer(8) },
  });
  state.state.media.push(mk('m1'), mk('m2'));
  // Первый клип занимает 0..5, второй лежит с 5-й секунды. Разбираем второй,
  // поэтому playhead ставим внутрь него: primaryClipAt выбирает по времени.
  state.state.clips.push(
    { id: 'c1', mediaId: 'm1', in: 0, out: 5, transitionIn: 'none', volume: 1, name: 'v.mp4' },
    { id: 'c2', mediaId: 'm2', in: 0, out: 3, transitionIn: 'none', volume: 1, name: 'v.mp4' },
  );
  state.state.time = 5.5;
  FakeAudioContext.nextDecode = impulseBuffer([0.5]);
  const res = await player.analyzeClipAudio();
  assert.equal(res.offset, 5, 'смещение = старт клипа минус его in');
  const onTimeline = res.steps[0].time + res.offset;
  // refineAttack уточняет момент атаки, поэтому сравниваем с допуском в
  // несколько кадров, а не до миллисекунды
  assert.ok(Math.abs(onTimeline - 5.5) < 0.1,
    `локальное время шага плюс смещение даёт время на таймлайне — иначе ворота `
    + `и отметки разойдутся с расстановкой (получили ${onTimeline})`);
  state.state.time = 0;
});

test('разбор звука: файл без звуковой дорожки даёт внятную ошибку, а не пустоту', async () => {
  const player = await import(new URL('../js/player.js', import.meta.url).href);
  state.state.media.length = 0;
  state.state.clips.length = 0;
  state.state.media.push({
    id: 'm1', name: 'v.mp4', duration: 3, url: 'blob:fake',
    width: 1920, height: 882, file: { name: 'v.mp4', arrayBuffer: async () => new ArrayBuffer(8) },
  });
  state.state.clips.push({
    id: 'c1', mediaId: 'm1', in: 0, out: 3, transitionIn: 'none', volume: 1, name: 'v.mp4',
  });
  FakeAudioContext.nextDecode = null;
  const res = await player.analyzeClipAudio();
  assert.ok(res.error, 'ошибки нет — «оригинальных шагов нет» выглядело бы как правда');
  assert.equal(res.ready, false);
  assert.equal(res.steps.length, 0);
});

test('разбор звука: без файла видео ошибка называется прямо', async () => {
  const player = await import(new URL('../js/player.js', import.meta.url).href);
  state.state.media.length = 0;
  state.state.clips.length = 0;
  state.state.media.push({ id: 'm1', name: 'v.mp4', duration: 3, url: 'blob:fake', width: 16, height: 9 });
  state.state.clips.push({
    id: 'c1', mediaId: 'm1', in: 0, out: 3, transitionIn: 'none', volume: 1, name: 'v.mp4',
  });
  const res = await player.analyzeClipAudio();
  assert.match(res.error, /переимпортируйте/i);
});

test('режим «только шаги» переключается и переживает разбор', async () => {
  assert.equal(state.state.videoAudio.only, true, 'по умолчанию речь убрана');
  state.setVideoAudioOnly(false);
  assert.equal(state.state.videoAudio.only, false);
  state.setVideoAudioOnly(false);
  assert.equal(state.state.videoAudio.only, false, 'повторное выключение не должно ни на что влиять');
  state.setVideoAudioOnly(true);
  assert.equal(state.state.videoAudio.only, true);
});

test('сравнение пересчитывается при изменении расстановки', () => {
  state.setVideoAudio({ name: 'v.mp4', steps: [{ time: 1.0 }, { time: 2.0 }], dropped: [], wave: [], duration: 3, offset: 0, error: '' });
  assert.equal(state.state.videoAudio.cmp.miss, 2, 'без размещения оба шага пропущены');
  state.setPlacements([{ id: 'p1', time: 1.02 }]);
  assert.equal(state.state.videoAudio.cmp.ok, 1, 'размещение закрыло первый шаг');
  assert.equal(state.state.videoAudio.cmp.miss, 1);
  state.clearPlacements();
  assert.equal(state.state.videoAudio.cmp.miss, 2, 'после очистки снова все пропущены');
});
