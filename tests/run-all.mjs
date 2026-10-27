/* Прогон всех наборов тестов: node tests/run-all.mjs */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs' && f !== 'helpers.mjs')
  .sort();

const results = [];
for (const file of files) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], {
      cwd: new URL('..', import.meta.url),
      stdio: 'inherit',
    });
    child.on('exit', resolve);
  });
  results.push({ file, code });
}

console.log('\n' + '='.repeat(60));
const bad = results.filter((r) => r.code !== 0);
for (const r of results) console.log(`${r.code === 0 ? 'OK  ' : 'FAIL'} ${r.file}`);
console.log('='.repeat(60));
console.log(bad.length ? `\nПРОВАЛЕНО: ${bad.length} из ${results.length}` : `\nВСЕ ${results.length} НАБОРОВ ЗЕЛЁНЫЕ`);
process.exitCode = bad.length ? 1 : 0;
