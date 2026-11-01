/* ============ Инспектор: интерактивность ============
 * Здесь на каждое отпускание мыши во всём приложении летел
 * ReferenceError: supppressRenderSafe is not defined — обработчик pointerup
 * падал, флаг suppressRender не снимался, панель залипала.
 */
import { setupDom, reporter } from './helpers.mjs';

const { window, document, silenceConsole, errors } = await setupDom();
silenceConsole();
const { check, done } = reporter();

const BASE = new URL('../js/', import.meta.url);
const state = await import(new URL('state.js', BASE).href);
state.state.media.push(
  { id: 'm1', name: 'a.mp4', url: 'blob:a', duration: 10, width: 640, height: 480, thumb: 'data:,' });
state.state.clips.push({
  id: 'c1', mediaId: 'm1', name: 'a.mp4', in: 2, out: 6, transitionIn: 'none', volume: 1,
});
state.state.selectedClipId = 'c1';

const insp = await import(new URL('inspector.js', BASE).href);
insp.initInspector();

const body = document.getElementById('inspector-body');
check('инспектор отрисован', !!body && body.children.length > 0);

/* любое отпускание мыши — не только внутри панели */
const before = errors.length;
window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
const thrown = errors.slice(before).join(' | ');
check('pointerup не бросает исключение', !/is not defined|ReferenceError/.test(thrown),
  thrown.slice(0, 140));

/* кнопки панели не должны исчезать из DOM между pointerup и click */
const btns = [...body.querySelectorAll('button')];
if (btns.length) {
  const first = btns[0];
  body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
  check('кнопка под пальцем не пересоздалась', first.isConnected === true);
}

/* панель переживает смену выбора клипа */
state.state.selectedClipId = null;
state.bus.emit(state.EV.SELECT);
check('после смены выбора панель жива', body.children.length > 0,
  'панель должна перерисоваться, а не опустеть');

process.exitCode = done('Инспектор') ? 0 : 1;
