/**
 * Этап 11 / раздел 2 — сохранность данных (critical path).
 * Создание, persistence, отсутствие дубликатов, целостность связей.
 */
import { open, gotoSection, seed, counts, rows, resetAll, report, check, BASE } from './harness.mjs';

const R = [];
const { browser, page, log } = await open();

await resetAll(page);

// ---------- 2a. Создание данных (через UI-формы, не только API) ----------
await gotoSection(page, 'payments', '.empty-state, .payment-card');

async function uiAddPayment({ title, amount, date, category, frequency, paid }) {
  await page.evaluate(() => window.Payments.openAddForm());
  await page.waitForSelector('.modal-content', { timeout: 4000 });
  await page.fill('#f-title', title);
  await page.fill('#f-amount', String(amount));
  await page.fill('#f-date', date);
  await page.selectOption('#f-category', { label: category }).catch(async () => {
    await page.selectOption('#f-category', category);
  });
  if (frequency && frequency !== 'once') {
    await page.selectOption('#f-frequency', { label: 'Ежемесячно' });
  }
  if (paid) { await page.check('#f-paid').catch(() => {}); }
  await page.click('.modal-content button[type="submit"]');
  await page.waitForTimeout(600);
}

const todayISO = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

await uiAddPayment({ title: 'Аренда квартиры', amount: '45000', date: todayISO(3), category: 'Коммунальные', frequency: 'monthly' });
await uiAddPayment({ title: 'Интернет', amount: '650', date: todayISO(1), category: 'Интернет', frequency: 'once' });
await uiAddPayment({ title: 'Фитнес', amount: '2500', date: todayISO(7), category: 'Личные', frequency: 'monthly' });

const afterUI = await counts(page);
check(R, '2a.1 UI-формы создают 3 платежа', afterUI.payments === 3, afterUI.payments);

// Остальные сущности — seed-ом (их UI-создание проверяется в разделе 4)
const ids = await seed(page, {
  meters: [
    { name: 'ХВС кухня', type: 'cold', initialValue: 100, readings: [{ value: 105, date: -20 }, { value: 112, date: -10 }, { value: 120, date: -1 }] },
    { name: 'Электричество', type: 'electricity', initialValue: 4000, readings: [{ value: 4050, date: -20 }, { value: 4110, date: -10 }, { value: 4200, date: -1 }] }
  ],
  documents: [
    { name: 'Полис ОСАГО', category: 'Страховка', issuedDate: -300, expiryDate: 5, reminderDays: 14 },
    { name: 'Паспорт (проверка)', category: 'Паспорт', expiryDate: -10, reminderDays: 30 },
    { name: 'Договор аренды', category: 'Договоры', issuedDate: -60, expiryDate: 200, reminderDays: 30 }
  ],
  tasks: [
    { title: 'Передать показания', priority: 'high', dueDate: -2 },
    { title: 'Оплатить проезд', priority: 'medium', dueDate: 0 },
    { title: 'Купить подарок', priority: 'low', dueDate: 5 },
    { title: 'Генуборка', priority: 'medium', dueDate: 3, recurring: 'weekly' },
    { title: 'Полить цветы', priority: 'low', dueDate: -1, completed: true }
  ]
});

await gotoSection(page, 'payments', '.payment-card');
const base = await counts(page);
check(R, '2a.2 полный набор создан',
  base.payments === 3 && base.meters === 2 && base.meter_readings === 6 &&
  base.documents === 3 && base.tasks === 5, base);

// ---------- 2b. Persistence ----------
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const afterReload = await counts(page);
check(R, '2b.1 данные на месте после F5', JSON.stringify(afterReload) === JSON.stringify(base), afterReload);

// Закрытие и повторное открытие вкладки (новый page в том же контексте)
const ctx = page.context();
await page.close();
const page2 = await ctx.newPage();
page2.on('pageerror', (e) => log().push('[pageerror2] ' + e.message));
await page2.goto(BASE + '/#home', { waitUntil: 'networkidle' });
await page2.waitForTimeout(1400);
const afterReopen = await counts(page2);
check(R, '2b.2 данные на месте после закрытия вкладки',
  JSON.stringify(afterReopen) === JSON.stringify(base), afterReopen);

// Переключение разделов туда-сюда
for (let i = 0; i < 3; i++) {
  for (const h of ['payments', 'meters', 'documents', 'tasks', 'stats', 'home']) {
    await page2.goto(`${BASE}/#${h}`, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(320);
  }
}
const afterNav = await counts(page2);
check(R, '2b.3 данные не теряются при 18 переходах между разделами',
  JSON.stringify(afterNav) === JSON.stringify(base), afterNav);

// Значения, а не только количество: сверка конкретного платежа и показаний
const exact = await page2.evaluate(async () => {
  const p = (await window.DB.getAll('payments')).find((x) => x.title === 'Аренда квартиры');
  const readings = await window.DB.getAll('meter_readings');
  return {
    rent: p ? { amount: p.amount, category: p.category, frequency: p.frequency, date: p.date } : null,
    readingsCount: readings.length,
    firstValue: readings.length ? Math.min(...readings.map((r) => r.value)) : null
  };
});
check(R, '2b.4 поля записи сохранены побайтово',
  // Сумма хранится в целых копейках: ввод 45000 → 4500000
  exact.rent && exact.rent.amount === 4500000 && exact.rent.category === 'Коммунальные' &&
  exact.rent.frequency === 'monthly' && exact.readingsCount === 6, exact);

// ---------- 2c. Дублирование ----------
let dup = null;
for (let i = 0; i < 5; i++) {
  await page2.reload({ waitUntil: 'networkidle' });
  await page2.waitForTimeout(900);
}
dup = await counts(page2);
check(R, '2c.1 5 перезагрузок подряд → количество НЕ выросло',
  JSON.stringify(dup) === JSON.stringify(base), dup);

// Recurring-платёж: приложение не авто-генерирует экземпляры (v2 в TODO),
// значит 5 перезагрузок не должны создать ни одной новой записи — уже
// подтверждено выше. Проверяем отдельно, что шаблон помечен и не размножается.
const templates = await page2.evaluate(async () => {
  const all = await window.DB.getAll('payments');
  return {
    monthly: all.filter((p) => p.frequency === 'monthly').length,
    templates: all.filter((p) => p.isTemplate).length,
    titles: all.map((p) => p.title).sort()
  };
});
check(R, '2c.2 recurring-платежи: ровно 1 экземпляр на период',
  templates.monthly === 2 && templates.templates === 2 &&
  new Set(templates.titles).size === templates.titles.length, templates);

// Recurring-задача: завершение создаёт СЛЕДУЮЩИЙ экземпляр, но не дублирует его.
// Сначала открываем раздел задач: toggleComplete ищет задачу во внутреннем
// кэше модуля, который наполняется только при рендере списка.
await gotoSection(page2, 'tasks', '.task-card');
const taskDup = await page2.evaluate(async () => {
  const before = (await window.DB.getAll('tasks')).length;
  const gen = (await window.DB.getAll('tasks')).find((t) => t.recurring === 'weekly');
  window.Tasks.toggleComplete(gen.id);
  await new Promise((r) => setTimeout(r, 900));
  const afterFirst = (await window.DB.getAll('tasks')).length;
  // Повторное переключение туда-сюда не должно спамить копиями
  const fresh = (await window.DB.getAll('tasks')).find((t) => t.recurring === 'weekly' && !t.completed);
  window.Tasks.toggleComplete(fresh.id);
  await new Promise((r) => setTimeout(r, 700));
  window.Tasks.toggleComplete(fresh.id);
  await new Promise((r) => setTimeout(r, 700));
  const afterToggle = (await window.DB.getAll('tasks'));
  return {
    before, afterFirst, afterToggle: afterToggle.length,
    byDate: afterToggle.filter((t) => t.title === 'Генуборка').map((t) => t.dueDate + (t.completed ? ':done' : ':open')).sort()
  };
});
check(R, '2c.3 recurring-задача: 1 копия на период, без спама при переключениях',
  taskDup.afterFirst === taskDup.before + 1 &&
  new Set(taskDup.byDate).size === taskDup.byDate.length, taskDup);

// ---------- 2d. Связи ----------
const cascade = await page2.evaluate(async () => {
  const meters = await window.DB.getAll('meters');
  const target = meters.find((m) => m.name === 'ХВС кухня');
  const readingsBefore = (await window.DB.getAll('meter_readings')).filter((r) => r.meterId === target.id).length;
  const totalBefore = (await window.DB.getAll('meter_readings')).length;

  // UI-путь удаления (модалка → подтверждение)
  document.querySelector('.nav-bottom__item[data-hash="#meters"]').click();
  await new Promise((r) => setTimeout(r, 900));
  const card = document.querySelector(`.meter-card[data-id="${target.id}"]`);
  if (!card) return { error: 'meter card not rendered', readingsBefore };
  card.querySelector('[data-action="delete-meter"]').click();
  await new Promise((r) => setTimeout(r, 500));
  const confirm = document.querySelector('.modal-content [data-action="confirm"]');
  if (!confirm) return { error: 'confirm button missing' };
  confirm.click();
  await new Promise((r) => setTimeout(r, 1400));

  const readingsAfter = await window.DB.getAll('meter_readings');
  return {
    targetId: target.id, readingsBefore, totalBefore,
    metersLeft: (await window.DB.getAll('meters')).length,
    readingsLeft: readingsAfter.length,
    orphan: readingsAfter.filter((r) => r.meterId === target.id).length,
    otherIntact: readingsAfter.filter((r) => r.meterId !== target.id).length
  };
});
check(R, '2d.1 удаление счётчика → показания удалены каскадно',
  !cascade.error && cascade.orphan === 0 &&
  cascade.readingsLeft === cascade.totalBefore - cascade.readingsBefore &&
  cascade.otherIntact === cascade.totalBefore - cascade.readingsBefore, cascade);

check(R, '2d.2 чужие показания не пострадали',
  cascade.metersLeft === 1 && cascade.otherIntact === 3, cascade);

const bad = log();
check(R, '2.3 итог: консоль чистая на всём критическом пути', bad.length === 0, bad.slice(0, 6));

const fails = report('PERSISTENCE', R);
await browser.close();
process.exit(fails ? 1 : 0);
