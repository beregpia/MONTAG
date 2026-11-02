/* ============ Панель Foley: интерактивность ============
 * Та же болезнь, что была в панели «Движок»: панель перестраивалась на
 * pointerup, кнопка под пальцем исчезала из DOM, и click до неё не доходил.
 */
import { setupDom, reporter } from './helpers.mjs';

const { window, document, silenceConsole } = await setupDom();
silenceConsole();
const { check, done } = reporter();

const BASE = new URL('../js/', import.meta.url);
const foleyPanel = await import(new URL('foley-panel.js', BASE).href);
foleyPanel.initFoleyPanel();

const body = document.getElementById('foley-body');
check('панель Foley отрисована', !!body && body.children.length > 0);

const btns = [...body.querySelectorAll('button')];
check('в панели есть кнопки', btns.length > 0, `кнопок ${btns.length}`);

if (btns.length) {
  const first = btns[0];
  body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
  check('кнопка под пальцем не пересоздалась', first.isConnected === true,
    'после pointerup кнопка должна остаться в DOM, иначе click не дойдёт');
  check('кнопок столько же', body.querySelectorAll('button').length === btns.length);
}

/* значения полей не сбрасываются при отпускании */
const sel = body.querySelector('select');
if (sel) {
  sel.value = sel.options[sel.options.length - 1].value;
  window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
  check('выбор в списке не сбросился',
    body.querySelector('select')?.value === sel.value);
}

process.exitCode = done('Панель Foley') ? 0 : 1;
