/* Минимальный WAV-ридер/райтер без зависимостей: 16/24/32-бит int и 32-float.
 * Нужен, чтобы (а) генерировать эталонные треки и (б) читать WAV, выгруженный
 * из Mirelo / ElevenLabs / любой DAW. */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function fourCC(s) {
  return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
}

/** Записывает 32-бит float WAV (без потерь, читается любой DAW). */
export function writeWav(path, { sampleRate, channels }) {
  const data = channels; // Float32Array[]
  const frames = data[0].length;
  const numCh = data.length;
  const bytesPerSample = 4;
  const dataSize = frames * numCh * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  let o = 0;
  for (const b of fourCC('RIFF')) buf[o++] = b;
  buf.writeUInt32LE(36 + dataSize, o); o += 4;
  for (const b of fourCC('WAVE')) buf[o++] = b;
  for (const b of fourCC('fmt ')) buf[o++] = b;
  buf.writeUInt32LE(16, o); o += 4;          // размер fmt-чанка
  buf.writeUInt16LE(3, o); o += 2;           // 3 = IEEE float
  buf.writeUInt16LE(numCh, o); o += 2;
  buf.writeUInt32LE(sampleRate, o); o += 4;
  buf.writeUInt32LE(sampleRate * numCh * bytesPerSample, o); o += 4;
  buf.writeUInt16LE(numCh * bytesPerSample, o); o += 2;
  buf.writeUInt16LE(32, o); o += 2;
  for (const b of fourCC('data')) buf[o++] = b;
  buf.writeUInt32LE(dataSize, o); o += 4;

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numCh; c++) buf.writeFloatLE(data[c][f], o), (o += 4);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  return { path, bytes: buf.length, frames, sampleRate, channels: numCh };
}

/** Читает WAV: 16/24/32-бит int и 32-бит float, любое число каналов. */
export function readWav(path) {
  const buf = readFileSync(path);
  if (buf.length < 44) throw new Error('слишком короткий WAV');
  const tag = buf.toString('ascii', 0, 4);
  if (tag !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('не WAV (RIFF/WAVE)');

  let o = 12;
  let fmt = null;
  let dataStart = -1;
  let dataSize = 0;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    o += 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(o),
        channels: buf.readUInt16LE(o + 2),
        sampleRate: buf.readUInt32LE(o + 4),
        bits: buf.readUInt16LE(o + 14),
      };
    } else if (id === 'data') {
      dataStart = o;
      dataSize = Math.min(size, buf.length - o);
    }
    o += size + (size % 2); // чанки выравниваются по 2 байта
  }
  if (!fmt || dataStart < 0) throw new Error('не найдены чанки fmt/data');

  const numCh = fmt.channels;
  const bits = fmt.bits;
  const frames = Math.floor(dataSize / (numCh * (bits / 8)));
  const channels = Array.from({ length: numCh }, () => new Float32Array(frames));

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numCh; c++) {
      const p = dataStart + (f * numCh + c) * (bits / 8);
      let v;
      if (fmt.format === 3 && bits === 32) v = buf.readFloatLE(p);
      else if (bits === 16) v = buf.readInt16LE(p) / 32768;
      else if (bits === 24) {
        const lo = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
        v = (lo & 0x800000 ? lo - 0x1000000 : lo) / 8388608;
      } else if (bits === 32) v = buf.readInt32LE(p) / 2147483648;
      else throw new Error(`не поддерживаемая разрядность: ${bits} бит`);
      channels[c][f] = v;
    }
  }
  return { sampleRate: fmt.sampleRate, channels, frames, bits };
}

/** Микширует каналы в моно (как mixToMono в приложении). */
export function toMono(wav) {
  const n = wav.channels.length;
  const out = new Float32Array(wav.frames);
  for (let c = 0; c < n; c++) {
    const ch = wav.channels[c];
    for (let i = 0; i < wav.frames; i++) out[i] += ch[i] / n;
  }
  return out;
}
