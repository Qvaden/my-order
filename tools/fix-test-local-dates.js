/**
 * Одноразовая правка e2e-тестов.
 *
 * Причина дефекта: относительные даты в фикстурах строились через
 * `d.toISOString().slice(0, 10)`, то есть по UTC. Приложение же считает
 * «сегодня» по локальному времени (MSK, UTC+3). До полуночи по Москве это
 * совпадало, после — каждая фикстура уезжала на день назад, и проверки
 * фильтров («истекает сегодня», «просрочен», «задача на сегодня»)
 * падали уже на валидном коде приложения.
 *
 * Формат ISO YYYY-MM-DD сохраняем: он тот же, просто части берутся
 * локальные. Заменяем только способ их получить.
 */
const fs = require('node:fs');

const LOCAL_DATE = [
  'const d = new Date();',
  'd.setDate(d.getDate() + n);',
  'return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");'
].join(' ');

/** @type {Array<[string, string, string]>} [файл, что ищем, на что меняем] */
const edits = [
  // Хелперы вида (n) => дата со сдвигом на n дней
  ['tests/harness.mjs',
    'const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };',
    'const iso = (n) => { ' + LOCAL_DATE + ' }'],
  ['tests/02-persistence.mjs',
    'const todayISO = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };',
    'const todayISO = (n) => { ' + LOCAL_DATE + ' }'],
  ['tests/05-validation.mjs',
    'const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };',
    'const iso = (n) => { ' + LOCAL_DATE + ' }'],
  ['tests/06-filters.mjs',
    'const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };',
    'const iso = (n) => { ' + LOCAL_DATE + ' }'],
  ['tests/07-animations.mjs',
    'const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };',
    'const iso = (n) => { ' + LOCAL_DATE + ' }'],
  ['tests/09-edge-stress.mjs',
    'const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };',
    'const iso = (n) => { ' + LOCAL_DATE + ' }'],

  // Прямые «сегодня» без сдвига
  ['tests/11-pro.mjs',
    "date: new Date().toISOString().slice(0, 10),",
    'date: localDate(0),'],

  // «Сегодня» для вычисления числа дней
  ['tests/09-edge-stress.mjs',
    "new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00')",
    "new Date(localDate(0) + 'T00:00:00')"]
];

const byFile = {};
for (const [file, from, to] of edits) {
  (byFile[file] = byFile[file] || []).push([from, to]);
}

let problems = 0;
for (const file of Object.keys(byFile)) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of byFile[file]) {
    if (!text.includes(from)) {
      console.log('MISS ' + file + ' :: ' + from.slice(0, 70));
      problems += 1;
      continue;
    }
    text = text.split(from).join(to);
  }
  fs.writeFileSync(file, text, 'utf8');
  console.log('OK   ' + file);
}

// 09-му нужны оба хелпера: локальная дата и для dd/td-фикстур
console.log('\nОсталось заменить вручную (dd/td.toISOString в 09-edge-stress):');
const nine = fs.readFileSync('tests/09-edge-stress.mjs', 'utf8');
nine.split(/\r?\n/).forEach((line, i) => {
  if (/toISOString\(\)\.slice\(0, 10\)/.test(line)) {
    console.log('  09:' + (i + 1) + ': ' + line.trim());
  }
});

const pro = fs.readFileSync('tests/11-pro.mjs', 'utf8');
pro.split(/\r?\n/).forEach((line, i) => {
  if (/toISOString\(\)\.slice\(0, 10\)/.test(line)) {
    console.log('  11-pro:' + (i + 1) + ': ' + line.trim());
  }
});

process.exit(problems ? 1 : 0);
