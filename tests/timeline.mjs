/* ============ Тесты линейки таймлайна: подписи должны соответствовать позиции ============
 *
 * Инвариант: подпись, стоящая на X пикселях от начала линейки, показывает время
 * X / pps. И подписи идут по возрастанию. Если это нарушается, монтажёр врёт
 * о позиции — а на нём строят всю расстановку фоли.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers.mjs';

const { document, window } = await setupDom();

const timeline = await import(new URL('../js/timeline.js', import.meta.url).href);
const state = await import(new URL('../js/state.js', import.meta.url).href);

/* jsdom не считает Layout — задаём ширину вручную, как в браузере. */
function stubWidth(px) {
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return this.id === 'timeline' ? px : 0; },
  });
}

function addClip(dur) {
  state.state.media.push({ id: 'm1', name: 'v.mp4', duration: dur, width: 1920, height: 882 });
  state.state.clips.push({
    id: 'c1', mediaId: 'm1', in: 0, out: dur, transitionIn: 'none', volume: 1, name: 'v.mp4',
  });
}

function rulerLabels() {
  const ruler = document.getElementById('ruler');
  return [...ruler.querySelectorAll('.ruler-label')].map((n) => ({
    left: parseFloat(n.style.left),
    text: n.textContent.trim(),
  }));
}

test('линейка: подписи идут по возрастанию и совпадают с позицией', () => {
  stubWidth(1600);
  addClip(60);
  timeline.render();

  const labels = rulerLabels();
  assert.ok(labels.length >= 5, `подписей ${labels.length} — слишком мало`);

  const times = labels.map((l) => {
    const [m, s] = l.text.split(':').map(Number);
    return m * 60 + s;
  });

  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1],
      `подписи не по возрастанию: ${labels[i - 1].text} → ${labels[i].text}`);
  }

  // шаг между подписями постоянный
  const steps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(new Set(steps).size === 1, `шаг подписей не постоянный: ${steps.join(',')}`);

  // позиция подписи соответствует её времени (учитывая отступ RULER_PAD)
  const pad = labels[0].left;
  const pps = (labels[1].left - pad) / times[1];
  assert.ok(pps > 0, `pps = ${pps}`);
  for (const l of labels) {
    const expected = pad + times[labels.indexOf(l)] * pps;
    assert.ok(Math.abs(l.left - expected) < 1.5,
      `подпись ${l.text} стоит на ${l.left}px, а должна на ${expected.toFixed(1)}px`);
  }
});

test('линейка: последняя подпись не забегает далеко за конец клипа', () => {
  stubWidth(1600);
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  timeline.render();
  const labels = rulerLabels();
  const last = labels.at(-1);
  const [m, s] = last.text.split(':').map(Number);
  const lastT = m * 60 + s;
  assert.ok(lastT <= 60 + 60, `последняя подпись ${last.text} — линейка разошлась`);
});

test('линейка: на длинном проекте подписей остаётся немного', () => {
  stubWidth(1600);
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60 * 90); // 90 минут
  timeline.render();
  const labels = rulerLabels();
  assert.ok(labels.length < 400, `подписей ${labels.length} — линейка перегружена`);
  assert.ok(labels.length > 3, `подписей ${labels.length} — слишком мало`);
  const times = labels.map((l) => { const [m, s] = l.text.split(':').map(Number); return m * 60 + s; });
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], `не по возрастанию: ${labels[i - 1].text} → ${labels[i].text}`);
  }
});

test('линейка: ширина дорожки покрывает клип', () => {
  stubWidth(1600);
  state.state.clips.length = 0;
  state.state.media.length = 0;
  addClip(60);
  timeline.render();
  const ruler = document.getElementById('ruler');
  const track = document.getElementById('track');
  assert.ok(parseFloat(ruler.style.width) >= 60 * 10, `ширина линейки ${ruler.style.width}`);
  assert.equal(ruler.style.width, track.style.width, 'линейка и дорожка разной ширины');
});
