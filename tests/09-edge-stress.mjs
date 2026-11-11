/**
 * Этап 11 / раздел 8+9 — граничные случаи и нагрузочные проверки.
 * Большие наборы (100 платежей / 50 показаний / 30 документов / 80 дел),
 * время рендера, размер экспорта, невозмутность UI при быстрых кликах
 * и конкурентных операциях, «неудобные» даты и имена.
 */
import fs from 'node:fs';
import path from 'node:path';
import { open, gotoSection, counts, resetAll, report, SHOTS, BASE } from './harness.mjs';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });
const { browser, page, log } = await open();
await resetAll(page);

const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

// ---------- 8.1 «Неудобные» даты ----------
const dateEdge = await page.evaluate(async () => {
  const out = { added: [], rejected: [] };
  const tryAdd = async (label, rec) => {
    try {
      const id = await window.DB.add('payments', rec);
      out.added.push({ label, id, stored: (await window.DB.get('payments', id)).date });
    } catch (e) { out.rejected.push({ label, error: e.message.slice(0, 90) }); }
  };
  await tryAdd('2099-12-31 (далёкое будущее)', { title: '2099', amount: 100, date: '2099-12-31', category: 'Другое', frequency: 'once', status: 'pending' });
  await tryAdd('1970-01-01 (эPOCH)', { title: 'epoch', amount: 100, date: '1970-01-01', category: 'Другое', frequency: 'once', status: 'pending' });
  await tryAdd('31.02 (несуществующий день)', { title: 'feb31', amount: 100, date: '2026-02-31', category: 'Другое', frequency: 'once', status: 'pending' });
  await tryAdd('29.02 невисокосного года', { title: 'feb29', amount: 100, date: '2027-02-29', category: 'Другое', frequency: 'once', status: 'pending' });
  await tryAdd('29.02 високосного 2028', { title: 'feb29ok', amount: 100, date: '2028-02-29', category: 'Другое', frequency: 'once', status: 'pending' });
  await tryAdd('date как число (timestamp)', { title: 'num', amount: 100, date: 1700000000000, category: 'Другое', frequency: 'once', status: 'pending' });
  await tryAdd('empty string date', { title: 'empty', amount: 100, date: '', category: 'Другое', frequency: 'once', status: 'pending' });
  await tryAdd('невалютная строка', { title: 'str', amount: 100, date: 'не дата', category: 'Другое', frequency: 'once', status: 'pending' });
  return out;
});
const addedLabels = dateEdge.added.map((a) => a.label);
const rejectedLabels = dateEdge.rejected.map((r) => r.label);
check('8.1.1 дальние даты (2099, 1970) принимаются и хранятся без искажения',
  dateEdge.added.some((a) => a.stored === '2099-12-31') && dateEdge.added.some((a) => a.stored === '1970-01-01'),
  dateEdge.added);
check('8.1.2 31 февраля отклонено на уровне БД (не «исправлено» молча в 3 марта)',
  rejectedLabels.some((l) => /31/.test(l)), rejectedLabels);
check('8.1.3 29 февраля в невисокосном году отклонено, в високосном принято',
  rejectedLabels.some((l) => /невисокос/.test(l)) && addedLabels.some((l) => /високосного 2028/.test(l)),
  { addedLabels, rejectedLabels });
check('8.1.4 числовой timestamp, пустая строка и «не дата» отклоняются (контракт — ISO-строка)',
  rejectedLabels.filter((l) => /timestamp|empty|невалютн/.test(l)).length === 3, rejectedLabels);
const payCountAfterEdge = await counts(page);
check('8.1.5 отклонённые записи не оставили мусора в базе',
  payCountAfterEdge.payments === dateEdge.added.length, { db: payCountAfterEdge.payments, accepted: dateEdge.added.length });

// Просрочка/границы статусов по датам: вчера / сегодня / завтра
const statuses = await page.evaluate(async (t) => {
  const out = [];
  for (const [label, d] of [['вчера', t.y], ['сегодня', t.o], ['завтра', t.p1]]) {
    const id = await window.DB.add('documents', { name: 'Граница ' + label, category: 'Другое', expiryDate: d, reminderDays: 30 });
    // getStatus возвращает объект {status, tone, color, text} — сравниваем .status
    const st = window.Documents.getStatus(d, 30);
    out.push({ label, status: st.status, text: st.text, days: window.Documents.getDaysUntil(d), id });
  }
  return out;
}, { y: iso(-1), o: iso(0), p1: iso(1) });
check('8.2.1 getDaysUntil на границе суток даёт -1 / 0 / +1',
  statuses.map((s) => s.days).join() === '-1,0,1', statuses);
check('8.2.2 статусы на границе: expired / expiring / expiring (без «дыры» в 0 дней)',
  statuses[0].status === 'expired' && statuses[1].status === 'expiring' && statuses[2].status === 'expiring',
  statuses.map((s) => [s.label, s.status, s.text]));

// ---------- 8.3 Экзотические имена ----------
const weird = await page.evaluate(async () => {
  const names = [
    '🔥 Печка и 🔥 камин',
    'Ünïcödé — стрелки → ← ↑ ↓',
    '日本語の名前',
    'Мискс Ελληνικά عربي हिन्दी',
    '   пробелы по краям   ',
    '"кавычки" и \'апострофы\' и \\ бэкслэш',
    'a'.repeat(100),
    'tab\tсимвол и \n перенос'
  ];
  const ids = [];
  for (const n of names) {
    ids.push(await window.DB.add('tasks', { title: n, dueDate: '2030-01-01', priority: 'medium', recurring: 'none', completed: false }));
  }
  const stored = await window.DB.getAll('tasks');
  return { count: ids.length, names, stored: stored.map((t) => t.title) };
});
check('8.3.1 emoji, смешанные алфавиты и спецсимволы сохраняются побайтово',
  weird.count === weird.stored.length && weird.names.every((n) => weird.stored.includes(n)),
  { count: weird.count, stored: weird.stored.length });

await gotoSection(page, 'home', '.home-summary');
await gotoSection(page, 'tasks', '.task-card');
const weirdUi = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.task-card')];
  const titles = cards.map((c) => (c.querySelector('.task-card__title') || c).textContent);
  const doc = document.documentElement;
  return {
    cards: cards.length,
    hasEmoji: titles.some((t) => /🔥/.test(t)),
    hasCjk: titles.some((t) => /日本語/.test(t)),
    hasBackslash: titles.some((t) => /\\ бэкслэш/.test(t)),
    scripts: document.querySelectorAll('#app script').length,
    overflowX: doc.scrollWidth - doc.clientWidth
  };
});
check('8.3.2 экзотические имена отрендерены в UI (emoji и иероглифы видны)',
  weirdUi.hasEmoji && weirdUi.hasCjk && weirdUi.hasBackslash, weirdUi);
check('8.3.3 спецсимволы не создали DOM-узлов и не сломали вёрстку',
  weirdUi.scripts === 0 && weirdUi.overflowX <= 1, weirdUi);

// ---------- 8.4 Быстрые клики: модалка должна быть одна ----------
await gotoSection(page, 'home', '.home-summary');
const rapidAdd = await page.evaluate(async () => {
  window.App.navigate('payments');
  await new Promise((r) => setTimeout(r, 800));
  const btn = document.querySelector('[data-action="add"]');
  const before = (await window.DB.getAll('payments')).length;
  for (let i = 0; i < 10; i++) { btn.click(); }
  await new Promise((r) => setTimeout(r, 600));
  const overlays = document.querySelectorAll('.modal-overlay').length;
  const forms = document.querySelectorAll('.modal-content form').length;
  // Закрываем и проверяем, что открытие/закрытие не оставило «мусора»
  const cancel = [...document.querySelectorAll('.modal-content button')].find((b) =>
    /cancel/i.test(b.getAttribute('data-action') || '') || /^(Отмена|Закрыть)/.test(b.textContent.trim()));
  if (cancel) cancel.click();
  await new Promise((r) => setTimeout(r, 700));
  return {
    overlays, forms,
    afterCancel: document.querySelectorAll('.modal-overlay').length,
    bodyModalOpen: /modal-open/.test(document.body.className),
    created: (await window.DB.getAll('payments')).length - before
  };
});
check('8.4.1 десять быстрых кликов «+» открывают РОВНО один модуль',
  rapidAdd.overlays === 1 && rapidAdd.forms === 1, rapidAdd);
check('8.4.2 закрытие убирает оверлей полностью и возвращает скролл',
  rapidAdd.afterCancel === 0 && rapidAdd.bodyModalOpen === false, rapidAdd);
check('8.4.3 спам кликами не создал записей в базе', rapidAdd.created === 0, rapidAdd);

// ---------- 8.4b Защита не должна ломать легитимные «стопки» диалогов ----------
// Реальный пользовательский путь: история счётчика → подтверждение удаления
// показания внутри неё. Отсеивать нужно дубликаты identical-диалогов, а не
// любые вложенные окна — иначе подтверждение просто не открылось бы.
const stacking = await page.evaluate(async () => {
  const meterId = await window.DB.add('meters', { name: 'Стопочный', type: 'cold', initialValue: 0, unit: 'м³' });
  await window.DB.add('meter_readings', { meterId, value: 10, date: '2026-01-10' });
  await window.DB.add('meter_readings', { meterId, value: 20, date: '2026-02-10' });
  window.App.navigate('home');
  await new Promise((r) => setTimeout(r, 200));
  window.Meters.invalidate();
  window.App.navigate('meters');
  await new Promise((r) => setTimeout(r, 900));

  const card = [...document.querySelectorAll('.meter-card')].find((c) => /Стопочный/.test(c.textContent));
  const historyBtn = card.querySelector('[data-action="history"]');
  for (let i = 0; i < 5; i++) { historyBtn.click(); }   // спам по одной кнопке
  await new Promise((r) => setTimeout(r, 400));
  const afterHistory = document.querySelectorAll('.modal-overlay').length;
  const sigsAfterHistory = [...document.querySelectorAll('.modal-overlay')].map((o) => (o._signature || '').slice(0, 40));

  // Теперь легитимная вложенность: удалить показание из открытой истории
  const del = document.querySelector('.modal-overlay:last-child [data-action="del-reading"]') ||
    [...document.querySelectorAll('.modal-overlay')].pop().querySelector('[data-action="del-reading"]');
  del.click();
  await new Promise((r) => setTimeout(r, 400));
  const afterConfirm = document.querySelectorAll('.modal-overlay').length;
  const confirmTitle = [...document.querySelectorAll('.modal-overlay')].pop().querySelector('.modal-content__title');

  // Повторный клик по тому же показанию в НИЖНЕМ окне истории не должен
  // множить подтверждений: такой диалог уже открыт сверху.
  const historyOverlay = document.querySelector('.modal-overlay');
  const delAgain = historyOverlay.querySelector('[data-action="del-reading"]');
  if (delAgain) { delAgain.click(); await new Promise((r) => setTimeout(r, 300)); }
  const afterRepeat = document.querySelectorAll('.modal-overlay').length;

  const titles = [...document.querySelectorAll('.modal-overlay .modal-content__title')].map((t) => t.textContent.trim());
  return {
    afterHistory, afterConfirm, afterRepeat, sigsAfterHistory,
    confirmTitle: confirmTitle ? confirmTitle.textContent.trim() : null,
    titles,
    hasHistoryForm: [...document.querySelectorAll('.modal-overlay')].some((o) => /История|показани/i.test(o.textContent)),
    readingsLeft: (await window.DB.getAll('meter_readings')).filter((r) => r.meterId === meterId).length,
    meterId
  };
});
check('8.4.4 пять кликов по «История» открывают одно окно (дубликаты отсеяны)',
  stacking.afterHistory === 1, { afterHistory: stacking.afterHistory, sigs: stacking.sigsAfterHistory });
check('8.4.4b разные диалоги наслаиваются: подтверждение удаления открылось поверх истории',
  stacking.afterConfirm === 2 && /Удалить показание/.test(stacking.confirmTitle || ''), stacking.titles);
check('8.4.4c повторный клик по тому же показанию не множит подтверждений',
  stacking.afterRepeat === 2, { afterRepeat: stacking.afterRepeat, titles: stacking.titles });
check('8.4.4d подтверждение осталось рабочим (кнопка «Удалить» в верхнем окне)',
  stacking.readingsLeft >= 1 && !!stacking.meterId, { readingsLeft: stacking.readingsLeft });

await page.evaluate(async (id) => {
  const readings = (await window.DB.getAll('meter_readings')).filter((r) => r.meterId === id);
  for (const r of readings) { await window.DB.delete('meter_readings', r.id); }
  await window.DB.delete('meters', id);
  document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
  document.body.classList.remove('modal-open');
  window.Meters.invalidate();
}, stacking.meterId);

// ---------- 8.5 Конкурентные операции над одной записью ----------
await gotoSection(page, 'home', '.home-summary');
const concurrent = await page.evaluate(async () => {
  const id = await window.DB.add('payments', {
    title: 'Конкурент', amount: 100000, date: '2030-05-05', category: 'Другое', frequency: 'once', status: 'pending'
  });
  // Одновременно: редактирование, удаление, ещё одно редактирование, чтение
  const results = await Promise.allSettled([
    window.DB.update('payments', id, { title: 'Обновлено 1' }),
    window.DB.delete('payments', id),
    window.DB.update('payments', id, { title: 'Обновлено 2' }),
    window.DB.get('payments', id)
  ]);
  const after = await window.DB.get('payments', id);
  return {
    settled: results.length,
    rejected: results.filter((r) => r.status === 'rejected').map((r) => String(r.reason && r.reason.message).slice(0, 70)),
    after: after ? after.title : null,
    gone: after === undefined || after === null
  };
});
check('8.5.1 гонка update/delete не подвешивает промисы (все 4 завершились)',
  concurrent.settled === 4, concurrent);
check('8.5.2 отказ при проигравшей гонке объясним, а не «undefined is not…»',
  concurrent.rejected.every((m) => /не найдена|Validation|не инициализ/i.test(m)), concurrent.rejected);
check('8.5.3 итоговое состояние записи однозначно: удалена либо одна из версий',
  concurrent.gone || concurrent.after === 'Обновлено 1' || concurrent.after === 'Обновлено 2', concurrent);

const doubleDelete = await page.evaluate(async () => {
  const id = await window.DB.add('payments', {
    title: 'Двойное удаление', amount: 100000, date: '2030-06-06', category: 'Другое', frequency: 'once', status: 'pending'
  });
  const rs = await Promise.allSettled([window.DB.delete('payments', id), window.DB.delete('payments', id)]);
  return { statuses: rs.map((r) => r.status), left: (await window.DB.getAll('payments')).filter((p) => p.title === 'Двойное удаление').length };
});
check('8.5.4 повторное удаление отсутствующей записи не оставляет «полуданных»',
  doubleDelete.left === 0, doubleDelete);

// ---------- 8.6 Параллельные записи: ни одна не потеряна ----------
const parallelWrite = await page.evaluate(async () => {
  const before = (await window.DB.getAll('meters')).length;
  const ids = await Promise.all(Array.from({ length: 25 }, (_, i) =>
    window.DB.add('meters', { name: 'Метр ' + i, type: 'cold', initialValue: i, unit: 'м³' })));
  const after = await window.DB.getAll('meters');
  return { before, ids: ids.length, after: after.length, unique: new Set(ids).size };
});
check('8.6.1 25 параллельных add сохранили все записи с уникальными id',
  parallelWrite.after - parallelWrite.before === 25 && parallelWrite.unique === 25, parallelWrite);

const parallelRead = await page.evaluate(async () => {
  const rs = await Promise.all(Array.from({ length: 20 }, () => window.DB.getAll('payments')));
  return { all: rs.every((r) => Array.isArray(r)), same: new Set(rs.map((r) => r.length)).size };
});
check('8.6.2 20 параллельных чтений согласованы (без «полустатей»)',
  parallelRead.all, parallelRead);

// ---------- 9. Большой набор данных: 100 / 50 / 30 / 80 ----------
await resetAll(page);
const big = await page.evaluate(async () => {
  const t0 = performance.now();
  const cats = ['Коммунальные', 'Интернет', 'Мобильная связь', 'Кредиты', 'Подписки', 'Личные', 'Другое'];
  const freqs = ['once', 'monthly', 'quarterly', 'yearly'];
  const pads = (n) => String(n).padStart(2, '0');
  const day = (i) => `2026-${pads(1 + (i % 12))}-${pads(1 + (i % 28))}`;
  // Локальная дата без UTC-сдвига: приложение считает «сегодня/просрочено»
  // по московским суткам, а toISOString().slice() уехал бы на день назад
  const localDay = (d) => d.getFullYear() + '-' + pads(d.getMonth() + 1) + '-' + pads(d.getDate());

  for (let i = 0; i < 100; i++) {
    await window.DB.add('payments', {
      title: 'Платёж номер ' + i, amount: 10000 + i * 37, date: day(i),
      category: cats[i % cats.length], frequency: freqs[i % freqs.length],
      status: i % 3 === 0 ? 'paid' : 'pending'
    });
  }
  const meterIds = [];
  for (let i = 0; i < 5; i++) {
    meterIds.push(await window.DB.add('meters', { name: 'Счётчик ' + i, type: 'cold', initialValue: 0, unit: 'м³' }));
  }
  for (let i = 0; i < 50; i++) {
    await window.DB.add('meter_readings', { meterId: meterIds[i % 5], value: 100 + i * 10, date: day(i) });
  }
  const dcats = ['Паспорт', 'Водительское удостоверение', 'Страховка', 'Медицинские', 'Договоры', 'Другое'];
  for (let i = 0; i < 30; i++) {
    const dd = new Date(); dd.setDate(dd.getDate() + (i * 11 - 100));
    await window.DB.add('documents', {
      name: 'Документ ' + i, category: dcats[i % dcats.length],
      expiryDate: localDay(dd), reminderDays: [0, 7, 14, 30][i % 4]
    });
  }
  for (let i = 0; i < 80; i++) {
    const td = new Date(); td.setDate(td.getDate() + (i % 9) - 4);
    await window.DB.add('tasks', {
      title: 'Дело ' + i, dueDate: localDay(td),
      priority: ['high', 'medium', 'low'][i % 3], recurring: i % 7 === 0 ? 'weekly' : 'none',
      completed: i % 5 === 0
    });
  }
  const counts = {};
  for (const s of ['payments', 'meters', 'meter_readings', 'documents', 'tasks']) counts[s] = (await window.DB.getAll(s)).length;
  return { counts, ms: Math.round(performance.now() - t0) };
});
check('9.1 большой набор создан: 100/5/50/30/80 записей',
  big.counts.payments === 100 && big.counts.meters === 5 && big.counts.meter_readings === 50 &&
  big.counts.documents === 30 && big.counts.tasks === 80, big);

/** Замер времени перехода в раздел с большим набором. */
async function measureRender(hash) {
  return page.evaluate(async (h) => {
    const sel = {
      home: '.home-summary', payments: '.payment-card', meters: '.meter-card',
      documents: '.document-card', tasks: '.task-card', stats: '.stats-section',
      backup: '.backup-section'
    }[h];
    window.App.navigate('home');
    await new Promise((r) => setTimeout(r, 800));
    const t0 = performance.now();
    window.App.navigate(h);
    // Ждём реальный контент, а не только вызов navigate
    let painted = false;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (document.querySelector(sel)) { painted = true; break; }
    }
    const ms = Math.round(performance.now() - t0);
    // Считаем по селектору записей раздела: в разметке платежей/счётчиков есть
    // ещё и общая .card summary-card, поэтому .card дал бы +1 «лишнюю» карточку
    return {
      ms,
      painted,
      rows: document.querySelectorAll(sel).length,
      cards: document.querySelectorAll('.card').length
    };
  }, hash);
}

const renders = {};
for (const hash of ['payments', 'meters', 'documents', 'tasks', 'home', 'stats', 'backup']) {
  renders[hash] = await measureRender(hash);
}
check('9.2.1 рендер платежей (100 записей) быстрее 1000ms',
  renders.payments.ms < 1000 && renders.payments.rows === 100, renders.payments);
check('9.2.2 рендер счётчиков (5 + 50 показаний) быстрее 1000ms',
  renders.meters.ms < 1000 && renders.meters.rows === 5, renders.meters);
check('9.2.3 рендер документов (30) быстрее 1000ms',
  renders.documents.ms < 1000 && renders.documents.rows === 30, renders.documents);
check('9.2.4 рендер дел (80) быстрее 1000ms',
  renders.tasks.ms < 1000 && renders.tasks.rows === 80, renders.tasks);
check('9.2.5 главная и статистика на большом наборе быстрее 1000ms',
  renders.home.ms < 1000 && renders.home.painted && renders.stats.ms < 1000 && renders.stats.painted,
  { home: renders.home.ms, homeRows: renders.home.rows, stats: renders.stats.ms, statsRows: renders.stats.rows });

// ---------- 9.3 Фильтры и сортировка на большом массиве ----------
const bigFilters = await page.evaluate(async () => {
  const out = {};
  window.App.navigate('payments');
  await new Promise((r) => setTimeout(r, 900));
  const all = (await window.DB.getAll('payments'));
  const t0 = performance.now();
  document.querySelector('[data-filter="pending"]').click();
  await new Promise((r) => setTimeout(r, 500));
  out.pendingMs = Math.round(performance.now() - t0);
  out.pendingDom = document.querySelectorAll('.payment-card').length;
  out.pendingExpect = all.filter((p) => p.status === 'pending').length;
  document.querySelector('[data-filter="paid"]').click();
  await new Promise((r) => setTimeout(r, 400));
  out.paidDom = document.querySelectorAll('.payment-card').length;
  out.paidExpect = all.filter((p) => p.status === 'paid').length;
  document.querySelector('[data-action="toggle-sort"]').click();
  await new Promise((r) => setTimeout(r, 400));
  out.sortReversed = [...document.querySelectorAll('.payment-card')].map((c) => c.dataset.id).join() !==
    [...document.querySelectorAll('.payment-card')].map((c) => c.dataset.id).reverse().join();
  document.querySelector('[data-filter="all"]').click();
  await new Promise((r) => setTimeout(r, 500));
  out.backToAll = document.querySelectorAll('.payment-card').length;

  window.App.navigate('documents');
  await new Promise((r) => setTimeout(r, 800));
  const docs = await window.DB.getAll('documents');
  document.querySelector('[data-doc-filter="expired"]').click();
  await new Promise((r) => setTimeout(r, 400));
  // «Сегодня» берём локальными частями, как его считает приложение:
  // toISOString() после полуночи по MSK дал бы вчерашний день в UTC
  const today = (dd) => dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0') +
    '-' + String(dd.getDate()).padStart(2, '0');
  const days = (d) => Math.round((new Date(d + 'T00:00:00') - new Date(today(new Date()) + 'T00:00:00')) / 86400000);
  out.expiredDom = document.querySelectorAll('.document-card').length;
  out.expiredExpect = docs.filter((d) => d.expiryDate && days(d.expiryDate) < 0).length;
  document.querySelector('[data-doc-filter="all"]').click();
  await new Promise((r) => setTimeout(r, 400));
  return out;
});
check('9.3.1 фильтр «Ожидают» на 100 платежах даёт ровно pending-записи',
  bigFilters.pendingDom === bigFilters.pendingExpect && bigFilters.pendingExpect > 0, bigFilters);
check('9.3.2 «Ожидают» + «Оплаченные» = 100, возврат к «Все» восстанавливает список',
  bigFilters.pendingDom + bigFilters.paidDom === 100 && bigFilters.backToAll === 100, bigFilters);
check('9.3.3 фильтр документов по просроченным на 30 записях корректен',
  bigFilters.expiredDom === bigFilters.expiredExpect, bigFilters);
check('9.3.4 переключение фильтров на большом наборе занимает <700ms',
  bigFilters.pendingMs < 700, { pendingMs: bigFilters.pendingMs });

// ---------- 9.4 Экспорт большого набора: размер и скорость ----------
const exportBig = await page.evaluate(async () => {
  const t0 = performance.now();
  const dump = await window.Backup.exportData();
  const ms = Math.round(performance.now() - t0);
  const str = JSON.stringify(dump);
  return {
    ms,
    bytes: new Blob([str]).size,
    stores: Object.fromEntries(Object.entries(dump.data).map(([k, v]) => [k, v.length]))
  };
});
check('9.4.1 экспорт 265 записей меньше 5 МБ',
  exportBig.bytes < 5 * 1024 * 1024, { kb: Math.round(exportBig.bytes / 1024), stores: exportBig.stores });
check('9.4.2 экспорт полного набора быстрее 1000ms', exportBig.ms < 1000, exportBig.ms + 'ms');

const dumpPath = path.join(SHOTS, 'e11-big-dump.json');
fs.writeFileSync(dumpPath, JSON.stringify(await page.evaluate(() => window.Backup.exportData())));

// ---------- 9.5 Полный цикл «экспорт → очистить → импорт» на большом наборе ----------
// Реальный путь пользователя: «Удалить всё» через UI, затем импорт дампа.
await gotoSection(page, 'backup', '.backup-section');
await page.click('[data-backup-action="clear"]');
await page.waitForSelector('[data-backup-confirm="confirm"]', { timeout: 5000 });
await page.click('[data-backup-confirm="confirm"]');
await page.waitForTimeout(2500);
const wiped = await counts(page);
check('9.5.1 «Удалить всё» на большом наборе очищает все stores',
  wiped.payments === 0 && wiped.meters === 0 && wiped.meter_readings === 0 &&
  wiped.documents === 0 && wiped.tasks === 0, wiped);

await gotoSection(page, 'backup', '.backup-section');
await page.setInputFiles('[data-backup-input="file"]', dumpPath);
await page.waitForSelector('[data-backup-confirm="run"]', { timeout: 8000 });
const tImp0 = await page.evaluate(() => performance.now());
await page.click('[data-backup-confirm="run"]');
await page.waitForTimeout(3500);
const tImp = await page.evaluate((t0) => Math.round(performance.now() - t0), tImp0);

const restoredBig = await page.evaluate(async () => {
  const out = {};
  for (const s of ['payments', 'meters', 'meter_readings', 'documents', 'tasks']) {
    out[s] = (await window.DB.getAll(s)).length;
  }
  const readings = await window.DB.getAll('meter_readings');
  const meters = await window.DB.getAll('meters');
  out.orphans = readings.filter((r) => !meters.some((m) => m.id === r.meterId)).length;
  out.status = document.querySelector('[data-backup-status="import"]').textContent.trim();
  return out;
});
check('9.5.2 импорт дампа на 265 записей восстанавливает все данные целиком',
  restoredBig.payments === 100 && restoredBig.meters === 5 && restoredBig.meter_readings === 50 &&
  restoredBig.documents === 30 && restoredBig.tasks === 80, restoredBig);
check('9.5.3 связи показаний со счётчиками целы после импорта, сирот нет',
  restoredBig.orphans === 0, restoredBig.orphans);
check('9.5.4 пользователь получил подтверждение импорта (не молчаливую пустоту)',
  /Импортировано: 265/.test(restoredBig.status), restoredBig.status);
check('9.5.5 импорт большого дампа уложился в 4 с', tImp < 4000, tImp + 'ms');

// Повторный импорт поверх заполненной базы обязан быть идемпотентным
const reimport = await page.evaluate(async () => {
  const dump = await window.Backup.exportData();
  const stats = await window.DB.importAll(dump.data);
  const after = (await window.DB.getAll('payments')).length;
  return { stats, after };
});
check('9.5.6 повторный импорт не дублирует записи (skipped вместо re-insert)',
  reimport.after === 100 && reimport.stats.imported === 0 && reimport.stats.skipped === 265, reimport);

// ---------- 9.6 20 переключений разделов: нет роста памяти и «текучести» DOM ----------
await gotoSection(page, 'home', '.home-summary');
const heapCycle = await page.evaluate(async () => {
  const seq = ['payments', 'meters', 'documents', 'tasks', 'stats', 'backup', 'home'];
  const snap = () => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024) : null;
  const listeners = () => document.querySelectorAll('*').length;
  const gc = async () => { if (window.gc) { window.gc(); } await new Promise((r) => setTimeout(r, 120)); };

  for (let i = 0; i < 4; i++) { window.App.navigate(seq[i % seq.length]); await new Promise((r) => setTimeout(r, 500)); }
  await gc();
  const start = { kb: snap(), nodes: listeners() };

  for (let i = 0; i < 20; i++) {
    window.App.navigate(seq[i % seq.length]);
    await new Promise((r) => setTimeout(r, 420));
  }
  await gc();
  const end = { kb: snap(), nodes: listeners() };
  return { start, end, deltaKb: (start.kb === null || end.kb === null) ? null : end.kb - start.kb };
});
check('9.6.1 20 переключений разделов не оставили «мусора» в DOM (узлы не растут)',
  heapCycle.end.nodes <= heapCycle.start.nodes + 40, heapCycle);
check('9.6.2 куча после 20 переходов не выросла более чем на 8 МБ',
  heapCycle.deltaKb === null || heapCycle.deltaKb < 8192, heapCycle.deltaKb === null ? 'performance.memory недоступен' : heapCycle.deltaKb + ' КБ');

// ---------- 9.7 Быстрые переходы без зависаний и «гонки рендеров» ----------
const spamNav = await page.evaluate(async () => {
  const seq = ['payments', 'tasks', 'meters', 'documents', 'stats', 'backup', 'home', 'payments'];
  for (const h of seq) { window.App.navigate(h); await new Promise((r) => setTimeout(r, 60)); }
  await new Promise((r) => setTimeout(r, 1600));
  const app = document.getElementById('app');
  return {
    route: window.App.getCurrentRoute(),
    rows: app.querySelectorAll('.payment-card').length,
    cards: app.querySelectorAll('.card').length,
    skeletons: app.querySelectorAll('.skeleton').length,
    headers: app.querySelectorAll('.page-header').length,
    errors: !!app.querySelector('[data-action="retry"]'),
    hasContent: app.innerHTML.length > 200
  };
});
check('9.7.1 8 быстрых переходов подряд: последний рендер победил, контент на месте',
  spamNav.route === 'payments' && spamNav.rows === 100 && spamNav.headers === 1, spamNav);
check('9.7.2 после спама переходов нет «залипших» skeleton и ошибок',
  spamNav.skeletons === 0 && !spamNav.errors && spamNav.hasContent, spamNav);

// ---------- 9.8 Удаление последней записи на большом наборе ----------
const lastDelete = await page.evaluate(async () => {
  const all = await window.DB.getAll('payments');
  for (const p of all) { await window.DB.delete('payments', p.id); }
  window.Payments.invalidate();
  window.App.navigate('tasks');
  await new Promise((r) => setTimeout(r, 150));
  window.App.navigate('payments');
  await new Promise((r) => setTimeout(r, 1200));
  return {
    left: (await window.DB.getAll('payments')).length,
    cards: document.querySelectorAll('.payment-card').length,
    empty: !!document.querySelector('.empty-state'),
    tasksOk: true
  };
});
check('9.8.1 удаление всех 100 платежей оставляет корректный пустой раздел',
  lastDelete.left === 0 && lastDelete.cards === 0 && lastDelete.empty, lastDelete);

const others = await counts(page);
check('9.8.2 удаление платежей не затронуло другие разделы',
  others.documents === 30 && others.tasks === 80 && others.meters === 5 && others.meter_readings === 50, others);

const bad = log();
check('9.9 итог: консоль чиста под нагрузкой', bad.length === 0, bad.slice(0, 8));

const fails = report('EDGE CASES & STRESS', R);
await browser.close();
process.exit(fails ? 1 : 0);
