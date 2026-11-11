/**
 * Этап 11 / раздел 5 — фильтры и сортировка.
 * Сверяет UI-результат с независимым расчётом по тем же правилам модулей.
 */
import { open, gotoSection, seed, counts, resetAll, report, BASE } from './harness.mjs';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });
const { browser, page, log } = await open();
await resetAll(page);

const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

/** id карточек в DOM по селектору */
const domIds = (sel) => page.evaluate((s) =>
  [...document.querySelectorAll(s)].map((c) => Number(c.dataset.id)), sel);

/** Клик по чипу фильтра раздела */
async function chip(attr, value) {
  await page.click(`[${attr}="${value}"]`);
  await page.waitForTimeout(700);
}

const SPEC = {
  payments: [
    { title: 'P1 pending далёкий', amount: 100000, date: 20, category: 'Коммунальные', status: 'pending' },
    { title: 'P2 paid давний', amount: 200000, date: -20, category: 'Интернет', status: 'paid' },
    { title: 'P3 pending завтра', amount: 300000, date: 1, category: 'Подписки', status: 'pending' },
    { title: 'P4 paid вчера', amount: 400000, date: -1, category: 'Личные', status: 'paid' },
    { title: 'P5 pending сегодня', amount: 500000, date: 0, category: 'Другое', status: 'pending' }
  ],
  documents: [
    { name: 'D0 истекает сегодня', category: 'Страховка', expiryDate: 0, reminderDays: 14 },
    { name: 'D1 просрочен 10 дней', category: 'Паспорт', expiryDate: -10, reminderDays: 30 },
    { name: 'D2 истекает через 5', category: 'Медицинские', expiryDate: 5, reminderDays: 14 },
    { name: 'D3 активный 200', category: 'Договоры', expiryDate: 200, reminderDays: 30 },
    { name: 'D4 без срока', category: 'Другое', issuedDate: -100 },
    { name: 'D5 истекает через 25 при напоминании 7', category: 'Договоры', expiryDate: 25, reminderDays: 7 },
    { name: 'D6 просрочен 3 дня', category: 'Водительское удостоверение', expiryDate: -3, reminderDays: 30 }
  ],
  tasks: [
    { title: 'T1 просрочена', priority: 'low', dueDate: -5 },
    { title: 'T2 сегодня', priority: 'high', dueDate: 0 },
    { title: 'T3 завтра', priority: 'medium', dueDate: 1 },
    { title: 'T4 через неделю', priority: 'high', dueDate: 7 },
    { title: 'T5 без даты', priority: 'medium' },
    { title: 'T6 выполнена давно', priority: 'low', dueDate: -30, completed: true },
    { title: 'T7 просрочена выпол', priority: 'high', dueDate: -2, completed: true },
    { title: 'T8 сегодня низкий', priority: 'low', dueDate: 0 }
  ]
};

await seed(page, SPEC);
const all = await page.evaluate(async () => {
  const out = {};
  for (const s of ['payments', 'documents', 'tasks']) out[s] = await window.DB.getAll(s);
  return out;
});

// ---------- 5.1 Платежи: Ожидают / Оплаченные ----------
await gotoSection(page, 'payments', '.payment-card');
const payAll = await domIds('.payment-card');
check('5.1.1 фильтр «Все» показывает все 5 платежей', payAll.length === 5, payAll);

await chip('data-filter', 'pending');
const pend = await domIds('.payment-card');
const expectPend = all.payments.filter((p) => p.status === 'pending').map((p) => p.id).sort();
check('5.1.2 «Ожидают» = ровно pending-записи',
  pend.slice().sort().join() === expectPend.join(), { dom: pend, expect: expectPend });

await chip('data-filter', 'paid');
const paid = await domIds('.payment-card');
const expectPaid = all.payments.filter((p) => p.status === 'paid').map((p) => p.id).sort();
check('5.1.3 «Оплаченные» = ровно paid-записи',
  paid.slice().sort().join() === expectPaid.join(), { dom: paid, expect: expectPaid });
check('5.1.4 «Ожидают» + «Оплаченные» = все, без пересечений',
  pend.length + paid.length === 5 &&
  pend.filter((x) => paid.includes(x)).length === 0, { pend, paid });

// Сортировка «Ближайшие»/«Поздние»
await chip('data-filter', 'all');
const sortAsc = await domIds('.payment-card');
const ascExpected = all.payments.slice().sort((a, b) => a.date.localeCompare(b.date)).map((p) => p.id);
check('5.1.5 сортировка «Ближайшие»: по date asc',
  sortAsc.join() === ascExpected.join(), { dom: sortAsc, expect: ascExpected });

await page.click('[data-action="toggle-sort"]');
await page.waitForTimeout(700);
const sortDesc = await domIds('.payment-card');
check('5.1.6 переключение сортировки обращает порядок',
  sortDesc.join() === ascExpected.slice().reverse().join(), { dom: sortDesc });

const sortLabel = await page.evaluate(() =>
  document.querySelector('[data-action="toggle-sort"]').textContent.trim());
check('5.1.7 подпись сортировки меняется на «Поздние»', /Поздние/.test(sortLabel), sortLabel);

// Сброс фильтра
await chip('data-filter', 'paid');
await page.click('[data-action="reset-filter"]').catch(() => {});
await page.waitForTimeout(600);

// ---------- 5.2 Документы: «Истекают скоро» по reminderDays ----------
await gotoSection(page, 'documents', '.document-card');
const docsAll = await domIds('.document-card');
check('5.2.1 «Все» показывает все 7 документов', docsAll.length === 7, docsAll);

await chip('data-doc-filter', 'expiring');
const expiring = await domIds('.document-card');
// Независимый расчёт по правилам getStatus: days<=URGENT(7) → expiring,
// days<=30 → expiring; reminderDays порога для фильтра неused (getStatus зовётся с DEFAULT_REMINDER)
const daysUntil = (d) => Math.round((new Date(d + 'T00:00:00') - new Date(iso(0) + 'T00:00:00')) / 86400000);
const expExpect = all.documents.filter((d) => {
  if (!d.expiryDate) return false;
  const n = daysUntil(d.expiryDate);
  return n >= 0 && n <= 30;
}).map((d) => d.id).sort();
check('5.2.2 «Истекают скоро» = документы с 0 ≤ days ≤ 30',
  expiring.slice().sort().join() === expExpect.join(), { dom: expiring, expect: expExpect });

const todayDoc = all.documents.find((d) => d.name === 'D0 истекает сегодня');
check('5.2.3 документ, истекающий СЕГОДНЯ, в фильтре «Истекают скоро»',
  expiring.includes(todayDoc.id), { todayDocId: todayDoc.id, dom: expiring });

await chip('data-doc-filter', 'expired');
const expiredDom = await domIds('.document-card');
const expdExpect = all.documents.filter((d) => d.expiryDate && daysUntil(d.expiryDate) < 0)
  .map((d) => d.id).sort();
check('5.2.4 «Просрочены» = только days < 0',
  expiredDom.slice().sort().join() === expdExpect.join(), { dom: expiredDom, expect: expdExpect });

await chip('data-doc-filter', 'active');
const activeDom = await domIds('.document-card');
const activeExpect = all.documents.filter((d) => {
  if (!d.expiryDate) return true;
  const n = daysUntil(d.expiryDate);
  return n > 30;
}).map((d) => d.id).sort();
check('5.2.5 «Активные» = days > 30 и документы без срока',
  activeDom.slice().sort().join() === activeExpect.join(), { dom: activeDom, expect: activeExpect });

const sums = expiring.length + expiredDom.length + activeDom.length;
check('5.2.6 три фильтра покрывают все 7 документов без пересечений', sums === 7,
  { expiring: expiring.length, expired: expiredDom.length, active: activeDom.length });

// Сортировка документов: истекающие сверху, по expiryDate asc, без срока в конце
const docOrder = await page.evaluate(async () => {
  document.querySelector('[data-doc-filter="all"]').click();
  await new Promise((r) => setTimeout(r, 700));
  return [...document.querySelectorAll('.document-card')].map((c) => c.innerText.split('\n')[0]);
});
check('5.2.7 сортировка документов: просроченные и ближайшие — первыми',
  /D1 просрочен/.test(docOrder[0]) && /D6 просрочен/.test(docOrder[1]) && /D0 истекает сегодня/.test(docOrder[2]),
  docOrder);
check('5.2.8 документ без срока — в конце списка',
  /D4 без срока/.test(docOrder[docOrder.length - 1]), docOrder);

// ---------- 5.3 Задачи: просроченные → сегодня → будущие ----------
await gotoSection(page, 'tasks', '.task-card');
const taskOrder = await domIds('.task-card');
const taskTitles = await page.evaluate(() =>
  [...document.querySelectorAll('.task-card')].map((c) => c.querySelector('.task-card__title').textContent.trim()));
const pos = (t) => taskTitles.findIndex((x) => x.startsWith(t));

check('5.3.1 «Все»: невыполненные выше выполненных',
  pos('T6') > pos('T1') && pos('T7') > pos('T3'), taskTitles);
check('5.3.2 просроченные — первыми',
  pos('T1') === 0, { order: taskTitles, t1: pos('T1') });
check('5.3.3 сегодня — раньше будущих',
  pos('T2') < pos('T3') && pos('T3') < pos('T4'), taskTitles);
check('5.3.4 задачи без даты — в конце (среди невыполненных)',
  pos('T5') > pos('T4'), taskTitles);
check('5.3.5 при равных датах приоритет определяет порядок: high перед low',
  pos('T2') < pos('T8'), { t2: pos('T2'), t8: pos('T8'), order: taskTitles });

// Фильтры задач
const taskFilters = await page.evaluate(() =>
  [...document.querySelectorAll('[data-task-filter]')].map((c) => c.getAttribute('data-task-filter')));
check('5.3.6 чипы фильтров задач присутствуют', taskFilters.length >= 3, taskFilters);

if (taskFilters.includes('overdue')) {
  await chip('data-task-filter', 'overdue');
  const od = await page.evaluate(() =>
    [...document.querySelectorAll('.task-card')].map((c) => c.querySelector('.task-card__title').textContent.trim()));
  const odExpect = all.tasks.filter((t) => !t.completed && t.dueDate && daysUntil(t.dueDate) < 0)
    .map((t) => t.title).sort();
  check('5.3.7 «Просроченные» = только невыполненные с dueDate < сегодня',
    od.slice().sort().join('§') === odExpect.join('§'), { dom: od, expect: odExpect });
}

if (taskFilters.includes('today')) {
  await chip('data-task-filter', 'today');
  const td = await page.evaluate(() =>
    [...document.querySelectorAll('.task-card')].map((c) => c.querySelector('.task-card__title').textContent.trim()));
  const tdExpect = all.tasks.filter((t) => !t.completed && t.dueDate === iso(0)).map((t) => t.title).sort();
  check('5.3.8 «Сегодня» = невыполненные задачи на сегодня',
    td.slice().sort().join('§') === tdExpect.join('§'), { dom: td, expect: tdExpect });
}

// Комбинация «Выполненные» + «Просрочены»: последовательные фильтры не ломают список
await chip('data-task-filter', 'completed');
const comp = await page.evaluate(() =>
  [...document.querySelectorAll('.task-card')].map((c) => ({
    title: c.querySelector('.task-card__title').textContent.trim(),
    done: c.classList.contains('task-card--completed') || !!c.querySelector('.task-checkbox:checked')
  })));
check('5.3.9 «Выполненные» показывает только выполненные', comp.length === 2 && comp.every((c) => c.done), comp);

await chip('data-task-filter', 'overdue');
const afterCombo = await page.evaluate(() => ({
  cards: document.querySelectorAll('.task-card').length,
  hasBroken: !!document.querySelector('[data-action="retry"]'),
  empty: !!document.querySelector('.empty-state')
}));
check('5.3.10 последовательная смена фильтров не ломает список',
  !afterCombo.hasBroken && (afterCombo.cards > 0 || afterCombo.empty), afterCombo);

await chip('data-task-filter', 'all');
const backAll = await domIds('.task-card');
check('5.3.11 возврат к «Все» восстанавливает полный список',
  backAll.length === all.tasks.length, { dom: backAll.length, db: all.tasks.length });

// ---------- 5.12 Фильтр на пустом результате ----------
// Делаем так, чтобы в состоянии «Ожидают» не осталось ни одной записи:
// помечаем все платежи оплаченными и заставляем модуль перечитать кэш.
await page.evaluate(async () => {
  const all = await window.DB.getAll('payments');
  for (const p of all) { await window.DB.update('payments', p.id, { status: 'paid' }); }
  window.Payments.invalidate();
});
await gotoSection(page, 'home', '.home-summary');
await gotoSection(page, 'payments', '.empty-state, .payment-card');
await chip('data-filter', 'pending');
const filtered = await page.evaluate(() => ({
  cards: document.querySelectorAll('.payment-card').length,
  hasEmptyState: !!document.querySelector('.empty-state'),
  emptyText: (document.querySelector('.empty-state') || {}).innerText || '',
  hasBroken: !!document.querySelector('[data-action="retry"]')
}));
check('5.12 пустой результат фильтра даёт empty-state, а не broken UI',
  filtered.hasEmptyState && filtered.cards === 0 && !filtered.hasBroken, filtered);
check('5.12b empty-state при активном фильтре объясняет, что записей нет по фильтру',
  /фильтр|нет|не найдено|не найдены/i.test(filtered.emptyText), filtered.emptyText);

await chip('data-filter', 'all');
const recovered = await page.evaluate(() => document.querySelectorAll('.payment-card').length);
check('5.13 сброс фильтра возвращает все карточки', recovered > 0, recovered);

const bad = log();
check('5.14 итог: консоль чиста', bad.length === 0, bad.slice(0, 6));

const fails = report('FILTERS & SORTING', R);
await browser.close();
process.exit(fails ? 1 : 0);
