/* ============ Standard MIDI File: запись маркеров ============
 * Cubase (и большинство DAW) импортируют маркеры из SMF:
 *   Preferences → MIDI → MIDI File → Import Markers → File → Import → MIDI File
 * Темпомап подбирается так, чтобы 1 тик = 1 мс (PPQ 480, 125 BPM),
 * поэтому позиции маркеров попадают в проект с точностью до 1 мс —
 * это меньше кадра при любом fps.
 */

/** VLQ (variable length quantity) — как в SMF. */
export function vlq(value) {
  const v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  let rest = v >> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes;
}

function str(s) {
  const out = [];
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else {
      // ASCII-безопасное имя маркера
      out.push(0x3f); // '?'
    }
  }
  return out;
}

/**
 * Собирает SMF формата 0 с темпомапой и маркерами.
 * @param {{time:number, name?:string}[]} markers  время в секундах
 * @param {object} opts
 * @returns {Uint8Array}
 */
export function buildMarkerMidi(markers, opts = {}) {
  const {
    ppq = 480,
    msPerTick = 1,
    trackName = 'MONTAG FOLEY',
  } = opts;

  const ticksPerSecond = 1000 / msPerTick;
  const tempoUsPerQuarter = Math.round(msPerTick * 1000 * ppq); // мкс на долю

  const bytes = [];

  /* --- заголовок файла: MThd --- */
  bytes.push(0x4d, 0x54, 0x68, 0x64); // "MThd"
  bytes.push(0, 0, 0, 6);             // длина заголовка
  bytes.push(0, 0);                   // формат 0
  bytes.push(0, 1);                   // один трек
  bytes.push((ppq >> 8) & 0xff, ppq & 0xff);

  /* --- трек --- */
  const track = [];

  // имя трека
  const nameBytes = str(trackName);
  track.push(0x00, 0xff, 0x03, nameBytes.length, ...nameBytes);
  // темп
  track.push(0x00, 0xff, 0x51, 0x03,
    (tempoUsPerQuarter >> 16) & 0xff,
    (tempoUsPerQuarter >> 8) & 0xff,
    tempoUsPerQuarter & 0xff);
  // размер 4/4
  track.push(0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);

  const sorted = [...markers]
    .filter((m) => Number.isFinite(m.time) && m.time >= 0)
    .sort((a, b) => a.time - b.time);

  let lastTick = 0;
  for (const m of sorted) {
    const tick = Math.round(m.time * ticksPerSecond);
    const delta = Math.max(0, tick - lastTick);
    lastTick = tick;
    const name = m.name ?? `marker ${(m.time).toFixed(3)}s`;
    const nameBytes = str(name);
    track.push(...vlq(delta), 0xff, 0x06, nameBytes.length, ...nameBytes);
  }

  // конец трека
  track.push(0x00, 0xff, 0x2f, 0x00);

  bytes.push(0x4d, 0x54, 0x72, 0x6b); // "MTrk"
  const len = track.length;
  bytes.push((len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  bytes.push(...track);

  return new Uint8Array(bytes);
}

/** Разбор SMF обратно в маркеры — для самопроверки и тестов. */
export function parseMarkerMidi(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const ascii = (off, n) => String.fromCharCode(...u8.subarray(off, off + n));
  if (ascii(0, 4) !== 'MThd') throw new Error('не SMF: нет MThd');
  const format = (u8[8] << 8) | u8[9];
  const ntrks = (u8[10] << 8) | u8[11];
  const ppq = (u8[12] << 8) | u8[13];

  const markers = [];
  let pos = 14;
  let tempoUs = 500000;
  for (let t = 0; t < ntrks; t++) {
    if (ascii(pos, 4) !== 'MTrk') throw new Error('нет MTrk');
    const len = (u8[pos + 4] << 24) | (u8[pos + 5] << 16) | (u8[pos + 6] << 8) | u8[pos + 7];
    const end = pos + 8 + len;
    let p = pos + 8;
    let tick = 0;
    while (p < end) {
      // VLQ delta
      let delta = 0;
      for (;;) {
        const b = u8[p++];
        delta = (delta << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      tick += delta;
      const status = u8[p++];
      if (status === 0xff) {
        const type = u8[p++];
        let metaLen = 0;
        for (;;) {
          const b = u8[p++];
          metaLen = (metaLen << 7) | (b & 0x7f);
          if (!(b & 0x80)) break;
        }
        if (type === 0x51 && metaLen === 3) {
          tempoUs = (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
        } else if (type === 0x06) {
          markers.push({ tick, name: ascii(p, metaLen) });
        }
        p += metaLen;
        if (type === 0x2f) break;
      } else if (status === 0xf0) {
        let sysexLen = 0;
        for (;;) {
          const b = u8[p++];
          sysexLen = (sysexLen << 7) | (b & 0x7f);
          if (!(b & 0x80)) break;
        }
        p += sysexLen;
      } else {
        // прочие MIDI-события в наших файлах не встречаются
        p += 1;
      }
    }
    pos = end;
  }

  // переводим тики в секунды через темпомап (один темп на весь трек)
  const ticksPerSecond = (tempoUs > 0 ? 1e6 / tempoUs : 2) * ppq;
  return {
    format, ntrks, ppq, tempoUs, ticksPerSecond,
    markers: markers.map((m) => ({ ...m, time: m.tick / ticksPerSecond })),
  };
}
