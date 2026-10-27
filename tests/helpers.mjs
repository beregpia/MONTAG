/* Общий помощник для тестов: разворачивает index.html в jsdom с заглушками. */
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

export const ROOT = new URL('..', import.meta.url);

export function readIndex() {
  return readFileSync(new URL('../index.html', import.meta.url), 'utf8');
}

/** Фейковый Web Audio: пишет все запуски буферов в SOURCE_STARTS. */
export const SOURCE_STARTS = [];

class FakeParam {
  constructor(v) { this.value = v; }
}
class FakeGain {
  constructor() { this.gain = new FakeParam(1); }
  connect() { return this; }
  disconnect() {}
}
class FakeSource {
  constructor() { this.started = null; this.onended = null; }
  connect() {}
  disconnect() {}
  start(when, offset) { this.started = { when, offset }; SOURCE_STARTS.push(this); }
}
export class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
  }
  createGain() { return new FakeGain(); }
  createBufferSource() { return new FakeSource(); }
  createBuffer(ch, len, sr) {
    return { length: len, sampleRate: sr, numberOfChannels: ch, duration: len / sr, copyToChannel() {} };
  }
  createMediaStreamDestination() { return { stream: { getAudioTracks: () => [] } }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  decodeAudioData() { return Promise.resolve(FakeAudioContext.nextDecode); }
}
FakeAudioContext.nextDecode = null;

/**
 * @param {object} opts
 *   scripts      — выполнять инлайновые скрипты (для standalone-сборки)
 *   videoError   — код ошибки <video> (эмуляция неподдерживаемого кодека)
 *   decode       — что вернёт decodeAudioData
 */
export async function setupDom(opts = {}) {
  const { scripts = false, videoError = null, decode = null } = opts;
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(`${e.message}${e.detail ? ` (${e.detail})` : ''}`));
  vc.on('error', (...a) => errors.push(a.join(' ')));

  const dom = new JSDOM(readIndex(), {
    url: 'http://localhost:8080/',
    runScripts: scripts ? 'dangerously' : 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;

  window.HTMLCanvasElement.prototype.getContext = () => null;
  // jsdom-шный performance.now при обращении из Node уходит в бесконечную рекурсию
  const perfShim = { now: () => Date.now() };
  try {
    Object.defineProperty(window, 'performance', { value: perfShim, configurable: true });
  } catch { /* окно могло замёрзнуть свойство */ }
  window.URL.createObjectURL = () => 'blob:fake';
  window.URL.revokeObjectURL = () => {};
  window.confirm = () => true;

  if (videoError) {
    const origCreate = window.document.createElement.bind(window.document);
    window.document.createElement = (tag) => {
      const el = origCreate(tag);
      if (tag === 'video') {
        let src = '';
        Object.defineProperty(el, 'src', {
          set(v) { src = v; setTimeout(() => el.dispatchEvent(new window.Event('error')), 0); },
          get() { return src; },
        });
        Object.defineProperty(el, 'error', { get: () => ({ code: videoError }) });
      }
      return el;
    };
  }

  FakeAudioContext.nextDecode = decode;
  window.AudioContext = FakeAudioContext;

  // модули приложения обращаются к глобалам — пробрасываем их
  const globals = ['document', 'window', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
    'HTMLVideoElement', 'HTMLCanvasElement', 'HTMLAnchorElement', 'File', 'FileList', 'Blob', 'URL',
    'requestAnimationFrame', 'cancelAnimationFrame', 'confirm', 'alert',
    'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'AudioContext'];
  for (const key of globals) {
    const value = key === 'AudioContext' ? FakeAudioContext : window[key];
    if (value === undefined) continue;
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    } catch { /* некоторые глобали только для чтения */ }
  }

  return { window, document: window.document, dom, errors, silenceConsole };
}

/** Вывод приложения, перехваченный во время теста (консоль не засоряется). */
export const appConsole = { log: [], warn: [], error: [] };

const realLog = console.log.bind(console);

/** Перехватывает console.* приложения; сами тесты печатают через настоящий console. */
function silenceConsole() {
  for (const key of ['log', 'warn', 'error']) {
    console[key] = (...args) => { appConsole[key].push(args.map(String).join(' ')); };
  }
}

/** Счётчик проверок с единым форматом вывода. */
export function reporter() {
  let fails = 0;
  let total = 0;
  const check = (name, cond, extra = '') => {
    total++;
    realLog(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
    if (!cond) fails++;
  };
  return {
    check,
    done(title) {
      realLog(fails ? `\nПРОВАЛОВ: ${fails} из ${total}` : `\n${title} — всё зелёно (${total} проверок)`);
      return fails === 0;
    },
  };
}
