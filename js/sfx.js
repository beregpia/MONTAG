/* ============ Фоли-библиотека: процедурный синтез звуков ============
 * Звуки генерируются из шума и синусов однополюсными фильтрами —
 * никаких внешних сэмплов, работает офлайн и детерминировано при seed.
 */

export const SFX_LIST = [
  { id: 'step', label: 'Шаг', icon: '👟', cat: 'low' },
  { id: 'step_soft', label: 'Шаг тихий', icon: '🧦', cat: 'low' },
  { id: 'heel', label: 'Каблук', icon: '👠', cat: 'low' },
  { id: 'thud', label: 'Предмет (туду)', icon: '📦', cat: 'low' },
  { id: 'cloth', label: 'Ткань / руки', icon: '👕', cat: 'mid' },
  { id: 'rustle', label: 'Шелест', icon: '🍃', cat: 'mid' },
  { id: 'tap', label: 'Касание', icon: '☝️', cat: 'mid' },
  { id: 'whoosh', label: 'Взмах руки', icon: '💨', cat: 'mid' },
  { id: 'click', label: 'Клик / щелчок', icon: '🖱️', cat: 'high' },
  { id: 'object', label: 'Металл / пластик', icon: '🔧', cat: 'high' },
];

export const sfxById = (id) => SFX_LIST.find((s) => s.id === id) || SFX_LIST[0];

/** Длительность звука в секундах (дублирует логику синтеза). */
export function sfxDuration(id) {
  return DURATIONS[id] ?? 0.2;
}

const DURATIONS = {
  step: 0.25, step_soft: 0.16, heel: 0.15, thud: 0.3, cloth: 0.28,
  rustle: 0.45, tap: 0.09, whoosh: 0.42, click: 0.06, object: 0.4,
};

/** Детерминированный ГПСЧ (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function whiteNoise(n, rnd) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rnd() * 2 - 1;
  return x;
}

function sine(n, freq, sr, decay = 0) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = Math.sin(2 * Math.PI * freq * t) * (decay ? Math.exp(-t / decay) : 1);
  }
  return x;
}

function lowpass(x, fc, sr) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; }
  return x;
}

function highpass(x, fc, sr) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] -= y; }
  return x;
}

function bandpass(x, lo, hi, sr) {
  return lowpass(highpass(x, lo, sr), hi, sr);
}

/** Низкочастотный срез с плавно меняющейся частотой (для взмаха). */
function lowpassSweep(x, f0, f1, sr) {
  let y = 0;
  const n = x.length;
  for (let i = 0; i < n; i++) {
    const p = n > 1 ? i / (n - 1) : 0;
    const bell = Math.sin(Math.PI * p); // вверх-вниз
    const fc = f0 + (f1 - f0) * bell;
    const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
    y += a * (x[i] - y);
    x[i] = y;
  }
  return x;
}

function expDecay(n, tau, sr) {
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = Math.exp(-i / (tau * sr));
  return e;
}

function mul(a, k) { for (let i = 0; i < a.length; i++) a[i] *= k; return a; }
function addTo(target, src, k = 1) {
  for (let i = 0; i < target.length; i++) target[i] += src[i] * k;
  return target;
}
function applyEnv(x, env) {
  for (let i = 0; i < x.length; i++) x[i] *= env[i];
  return x;
}

/** Короткий фейд на концах, чтобы не было щелчков. */
function fadeEdges(x, sr, ms = 3) {
  const n = Math.min(x.length, Math.floor((ms / 1000) * sr));
  for (let i = 0; i < n; i++) {
    const k = i / n;
    x[i] *= k;
    x[x.length - 1 - i] *= k;
  }
  return x;
}

function normalize(x, peak = 0.85) {
  let max = 0;
  for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i]));
  if (max > 1e-6) mul(x, peak / max);
  return x;
}

/**
 * Синтез одного фоли-звука.
 * @returns {{sampleRate:number, duration:number, data:Float32Array}}
 */
export function synthesize(id, sampleRate = 48000, seed = 1) {
  const sr = sampleRate;
  const n = Math.max(1, Math.floor((DURATIONS[id] ?? 0.2) * sr));
  const rnd = rng(seed * 2654435761);
  const out = new Float32Array(n);
  const noise = () => whiteNoise(n, rnd);

  switch (id) {
    case 'step': {
      const body = applyEnv(lowpass(noise(), 380, sr), expDecay(n, 0.045, sr));
      mul(body, 0.7);
      addTo(out, body);
      addTo(out, sine(n, 62, sr, 0.07), 0.8);
      break;
    }
    case 'step_soft': {
      const body = applyEnv(lowpass(noise(), 750, sr), expDecay(n, 0.03, sr));
      mul(body, 0.55);
      addTo(out, body);
      addTo(out, sine(n, 95, sr, 0.035), 0.35);
      break;
    }
    case 'heel': {
      const body = applyEnv(lowpass(noise(), 560, sr), expDecay(n, 0.022, sr));
      mul(body, 0.75);
      addTo(out, body);
      addTo(out, sine(n, 110, sr, 0.03), 0.4);
      break;
    }
    case 'thud': {
      addTo(out, sine(n, 48, sr, 0.1), 0.95);
      const body = applyEnv(lowpass(noise(), 220, sr), expDecay(n, 0.05, sr));
      addTo(out, mul(body, 0.5));
      break;
    }
    case 'cloth': {
      const body = applyEnv(bandpass(noise(), 900, 3200, sr), expDecay(n, 0.09, sr));
      addTo(out, mul(body, 0.65));
      break;
    }
    case 'rustle': {
      const body = applyEnv(bandpass(noise(), 1800, 5200, sr), expDecay(n, 0.16, sr));
      // медленная амплитудная модуляция — «шуршание»
      for (let i = 0; i < n; i++) body[i] *= 0.6 + 0.4 * Math.sin((2 * Math.PI * 3.1 * i) / sr);
      addTo(out, mul(body, 0.5));
      break;
    }
    case 'tap': {
      const body = applyEnv(bandpass(noise(), 1400, 4200, sr), expDecay(n, 0.018, sr));
      addTo(out, mul(body, 0.6));
      addTo(out, sine(n, 880, sr, 0.012), 0.2);
      break;
    }
    case 'whoosh': {
      const body = lowpassSweep(highpass(noise(), 200, sr), 260, 2800, sr);
      for (let i = 0; i < n; i++) {
        const p = n > 1 ? i / (n - 1) : 0;
        body[i] *= Math.pow(Math.sin(Math.PI * p), 0.8);
      }
      addTo(out, mul(body, 0.6));
      break;
    }
    case 'click': {
      const body = applyEnv(highpass(noise(), 2800, sr), expDecay(n, 0.007, sr));
      addTo(out, mul(body, 0.8));
      break;
    }
    case 'object': {
      const partials = [
        { f: 523.25, tau: 0.05, k: 0.5 },
        { f: 1046.5 * 1.004, tau: 0.08, k: 0.3 },
        { f: 1568 * 0.992, tau: 0.12, k: 0.18 },
      ];
      for (const p of partials) addTo(out, sine(n, p.f, sr, p.tau), p.k);
      const tick = applyEnv(highpass(noise(), 4000, sr), expDecay(n, 0.006, sr));
      addTo(out, mul(tick, 0.35));
      break;
    }
    default: {
      addTo(out, mul(applyEnv(lowpass(noise(), 600, sr), expDecay(n, 0.05, sr)), 0.7));
    }
  }

  return { sampleRate: sr, duration: n / sr, data: normalize(fadeEdges(out, sr)) };
}

/** Авто-подбор звука по диапазону и силе события. */
export function autoSfxFor(band, strength, index = 0) {
  const i = index;
  if (band === 'low') {
    if (strength > 0.55) return i % 2 ? 'thud' : 'step';
    return i % 3 === 0 ? 'step_soft' : 'heel';
  }
  if (band === 'high') return i % 2 ? 'click' : 'object';
  return i % 2 ? 'cloth' : 'rustle';
}
