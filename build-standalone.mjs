#!/usr/bin/env node
/* ============ Сборка одного HTML-файла (montag-standalone.html) ============
 *
 * Приложение — набор ES-модулей, поэтому index.html нужно раздавать через
 * локальный сервер (file:// блокирует импорты). Этот скрипт собирает все
 * модули в один бандл и встраивает его вместе с CSS в один HTML-файл,
 * который открывается двойным кликом — без Node, Python и VS Code.
 *
 * Использование:
 *   npm install esbuild          # один раз
 *   node build-standalone.mjs    # создать montag-standalone.html
 *
 * Путь к esbuild можно переопределить: ESBUILD=/path/to/esbuild node build-standalone.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'js/main.js';
const OUT_JS = join(ROOT, '.bundle.tmp.js');
const OUT_HTML = join(ROOT, 'montag-standalone.html');

const ESBUILD = process.env.ESBUILD
  || join(ROOT, 'node_modules', '.bin', 'esbuild')
  || 'esbuild';

const esbuildBin = existsSync(ESBUILD) ? ESBUILD : 'esbuild';

console.log(`→ бандлю ${ENTRY} …`);
execFileSync(
  esbuildBin,
  [ENTRY, '--bundle', '--format=iife', '--target=es2020', '--minify', `--outfile=${OUT_JS}`],
  { cwd: ROOT, stdio: 'inherit' },
);

const js = readFileSync(OUT_JS, 'utf8');
const css = readFileSync(join(ROOT, 'css', 'style.css'), 'utf8');
let html = readFileSync(join(ROOT, 'index.html'), 'utf8');

// CSS inline вместо ссылки
html = html.replace(
  /<link rel="stylesheet" href="css\/style\.css">/,
  `<style>\n${css}\n</style>`,
);

// Скрипт inline вместо модуля. </script> внутри строк исключаем escape'ом.
html = html.replace(
  /<script type="module" src="js\/main\.js"><\/script>/,
  `<script>\n${js.replace(/<\/script>/gi, '<\\/script>')}\n</script>`,
);

if (html.includes('js/main.js') || html.includes('css/style.css')) {
  console.error('✕ не все ссылки заменены — проверь index.html');
  process.exit(1);
}

writeFileSync(OUT_HTML, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`✓ ${OUT_HTML} (${kb} КБ) — открывается двойным кликом`);
