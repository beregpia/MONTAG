/* ============ Сборка Windows-приложения ============
 *
 *   npm run build:win
 *
 * Пакует приложение вместе с рантаймом Electron в папку dist/MONTAG-win32-x64.
 * Внутри — MONTAG.exe: двойной клик, и программа открывается. Папку можно
 * зазиповать и перенести на любой Windows (даже без Node и без интернета).
 *
 * Размер около 200 МБ — это цена настоящего .exe. Если нужен вариант полегче,
 * смотрите MONTAG.bat в корне: тот же эффект без установки, весом 100 КБ.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = `${ROOT}dist`;

if (!existsSync(`${ROOT}montag-standalone.html`)) {
  console.error('Нет montag-standalone.html. Сначала: npm run build');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const args = [
  'electron-packager', ROOT, 'MONTAG',
  '--platform=win32',
  '--arch=x64',
  '--out', OUT,
  '--overwrite',
  '--asar',
  '--ignore=^\\.git($|/)',
  '--ignore=^node_modules($|/)',
  '--ignore=^dist($|/)',
  '--ignore=^tools/fixtures($|/)',
  '--ignore=^tests($|/)',
  '--ignore=^research($|/)',
  '--app-version=1.0.0',
  '--build-version=1.0.0',
];

console.log('→ собираю Windows-приложение (скачивается рантайм Electron ~100 МБ)…');
console.log(`  npx ${args.join(' ')}`);

const child = spawn('npx', args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' });
child.on('exit', (code) => {
  if (code === 0) {
    console.log('');
    console.log('✓ Готово: dist/MONTAG-win32-x64/MONTAG.exe');
    console.log('  Зазипкуйте папку MONTAG-win32-x64 и перенесите на любой Windows.');
  } else {
    console.error(`Сборка не удалась (код ${code})`);
    process.exit(code ?? 1);
  }
});
