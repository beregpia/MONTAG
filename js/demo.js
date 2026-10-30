/* ============ Демо-клип: синтетическое видео с «шагами» ============
 * Нужен, чтобы проверить весь путь (импорт → таймлайн → фоли → экспорт),
 * не имея под рукой своего видео. Генерируется локально через
 * canvas.captureStream + MediaRecorder, содержит ритмичные низкие
 * удары (шаги) и пару щелчков — детектор фоли должен их найти.
 */

import { toast } from './ui.js';

/** Сценарий демо: чистый план событий (тестируемо без браузера). */
export function demoScript() {
  const duration = 8;
  const steps = [];
  let i = 0;
  for (let t = 1.0; t < duration - 0.6; t += 1.0) {
    steps.push({ time: t, strong: i % 2 === 0 });
    i++;
  }
  const clicks = [{ time: 2.5 }, { time: 5.5 }, { time: 6.5 }];
  return { duration, steps, clicks };
}

function pickMime() {
  const list = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

/** Рисует один кадр демо-сцены. */
export function drawDemoFrame(ctx, t, script, W, H) {
  ctx.fillStyle = '#101318';
  ctx.fillRect(0, 0, W, H);

  // «пол» — бегущая разметка, чтобы было видно движение
  ctx.fillStyle = '#1c2029';
  ctx.fillRect(0, H - 60, W, 60);
  ctx.strokeStyle = '#2a2e38';
  ctx.lineWidth = 2;
  for (let x = -((t * 120) % 40); x < W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, H - 60);
    ctx.lineTo(x - 20, H);
    ctx.stroke();
  }

  // персонаж
  const x = 50 + (t / script.duration) * (W - 100);
  ctx.fillStyle = '#ff7a2f';
  ctx.fillRect(x - 13, H - 118, 26, 58);
  ctx.beginPath();
  ctx.arc(x, H - 130, 13, 0, Math.PI * 2);
  ctx.fill();

  // вспышка на контакте (визуальный маркер шага)
  for (const s of script.steps) {
    if (Math.abs(t - s.time) < 0.07) {
      ctx.fillStyle = s.strong ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.3)';
      ctx.fillRect(0, 0, W, H);
    }
  }

  // таймкод
  ctx.fillStyle = '#8b91a0';
  ctx.font = '13px monospace';
  ctx.fillText(`MONTAG demo   ${t.toFixed(2)}s / ${script.duration}s`, 12, 22);
}

/** Записывает демо-клип и возвращает File, готовый для импорта. */
export async function makeDemoFile(onStage) {
  const script = demoScript();
  const W = 640;
  const H = 360;
  const FPS = 30;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.captureStream || typeof MediaRecorder === 'undefined') {
    throw new Error('браузер не поддерживает запись видео (нужен Chrome, Edge или Firefox)');
  }

  const stream = canvas.captureStream(0); // 0 = кадры только по запросу
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack || typeof videoTrack.requestFrame !== 'function') {
    throw new Error('браузер не отдал видео-дорожку canvas (captureStream) — запись невозможна');
  }

  // --- звук: низкие удары (шаги) + щелчки ---
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('Web Audio недоступен в этом браузере');
  const actx = new AC();
  await actx.resume().catch(() => { /* бывает suspended */ });
  const dest = actx.createMediaStreamDestination();
  dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  const t0 = actx.currentTime + 0.15;

  for (const s of script.steps) {
    const osc = actx.createOscillator();
    const g = actx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(s.strong ? 58 : 78, t0 + s.time);
    osc.frequency.exponentialRampToValueAtTime(38, t0 + s.time + 0.13);
    g.gain.setValueAtTime(0.0001, t0 + s.time);
    g.gain.exponentialRampToValueAtTime(s.strong ? 0.85 : 0.45, t0 + s.time + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + s.time + 0.2);
    osc.connect(g);
    g.connect(dest);
    osc.start(t0 + s.time);
    osc.stop(t0 + s.time + 0.3);
  }
  for (const c of script.clicks) {
    const osc = actx.createOscillator();
    const g = actx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(2100, t0 + c.time);
    g.gain.setValueAtTime(0.0001, t0 + c.time);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + c.time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + c.time + 0.05);
    osc.connect(g);
    g.connect(dest);
    osc.start(t0 + c.time);
    osc.stop(t0 + c.time + 0.08);
  }

  // --- запись ---
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  const stopped = new Promise((res) => { rec.onstop = res; });

  onStage?.('Запись демо-сцены…');

  // Кадры снимаем вручную: requestAnimationFrame в фоновой вкладке или в
  // свёрнутом превью-iframe не вызывается, и генерация зависла бы навсегда.
  // setTimeout работает всегда (в фоне — реже, но идёт), поэтому сцену
  // всегда дорисовываем. Watchdog страхует от любого подвисания.
  const frameMs = Math.max(16, Math.round(1000 / FPS));
  let frameCount = 0;
  const pushFrame = (t) => {
    drawDemoFrame(ctx, t, script, W, H);
    frameCount++;
    if (videoTrack && typeof videoTrack.requestFrame === 'function') videoTrack.requestFrame();
  };

  pushFrame(0);
  rec.start(200);
  const startedAt = performance.now();
  await new Promise((resolve) => {
    let watchdog = 0;
    const finish = () => {
      clearTimeout(watchdog);
      resolve();
    };
    const tick = () => {
      const t = (performance.now() - startedAt) / 1000;
      pushFrame(Math.min(t, script.duration));
      if (t >= script.duration) { finish(); return; }
      setTimeout(tick, frameMs);
    };
    // watchdog: не больше длительности + 6 с при любых тормозах таймеров
    watchdog = setTimeout(finish, script.duration * 1000 + 6000);
    setTimeout(tick, frameMs);
  });

  pushFrame(script.duration); // дорисуем последний кадр
  await new Promise((r) => setTimeout(r, 250));
  rec.stop();
  await stopped;
  actx.close().catch(() => { /* ignore */ });

  if (!chunks.length) throw new Error('рекордер не отдал данных');
  if (frameCount < 5) throw new Error('записано слишком мало кадров — попробуйте вернуть вкладку на передний план');
  const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
  return new File([blob], 'demo-footsteps.webm', { type: blob.type });
}

/** Что поддерживает браузер — для диагностики, если демо не собирается. */
export function demoCapabilities() {
  const canvas = document.createElement('canvas');
  return {
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    captureStream: typeof canvas.captureStream === 'function',
    webm: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm'),
    audioContext: !!(window.AudioContext || window.webkitAudioContext),
    fileConstructor: typeof File === 'function',
  };
}

/** Полный путь: сгенерировать → импортировать → добавить на таймлайн. */
export async function loadDemoClip(importFiles, appendAllToTimeline, onStage) {
  onStage?.('Генерация демо-клипа…');
  const file = await makeDemoFile(onStage);
  const items = await importFiles([file]);
  if (items.length) {
    appendAllToTimeline();
    toast('Демо-клип добавлен: 8 с, шаги каждую секунду + щелчки. Откройте 🎙 Foley → Анализировать');
  }
  return items;
}
