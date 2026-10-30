/* ============ Таймкод: перевод в секунды и обратно ============
 *
 * Нужен при экспорте фрагмента: HandBrake и ffmpeg принимают диапазон в
 * секундах от начала файла, а в Pro Tools вы оперируете таймкодом сессии.
 * Этот мостик считает за вас и печатает готовые числа.
 *
 *   node tools/tc.mjs 01:04:12:07 --fps 25 --start 01:00:00:00
 *   node tools/tc.mjs 252.28 --fps 25 --start 01:00:00:00     (обратно)
 *   node tools/tc.mjs --range 01:04:12:07 00:01:00:00 --fps 25 --start 01:00:00:00
 */
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FPS = Number(arg('fps', 25));
const START = arg('start', '00:00:00:00');
const RANGE = (() => {
  const i = argv.indexOf('--range');
  return i >= 0 && argv[i + 1] && argv[i + 2] ? `${argv[i + 1]} ${argv[i + 2]}` : '';
})();

function parseTC(s) {
  const m = String(s).trim().match(/^(\d+):(\d+):(\d+)[:;](\d+)$/);
  if (!m) return null;
  return { h: +m[1], m: +m[2], s: +m[3], f: +m[4] };
}
function tcToSec(tc) {
  const p = parseTC(tc);
  if (!p) return null;
  return p.h * 3600 + p.m * 60 + p.s + p.f / FPS;
}
function secToTC(sec) {
  const total = Math.max(0, Math.round(sec * FPS));
  const f = total % FPS;
  const s = Math.floor(total / FPS) % 60;
  const m = Math.floor(total / (FPS * 60)) % 60;
  const h = Math.floor(total / (FPS * 3600));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}
const startSec = tcToSec(START) ?? 0;

console.log(`fps ${FPS} · стартовый ТК сессии ${START} (= ${startSec} с от начала файла)`);
console.log('');

if (RANGE) {
  const [a, b] = RANGE.split(/\s+/);
  const secA = tcToSec(a);
  const secB = tcToSec(b);
  if (secA == null || secB == null) { console.error('Диапазон: два таймкода через пробел'); process.exit(1); }
  const from = secA - startSec;
  const to = secB - startSec;
  console.log('  HandBrake / ffmpeg берут диапазон в секундах от начала файла:');
  console.log(`    начало  ${from.toFixed(3)} с   (ТК ${a})`);
  console.log(`    конец   ${to.toFixed(3)} с   (ТК ${b})`);
  console.log(`    длина   ${(to - from).toFixed(3)} с`);
  console.log('');
  console.log('  Готовые команды:');
  console.log(`    ffmpeg -ss ${from.toFixed(3)} -to ${to.toFixed(3)} -i movie.mov -c:v libx264 -c:a aac fragment.mp4`);
  console.log(`    HandBrake: Range → Seconds, с ${from.toFixed(2)} по ${to.toFixed(2)}`);
  console.log('');
  console.log('  Эти же числа — начало фрагмента для движка:');
  console.log(`    фрагмент начинается с ТК ${a}, т.е. ${from.toFixed(3)} с от начала файла`);
  process.exit(0);
}

const input = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a) || /^\d+:\d+:\d+:\d+$/.test(a))[0]
  || argv.filter((a) => !a.startsWith('--') && !['fps', 'start', 'range'].includes(argv[argv.indexOf(a) - 1]?.replace(/^--/, '')))[0];

if (input && /^\d+:\d+:\d+[:;]\d+$/.test(input)) {
  const sec = tcToSec(input);
  const rel = sec - startSec;
  console.log(`  ТК ${input} → ${sec.toFixed(4)} с от начала файла`);
  console.log(`  относительно старта сессии: ${rel.toFixed(4)} с`);
  console.log(`  абсолютный кадр: ${Math.round(sec * FPS)}`);
  console.log(`  для HandBrake: ${rel.toFixed(3)}`);
} else if (input && /^\d+(\.\d+)?$/.test(input)) {
  const sec = Number(input);
  console.log(`  ${sec} с от начала файла → ТК ${secToTC(sec + startSec)}`);
  console.log(`  ${sec} с от старта сессии → ТК ${secToTC(startSec + sec)}`);
  console.log(`  абсолютный кадр: ${Math.round((sec + startSec) * FPS)}`);
} else {
  console.log('  Использование:');
  console.log('    node tools/tc.mjs 01:04:12:07 --fps 25 --start 01:00:00:00');
  console.log('    node tools/tc.mjs --range 01:04:12:07 01:05:12:07 --fps 25 --start 01:00:00:00');
  console.log('    node tools/tc.mjs 252.28 --fps 25 --start 01:00:00:00');
}
