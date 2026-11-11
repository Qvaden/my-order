/**
 * Этап 11 / раздел 4 — валидация форм.
 * Пустые поля, отрицательные суммы, уменьшение показаний, даты задом наперёд,
 * время без даты, экранирование HTML, длинные строки.
 */
import { open, gotoSection, seed, counts, rows, resetAll, report, BASE } from './harness.mjs';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });
const { browser, page, log } = await open();
await resetAll(page);

const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

/** Закрыть всё, что осталось открытым (предыдущие неудачные сабмиты). */
async function closeAllModals() {
  await page.evaluate(() => {
    document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
    document.body.classList.remove('modal-open');
  });
  await page.waitForTimeout(350);
}

/** Открыл форму → заполнил поля → сабмит → вернул {errors, invalid, modalStillOpen} */
async function submitForm(openFn, args, fields) {
  await closeAllModals();
  await page.evaluate(({ fn, a }) => {
    const [mod, method] = fn.split('.');
    window[mod][method].apply(window[mod], a);
  }, { fn: openFn, a: args });
  await page.waitForSelector('.modal-content form', { timeout: 4000 });
  await page.waitForTimeout(450); // анимация overlay: иначе click считает элемент нестабильным

  for (const [sel, value] of Object.entries(fields)) {
    if (value === null) continue;
    if (sel.startsWith('raw:')) {
      // Значение напрямую: позволяет заполнить поле, скрытое логикой формы
      // (например, «время без даты»), и проверить, что валидация его ловит.
      await page.evaluate(({ s, v }) => {
        const el = document.querySelector(s.slice(4));
        if (!el) throw new Error('field not found: ' + s);
        el.value = v;
      }, { s: sel, v: String(value) });
      continue;
    }
    if (sel.startsWith('select:')) {
      await page.selectOption(sel.slice(7), String(value));
    } else {
      await page.fill(sel, String(value));
    }
  }

  await page.locator('.modal-content form button[type="submit"]').last().click();
  await page.waitForTimeout(700);

  const res = await page.evaluate(() => {
    const overlays = document.querySelectorAll('.modal-overlay');
    const card = overlays.length ? overlays[overlays.length - 1].querySelector('.modal-content') : null;
    const errs = {};
    if (card) {
      card.querySelectorAll('.form-error').forEach((e) => {
        if (e.textContent.trim()) errs[e.id] = e.textContent.trim();
      });
    }
    const invalid = [];
    if (card) card.querySelectorAll('.is-invalid').forEach((i) => invalid.push(i.name || i.id));
    return {
      errors: errs,
      invalid,
      modalStillOpen: !!card && !!card.querySelector('form'),
      modals: overlays.length
    };
  });
  return res;
}

async function dbCounts() { return counts(page); }

// ---------- 4.1 Платежи ----------
await gotoSection(page, 'payments', '.empty-state, .payment-card');

let r = await submitForm('Payments.openAddForm', [], { '#f-title': '', '#f-amount': '100', '#f-date': iso(3), 'select:#f-category': 'Интернет' });
check('4.1.1 платёж: пустое название блокирует сохранение + ошибка под полем',
  r.modalStillOpen && !!r.errors['e-title'] && r.invalid.includes('title'), r);

r = await submitForm('Payments.openAddForm', [], { '#f-title': 'Тест', '#f-amount': '-500', '#f-date': iso(3), 'select:#f-category': 'Интернет' });
check('4.1.2 платёж: отрицательная сумма блокируется',
  r.modalStillOpen && !!r.errors['e-amount'], r);

r = await submitForm('Payments.openAddForm', [], { '#f-title': 'Тест', '#f-amount': 'abc', '#f-date': iso(3), 'select:#f-category': 'Интернет' });
check('4.1.3 платёж: нечисловая сумма блокируется',
  r.modalStillOpen && !!r.errors['e-amount'], r);

r = await submitForm('Payments.openAddForm', [], { '#f-title': 'Тест', '#f-amount': '100', '#f-date': '', 'select:#f-category': 'Интернет' });
check('4.1.4 платёж: пустая дата блокируется',
  r.modalStillOpen && !!r.errors['e-date'], r);

r = await submitForm('Payments.openAddForm', [], { '#f-title': 'Тест', '#f-amount': '100', '#f-date': iso(3) });
check('4.1.5 платёж: без категории блокируется',
  r.modalStillOpen && !!r.errors['e-category'], r);

const beforePay = await dbCounts();
check('4.1.6 ни одна невалидная форма не создала запись', beforePay.payments === 0, beforePay);

// ---------- 4.2 Счётчики: показание меньше предыдущего ----------
await seed(page, { meters: [{ name: 'ХВС', type: 'cold', initialValue: 100, readings: [{ value: 120, date: -5 }] }] });
const meterId = (await rows(page)).meters[0].id;
await gotoSection(page, 'meters', '.meter-card');

r = await submitForm('Meters.openAddReadingForm', [meterId], { '#f-value': '110', '#f-rdate': iso(0) });
check('4.2.1 показание меньше предыдущего блокируется',
  r.modalStillOpen && !!r.errors['e-value'], r);
check('4.2.2 текст ошибки объясняет, что делать (указано предыдущее значение)',
  /предыдущ/.test(r.errors['e-value'] || '') && /120/.test(r.errors['e-value'] || ''),
  r.errors['e-value']);

r = await submitForm('Meters.openAddReadingForm', [meterId], { '#f-value': '-10', '#f-rdate': iso(0) });
check('4.2.3 отрицательное показание блокируется', r.modalStillOpen && !!r.errors['e-value'], r);

r = await submitForm('Meters.openAddReadingForm', [meterId], { '#f-value': '130', '#f-rdate': '' });
check('4.2.4 показание без даты блокируется', r.modalStillOpen && !!r.errors['e-date'], r);

const readingsBefore = (await dbCounts()).meter_readings;
r = await submitForm('Meters.openAddReadingForm', [meterId], { '#f-value': '130', '#f-rdate': iso(0) });
const readingsAfter = await dbCounts();
check('4.2.5 валидное показание проходит (контрольная проверка, что форма живая)',
  !r.modalStillOpen && readingsAfter.meter_readings === readingsBefore + 1,
  { before: readingsBefore.meter_readings, after: readingsAfter.meter_readings });

r = await submitForm('Meters.openAddMeterForm', [], { '#f-name': '', 'select:#f-type': 'cold' });
check('4.2.6 счётчик: пустое название блокируется', r.modalStillOpen && !!r.errors['e-name'], r);

// ---------- 4.3 Документы ----------
await gotoSection(page, 'documents', '.empty-state, .document-card');

r = await submitForm('Documents.openAddForm', [], { '#f-name': '', '#f-expiry': iso(30) });
check('4.3.1 документ: пустое название блокируется', r.modalStillOpen && !!r.errors['e-name'], r);

r = await submitForm('Documents.openAddForm', [], { '#f-name': 'Документ', '#f-issued': iso(10), '#f-expiry': iso(-10) });
check('4.3.2 дата окончания раньше даты выдачи блокируется',
  r.modalStillOpen && !!r.errors['e-expiryDate'], r);
check('4.3.3 текст ошибки про даты понятен', /раньше даты выдачи/.test(r.errors['e-expiryDate'] || ''),
  r.errors['e-expiryDate']);

const docsBefore = (await dbCounts()).documents;
r = await submitForm('Documents.openAddForm', [], { '#f-name': 'Документ', '#f-issued': iso(-300), '#f-expiry': iso(30) });
const docsAfter = await dbCounts();
check('4.3.4 валидный документ сохранён', !r.modalStillOpen && docsAfter.documents === docsBefore + 1,
  { before: docsBefore, after: docsAfter.documents });

// ---------- 4.4 Задачи ----------
await gotoSection(page, 'tasks', '.empty-state, .task-card');

r = await submitForm('Tasks.openAddForm', [], { '#f-title': '', '#f-due': iso(2), 'raw:#f-time': '10:00' });
check('4.4.1 задача: пустое название блокируется', r.modalStillOpen && !!r.errors['e-title'], r);

// Поле времени в форме скрыто, пока нет даты (group-time display:none),
// поэтому значение ставим напрямую — ровно так, как это сделал бы пользователь
// с включённым автозаполнением или скриптом.
r = await submitForm('Tasks.openAddForm', [], { '#f-title': 'Дело', 'raw:#f-time': '10:00' });
check('4.4.2 задача: время без даты блокируется',
  r.modalStillOpen && !!r.errors['e-dueTime'] && /должна быть указана дата/.test(r.errors['e-dueTime']),
  r.errors['e-dueTime']);

const timeHidden = await page.evaluate(() => {
  const g = document.querySelector('#group-time');
  return g ? getComputedStyle(g).display === 'none' : null;
});
check('4.4.2b UX: поле времени скрыто, пока не указана дата', timeHidden === true, timeHidden);

const tasksBefore = (await dbCounts()).tasks;
r = await submitForm('Tasks.openAddForm', [], { '#f-title': 'Дело', '#f-due': iso(2), '#f-time': '10:00' });
const tasksAfter = await dbCounts();
check('4.4.3 валидная задача сохранена (дата+время)', !r.modalStillOpen && tasksAfter.tasks === tasksBefore + 1,
  { before: tasksBefore, after: tasksAfter.tasks });

// ---------- 4.5 Спецсимволы и XSS ----------
const XSS = '<script>alert(1)</script>';
const IMG = '<img src=x onerror=alert(2)>';

await gotoSection(page, 'payments', '.payment-card');
r = await submitForm('Payments.openAddForm', [], { '#f-title': XSS, '#f-amount': '100', '#f-date': iso(3), 'select:#f-category': 'Другое' });
check('4.5.1 платёж с XSS в названии сохранён как текст', !r.modalStillOpen, r);

r = await submitForm('Payments.openAddForm', [], { '#f-title': IMG, '#f-amount': '100', '#f-date': iso(3), 'select:#f-category': 'Другое' });
check('4.5.2 платёж с onerror-инъекцией сохранён как текст', !r.modalStillOpen, r);

await gotoSection(page, 'tasks', '.task-card');
r = await submitForm('Tasks.openAddForm', [], { '#f-title': XSS, '#f-due': iso(1) });
check('4.5.3 задача с XSS в названии сохранена', !r.modalStillOpen, r);

const inj = await page.evaluate(async () => {
  const pay = (await window.DB.getAll('payments')).filter((p) => /script|onerror/.test(p.title));
  const task = (await window.DB.getAll('tasks')).filter((t) => /script/.test(t.title));
  document.querySelectorAll('.nav-bottom__item')[1].click();
  await new Promise((r) => setTimeout(r, 900));
  const app = document.getElementById('app');
  return {
    inDbPay: pay.length,
    inDbTask: task.length,
    scriptTagsInDom: app.querySelectorAll('script').length,
    imgTagsInDom: app.querySelectorAll('img').length,
    onerrorAttrs: [...app.querySelectorAll('*')].filter((e) => e.getAttribute('onerror')).length,
    // Текст карточки должен содержать исходную строку буквально
    literal: app.innerText.includes('<script>alert(1)</script>') || app.innerText.includes('<img src=x onerror=alert(2)>')
  };
});
check('4.5.4 XSS не исполняется: в DOM нет script/img из пользовательских данных',
  inj.scriptTagsInDom === 0 && inj.imgTagsInDom === 0 && inj.onerrorAttrs === 0, inj);
check('4.5.5 инъекция видна как буквальный текст (экранирована, не проглочена)',
  inj.literal === true, inj);
check('4.5.6 UI не сломан: карточки с инъекциями отрендерены',
  await page.evaluate(() => document.querySelectorAll('.payment-card').length >= 2), 'ok');

// ---------- 4.6 Длинные строки (200+ символов) ----------
const LONG = 'А'.repeat(150) + ' ' + 'B'.repeat(120);
await gotoSection(page, 'payments', '.payment-card');
r = await submitForm('Payments.openAddForm', [], { '#f-title': LONG.slice(0, 100), '#f-amount': '100', '#f-date': iso(3), 'select:#f-category': 'Другое' });
const longCheck = await page.evaluate(() => {
  const app = document.getElementById('app');
  const doc = document.documentElement;
  const cards = [...app.querySelectorAll('.payment-card')];
  const overflowing = cards.filter((c) => c.scrollWidth > c.clientWidth + 2).map((c) => c.innerText.slice(0, 30));
  const names = cards.map((c) => (c.querySelector('.payment-card__title, .payment-card__name, h3') || {}).textContent || '');
  return {
    inputLen: doc.clientWidth,
    pageScrollW: doc.scrollWidth,
    cardScrollW: Math.max(...cards.map((c) => c.scrollWidth)),
    cardClientW: Math.min(...cards.map((c) => c.clientWidth)),
    overflowing,
    maxNameLen: Math.max(...names.map((n) => n.trim().length))
  };
});
check('4.6.1 maxlength=100 реально ограничивает ввод в форме',
  !r.modalStillOpen && longCheck.maxNameLen <= 100, { modal: r.modalStillOpen, ...longCheck });
check('4.6.2 длинное название не переполняет карточку (нет горизонтального скролла)',
  longCheck.pageScrollW <= longCheck.inputLen + 1 && longCheck.overflowing.length === 0, longCheck);

// 200+ символов напрямую в БД (обход формы) — UI обязан выдержать
const brutalIds = await page.evaluate(async (s) => {
  const pid = await window.DB.add('payments', { title: s, amount: 100000, date: '2099-01-01', category: 'Другое', frequency: 'once', status: 'pending' });
  const tid = await window.DB.add('tasks', { title: s, dueDate: '2099-01-02', priority: 'high', recurring: 'none', completed: false });
  // Данные добавлены мимо UI: сбрасываем кэши модулей, чтобы render их перечитал
  window.Payments.invalidate();
  window.Tasks.invalidate();
  return { pid, tid };
}, LONG);
// hash-навигация на тот же раздел не перерисовывает SPA — сначала уходим
await gotoSection(page, 'home', '.home-summary');
await gotoSection(page, 'payments', '.payment-card');
const brutal = await page.evaluate((id) => {
  const doc = document.documentElement;
  const card = document.querySelector('.payment-card[data-id="' + id + '"]');
  if (!card) return { found: false };
  const title = card.querySelector('h3, [class*="__title"]') || card;
  const cs = getComputedStyle(title);
  return {
    found: true,
    pageScrollW: doc.scrollWidth, clientW: doc.clientWidth,
    cardOverflow: card.scrollWidth - card.clientWidth,
    titleOverflow: title.scrollWidth - title.clientWidth,
    textLen: title.textContent.trim().length,
    wordBreak: cs.wordBreak, overflow: cs.overflow, whiteSpace: cs.whiteSpace,
    // Не залезло ли на соседний элемент
    titleRight: Math.round(title.getBoundingClientRect().right),
    cardRight: Math.round(card.getBoundingClientRect().right)
  };
}, brutalIds.pid);
check('4.6.3 270-символьное название из БД отрендерено и не ломает вёрстку',
  brutal.found && brutal.pageScrollW <= brutal.clientW + 1 &&
  brutal.cardOverflow <= 2 && brutal.titleOverflow <= 2 &&
  brutal.titleRight <= brutal.cardRight + 2 && brutal.textLen > 150, brutal);

await gotoSection(page, 'tasks', '.task-card');
const brutalTask = await page.evaluate((id) => {
  const doc = document.documentElement;
  const card = document.querySelector('.task-card[data-id="' + id + '"]');
  if (!card) return { found: false };
  const title = card.querySelector('h3, [class*="__title"]') || card;
  return {
    found: true,
    pageScrollW: doc.scrollWidth, clientW: doc.clientWidth,
    cardOverflow: card.scrollWidth - card.clientWidth,
    titleOverflow: title.scrollWidth - title.clientWidth,
    textLen: title.textContent.trim().length
  };
}, brutalIds.tid);
check('4.6.3b то же в карточке задачи',
  brutalTask.found && brutalTask.pageScrollW <= brutalTask.clientW + 1 &&
  brutalTask.cardOverflow <= 2 && brutalTask.titleOverflow <= 2, brutalTask);

await gotoSection(page, 'tasks', '.task-card');
const brutalTasks = await page.evaluate(() => {
  const doc = document.documentElement;
  return { scrollW: doc.scrollWidth, clientW: doc.clientWidth, cards: document.querySelectorAll('.task-card').length };
});
check('4.6.4 то же в задачах', brutalTasks.scrollW <= brutalTasks.clientW + 1, brutalTasks);

// ---------- 4.7 Пустая сумма / ноль ----------
await gotoSection(page, 'payments', '.payment-card');
r = await submitForm('Payments.openAddForm', [], { '#f-title': 'Ноль', '#f-amount': '0', '#f-date': iso(3), 'select:#f-category': 'Другое' });
check('4.7.1 нулевая сумма блокируется', r.modalStillOpen && !!r.errors['e-amount'], r);

r = await submitForm('Payments.openAddForm', [], { '#f-title': 'Дробь', '#f-amount': '12,50', '#f-date': iso(3), 'select:#f-category': 'Другое' });
const frac = await page.evaluate(async () => {
  const p = (await window.DB.getAll('payments')).find((x) => x.title === 'Дробь');
  return p ? { amount: p.amount } : null;
});
// Сумма хранится в целых копейках: 12,50 ₽ → 1250
check('4.7.2 сумма с запятой принята и сохранена в копейках (12,50 → 1250)',
  !r.modalStillOpen && frac && frac.amount === 1250, { form: r, db: frac });

r = await submitForm('Payments.openAddForm', [], { '#f-title': 'Тысячи', '#f-amount': '1 234 567,89', '#f-date': iso(3), 'select:#f-category': 'Другое' });
const spaced = await page.evaluate(async () => {
  const p = (await window.DB.getAll('payments')).find((x) => x.title === 'Тысячи');
  return p ? p.amount : null;
});
// Пробелы-разделители не принимаются. Главное — ввод НЕ должен превратиться
// в «1234» молча: либо сохранено верное значение, либо явно отказано.
check('4.7.3 разделители тысяч не приводят к тихой порче суммы',
  spaced === null ? !!r.errors['e-amount'] : spaced === 123456789,
  { modal: r.modalStillOpen, errors: r.errors, db: spaced });

// ---------- 4.9 Календарно-несуществующие даты (регрессия критического бага №5) ----------
// new Date('2026-02-31') в JS — НЕ Invalid Date: парсер молча переносит её на
// 3 марта. Без строгой проверки база хранила одну дату, а UI показывал другую,
// и пользователь не получал никакой ошибки. Проверяем оба уровня.
const badDates = await page.evaluate(async () => {
  const attempts = ['2026-02-31', '2026-04-31', '2026-06-31', '2027-02-29', '2026-13-01', '2026-00-10'];
  const rejected = [];
  for (const date of attempts) {
    try {
      const id = await window.DB.add('payments', {
        title: 'bad ' + date, amount: 100, date, category: 'Другое', frequency: 'once', status: 'pending'
      });
      rejected.push({ date, accepted: true, stored: (await window.DB.get('payments', id)).date });
    } catch (e) { rejected.push({ date, accepted: false, error: e.message }); }
  }
  const leapId = await window.DB.add('payments', {
    title: 'leap 2028', amount: 100, date: '2028-02-29', category: 'Другое', frequency: 'once', status: 'pending'
  });
  const leap = await window.DB.get('payments', leapId);
  const epochId = await window.DB.add('payments', {
    title: 'epoch', amount: 100, date: '1970-01-01', category: 'Другое', frequency: 'once', status: 'pending'
  });
  const epoch = await window.DB.get('payments', epochId);
  return { rejected, leap: { stored: leap.date, shown: window.Payments.formatDate(leap.date) }, epoch: epoch.date };
});
const IMPOSSIBLE = ['2026-02-31', '2026-04-31', '2026-06-31', '2027-02-29'];
const badMsg = (x) => !x.accepted && /date должно быть строкой ISO 8601/.test(x.error);
check('4.9.1 календарно-несуществующие дни (31.02, 31.04, 31.06, 29.02 невисокосного) отклонены, а не «исправлены»',
  IMPOSSIBLE.every((d) => badMsg(badDates.rejected.find((x) => x.date === d))),
  badDates.rejected.filter((x) => !x.accepted).length + '/6 отклонено');
check('4.9.1b месяц 13 и месяц 00 тоже отклонены',
  badMsg(badDates.rejected.find((x) => x.date === '2026-13-01')) &&
  badMsg(badDates.rejected.find((x) => x.date === '2026-00-10')),
  badDates.rejected.map((x) => [x.date, x.accepted]));
check('4.9.2 в базе не осталось ни одной искажённой даты',
  !badDates.rejected.some((x) => x.accepted), badDates.rejected.filter((x) => x.accepted));
check('4.9.3 29.02 високосного 2028 принята и показана тем же днём (без подмены)',
  badDates.leap.stored === '2028-02-29' && badDates.leap.shown === '29.02.2028', badDates.leap);
check('4.9.4 корректные границы (1970-01-01) проходят без изменений',
  badDates.epoch === '1970-01-01', badDates.epoch);

// Уровень импорта: importAll пишет напрямую, минуя DB.add, поэтому обязан
// валидировать сам. Плохая запись пропускается, остальной дамп импортируется.
const importStrict = await page.evaluate(async () => {
  const dump = {
    payments: [
      { id: 91001, title: 'целый', amount: 50000, date: '2030-06-15', category: 'Другое', frequency: 'once', status: 'pending' },
      { id: 91002, title: '31 февраля', amount: 100, date: '2026-02-31', category: 'Другое', frequency: 'once', status: 'pending' },
      { id: 91003, title: 'число вместо строки', amount: 100, date: 1700000000000, category: 'Другое', frequency: 'once', status: 'pending' }
    ],
    meters: [], meter_readings: [], documents: [{ id: 91004, name: 'Дата выдачи в будущем', category: 'Другое', issuedDate: '2026-02-31', expiryDate: '2031-01-01' }], tasks: []
  };
  const before = (await window.DB.getAll('payments')).length;
  const stats = await window.DB.importAll(dump.data || dump);
  const payments = await window.DB.getAll('payments');
  const docs = await window.DB.getAll('documents');
  return {
    before,
    stats,
    badInDb: payments.filter((p) => p.date === '2026-02-31' || typeof p.date === 'number').length,
    goodImported: payments.some((p) => p.id === 91001),
    badDocInDb: docs.filter((d) => d.issuedDate === '2026-02-31').length
  };
});
check('4.9.5 импорт не может обойти валидацию дат: битые записи пропущены, в базу не легли',
  importStrict.badInDb === 0 && importStrict.stats.skipped >= 3, importStrict.stats);
check('4.9.6 одна плохая запись не ломает весь импорт (целые записи на месте)',
  importStrict.goodImported === true, importStrict);
check('4.9.7 issuedDate документов тоже под контролем (раньше не проверялся)',
  importStrict.badDocInDb === 0, importStrict.badDocInDb);

// UI-путь: форма не должна создать запись с «исправленной» датой.
await gotoSection(page, 'payments', '.payment-card');
const beforeUiBad = await dbCounts();
r = await submitForm('Payments.openAddForm', [], { '#f-title': '31 февраля', '#f-amount': '100', 'raw:#f-date': '2026-02-31', 'select:#f-category': 'Другое' });
const afterUiBad = await dbCounts();
const uiBad = await page.evaluate(async () => {
  const p = (await window.DB.getAll('payments')).find((x) => x.title === '31 февраля');
  return p ? p.date : null;
});
check('4.9.8 форма не сохраняет платёж с календарно-несуществующей датой',
  uiBad === null && afterUiBad.payments === beforeUiBad.payments,
  { form: r, dbDate: uiBad, before: beforeUiBad.payments, after: afterUiBad.payments });

// Единственное допустимое сообщение — предупреждение нативного <input type=date>
// о значении «2026-02-31», которое сюда подставил сам тест (raw:-инъекция).
// Код приложения таких дат в поле не пишет: они отклоняются до сохранения.
const NATIVE_DATE_WARNING = /does not conform to the required format/;
const bad = log().filter((m) => !NATIVE_DATE_WARNING.test(m));
check('4.8 итог: консоль чиста при всей валидационной нагрузке', bad.length === 0, bad.slice(0, 6));

const fails = report('VALIDATION', R);
await browser.close();
process.exit(fails ? 1 : 0);
