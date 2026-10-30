/* Проверка SMF-writer: структура файла и точность позиций маркеров. */
import { buildMarkerMidi, parseMarkerMidi, vlq } from '../js/midi.js';

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fails++;
};

/* ---------- VLQ ---------- */
check('VLQ: 0 -> [0]', JSON.stringify(vlq(0)) === '[0]');
check('VLQ: 127 -> [127]', JSON.stringify(vlq(127)) === '[127]');
check('VLQ: 128 -> [129,0]', JSON.stringify(vlq(128)) === '[129,0]');
check('VLQ: 8192 -> [192,0]', JSON.stringify(vlq(8192)) === '[192,0]');
check('VLQ: 106903 -> [134,195,23]', JSON.stringify(vlq(106903)) === '[134,195,23]');

/* ---------- сборка и разбор ---------- */
const markers = [
  { time: 0.397, name: '01 step low' },
  { time: 1.2, name: '02 click high' },
  { time: 5.0, name: '03' },
];
const data = buildMarkerMidi(markers);

check('файл начинается с MThd', data[0] === 0x4d && data[1] === 0x54 && data[2] === 0x68 && data[3] === 0x64);
check('длина заголовка = 6', data[4] === 0 && data[5] === 0 && data[6] === 0 && data[7] === 6);
check('формат 0', data[8] === 0 && data[9] === 0);
check('один трек', data[10] === 0 && data[11] === 1);
check('PPQ = 480', data[12] === 0x01 && data[13] === 0xe0);
check('есть MTrk', data[14] === 0x4d && data[15] === 0x54 && data[16] === 0x72 && data[17] === 0x6b);

const back = parseMarkerMidi(data);
check('разбор: 3 маркера', back.markers.length === 3, `найдено ${back.markers.length}`);
check('разбор: формат/PPQ', back.format === 0 && back.ppq === 480);
check('разбор: темп 480000 (125 BPM, 1 тик = 1 мс)', back.tempoUs === 480000, `tempo=${back.tempoUs}`);
check('разбор: тиков в секунду ~1000', Math.abs(back.ticksPerSecond - 1000) < 1e-6, `${back.ticksPerSecond}`);

const tol = 0.0015;
check('позиция маркера 1 точна до 1.5 мс', Math.abs(back.markers[0].time - 0.397) < tol, `${(back.markers[0].time * 1000).toFixed(2)} мс`);
check('позиция маркера 2 точна до 1.5 мс', Math.abs(back.markers[1].time - 1.2) < tol, `${(back.markers[1].time * 1000).toFixed(2)} мс`);
check('позиция маркера 3 точна до 1.5 мс', Math.abs(back.markers[2].time - 5.0) < tol, `${(back.markers[2].time * 1000).toFixed(2)} мс`);
check('имена маркеров сохранились',
  back.markers[0].name === '01 step low' && back.markers[1].name === '02 click high' && back.markers[2].name === '03');

/* ---------- крайние случаи ---------- */
const shuffled = buildMarkerMidi([
  { time: 3.5, name: 'c' }, { time: 0.1, name: 'a' }, { time: 1.7, name: 'b' },
]);
const sb = parseMarkerMidi(shuffled);
check('маркеры сортируются по времени',
  sb.markers.map((m) => m.name).join('') === 'abc' && Math.abs(sb.markers[0].time - 0.1) < tol);

const edge = parseMarkerMidi(buildMarkerMidi([{ time: 0, name: 'z' }, { time: -5, name: 'neg' }]));
check('время 0 сохраняется, отрицательное отбрасывается',
  edge.markers.length === 1 && Math.abs(edge.markers[0].time) < tol, `маркеров: ${edge.markers.length}`);

const empty = parseMarkerMidi(buildMarkerMidi([]));
check('пустой список даёт валидный файл без маркеров', empty.markers.length === 0 && empty.ppq === 480);

const uni = parseMarkerMidi(buildMarkerMidi([{ time: 1, name: 'шаг 👟' }]));
check('не-ASCII имена заменяются на ? и не ломают файл',
  uni.markers.length === 1 && /^[\? ]+$/.test(uni.markers[0].name), `имя: ${uni.markers[0].name}`);

const many = [];
for (let i = 0; i < 500; i++) many.push({ time: i * 0.137, name: `m${i}` });
const mb = parseMarkerMidi(buildMarkerMidi(many));
check('500 маркеров собираются и читаются', mb.markers.length === 500, `${mb.markers.length}`);
check('последний из 500 маркеров на месте',
  Math.abs(mb.markers[499].time - 499 * 0.137) < tol, `${(mb.markers[499].time).toFixed(3)}`);

const far = parseMarkerMidi(buildMarkerMidi([{ time: 0, name: 'a' }, { time: 100, name: 'b' }]));
check('большой скачок времени (100 с) корректен',
  far.markers.length === 2 && Math.abs(far.markers[1].time - 100) < tol, `${far.markers[1].time}`);

const noname = parseMarkerMidi(buildMarkerMidi([{ time: 2.5 }]));
check('имя по умолчанию генерируется', typeof noname.markers[0].name === 'string' && noname.markers[0].name.length > 0, noname.markers[0].name);

console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nSMF-writer корректен');
process.exitCode = fails ? 1 : 0;
