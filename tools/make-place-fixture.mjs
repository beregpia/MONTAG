/* ============ Фикстура «сессия против картинки» для размещения ============
 *
 * Имитирует рабочую ситуацию из вашей сессии Pro Tools: каждая категория
 * записана своей дорожкой (свой файл), а на картинке в тех же категориях
 * происходят события. Категорий намеренно четыре и одна из них — «руки»,
 * чтобы показать, что движок не знает списка категорий заранее.
 *
 *   node tools/make-place-fixture.mjs
 */
import { writeWav } from './lib/wav.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const SR = 44100;
const FPS = 25;
mkdirSync('tools/fixtures/lib', { recursive: true });

/* ---------- синтез по категориям ---------- */
function thump(dur, freq, noise) {
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    const env = Math.exp(-tt / 0.05) * (1 - Math.exp(-tt / 0.0012));
    ph += (2 * Math.PI * freq * (1 - 0.4 * (tt / dur))) / SR;
    out[i] = env * (Math.sin(ph) + noise * (Math.random() * 2 - 1));
  }
  return out;
}
function click(dur, freq) {
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    out[i] = Math.exp(-tt / 0.004) * (Math.sin(2 * Math.PI * freq * tt) + 0.5 * (Math.random() * 2 - 1));
  }
  return out;
}
function rustle(dur) {
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    lp += 0.05 * ((Math.random() * 2 - 1) - lp);
    out[i] = Math.sin((Math.PI * tt) / dur) ** 1.5 * lp * 6;
  }
  return out;
}
function render(events, totalDur) {
  const out = new Float32Array(totalDur * SR);
  for (const e of events) {
    const s = e.kind === 'gravel' ? thump(0.22, 62, 0.9)
      : e.kind === 'wood' ? thump(0.14, 130, 0.15)
        : e.kind === 'hand' ? click(0.06, 2600)
          : e.kind === 'cloth' ? rustle(0.5) : thump(0.5, 90, 0.2);
    const start = Math.round(e.time * SR);
    for (let i = 0; i < s.length; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= out.length) continue;
      out[idx] += e.amp * s[i];
    }
  }
  for (let k = 0; k < out.length; k++) out[k] += 0.004 * (Math.random() * 2 - 1);
  return out;
}

/* ---------- дорожки сессии (по одной на категорию) ---------- */
const tracks = {
  steps: [], hands: [], cloth: [], door: [], metal: [],
};
let t = 1.0;
for (let i = 0; i < 8; i++) { tracks.steps.push({ time: t, kind: i % 2 ? 'gravel' : 'wood', amp: i % 3 === 0 ? 0.9 : 0.5 }); t += 0.62; }
t = 1.4;
for (let i = 0; i < 7; i++) { tracks.hands.push({ time: t, kind: 'hand', amp: 0.4 + 0.4 * ((i % 3) / 2) }); t += 0.55; }
t = 2.0;
for (let i = 0; i < 5; i++) { tracks.cloth.push({ time: t, kind: 'cloth', amp: 0.3 + 0.2 * (i % 2) }); t += 1.6; }
t = 4.2;
for (let i = 0; i < 2; i++) { tracks.door.push({ time: t, kind: 'door', amp: 0.95 }); t += 3.5; }
t = 1.2;
for (let i = 0; i < 3; i++) { tracks.metal.push({ time: t, kind: 'hand', amp: 0.6 + 0.2 * (i % 2) }); t += 2.1; }

const DUR = 8;
for (const [name, evs] of Object.entries(tracks)) {
  writeWav(`tools/fixtures/lib/${name}.wav`, { sampleRate: SR, channels: [render(evs, DUR)] });
}

/* ---------- картинка: события в тех же категориях ---------- */
const picture = [];
for (let i = 0; i < 8; i++) {
  picture.push({
    frame: Math.round((3.0 + i * 0.62) * FPS), time: Number((3.0 + i * 0.62).toFixed(4)),
    category: 'steps', zone: [0.45, 0.62, 0.07, 0.12], strength: i % 3 === 0 ? 0.9 : 0.5,
    duration: i % 2 ? 0.14 : 0.22,
  });
}
for (let i = 0; i < 7; i++) {
  picture.push({
    frame: Math.round((3.3 + i * 0.55) * FPS), time: Number((3.3 + i * 0.55).toFixed(4)),
    category: 'hands', zone: [0.5, 0.4, 0.09, 0.09], strength: 0.4 + 0.4 * ((i % 3) / 2),
    duration: 0.06,
  });
}
for (let i = 0; i < 5; i++) {
  picture.push({
    frame: Math.round((4.5 + i * 1.6) * FPS), time: Number((4.5 + i * 1.6).toFixed(4)),
    category: 'cloth', zone: [0.3, 0.35, 0.2, 0.25], strength: i % 2 ? 0.3 : 0.5,
    duration: 0.5,
  });
}
picture.push({
  frame: Math.round(6.0 * FPS), time: 6.0, category: 'door', zone: [0.1, 0.3, 0.25, 0.5],
  strength: 0.95, duration: 0.5,
});
// событие категории, которой нет в коде движка, но есть дорожка — должно работать
picture.push({
  frame: Math.round(2.2 * FPS), time: 2.2, category: 'metal', zone: [0.6, 0.5, 0.05, 0.05],
  strength: 0.6, duration: 0.06,
});
picture.push({
  frame: Math.round(4.3 * FPS), time: 4.3, category: 'metal', zone: [0.6, 0.5, 0.05, 0.05],
  strength: 0.8, duration: 0.06,
});
// событие категории, для которой дорожки нет — движок должен честно сказать
picture.push({
  frame: Math.round(7.0 * FPS), time: 7.0, category: 'paper', zone: [0.6, 0.5, 0.05, 0.05],
  strength: 0.7, duration: 0.2,
});
picture.sort((a, b) => a.time - b.time);

writeFileSync('tools/fixtures/place-video.json', `${JSON.stringify({
  video: 'demo-scene', fps: FPS,
  events: picture,
}, null, 2)}\n`);

console.log(`✓ 5 дорожек в tools/fixtures/lib/: steps (8), hands (7), cloth (5), door (2), metal (3)`);
console.log(`✓ tools/fixtures/place-video.json — картинка: ${picture.length} событий в 6 категориях`);
console.log(`  «metal» в коде движка не описан — работает на общем профиле; «paper» без дорожки — будет назван напрямую`);
