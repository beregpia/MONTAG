/* Тест WAV-ридера/райтера: пользовательские дорожки из Mirelo/ElevenLabs/DAW
 * приходят как 16/24/32-бит PCM или 32-float — читатель должен принимать все. */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { writeWav, readWav, toMono } from '../tools/lib/wav.mjs';
import { reporter } from './helpers.mjs';

const { check, done } = reporter();
const DIR = '/tmp/montag-wav-test';
mkdirSync(DIR, { recursive: true });

/* ---------- свой round-trip (32-bit float) ---------- */
const SR = 44100;
const signal = new Float32Array(SR);
for (let i = 0; i < signal.length; i++) signal[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.7;
const { bytes } = writeWav(`${DIR}/float32.wav`, { sampleRate: SR, channels: [signal] });
const back = readWav(`${DIR}/float32.wav`);
let maxErr = 0;
for (let i = 0; i < signal.length; i++) maxErr = Math.max(maxErr, Math.abs(signal[i] - back.channels[0][i]));
check('round-trip 32-float без потерь', back.sampleRate === SR && maxErr < 1e-6, `maxErr=${maxErr.toExponential(2)}`);
check('файл имеет разумный размер', bytes > 44 + SR * 4 - 100 && bytes < 44 + SR * 4 + 100, `${bytes} байт`);

/* ---------- 16-бит PCM (типичный экспорт) ---------- */
function writePcm16(path, channels, sr) {
  const frames = channels[0].length;
  const buf = Buffer.alloc(44 + frames * channels.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * channels.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels.length, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * channels.length * 2, 28);
  buf.writeUInt16LE(channels.length * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(frames * channels.length * 2, 40);
  let o = 44;
  for (let f = 0; f < frames; f++) for (const ch of channels) { buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, ch[f])) * 32767), o); o += 2; }
  writeFileSync(path, buf);
}
writePcm16(`${DIR}/int16.wav`, [signal], SR);
const w16 = readWav(`${DIR}/int16.wav`);
let err16 = 0;
for (let i = 0; i < signal.length; i++) err16 = Math.max(err16, Math.abs(signal[i] - w16.channels[0][i]));
check('16-бит PCM читается', w16.sampleRate === SR && w16.channels[0].length === SR);
// допуск = 2 LSB: половина шага квантования + поправка на масштаб 32767/32768
check('16-бит: погрешность в пределах 2 LSB', err16 < 2 / 32768, `err=${err16.toExponential(2)}`);

/* ---------- 24-бит PCM ---------- */
function writePcm24(path, channels, sr) {
  const frames = channels[0].length;
  const dataSize = frames * channels.length * 3;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels.length, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * channels.length * 3, 28);
  buf.writeUInt16LE(channels.length * 3, 32); buf.writeUInt16LE(24, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let f = 0; f < frames; f++) {
    for (const ch of channels) {
      const v = Math.round(Math.max(-1, Math.min(1, ch[f])) * 8388607);
      buf[o] = v & 0xff; buf[o + 1] = (v >> 8) & 0xff; buf[o + 2] = (v >> 16) & 0xff; o += 3;
    }
  }
  writeFileSync(path, buf);
}
writePcm24(`${DIR}/int24.wav`, [signal], SR);
const w24 = readWav(`${DIR}/int24.wav`);
let err24 = 0;
for (let i = 0; i < signal.length; i++) err24 = Math.max(err24, Math.abs(signal[i] - w24.channels[0][i]));
check('24-бит PCM читается', w24.bits === 24 && w24.channels[0].length === SR);
check('24-бит: погрешность в пределах 2 LSB', err24 < 2 / 8388608, `err=${err24.toExponential(2)}`);

/* ---------- стерео и моно-микширование ---------- */
const right = new Float32Array(SR);
for (let i = 0; i < SR; i++) right[i] = Math.cos((2 * Math.PI * 440 * i) / SR) * 0.5;
writeWav(`${DIR}/stereo.wav`, { sampleRate: SR, channels: [signal, right] });
const st = readWav(`${DIR}/stereo.wav`);
const mono = toMono(st);
check('стерео: два канала', st.channels.length === 2);
check('toMono усредняет каналы',
  Math.abs(mono[100] - (signal[100] + right[100]) / 2) < 1e-6, `mono[100]=${mono[100].toFixed(4)}`);

/* ---------- защита от мусора ---------- */
writeFileSync(`${DIR}/not-wav.wav`, Buffer.from('это не WAV-файл'.repeat(10)));
let threw = false;
try { readWav(`${DIR}/not-wav.wav`); } catch { threw = true; }
check('не-WAV отклоняется с ошибкой', threw);

writeFileSync(`${DIR}/short.wav`, Buffer.alloc(10));
threw = false;
try { readWav(`${DIR}/short.wav`); } catch { threw = true; }
check('обрезанный файл отклоняется', threw);

rmSync(DIR, { recursive: true, force: true });
process.exitCode = done('WAV-ридер') ? 0 : 1;
