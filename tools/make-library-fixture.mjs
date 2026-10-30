/* ============ Синтетический «фоли-дубль» для демо индексатора ============
 *
 * Имитирует студийную запись фоли: один непрерывный дубль, внутри которого
 * много разных событий — шаги по гравию и по дереву (сильные/слабые,
 * с разной длительностью), щелчки, шуршание ткани, хлопок двери.
 *
 *   node tools/make-library-fixture.mjs
 */
import { writeWav } from './lib/wav.mjs';

const SR = 44100;

function addThump(out, t, { freq = 60, dur = 0.2, amp = 0.8, noise = 0.0 }) {
  const start = Math.round(t * SR);
  const n = Math.round(dur * SR);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= out.length) continue;
    const tt = i / SR;
    const env = Math.exp(-tt / 0.05) * (1 - Math.exp(-tt / 0.0012));
    phase += (2 * Math.PI * freq * (1 - 0.4 * (tt / dur))) / SR;
    out[idx] += amp * env * (Math.sin(phase) + noise * (Math.random() * 2 - 1));
  }
}

function addClick(out, t, { freq = 2400, dur = 0.04, amp = 0.5 }) {
  const start = Math.round(t * SR);
  const n = Math.round(dur * SR);
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= out.length) continue;
    const tt = i / SR;
    out[idx] += amp * Math.exp(-tt / 0.005) * (Math.sin(2 * Math.PI * freq * tt) + 0.4 * (Math.random() * 2 - 1));
  }
}

function addRustle(out, t, { dur = 0.45, amp = 0.35 }) {
  const start = Math.round(t * SR);
  const n = Math.round(dur * SR);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= out.length) continue;
    const tt = i / SR;
    lp += 0.05 * ((Math.random() * 2 - 1) - lp);
    const env = Math.sin((Math.PI * tt) / dur) ** 1.5; // плавный подъём-спад
    out[idx] += amp * env * lp * 6;
  }
}

function addDoor(out, t) {
  addThump(out, t, { freq: 90, dur: 0.5, amp: 0.95 });
  addRustle(out, t + 0.02, { dur: 0.3, amp: 0.2 });
}

/* ---------- сценарий дубля: 25 секунд «фоли-пасса» ---------- */
const DUR = 25;
const script = [];
let t = 0.8;
let i = 0;
// серия шагов по гравию (шумный низ), чередование сильный/слабый = левая/правая
while (t < 9) {
  script.push({ t, kind: 'gravel', strong: i % 2 === 0 });
  t += 0.62;
  i++;
}
// серия шагов по дереву (меньше шума, короче затухание)
i = 0;
t = 10.2;
while (t < 15) {
  script.push({ t, kind: 'wood', strong: i % 2 === 0 });
  t += 0.55;
  i++;
}
// реквизит: щелчки и хлопок двери
script.push({ t: 15.9, kind: 'click' });
script.push({ t: 16.4, kind: 'click' });
script.push({ t: 17.0, kind: 'door' });
// ткань
script.push({ t: 18.1, kind: 'cloth' });
script.push({ t: 19.0, kind: 'cloth' });
// снова шаги, но тише (актёр отошёл)
t = 20.3;
i = 0;
while (t < 24) {
  script.push({ t, kind: 'gravel', strong: false });
  t += 0.7;
  i++;
}

const out = new Float32Array(DUR * SR);
for (const e of script) {
  if (e.kind === 'gravel') addThump(out, e.t, { freq: 62, dur: 0.22, amp: e.strong ? 0.9 : 0.45, noise: 0.9 });
  else if (e.kind === 'wood') addThump(out, e.t, { freq: 130, dur: 0.14, amp: e.strong ? 0.75 : 0.4, noise: 0.15 });
  else if (e.kind === 'click') addClick(out, e.t, { amp: 0.5 });
  else if (e.kind === 'cloth') addRustle(out, e.t, { dur: 0.5, amp: 0.35 });
  else if (e.kind === 'door') addDoor(out, e.t);
}
// room tone
for (let k = 0; k < out.length; k++) out[k] += 0.005 * (Math.random() * 2 - 1);

writeWav('tools/fixtures/library-pass.wav', { sampleRate: SR, channels: [out] });

const { writeFileSync } = await import('node:fs');
writeFileSync('tools/fixtures/library-pass.json', `${JSON.stringify({
  description: 'Синтетический фоли-дубль: шаги по гравию и дереву, щелчки, ткань, дверь',
  sampleRate: SR,
  duration: DUR,
  truth: script.map((e) => ({ time: e.t, kind: e.kind })),
}, null, 2)}\n`);

console.log(`✓ tools/fixtures/library-pass.wav — дубль ${DUR} с, ${script.length} заложенных событий`);
console.log(`  ${script.map((e) => `${e.t.toFixed(1)}с/${e.kind}${e.strong === false ? '(тихо)' : ''}`).join(', ')}`);
