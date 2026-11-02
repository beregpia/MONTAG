/* ============ Тесты экспорта в Premiere Pro (FCP7 XML) ============
 *
 * Формат нельзя проверить без самой Premiere, поэтому проверяем то, что
 * ломается молча: кодировку пути, частоту кадра, clamping out-точки и
 * соответствие кадров таймлайна кадрам источника. Ошибка в любом из этих
 * мест не даёт ошибки импорта — клипы просто встают не там или не встают вовсе.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupDom } from './helpers.mjs';

await setupDom();
const { pathurl, frameRate, buildFcp7Xml } =
  await import(new URL('../js/premiere-export.js', import.meta.url).href);

/* ---------- pathurl ---------- */
test('pathurl: двоеточие диска кодируется, hex строчный', () => {
  assert.equal(pathurl('C:/clips/a.wav'), 'file://localhost/C%3a/clips/a.wav');
  assert.ok(!pathurl('C:/a.wav').includes('%3A'), 'hex должен быть строчным');
});

test('pathurl: скобки и квадратные скобки остаются как есть', () => {
  // %28 вместо ( — именно это ломало импорт в референсной реализации
  assert.equal(pathurl('C:/clips(OBS)[raw]/a.wav'),
    'file://localhost/C%3a/clips(OBS)[raw]/a.wav');
  for (const ch of "&~!$'*+,;=@_-.") {
    const p = 'C:/a' + ch + 'b.wav';
    assert.ok(pathurl(p).includes(ch), `символ ${ch} не должен кодироваться`);
  }
});

test('pathurl: пробел и кириллица кодируются', () => {
  assert.equal(pathurl('C:/my clips/a.wav'), 'file://localhost/C%3a/my%20clips/a.wav');
  assert.match(pathurl('C:/Фoley/a.wav'), /%[0-9a-f]{2}/, 'не-ASCII уходит в проценты');
  assert.ok(!pathurl('C:/Фoley/a.wav').includes('Ф'), 'кириллица не остаётся как есть');
});

test('pathurl: обратные слэши Windows нормализуются', () => {
  assert.equal(pathurl('D:\\Foley\\Ep07\\a.wav'), 'file://localhost/D%3a/Foley/Ep07/a.wav');
});

/* ---------- частота кадра ---------- */
test('частота кадра: 25 — это timebase 25 без NTSC', () => {
  assert.deepEqual(frameRate(25), { timebase: 25, ntsc: 'FALSE', df: 'NDF' });
  assert.deepEqual(frameRate(24), { timebase: 24, ntsc: 'FALSE', df: 'NDF' });
  assert.deepEqual(frameRate(30), { timebase: 30, ntsc: 'FALSE', df: 'NDF' });
});

test('частота кадра: NTSC-ставки кодируются флагом, иначе таймлайн уедет', () => {
  assert.deepEqual(frameRate(29.97), { timebase: 30, ntsc: 'TRUE', df: 'DF' });
  assert.deepEqual(frameRate(23.976), { timebase: 24, ntsc: 'TRUE', df: 'DF' });
});

/* ---------- сборка документа ---------- */
const SRC = [
  { name: 'steps 02.L.wav', path: 'C:/foley/steps 02.L.wav', duration: 25 },
  { name: 'steps 03.L.wav', path: 'C:/foley/steps 03.L.wav', duration: 30 },
];
const CLIPS = [
  { file: 'steps 02.L.wav', at: 1.0, in: 0.5, out: 0.8, label: 'steps A' },
  { file: 'steps 02.L.wav', at: 3.0, in: 2.0, out: 2.35, label: 'steps A' },
  { file: 'steps 03.L.wav', at: 1.5, in: 1.0, out: 1.4, label: 'steps B' },
];

test('документ — валидный xmeml с объявлением и DOCTYPE', () => {
  const { xml } = buildFcp7Xml({ fps: 25, sources: SRC, clips: CLIPS, markers: [] });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.ok(xml.includes('<!DOCTYPE xmeml>'), 'DOCTYPE обязателен для Premiere');
  assert.ok(xml.includes('<xmeml version="4">'));
  assert.ok(xml.endsWith('</xmeml>\n'));
});

test('каждая дорожка получает свою звуковую дорожку', () => {
  const { xml, summary } = buildFcp7Xml({ fps: 25, sources: SRC, clips: CLIPS });
  assert.equal(summary.audioTracks, 2, 'по дорожке на персонажа');
  assert.equal(summary.clips, 3);
  // считаем <track> внутри <audio>, а не в <video>
  const audio = xml.slice(xml.indexOf('<audio>'));
  assert.equal((audio.match(/<track>/g) || []).length, 2);
  assert.equal((audio.match(/<clipitem /g) || []).length, 3);
});

test('кадры клипа совпадают с кадрами таймлайна', () => {
  const { xml } = buildFcp7Xml({ fps: 25, sources: SRC, clips: CLIPS });
  // первый клип: at 1.0 с -> start 25, длина out-in = 0.3 с -> end 32
  assert.ok(xml.includes('<start>25</start><end>32</end><in>13</in><out>20</out>'),
    'кадры должны считаться от частоты кадра проекта');
});

test('клипы внутри одной дорожки идут по возрастанию времени', () => {
  const { xml } = buildFcp7Xml({ fps: 25, sources: SRC, clips: CLIPS });
  const tracks = xml.slice(xml.indexOf('<audio>')).split('<track>').slice(1);
  assert.equal(tracks.length, 2);
  for (const t of tracks) {
    const starts = [...t.matchAll(/<start>(\d+)<\/start>/g)].map((m) => Number(m[1]));
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b),
      'внутри дорожки клипы должны идти по времени');
  }
});

test('out-точка зажимается по длине дорожки', () => {
  const { xml, summary } = buildFcp7Xml({
    fps: 25,
    sources: [{ name: 'a.wav', path: 'C:/a.wav', duration: 2 }],
    clips: [{ file: 'a.wav', at: 0, in: 1.9, out: 9.9, label: 'x' }],
  });
  // 2 с дорожки = 50 кадров; out не должен превысить 50
  assert.ok(!/<out>(\d+)<\/out>/.test(xml) || Number(xml.match(/<out>(\d+)<\/out>/)[1]) <= 50,
    'out за концом файла — Premiere отклоняет весь импорт');
  assert.equal(summary.clips, 1);
});

test('нулевой и вырожденный клип не попадает в документ', () => {
  const { xml, summary } = buildFcp7Xml({
    fps: 25, sources: [{ name: 'a.wav', path: 'C:/a.wav', duration: 10 }],
    clips: [
      { file: 'a.wav', at: 0, in: 1, out: 1 },      // нулевая длина
      { file: 'a.wav', at: 5, in: 3, out: 2 },      // out < in
      { file: 'a.wav', at: 7, in: 2, out: 4 },      // нормальный
    ],
  });
  assert.equal(summary.clips, 1, 'вырожденные клипы отброшены');
});

test('длительность последовательности покрывает все дорожки', () => {
  const { xml, summary } = buildFcp7Xml({
    fps: 25, sources: [{ name: 'a.wav', path: 'C:/a.wav', duration: 60 }],
    clips: [
      { file: 'a.wav', at: 0, in: 0, out: 1 },
      { file: 'a.wav', at: 50, in: 0, out: 2 },
    ],
  });
  assert.equal(summary.frames, 52 * 25, 'последний клип должен попасть в длину');
  assert.ok(xml.includes(`<duration>${52 * 25}</duration>`));
});

test('каждый источник определён один раз, дальше — ссылка', () => {
  const { xml } = buildFcp7Xml({
    fps: 25, sources: [{ name: 'a.wav', path: 'C:/a.wav', duration: 60 }],
    clips: [
      { file: 'a.wav', at: 0, in: 0, out: 1 },
      { file: 'a.wav', at: 5, in: 0, out: 1 },
    ],
  });
  assert.equal((xml.match(/<file id=/g) || []).length, 2, 'одно определение + одна ссылка');
  assert.equal((xml.match(/<pathurl>/g) || []).length, 1,
    'повторное определение заставило бы Premiere считать файл разными элементами');
});

test('маркер-точка имеет out=-1, маркер-интервал — реальную длину', () => {
  const { xml, summary } = buildFcp7Xml({
    fps: 25, sources: SRC, clips: [],
    markers: [
      { at: 1.0, name: '01 шаг', comment: 'steps 02.L' },
      { at: 2.0, name: '02 шаг', dur: 0.5 },
    ],
  });
  assert.ok(xml.includes('<comment>steps 02.L</comment><name>01 шаг</name><in>25</in><out>-1</out>'));
  assert.ok(xml.includes('<name>02 шаг</name><in>50</in><out>63</out>'));
  assert.equal(summary.markers, 2);
});

test('порядок в маркере: comment перед name', () => {
  const { xml } = buildFcp7Xml({
    fps: 25, sources: SRC, clips: [],
    markers: [{ at: 0, name: 'N', comment: 'C' }],
  });
  assert.ok(xml.indexOf('<comment>C</comment>') < xml.indexOf('<name>N</name>'),
    'Premiere пишет comment раньше name');
});

test('спецсимволы в именах экранируются', () => {
  const { xml } = buildFcp7Xml({
    fps: 25, sources: [{ name: 'a&b.wav', path: 'C:/a&b.wav', duration: 5 }],
    clips: [{ file: 'a&b.wav', at: 0, in: 0, out: 1, label: '<x>&"y"' }],
  });
  assert.ok(!xml.includes('<x>'), 'неэкранированный < сломал бы разбор');
  assert.ok(xml.includes('&lt;x&gt;&amp;&quot;y&quot;'));
});

test('пустой результат даёт валидную пустую последовательность', () => {
  const { xml, summary } = buildFcp7Xml({ fps: 25, sources: [], clips: [], markers: [] });
  assert.ok(xml.includes('<xmeml version="4">'));
  assert.equal(summary.clips, 0);
  assert.equal(summary.frames, 0);
  assert.ok(xml.includes('<duration>0</duration>'));
});

test('сводка пригодна для проверки без разбора XML', () => {
  const { summary } = buildFcp7Xml({
    name: 'Тест', fps: 25, width: 1920, height: 882,
    sources: SRC, clips: CLIPS,
    markers: [{ at: 1, name: 'm' }],
  });
  assert.equal(summary.name, 'Тест');
  assert.equal(summary.timebase, 25);
  assert.equal(summary.ntsc, 'FALSE');
  assert.equal(summary.seconds, 3.36);
  assert.deepEqual(summary.sources, ['steps 02.L.wav', 'steps 03.L.wav']);
});

test('кадр проекта подставляется в <format> последовательности', () => {
  const { xml } = buildFcp7Xml({
    fps: 25, width: 1920, height: 882, sources: SRC, clips: CLIPS,
  });
  assert.ok(xml.includes('<width>1920</width><height>882</height>'));
});
