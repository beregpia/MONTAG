/* ============ Сохранение / открытие проекта (JSON) ============ */

import { state, uid, EV, bus, selectClip, clamp } from './state.js';
import { toast } from './ui.js';

export function saveProject() {
  const data = {
    app: 'montag',
    version: 1,
    settings: { ...state.settings },
    media: state.media.map((m) => ({ name: m.name, duration: m.duration, width: m.width, height: m.height })),
    clips: state.clips.map((c) => ({
      mediaName: getMedia(c.mediaId)?.name ?? '',
      in: c.in, out: c.out, transitionIn: c.transitionIn, volume: c.volume ?? 1, name: c.name,
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `montag-project-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  toast('Проект сохранён (JSON). Видео нужно импортировать повторно.');
}

export async function openProjectFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('Не похоже на проект MONTAG (битый JSON)', { type: 'error' });
    return;
  }
  if (data?.app !== 'montag') {
    toast('Файл не является проектом MONTAG', { type: 'error' });
    return;
  }

  const byName = new Map(state.media.map((m) => [m.name, m]));
  const missing = new Set();
  const clips = [];

  for (const c of data.clips || []) {
    const media = byName.get(c.mediaName);
    if (!media) { missing.add(c.mediaName); continue; }
    const maxDur = media.duration > 0 ? media.duration : Math.max(c.out, 1);
    clips.push({
      id: uid('c'),
      mediaId: media.id,
      name: c.name || media.name.replace(/\.[^.]+$/, ''),
      in: clamp(Number(c.in) || 0, 0, maxDur),
      out: clamp(Number(c.out) || maxDur, 0.1, maxDur),
      transitionIn: ['none', 'crossfade', 'fadeblack'].includes(c.transitionIn) ? c.transitionIn : 'none',
      volume: Number(c.volume ?? 1),
    });
  }

  state.clips = clips;
  selectClip(clips[0]?.id ?? null);
  bus.emit(EV.CLIPS);

  if (missing.size) {
    toast(`Импортируйте недостающие файлы: ${[...missing].slice(0, 3).join(', ')}${missing.size > 3 ? '…' : ''}`, { type: 'error', timeout: 9000 });
  } else {
    toast(`Проект загружен: ${clips.length} клип(ов)`);
  }
}

function getMedia(id) {
  return state.media.find((m) => m.id === id) || null;
}
