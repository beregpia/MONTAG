/* Тест однозначной сборки montag-standalone.html: нет внешних ссылок, интерфейс поднимается. */
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { reporter } from './helpers.mjs';

const { check, done } = reporter();
const FILE = new URL('../montag-standalone.html', import.meta.url);

let html;
try {
  html = readFileSync(FILE, 'utf8');
} catch {
  console.log('SKIP  сборки montag-standalone.html нет (выполните `node build-standalone.mjs`)');
  process.exitCode = 0;
}

if (html) {
  /* ---------- статический анализ ---------- */
  const markup = html.replace(/<script[\s\S]*?<\/script>/gi, '<script></script>');
  const external = markup.match(/(?:src|href)\s*=\s*["'](?!data:|#)[^"']+["']/gi) || [];
  check('в разметке нет внешних src/href', external.length === 0, external.slice(0, 3).join(' | '));
  check('в разметке есть <script>', /<script[\s>]/.test(markup));
  check('встроены стили', /<style[\s>]/.test(html));
  check('интерфейс на русском', /Таймлайн/.test(html) && /Импорт/.test(html));
  check('есть кнопка демо', /Демо/.test(html));
  check('в бандле нет module-импортов', !/^\s*import\s+.*from\s+['"]\.\.?\//m.test(html));
  check('в бандле нет ссылок на js/*.js', !/["']js\/[a-z-]+\.js["']/.test(html));
  check('в бандле нет ссылок на css/style.css', !/css\/style\.css/.test(html));
  check('размер разумный (< 512 КБ)', html.length < 512 * 1024, `${Math.round(html.length / 1024)} КБ`);

  /* ---------- запуск как обычной страницы ---------- */
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    // jsdom без пакета canvas не умеет getContext — это ограничение среды, не приложения
    if (/Not implemented/.test(e.message)) return;
    errors.push(e.message);
  });
  vc.on('error', (...a) => errors.push(a.join(' ')));

  const dom = new JSDOM(html, { url: 'file:///tmp/montag-standalone.html', runScripts: 'dangerously', virtualConsole: vc });
  await new Promise((r) => setTimeout(r, 80));
  const d = dom.window.document;

  check('интерфейс поднят: дорожка таймлайна', !!d.getElementById('track'));
  check('интерфейс поднят: список медиа', !!d.getElementById('media-list'));
  check('интерфейс поднят: кнопка демо', !!d.getElementById('btn-demo'));
  check('интерфейс поднят: панель фоли', !!d.getElementById('foley-body') && !!d.getElementById('foley-drawer'));
  check('интерфейс поднят: холст плеера', !!d.getElementById('canvas'));
  check('нет ошибок исполнения скриптов', errors.length === 0, errors.slice(0, 2).join(' | '));

  /* ---------- клик по «Демо-клип» должен дать обратную связь ---------- */
  const btn = d.getElementById('btn-demo');
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  const toasts = d.getElementById('toasts');
  const toastText = toasts ? toasts.textContent.trim() : '';
  check('клик по «Демо-клип» показывает сообщение', toastText.length > 0, toastText.slice(0, 80));
  check('кнопка разблокировалась после неудачи', btn.disabled === false && btn.textContent !== '⏳ …',
    `текст: ${btn.textContent}`);

  /* ---------- открытие панели фоли ---------- */
  const foleyBtn = [...d.querySelectorAll('button')].find((b) => /Foley/.test(b.textContent));
  if (foleyBtn) {
    foleyBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    check('панель фоли открывается',
      !d.getElementById('foley-drawer').classList.contains('hidden'));
  }
}

process.exitCode = done('Сборка') ? 0 : 1;
