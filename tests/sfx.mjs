/* Проверка процедурного синтеза фоли-звуков. */
import { synthesize, SFX_LIST, sfxDuration, autoSfxFor } from '../js/sfx.js';

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fails++;
};

for (const { id } of SFX_LIST) {
  const s = synthesize(id, 48000, 7);
  let peak = 0;
  let energy = 0;
  let nan = false;
  for (let i = 0; i < s.data.length; i++) {
    const v = s.data[i];
    if (!Number.isFinite(v)) nan = true;
    peak = Math.max(peak, Math.abs(v));
    energy += v * v;
  }
  const rms = Math.sqrt(energy / s.data.length);
  check(`${id}: корректная длина`, Math.abs(s.duration - sfxDuration(id)) < 1e-6 && s.data.length === Math.round(sfxDuration(id) * 48000), `${s.duration.toFixed(3)}s`);
  check(`${id}: без NaN/Inf`, !nan);
  check(`${id}: без клиппинга (<= 1.0)`, peak <= 1.0001, `peak=${peak.toFixed(3)}`);
  check(`${id}: нормализован (peak >= 0.5)`, peak >= 0.5, `peak=${peak.toFixed(3)}`);
  check(`${id}: не тишина (rms > 0.005)`, rms > 0.005, `rms=${rms.toFixed(4)}`);
}

{
  const a = synthesize('step', 48000, 3);
  const b = synthesize('step', 48000, 3);
  let same = true;
  for (let i = 0; i < a.data.length; i++) if (Math.abs(a.data[i] - b.data[i]) > 1e-9) same = false;
  check('один seed — идентичный результат', same);
}

{
  const a = synthesize('step', 48000, 3);
  const b = synthesize('step', 48000, 4);
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) diff += Math.abs(a.data[i] - b.data[i]);
  check('разные seed — разный шум', diff > 1, `diff=${diff.toFixed(2)}`);
}

{
  const s = synthesize('cloth', 44100, 1);
  check('sampleRate 44100 → корректная длина', s.data.length === Math.round(sfxDuration('cloth') * 44100));
}

{
  const ok = autoSfxFor('low', 0.9, 1) === 'thud'
    && autoSfxFor('low', 0.9, 0) === 'step'
    && autoSfxFor('low', 0.2, 1) === 'heel'
    && autoSfxFor('low', 0.2, 3) === 'step_soft'
    && autoSfxFor('high', 0.5, 1) === 'click'
    && autoSfxFor('high', 0.5, 0) === 'object'
    && autoSfxFor('mid', 0.5, 1) === 'cloth';
  check('autoSfxFor маппит диапазоны', ok,
    `low strong → ${autoSfxFor('low', 0.9, 0)}/${autoSfxFor('low', 0.9, 1)}, ` +
    `low weak → ${autoSfxFor('low', 0.2, 1)}/${autoSfxFor('low', 0.2, 3)}, ` +
    `high → ${autoSfxFor('high', 0.5, 0)}/${autoSfxFor('high', 0.5, 1)}, ` +
    `mid → ${autoSfxFor('mid', 0.5, 1)}/${autoSfxFor('mid', 0.5, 0)}`);
}

{
  const a = synthesize('step', 48000, 1).data;
  const b = synthesize('click', 48000, 1).data;
  check('разные звуки отличаются', a.length !== b.length || a[100] !== b[100]);
}

console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nСинтез фоли-звуков работает');
process.exitCode = fails ? 1 : 0;
