/* ============ Экспорт размещения в Adobe Premiere Pro ============
 *
 * Формат — FCP7 XML (xmeml). Это единственный interchange, который Premiere
 * действительно открывает: File → Import. У него есть и клипы на дорожках, и
 * маркеры последовательности, поэтому размещение видно в Premiere так же, как
 * в нашем приложении: строка на персонажа, клипы по кадрам.
 *
 * Чего здесь намеренно НЕТ:
 *   — .prproj: проприетарный gzip-XML, отличается в каждой версии;
 *   — EDL: без многодорожечности и без маркеров;
 *   — голый .jsx: в Premiere, в отличие от After Effects, нет меню
 *     File → Scripts, и произвольный скрипт там не запустить. Adobe прямо
 *     говорит, что способ выполнять ExtendScript в Premiere — CEP-панель.
 *
 * Правила формата сняты не с потолка, а с XML, который Premiere выгрузила
 * сама (см. ссылки в research/premiere.md). Два места легко испортить молча:
 *   1) pathurl. Стокое процент-кодирование ломает импорт целиком — Premiere
 *      отвечает «проект повреждён», не упоминая пути.
 *   2) частота кадра. В FCP7 хранится целый timebase плюс флаг NTSC, поэтому
 *      29.97 — это «30, но NTSC». Перепутать — таймлайн уезжает молча.
 */

/** Символы, которые Premiere оставляет в пути как есть. */
const UNRESERVED = "/()[]&~!$'*+,;=@_-.";

const SAFE = new Set(UNRESERVED);
const isSafe = (ch) => (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
  || (ch >= '0' && ch <= '9') || SAFE.has(ch);

/**
 * Кодирует локальный путь в <pathurl>.
 *
 * Четыре правила, вычитанные из выгрузки самой Premiere:
 *   1) двоеточие диска кодируется: C: → C%3a;
 *   2) hex-цифры строчные: %3a, не %3A;
 *   3) ( ) [ ] & ~ ! $ ' * + , ; = @ _ - . остаются как есть;
 *   4) пробел → %20, не-ASCII → процент-кодирование UTF-8.
 *
 * @param {string} path путь к файлу дорожки
 * @returns {string} file://localhost/...
 */
export function pathurl(path) {
  const norm = String(path ?? '').replace(/\\/g, '/');
  let out = '';
  for (const ch of norm) {
    if (isSafe(ch)) { out += ch; continue; }
    // кодируем по байтам UTF-8, чтобы кириллица в пути не сломала импорт
    for (const b of new TextEncoder().encode(ch)) out += `%${b.toString(16).padStart(2, '0')}`;
  }
  return `file://localhost/${out}`;
}

/**
 * Частота кадра в виде FCP7: целый timebase + флаг NTSC.
 * 29.97 → (30, TRUE, DF); 25 → (25, FALSE, NDF); 23.976 → (24, TRUE, DF).
 *
 * @param {number} fps
 * @returns {{timebase: number, ntsc: string, df: string}}
 */
export function frameRate(fps) {
  const timebase = Math.round(fps);
  const ntsc = Math.abs(fps - timebase) > 0.001;
  return { timebase, ntsc: ntsc ? 'TRUE' : 'FALSE', df: ntsc ? 'DF' : 'NDF' };
}

/** Экранирование XML. */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const rate = (timebase, ntsc) =>
  `<rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>`;

const timecode = (timebase, ntsc, df) =>
  `<timecode>${rate(timebase, ntsc)}<string>00:00:00:00</string>`
  + `<frame>0</frame><displayformat>${df}</displayformat></timecode>`;

/**
 * Собирает FCP7 XML с размещением фоли.
 *
 * @param {object} o
 * @param {string} o.name        имя последовательности в Premiere
 * @param {number} o.fps         частота кадра проекта
 * @param {number} o.width       ширина кадра
 * @param {number} o.height      высота кадра
 * @param {Array<{name:string, path:string, duration:number, channels?:number}>} o.sources
 *   дорожки-источники; duration в секундах — из неё clamping out-точки
 * @param {Array<{file:string, at:number, in:number, out:number, label?:string}>} o.clips
 *   клипы: at — позиция на таймлайне (с), in/out — позиции в дорожке (с)
 * @param {Array<{at:number, name?:string, comment?:string, dur?:number}>} o.markers
 * @returns {{xml: string, summary: object}}
 */
export function buildFcp7Xml(o) {
  const fps = Number(o.fps) || 25;
  const { timebase, ntsc, df } = frameRate(fps);
  const width = Math.round(Number(o.width) || 1920);
  const height = Math.round(Number(o.height) || 1080);
  const seqName = o.name || 'MONTAG фоли';
  const fr = (s) => Math.round(Number(s) * fps);

  /* --- источники: один <file> на дорожку --- */
  const byName = new Map();
  const sources = [];
  for (const s of o.sources || []) {
    if (byName.has(s.name)) continue;
    const known = Number(s.duration);
    // out-точка за концом файла — Premiere отклоняет ВЕСЬ импорт, поэтому
    // длину не знаем — берём с запасом
    const dur = known > 0 ? known : (Math.max(0, ...(o.clips || [])
      .filter((c) => c.file === s.name).map((c) => c.out || 0)) + 1);
    byName.set(s.name, { path: s.path || s.name, frames: fr(dur), channels: s.channels || 1 });
    sources.push({ name: s.name, ...byName.get(s.name) });
  }

  /* --- клипы: дорожка на каждого персонажа --- */
  const order = [];
  const perTrack = new Map();
  for (const c of o.clips || []) {
    if (!byName.has(c.file)) continue;
    if (!perTrack.has(c.file)) { perTrack.set(c.file, []); order.push(c.file); }
    const src = byName.get(c.file);
    const inF = Math.max(0, fr(c.in || 0));
    const outF = Math.min(fr(c.out || 0), src.frames);
    if (outF <= inF) continue;
    const at = Math.max(0, fr(c.at || 0));
    perTrack.get(c.file).push({
      src, in: inF, out: outF, start: at, end: at + (outF - inF),
      label: c.label || c.file,
    });
  }
  for (const list of perTrack.values()) list.sort((a, b) => a.start - b.start);

  const totalFrames = Math.max(0, ...[...perTrack.values()]
    .flat().map((c) => c.end));

  /* --- сборка --- */
  const defined = new Set();
  const fileRef = (name) => {
    const s = byName.get(name);
    const id = `file-${sources.findIndex((x) => x.name === name) + 1}`;
    if (defined.has(id)) return `<file id="${id}"/>`;
    defined.add(id);
    return `<file id="${id}"><name>${esc(name)}</name>`
      + `<pathurl>${esc(pathurl(s.path))}</pathurl>${rate(timebase, ntsc)}`
      + `<duration>${s.frames}</duration>${timecode(timebase, ntsc, df)}`
      + `<media><video><samplecharacteristics>${rate(timebase, ntsc)}`
      + `<width>${width}</width><height>${height}</height>`
      + `<pixelaspectratio>square</pixelaspectratio><anamorphic>FALSE</anamorphic>`
      + `</samplecharacteristics></video>`
      + `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate>`
      + `</samplecharacteristics><channelcount>${s.channels}</channelcount></audio>`
      + `</media></file>`;
  };

  const audioTracks = [];
  let placedClips = 0;
  for (const name of order) {
    const items = [];
    perTrack.get(name).forEach((c, i) => {
      placedClips++;
      const src = byName.get(name);
      const head = `<name>${esc(c.label)}</name><enabled>TRUE</enabled>`
        + `<duration>${src.frames}</duration>${rate(timebase, ntsc)}`
        + `<start>${c.start}</start><end>${c.end}</end>`
        + `<in>${c.in}</in><out>${c.out}</out>`;
      items.push(`<clipitem id="a${i + 1}">${head}${fileRef(name)}`
        + `<sourcetrack><mediatype>audio</mediatype>`
        + `<trackindex>1</trackindex></sourcetrack></clipitem>`);
    });
    audioTracks.push(`<track>${items.join('')}</track>`);
  }

  const markers = (o.markers || []).map((m) => {
    const start = fr(m.at || 0);
    const span = Number(m.dur) || 0;
    const end = span > 0 ? start + fr(span) : -1;   // -1 = маркер-точка
    return `<marker><comment>${esc(m.comment || '')}</comment>`
      + `<name>${esc(m.name || '')}</name><in>${start}</in><out>${end}</out></marker>`;
  }).join('');

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">\n'
    + `<sequence id="${esc(seqName)}"><name>${esc(seqName)}</name>`
    + `<duration>${totalFrames}</duration>${rate(timebase, ntsc)}`
    + `${timecode(timebase, ntsc, df)}`
    + '<media><video><format><samplecharacteristics>'
    + `${rate(timebase, ntsc)}<width>${width}</width><height>${height}</height>`
    + '<pixelaspectratio>square</pixelaspectratio><anamorphic>FALSE</anamorphic>'
    + '</samplecharacteristics></format></video>'
    + '<audio><numOutputChannels>2</numOutputChannels>'
    + '<format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate>'
    + '</samplecharacteristics></format>'
    + `${audioTracks.join('')}</audio></media>${markers}</sequence>\n</xmeml>\n`;

  return {
    xml,
    summary: {
      name: seqName, fps, timebase, ntsc, frames: totalFrames,
      seconds: Number((totalFrames / fps).toFixed(3)),
      audioTracks: audioTracks.length, clips: placedClips,
      markers: (o.markers || []).length,
      sources: sources.map((s) => s.name),
    },
  };
}
