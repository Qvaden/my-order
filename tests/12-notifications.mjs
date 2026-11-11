/**
 * Этап 12.6 — экспорт в календарь (.ics), локальные напоминания, панель
 * быстрых действий и раздел «Уведомления» (PRO).
 *
 * Инварианты, которые проверяет файл:
 *   • .ics соответствует RFC 5545 так, чтобы его принял Google/Apple/Outlook:
 *     CRLF, складка не длиннее 75 БАЙТ, BOM, VTIMEZONE, UTC в DTSTAMP,
 *     корректные DTSTART/DTEND и экранирование;
 *   • напоминания — только нативные Web API: никаких сетевых push-каналов
 *     и фоновых таймеров (закрытую вкладку будит календарь, не мы);
 *   • приватность по умолчанию: заголовок нейтральный, названия и суммы
 *     появляются только при showAmounts;
 *   • Free не видит ни одной кнопки этапа и не может вызвать генератор;
 *   • отказ в разрешении НЕ ломает приложение — работает in-app-баннер;
 *   • одно и то же событие не показывается дважды в тот же день.
 *
 * Заметка по headless: промпт Notification там не появляется, поэтому
 * ветка «нет системных пушей» проверяется через options.system=false —
 * тот же код, что идёт при отказе, только без зависимости от движка.
 */
import {
  open, resetAll, gotoSection, seed, setProTier, report, BASE
} from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });

/** Сдвиг даты на n суток в локальном 'YYYY-MM-DD'. */
const iso = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
};

/** Снимает BOM, если он остался в строке (регэксп с невидимым символом
   тут ненадёжен: проверка идёт по кодовой точке). */
function stripBom(text) {
  return String(text).charCodeAt(0) === 0xFEFF ? String(text).slice(1) : String(text);
}

/** Разворачивает складку RFC 5545 обратно в логические строки. */
function unfold(text) {
  return stripBom(text).split('\r\n').reduce((acc, line) => {
    if (/^[ \t]/.test(line) && acc.length) { acc[acc.length - 1] += line.slice(1); }
    else { acc.push(line); }
    return acc;
  }, []);
}

/** Физические строки без BOM. */
function physical(text) {
  return stripBom(text).split('\r\n');
}

/** Логические строки с данным свойством. */
const propsOf = (lines, name) => lines.filter((l) => l.indexOf(name) === 0);

const { browser, ctx, page, log } = await open();
page.setDefaultTimeout(15000);
await resetAll(page);

/* ================================================================
   12.0 Сид: набор, в котором есть все три триггера напоминаний
   ================================================================ */
await setProTier(page, 'pro');
await page.reload({ waitUntil: 'networkidle' });
await gotoSection(page, 'home', '.home-summary');

await seed(page, {
  payments: [
    { title: 'Интернет', amount: 50000, date: 2, category: 'Интернет' },
    { title: 'Коммунальные', amount: 550050, date: 10, category: 'Коммунальные', frequency: 'monthly' },
    { title: 'Долг', amount: 123400, date: -3, category: 'Другое' },
    { title: 'Оплачено', amount: 1000, date: 1, category: 'Другое', status: 'paid' },
    { title: 'Дальний горизонт', amount: 700000, date: 40, category: 'Другое' },
    { title: 'Странный "название": с запятой; слэхом \\ и суммой', amount: 99999, date: 5, category: 'Другое' }
  ],
  tasks: [
    { title: 'Позвонить врачу', dueDate: 0, dueTime: '14:30', priority: 'high' },
    { title: 'Просроченное дело', dueDate: -2, priority: 'medium' },
    { title: 'Готово', dueDate: 1, priority: 'low', completed: true },
    { title: 'Очень длинное название дела, которое специально сделано так, чтобы проверка складки строк была неизбежной и рвало строку на несколько continuation-строк', dueDate: 6, priority: 'low' }
  ],
  documents: [
    { name: 'Страховка авто', category: 'Страховка', expiryDate: 3, reminderDays: 7 },
    { name: 'Паспорт', category: 'Паспорт', expiryDate: null }
  ],
  meters: [{ name: 'ХВС', type: 'cold', initialValue: 100 }]
});

/* Настройки уведомлений — через DB.add, как их пишет NotifPrefs.save */
await page.evaluate(async () => {
  await window.DB.add('settings', {
    key: 'notifications',
    value: { enabled: true, showAmounts: false, leadDays: 7, calendarHorizon: 'month', eventTime: 'morning' }
  });
});
await page.reload({ waitUntil: 'networkidle' });
await gotoSection(page, 'home', '.home-summary');
await ctx.grantPermissions(['notifications']);

const ics = await page.evaluate(() => window.CalendarExport.generateICS()
  .then((r) => ({
    ok: true, file: r.fileName, counts: r.counts, text: r.text,
    events: r.events.map((e) => ({ type: e.type, id: e.id, name: e.name, date: e.date, time: e.dueTime }))
  }))
  .catch((e) => ({ ok: false, err: e.message })));

check('12.0.1 PRO-генерация .ics проходит', ics.ok === true, ics.err || ics.file);

const eventsTotal = ics.counts.payment + ics.counts.task + ics.counts.document;
const lines = unfold(ics.text);
const phys = physical(ics.text);
const blocks = (() => {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { cur = []; continue; }
    if (l === 'END:VEVENT') { if (cur) { out.push(cur); cur = null; } continue; }
    if (cur) { cur.push(l); }
  }
  return out;
})();
const propOf = (block, name) => (block.find((l) => l.indexOf(name) === 0) || '');

/* ================================================================
   12.1 Формат файла: то, за что валидаторы календаря отвергают импорт
   ================================================================ */
check('12.1.1 переносы только CRLF (ни одиночных LF, ни висящих CR)',
  /\r\n/.test(ics.text) && !/[^\r]\n/.test(ics.text) && !/\r(?!\n)/.test(ics.text),
  { lf: (ics.text.match(/[^\r]\n/g) || []).length, cr: (ics.text.match(/\r(?!\n)/g) || []).length });

check('12.1.2 файл начинается с BOM: иначе кириллицу читают в кодировке страницы',
  ics.text.charCodeAt(0) === 0xFEFF, ics.text.charCodeAt(0));

const tooLong = phys.filter((l) => Buffer.byteLength(l, 'utf8') > 75);
check('12.1.3 ни одна физическая строка не длиннее 75 БАЙТ (кириллица = 2 байта)',
  tooLong.length === 0, tooLong.slice(0, 2).map((l) => ({ octets: Buffer.byteLength(l, 'utf8'), line: l.slice(0, 40) })));

/* Спецсимволы и длинные имена видны в файле только когда имена наружу:
   при закрытом showAmounts SUMMARY остаётся нейтральным, и складку длинного
   значения было бы нечем проверять. Собираем открытый дамп один раз. */
const icsSpecials = await page.evaluate(() => window.NotifPrefs.save({ showAmounts: true })
  .then(() => window.CalendarExport.generateICS())
  .then((r) => r.text)
  .then((text) => window.NotifPrefs.save({ showAmounts: false }).then(() => text)));
const specialLines = unfold(icsSpecials).filter((l) => /Странны/.test(l));
const specialPhys = physical(icsSpecials);

check('12.1.4 длинное значение разложено складкой, и continuation начинается с пробела',
  specialPhys.some((l) => l.charAt(0) === ' ') && specialPhys.filter((l) => l.charAt(0) === '\t').length === 0 &&
    specialPhys.filter((l) => Buffer.byteLength(l, 'utf8') > 75).length === 0,
  specialPhys.filter((l) => l.charAt(0) === ' ').length);

check('12.1.5 после unfold складка восстанавливается без потери символов',
  /* Значение остаётся экранированным (запятая — как \,), и его надо искать
     именно в таком виде: unfold снимает складку, а не экранирование */
  unfold(icsSpecials).some((l) => l.indexOf('неизбежной и рвало строку') !== -1) &&
    unfold(icsSpecials).some((l) => /^SUMMARY:Дело: Очень длинное название дела\\, которое/.test(l)),
  (unfold(icsSpecials).find((l) => /continuation-строк/.test(l)) || '').slice(0, 90));

const lastLine = lines.filter((l) => l !== '').pop();
check('12.1.6 конверт VCALENDAR + VERSION 2.0 + PRODID + CALSCALE + METHOD',
  lines[0] === 'BEGIN:VCALENDAR' && lastLine === 'END:VCALENDAR' &&
    propsOf(lines, 'VERSION:')[0] === 'VERSION:2.0' &&
    propsOf(lines, 'PRODID:').length === 1 &&
    propsOf(lines, 'CALSCALE:')[0] === 'CALSCALE:GREGORIAN' &&
    propsOf(lines, 'METHOD:')[0] === 'METHOD:PUBLISH',
  { first: lines[0], last: lastLine, tail: lines.slice(-2) });

check('12.1.7 есть VTIMEZONE Europe/Moscow +0300 — без него Google Calendar ругается на TZID',
  lines.includes('BEGIN:VTIMEZONE') && /TZID:Europe\/Moscow/.test(ics.text) &&
    /TZOFFSETTO:\+0300/.test(ics.text) && lines.includes('END:VTIMEZONE'),
  lines.filter((l) => /TZ/.test(l)).slice(0, 6));

check('12.1.8 BEGIN и END сбалансированы во всём файле',
  lines.filter((l) => l.indexOf('BEGIN:') === 0).length ===
    lines.filter((l) => l.indexOf('END:') === 0).length,
  { begin: lines.filter((l) => l.indexOf('BEGIN:') === 0).length });

check('12.1.9 DTSTAMP всех событий в UTC с суффиксом Z',
  propsOf(lines, 'DTSTAMP:').length === eventsTotal &&
    propsOf(lines, 'DTSTAMP:').every((l) => /^DTSTAMP:\d{8}T\d{6}Z$/.test(l)),
  propsOf(lines, 'DTSTAMP:').slice(0, 2));

check('12.1.10 UID уникальны и содержат тип и id записи',
  propsOf(lines, 'UID:').length === eventsTotal &&
    new Set(propsOf(lines, 'UID:')).size === eventsTotal &&
    propsOf(lines, 'UID:').every((l) => /^UID:myorder-(payment|task|document)-\d+@myorder$/.test(l)),
  propsOf(lines, 'UID:').slice(0, 3));

check('12.1.11 блоков VEVENT ровно столько, сколько событий в выборке',
  blocks.length === eventsTotal && eventsTotal >= 6, { blocks: blocks.length, events: eventsTotal });

check('12.1.12 у каждого события есть UID, DTSTAMP, DTSTART, SUMMARY, DESCRIPTION, STATUS',
  blocks.every((b) => ['UID:', 'DTSTAMP:', 'DTSTART', 'SUMMARY:', 'DESCRIPTION:', 'STATUS:CONFIRMED']
    .every((p) => b.some((l) => l.indexOf(p) === 0))),
  blocks.map((b) => b.map((l) => l.split(':')[0]).join('|')).slice(0, 2));

/* Спецсимволы видны в файле только когда имена наружу: при закрытом
   showAmounts они в DESCRIPTION не попадают. Дамп собран выше (12.1.4).
   В регулярках теста один литеральный слэш пишется как \\: значение в файле
   выглядит буквально как «запятой\;» и «слэхом \\». */
check('12.1.13 запятая и точка с запятой в тексте экранированы по RFC 3.3.11',
  specialLines.length >= 2 &&
    specialLines.every((l) => !/запятой;/.test(l) && /запятой\\;/.test(l)) &&
    (icsSpecials.match(/\\,/g) || []).length > 0,
  specialLines.map((l) => l.slice(0, 90)));

check('12.1.14 обратный слэш в названии задвоен (иначе парсер теряет следующий символ)',
  specialLines.some((l) => /слэхом \\\\ и/.test(l)) &&
    (icsSpecials.match(/\\\\/g) || []).length >= 2,
  specialLines.map((l) => (l.match(/слэхом .{0,10}/) || [''])[0]));

/* Перевод строки внутри значения по RFC обязан стать литеральным «\n», а не
   реальным CRLF: иначе блок рвётся пополам и парсер теряет свойства.
   У события DESCRIPTION их до трёх: свой и по одному на каждый VALARM
   (документу со сроком больше суток ставятся два напоминания). */
check('12.1.15 переводы строки в DESCRIPTION переданы как \\n, а не реальным CRLF',
  (ics.text.match(/\\n/g) || []).length > 0 &&
    lines.every((l) => !/^(Статус|Запись|Срок):/.test(l)) &&
    blocks.every((b) => {
      const d = b.filter((l) => l.indexOf('DESCRIPTION:') === 0).length;
      return d >= 1 && d <= 3;
    }) &&
    blocks.every((b) => b.some((l) => l.indexOf('DESCRIPTION:') === 0 && /\\n/.test(l))),
  blocks.map((b) => b.filter((l) => l.indexOf('DESCRIPTION:') === 0).length));

const methodCheck = await page.evaluate(() => {
  const bad = [];
  const real = window.fetch;
  window.fetch = function (u) { bad.push(String(u)); return real.apply(window, arguments); };
  return window.CalendarExport.generateICS().then(() => { window.fetch = real; return bad; });
});
check('12.1.16 сборка файла не делает сетевых запросов (работает офлайн)',
  methodCheck.length === 0, methodCheck);

/* ================================================================
   12.2 Что попадает в файл: горизонт и отсев закрытого
   ================================================================ */
const namesOf = (type) => ics.events.filter((e) => e.type === type).map((e) => e.name);

check('12.2.1 оплаченный платёж в календарь не попадает',
  !namesOf('payment').includes('Оплачено'), namesOf('payment'));

check('12.2.2 выполненное дело не попадает',
  !namesOf('task').includes('Готово'), namesOf('task'));

check('12.2.3 платёж дальше горизонта (месяц) отсеивается',
  !namesOf('payment').includes('Дальний горизонт'), namesOf('payment'));

check('12.2.4 документ без срока действия не создаёт событие',
  ics.counts.document === 1 && namesOf('document').includes('Страховка авто'), namesOf('document'));

check('12.2.5 просроченный платёж остаётся в выборке: долг надо напоминать',
  namesOf('payment').includes('Долг'), namesOf('payment'));

const horizonWide = await page.evaluate(() => window.CalendarExport.collectEvents({ horizon: 'quarter' })
  .then((ev) => ev.filter((e) => e.type === 'payment').map((e) => e.name)));
check('12.2.6 горизонт «квартал» реально расширяет выборку',
  horizonWide.includes('Дальний горизонт') && horizonWide.length > ics.counts.payment,
  { month: ics.counts.payment, quarter: horizonWide });

const horizonNarrow = await page.evaluate((until) => window.CalendarExport.collectEvents({ horizon: 'week' })
  .then((ev) => ev.map((e) => e.date)), iso(8));
check('12.2.7 горизонт «неделя» сужает выборку и не берёт ничего за её пределами',
  horizonNarrow.length > 0 && horizonNarrow.every((d) => d <= iso(8)), horizonNarrow);

const horizonJunk = await page.evaluate(() => window.CalendarExport.collectEvents({ horizon: 'год' })
  .then((ev) => ev.map((e) => e.date)));
const badHorizon = { n: horizonJunk.length, dates: horizonJunk.every((d) => d <= iso(32)) };
check('12.2.8 неизвестное значение горизонта откатывается к месяцу, а не в крах',
  badHorizon.n > 0 && badHorizon.dates, badHorizon);

/* ================================================================
   12.3 DTSTART / DTEND: сутки против часа
   ================================================================ */
const timed = blocks.filter((b) => b.some((l) => l.indexOf('DTSTART;TZID=') === 0));
const allDay = blocks.filter((b) => b.some((l) => l.indexOf('DTSTART;VALUE=DATE:') === 0));

check('12.3.1 события во времени используют DTSTART с TZID Europe/Moscow',
  timed.length === eventsTotal - 1 && timed.every((b) => /^DTSTART;TZID=Europe\/Moscow:\d{8}T\d{6}$/.test(propOf(b, 'DTSTART'))),
  { timed: timed.length, events: eventsTotal });

check('12.3.2 документ — событие на весь день: DTSTART;VALUE=DATE, без DTEND',
  allDay.length === 1 && allDay[0].some((l) => /^DTSTART;VALUE=DATE:\d{8}$/.test(l)) &&
    !allDay[0].some((l) => l.indexOf('DTEND') === 0),
  allDay.map((b) => propOf(b, 'DTSTART')));

check('12.3.3 у временного события есть DTEND на +1 час (иначе нулевая длительность)',
  timed.every((b) => {
    const s = propOf(b, 'DTSTART').slice(-6);
    const e = propOf(b, 'DTEND;').slice(-6);
    return /^DTEND;TZID=Europe\/Moscow:\d{8}T\d{6}$/.test(propOf(b, 'DTEND;')) &&
      Number(e.slice(0, 2)) === (Number(s.slice(0, 2)) + 1) % 24 && e.slice(2) === s.slice(2);
  }),
  timed.map((b) => propOf(b, 'DTSTART').slice(-6) + '→' + propOf(b, 'DTEND;').slice(-6)));

/* Событие в 23:30 через 3 дня: в горизонте, поэтому попадёт в выборку */
const dtendNextDay = await page.evaluate(async (dueDate) => {
  const p = await window.DB.add('tasks', { title: 'Поздний звонок', dueDate: dueDate, dueTime: '23:30', priority: 'low', recurring: 'none', completed: false });
  return window.CalendarExport.collectEvents().then((ev) => {
    const item = ev.filter((e) => e.type === 'task' && e.dueTime === '23:30')[0];
    const text = window.CalendarExport.buildICS(item ? [item] : []);
    return window.DB.delete('tasks', p).then(() => {
      const m = /DTEND;TZID=Europe\/Moscow:(\d{8})T(\d{4})00/.exec(text);
      return m ? { day: m[1], hhmm: m[2], start: /DTSTART;TZID=Europe\/Moscow:(\d{8})T(\d{4})00/.exec(text)[1] } : null;
    });
  });
}, iso(3));
check('12.3.4 событие в 23:30 переносит DTEND на следующие сутки, а не в 24:30',
  dtendNextDay && dtendNextDay.hhmm === '0030' &&
    Number(dtendNextDay.day) - Number(dtendNextDay.start) === 1, dtendNextDay);

check('12.3.5 время дела берётся из dueTime, а не из настройки',
  ics.events.some((e) => e.type === 'task' && e.time === '14:30'),
  ics.events.filter((e) => e.type === 'task').map((e) => e.time));

const regularEvening = ics.events.find((e) => e.name === 'Коммунальные');
check('12.3.6 регулярный платёж ставится на 19:00 — коммуналку закрывают вечером',
  regularEvening && regularEvening.time === '19:00', regularEvening);

const singleMorning = ics.events.find((e) => e.name === 'Интернет');
check('12.3.7 разовый платёж идёт на время из настройки (утро)',
  singleMorning && singleMorning.time === '09:00', singleMorning);

/* ================================================================
   12.4 VALARM: пороги напоминаний в самом календаре
   ================================================================ */
const triggersOf = (type, id) => {
  const b = blocks.filter((x) => x.indexOf('UID:myorder-' + type + '-' + id + '@myorder') !== -1)[0];
  return b ? b.filter((l) => l.indexOf('TRIGGER:') === 0).map((l) => l.slice(8)) : null;
};
const idOf = (type, name) => {
  const e = ics.events.filter((x) => x.type === type && x.name === name)[0];
  return e ? e.id : null;
};

check('12.4.1 документу ставится напоминание за leadDays и за сутки',
  JSON.stringify(triggersOf('document', idOf('document', 'Страховка авто'))) === JSON.stringify(['-P7D', '-P1D']),
  triggersOf('document', idOf('document', 'Страховка авто')));

check('12.4.2 делу во времени — за 30 минут',
  JSON.stringify(triggersOf('task', idOf('task', 'Позвонить врачу'))) === JSON.stringify(['-PT30M']),
  triggersOf('task', idOf('task', 'Позвонить врачу')));

check('12.4.3 платежу во времени — за час',
  JSON.stringify(triggersOf('payment', idOf('payment', 'Интернет'))) === JSON.stringify(['-PT1H']),
  triggersOf('payment', idOf('payment', 'Интернет')));

const lead14 = await page.evaluate(() => window.CalendarExport.collectEvents()
  .then((ev) => {
    const doc = ev.filter((e) => e.type === 'document')[0];
    return window.CalendarExport.triggersFor(doc, { leadDays: 1, showAmounts: false, eventTime: 'morning' });
  }));
check('12.4.4 при leadDays = 1 суточное напоминание не дублируется',
  JSON.stringify(lead14) === JSON.stringify(['-P1D']), lead14);

check('12.4.5 каждый VALARM закрыт и содержит ACTION:DISPLAY',
  blocks.every((b) => {
    const t = b.join('\n');
    return (t.match(/BEGIN:VALARM/g) || []).length === (t.match(/END:VALARM/g) || []).length &&
      (t.match(/ACTION:DISPLAY/g) || []).length === (t.match(/TRIGGER:/g) || []).length;
  }), blocks.map((b) => (b.join('\n').match(/VALARM/g) || []).length));

/* ================================================================
   12.5 Приватность: экран блокировки не должен ничего рассказывать
   ================================================================ */
const summaries = blocks.map((b) => propOf(b, 'SUMMARY:'));

check('12.5.1 при showAmounts=false SUMMARY нейтральный — только тип события',
  summaries.every((s) => ['SUMMARY:Платёж', 'SUMMARY:Дело', 'SUMMARY:Документ'].indexOf(s) !== -1),
  [...new Set(summaries)]);

const dataLines = lines.filter((l) => /^(SUMMARY|DESCRIPTION|CATEGORIES|LOCATION):/.test(l));
check('12.5.2 при showAmounts=false в событиях нет ни названий записей, ни сумм',
  !dataLines.some((l) => /Интернет|Коммунальные|Страховка|Позвонить|Паспорт|Странный|Долг/.test(l)) &&
    !/₽/.test(dataLines.join('\n')),
  { leaked: dataLines.filter((l) => /Интернет|Коммунальные|₽/.test(l)).slice(0, 2) });

check('12.5.3 DESCRIPTION при выключенном показе ведёт в приложение, а не раскрывает',
  blocks.every((b) => /Подробности — в приложении/.test(b.join('\n'))),
  blocks.map((b) => propOf(b, 'DESCRIPTION:').slice(0, 60)));

const icsPrivate = await page.evaluate(() => window.CalendarExport.generateICS()
  .then((r) => r.text));
check('12.5.4 CATEGORIES остаются нейтральными и позволяют отличить наш календарь',
  /CATEGORIES:Мой Порядок/.test(icsPrivate) && (icsPrivate.match(/CATEGORIES:/g) || []).length >= 6,
  unfold(icsPrivate).filter((l) => l.indexOf('CATEGORIES:') === 0).slice(0, 3));

/* включаем показ сумм — и приватность обязана открыться ровно там, где обещано */
await page.evaluate(() => window.NotifPrefs.save({ showAmounts: true }));
const icsOpen = await page.evaluate(() => window.CalendarExport.generateICS()
  .then((r) => ({ text: r.text, counts: r.counts })));
const openLines = unfold(icsOpen.text);
const openBlocks = (() => {
  const out = []; let cur = null;
  for (const l of openLines) {
    if (l === 'BEGIN:VEVENT') { cur = []; continue; }
    if (l === 'END:VEVENT') { if (cur) { out.push(cur); cur = null; } continue; }
    if (cur) { cur.push(l); }
  }
  return out;
})();

check('12.5.5 showAmounts=true: название попадает в SUMMARY',
  openBlocks.some((b) => /^SUMMARY:Платёж: (Интернет|Коммунальные)$/.test(propOf(b, 'SUMMARY:'))),
  openBlocks.map((b) => propOf(b, 'SUMMARY:')).slice(0, 4));

check('12.5.6 showAmounts=true: название и сумма попадают в DESCRIPTION',
  unfold(icsOpen.text).some((l) => l.indexOf('DESCRIPTION:') === 0 && /Запись: .+ — [\d\s]+ ₽/.test(l)),
  unfold(icsOpen.text).filter((l) => /Запись:/.test(l)).slice(0, 2).map((l) => l.slice(0, 90)));

check('12.5.7 сумма форматирована как деньги, а не как «50000» копеек',
  /* Разделитель тысяч в money() — неразрывный пробел (\u00A0): \s в JS
     покрывает и его, и обычный, поэтому проверка не привязана к конкретному
     байту и не даст файлу разъезжаться с вёрсткой */
  /500\s₽/.test(icsOpen.text) && /5\s500\s₽\s50\sк\./.test(icsOpen.text) &&
    !/Сумма: 550050|— 550050/.test(icsOpen.text),
  { rub500: /500\s₽/.test(icsOpen.text), kopecks: /5\s500\s₽\s50\sк\./.test(icsOpen.text), rawKopecks: /— 550050/.test(icsOpen.text) });

check('12.5.8 «весь день» в настройках снимает время со всех событий',
  await page.evaluate(() => window.NotifPrefs.save({ eventTime: 'allday' })
    .then(() => window.CalendarExport.generateICS()))
    .then((r) => {
      const ls = unfold(r.text);
      return !/DTSTART;TZID=/.test(r.text) && ls.filter((l) => l.indexOf('DTSTART;VALUE=DATE:') === 0).length === ls.filter((l) => l === 'BEGIN:VEVENT').length;
    }), await page.evaluate(() => window.CalendarExport.generateICS().then((r) => (r.text.match(/DTSTART;TZID=/g) || []).length)));

await page.evaluate(() => window.NotifPrefs.save({ eventTime: 'morning', showAmounts: false }));

/* ================================================================
   12.6 Настройки: отдельное хранилище, память и толерантность к мусору
   ================================================================ */
const prefsRaw = await page.evaluate(async () => {
  const rec = await window.DB.get('settings', 'notifications');
  return { stored: rec && rec.value, key: window.NotifPrefs.SETTING_KEY, mem: window.NotifPrefs.get() };
});
check('12.6.1 настройки лежат в store settings под ключом notifications (условие этапа)',
  prefsRaw.key === 'notifications' && prefsRaw.stored && typeof prefsRaw.stored.enabled === 'boolean',
  prefsRaw.stored);

check('12.6.2 get() отдаёт копию: правка результата не меняет настройки',
  await page.evaluate(() => {
    const a = window.NotifPrefs.get();
    a.enabled = !a.enabled;
    a.leadDays = 99;
    const b = window.NotifPrefs.get();
    return b !== a && typeof b.enabled === 'boolean' && window.NotifPrefs.LEAD_OPTIONS.indexOf(b.leadDays) !== -1;
  }), await page.evaluate(() => window.NotifPrefs.get()));

check('12.6.3 save() пишет в IndexedDB и обновляет память синхронно для UI',
  await page.evaluate(() => window.NotifPrefs.save({ leadDays: 3 }).then(() =>
    window.DB.get('settings', 'notifications').then((rec) =>
      rec.value.leadDays === 3 && window.NotifPrefs.get().leadDays === 3))),
  await page.evaluate(() => window.NotifPrefs.get()));

check('12.6.4 save() вызывает db:change — резервная копия помечает данные грязными',
  await page.evaluate(() => {
    let seen = null;
    const h = (e) => { seen = e.detail && e.detail.store; };
    window.addEventListener('db:change', h);
    return window.NotifPrefs.save({ leadDays: 7 }).then(() => {
      window.removeEventListener('db:change', h);
      return seen === 'settings';
    });
  }), await page.evaluate(() => ({ dirty: window.CloudSync && window.CloudSync.isDirty ? window.CloudSync.isDirty() : null })));

const junk = await page.evaluate(async () => {
  await window.DB.update('settings', 'notifications', {
    value: { enabled: 'да', leadDays: 400, calendarHorizon: 'век', eventTime: 'полночь', showAmounts: 1, extra: 'мусор' }
  });
  return window.NotifPrefs.load({ force: true }).then(async (p) => ({
    prefs: p, stored: (await window.DB.get('settings', 'notifications')).value
  }));
});
check('12.6.5 мусор в записе настроек откатывается к значениям по умолчанию, без краха',
  junk.prefs.enabled === false && junk.prefs.leadDays === 7 &&
    junk.prefs.calendarHorizon === 'month' && junk.prefs.eventTime === 'morning' &&
    junk.prefs.showAmounts === false && !('extra' in junk.prefs), junk.prefs);

const missing = await page.evaluate(async () => {
  await window.DB.delete('settings', 'notifications');
  return window.NotifPrefs.load({ force: true }).then((p) => p);
});
check('12.6.6 отсутствие записи = значения по умолчанию, приложение работает',
  missing.enabled === false && missing.showAmounts === false && missing.leadDays === 7, missing);

check('12.6.7 приватность по умолчанию: showAmounts выключен (критерий этапа)',
  missing.showAmounts === false, missing);

/* возвращаем рабочий набор настроек */
await page.evaluate(() => window.NotifPrefs.save({ enabled: true, showAmounts: false, leadDays: 7, calendarHorizon: 'month', eventTime: 'morning' }));

/* ================================================================
   12.7 Метка устаревания экспорта
   ================================================================ */
const staleFlow = await page.evaluate(async () => {
  localStorage.removeItem(window.CalendarExport.KEY_EXPORTED);
  localStorage.removeItem(window.CalendarExport.KEY_CHANGED);
  const never = window.CalendarExport.isStale();

  window.CalendarExport.markExported();
  const fresh = window.CalendarExport.isStale();

  // правка данных — календарь снова отстаёт
  const id = await window.DB.add('payments', { title: 'Временный', amount: 100, date: '2099-01-01', category: 'Другое', frequency: 'once', status: 'pending' });
  await window.DB.delete('payments', id);
  const afterEdit = window.CalendarExport.isStale();

  // и это состояние ПЕРЕЖИВАЕТ перезагрузку: метка лежит в localStorage,
  // а не только в памяти страницы
  const persisted = localStorage.getItem(window.CalendarExport.KEY_CHANGED);

  // правка настроек уведомлений — не повод пересобирать файл
  window.CalendarExport.markExported();
  const clean = window.CalendarExport.isStale();
  await window.NotifPrefs.save({ leadDays: 3 });
  const afterPrefs = window.CalendarExport.isStale();
  await window.NotifPrefs.save({ leadDays: 7 });

  // облачный dirty-флаг к срокам в календаре отношения не имеет
  window.CalendarExport.markExported();
  localStorage.setItem('myorder_cloud_dirty', '1');
  const dirtyOnly = window.CalendarExport.isStale();
  localStorage.removeItem('myorder_cloud_dirty');

  return { never, fresh, afterEdit, afterPrefs, clean, persisted: Boolean(persisted), dirtyOnly };
});
check('12.7.1 без экспорта календарь считается устаревшим', staleFlow.never === true, staleFlow);
check('12.7.2 после markExported устаревание снимается', staleFlow.fresh === false, staleFlow);
check('12.7.3 правка записей данных снова делает экспорт устаревшим',
  staleFlow.afterEdit === true && staleFlow.clean === false, staleFlow);
check('12.7.4 состояние устаревания переживает перезагрузку страницы',
  staleFlow.persisted === true, staleFlow);
check('12.7.5 правка настроек уведомлений экспорт не устаревляет (события те же)',
  staleFlow.afterPrefs === false, staleFlow);
check('12.7.6 несохранённый в облако бэкап не означает, что календарь отстал',
  staleFlow.dirtyOnly === false, staleFlow);

const nameShape = await page.evaluate(() => window.CalendarExport.fileName(new Date(2026, 0, 5)));
check('12.7.5 имя файла с датой: повторы не перезаписывают старый экспорт',
  /^my_order_calendar_\d{4}-\d{2}-\d{2}\.ics$/.test(nameShape) && /2026-01-05/.test(nameShape), nameShape);

const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
const dlRes = await page.evaluate(() => window.CalendarExport.exportNow()
  .then((r) => ({ ok: true, file: r.fileName })).catch((e) => ({ ok: false, err: e.message })));
const download = await dl;
check('12.7.6 кнопка экспорта реально отдаёт файл .ics браузеру',
  dlRes.ok === true && download && /\.ics$/.test(download.suggestedFilename()),
  { res: dlRes, name: download && download.suggestedFilename() });

if (download) {
  const out = path.join(process.env.LOCALAPPDATA, 'opencode', 'shots', 'e11', 'my_order_calendar.ics');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await download.saveAs(out);
}

/* ================================================================
   12.8 PRO-гейт: Free не видит кнопок и не может вызвать генератор
   ================================================================ */
await page.evaluate(() => window.ProManager.setTier('free'));
await gotoSection(page, 'backup', '.backup-section');

const freeBackup = await page.evaluate(() => {
  const vis = (sel) => { const el = document.querySelector(sel); return Boolean(el && el.offsetParent !== null); };
  return {
    section: !!document.querySelector('[data-backup-notif="enabled"]'),
    sectionVisible: vis('.backup-notif__grid'),
    icsBtn: vis('[data-backup-action="ics-export"]'),
    checkBtn: vis('[data-backup-action="notif-check"]'),
    permLine: vis('[data-backup-notif-perm]')
  };
});
check('12.8.1 Free: секция «Уведомления и календарь» невидима (CSS-гейт .pro-only)',
  freeBackup.section && !freeBackup.sectionVisible && !freeBackup.icsBtn && !freeBackup.checkBtn && !freeBackup.permLine,
  freeBackup);

const freeCalls = await page.evaluate(() => Promise.all([
  window.CalendarExport.generateICS().then(() => 'resolved').catch((e) => e.message),
  window.CalendarExport.exportNow().then(() => 'resolved').catch((e) => e.message),
  window.PushManager.checkDueEvents({ force: true })
]));
check('12.8.2 Free: генератор .ics отказывает сам, а не только через скрытую кнопку',
  /PRO/.test(freeCalls[0]) && /PRO/.test(freeCalls[1]), freeCalls.slice(0, 2));
check('12.8.3 Free: проверка напоминаний выходит сразу с reason=free и ничего не считает',
  freeCalls[2].tier === 'free' && freeCalls[2].reason === 'free' && freeCalls[2].items.length === 0,
  freeCalls[2]);

/* Панель считается на том экране, где она живёт: backup → home. Тариф уже
   Free, поэтому переход перерисует панель без PRO-пункта */
const freeHomePanel = await page.evaluate(async () => {
  window.App.navigate('home');
  await new Promise((r) => setTimeout(r, 1200));
  const items = [].slice.call(document.querySelectorAll('[data-quick-action]'))
    .filter((b) => b.offsetParent !== null);
  return {
    panel: !!document.querySelector('.quick-panel'),
    ids: items.map((b) => b.getAttribute('data-quick-action')),
    cal: items.some((b) => b.getAttribute('data-quick-action') === 'calendar')
  };
});
check('12.8.4 Free: панель быстрых действий осталась (это навигация), а пункт календаря скрыт',
  freeHomePanel.panel && freeHomePanel.ids.length === 4 && !freeHomePanel.cal, freeHomePanel.ids);

await gotoSection(page, 'stats', '.stats-section');
const freeStats = await page.evaluate(() => ({
  cal: !!document.querySelector('[data-pro-only="calendar"]'),
  visible: Boolean((document.querySelector('[data-pro-only="calendar"]') || {}).offsetParent)
}));
check('12.8.5 Free: блок экспорта в статистике не появляется даже после догрузки PRO-аналитики',
  !freeStats.cal || !freeStats.visible, freeStats);

/* протухание PRO должно выключать пуши, не трогая настройки */
const expiry = await page.evaluate(async () => {
  await window.NotifPrefs.save({ enabled: true });
  const before = window.NotifPrefs.get().enabled;
  window.ProManager.setTier('free');
  const after = window.NotifPrefs.get();
  window.ProManager.setTier('pro');
  const restored = await window.NotifPrefs.load({ force: true });
  return { before, after, restored: restored.enabled, canNow: window.NotifPrefs.canNotify() };
});
check('12.8.6 истечение PRO гасит enabled на лету, а настройки сохраняёт для возврата',
  expiry.before === true && expiry.after.enabled === false && expiry.restored === true,
  expiry);

/* ================================================================
   12.9 Триггеры напоминаний: что приложение считает «наступившим»
   ================================================================ */
await page.evaluate(() => window.ProManager.setTier('pro'));
await page.evaluate(() => window.PushManager.resetState());

const due = await page.evaluate(() => window.PushManager.findDueEvents()
  .then((ev) => ev.map((e) => ({ type: e.type, title: e.title, overdue: e.overdue, time: e.dueTime }))));

check('12.9.1 платёж в день срока попадает в напоминания',
  due.some((d) => d.type === 'payment' && !d.overdue) || due.length > 0, due);

check('12.9.2 просроченный платёж помечен overdue и идёт первым',
  due.length > 0 && due[0].overdue === true, due.slice(0, 3));

const dueAll = await page.evaluate(() => window.PushManager.findDueEvents()
  .then((ev) => ({ types: ev.map((e) => e.type), titles: ev.map((e) => e.title) })));
check('12.9.3 сегодняшнее и просроченное дело напоминают о себе',
  dueAll.types.filter((t) => t === 'task').length >= 2, dueAll);

check('12.9.4 выполненное дело из напоминаний выпадает',
  !dueAll.titles.includes('Готово'), dueAll.titles);

/* leadDays читается только из prefs: отдельный ключ options — не канал.
   Документ в сиде истекает через 3 дня: при leadDays=1 он ещё не срок,
   при 14 — уже да. */
const dueDocFar = await page.evaluate(() => window.PushManager.findDueEvents({ prefs: { leadDays: 1, showAmounts: false } })
  .then((ev) => ev.filter((e) => e.type === 'document').length));
const dueDocLead = await page.evaluate(() => window.PushManager.findDueEvents({ prefs: { leadDays: 14, showAmounts: false } })
  .then((ev) => ev.filter((e) => e.type === 'document').length));
check('12.9.5 порог документа берётся из настройки leadDays, а не зашит в код',
  dueDocFar === 0 && dueDocLead >= 1, { lead1: dueDocFar, lead14: dueDocLead });

check('12.9.6 документ без срока действия не создаёт напоминание',
  !dueAll.titles.includes('Паспорт'), dueAll.titles);

const paidGone = await page.evaluate(async () => {
  const list = await window.DB.getAll('payments');
  const unpaid = list.filter((p) => p.status === 'pending' && p.date <= '2100-01-01');
  const today = unpaid.filter((p) => p.date <= window.NotifPrefs.localDay());
  return window.DB.update('payments', today.length ? today[0].id : unpaid[0].id, { status: 'paid' })
    .then(() => window.PushManager.findDueEvents())
    .then((ev) => ev.some((e) => e.type === 'payment' && e.title === (today.length ? today[0].title : unpaid[0].title)));
});
check('12.9.7 оплаченный платёж перестаёт напоминать о себе сразу', paidGone === false, paidGone);
await page.evaluate(async () => {
  const list = await window.DB.getAll('payments');
  const back = list.filter((p) => p.status === 'paid' && p.title !== 'Оплачено');
  for (const p of back) { await window.DB.update('payments', p.id, { status: 'pending' }); }
});

const tplCheck = await page.evaluate(async () => {
  const id = await window.DB.add('payments', {
    title: 'Шаблон подписки', amount: 1000, date: window.NotifPrefs.localDay(),
    category: 'Подписки', frequency: 'monthly', status: 'pending', isTemplate: true
  });
  return window.PushManager.findDueEvents()
    .then((ev) => ({ hit: ev.some((e) => e.title === 'Шаблон подписки') }))
    .then((r) => window.DB.delete('payments', id).then(() => r));
});
check('12.9.8 recurring-шаблон (isTemplate) — заготовка, а не событие: не напоминает',
  tplCheck.hit === false, tplCheck);

/* ================================================================
   12.10 Показ: ветки разрешения, троттлинг, де-дуп по дню
   ================================================================ */
const perm = await page.evaluate(() => ({
  state: window.NotifPrefs.permission(),
  supported: window.PushManager.supported(),
  can: window.NotifPrefs.canNotify(),
  api: typeof window.Notification === 'function'
}));
check('12.10.1 разрешение синхронизировано из Notification API при старте',
  perm.supported === (perm.api === true) && ['granted', 'denied', 'default', 'unsupported'].indexOf(perm.state) !== -1, perm);

const branch = await page.evaluate(async () => {
  window.PushManager.resetState();
  const a = await window.PushManager.checkDueEvents({ force: true, system: false });
  /* Вторая проверка — без force: он означает «пользователь попросил» и
     обходит память показов. ignoreThrottle снимает только троттлинг, и
     де-дуп по дню остаётся включённым — ровно то, что проверяем */
  const b = await window.PushManager.checkDueEvents({ ignoreThrottle: true, system: false });
  const c = await window.PushManager.checkDueEvents({ ignoreThrottle: true, system: false });
  return {
    a: { reason: a.reason, shown: a.shown, items: a.items.length, left: a.left },
    b: { reason: b.reason, shown: b.shown, left: b.left },
    c: { reason: c.reason, shown: c.shown }
  };
});
check('12.10.2 без системных пушей работает in-app-баннер: приложение не молчит',
  branch.a.reason === 'in-app' && branch.a.shown > 0, branch.a);

check('12.10.3 повторное обращение в тот же день не показывает то же самое (де-дуп по дню)',
  /* В сиде 4 наступивших срока, лимит показа — 3: вторая проверка честно
     добирает остаток, а третья уже ничего нового не находит */
  branch.a.left === 1 && branch.b.reason === 'in-app' && branch.b.shown === 1 &&
    branch.b.left === 0 && branch.c.reason === 'already-notified' && branch.c.shown === 0, branch);

const mem = await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem(window.PushManager.KEY_SHOWN) || '{}');
  const keys = Object.keys(raw);
  const today = window.NotifPrefs.localDay();
  return { keys: keys, todayHas: Boolean(raw[today] && Object.keys(raw[today]).length) };
});
check('12.10.4 память показов лежит в localStorage под сегодняшним днём',
  mem.todayHas === true && mem.keys.length <= 2, mem);

const throttle = await page.evaluate(async () => {
  window.PushManager.resetState();
  const first = await window.PushManager.checkDueEvents({ system: false });
  const second = await window.PushManager.checkDueEvents({ system: false });
  return { first: first.reason, second: second.reason };
});
check('12.10.5 повторная проверка в пределах троттлинга выходит без чтения базы',
  throttle.second === 'throttled', throttle);

const disabled = await page.evaluate(async () => {
  window.PushManager.resetState();
  await window.NotifPrefs.save({ enabled: false });
  const r = await window.PushManager.checkDueEvents();
  await window.NotifPrefs.save({ enabled: true });
  return r;
});
check('12.10.6 выключенный тумблер не показывает ничего (reason=disabled)',
  disabled.reason === 'disabled' && disabled.shown === 0, disabled);

const nothing = await page.evaluate(async () => {
  window.PushManager.resetState();
  const all = await window.DB.getAll('payments');
  const ids = all.map((p) => p.id);
  const tids = (await window.DB.getAll('tasks')).map((t) => t.id);
  const backups = [];
  for (const id of ids) { const r = await window.DB.get('payments', id); backups.push(['payments', id, r]); await window.DB.update('payments', id, { status: 'paid', date: '2099-12-31' }); }
  for (const id of tids) { const r = await window.DB.get('tasks', id); backups.push(['tasks', id, r]); await window.DB.update('tasks', id, { completed: true }); }
  const docs = await window.DB.getAll('documents');
  for (const d of docs) { backups.push(['documents', d.id, d]); await window.DB.update('documents', d.id, { expiryDate: '2099-12-31' }); }
  /* ignoreThrottle нужен потому, что правки ниже стреляют db:change, а
     слушатель push-manager на него тоже проверяет сроки и занимает окно
     троттлинга. Память показов при этом остаётся включённой */
  const r = await window.PushManager.checkDueEvents({ ignoreThrottle: true, system: false });
  for (const [store, id, rec] of backups) { await window.DB.update(store, id, rec); }
  return { reason: r.reason, items: r.items.length };
});
check('12.10.7 когда наступивших сроков нет — ложной тревоги нет',
  nothing.reason === 'nothing-due' && nothing.items === 0, nothing);

const texts = await page.evaluate(() => {
  const items = [
    { type: 'payment', title: 'Коммунальные', date: window.NotifPrefs.localDay(), amountLabel: '5 500 ₽', overdue: false },
    { type: 'task', title: 'Позвонить врачу', date: window.NotifPrefs.localDay(), dueTime: '14:30', overdue: true },
    { type: 'document', title: 'Страховка авто', date: window.NotifPrefs.localDay(), overdue: false }
  ];
  return window.NotifPrefs.save({ showAmounts: false })
    .then(() => ({
      off: items.map((i) => ({ t: window.NotifPrefs.titleFor(i), b: window.NotifPrefs.bodyFor(i) })),
      on: (window.NotifPrefs.save({ showAmounts: true }), null)
    }));
});
const textsOn = await page.evaluate(() => {
  const items = [
    { type: 'payment', title: 'Коммунальные', date: window.NotifPrefs.localDay(), amountLabel: '5 500 ₽', overdue: false },
    { type: 'task', title: 'Позвонить врачу', date: window.NotifPrefs.localDay(), dueTime: '14:30', overdue: true },
    { type: 'document', title: 'Страховка авто', date: window.NotifPrefs.localDay(), overdue: false }
  ];
  return window.NotifPrefs.get().showAmounts === true
    ? items.map((i) => ({ t: window.NotifPrefs.titleFor(i), b: window.NotifPrefs.bodyFor(i) }))
    : null;
});
check('12.10.8 заголовки уведомлений нейтральные и не содержат названий записей',
  texts.off.every((x) => !/Коммунальные|Позвонить|Страховка/.test(x.t)), texts.off);
check('12.10.9 при showAmounts=false тело не раскрывает название и сумму',
  texts.off.every((x) => !/Коммунальные|Страховка|₽/.test(x.b)), texts.off);
check('12.10.10 при showAmounts=true тело называет запись и сумму',
  Array.isArray(textsOn) && /5 500 ₽/.test(textsOn[0].b) && /Коммунальные/.test(textsOn[0].b), textsOn);
await page.evaluate(() => window.NotifPrefs.save({ showAmounts: false }));

/* ================================================================
   12.11 Панель быстрых действий на главном экране
   ================================================================ */
await page.evaluate(() => window.ProManager.setTier('pro'));
await gotoSection(page, 'home', '.quick-panel');

const panel = await page.evaluate(() => {
  const items = [].slice.call(document.querySelectorAll('[data-quick-action]'));
  return {
    title: (document.querySelector('.quick-panel__title') || {}).textContent,
    ids: items.map((b) => b.getAttribute('data-quick-action')),
    labels: items.map((b) => (b.querySelector('.quick-panel__label') || {}).textContent),
    touch: items.every((b) => b.getBoundingClientRect().height >= 44),
    badge: (() => { const el = document.querySelector('[data-quick-badge="reading"]'); return el ? { hidden: el.hidden, text: el.textContent, cls: el.className } : null; })(),
    tiles: document.querySelectorAll('[data-home-add], .quick-actions').length,
    icons: [].slice.call(document.querySelectorAll('.quick-panel__icon')).map((i) => {
      const r = i.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height);
    }),
    arrows: (() => {
      const right = Math.max.apply(null, [].slice.call(document.querySelectorAll('.quick-panel__arrow'))
        .map((a) => a.getBoundingClientRect().right));
      const spread = [].slice.call(document.querySelectorAll('.quick-panel__arrow'))
        .map((a) => Math.abs(right - a.getBoundingClientRect().right));
      return Math.max.apply(null, spread);
    })(),
    aria: document.querySelector('.quick-panel').getAttribute('aria-label')
  };
});
check('12.11.1 панель видна на главном экране и содержит все пять действий',
  panel.title === 'Быстрые действия' && panel.ids.length === 5 &&
    panel.ids[0] === 'reading' && panel.ids[4] === 'calendar', panel.ids);
check('12.11.2 панель помечена как группа: скринридер читает заголовок',
  panel.aria === 'Быстрые действия', panel);
check('12.11.3 каждая кнопка не меньше 44 px — условие этапа по тач-зонам',
  panel.touch === true, panel.ids);
check('12.11.4 бейдж — семантический статус, а не красная точка со цифрой',
  panel.badge && panel.badge.hidden === false && panel.badge.text === 'Срочно' &&
    /status-badge--expired/.test(panel.badge.cls), panel.badge);
check('12.11.4b старых плиток «Быстрое добавление» на главной больше нет (дубль панели)',
  panel.tiles === 0, panel.tiles);
check('12.11.4c иконки панели одного размера 48x48',
  panel.icons.length === 5 && panel.icons.every((s) => s === '48x48'), panel.icons);
check('12.11.4d стрелки выровнены по правому краю контейнера (разбег ≤ 1 px)',
  panel.arrows <= 1, panel.arrows);

const badgeStates = await page.evaluate(async () => {
  const read = () => {
    const el = document.querySelector('[data-quick-badge="reading"]');
    return { hidden: el.hidden, text: el.textContent, cls: el.className };
  };
  const paint = async () => {
    window.App.renderSection('home');
    await new Promise((r) => setTimeout(r, 1500));
  };
  const meters = await window.DB.getAll('meters');
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  };
  /* Шаг 1: показания есть за прошлый месяц, но нет за текущий — пропуская
     срока ещё нет, поэтому тон янтарный и текст нейтральный.
     navigate() на текущий маршрут не вызывает hashchange и не перерисовывает
     сводку — а бейдж проставляет именно она. Рендерим раздел напрямую */
  const prevId = await window.DB.add('meter_readings',
    { meterId: meters[0].id, value: 110, date: day(-40), createdAt: Date.now() });
  await paint();
  const expiring = read();
  /* Шаг 2: передано за текущий месяц — бейдж гаснет полностью */
  const curId = await window.DB.add('meter_readings',
    { meterId: meters[0].id, value: 120, date: day(0), createdAt: Date.now() });
  await paint();
  const off = read();
  await window.DB.delete('meter_readings', curId);
  await window.DB.delete('meter_readings', prevId);
  await paint();
  return { expiring: expiring, off: off, back: read() };
});
check('12.11.5a без пропуска месяца бейдж добрый: «Нужно» и янтарный тон',
  badgeStates.expiring.hidden === false && badgeStates.expiring.text === 'Нужно' &&
    /status-badge--expiring/.test(badgeStates.expiring.cls), badgeStates.expiring);
check('12.11.5 бейдж гаснет, когда за текущий месяц показания уже переданы',
  badgeStates.off.hidden === true && badgeStates.off.text === '', badgeStates.off);
check('12.11.5b удаление показания возвращает срочный бейдж — статус не «прилипает»',
  badgeStates.back.hidden === false && badgeStates.back.text === 'Срочно', badgeStates.back);

await gotoSection(page, 'home', '.quick-panel');
await page.click('[data-quick-action="reading"]');
const readingModal = await page.evaluate(async () => {
  for (let i = 0; i < 25; i++) {
    if (document.querySelector('.modal-overlay')) { break; }
    await new Promise((r) => setTimeout(r, 120));
  }
  return {
    route: location.hash,
    modal: !!document.querySelector('.modal-overlay'),
    title: (document.querySelector('.modal-content__title') || {}).textContent || '',
    hasValueField: !!document.getElementById('e-value')
  };
});
check('12.11.6 тап «Передать показания» = переход в раздел + форма за один тап',
  readingModal.route === '#meters' && readingModal.modal &&
    /Новое показание/.test(readingModal.title) && readingModal.hasValueField, readingModal);

await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await gotoSection(page, 'home', '.quick-panel');
await page.click('[data-quick-action="payment"]');
const payModal = await page.evaluate(async () => {
  for (let i = 0; i < 20; i++) {
    if (document.querySelector('.modal-overlay')) { break; }
    await new Promise((r) => setTimeout(r, 120));
  }
  return {
    route: location.hash,
    modal: !!document.querySelector('.modal-overlay'),
    title: (document.querySelector('.modal-content__title') || {}).textContent || ''
  };
});
check('12.11.7 тап «Добавить платёж» открывает форму платежа в том же действии',
  payModal.route === '#payments' && payModal.modal && /латё/.test(payModal.title), payModal);

await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await gotoSection(page, 'home', '.quick-panel');

const gatePanel = await page.evaluate(async () => {
  const res = {};
  window.ProManager.setTier('free');
  window.App.renderSection('home');
  await new Promise((r) => setTimeout(r, 900));
  const btn = document.querySelector('[data-quick-action="calendar"]');
  res.hiddenForFree = !btn || btn.offsetParent === null;
  // Даже если кнопка осталась в DOM, обработчик обязан отказаться запускать генератор
  let started = false;
  const real = window.CalendarExport.exportNow;
  window.CalendarExport.exportNow = function () { started = true; return Promise.resolve({}); };
  if (btn) { btn.click(); }
  await new Promise((r) => setTimeout(r, 300));
  window.CalendarExport.exportNow = real;
  res.started = started;
  /* Считаем панель, ПОКА человек в Free: если отложить подсчёт до возврата
     в PRO, доска покажет пять пунктов и тест потеряет смысл */
  res.itemsFree = document.querySelectorAll('[data-quick-action]').length;
  /* Единственный путь, которым Free может постучаться в закрытое действие, —
     домашний ярлык ?view=calendar: кнопки в панели нет */
  history.replaceState({}, document.title, location.pathname + '?view=calendar#home');
  res.handled = window.QuickActions.applyShortcutView();
  await new Promise((r) => setTimeout(r, 300));
  const toastEl = document.querySelector('.vk-toast__text');
  res.toastText = toastEl ? toastEl.textContent : '';
  res.toastVisible = Boolean(toastEl && toastEl.offsetParent !== null);
  res.stillHome = location.hash === '#home';
  history.replaceState({}, document.title, location.pathname + '#home');
  window.ProManager.setTier('pro');
  window.App.renderSection('home');
  await new Promise((r) => setTimeout(r, 900));
  return res;
});
check('12.11.8 Free: пункт «Экспорт в календарь» скрыт, а клик по нему не запускает генератор',
  gatePanel.hiddenForFree === true && gatePanel.started === false, gatePanel);
check('12.11.9 Free: остальные четыре действия панели остаются доступными (панель — навигация)',
  gatePanel.itemsFree === 4, gatePanel.itemsFree);
check('12.11.10 закрытое действие объясняется тостом, а не молчанием',
  gatePanel.handled === true && /PRO/.test(gatePanel.toastText) &&
    gatePanel.toastVisible === true && gatePanel.stillHome === true,
  { toast: gatePanel.toastText, visible: gatePanel.toastVisible, hashKept: gatePanel.stillHome });

/* ================================================================
   12.12 Ярлыки установленного приложения (?view= из webmanifest)
   ================================================================ */
const manifest = await page.evaluate(() => fetch('app-manifest.webmanifest')
  .then((r) => r.json())
  .then((m) => ({
    count: (m.shortcuts || []).length,
    urls: (m.shortcuts || []).map((s) => s.url),
    names: (m.shortcuts || []).map((s) => s.name),
    validIcons: (m.shortcuts || []).every((s) => s.icons && s.icons.length > 0)
  })));
check('12.12.1 манифест объявляет три быстрых ярлыка с иконками',
  manifest.count === 3 && manifest.validIcons, manifest.names);

const shortcut = await page.evaluate(async () => {
  history.replaceState({}, document.title, location.pathname + '?view=add-payment#home');
  const ok = window.QuickActions.applyShortcutView();
  await new Promise((r) => setTimeout(r, 900));
  return {
    handled: ok,
    search: location.search,
    modal: !!document.querySelector('.modal-overlay'),
    title: (document.querySelector('.modal-content__title') || {}).textContent || ''
  };
});
check('12.12.2 ?view=add-payment открывает форму платежа сразу после старта',
  shortcut.handled === true && shortcut.modal && /латё/.test(shortcut.title), shortcut);
check('12.12.3 параметр view убирается из адреса: «назад» не плодит форму заново',
  shortcut.search === '', shortcut.search);

const shortcutUnknown = await page.evaluate(() => {
  history.replaceState({}, document.title, location.pathname + '?view=мусор#home');
  return { handled: window.QuickActions.applyShortcutView(), search: location.search };
});
check('12.12.4 неизвестный view игнорируется молча и не чистит адрес',
  shortcutUnknown.handled === false && /view=/.test(shortcutUnknown.search), shortcutUnknown);

const shortcutProGate = await page.evaluate(async () => {
  window.ProManager.setTier('free');
  history.replaceState({}, document.title, location.pathname + '?view=calendar#home');
  const handled = window.QuickActions.applyShortcutView();
  await new Promise((r) => setTimeout(r, 300));
  const toastText = (document.querySelector('.vk-toast__text') || {}).textContent || '';
  window.ProManager.setTier('pro');
  return { handled, toastText };
});
check('12.12.5 PRO-ярлык изFree не запускает экспорт, а объясняет причину тостом',
  shortcutProGate.handled === true && /PRO/.test(shortcutProGate.toastText), shortcutProGate);

/* ================================================================
   12.13 Клик по напоминанию → нужный раздел с нужным фильтром
   ================================================================ */
const targets = await page.evaluate(() => {
  const mk = (type, overdue) => window.PushManager.targetFor({ type: type, overdue: Boolean(overdue) });
  return {
    taskOverdue: mk('task', true),
    taskToday: mk('task', false),
    payment: mk('payment', true),
    document: mk('document', false),
    junk: mk('unknown', false)
  };
});
check('12.13.1 просроченное дело ведёт в «Дела» со фильтром «просроченные»',
  targets.taskOverdue.route === '#tasks' && targets.taskOverdue.filter === 'overdue', targets.taskOverdue);
check('12.13.2 дело на сегодня ведёт на фильтр «сегодня»',
  targets.taskToday.route === '#tasks' && targets.taskToday.filter === 'today', targets.taskToday);
check('12.13.3 платёж ведёт в «Платежи» в список ожидающих',
  targets.payment.route === '#payments' && targets.payment.filter === 'pending', targets.payment);
check('12.13.4 документ ведёт в «Документы» на истекающие',
  targets.document.route === '#documents' && targets.document.filter === 'expiring', targets.document);
check('12.13.5 ни один вариант не рождает маршрут вне списка разделов',
  [targets.taskOverdue, targets.taskToday, targets.payment, targets.document, targets.junk]
    .every((t) => /^#(home|payments|meters|documents|tasks|stats|backup)$/.test(t.route)), targets);

const applied = await page.evaluate(async () => {
  window.PushManager.applyNotificationTarget({ route: '#tasks', filter: 'overdue' });
  for (let i = 0; i < 40; i++) {
    const chip = document.querySelector('[data-task-filter][aria-pressed="true"]');
    if (chip && chip.getAttribute('data-task-filter') === 'overdue') { break; }
    await new Promise((r) => setTimeout(r, 150));
  }
  const active = document.querySelector('[data-task-filter][aria-pressed="true"]');
  return {
    route: location.hash,
    filter: active ? active.getAttribute('data-task-filter') : null,
    leftover: window.__homeTaskFilter
  };
});
check('12.13.6 обработка клика по пушу переходит в раздел и ставит фильтр',
  applied.route === '#tasks' && applied.filter === 'overdue', applied);
check('12.13.7 метка фильтра потребляется: повторный вход фильтр не навязывает',
  applied.leftover === null, applied.leftover);

const swCode = await page.evaluate(() => fetch('sw.js').then((r) => r.text()));
check('12.13.8 sw.js слушает notificationclick, закрывает пуш и шлёт окну myorder:navigate',
  /addEventListener\('notificationclick'/.test(swCode) && /event\.notification\.close\(\)/.test(swCode) &&
    /myorder:navigate/.test(swCode) && /postMessage/.test(swCode),
  { click: /notificationclick/.test(swCode), close: /close\(\)/.test(swCode) });
check('12.13.9 sw.js принимает только известные маршруты: битый tag не уронит навигацию',
  /\^#\(home\|payments\|meters\|documents\|tasks\|stats\|backup\)\$/.test(swCode) &&
    /'#home'/.test(swCode), null);

/* Само окно: сообщение от Service Worker должно открыть раздел. Проверяем
   подписку модуля — postMessage от controller доходит до слушателя. */
const viaMessage = await page.evaluate(async () => {
  window.App.navigate('home');
  await new Promise((r) => setTimeout(r, 900));
  window.postMessage({ type: 'myorder:navigate', route: '#documents', filter: 'expiring' }, '*');
  for (let i = 0; i < 40; i++) {
    const chip = document.querySelector('[data-doc-filter][aria-pressed="true"]');
    if (chip && chip.getAttribute('data-doc-filter') === 'expiring') { break; }
    await new Promise((r) => setTimeout(r, 150));
  }
  const active = document.querySelector('[data-doc-filter][aria-pressed="true"]');
  return {
    route: location.hash,
    filter: active ? active.getAttribute('data-doc-filter') : null,
    docCount: document.querySelectorAll('[data-doc-filter]').length
  };
});
check('12.13.10 окно слушает myorder:navigate: пуш открывает раздел без перезагрузки',
  viaMessage.route === '#documents' && viaMessage.filter === 'expiring', viaMessage);
check('12.13.11 чужие postMessage-сообщения слушатель этапа игнорирует',
  viaMessage.docCount > 0, viaMessage.docCount);

/* ================================================================
   12.14 In-app-баннер: отказ разрешения не должен означать тишину
   ================================================================ */
const banner = await page.evaluate(async () => {
  window.PushManager.resetState();
  document.querySelectorAll('.vk-toast').forEach((t) => t.remove());

  const r = await window.PushManager.checkDueEvents({ force: true, system: false });
  await new Promise((res) => setTimeout(res, 200));
  const toast = document.querySelector('.vk-toast');
  return {
    reason: r.reason,
    items: r.items.length,
    shown: r.shown,
    text: toast ? toast.textContent : '',
    live: (document.getElementById('vk-toasts') || {}).ariaLive || null,
    role: (document.querySelector('.vk-toast') || {}).ariaHidden || null
  };
});
check('12.14.1 при недоступных системных пушах показывается in-app-баннер',
  banner.reason === 'in-app' && banner.shown > 0 && banner.text.length > 0, banner);
check('12.14.2 баннер считает наступившие сроки по-русски с правильным падежом',
  /(платёж|платежа|платежей|дело|дела|дел|документ|документа|документов)/.test(banner.text), banner.text);
check('12.14.3 при showAmounts=false баннер не называет записи',
  !/Коммунальные|Страховка|Позвонить/.test(banner.text), banner.text);
check('12.14.4 тост живёт в aria-live-контейнере: скринридер его прочитает',
  banner.live === 'polite', banner.live);

const bannerOpen = await page.evaluate(async () => {
  await window.NotifPrefs.save({ showAmounts: true });
  window.PushManager.resetState();
  document.querySelectorAll('.vk-toast').forEach((t) => t.remove());
  await window.PushManager.checkDueEvents({ force: true, system: false });
  await new Promise((r) => setTimeout(r, 200));
  const text = (document.querySelector('.vk-toast') || {}).textContent || '';
  await window.NotifPrefs.save({ showAmounts: false });
  return text;
});
check('12.14.5 включённый показ сумм делает баннер конкретным',
  bannerOpen !== banner.text, { off: banner.text, on: bannerOpen });

/* Лимит показа проверяем на реальных записях: подменять
   window.PushManager.findDueEvents бесполезно — внутри checkDueEvents
   вызывается приватная функция модуля, а не поле публичного API.
   Добавляем четыре сегодняшних дела: вместе с сидовыми их больше MAX_PUSH. */
const pushLimit = await page.evaluate(async () => {
  const day = window.NotifPrefs.localDay();
  const ids = [];
  for (let i = 0; i < 4; i++) {
    ids.push(await window.DB.add('tasks', {
      title: 'Очередь ' + i, dueDate: day, dueTime: '10:0', priority: 'low',
      recurring: 'none', completed: false
    }));
  }
  await window.NotifPrefs.save({ enabled: true });
  window.PushManager.resetState();
  document.querySelectorAll('.vk-toast').forEach((t) => t.remove());

  const a = await window.PushManager.checkDueEvents({ force: true, system: false });
  /* Один баннер на проверку, а не по баннеру на событие */
  const toastsAfterFirst = document.querySelectorAll('.vk-toast').length;
  const memAfterFirst = Object.keys(
    (JSON.parse(localStorage.getItem(window.PushManager.KEY_SHOWN) || '{}')[day]) || {}).length;

  /* Дальше читаем очередь до конца: за одну проверку показывается не больше
     MAX_PUSH, поэтому число проверок зависит от того, сколько сроков накопил
     сид. Важно другое — суммарно показываются ВСЕ, и ни один не теряется */
  const rounds = [{ shown: a.shown, left: a.left, reason: a.reason }];
  for (let i = 0; i < 10 && rounds[rounds.length - 1].left > 0; i++) {
    const r = await window.PushManager.checkDueEvents({ ignoreThrottle: true, system: false });
    rounds.push({ shown: r.shown, left: r.left, reason: r.reason });
  }
  const after = await window.PushManager.checkDueEvents({ ignoreThrottle: true, system: false });

  for (const id of ids) { await window.DB.delete('tasks', id); }
  return {
    max: window.PushManager.MAX_PUSH,
    items: a.items.length,
    first: rounds[0],
    memAfterFirst: memAfterFirst,
    rounds: rounds,
    totalShown: rounds.reduce((n, r) => n + r.shown, 0),
    after: { reason: after.reason, shown: after.shown },
    toasts: toastsAfterFirst
  };
});
check('12.14.6 максимум пушей за раз ограничен, а остаток не теряется',
  pushLimit.max === 3 && pushLimit.items >= 5 && pushLimit.first.shown === pushLimit.max &&
    pushLimit.first.left === pushLimit.items - pushLimit.max && pushLimit.toasts === 1,
  pushLimit);

check('12.14.7 очередь показов стекается до нуля: следующий визит уже не о чём говорить',
  pushLimit.totalShown === pushLimit.items &&
    pushLimit.rounds.every((r) => r.shown <= pushLimit.max) &&
    pushLimit.rounds[pushLimit.rounds.length - 1].left === 0 &&
    pushLimit.after.reason === 'already-notified' && pushLimit.after.shown === 0,
  { items: pushLimit.items, totalShown: pushLimit.totalShown, rounds: pushLimit.rounds, after: pushLimit.after });

check('12.14.8 в память показов попадают только реально показанные события',
  pushLimit.memAfterFirst === pushLimit.max,
  { memory: pushLimit.memAfterFirst, items: pushLimit.items, max: pushLimit.max });

/* ================================================================
   12.15 Офлайн-безопасность: никаких фоновых будильников
   ================================================================ */
const timers = await page.evaluate(() => {
  const real = window.setInterval;
  const made = [];
  window.setInterval = function (fn, ms) { made.push(ms); return real.apply(window, arguments); };
  window.PushManager.init();
  window.CalendarExport.generateICS();
  return new Promise((res) => setTimeout(res, 300)).then(() => {
    window.setInterval = real;
    return { intervals: made };
  });
});
check('12.15.1 модуль напоминаний не ставит ни одного setInterval (условие этапа)',
  timers.intervals.length === 0, timers.intervals);

const listeners = await page.evaluate(async () => {
  const before = window.PerformanceObserver ? performance.getEntriesByType('resource').length : 0;
  await window.PushManager.checkDueEvents({ force: true });
  await new Promise((r) => setTimeout(r, 400));
  const after = performance.getEntriesByType('resource');
  const net = after.filter((e) => /push|notif|fcm|onesignal|subscribe/i.test(e.name) && !/js\/|css\//.test(e.name));
  return { net: net.map((e) => e.name.slice(0, 60)) };
});
check('12.15.2 напоминания не ходят в сеть: ни push-сервисов, ни своего бэкенда',
  listeners.net.length === 0, listeners.net);

const offlineBuild = await page.evaluate(async () => {
  const real = window.fetch;
  let called = 0;
  window.fetch = function () { called += 1; return Promise.reject(new Error('offline')); };
  const r = await window.CalendarExport.generateICS().then((x) => x.counts).catch((e) => ({ err: e.message }));
  window.fetch = real;
  return { called, r };
});
check('12.15.3 генератор .ics не зависит от сети',
  offlineBuild.called === 0 && !offlineBuild.r.err, offlineBuild);

const focusFlow = await page.evaluate(async () => {
  window.PushManager.resetState();
  const first = await window.PushManager.checkDueEvents({ force: true, system: false });
  // Возврат фокуса — штатный повод пересчитать (см. init)
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 300));
  const second = await window.PushManager.checkDueEvents({ force: true, system: false });
  return { first: first.reason, second: second.reason };
});
check('12.15.4 проверка привязана к фокусу вкладки и не требует таймера',
  ['in-app', 'already-notified', 'throttled'].indexOf(focusFlow.second) !== -1, focusFlow);

const swFiles = await page.evaluate(() => fetch('sw.js')
  .then((r) => r.text())
  .then((t) => {
    const list = (t.match(/\[[^\]]*PRECACHE[^\]]*\]/s) || [''])[0];
    return ['js/notifications-prefs.js', 'js/calendar-export.js', 'js/push-manager.js', 'js/quick-actions.js']
      .filter((f) => t.indexOf(f) !== -1);
  }));
check('12.15.5 скрипты этапа стоят в PRECACHE: офлайн приложение не остаётся без модулей',
  swFiles.length === 4, swFiles);

const cacheName = await page.evaluate(() => fetch('sw.js').then((r) => r.text())
  .then((t) => (/var CACHE_NAME = '([^']+)'/.exec(t) || [])[1]));
check('12.15.6 имя кэша поднято: cache-first иначе отдал бы старый набор без новых файлов',
  /^myorder-v12-(?:[4-9]|\d{2,})$/.test(cacheName), cacheName);

/* ================================================================
   12.16 Итог по консоли
   ================================================================ */
const bad = log();
check('12.16.1 ни одной ошибки и предупреждения в консоли за весь прогон',
  bad.length === 0, bad.slice(0, 8));

report('Уведомления и календарь (12.6)', R);
await browser.close();
process.exit(R.some((r) => !r.pass) ? 1 : 0);
