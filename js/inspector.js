/* ============ Инспектор выбранного клипа ============ */

import { state, EV, bus, getClip, getMedia, TRANSITIONS, removeClip, computeLayout } from './state.js';
import { fmtTime, el } from './ui.js';
import * as player from './player.js';

let suppressRender = false; // пока пользователь тащит ползунок — не перестраиваем DOM

export function initInspector() {
  const body = document.getElementById('inspector-body');
  body.addEventListener('pointerdown', () => { suppressRender = true; });
  window.addEventListener('pointerup', () => {
    if (supppressRenderSafe()) { suppressRender = false; render(); }
  });
  bus.on(EV.SELECT, render);
  bus.on(EV.CLIPS, () => { if (!suppressRender) render(); });
  bus.on(EV.MEDIA, render);
  render();
}

export function render() {
  const body = document.getElementById('inspector-body');
  body.textContent = '';
  const clip = getClip(state.selectedClipId);

  if (!clip) {
    body.append(
      el('div', { class: 'inspector-empty' },
        'Клип не выбран.',
        el('br'), el('br'),
        'Кликните клип на таймлайне, чтобы подрезать края, выбрать переход и громкость.',
        el('br'), el('br'),
        'Двойной клик по медиа — добавить на таймлайн.',
        el('br'),
        'Пробел — пуск/пауза, S — разделить, ←/→ — ±1 с.',
      ),
    );
    return;
  }

  const media = getMedia(clip.mediaId);
  const maxDur = media?.duration > 0 ? media.duration : Math.max(clip.out, 1);
  const startOfClip = () => computeLayout().find((it) => it.clip.id === state.selectedClipId)?.start ?? 0;

  body.append(
    el('div', { class: 'insp-title' }, clip.name || 'Клип'),
    el('div', { class: 'muted small' }, media?.name || '—'),
  );

  /* --- тримминг: метки обновляем точечно, DOM не пересобираем --- */
  const inLabel = el('b', {}, fmtTime(clip.in));
  body.append(
    el('div', { class: 'insp-row' },
      el('div', { class: 'insp-label' }, 'Начало', inLabel),
      slider({
        min: 0, max: maxDur, step: 0.05, value: clip.in,
        onInput: (v) => {
          const c = getClip(state.selectedClipId);
          if (!c) return;
          c.in = Math.min(v, c.out - 0.1);
          inLabel.textContent = fmtTime(c.in);
          bus.emit(EV.CLIPS);
          if (state.time < c.in) player.seek(c.in);
        },
      }),
    ),
  );

  const outLabel = el('b', {}, fmtTime(clip.out));
  const durLabel = el('b', {}, fmtTime(clip.out - clip.in));
  body.append(
    el('div', { class: 'insp-row' },
      el('div', { class: 'insp-label' }, 'Конец', outLabel),
      slider({
        min: 0, max: maxDur, step: 0.05, value: clip.out,
        onInput: (v) => {
          const c = getClip(state.selectedClipId);
          if (!c) return;
          c.out = Math.max(v, c.in + 0.1);
          outLabel.textContent = fmtTime(c.out);
          durLabel.textContent = fmtTime(c.out - c.in);
          bus.emit(EV.CLIPS);
        },
      }),
    ),
    el('div', { class: 'insp-row' },
      el('div', { class: 'insp-label' }, 'Длительность клипа', durLabel),
    ),
  );

  /* --- переход --- */
  const transSelect = el('select', { class: 'select', style: 'width:100%' });
  for (const [value, label] of Object.entries(TRANSITIONS)) {
    const opt = el('option', { value }, label);
    if (clip.transitionIn === value) opt.selected = true;
    transSelect.append(opt);
  }
  transSelect.addEventListener('change', () => {
    const c = getClip(state.selectedClipId);
    if (!c) return;
    c.transitionIn = transSelect.value;
    bus.emit(EV.CLIPS);
    render();
  });
  body.append(
    el('div', { class: 'insp-row' },
      el('div', { class: 'insp-label' }, 'Переход входящим'),
      transSelect,
    ),
  );

  /* --- громкость --- */
  const volLabel = el('b', {}, `${Math.round((clip.volume ?? 1) * 100)}%`);
  body.append(
    el('div', { class: 'insp-row' },
      el('div', { class: 'insp-label' }, 'Громкость', volLabel),
      slider({
        min: 0, max: 1.5, step: 0.05, value: clip.volume ?? 1,
        onInput: (v) => {
          const c = getClip(state.selectedClipId);
          if (!c) return;
          c.volume = v;
          volLabel.textContent = `${Math.round(v * 100)}%`;
          player.setClipVolume(c);
        },
      }),
    ),
  );

  const btnGoto = el('button', { class: 'btn ghost' }, 'Перейти к началу клипа');
  btnGoto.addEventListener('click', () => player.seek(startOfClip()));
  const btnDelete = el('button', { class: 'btn ghost danger' }, 'Удалить клип');
  btnDelete.addEventListener('click', () => removeClip(state.selectedClipId));

  body.append(btnGoto, btnDelete);
}

function slider({ min, max, step, value, onInput }) {
  const input = el('input', {
    type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
  });
  input.addEventListener('input', () => onInput(parseFloat(input.value)));
  return input;
}
