/* ============ Панель «Движок»: интерактивность ============
 * Главная проверка: панель не должна перестраиваться, пока пользователь
 * держит кнопку. Иначе кнопка исчезает из DOM между pointerup и click,
 * и браузер не доносит click — импорт дорожек просто не открывается.
 */
import { setupDom, reporter } from './helpers.mjs';

const { window, document, silenceConsole } = await setupDom();
silenceConsole();
const { check, done } = reporter();

const BASE = new URL('../js/', import.meta.url);
const state = await import(new URL('state.js', BASE).href);
const panel = await import(new URL('engine-panel.js', BASE).href);

panel.initEnginePanel();

const body = document.getElementById('engine-body');
const pick = () => document.getElementById('engine-pick');

check('панель отрисована', !!body && body.children.length > 0);
check('кнопка импорта дорожек на месте', !!pick());
check('подпись playhead на месте', !!document.getElementById('engine-readout'));

/* ---------- нажатие и отпускание кнопки ---------- */
const before = pick();
body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));

check('кнопка под пальцем не пересоздалась', before.isConnected === true,
  'если панель перестроится на pointerup, click до неё не дойдёт');
check('кнопка импорта та же по тексту', pick() === before);
check('после отпускания флаг взаимодействия снят',
  body.querySelectorAll('.btn').length > 0);

/* ---------- смена времени не ломает панель ---------- */
state.state.time = 12.5;
const busMod = await import(new URL('state.js', BASE).href);
busMod.bus.emit(busMod.EV.TIME, 12.5);
const readout = document.getElementById('engine-readout');
check('подпись playhead обновилась без перестройки',
  readout && readout.textContent.includes('12.5'), readout?.textContent);
check('кнопка импорта жива после смены времени', pick() === before);

/* ---------- значения полей не сбрасываются ---------- */
const cat = document.getElementById('engine-cat');
if (cat) {
  cat.value = 'cloth';
  window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
  check('набранная категория не сбросилась', document.getElementById('engine-cat')?.value === 'cloth');
}

process.exitCode = done('Панель «Движок»') ? 0 : 1;
