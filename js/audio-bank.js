/* ============ Банк декодированных дорожек ============
 *
 * Дорожки фоли декодируются один раз при импорте и хранятся здесь как моно.
 * Нужно двум потребителям:
 *   - движку: вырезать дубль, который встаёт на картинку;
 *   - проигрывателю: звучать этим дублем во время воспроизведения.
 *
 * Модуль намеренно ничего не знает ни о движке, ни о плеере — только имя
 * дорожки и её сэмплы.
 */

const bank = new Map();   // имя дорожки -> { data: Float32Array, sampleRate }

/** @param {string} name имя файла дорожки
 *  @param {{data: Float32Array, sampleRate: number}} buf моно-сэмплы */
export function putTrack(name, buf) {
  if (!name || !buf?.data) return false;
  bank.set(name, { data: buf.data, sampleRate: buf.sampleRate });
  return true;
}

export function getTrack(name) {
  return bank.get(name) || null;
}

export function hasTrack(name) {
  return bank.has(name);
}

export function dropTrack(name) {
  return bank.delete(name);
}

export function clearBank() {
  bank.clear();
}

export const bankNames = () => [...bank.keys()];

/** Длительность дорожки в секундах (0 если её нет в банке). */
export function trackDuration(name) {
  const t = bank.get(name);
  return t ? t.data.length / t.sampleRate : 0;
}

/**
 * Играет вырезок [from, to) дорожки. Резка идёт из той же позиции, куда дубль
 * встаёт на картинке, поэтому слышно именно стык, а не «примерно рядом».
 *
 * @param {string} name  имя дорожки
 * @param {number} from  секунды
 * @param {number} to    секунды
 * @param {number} when  абсолютное время AudioContext
 * @param {{ctx: AudioContext, out: AudioNode, gain?: number}} opts
 * @returns {boolean} получилось ли играть
 */
export function playCut(name, from, to, when, opts = {}) {
  const trk = bank.get(name);
  const { ctx, out, gain = 1 } = opts;
  if (!trk || !ctx?.createBuffer || !out) return false;
  const { data, sampleRate } = trk;
  const a = Math.max(0, Math.round((from || 0) * sampleRate));
  const b = Math.min(data.length, Math.round((to || 0) * sampleRate));
  const len = b - a;
  if (len <= 0) return false;
  const buf = ctx.createBuffer(1, len, sampleRate);
  buf.copyToChannel(data.subarray(a, b), 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g);
  g.connect(out);
  try { src.start(when); } catch { return false; }
  src.onended = () => { try { g.disconnect(); } catch { /* ignore */ } };
  return true;
}

/**
 * Огибающая дорожки для мини-волформы: пиковые значения по сегментам.
 * Нормируется по пику всей дорожки, а не отрезка — иначе тихий шаг выглядел бы
 * таким же громким, как сильный, и сравнить дубли на глаз было бы нельзя.
 */
export function waveform(name, points = 48, from = 0, to = Infinity) {
  const trk = bank.get(name);
  if (!trk) return null;
  const { data, sampleRate } = trk;
  const a = Math.max(0, Math.min(data.length, Math.round(from * sampleRate)));
  const b = Math.max(a, Math.min(data.length, Math.round(
    Number.isFinite(to) ? to * sampleRate : data.length,
  )));
  const len = b - a;
  if (len <= 0) return null;
  if (trk.peak === undefined) {
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    trk.peak = peak || 1e-6;
  }
  const out = new Array(points).fill(0);
  const per = len / points;
  for (let i = 0; i < points; i++) {
    const s = a + Math.floor(i * per);
    const e = Math.max(s + 1, a + Math.floor((i + 1) * per));
    let peak = 0;
    for (let j = s; j < e && j < b; j++) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    out[i] = Math.min(1, peak / trk.peak);
  }
  return out;
}
