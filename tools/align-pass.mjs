/* ============ Приведение фоли-дубля к картинке (регистрация прохода) ============
 *
 * Задача из реальной сессии: артист записал проход, глядя на картинку, но у него
 * свой темп и свой сдвиг. Нужно привести его к кадрам контакта стопы: для
 * каждого контакта на картинке найти, из какого места дубля брать звук.
 *
 * Как решает:
 *   1) сегментируем дубль на шаги (готовый детектор js/onset.js);
 *   2) грубый сдвиг — «гистограмма разностей»;
 *   3) сопоставление через **динамическое программирование с полосой**:
 *      монотонно, один к одному, с пропусками (лишний шаг артиста / пропущенный
 *      контакт). Именно это лечит «съезд на шаг» — при почти периодических шагах
 *      жадный поиск цепляет неверное соответствие и весь конец прохода уезжает;
 *   4) линейная модель t = k·s + d убирает накопившийся дрейф темпа
 *      (2 итерации: DP → МНК по согласованным парам → DP).
 *
 *   node tools/align-pass.mjs --track T.wav --targets T.json [--fps 25]
 *                             [--tol 0.08] [--max-shift 5] [--handles 0.05]
 */
import { readFileSync, existsSync } from 'node:fs';
import { detectOnsets } from '../js/onset.js';
import { readWav, toMono } from './lib/wav.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const TRACK = arg('track', 'tools/fixtures/align-pass.wav');
const TARGETS = arg('targets', 'tools/fixtures/align-targets.json');
const TOL = Number(arg('tol', 0.08));
const MAX_SHIFT = Number(arg('max-shift', 30));
const HANDLES = Number(arg('handles', 0.05));
const CUT_LEN = Number(arg('cut-len', 0.25));
const BAND = Number(arg('band', 96));
const SKIP_SRC = 0.7;  // штраф за лишний шаг в дубле
const SKIP_TGT = 0.7;  // штраф за незакрытый контакт на картинке

if (!existsSync(TRACK)) { console.error(`Нет ${TRACK}`); process.exit(1); }
if (!existsSync(TARGETS)) { console.error(`Нет ${TARGETS}`); process.exit(1); }

const wav = readWav(TRACK);
const mono = toMono(wav);
const SR = wav.sampleRate;
const tj = JSON.parse(readFileSync(TARGETS, 'utf8'));
const FPS = tj.fps || Number(arg('fps', 25));
const targets = tj.events.map((e) => ({ ...e, time: e.time ?? (e.frame / FPS) })).sort((a, b) => a.time - b.time);
const tgt = targets.map((t) => t.time);

/* ---------- 1. шаги дубля ---------- */
const onsets = detectOnsets(mono, SR, { sensitivity: 1, minGap: 0.3, maxEvents: 5000 });
if (onsets.length < 2) { console.error('В дубле не найдено шагов'); process.exit(1); }

/* Уточнение времени атаки до отсчёта: детектор выдаёт время кадра анализа
 * (шаг 11.6 мс) плюс запаздывание на атаку. Ищем первый момент, где сигнал
 * превысил 15% пика и держится 3 мс — это и есть касание. */
function refineTime(t) {
  const center = Math.round(t * SR);
  const from = Math.max(0, center - Math.round(0.03 * SR));
  const end = Math.min(mono.length, from + Math.round(0.3 * SR));
  let peak = 0;
  for (let i = from; i < end; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }
  if (peak <= 0) return t;
  const thr = peak * 0.15;
  const hold = Math.round(0.003 * SR);
  let above = 0;
  for (let i = from; i < end; i++) {
    if (Math.abs(mono[i]) >= thr) { if (++above >= hold) return (i - hold + 1) / SR; }
    else above = 0;
  }
  return t;
}
const srcT = onsets.map((o) => refineTime(o.time));

/* ---------- 2. грубый сдвиг ---------- */
function countAt(d) {
  let n = 0;
  for (const s of srcT) {
    const t = s + d;
    for (const g of tgt) if (Math.abs(g - t) <= TOL) { n++; break; }
  }
  return n;
}
const scored = [];
for (let d = -MAX_SHIFT; d <= MAX_SHIFT; d += 0.01) scored.push([countAt(d), d]);
scored.sort((a, b) => b[0] - a[0]);
const coarseD = scored[0][1];

/* ---------- 3. DP-сопоставление ---------- */
function better(m1, c1, m2, c2) { return m1 > m2 || (m1 === m2 && c1 < c2 - 1e-9); }

function dp(k, d) {
  const N = srcT.length;
  const M = tgt.length;
  const W = 2 * BAND + 3;
  const m = new Int32Array((N + 1) * W).fill(-1);
  const c = new Float32Array((N + 1) * W).fill(Infinity);
  const b = new Int8Array((N + 1) * W).fill(-1);
  const jOf = (i, j) => j - (i - BAND) + 1; // локальный индекс
  m[jOf(0, 0)] = 0; c[jOf(0, 0)] = 0;

  for (let i = 0; i <= N; i++) {
    const jLo = Math.max(0, i - BAND);
    const jHi = Math.min(M, i + BAND);
    for (let j = jLo; j <= jHi; j++) {
      if (i === 0 && j === 0) continue;
      const idx = i * W + jOf(i, j);
      let bm = -1, bc = Infinity, bb = -1;
      if (i > 0) {
        const jj = jOf(i - 1, j);
        if (j - (i - 1 - BAND) + 1 >= 0 && jj < W) {
          const p = (i - 1) * W + jj;
          if (m[p] >= 0 && better(m[p], c[p] + SKIP_SRC, bm, bc)) { bm = m[p]; bc = c[p] + SKIP_SRC; bb = 1; }
        }
      }
      if (j > 0) {
        const jj = jOf(i, j - 1);
        if (j - 1 - (i - BAND) + 1 >= 0 && jj < W) {
          const p = i * W + jj;
          if (m[p] >= 0 && better(m[p], c[p] + SKIP_TGT, bm, bc)) { bm = m[p]; bc = c[p] + SKIP_TGT; bb = 2; }
        }
      }
      if (i > 0 && j > 0) {
        const resid = Math.abs(k * srcT[i - 1] + d - tgt[j - 1]);
        if (resid <= TOL) {
          const jj = jOf(i - 1, j - 1);
          if (j - 1 - (i - 1 - BAND) + 1 >= 0 && jj < W) {
            const p = (i - 1) * W + jj;
            if (m[p] >= 0 && better(m[p] + 1, c[p] + resid * resid, bm, bc)) { bm = m[p] + 1; bc = c[p] + resid * resid; bb = 0; }
          }
        }
      }
      m[idx] = bm; c[idx] = bc; b[idx] = bb;
    }
  }
  // обратный ход
  const assign = new Map(); // j -> {i, resid}
  let i = N, j = M;
  if (m[i * W + jOf(i, j)] < 0) return { matched: 0, assign: new Map(), cost: Infinity };
  while (i > 0 || j > 0) {
    const bb = b[i * W + jOf(i, j)];
    if (bb === 0) {
      assign.set(j - 1, { i: i - 1, resid: Math.abs(k * srcT[i - 1] + d - tgt[j - 1]) });
      i--; j--;
    } else if (bb === 1) { i--; } else if (bb === 2) { j--; } else break;
  }
  return { matched: assign.size, assign, cost: c[N * W + jOf(N, M)] };
}

/* ---------- 4. подбор k и d: грубая 2D-сетка, потом уточнение ---------- */
let best = null;
const consider = (k, d) => {
  const r = dp(k, d);
  if (!best || better(r.matched, r.cost, best.matched, best.cost)) best = { ...r, k, d };
};
for (let k = 0.90; k <= 1.101; k += 0.01) {
  for (let d = -MAX_SHIFT; d <= MAX_SHIFT; d += 0.02) consider(k, d);
}
for (let k = best.k - 0.012; k <= best.k + 0.0121; k += 0.002) {
  for (let d = best.d - 0.06; d <= best.d + 0.0601; d += 0.01) consider(k, d);
}
for (let k = best.k - 0.003; k <= best.k + 0.0031; k += 0.0005) {
  for (let d = best.d - 0.012; d <= best.d + 0.0121; d += 0.002) consider(k, d);
}
// уточнение: МНК по согласованным парам, затем снова DP
for (let iter = 0; iter < 3; iter++) {
  const pairs = [];
  for (const [j, v] of best.assign) pairs.push([srcT[v.i], tgt[j]]);
  if (pairs.length < 2) break;
  const n = pairs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-9) break;
  const nk = (n * sxy - sx * sy) / den;
  const nd = (sy - nk * sx) / n;
  const r = dp(nk, nd);
  if (better(r.matched, r.cost, best.matched, best.cost)) best = { ...r, k: nk, d: nd };
  else if (r.matched === best.matched && r.cost < best.cost + 0.5) best = { ...r, k: nk, d: nd };
  else break;
}
const K = best.k;
const D = best.d;
const assign = best.assign;

/* ---------- 5. размещения ---------- */
const placements = targets.map((g, j) => {
  const hit = assign.get(j);
  if (!hit) {
    return {
      targetTime: Number(g.time.toFixed(4)), targetFrame: Math.round(g.time * FPS),
      targetTimecode: tc(g.time, FPS), side: g.side || null, sourceTime: null,
      residualMs: null, matched: false, reason: 'в дубле нет подходящего шага',
    };
  }
  const resid = hit.resid;
  return {
    targetTime: Number(g.time.toFixed(4)), targetFrame: Math.round(g.time * FPS),
    targetTimecode: tc(g.time, FPS), side: g.side || null,
    sourceTime: Number(srcT[hit.i].toFixed(4)),
    residualMs: Number((resid * 1000).toFixed(1)),
    // «проверить» — модель плохо объясняет эту пару: возможно съезд на шаг
    verify: resid > 1.5 / FPS,
    cutFrom: Number((srcT[hit.i] - HANDLES).toFixed(4)),
    cutTo: Number((srcT[hit.i] + CUT_LEN + HANDLES).toFixed(4)),
    matched: true,
  };
});
const used = new Set([...assign.values()].map((v) => v.i));
const unused = srcT.map((t, i) => ({ time: t, i })).filter((s) => !used.has(s.i));

/* ---------- вывод ---------- */
const pad = (s, n, r = false) => { s = String(s); return r ? s + ' '.repeat(Math.max(0, n - s.length)) : ' '.repeat(Math.max(0, n - s.length)) + s; };
const frameMs = 1000 / FPS;
console.log('='.repeat(100));
console.log(`Приведение дубля к картинке: ${TRACK}`);
console.log(`шагов в дубле: ${srcT.length} · контактов на картинке: ${targets.length} · допуск ${(TOL * 1000).toFixed(0)} мс (${TOL * FPS} к) · ${FPS} к/с`);
console.log('='.repeat(100));
console.log(`Модель регистрации: t = ${K.toFixed(5)}·s ${D >= 0 ? '+' : '−'} ${Math.abs(D).toFixed(4)} с`);
console.log(`  темп дубля отличается от картинки на ${((K - 1) * 100).toFixed(2)}%`);
const drift = Math.abs(K - 1) * (tgt.at(-1) - tgt[0]);
console.log(`  накопленный дрейф темпа за проход: ${(drift * 1000).toFixed(0)} мс (${(drift * FPS).toFixed(1)} кадра)`);
console.log('-'.repeat(100));
console.log(`${pad('ТК на картинке', 13)} ${pad('кадр', 6)} ${pad('стопа', 5)} ${pad('взять из дубля', 15)} ${pad('вырез', 18)} ${pad('пара', 6)} ${pad('примечание', 20)}`);
for (const p of placements) {
  if (p.matched) {
    console.log(`${pad(p.targetTimecode, 13)} ${pad(p.targetFrame, 6)} ${pad(p.side || '—', 5)} `
      + `${pad(p.sourceTime.toFixed(3) + 'с', 15)} ${pad(p.cutFrom.toFixed(2) + '–' + p.cutTo.toFixed(2), 18)} `
      + `${pad('✓', 6)} ${pad(p.verify ? 'проверить вручную' : '', 20)}`);
  } else {
    console.log(`${pad(p.targetTimecode, 13)} ${pad(p.targetFrame, 6)} ${pad(p.side || '—', 5)} `
      + `${pad('— НЕТ ДУБЛЯ —', 15)} ${pad('', 18)} ${pad('—', 6)} ${pad(p.reason, 20)}`);
  }
}
console.log('='.repeat(100));
const ok = placements.filter((p) => p.matched);
const errs = ok.map((p) => p.residualMs);
const mean = errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length);
const flagged = ok.filter((p) => p.verify).length;
console.log(`Соответствие: размещено ${ok.length} из ${targets.length} контактов · незакрытых ${placements.length - ok.length} · лишних шагов в дубле ${unused.length}`);
console.log(`Уверенность пары: средний остаток ${mean.toFixed(1)} мс, максимум ${errs.length ? Math.max(...errs).toFixed(1) : 0} мс, помечено «проверить» ${flagged}`);
console.log('');
console.log('ВАЖНО: «остаток» — это насколько линейная модель объясняет пару, а НЕ ошибка синхронности.');
console.log('      Звук вырезается из дубля в исходной точке и вставляется в кадр контакта, поэтому');
console.log('      точность расстановки ограничена только точностью кадра контакта на картинке.');
if (unused.length) console.log(`Не использованы шаги дубля: ${unused.map((s) => s.time.toFixed(2)).join(', ')} с`);

function tc(t, fps) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const f = Math.round((t - Math.floor(t)) * fps);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}
