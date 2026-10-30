/* ============ Демо-прогон всего контура размещения одной командой ============
 *
 *   node tools/run-place-demo.mjs      (или npm run place)
 *
 * Делает по шагам то, что происходит в реальной работе:
 *   1) синтезирует дорожки сессии (по одной на категорию) и события на картинке;
 *   2) индексирует каждую дорожку (сегментация + дескрипторы), со своим min-gap
 *      под категорию — у рук события чаще, чем у шагов;
 *   3) сопоставляет события на картинке с дублями и выдаёт расстановку.
 */
import { execFileSync } from 'node:child_process';

const run = (cmd, args) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit' });
};

const node = process.execPath;
const GAP = { steps: '0.3', hands: '0.12', cloth: '0.2', door: '0.3', metal: '0.15' };

run(node, ['tools/make-place-fixture.mjs']);
for (const [cat, gap] of Object.entries(GAP)) {
  run(node, ['tools/foley-library.mjs',
    '--track', `tools/fixtures/lib/${cat}.wav`,
    '--category', cat,
    '--min-gap', gap,
    '--out', `tools/fixtures/lib/${cat}.index.json`]);
}
run(node, ['tools/place-foley.mjs']);
