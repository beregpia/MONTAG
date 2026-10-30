/* ============ Фикстура «дубль против картинки» ============
 *
 * Имитирует реальную ситуацию из вашей сессии Pro Tools: фоли-артист записал
 * проход по картинке, но у него свой темп и свой сдвиг, поэтому проход нужно
 * привести к кадрам контакта стопы.
 *
 *   Картинка: 25 контактов стопы, темп 0.580 с (джиттер ±20 мс)
 *   Дубль:    25 шагов + 1 лишний, темп 0.585 с, сдвиг +7.03 с
 *
 *   node tools/make-align-fixture.mjs
 */
import { writeWav } from './lib/wav.mjs';
import { writeFileSync } from 'node:fs';

const SR = 44100;
const FPS = 25;
const PIC_CAD = 0.580;
const PASS_CAD = 0.585;

/* ---- картинка: кадры контакта стопы (ground truth) ---- */
const targets = [];
let t = 10.3;
for (let i = 0; i < 25; i++) {
  targets.push({ frame: Math.round(t * FPS), time: t, side: i % 2 ? 'R' : 'L', strength: 0.5 + 0.5 * ((i % 3) / 2) });
  t += PIC_CAD + (Math.random() * 0.04 - 0.02);
}

/* ---- дубль: шаги артиста, свой темп, свой сдвиг, один лишний шаг ---- */
const steps = [];
t = 9.9;
for (let i = 0; i < 25; i++) {
  steps.push({ time: t, side: i % 2 ? 'R' : 'L' });
  t += PASS_CAD + (Math.random() * 0.04 - 0.02);
}
steps.splice(12, 0, { time: steps[11].time + 0.30, side: 'X' }); // лишний шаг артиста

const DUR = 30;
const out = new Float32Array(DUR * SR);
for (const s of steps) {
  const start = Math.round(s.time * SR);
  const n = Math.round(0.22 * SR);
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= out.length) continue;
    const tt = i / SR;
    const env = Math.exp(-tt / 0.05) * (1 - Math.exp(-tt / 0.0012));
    let ph = (2 * Math.PI * 62 * (1 - 0.4 * (tt / 0.22))) / SR;
    out[idx] += 0.8 * env * (Math.sin(ph) + 0.9 * (Math.random() * 2 - 1));
  }
}
for (let k = 0; k < out.length; k++) out[k] += 0.004 * (Math.random() * 2 - 1);

writeWav('tools/fixtures/align-pass.wav', { sampleRate: SR, channels: [out] });
writeFileSync('tools/fixtures/align-targets.json', `${JSON.stringify({
  video: 'demo-scene', fps: FPS,
  events: targets,
}, null, 2)}\n`);
writeFileSync('tools/fixtures/align-truth.json', `${JSON.stringify({
  fps: FPS,
  k: PIC_CAD / PASS_CAD,
  offsetSeconds: targets[0].time - (PIC_CAD / PASS_CAD) * steps[0].time,
  pictureCadence: PIC_CAD,
  passCadence: PASS_CAD,
  passEvents: steps.length,
  pictureEvents: targets.length,
}, null, 2)}\n`);

console.log(`✓ tools/fixtures/align-pass.wav — дубль ${DUR} с, ${steps.length} шагов (темп ${PASS_CAD} с)`);
console.log(`✓ tools/fixtures/align-targets.json — картинка: ${targets.length} контактов стопы (темп ${PIC_CAD} с)`);
console.log(`  Сдвиг дубля: +${(targets[0].time - (PIC_CAD / PASS_CAD) * steps[0].time).toFixed(3)} с`);
console.log(`  Настоящие параметры: k=${(PIC_CAD / PASS_CAD).toFixed(5)}, сдвиг +${(targets[0].time - (PIC_CAD / PASS_CAD) * steps[0].time).toFixed(3)} с`);
