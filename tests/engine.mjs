/* ============ Тесты движка расстановки (браузерные модули) ============ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexTrack, splitTrackName, gapFor, refineAttack, classifyEvent } from '../js/foley-library.js';
import { placeEvents, profileOf, PROFILES } from '../js/foley-place.js';
import { readWav, toMono } from '../tools/lib/wav.mjs';

/* ---------- утилита: сделать синтетический шаг ---------- */
function stepAt(buf, sampleRate, t, { freq = 62, dur = 0.22, amp = 0.8, noise = 0.9 } = {}) {
  const start = Math.round(t * sampleRate);
  const n = Math.round(dur * sampleRate);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= buf.length) continue;
    const tt = i / sampleRate;
    const env = Math.exp(-tt / 0.05) * (1 - Math.exp(-tt / 0.0012));
    ph += (2 * Math.PI * freq * (1 - 0.4 * (tt / dur))) / sampleRate;
    buf[idx] += amp * env * (Math.sin(ph) + noise * (Math.random() * 2 - 1));
  }
}
function pass(sampleRate, times, opts) {
  const buf = new Float32Array(sampleRate * 30);
  for (const t of times) stepAt(buf, sampleRate, t, opts);
  return buf;
}

/* ---------- имена дорожек ---------- */
test('splitTrackName: «steps 02» → категория steps, проход 02', () => {
  assert.deepEqual(splitTrackName('steps 02'), { category: 'steps', pass: '02' });
  assert.deepEqual(splitTrackName('HEANDS 3'), { category: 'HEANDS', pass: '3' });
  assert.deepEqual(splitTrackName('CLOTH 1'), { category: 'CLOTH', pass: '1' });
  assert.deepEqual(splitTrackName('steps'), { category: 'steps', pass: '' });
  assert.deepEqual(splitTrackName('requisite-4'), { category: 'requisite', pass: '4' });
});

test('splitTrackName: не отрезает число от слова без пробела', () => {
  assert.deepEqual(splitTrackName('step2'), { category: 'step2', pass: '' });
});

test('gapFor: порог сегментации по смыслу имени', () => {
  assert.equal(gapFor('steps 02'), 0.3);
  assert.equal(gapFor('HEANDS 3'), 0.12);
  assert.equal(gapFor('CLOTH 1'), 0.2);
  assert.equal(gapFor('Door'), 0.3);
  assert.equal(gapFor('что-то новое'), 0.15);
});

/* ---------- индексация ---------- */
test('indexTrack: находит все шаги прохода', () => {
  const SR = 44100;
  const times = [1, 1.62, 2.24, 2.86, 3.48, 4.1, 4.72, 5.34];
  const idx = indexTrack(pass(SR, times), SR, { category: 'steps', pass: '02', minGap: 0.3 });
  assert.equal(idx.events.length, times.length, `найдено ${idx.events.length} из ${times.length}`);
  assert.equal(idx.category, 'steps');
  assert.equal(idx.pass, '02');
});

test('indexTrack: id уникален и содержит проход', () => {
  const SR = 44100;
  const a = indexTrack(pass(SR, [1, 2, 3, 4]), SR, { category: 'steps', pass: '01', minGap: 0.3 });
  const b = indexTrack(pass(SR, [1, 2, 3, 4]), SR, { category: 'steps', pass: '02', minGap: 0.3 });
  const ids = new Set([...a.events, ...b.events].map((e) => e.id));
  assert.equal(ids.size, a.events.length + b.events.length, 'id не должны пересекаться между проходами');
  assert.ok(a.events.every((e) => e.id.startsWith('01#')));
  assert.ok(b.events.every((e) => e.id.startsWith('02#')));
});

test('indexTrack: дескрипторы различают сильный и слабый шаг', () => {
  const SR = 44100;
  const buf = new Float32Array(SR * 10);
  stepAt(buf, SR, 1, { amp: 0.9 });
  stepAt(buf, SR, 2, { amp: 0.35 });
  const idx = indexTrack(buf, SR, { category: 'steps', minGap: 0.3 });
  assert.equal(idx.events.length, 2);
  const [strong, weak] = idx.events;
  assert.ok(strong.peak > weak.peak * 1.5, `пик ${strong.peak} vs ${weak.peak}`);
});

test('indexTrack: ZCR различает гравий и дерево', () => {
  const SR = 44100;
  const buf = new Float32Array(SR * 10);
  stepAt(buf, SR, 1, { noise: 0.9 });   // гравий — шумный
  stepAt(buf, SR, 2, { noise: 0.05 });  // дерево — чистый тон
  const idx = indexTrack(buf, SR, { category: 'steps', minGap: 0.3 });
  assert.ok(idx.events[0].zcr > idx.events[1].zcr * 2,
    `zcr гравия ${idx.events[0].zcr} должен сильно превышать дерево ${idx.events[1].zcr}`);
});

test('indexTrack: стопа чередуется L/R и темп посчитан', () => {
  const SR = 44100;
  const idx = indexTrack(pass(SR, [1, 1.6, 2.2, 2.8, 3.4]), SR, { category: 'steps', minGap: 0.3 });
  const feet = idx.events.map((e) => e.foot).filter(Boolean);
  assert.equal(feet.length, 5);
  assert.deepEqual(feet, ['L', 'R', 'L', 'R', 'L']);
  assert.ok(Math.abs(idx.events[0].cadence - 0.6) < 0.05, `темп ${idx.events[0].cadence}`);
});

test('refineAttack: уточняет время до отсчёта', () => {
  const SR = 44100;
  const buf = new Float32Array(SR * 5);
  stepAt(buf, SR, 2.0, { amp: 0.8 });
  const refined = refineAttack(buf, SR, 2.0116); // время кадра анализа
  assert.ok(Math.abs(refined - 2.0) < 0.01, `уточнено ${refined} вместо 2.0`);
});

test('classifyEvent: щелчок vs шуршание vs удар', () => {
  assert.equal(classifyEvent({ band: 'high', duration: 0.1, zcr: 0.2, centroid: 3000 }), 'click');
  assert.equal(classifyEvent({ band: 'mid', duration: 0.4, zcr: 0.1, centroid: 2000 }), 'cloth/rustle');
  assert.equal(classifyEvent({ band: 'low', duration: 0.5, zcr: 0.05, centroid: 300 }), 'door/boom');
});

/* ---------- размещение ---------- */
function library() {
  const SR = 44100;
  const out = [];
  for (const p of ['01', '02', '03']) {
    const idx = indexTrack(pass(SR, [1, 1.62, 2.24, 2.86, 3.48, 4.1, 4.72, 5.34]), SR,
      { category: 'steps', pass: p, minGap: 0.3 });
    for (const e of idx.events) out.push({ ...e, track: p, file: `steps ${p}.wav`, category: 'steps' });
  }
  return out;
}

test('placeEvents: все события размещены, когда дублей хватает', () => {
  const lib = library();
  const video = Array.from({ length: 12 }, (_, i) => ({
    frame: i * 15, time: 3 + i * 0.5, category: 'steps', strength: 0.7, duration: 0.2,
  }));
  const { placements, summary } = placeEvents(video, lib, { fps: 25 });
  assert.equal(placements.length, 12);
  assert.equal(summary.placed, 12);
  assert.equal(summary.missing, 0);
});

test('placeEvents: использует разные дубли, а не заедает одним', () => {
  const lib = library();
  const video = Array.from({ length: 20 }, (_, i) => ({
    frame: i * 12, time: 3 + i * 0.4, category: 'steps', strength: 0.7, duration: 0.2,
  }));
  const { summary } = placeEvents(video, lib, { fps: 25 });
  const used = summary.byCategory.steps.unique;
  assert.ok(used > 12, `уникальных дублей ${used} — должно быть много, повторы дороги`);
});

test('placeEvents: категория без дорожки названа прямо, а не подменена', () => {
  const lib = library();
  const video = [
    { frame: 0, time: 1, category: 'steps', strength: 0.7, duration: 0.2 },
    { frame: 25, time: 2, category: 'metal', strength: 0.7, duration: 0.2 },
  ];
  const { placements, summary } = placeEvents(video, lib, { fps: 25 });
  assert.ok(placements[1].audio === null);
  assert.match(placements[1].note, /нет дорожки/);
  assert.equal(summary.byCategory.metal.noTrack, true);
  assert.equal(summary.byCategory.steps.placed, 1);
});

test('placeEvents: неизвестная категория работает на общем профиле', () => {
  const SR = 44100;
  const idx = indexTrack(pass(SR, [1, 1.6, 2.2, 2.8]), SR, { category: 'metal', minGap: 0.15 });
  const lib = idx.events.map((e) => ({ ...e, track: 'metal', file: 'metal.wav', category: 'metal' }));
  const video = [{ frame: 0, time: 3, category: 'metal', strength: 0.7, duration: 0.2 }];
  const { placements } = placeEvents(video, lib, { fps: 25 });
  assert.ok(placements[0].audio, 'металл должен разместиться без своего профиля');
  assert.equal(profileOf('metal').weights.strength, PROFILES.default.weights.strength);
});

test('placeEvents: вырез охватывает событие с хендлами', () => {
  const lib = library();
  const { placements } = placeEvents(
    [{ frame: 0, time: 3, category: 'steps', strength: 0.7, duration: 0.2 }], lib, { fps: 25, handles: 0.05 });
  const a = placements[0].audio;
  assert.ok(a.cutFrom < a.sourceTime && a.cutTo > a.sourceTime + a.duration,
    `вырез ${a.cutFrom}–${a.cutTo} должен охватывать ${a.sourceTime}`);
});

/* ---------- реальный WAV из фикстур, если он есть ---------- */
test('indexTrack: читает настоящий WAV из фикстур', () => {
  let wav;
  try { wav = readWav('tools/fixtures/lib/steps.wav'); } catch { return; }
  const idx = indexTrack(toMono(wav), wav.sampleRate, { category: 'steps', minGap: 0.3 });
  assert.ok(idx.events.length >= 5, `событий ${idx.events.length}`);
  for (const e of idx.events) {
    assert.ok(typeof e.peak === 'number' && typeof e.duration === 'number');
    assert.ok(typeof e.id === 'string' && e.id.length > 0);
  }
});
