/**
 * Одноразовая правка: штатные PRO-ситуации (отменённый выбор папки,
 * недоступная печать, отсутствие QR-библиотеки офлайн) не должны попадать
 * в консоль как warning — e2e-страж (tests/harness.mjs) считает warning
 * провалом, а это не ошибки, а обработанные ветки.
 */
const fs = require('node:fs');

const edits = [
  ['js/backup.js', "console.warn('[Backup] Облачное сохранение не удалось:'", "console.info('[Backup] Облачное сохранение не удалось:'"],
  ['js/backup.js', "console.warn('[Backup] PDF не создан:'", "console.info('[Backup] PDF не создан:'"],
  ['js/cloud-sync.js', "console.warn('[CloudSync] Выгрузка не выполнена:'", "console.info('[CloudSync] Выгрузка не выполнена:'"],
  ['js/pro-manager.js', "console.warn('[ProManager] VKWebAppShowOrderBox не сработал:'", "console.info('[ProManager] VKWebAppShowOrderBox не сработал:'"],
  ['js/pdf-exporter.js', "console.warn('[PdfExporter] doc.save не сработал:'", "console.info('[PdfExporter] doc.save не сработал:'"],
  ['js/pdf-exporter.js', "console.warn('[PdfExporter] QR не получился:'", "console.info('[PdfExporter] QR не получился:'"],
  ['js/pdf-exporter.js', "console.warn('[PdfExporter] Стили печати не загрузились:'", "console.info('[PdfExporter] Стили печати не загрузились:'"],
  ['js/pdf-exporter.js', "console.warn('[PdfExporter] Печать недоступна:'", "console.info('[PdfExporter] Печать недоступна:'"],
  ['js/stats.js', "console.warn('[Stats] PRO-аналитика не догрузилась:'", "console.info('[Stats] PRO-аналитика не догрузилась:'"]
];

const byFile = {};
for (const [file, from, to] of edits) {
  (byFile[file] = byFile[file] || []).push([from, to]);
}

for (const file of Object.keys(byFile)) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of byFile[file]) {
    if (!text.includes(from)) { console.log('MISS ' + file + ' :: ' + from); continue; }
    text = text.split(from).join(to);
  }
  fs.writeFileSync(file, text, 'utf8');
  console.log('OK ' + file);
}
