/* ============ Тесты банка дорожек: вырезка дубля и волформа ============
 *
 * Инвариант: дубль играется из той же позиции дорожки, куда его ставит движок.
 * Если сдвинуть границы вырезки — слышно будет не то место, и вся расстановка
 * теряет смысл, поэтому границы проверяются в сэмплах.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers.mjs';

await setupDom();
const bank = await import(new URL('../js/audio-bank.js', import.meta.url).href);

/** Дорожка, у которой сэмпл с индексом i равен i — по копии видно, откуда рез. */
function ramp(seconds, sampleRate = 1000) {
  const data = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < data.length; i++) data[i] = i;
  return { data, sampleRate };
}

/** Заглушка AudioContext: запоминает, что в неё скормили. */
function fakeOut(created) {
  const ctx = {
    createBuffer(ch, len, sr) {
      const b = { _ch: ch, _len: len, _sr: sr, _data: null, copyToChannel(d) { this._data = d; } };
      created.push(b);
      return b;
    },
    createBufferSource() {
      const s = { buffer: null, connect() {}, start(when) { s._when = when; }, onended: null };
      created.push(s);
      return s;
    },
    createGain() {
      const g = { gain: { value: 1 }, connect() {}, disconnect() {} };
      created.push(g);
      return g;
    },
  };
  return { context: ctx };
}

test('банк хранит и отдаёт дорожку по имени', () => {
  bank.clearBank();
  const r = ramp(2);
  assert.equal(bank.putTrack('steps 02.L.wav', r), true);
  assert.equal(bank.hasTrack('steps 02.L.wav'), true);
  assert.equal(bank.getTrack('steps 02.L.wav').data.length, 2000);
  assert.equal(bank.trackDuration('steps 02.L.wav'), 2);
  assert.equal(bank.hasTrack('нет такой.wav'), false);
});

test('вырезка берёт сэмплы ровно из [from, to)', () => {
  bank.clearBank();
  bank.putTrack('a.wav', ramp(10));
  const made = [];
  assert.equal(bank.playCut('a.wav', 1.5, 2.25, 100, { ctx: fakeOut(made).context, out: fakeOut(made), gain: 1 }), true);
  const buf = made.find((m) => m._len !== undefined);
  assert.equal(buf._len, 750, 'длина вырезки = (to − from) · sampleRate');
  assert.equal(buf._data[0], 1500, 'первый сэмпл — ровно из позиции cutFrom');
  assert.equal(buf._data[749], 2249, 'последний сэмпл — перед cutTo');
});

test('границы вырезки зажимаются по концам дорожки', () => {
  bank.clearBank();
  bank.putTrack('a.wav', ramp(2));
  const made = [];
  bank.playCut('a.wav', -1, 99, 0, { ctx: fakeOut(made).context, out: fakeOut(made), gain: 1 });
  const buf = made.find((m) => m._len !== undefined);
  assert.equal(buf._len, 2000, 'вырезка не вылезает за дорожку');
});

test('несуществующая дорожка и пустой вырез не играют', () => {
  bank.clearBank();
  bank.putTrack('a.wav', ramp(2));
  assert.equal(bank.playCut('нет.wav', 0, 1, 0, { ctx: fakeOut([]).context, out: fakeOut([]), gain: 1 }), false);
  assert.equal(bank.playCut('a.wav', 1, 1, 0, { ctx: fakeOut([]).context, out: fakeOut([]), gain: 1 }), false, 'нулевая длина');
});

test('удаление и очистка банка', () => {
  bank.clearBank();
  bank.putTrack('a.wav', ramp(1));
  bank.putTrack('b.wav', ramp(1));
  assert.equal(bank.dropTrack('a.wav'), true);
  assert.equal(bank.hasTrack('a.wav'), false);
  assert.deepEqual(bank.bankNames(), ['b.wav']);
  bank.clearBank();
  assert.deepEqual(bank.bankNames(), []);
});

test('волформа: тихий участок ниже громкого в той же шкале', () => {
  bank.clearBank();
  const data = new Float32Array(1000);
  for (let i = 0; i < 500; i++) data[i] = 0.1;      // тихо
  for (let i = 500; i < 1000; i++) data[i] = 0.9;  // громко
  bank.putTrack('a.wav', { data, sampleRate: 1000 });
  const w = bank.waveform('a.wav', 10);
  assert.equal(w.length, 10);
  assert.equal(Math.max(...w), 1, 'самый громкий сегмент — в 1');
  assert.ok(w[0] < w[9], 'тихий участок ниже громкого');
  assert.ok(w[0] < 0.2, 'шкала общая на дорожку, а не на каждый отрезок');
});

test('волформа считает только запрошенный отрезок', () => {
  bank.clearBank();
  const data = new Float32Array(1000);
  for (let i = 0; i < 250; i++) data[i] = 1;
  for (let i = 250; i < 1000; i++) data[i] = 0.01;
  bank.putTrack('a.wav', { data, sampleRate: 1000 });
  const head = bank.waveform('a.wav', 4, 0, 0.25);
  assert.equal(Math.max(...head), 1, 'в начале дорожки громко');
  const tail = bank.waveform('a.wav', 4, 0.25, 1);
  assert.ok(Math.max(...tail) < 0.2, 'в конце дорожки тихо');
});

test('волформа чужой дорожки — null', () => {
  bank.clearBank();
  assert.equal(bank.waveform('нет.wav', 10), null);
});
