/* ============ Быстрое преобразование Фурье (radix-2, на месте) ============ */

/**
 * Итеративный FFT Кули–Тьюки. Длины re/im должны быть равны и степенью двойки.
 * Прямое преобразование (экспонента со знаком минус).
 */
export function fft(re, im) {
  const n = re.length;
  if (n !== im.length) throw new Error('fft: длины массивов не совпадают');
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error('fft: n должно быть степенью двойки');

  // реверс битов
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < half; j++) {
        const ar = re[i + j];
        const ai = im[i + j];
        const br = re[i + j + half];
        const bi = im[i + j + half];
        const vr = br * cwr - bi * cwi;
        const vi = br * cwi + bi * cwr;
        re[i + j] = ar + vr;
        im[i + j] = ai + vi;
        re[i + j + half] = ar - vr;
        im[i + j + half] = ai - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

/** Окно Ханна длины n. */
export function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** Амплитудный спектр вещественного сигнала (n/2+1 бинов). */
export function magnitudeSpectrum(frame, window) {
  const n = frame.length;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * (window ? window[i] : 1);
  fft(re, im);
  const mag = new Float32Array(n / 2 + 1);
  for (let k = 0; k < mag.length; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}
