/* ============ Точка входа: связываем UI и модули ============ */

import { state, EV, bus, totalDuration, clamp } from './state.js';
import { importFiles, renderMediaList } from './media.js';
import { initTimeline, deleteSelected } from './timeline.js';
import { initInspector } from './inspector.js';
import { initFoleyPanel } from './foley-panel.js';
import * as foley from './foley.js';
import * as player from './player.js';
import { runExport } from './recorder.js';
import { saveProject, openProjectFile } from './project.js';
import { toast, fmtTime } from './ui.js';

const $ = (id) => document.getElementById(id);

let booted = false;
function init() {
  if (booted) return;
  booted = true;

  player.initPlayer($('canvas'));
  initTimeline();
  initInspector();
  initFoleyPanel();

  // фоли-триггеры: покадровый хук плеера
  player.setFrameHook(foley.tick);

  bus.on(EV.MEDIA, renderMediaList);
  bus.on(EV.PLAY, updatePlayButton);
  renderMediaList();

  /* --- импорт --- */
  const fileInput = $('file-input');
  $('btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    importFiles(fileInput.files);
    fileInput.value = '';
  });

  const dropzone = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }),
  );
  dropzone.addEventListener('drop', (e) => importFiles(e.dataTransfer.files));

  // дроп в любое место окна (кроме dropzone — у него свой обработчик)
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.target.closest('#dropzone')) return;
    if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files);
  });

  /* --- транспорт --- */
  $('btn-play').addEventListener('click', () => player.toggle());
  $('scrub').addEventListener('input', (e) => {
    const total = totalDuration();
    player.seek((Number(e.target.value) / 1000) * total);
  });
  $('btn-split').addEventListener('click', doSplit);
  $('btn-fullscreen').addEventListener('click', () => {
    const stage = $('stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen?.().catch(() => toast('Полный экран недоступен', { type: 'error' }));
  });

  /* --- верхняя панель --- */
  $('btn-save').addEventListener('click', saveProject);
  const projectInput = $('project-input');
  $('btn-load').addEventListener('click', () => projectInput.click());
  projectInput.addEventListener('change', () => {
    if (projectInput.files[0]) openProjectFile(projectInput.files[0]);
    projectInput.value = '';
  });
  $('btn-foley').addEventListener('click', () => {
    $('foley-drawer').classList.toggle('hidden');
  });
  $('btn-export').addEventListener('click', () => runExport());
  $('btn-clear').addEventListener('click', () => {
    if (!state.clips.length) return;
    if (confirm('Удалить все клипы с таймлайна?')) {
      state.clips = [];
      bus.emit(EV.CLIPS);
    }
  });

  $('resolution').addEventListener('change', (e) => {
    const [w, h] = e.target.value.split('x').map(Number);
    state.settings.width = w;
    state.settings.height = h;
    player.applyResolution();
    toast(`Размер проекта: ${w}×${h}`);
  });

  /* --- горячие клавиши --- */
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (deleteSelected()) e.preventDefault(); }
    else if (e.key.toLowerCase() === 's') doSplit();
    else if (e.key === 'ArrowLeft') { e.preventDefault(); player.seek(state.time - (e.shiftKey ? 5 : 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); player.seek(state.time + (e.shiftKey ? 5 : 1)); }
    else if (e.key === 'Home') player.seek(0);
    else if (e.key === 'End') player.seek(totalDuration());
  });

  // предупреждаем о несохранённом проекте
  window.addEventListener('beforeunload', (e) => {
    if (state.clips.length || state.foley.length) { e.preventDefault(); e.returnValue = ''; }
  });
}

function doSplit() {
  const res = player.splitAtPlayhead();
  if (!res.ok) toast(res.reason, { type: 'error' });
}

function updatePlayButton(playing) {
  const btn = $('btn-play');
  btn.textContent = playing ? '❚❚' : '▶';
  btn.title = playing ? 'Пауза (Пробел)' : 'Пуск (Пробел)';
}

document.addEventListener('DOMContentLoaded', init, { once: true });
// модули выполняются после разбора HTML, но на всякий случай:
if (document.readyState !== 'loading') init();
