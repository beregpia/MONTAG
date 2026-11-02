/* ============ Пакетная индексация папки с дорожками ============
 *
 * Вы выгрузили из Pro Tools несколько дорожек в одну папку — этот инструмент
 * проиндексирует их все разом: сегментация, дескрипторы, стопа L/R, темп.
 * Имя файла (без расширения) становится категорией.
 *
 *   node tools/index-library.mjs --dir "C:/foley/steps 02-04"
 *   node tools/index-library.mjs --dir . --gap 0.25          # свой порог для всех
 *
 * min-gap подбирается по имени файла: у шагов события реже, чем у рук, поэтому
 * у шагов порог 0.30 с, у рук 0.12 с. Имя вида «steps 02» поймёт как шаги.
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DIR = arg('dir', '.');
const GAP = arg('gap', '');

if (!existsSync(DIR) || !statSync(DIR).isDirectory()) {
  console.error(`Нет папки ${DIR}`);
  process.exit(1);
}

/* Подсказки по порогу сегментации — по смыслу имени дорожки. */
const GAP_HINTS = [
  [/step|шаг|foot|walk|ног|ходьб/i, 0.30],
  [/hand|heand|рук/i, 0.12],
  [/cloth|ткан|rustl|шурш|coat/i, 0.20],
  [/door|двер|impact|удар|boom|slam/i, 0.30],
  [/prop|реквиз|key|money|cup|chair/i, 0.18],
];
const gapFor = (name) => {
  if (GAP) return Number(GAP);
  for (const [re, g] of GAP_HINTS) if (re.test(name)) return g;
  return 0.15;
};

const wavs = readdirSync(DIR).filter((f) => /\.wav$/i.test(f)).sort();

/* «steps 02» → категория «steps», проход «02».
 * Так три прохода шагов складываются в одну категорию, и движок может выбирать
 * между ними, а не считать тремя разными категориями. */
function splitName(name) {
  const m = name.match(/^(.*?)[\s_-]+(\d{1,3})$/);
  if (m && m[1].trim()) return { category: m[1].trim(), pass: m[2] };
  return { category: name.trim(), pass: '' };
}
if (!wavs.length) {
  console.error(`В ${DIR} нет WAV-файлов`);
  process.exit(1);
}

console.log(`Индексация папки: ${DIR}`);
console.log(`Найдено дорожек: ${wavs.length}`);
console.log('');
console.log(`  ${'файл'.padEnd(24)} ${'категория'.padEnd(12)} ${'проход'.padEnd(8)} ${'min-gap'.padEnd(9)} событий`);
console.log('  ' + '-'.repeat(72));

let total = 0;
const indexFiles = [];
for (const f of wavs) {
  const name = basename(f).replace(/\.wav$/i, '');
  const { category: cat, pass } = splitName(name);
  const gap = gapFor(name);
  const out = join(DIR, `${name}.index.json`);
  try {
    const stdout = execFileSync(process.execPath, ['tools/foley-library.mjs',
      '--track', join(DIR, f),
      '--category', cat,
      '--pass', pass || name,
      '--min-gap', String(gap),
      '--out', out,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    const idx = JSON.parse(existsSync(out) ? readFileSync(out, 'utf8') : '{}');
    const n = (idx.events || []).length;
    total += n;
    indexFiles.push(out);
    console.log(`  ${f.padEnd(24)} ${cat.padEnd(12)} ${(pass || '—').padEnd(8)} ${String(gap).padEnd(9)} ${n}`);
  } catch (err) {
    console.log(`  ${f.padEnd(24)} ${'ОШИБКА'.padEnd(12)} ${(pass || '—').padEnd(8)} ${String(gap).padEnd(9)} ${String(err.message).split('\n')[0]}`);
  }
}

console.log('  ' + '-'.repeat(72));
console.log(`Всего событий в индексе: ${total}`);
console.log('');
console.log('Индексы лежат рядом с дорожками. Дальше:');
console.log(`  node tools/place-foley.mjs --library "${DIR}" --video events.json`);
console.log('');
console.log('Если дорожка — записанный проход по картинке (артист шёл, глядя на неё),');
console.log('индекс не нужен, ведите её напрямую на регистрацию:');
console.log(`  node tools/align-pass.mjs --track "${join(DIR, wavs[0])}" --targets events.json`);
