/**
 * Этап 11 / раздел 3 — резервное копирование.
 * Экспорт → очистка → импорт → сверка id и связей; битый JSON; структура без stores.
 */
import fs from 'node:fs';
import path from 'node:path';
import { open, gotoSection, seed, counts, rows, resetAll, report, SHOTS, BASE } from './harness.mjs';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });
const { browser, page, log } = await open();
await resetAll(page);

const SPEC = {
  payments: [
    { title: 'Коммунальные', amount: 2500000, date: 4, category: 'Коммунальные', frequency: 'monthly' },
    { title: 'Подписка VK', amount: 39900, date: 9, category: 'Подписки', frequency: 'monthly', status: 'paid' }
  ],
  meters: [
    { name: 'ХВС', type: 'cold', initialValue: 100, readings: [{ value: 111, date: -5 }, { value: 118, date: -1 }] },
    { name: 'Свет', type: 'electricity', initialValue: 3000, readings: [{ value: 3100, date: -4 }] }
  ],
  documents: [
    { name: 'ОСАГО', category: 'Страховка', expiryDate: 12, issuedDate: -300 },
    { name: 'Права', category: 'Водительское удостоверение', expiryDate: 400, issuedDate: -1000 }
  ],
  tasks: [
    { title: 'Показать счётчики', priority: 'high', dueDate: 1 },
    { title: 'Уборка', priority: 'low', dueDate: 6, recurring: 'weekly' },
    { title: 'Позвонить в банк', priority: 'medium', dueDate: -1, completed: true }
  ]
};

const created = await seed(page, SPEC);
const before = await counts(page);
check('3.0 эталонный набор создан',
  before.payments === 2 && before.meters === 2 && before.meter_readings === 3 &&
  before.documents === 2 && before.tasks === 3, before);

const snapshot = await rows(page);

// ---------- 3.1 Экспорт: структура дампа ----------
await gotoSection(page, 'backup', '.backup-section');
const dump = await page.evaluate(() => window.Backup.exportData());
check('3.1.1 exportData() возвращает Promise с корректной оболочкой',
  dump.version === 1 && typeof dump.exportDate === 'string' &&
  dump.appName === 'MyOrder' && dump.data && typeof dump.data === 'object',
  { version: dump.version, exportDate: dump.exportDate, appName: dump.appName });

const dumpStr = JSON.stringify(dump);
check('3.1.2 в дампе все 5 stores и правильное число записей',
  ['payments', 'meters', 'meter_readings', 'documents', 'tasks'].every((s) => Array.isArray(dump.data[s])) &&
  dump.data.payments.length === 2 && dump.data.meters.length === 2 &&
  dump.data.meter_readings.length === 3 && dump.data.documents.length === 2 &&
  dump.data.tasks.length === 3,
  Object.fromEntries(Object.entries(dump.data).map(([k, v]) => [k, v.length])));

check('3.1.3 id в дампе совпадают с id в базе',
  dump.data.payments.map((p) => p.id).join() === snapshot.payments.map((p) => p.id).join() &&
  dump.data.meters.map((m) => m.id).join() === snapshot.meters.map((m) => m.id).join() &&
  dump.data.meter_readings.map((r) => r.id).join() === snapshot.meter_readings.map((r) => r.id).join(),
  { dumpPayments: dump.data.payments.map((p) => p.id), dbPayments: snapshot.payments.map((p) => p.id) });

const jsonSize = Buffer.byteLength(dumpStr, 'utf8');
check('3.1.4 размер дампа адекватен (кириллица не удвоилась)', jsonSize > 500 && jsonSize < 200000, jsonSize + ' байт');

// Скачивание через UI — файл должен реально появиться
const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
await page.click('[data-backup-action="export"]');
const download = await dl;
check('3.1.5 кнопка «Скачать резервную копию» запускает скачивание',
  !!download && /\.json$/.test(download.suggestedFilename()),
  download && download.suggestedFilename());
const dumpPath = path.join(SHOTS, 'e11-dump.json');
if (download) { await download.saveAs(dumpPath); }
else { fs.writeFileSync(dumpPath, dumpStr); }

const statusExport = await page.evaluate(() =>
  document.querySelector('[data-backup-status="export"]').textContent.trim());
check('3.1.6 статус экспорта показывает имя файла', /Скачано/.test(statusExport), statusExport);

// settings — служебный store, чистить его нельзя. Проверяем на реальном значении:
// пишем настройку, делаем «Удалить всё», настройка должна выжить.
await page.evaluate(async () => {
  const rec = { key: 'e2e_probe', value: 'keep-me' };
  try { await window.DB.add('settings', rec); }
  catch (e) { await window.DB.update('settings', 'e2e_probe', { value: 'keep-me' }); }
});
const settingsBefore = await page.evaluate(async () => {
  const all = await window.DB.getAll('settings');
  return all.find((s) => s.key === 'e2e_probe') || null;
});
await gotoSection(page, 'backup', '.backup-section');
await page.click('[data-backup-action="clear"]');
await page.waitForSelector('[data-backup-confirm="confirm"]', { timeout: 4000 });
await page.click('[data-backup-confirm="confirm"]');
await page.waitForTimeout(1800);

const emptied = await counts(page);
check('3.2.1 «Удалить всё» очищает все stores',
  emptied.payments === 0 && emptied.meters === 0 && emptied.meter_readings === 0 &&
  emptied.documents === 0 && emptied.tasks === 0, emptied);

// Все разделы визуально пусты
for (const [hash, sel] of [['payments', '.payment-card'], ['meters', '.meter-card'],
                           ['documents', '.document-card'], ['tasks', '.task-card']]) {
  await gotoSection(page, hash, '.empty-state');
  const state = await page.evaluate((s) => ({
    cards: document.querySelectorAll(s).length,
    empty: !!document.querySelector('.empty-state')
  }), sel);
  check(`3.2.2 #${hash}: пустой список и empty-state`, state.cards === 0 && state.empty, state);
}

const settingsKept = await page.evaluate(async () => {
  const all = await window.DB.getAll('settings');
  return all.find((s) => s.key === 'e2e_probe') || null;
});
check('3.2.3 служебный store settings НЕ очищается вместе с данными',
  settingsBefore && settingsKept && settingsKept.value === 'keep-me',
  { settingsBefore, settingsKept });

// ---------- 3.3 Импорт того же файла: данные, id, связи ----------
// «Удалить всё» уводит пользователя на главную — возвращаемся в раздел.
await gotoSection(page, 'backup', '[data-backup-input="file"]');
await page.setInputFiles('[data-backup-input="file"]', dumpPath);
await page.waitForSelector('[data-backup-confirm="run"]', { timeout: 6000 });
const preview = await page.evaluate(() => {
  const m = document.querySelector('.modal-content');
  return m ? m.innerText.replace(/\s+/g, ' ').slice(0, 220) : null;
});
check('3.3.1 импорт показывает подтверждение со сводкой', !!preview && /платеж|Счётчик|задач|импорт/i.test(preview), preview);

await page.click('[data-backup-confirm="run"]');
await page.waitForTimeout(2000);
const restored = await counts(page);
check('3.3.2 после импорта количество записей как до очистки',
  JSON.stringify(restored) === JSON.stringify(before), restored);

const statusImport = await page.evaluate(() =>
  document.querySelector('[data-backup-status="import"]').textContent.trim());
check('3.3.3 статус импорта: импортировано 12, пропущено 0',
  /Импортировано: 12/.test(statusImport) && /пропущено: 0/.test(statusImport), statusImport);

const identity = await page.evaluate(async (snap) => {
  const now = {};
  for (const s of ['payments', 'meters', 'meter_readings', 'documents', 'tasks']) {
    now[s] = await window.DB.getAll(s);
  }
  const idMatch = (a, b) => a.map((x) => x.id).sort().join() === b.map((x) => x.id).sort().join();
  const links = now.meter_readings.every((r) => now.meters.some((m) => m.id === r.meterId));
  const orphans = now.meter_readings.filter((r) => !now.meters.some((m) => m.id === r.meterId)).length;
  return {
    idsPreserved: idMatch(now.payments, snap.payments) && idMatch(now.meters, snap.meters) &&
                  idMatch(now.meter_readings, snap.meter_readings) && idMatch(now.tasks, snap.tasks),
    linksIntact: links,
    orphans,
    amountsOk: now.payments.every((p) => typeof p.amount === 'number' && p.amount > 0),
    recurringOk: now.tasks.filter((t) => t.recurring && t.recurring !== 'none').length === 1,
    completedOk: now.tasks.filter((t) => t.completed).length === 1
  };
}, snapshot);
check('3.3.4 id совпадают побайтово', identity.idsPreserved, identity);
check('3.3.5 связи meter_readings → meters целы, сирот нет',
  identity.linksIntact && identity.orphans === 0, identity);
check('3.3.6 поля данных восстановлены (суммы, recurring, completed)',
  identity.amountsOk && identity.recurringOk && identity.completedOk, identity);

// UI разделов после импорта
await gotoSection(page, 'meters', '.meter-card');
const uiAfter = await page.evaluate(() => ({
  meterCards: document.querySelectorAll('.meter-card').length,
  hasLastReading: [...document.querySelectorAll('.meter-card')].every((c) => /\d/.test(c.innerText))
}));
check('3.3.7 раздел счётчиков показывает восстановленные показания', uiAfter.meterCards === 2 && uiAfter.hasLastReading, uiAfter);

// ---------- 3.4 Битый JSON ----------
const brokenPath = path.join(SHOTS, 'e11-broken.json');
fs.writeFileSync(brokenPath, '{"version": 1, "exportDate": "2026-11-09", "data": { broken');

// Импортных файлов несколько, перед каждым возвращаемся в раздел «Резервные копии»
// (file input скрыт, поэтому ждём видимую секцию, а не сам input).
async function upload(file) {
  await gotoSection(page, 'backup', '.backup-section');
  await page.setInputFiles('[data-backup-input="file"]', file);
  await page.waitForTimeout(1300);
}

await upload(brokenPath);
const brokenStatus = await page.evaluate(() =>
  document.querySelector('[data-backup-status="import"]').textContent.trim());
const brokenModal = await page.evaluate(() => !!document.querySelector('.modal-content'));
check('3.4.1 битый JSON отклонён с понятной ошибкой',
  /не удалось распарсить|не является корректным JSON/i.test(brokenStatus) && !brokenModal,
  brokenStatus);

const afterBroken = await counts(page);
check('3.4.2 база НЕ повреждена после битого файла (данные целы)',
  JSON.stringify(afterBroken) === JSON.stringify(before), afterBroken);

// ---------- 3.5 Валидный JSON с неверной структурой ----------
const noStoresPath = path.join(SHOTS, 'e11-nostores.json');
fs.writeFileSync(noStoresPath, JSON.stringify({ version: 1, exportDate: '2026-11-09', appName: 'MyOrder', data: {} }));
await upload(noStoresPath);
const noStoresStatus = await page.evaluate(() =>
  document.querySelector('[data-backup-status="import"]').textContent.trim());
check('3.5.1 JSON без stores отклонён (не «Импортировано: 0» как успех)',
  /Неверный формат|отсутствуют хранилища/i.test(noStoresStatus) && !/Импортировано/.test(noStoresStatus),
  noStoresStatus);

const afterNoStores = await counts(page);
check('3.5.2 данные не пострадали при отклонённом импорте',
  JSON.stringify(afterNoStores) === JSON.stringify(before), afterNoStores);

// ---------- 3.6 Массив вместо объекта, чужие stores ----------
const arrPath = path.join(SHOTS, 'e11-array.json');
fs.writeFileSync(arrPath, JSON.stringify([1, 2, 3]));
await upload(arrPath);
const arrStatus = await page.evaluate(() =>
  document.querySelector('[data-backup-status="import"]').textContent.trim());
check('3.6.1 JSON-массив отклонён', /не является JSON-объектом|Ошибк/i.test(arrStatus), arrStatus);

const alienPath = path.join(SHOTS, 'e11-alien.json');
fs.writeFileSync(alienPath, JSON.stringify({
  version: 1, exportDate: '2026-11-09', appName: 'MyOrder',
  data: { payments: [], hack: [{ id: 1 }] }
}));
await upload(alienPath);
const alienStatus = await page.evaluate(() =>
  document.querySelector('[data-backup-status="import"]').textContent.trim());
// Реальные имена хранилищ читаем из живого соединения (тот же номер версии —
// второго versionchange не будет, соединение приложения остаётся валидным).
const storesAfterAlien = await page.evaluate(async () => {
  const name = window.DB.getName();
  const ver = window.DB.getVersion();
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open(name, ver);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const names = Array.from(db.objectStoreNames);
  db.close();
  return names;
});
check('3.6.2 дамп с незнакомым store отклонён до записи',
  /Неверный формат|отсутствуют хранилища|неизвестн/i.test(alienStatus), alienStatus);
check('3.6.3 в базе не появился чужой store',
  Array.isArray(storesAfterAlien) && !storesAfterAlien.includes('hack') &&
  (storesAfterAlien.length >= 6 && storesAfterAlien.length <= 8), storesAfterAlien);

// ---------- 3.7 Импорт поверх непустой базы: не дублирует ----------
const idempotent = await page.evaluate(async (d) => {
  const before2 = (await window.DB.getAll('payments')).length;
  const stats = await window.DB.importAll(d.data);
  const after2 = (await window.DB.getAll('payments')).length;
  return { before2, after2, imported: stats.imported, skipped: stats.skipped };
}, dump);
check('3.7.1 повторный importAll не создаёт дубликатов (skipped, а не re-insert)',
  idempotent.after2 === idempotent.before2 && idempotent.imported === 0 &&
  idempotent.skipped === 12, idempotent);

// ---------- 3.9 Откат: упавший импорт обязан вернуть данные ----------
// Симулируем сбой на этапе записи (после очистки stores) и проверяем,
// что importDump восстанавливает снимок. Без отката база осталась бы пустой.
await upload(dumpPath);
await page.waitForSelector('[data-backup-confirm="run"]', { timeout: 6000 });

// Кнопка «Заменить данные» вызывает Backup.importDump → DB.importAll.
// Подменяем importAll так, чтобы первый вызов упал, а последующие (откат)
// прошли: это модель сбоя в середине записи, когда stores уже очищены.
await page.evaluate(() => {
  const orig = window.DB.importAll;
  window.__origImportAll = orig;
  window.__rb = { calls: 0 };
  window.DB.importAll = function (data) {
    window.__rb.calls += 1;
    if (window.__rb.calls === 1) {
      return Promise.reject(new Error('симулированный сбой записи'));
    }
    return orig.call(window.DB, data);
  };
});

const snapBefore = await counts(page);
await page.click('[data-backup-confirm="run"]');
await page.waitForTimeout(3000);

const rollback = await page.evaluate(async () => {
  window.DB.importAll = window.__origImportAll;
  const after = {};
  for (const s of ['payments', 'meters', 'meter_readings', 'documents', 'tasks']) {
    after[s] = (await window.DB.getAll(s)).length;
  }
  return {
    after,
    restoreAttempted: window.__rb.calls >= 2,
    status: document.querySelector('[data-backup-status="import"]').textContent.trim()
  };
});

check('3.9.1 при сбое записи импорт пытается восстановить данные (откат вызван)',
  rollback.restoreAttempted, rollback);
check('3.9.2 после отката данные пользователя целы',
  JSON.stringify(rollback.after) === JSON.stringify(snapBefore),
  { before: snapBefore, after: rollback.after });
check('3.9.3 пользователь видит ошибку, а не молчаливую пустоту',
  /Ошибка импорта/.test(rollback.status), rollback.status);

// Восстанавливаем настоящий importAll и перечитываем раздел
await page.evaluate(() => { window.DB.importAll = window.DB.importAll; });

const bad = log();
check('3.8 итог: консоль без ошибок приложения', bad.length === 0, bad.slice(0, 6));

const fails = report('BACKUP', R);
await browser.close();
process.exit(fails ? 1 : 0);
