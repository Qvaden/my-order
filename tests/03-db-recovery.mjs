/**
 * Этап 11 / регрессия — self-healing соединения с БД.
 *
 * Реальные способы потерять соединение, не меняя код приложения:
 *   A) другая вкладка вызывает indexedDB.deleteDatabase() — по спецификации
 *      всем открытым соединениям приходит versionchange, наш обработчик
 *      закрывает соединение и обнуляет dbConnection;
 *   B) параллельные операции в момент потери соединения — переподключение
 *      не должно открыть базу N раз и не должно терять часть вызовов;
 *   C) другая вкладка поднимает версию схемы выше CURRENT_VERSION —
 *      приложение НЕ может восстановиться (IndexedDB не умеет понижение),
 *      но обязано датьпонятную причину, а не вечно жить с устаревшим
 *      window.DB_READY.
 *
 * До фикса (Этап 11, критический баг #1) во всех случаях приложение
 * показывало «База данных не инициализирована» и не восстанавливалось
 * даже по кнопке «Попробовать снова».
 */
import { open, seed, counts, BASE } from './harness.mjs';

const R = [];
const check = (n, p, v) => R.push({ name: n, pass: !!p, value: v });

const { browser, ctx, page, log } = await open();

await page.goto(BASE + '/#home', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await seed(page, {
  payments: [
    { title: 'Регрессия 1', amount: 1000, date: 2, category: 'Интернет' },
    { title: 'Регрессия 2', amount: 2000, date: 3, category: 'Подписки' }
  ]
});
const base = await counts(page);
check('A0 сидинг: 2 платежа', base.payments === 2, base);

// ---------- A. deleteDatabase из другой вкладки ----------
const dbName = await page.evaluate(() => window.DB.getName());
const page2 = await ctx.newPage();
await page2.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
await page2.evaluate((name) => new Promise((res, rej) => {
  const r = indexedDB.deleteDatabase(name);
  r.onsuccess = res;
  r.onerror = () => rej(r.error);
  r.onblocked = () => res();
}), dbName);
await page2.close();
await page.waitForTimeout(700);

const afterDelete = await page.evaluate(async () => {
  const out = { readyFlagBefore: window.DB_READY, isReadyBefore: window.DB.isReady() };
  try {
    out.count = (await window.DB.getAll('payments')).length;
    out.recovered = true;
  } catch (e) { out.recovered = false; out.error = e.message; }
  // Соединение пересоздаётся лениво — читаем состояние ПОСЛЕ операции
  out.isReady = window.DB.isReady();
  return out;
});
check('A1 после внешнего удаления БД операции восстанавливаются сами',
  afterDelete.recovered === true, afterDelete);
check('A2 соединение пересоздано (не «протухшее»)', afterDelete.isReady === true, afterDelete);
// Данные удалила внешняя вкладка — приложение их вернуть не может,
// но обязано продолжить работу с чистой базой, а не зависнуть.
check('A3 база пересоздана пустой, приложение живо', afterDelete.count === 0, afterDelete);

// ---------- B. Параллельные операции сразу после потери соединения ----------
const page3 = await ctx.newPage();
await page3.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
await page3.evaluate((name) => new Promise((res) => {
  const r = indexedDB.deleteDatabase(name);
  r.onsuccess = res; r.onerror = res; r.onblocked = res;
}), dbName);
await page3.close();

const parallel = await page.evaluate(async () => {
  const results = await Promise.allSettled([
    window.DB.getAll('payments'),
    window.DB.getAll('meters'),
    window.DB.getAll('documents'),
    window.DB.getAll('tasks'),
    window.DB.add('payments', { title: 'Гонка', amount: 500, date: '2099-01-01', category: 'Другое' }),
    window.DB.getAll('payments'),
    window.DB.count('payments'),
    window.DB.exportAll()
  ]);
  return {
    fulfilled: results.filter((r) => r.status === 'fulfilled').length,
    total: results.length,
    reasons: results.filter((r) => r.status === 'rejected').map((r) => String(r.reason && r.reason.message || r.reason))
  };
});
check('B1 8 параллельных операций после потери соединения — все успешны',
  parallel.fulfilled === parallel.total, parallel);

const afterRace = await page.evaluate(async () => ({
  count: (await window.DB.getAll('payments')).length,
  race: (await window.DB.getAll('payments')).filter((p) => p.title === 'Гонка').length
}));
// База была удалена внешней вкладкой → пересоздана пустой; из всей гонки
// должна пережить её ровно одна запись «Гонка», без дублей от ретраев.
check('B2 запись из гонки не потеряна, ретраи не создали дубликатов',
  afterRace.race === 1 && afterRace.count === 1, afterRace);

// ---------- C. Версия схемы выше текущей (восстановление невозможно) ----------
const page4 = await ctx.newPage();
await page4.goto(BASE + '/#home', { waitUntil: 'networkidle' });
await page4.evaluate(() => new Promise((res, rej) => {
  const name = window.DB.getName();
  const ver = window.DB.getVersion();
  const r = indexedDB.open(name, ver + 1);
  r.onupgradeneeded = () => {};
  r.onsuccess = () => { window.__keepDb = r.result; res(); };
  r.onerror = () => rej(r.error);
}));
await page.waitForTimeout(600);

const stale = await page.evaluate(async () => {
  const out = { readyFlag: window.DB_READY };
  try {
    await window.DB.getAll('payments');
    out.succeeded = true;
  } catch (e) { out.succeeded = false; out.error = e.message; }
  return out;
});
check('C1 при версии схемы выше текущей — операция отклонена, не зависла',
  stale.succeeded === false, stale);
check('C2 причина понятна пользователю (не «не инициализирована»)',
  /более новую версию|Обновите страницу/.test(stale.error || ''), stale.error);

// UI: экран ошибки с кнопкой повтора, а не бесконечный скелетон
await page.goto(BASE + '/#payments', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const ui = await page.evaluate(() => ({
  retry: !!document.querySelector('[data-action="retry"]'),
  text: (document.getElementById('app')?.innerText || '').slice(0, 90)
}));
check('C3 раздел показывает экран ошибки с кнопкой повтора', ui.retry, ui);

// ---------- D. Возврат к нормальной работе после обновления страницы ----------
await page4.evaluate(() => { if (window.__keepDb) window.__keepDb.close(); });
await page4.close();
// Приложение с CURRENT_VERSION не может открыть базу версии N+1 —
// единственный штатный путь: пересоздать базу (очистка сайта / новый дамп).
await page.evaluate((name) => new Promise((res) => {
  const r = indexedDB.deleteDatabase(name);
  r.onsuccess = res; r.onerror = res; r.onblocked = res;
}), dbName);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
const revived = await page.evaluate(async () => {
  try {
    await window.DB.add('payments', { title: 'Возврат', amount: 100, date: '2099-01-02', category: 'Другое' });
    return { ok: true, count: (await window.DB.getAll('payments')).length };
  } catch (e) { return { ok: false, error: e.message }; }
});
check('D1 после пересоздания базы приложение полностью работоспособно',
  revived.ok && revived.count === 1, revived);

const bad = log().filter((m) => !/более новую версию|VersionError|init\(\) завершился|Ошибка загрузки|Не удалось построить|Ошибка открытия базы/.test(m));
check('итог: нет ошибок кроме ожидаемых в сценариях C', bad.length === 0, bad.slice(0, 5));

const fails = R.filter((r) => !r.pass).length;
console.log(`\n===== DB SELF-HEALING: ${R.length - fails}/${R.length} PASS =====`);
R.forEach((r) => console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  →  ${JSON.stringify(r.value)}`));
await browser.close();
process.exit(fails ? 1 : 0);
