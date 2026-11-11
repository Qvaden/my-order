/**
 * Генератор js/vendor/jspdf-font-ptsans.js
 *
 * Переводит подмножество PT Sans (js/vendor/fonts/pt-sans-cyr.ttf) в base64 и
 * оборачивает в модуль для jsPDF (addFileToVFS/addFont). Запускается вручную:
 *   node tools/gen-pdf-font.js
 *
 * Шрифт: PT Sans (C)ParaType, SIL Open Font License 1.1.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ttf = fs.readFileSync(path.join(root, 'js/vendor/fonts/pt-sans-cyr.ttf'));
const b64 = ttf.toString('base64');

const header = [
  '/**',
  ' * МОЙ ПОРЯДОК — кириллический шрифт для jsPDF (Этап 12.5, PRO)',
  ' *',
  ' * PT Sans (C) ParaType, SIL Open Font License 1.1 — подмножество:',
  ' * латиница + кириллица + ₽ № – — • °. ' + Math.round(ttf.length / 1024) + ' КБ TTF → ' +
    Math.round(b64.length / 1024) + ' КБ base64.',
  ' *',
  ' * Встроенные шрифты jsPDF (helvetica/times/courier) кириллицу не рисуют:',
  ' * кодировка WinAnsi, русские буквы превращаются в кракозябры. Поэтому PDF',
  ' * отчёты печатаются этим шрифтом через addFileToVFS + addFont.',
  ' *',
  ' * Загружается лениво — только при первой генерации PDF.',
  ' * Не редактировать вручную: сгенерировано tools/gen-pdf-font.js.',
  ' */',
  "(function () {",
  "  'use strict';",
  '',
  "  /** @const {string} Имя файла в виртуальной FS jsPDF */",
  "  var FILE_NAME = 'PTSansCyr-Regular.ttf';",
  '',
  "  /** @const {string} Имя шрифта для doc.setFont() */",
  "  var FONT_NAME = 'PTSansCyr';",
  '',
  '  window.PdfFontCyrillic = {',
  '    fileName: FILE_NAME,',
  '    family: FONT_NAME,',
  '    base64:',
  ''
].join('\n');

// Бьём base64 на куски по 96 символа: одна строка в 22 КБ плохо читается
// диффом и режет глаза в devtools, а склейка «a + b» стоит дешевле минификатора.
const CHUNK = 96;
const lines = [];
for (let i = 0; i < b64.length; i += CHUNK) {
  lines.push(b64.slice(i, i + CHUNK));
}
const body = lines.map((l, i) => (i === 0 ? '    ' : '      ') + "'" + l + "'" +
  (i === lines.length - 1 ? '' : ' +')).join('\n');
const tail = '\n  };\n})();\n';

const out = header + body + tail;
fs.writeFileSync(path.join(root, 'js/vendor/jspdf-font-ptsans.js'), out, 'utf8');
console.log('js/vendor/jspdf-font-ptsans.js =', out.length, 'B');
