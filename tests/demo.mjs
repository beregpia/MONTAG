/* Тест генератора демо-клипа: состав кадров, отсутствие requestAnimationFrame, защита от зависаний. */
import { setupDom, reporter, appConsole } from './helpers.mjs';

const { window, document, silenceConsole } = await setupDom();
silenceConsole();
const { check, done } = reporter();

const BASE = new URL('../js/', import.meta.url);
const demo = await import(new URL('demo.js', BASE).href);

/* ---------- фейковый 2D-контекст: пишем все fillRect ---------- */
const W = 640;
const H = 360;
const ctxCalls = [];
function fakeCtx() {
  const c = {
    canvas: { width: W, height: H },
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', globalAlpha: 1,
    drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {},
    closePath() {}, ellipse() {}, rect() {}, clip() {},
    fillText() {}, strokeText() {}, measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    setTransform() {}, clearRect() {},
    fillRect: (x, y, w, h) => ctxCalls.push({ x, y, w, h }),
  };
  return c;
}

/* ---------- 1. сценарий ---------- */
const script = demo.demoScript();
check('демо: длительность 8 с', script.duration === 8);
check('демо: шаги каждую секунду', script.steps.length === 7, `шагов ${script.steps.length}`);
check('демо: шаги чередуются сильный/слабый',
  script.steps.every((s, i) => s.strong === (i % 2 === 0)), script.steps.map((s) => (s.strong ? 'S' : 's')).join(''));
check('демо: есть щелчки', script.clicks.length === 3);
check('демо: все события внутри длительности',
  [...script.steps.map((s) => s.time), ...script.clicks.map((c) => c.time)].every((t) => t > 0 && t < script.duration));

/* ---------- 2. состав кадра ---------- */
function draw(t) {
  ctxCalls.length = 0;
  demo.drawDemoFrame(fakeCtx(), t, script, W, H);
  return ctxCalls.filter((c) => c.w === W && c.h === H).length;
}
check('кадр: фон рисуется полноэкранным fillRect', draw(0) === 1);
check('вне шага вспышки нет', draw(0.2) === 1);
check('вспышка на сильном шаге — доп. слой', draw(2.0) === 2);
check('вспышка на слабом шаге — доп. слой', draw(3.0) === 2);
check('вспышка не светит всюду', draw(2.5) === 1 && draw(4.5) === 1);
check('вспышка привязана к шагам сценария',
  script.steps.every((s) => draw(s.time) === 2), script.steps.map((s) => s.time.toFixed(1)).join(','));

/* ---------- 3. диагностика возможностей ---------- */
const caps = demo.demoCapabilities();
check('в jsdom без заглушек возможности недоступны',
  caps.mediaRecorder === false && caps.captureStream === false && caps.webm === false && caps.audioContext === true,
  JSON.stringify(caps));
const missing = Object.entries(caps).filter(([, ok]) => !ok).map(([k]) => k);
check('список недостающего совпадает с тем, что печатает main.js',
  missing.join(',') === 'mediaRecorder,captureStream,webm', missing.join(', '));

/* ---------- 4. отсутствие requestAnimationFrame в исходнике ---------- */
const src = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../js/demo.js', import.meta.url), 'utf8'));
const srcCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('в коде демо нет requestAnimationFrame', !/requestAnimationFrame/.test(srcCode));
check('исходник использует captureStream(0) + requestFrame',
  /captureStream\(0\)/.test(src) && /requestFrame/.test(src));
check('исходник содержит watchdog', /watchdog/.test(src));

/* ---------- 5. генерация клипа без rAF ---------- */
let rafUsed = 0;
window.requestAnimationFrame = () => { rafUsed++; return 1; };
window.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
window.HTMLCanvasElement.prototype.captureStream = () => ({
  getVideoTracks: () => [{ requestFrame() { this.frames = (this.frames || 0) + 1; }, stop() {} }],
  getTracks: () => [],
  addTrack() {},
});

class FakeOsc {
  constructor() { this.type = ''; this.frequency = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }; }
  connect() {}
  start() {}
  stop() {}
}
class FakeGain {
  constructor() { this.gain = { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 1 }; }
  connect() {}
}
class FakeActx {
  constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = 'running'; }
  createOscillator() { return new FakeOsc(); }
  createGain() { return new FakeGain(); }
  createMediaStreamDestination() { return { stream: { getAudioTracks: () => [] } }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
window.AudioContext = FakeActx;
Object.defineProperty(globalThis, 'AudioContext', { value: FakeActx, configurable: true, writable: true });

let recStarted = 0;
window.MediaRecorder = class MediaRecorder {
  constructor(stream, opts) { this.stream = stream; this.mimeType = (opts && opts.mimeType) || 'video/webm'; }
  static isTypeSupported(m) { return m === 'video/webm'; }
  start() { recStarted++; this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    setTimeout(() => {
      this.ondataavailable?.({ data: { size: 3 } });
      this.onstop?.();
    }, 0);
  }
};
Object.defineProperty(globalThis, 'MediaRecorder', { value: window.MediaRecorder, configurable: true, writable: true });

// демо кодирует blob из chunks — подменяем, чтобы File получил данные
const RealBlob = window.Blob;
window.Blob = class extends RealBlob {
  constructor(parts, opts) { super([new Uint8Array([1, 2, 3])], opts); }
};
Object.defineProperty(globalThis, 'Blob', { value: window.Blob, configurable: true, writable: true });

const stages = [];
const t0 = Date.now();
const file = await demo.makeDemoFile((s) => stages.push(s));
const elapsed = Date.now() - t0;

check('клип создан без requestAnimationFrame', rafUsed === 0, `rAF-вызовов: ${rafUsed}`);
check('MediaRecorder запущен', recStarted === 1);
check('этапы генерации сообщаются', stages.length > 0, stages.join(' → '));
check('клип — это File', file && file.size > 0 && /\.webm$/.test(file.name), file?.name);
check('клип создан за < 20 с (без реального ожидания)', elapsed < 20000, `${elapsed} мс`);

/* ---------- 6. watchdog: нет видео-дорожки → ошибка, а не вечное ожидание ---------- */
window.HTMLCanvasElement.prototype.captureStream = () => ({
  getVideoTracks: () => [],
  getTracks: () => [],
  addTrack() {},
});
let err = null;
const p = demo.makeDemoFile(() => {});
await p.catch((e) => { err = e; });
check('нет видео-дорожки → ошибка вместо зависания',
  err instanceof Error && /кадр|дорожк|requestFrame|captureStream|не поддерж/i.test(err.message),
  err?.message);

/* ---------- 7. нет ошибок в консоли приложения ---------- */
check('нет ошибок в консоли приложения', appConsole.error.length === 0, appConsole.error[0]?.slice(0, 60));

process.exitCode = done('Демо-клип') ? 0 : 1;
