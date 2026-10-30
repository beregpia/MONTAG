/* ============ Экспорт: сборка таймлайна в .webm через MediaRecorder ============ */

import { state, totalDuration } from './state.js';
import * as player from './player.js';
import { toast, fmtTime } from './ui.js';

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm',
];

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

/**
 * Проигрывает таймлайн от начала до конца в реальном времени и пишет
 * поток с canvas + мастер-шину звука в blob.
 */
export async function exportMontage({ onProgress } = {}) {
  const total = totalDuration();
  if (total <= 0) {
    toast('Таймлайн пуст — нечего экспортировать', { type: 'error' });
    return null;
  }
  const mime = pickMime();
  if (!mime) {
    toast('Браузер не поддерживает MediaRecorder (нужен Chrome, Edge или Firefox)', { type: 'error', timeout: 8000 });
    return null;
  }

  const canvas = document.getElementById('canvas');
  if (player.canvasBlocked()) {
    toast('Экспорт картинки недоступен: браузер не отдал 2D-контекст холста. ' +
      'Экспорт в SMF/CSV/JSON работает, для видео откройте MONTAG.bat.', { type: 'error', timeout: 10000 });
    return null;
  }
  const fps = state.settings.fps;
  const stream = canvas.captureStream(fps);

  // звук: мастер-шина плеера → MediaStreamDestination
  const dest = player.getStreamDestination();
  if (dest) dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  const stopped = new Promise((res) => { rec.onstop = res; });

  player.pause();
  player.seek(0);
  rec.start(250);
  player.play(); // пользовательский жест уже был (клик по «Экспорт»), аудио разблокируется

  // ждём окончания воспроизведения
  await new Promise((resolve) => {
    const tick = () => {
      onProgress?.(Math.min(1, state.time / total));
      if (player.isPlaying()) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });

  rec.stop();
  await stopped;
  onProgress?.(1);

  if (!chunks.length) {
    toast('Не удалось записать поток', { type: 'error' });
    return null;
  }
  return new Blob(chunks, { type: mime });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function runExport() {
  const total = totalDuration();
  const wrap = document.getElementById('export-progress');
  const fill = document.getElementById('export-progress-fill');
  const label = document.getElementById('export-progress-label');
  const badge = document.getElementById('export-badge');
  const btn = document.getElementById('btn-export');

  wrap.classList.remove('hidden');
  badge.classList.remove('hidden');
  btn.disabled = true;
  label.textContent = `Запись в реальном времени: ${fmtTime(total)}…`;

  try {
    const blob = await exportMontage({
      onProgress: (p) => {
        fill.style.width = `${Math.round(p * 100)}%`;
        label.textContent = `Запись… ${Math.round(p * 100)}%`;
      },
    });
    if (blob) {
      const name = `montag-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
      downloadBlob(blob, name);
      const mb = (blob.size / 1048576).toFixed(1);
      toast(`Готово: ${name} (${mb} МБ) — <a href="${URL.createObjectURL(blob)}" download="${name}">скачать снова</a>`, {
        html: true, timeout: 15000,
      });
    }
  } catch (err) {
    console.error(err);
    toast(`Ошибка экспорта: ${err.message || err}`, { type: 'error', timeout: 8000 });
  } finally {
    badge.classList.add('hidden');
    btn.disabled = false;
    fill.style.width = '0%';
    setTimeout(() => wrap.classList.add('hidden'), 1200);
    player.pause();
  }
}
