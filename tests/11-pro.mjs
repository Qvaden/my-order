/**
 * Этап 12.5 — PRO-функции: облачный бэкап, аналитика с прогнозами,
 * PDF-отчёты и печатные формы, PIN-код, подписка через VK Pay.
 *
 * Ключевые инварианты, которые проверяет этот файл:
 *   • Free не скачивает тяжёлые библиотеки и не видит PRO-блоков;
 *   • покупка включает модули БЕЗ перезагрузки страницы;
 *   • после истечения подписки блокируются только PRO-функции — CRUD цел;
 *   • облачный бэкап честно сообщает, когда канал недоступен или дамп
 *     не влезает в лимит VK Storage, и никогда не теряет данные молча.
 *
 * window.print() в тестах подменяется: в headless Chromium диалога нет,
 * а нам важен собствен DOM-вывод (квитанция, QR, хост печати), а не
 * поведение браузера.
 *
 * Все сценарии с PRO живут в ОТДЕЛЬНЫХ контекстах: Service Worker отдаёт
 * js/vendor/* по стратегии cache-first и перехват Playwright (мок VK Bridge)
 * до приложения не дойдёт, пока регистрация жива (тот же урок, что и в 08-vk).
 */
import {
  open, emulateVK, resetAll, gotoSection, seed, counts, report,
  setProTier, vkCalls, BASE
} from './harness.mjs';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });

const { browser, page, log } = await open();
await resetAll(page);

/* ================================================================
   11.0 Мок печати: диалога в headless нет, проверяем наш DOM
   ================================================================ */
async function stubPrint(p) {
  await p.evaluate(() => {
    window.__prints = 0;
    window.print = function () { window.__prints += 1; };
  });
}

/* ================================================================
   11.1 Free: ничего PRO-го не видно и не качается
   ================================================================ */
await page.evaluate(() => window.ProManager.setTier('free'));
await gotoSection(page, 'home', '.home-summary');

const freeHome = await page.evaluate(() => ({
  banner: !!document.querySelector('.home-pro-banner'),
  bannerText: (document.querySelector('.home-pro-banner__text b') || {}).textContent || '',
  proAttr: document.documentElement.getAttribute('data-pro'),
  proOnlyVisible: [].slice.call(document.querySelectorAll('.pro-only'))
    .filter((el) => el.offsetParent !== null).length,
  pdfScript: !!document.querySelector('script[src*="jspdf"]'),
  qrScript: !!document.querySelector('script[src*="qrcode"]'),
  printCss: !!document.querySelector('link[data-lazy-style="print"]')
}));

check('11.1.1 Free: на главной есть баннер перехода в PRO',
  freeHome.banner && /Перейти в PRO|Хотите защитить/i.test(freeHome.bannerText), freeHome.bannerText);
check('11.1.2 Free: data-pro="free" — CSS-гейт закрыт', freeHome.proAttr === 'free', freeHome.proAttr);
check('11.1.3 Free: ни один .pro-only блок не виден', freeHome.proOnlyVisible === 0, freeHome.proOnlyVisible);
check('11.1.4 Free: jsPDF и QR не загружаются вообще',
  !freeHome.pdfScript && !freeHome.qrScript, freeHome);

await gotoSection(page, 'backup', '.backup-section');
const freeBackup = await page.evaluate(() => {
  const vis = (sel) => {
    const el = document.querySelector(sel);
    return Boolean(el && el.offsetParent !== null);
  };
  return {
    sections: document.querySelectorAll('.backup-section').length,
    cloudVisible: vis('[data-backup-action="cloud-save"]'),
    pinVisible: vis('[data-backup-action="pin-set"]'),
    pdfVisible: vis('[data-backup-action="pdf-report"]'),
    buyVisible: vis('[data-backup-action="buy-pro"]'),
    cloudInDom: !!document.querySelector('[data-backup-action="cloud-save"]'),
    statusText: (document.querySelector('.backup-sub__status') || {}).textContent || '',
    benefits: document.querySelectorAll('.backup-sub__benefits li').length
  };
});
check('11.1.5 Free: блоки облака/PIN/PDF скрыты, но «Подписка» видна',
  !freeBackup.cloudVisible && !freeBackup.pinVisible && !freeBackup.pdfVisible &&
  freeBackup.buyVisible && /Бесплатный тариф/.test(freeBackup.statusText), freeBackup);
check('11.1.6 Free: список преимуществ подписки показан (пользователь видит, за что платит)',
  freeBackup.benefits >= 4, freeBackup.benefits);
check('11.1.7 Free: CRUD-кнопки доступны (блокировать данные нельзя)',
  await page.evaluate(() => {
    const el = document.querySelector('[data-backup-action="export"]');
    return Boolean(el && el.offsetParent !== null && !el.disabled);
  }));

/* ================================================================
   11.2 Покупка: активация модулей без перезагрузки
   ================================================================ */
await seed(page, {
  payments: [
    { title: 'Интернет', amount: 80000, date: -1, category: 'Интернет', frequency: 'monthly', status: 'paid' },
    { title: 'Коммунальные', amount: 550000, date: -3, category: 'Коммунальные', frequency: 'monthly' }
  ],
  meters: [
    { name: 'ХВС', type: 'cold', initialValue: 100, readings: [{ value: 111, date: -40 }, { value: 118, date: -2 }] }
  ],
  tasks: [{ title: 'Оплатить свет', priority: 'high', dueDate: 0 }]
});

await gotoSection(page, 'home', '.home-summary');
const bannerBefore = await page.evaluate(() => !!document.querySelector('.home-pro-banner'));

const purchase = await page.evaluate(async () => {
  const seen = [];
  const on = (e) => seen.push(e.detail.tier);
  window.addEventListener('pro:changed', on);
  window.ProManager.setTier('pro', { welcome: true });
  await new Promise((r) => setTimeout(r, 600));
  window.removeEventListener('pro:changed', on);
  return {
    seen: seen,
    tier: window.ProManager.tier(),
    isPro: window.ProManager.isPro(),
    cached: JSON.parse(localStorage.getItem('myorder_pro_cache') || 'null'),
    attr: document.documentElement.getAttribute('data-pro'),
    bannerGone: !document.querySelector('.home-pro-banner'),
    toast: [].slice.call(document.querySelectorAll('.vk-toast__text')).map((t) => t.textContent).join(' | ')
  };
});

check('11.2.1 до покупки баннер был, после — исчез без перезагрузки',
  bannerBefore && purchase.bannerGone, { bannerBefore, bannerGone: purchase.bannerGone });
check('11.2.2 setTier("pro") стреляет pro:changed и пишет кэш',
  purchase.seen.includes('pro') && purchase.cached && purchase.cached.tier === 'pro', purchase);
check('11.2.3 DOM-атрибут data-pro="pro" проставлен', purchase.attr === 'pro', purchase.attr);
check('11.2.4 приветственный тост PRO произнесён дословно',
  /Добро пожаловать в PRO!.*защищены и синхронизированы/.test(purchase.toast), purchase.toast);

const proBackup = await (async () => {
  await gotoSection(page, 'backup', '.backup-section');
  return page.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      return Boolean(el && el.offsetParent !== null);
    };
    return {
      cloud: vis('[data-backup-action="cloud-save"]'),
      load: vis('[data-backup-action="cloud-load"]'),
      pin: vis('[data-backup-action="pin-set"]'),
      pdf: vis('[data-backup-action="pdf-report"]'),
      print: vis('[data-backup-action="pdf-print"]'),
      manage: vis('[data-backup-action="manage-subscription"]'),
      buy: vis('[data-backup-action="buy-pro"]'),
      status: (document.querySelector('.backup-sub__status') || {}).textContent || '',
      cloudStatus: (document.querySelector('.backup-cloud__status') || {}).textContent || ''
    };
  });
})();

check('11.2.5 PRO: облако, PIN, PDF и «Управлять подпиской» видимы',
  proBackup.cloud && proBackup.load && proBackup.pin && proBackup.pdf &&
  proBackup.print && proBackup.manage, proBackup);
check('11.2.6 PRO: кнопка «Купить PRO» убрана, статус — активен',
  !proBackup.buy && /PRO активен/.test(proBackup.status), proBackup);
check('11.2.7 PRO: статус облака объясняет канал и давность копии',
  /копия|облачн|Ручное|OneDrive|ВКонтакте/i.test(proBackup.cloudStatus), proBackup.cloudStatus);

/* ================================================================
   11.3 Аналитика PRO: прогноз, сравнение, тепловая карта
   ================================================================ */
await page.evaluate(async () => {
  // Даты берём ПЕРВОГО числа нужного месяца: относительные «-40 дней»
  // на начале месяца попали бы в неправильный закрытый период.
  // Формируем строку ЛОКАЛЬНЫМИ частями: toISOString() сдвигает
  // «1 октября 00:00» на 30 сентября в UTC, и fixture попал бы в чужой месяц.
  const pad = (n) => String(n).padStart(2, '0');
  const first = (back) => {
    const d = new Date();
    const m = new Date(d.getFullYear(), d.getMonth() - back, 1);
    return m.getFullYear() + '-' + pad(m.getMonth() + 1) + '-' + pad(m.getDate());
  };
  const rows = [
    ['Коммунальные', 500000, first(1)], ['Интернет', 80000, first(1)],
    ['Коммунальные', 520000, first(2)], ['Мобильная связь', 60000, first(2)],
    ['Коммунальные', 470000, first(3)], ['Подписки', 39900, first(3)]
  ];
  for (const [category, amount, date] of rows) {
    await window.DB.add('payments', {
      title: 'Тест ' + category, amount: amount, date: date,
      category: category, frequency: 'monthly', status: 'paid'
    });
  }
});

await gotoSection(page, 'stats', '.stats-section');
await page.waitForTimeout(900);

const analytics = await page.evaluate(() => {
  const forecast = document.querySelector('[data-pro-only="forecast"]');
  const compare = document.querySelector('[data-pro-only="compare"]');
  const heat = document.querySelector('[data-pro-only="heatmap"]');
  const bars = forecast ? forecast.querySelectorAll('.forecast-row__fill').length : 0;
  const widths = forecast
    ? [].slice.call(forecast.querySelectorAll('.forecast-row__fill')).map((b) => b.style.width)
    : [];
  return {
    forecast: !!forecast,
    compare: !!compare,
    heat: !!heat,
    baseSections: document.querySelectorAll('.stats-section:not(.stats-section--pro)').length,
    forecastTitle: forecast ? forecast.querySelector('.stats-section__title').textContent.trim() : '',
    expectedText: forecast ? (forecast.querySelector('.forecast-row__value') || {}).textContent : '',
    bars: bars,
    barsAnimated: widths.length === 2 && widths.every((w) => /%$/.test(w) && parseFloat(w) > 0),
    deltaText: forecast ? (forecast.querySelector('.forecast-row__delta') || {}).textContent || '' : '',
    cats: forecast ? forecast.querySelectorAll('.forecast-cats li').length : 0,
    compareValues: compare
      ? [].slice.call(compare.querySelectorAll('.compare-cell__value')).map((n) => n.textContent.trim())
      : [],
    heatCells: heat ? heat.querySelectorAll('.heatmap-cell:not(.heatmap-legend .heatmap-cell)').length : 0,
    heatRows: heat ? heat.querySelectorAll('.heatmap-row').length : 0,
    heatLabels: heat ? [].slice.call(heat.querySelectorAll('.heatmap-day')).map((n) => n.textContent) : [],
    heatOn: heat ? [].slice.call(heat.querySelectorAll('.heatmap-cell--on')).filter((c) => parseFloat(getComputedStyle(c).opacity) > 0.2).length : 0
  };
});

check('11.3.1 PRO догружает три блока: прогноз, сравнение, динамика',
  analytics.forecast && analytics.compare && analytics.heat, analytics);
check('11.3.2 базовые блоки статистики остались на месте',
  analytics.baseSections >= 3, analytics.baseSections);
check('11.3.3 прогноз считает среднее по закрытым месяцам и показывает сумму',
  /Прогноз расходов/.test(analytics.forecastTitle) && /₽/.test(analytics.expectedText || ''), analytics);
check('11.3.4 два бара «ожидаемые / фактические» анимированы до ширины',
  analytics.bars === 2 && analytics.barsAnimated, analytics);
check('11.3.5 показана дельта к прошлому месяцу в процентах и рублях',
  /%/.test(analytics.deltaText) && /₽/.test(analytics.deltaText), analytics.deltaText);
check('11.3.6 категорийный разрез прогноза присутствует', analytics.cats >= 2, analytics.cats);
check('11.3.7 сравнение периодов показывает три значения (тек / прошлый / разница)',
  analytics.compareValues.length === 3 && analytics.compareValues.every((v) => /₽|0/.test(v)), analytics.compareValues);
check('11.3.8 тепловая карта — 7 дней недели + строка заголовков',
  analytics.heatRows === 8 && analytics.heatLabels.join(',') === 'Пн,Вт,Ср,Чт,Пт,Сб,Вс', analytics.heatLabels);
check('11.3.9 интенсивность ячеек различима (есть хотя бы одна «тёплая»)',
  analytics.heatCells >= 7 && analytics.heatOn >= 1, { cells: analytics.heatCells, on: analytics.heatOn });

const forecastMath = await page.evaluate(async () => {
  const payments = await window.DB.getAll('payments');
  const f = window.Stats.buildForecast(payments);
  const months = f.sums.map((s) => s.total);
  const filled = months.filter((m) => m > 0);
  const manual = filled.length ? Math.round(filled.reduce((a, b) => a + b, 0) / filled.length) : 0;
  return {
    months: f.months.length,
    sums: months,
    expected: f.expected,
    manual: manual,
    lastActual: f.lastActual,
    lastMonth: months[months.length - 1],
    enough: f.enoughData,
    nextLabel: f.nextMonthLabel
  };
});
check('11.3.10 прогноз = среднее арифметическое непустых закрытых месяцев',
  forecastMath.expected === forecastMath.manual && forecastMath.months === 3, forecastMath);
check('11.3.11 «фактические» берут последний закрытый месяц, а не текущий',
  forecastMath.lastActual === forecastMath.lastMonth, forecastMath);
check('11.3.12 прогноз целится в следующий месяц',
  /\d{4}$/.test(forecastMath.nextLabel), forecastMath.nextLabel);

const noData = await page.evaluate(async () => {
  const f = window.Stats.buildForecast([]);
  return { enough: f.enoughData, expected: f.expected, monthsWithData: f.monthsWithData };
});
check('11.3.13 на пустой базе прогноз не выдумывает числа и не делит на ноль',
  !noData.enough && noData.expected === 0 && noData.monthsWithData === 0, noData);

/* ================================================================
   11.4 Событие db:change — фундамент облачного бэкапа
   ================================================================ */
const changeEvents = await page.evaluate(async () => {
  const got = [];
  const on = (e) => got.push({ store: e.detail.store, kind: e.detail.kind });
  window.addEventListener('db:change', on);

  // Локальная дата: toISOString().slice() дал бы вчерашний день
  // после полуночи по MSK (UTC+3), и платёж «на сегодня» уехал бы в прошлое
  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };

  const id = await window.DB.add('payments', {
    title: 'Событие add', amount: 10000, date: localDate(0),
    category: 'Другое', frequency: 'once', status: 'pending'
  });
  await window.DB.update('payments', id, { status: 'paid' });
  await window.DB.delete('payments', id);
  await window.DB.getAll('payments');          // чтение — события не даёт
  await new Promise((r) => setTimeout(r, 200));
  window.removeEventListener('db:change', on);

  // ЧИТАЕМ флаг до уборки: в прошлом варианте тест сам же его удалял
  // перед проверкой и получал ложный null
  const after = window.localStorage.getItem('myorder_cloud_dirty');
  window.localStorage.removeItem('myorder_cloud_dirty');
  return { got: got, dirtyAfterWrite: after };
});

check('11.4.1 add/update/delete шлют db:change с store и kind',
  changeEvents.got.length === 3 &&
  changeEvents.got[0].kind === 'create' && changeEvents.got[0].store === 'payments' &&
  changeEvents.got[1].kind === 'update' && changeEvents.got[2].kind === 'delete', changeEvents);
check('11.4.2 любое изменение данных помечает «есть несохранённое»',
  changeEvents.dirtyAfterWrite === '1', changeEvents);

/* ================================================================
   11.5 Облачный бэкап: VK Storage по чанкам + лимит
   ================================================================ */
const vkDump = await (async () => {
  const c = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const p = await c.newPage();
  const bad = [];
  p.on('console', (m) => {
    const t = m.type();
    if ((t === 'error' || t === 'warning') && !/DevTools|download the React/.test(m.text())) {
      bad.push(`[${t}] ${m.text()}`);
    }
  });
  p.on('pageerror', (e) => bad.push(`[pageerror] ${e.message}`));

  await emulateVK(p, 'auth');
  await p.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await p.evaluate(() => window.ProManager.setTier('pro'));

  const small = await p.evaluate(async () => {
    await window.DB.clear('payments', true);
    await window.DB.add('payments', {
      title: 'Маленький платёж', amount: 10000, date: '2026-01-05',
      category: 'Другое', frequency: 'once', status: 'pending'
    });
    const res = await window.CloudSync.pushNow({ force: true, silent: true });
    const keys = Object.keys(window.__vk.store);
    const meta = JSON.parse(window.__vk.store['myorder_bk_meta'] || 'null');
    let rebuilt = '';
    if (meta) {
      for (let i = 0; i < meta.n; i++) { rebuilt += window.__vk.store['myorder_bk_' + i] || ''; }
    }
    return {
      res: res,
      keys: keys,
      meta: meta,
      chunkSizes: keys.filter((k) => /^myorder_bk_\d+$/.test(k)).map((k) => window.__vk.store[k].length),
      roundTrip: rebuilt,
      dirty: window.localStorage.getItem('myorder_cloud_dirty'),
      last: window.localStorage.getItem('myorder_cloud_last_backup')
    };
  });

  const big = await p.evaluate(async () => {
    // Дамп заведомо больше VK-лимита (24 куска × 4000 = 96 000 символов):
    // обязаны честно отказаться и предложить ручной путь, а не обрезанные
    // данные. Порог считаем от констант модуля, а не «на глаз».
    const LIMIT = window.CloudSync.VK_LIMIT_CHARS;
    // Снимок VK Storage ДО раздувания: сравнив с ним, докажем, что
    // большой дамп не перезаписал и не обрубил уже сохранённую копию
    const metaBefore = window.__vk.store['myorder_bk_meta'] || '';
    const keysBefore = Object.keys(window.__vk.store).length;

    let guard = 0;
    let json = await window.CloudSync.buildDumpJson();
    while (json.length <= LIMIT && guard < 400) {
      guard += 1;
      await window.DB.add('payments', {
        title: 'Очень длинное название платежа для раздувания дампа №' + guard,
        amount: 100000 + guard, date: '2026-0' + (1 + (guard % 9)) + '-1' + (guard % 9),
        category: 'Коммунальные', frequency: 'monthly',
        status: 'pending', note: 'x'.repeat(500)
      });
      json = await window.CloudSync.buildDumpJson();
    }
    const res = await window.CloudSync.pushNow({ force: true, silent: true });
    return {
      res: res,
      jsonLength: json.length,
      limit: LIMIT,
      added: guard,
      untouched: window.__vk.store['myorder_bk_meta'] === metaBefore &&
        Object.keys(window.__vk.store).length === keysBefore,
      proxySaved: Boolean(window.localStorage.getItem('myorder_cloud_proxy')),
      dirty: window.localStorage.getItem('myorder_cloud_dirty')
    };
  });

  const restored = await p.evaluate(async () => {
    // Проверяем чтение из VK Storage: собрать и распарсить обратно
    const pull = await window.CloudSync.pullFromVkStorage();
    return { ok: pull.ok, message: pull.message, hasData: Boolean(pull.dump && pull.dump.data) };
  });

  const calls = await p.evaluate(() => window.__vk.calls.map((c) => c.method));
  await c.close();
  return { small, big, restored, calls, bad };
})();

check('11.5.1 маленький дамп уходит в VK WebAppStorageSet',
  vkDump.small.res.ran === true && vkDump.small.res.channel === 'vk', vkDump.small.res);
check('11.5.2 дамп режется на куски ≤4000 символов и метаданные пишутся',
  vkDump.small.meta && vkDump.small.chunkSizes.length === vkDump.small.meta.n &&
  vkDump.small.chunkSizes.every((n) => n <= 4000), { meta: vkDump.small.meta, sizes: vkDump.small.chunkSizes });
check('11.5.3 склейка кусков даёт исходный JSON (потери нет)',
  vkDump.small.roundTrip.length === vkDump.small.meta.len &&
  vkDump.small.roundTrip.startsWith('{"version"'), { len: vkDump.small.roundTrip.length, meta: vkDump.small.meta });
check('11.5.4 успешная выгрузка снимает dirty и фиксирует время бэкапа',
  vkDump.small.dirty === null && Boolean(vkDump.small.last), vkDump.small);
check('11.5.5 переросший лимит НЕ пишется в VK и не портит уже сохранённую копию',
  vkDump.big.jsonLength > vkDump.big.limit && vkDump.big.res.channel === 'manual' &&
  vkDump.big.untouched === true && /вручную|локальн/i.test(vkDump.big.res.message),
  { len: vkDump.big.jsonLength, limit: vkDump.big.limit, added: vkDump.big.added,
    untouched: vkDump.big.untouched, res: vkDump.big.res });
check('11.5.6 при отказе канала dirty остаётся — напоминание не потеряется',
  vkDump.big.dirty === '1' && vkDump.big.proxySaved, vkDump.big);
check('11.5.7 чтение из VK Storage возвращает валидный дамп',
  vkDump.restored.ok && vkDump.restored.hasData, vkDump.restored);
check('11.5.8 приложение трогает только бесплатные методы storage',
  vkDump.calls.includes('VKWebAppStorageSet') && vkCallsName(vkDump.calls), unique(vkDump.calls).join(','));

function vkCallsName(calls) {
  // Ни одного платного/серверного метода: только storage, order box и базовые
  const allowed = /^VKWebApp(StorageSet|StorageGet|Init|GetUserInfo|UpdateConfig|CopyText|ShowSnackbar|ShowErrorBox|Share|GetSettings|LanguageChangeUpdate|LangChange|ScrollViewChanged|AppStatusViewed)$/;
  return calls.every((m) => allowed.test(m));
}
function unique(arr) { return arr.filter((v, i) => arr.indexOf(v) === i); }

/* ================================================================
   11.6 Напоминание о бэкапе
   ================================================================ */
await page.evaluate(() => {
  localStorage.setItem('myorder_cloud_reminder', '');
  localStorage.setItem('myorder_cloud_last_backup', new Date(Date.now() - 9 * 86400000).toISOString());
  localStorage.setItem('myorder_cloud_dirty', '1');
});
const reminder = await page.evaluate(async () => {
  const shown = [];
  const host = document.getElementById('vk-toasts');
  const before = host ? host.children.length : 0;
  const ok = await window.CloudSync.checkReminder();
  await new Promise((r) => setTimeout(r, 200));
  const after = document.getElementById('vk-toasts');
  const texts = after ? [].slice.call(after.children).map((n) => n.textContent) : [];
  return { ok: ok, days: window.CloudSync.daysSinceBackup(), last: texts.slice(before).join(' | ') };
});
check('11.6.1 бэкап старше недели → напоминание «Ваш последний бэкап был N дней назад»',
  reminder.ok === true && /последн\S+ бэкап был 9 дней назад/.test(reminder.last), reminder);

const reminderTwice = await page.evaluate(async () => {
  const again = await window.CloudSync.checkReminder();
  localStorage.setItem('myorder_cloud_last_backup', new Date().toISOString());
  const fresh = await window.CloudSync.checkReminder();
  return { again: again, fresh: fresh };
});
check('11.6.2 не чаще одного раза в сутки и не при свежей копии',
  reminderTwice.again === false && reminderTwice.fresh === false, reminderTwice);

// Формы проверяем только на тех значениях, где напоминание вообще
// положено (<7 дней его нет), и зачищаем хост тостов, чтобы не читать
// чужое сообщение прошлой итерации
const reminderTexts = await page.evaluate(async () => {
  const res = [];
  for (const d of [7, 8, 11, 21, 22, 24]) {
    const host = document.getElementById('vk-toasts');
    if (host) { host.innerHTML = ''; }
    localStorage.setItem('myorder_cloud_last_backup', new Date(Date.now() - d * 86400000).toISOString());
    localStorage.removeItem('myorder_cloud_reminder');
    const shown = await window.CloudSync.checkReminder();
    const node = host && host.lastElementChild;
    res.push({ d: d, shown: shown, text: node ? node.textContent : '' });
  }
  return res;
});
const grammar = reminderTexts.map((r) => (r.text.match(/был (\S+ \S+) назад/) || [])[1] || r.text);
check('11.6.3 русские формы корректны: 21 день / 22 дня / 7 дней / 11 дней',
  /21 день/.test(grammar.join(' ')) && /22 дня/.test(grammar.join(' ')) &&
  /7 дней/.test(grammar.join(' ')) && /11 дней/.test(grammar.join(' ')), grammar);

/* ================================================================
   11.7 PIN-код: установка, блокировка, восстановление
   ================================================================ */
await gotoSection(page, 'backup', '.backup-section');
const pinUi = await page.evaluate(async () => {
  const bad1 = window.Security.validatePin('1111');
  const bad2 = window.Security.validatePin('1234');
  const bad3 = window.Security.validatePin('12');
  const good = window.Security.validatePin('4917');
  // Подсказка восстановления читает привязанный VK ID. Вне клиента VK
  // приложение его получить не может, поэтому ID подставляем ровно так,
  // как он выглядел бы после авторизации (id=1)
  localStorage.setItem('myorder_pin_recovery', '1');
  const set = await window.Security.setPin('4917');
  return {
    bad1: bad1, bad2: bad2, bad3: bad3, good: good, set: set,
    isSet: window.Security.isPinSet(),
    record: JSON.parse(localStorage.getItem('myorder_pin') || 'null'),
    hint: window.Security.recoveryHint()
  };
});
check('11.7.1 PIN проверяется строго: 4 цифры, без «1111» и «1234»',
  Boolean(pinUi.bad1 && pinUi.bad2 && pinUi.bad3) && pinUi.good === null, pinUi);
check('11.7.2 валидный PIN устанавливается', pinUi.set.ok && pinUi.isSet, pinUi.set);
check('11.7.3 PIN хранится ТОЛЬКО хэшем — соли и алгоритма в открытом виде нет',
  /^[0-9a-f]{16,}$/.test(pinUi.record.hash) && pinUi.record.salt &&
  !JSON.stringify(pinUi.record).includes('4917'), pinUi.record);
check('11.7.4 восстановление привязано к VK ID (показаны последние 4 цифры)',
  pinUi.hint === '••••0001', pinUi.hint);

// Реальный запуск с уже установленным PIN: блокировка должна появиться ДО рендера разделов
const locked = await (async () => {
  const c = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const p = await c.newPage();
  const bad = [];
  p.on('console', (m) => {
    const t = m.type();
    if ((t === 'error' || t === 'warning') && !/DevTools|download the React/.test(m.text())) {
      bad.push(`[${t}] ${m.text()}`);
    }
  });
  p.on('pageerror', (e) => bad.push(`[pageerror] ${e.message}`));

  await p.addInitScript(() => {
    localStorage.setItem('myorder_pro_cache', JSON.stringify({ tier: 'pro', at: Date.now() }));
    // Хэш считаем самим приложением нельзя (нужен Web Crypto), поэтому
    // ставим PIN тем же кодом, что и пользователь, но ДО загрузки: см. ниже
  });
  await p.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  // Устанавливаем PIN штатным путём и перезагружаемся — ровно то, что
  // произойдёт у реального пользователя на следующем запуске
  await p.evaluate(async () => {
    await window.Security.setPin('4917');
    // setPin разблокирует текущую сессию (иначе каждый ввод PIN
    // заканчивал бы переспросом). Нас интересует СЛЕДУЮЩИЙ запуск,
    // поэтому сессионную метку снимаем руками — ровно то, что делает
    // закрытие вкладки у реального пользователя.
    sessionStorage.removeItem('myorder_pin_unlocked');
  });
  // goto() на тот же путь с другим hash — ЭТО НЕ перезагрузка (браузер
  // делает только hashchange), а блокировка вешается именно на старте.
  // Поэтому ставим hash и перезапускаем страницу по-настоящему.
  await p.goto(BASE + '/#payments', { waitUntil: 'domcontentloaded' });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1400);

  const state = await p.evaluate(() => ({
    overlay: !!document.querySelector('.pin-overlay'),
    locked: document.body.classList.contains('pin-locked'),
    dots: document.querySelectorAll('.pin-dot').length,
    title: (document.querySelector('.pin-card__title') || {}).textContent || '',
    cardsVisible: [].slice.call(document.querySelectorAll('.payment-card, .empty-state'))
      .filter((el) => el.offsetParent !== null).length,
    canScroll: getComputedStyle(document.body).overflow,
    session: sessionStorage.getItem('myorder_pin_unlocked')
  }));

  // Escape не должен снимать блокировку
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  const afterEscape = await p.evaluate(() => !!document.querySelector('.pin-overlay'));

  // Неправильный PIN ×5 → пауза 30 секунд
  await p.evaluate(() => { localStorage.setItem('myorder_pin_lock_until', '0'); });
  let wrongBlocked = false;
  for (let i = 0; i < 5; i++) {
    await p.fill('.pin-input', '1299');
    await p.waitForTimeout(220);
  }
  const cooldown = await p.evaluate(() => ({
    left: window.Security.cooldownLeft(),
    disabled: Boolean((document.querySelector('.pin-card__submit') || {}).disabled),
    line: (document.querySelector('.pin-card__cooldown') || {}).textContent || '',
    hidden: Boolean((document.querySelector('.pin-card__cooldown') || {}).hidden)
  }));
  wrongBlocked = cooldown.left > 0;

  // Верный PIN снимает блокировку
  await p.evaluate(() => { localStorage.removeItem('myorder_pin_lock_until'); });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await p.evaluate(() => {
    const el = document.querySelector('.pin-input');
    el.value = '4917';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(700);
  const unlocked = await p.evaluate(() => ({
    overlay: !!document.querySelector('.pin-overlay'),
    session: sessionStorage.getItem('myorder_pin_unlocked'),
    rendered: !!document.querySelector('.payment-card, .empty-state')
  }));

  await c.close();
  return { state, afterEscape, cooldown, wrongBlocked, unlocked, bad };
})();

check('11.7.5 PRO + установленный PIN → при запуске поверх всего оверлей',
  locked.state.overlay && locked.state.locked && locked.state.title.includes('Приложение защищено'), locked.state);
check('11.7.6 пока PIN не введён, данные не показываются и страница не скроллится',
  locked.state.cardsVisible === 0 && locked.state.canScroll === 'hidden', locked.state);
check('11.7.7 Escape блокировку не снимает', locked.afterEscape === true, locked.afterEscape);
check('11.7.8 пять ошибок подряд → пауза 30 с и кнопка отключена',
  locked.wrongBlocked && locked.cooldown.left > 20000 && locked.cooldown.disabled,
  { left: locked.cooldown.left, line: locked.cooldown.line });
check('11.7.9 верный PIN снимает оверлей и открывает раздел',
  !locked.unlocked.overlay && locked.unlocked.session === '1' && locked.unlocked.rendered, locked.unlocked);
check('11.7.10 в сценарии PIN консоль приложения чистая', locked.bad.length === 0, locked.bad.slice(0, 5));

const pinWrongSaysWrong = await page.evaluate(async () => {
  // Сессия уже разблокирована штатным setPin(); здесь важна сама
  // математика проверки: «неверно» и «нет механизма проверки» — разные ответы
  localStorage.removeItem('myorder_pin_lock_until');
  const bad = await window.Security.verify('9999');
  const good = await window.Security.verify('4917');
  return { bad: bad, good: good };
});
check('11.7.11 проверка PIN различает «неверно» и «нечем проверить»',
  pinWrongSaysWrong.bad.ok === false && pinWrongSaysWrong.bad.blocked === false &&
  pinWrongSaysWrong.good.ok === true, pinWrongSaysWrong);

/* ================================================================
   11.8 Истечение подписки: PRO-фичи уходят, данные остаются
   ================================================================ */
const expired = await page.evaluate(async () => {
  // Истечение симулируем СМЕНАЙ ТАРИФА, а не снятием PIN: приложение по
  // условиям этапа не имеет права удалять настройки пользователя — оно
  // обязано лишь скрыть PRO-функции.
  window.ProManager.setTier('free');
  await new Promise((r) => setTimeout(r, 500));
  const vis = (sel) => {
    const el = document.querySelector(sel);
    return Boolean(el && el.offsetParent !== null);
  };
  window.location.hash = 'backup';
  await new Promise((r) => setTimeout(r, 900));
  return {
    cloud: vis('[data-backup-action="cloud-save"]'),
    pin: vis('[data-backup-action="pin-set"]'),
    exportVisible: vis('[data-backup-action="export"]'),
    overlay: !!document.querySelector('.pin-overlay'),
    pinStillStored: Boolean(localStorage.getItem('myorder_pin')),
    payments: (await window.DB.getAll('payments')).length
  };
});
check('11.8.1 после истечения PRO-блоки снова скрыты',
  !expired.cloud && !expired.pin, expired);
check('11.8.2 PIN больше не держит приложение (данные доступны)',
  !expired.overlay, expired);
check('11.8.3 CRUD не заблокирован: экспорт и данные на месте',
  expired.exportVisible && expired.payments > 0, expired);
check('11.8.4 хэш PIN сохранён: возврат подписки не выглядит как потеря данных',
  expired.pinStillStored === true, expired);

const stale = await (async () => {
  const c = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const p = await c.newPage();
  await p.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
  const out = await p.evaluate(async () => {
    // Отметка старше TTL: считаем Free до подтверждения, вечной подписки нет
    localStorage.setItem('myorder_pro_cache', JSON.stringify({ tier: 'pro', at: Date.now() - 3 * 86400000 }));
    const pro = await window.ProManager.checkSubscriptionStatus();
    return { pro: pro, isPro: window.ProManager.isPro() };
  });
  await c.close();
  return out;
})();
check('11.8.5 кэш статуса старше TTL → тариф снова Free',
  stale.pro === false && stale.isPro === false, stale);

/* ================================================================
   11.9 PDF-отчёт (jsPDF + кириллица)
   ================================================================ */
await page.evaluate(() => window.ProManager.setTier('pro'));
await stubPrint(page);
await gotoSection(page, 'backup', '.backup-section');

const pdf = await page.evaluate(async () => {
  const before = {
    pdf: !!window.jspdf,
    font: !!window.PdfFontCyrillic
  };
  const res = await window.PdfExporter.generateReport('year');
  const after = {
    pdf: !!window.jspdf,
    font: !!window.PdfFontCyrillic
  };
  const doc = res.doc;
  const bytes = new Uint8Array(doc.output('arraybuffer'));
  let head = '';
  for (let i = 0; i < 8; i++) { head += String.fromCharCode(bytes[i]); }
  const pages = doc.internal.getNumberOfPages();

  // Кириллица реально вшита: без addFont doc.text('Платежи') дало бы
  // битую кодировку, а шрифт в ресурсах страницы появляется только после addFont
  const source = doc.output();
  return {
    before: before,
    after: after,
    fileName: res.fileName,
    bytes: bytes.length,
    head: head,
    pages: pages,
    payments: res.report.payments.length,
    meters: res.report.meters.length,
    fontEmbedded: /PTSansCyr/.test(source),
    cyrillicInPdf: /MTAg0YDRgtC40LLQuQ==|0JLQu/.test(source) || bytes.length > 3000
  };
});

check('11.9.1 jsPDF и шрифт появились ТОЛЬКО после запроса отчёта',
  !pdf.before.pdf && !pdf.before.font && pdf.after.pdf && pdf.after.font, pdf);
check('11.9.2 generateReport отдаёт настоящий PDF (заголовок %PDF-)',
  pdf.head.indexOf('%PDF-') === 0 && pdf.bytes > 2000, { head: pdf.head, bytes: pdf.bytes });
check('11.9.3 имя файла отражает период и дату',
  /^my_order_report_\d{4}-\d{2}-\d{2}_year\.pdf$/.test(pdf.fileName), pdf.fileName);
check('11.9.4 кириллический шрифт вшит в документ', pdf.fontEmbedded, pdf.fileName);
check('11.9.5 отчёт за год содержит платежи и счётчики из базы',
  pdf.payments > 0 && pdf.meters > 0 && pdf.pages >= 1, pdf);

const pdfStructure = await page.evaluate(async () => {
  // Структуру рисования читаем из НЕсжатого документа: при compress:true
  // потоки страниц уходят в FlateDecode и операторов в тексте нет.
  // Пользовательский файл всё равно сжимается — проверяем только геометрию.
  //
  // Формат чисел jsPDF — «40. 715.88 515.27 -20. re»: хвостовая точка и
  // отрицательная высота, поэтому в класс символа нужны и минус, и точка.
  const res = await window.PdfExporter.generateReport('year', { compress: false });
  const doc = res.doc;
  const src = doc.output();
  const rects = (src.match(/[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ re/g) || []).length;
  const lines = (src.match(/[-\d.]+ [-\d.]+ l/g) || []).length;
  const rows = res.report.payments.length + res.report.meters.length;
  return {
    rects: rects,
    lines: lines,
    rows: rows,
    payments: res.report.payments.length,
    meters: res.report.meters.length,
    pages: doc.internal.getNumberOfPages()
  };
});
// На каждую строку таблицы (плюс заголовки и блок итогов) приходится свой
// rect — иначе «таблица с чёткими границами» была бы только обещанием
check('11.9.6 таблицы нарисованы с границами: rect на каждую строку + линии колонок',
  pdfStructure.rects >= pdfStructure.rows + 3 && pdfStructure.lines >= 5,
  pdfStructure);

const longReport = await page.evaluate(async () => {
  for (let i = 0; i < 90; i++) {
    await window.DB.add('payments', {
      title: 'Очень длинное название платежа для проверки переноса таблицы ' + i,
      amount: 100000 + i, date: '2026-03-1' + (i % 9), category: 'Коммунальные',
      frequency: 'once', status: i % 2 ? 'paid' : 'pending'
    });
  }
  const res = await window.PdfExporter.generateReport('year');
  return { pages: res.doc.internal.getNumberOfPages(), payments: res.report.payments.length };
});
check('11.9.7 длинный список переносится на новые страницы, а не обрезается',
  longReport.pages >= 2 && longReport.payments > 60, longReport);

/* ================================================================
   11.10 Квитанция с QR и печать
   ================================================================ */
await gotoSection(page, 'payments', '.payment-card');
const receiptUi = await page.evaluate(() => ({
  buttons: document.querySelectorAll('[data-action="receipt"]').length,
  label: (document.querySelector('[data-action="receipt"]') || {}).getAttribute
    ? document.querySelector('[data-action="receipt"]').getAttribute('aria-label')
    : ''
}));
check('11.10.1 PRO: у каждого платежа есть кнопка «Распечатать квитанцию»',
  receiptUi.buttons >= 1 && /квитанц/i.test(receiptUi.label), receiptUi);

const receipt = await page.evaluate(async () => {
  const id = Number(document.querySelector('.payment-card').getAttribute('data-id'));
  const res = await window.PdfExporter.printReceipt(id);
  await new Promise((r) => setTimeout(r, 500));
  const host = document.getElementById('pdf-print-root');
  const qr = host ? host.querySelector('.receipt-print__qr svg') : null;
  return {
    shown: res.shown,
    hostExists: Boolean(host),
    prints: window.__prints,
    brand: host ? (host.querySelector('.receipt-print__brand') || {}).textContent : '',
    sum: host ? (host.querySelector('.receipt-print__sum strong') || {}).textContent : '',
    rows: host ? host.querySelectorAll('.receipt-print__table tr').length : 0,
    props: host ? host.querySelectorAll('.receipt-print__prop').length : 0,
    qrExists: Boolean(qr),
    // Библиотека рисует ВСЕ модули одним <path> (экономия места),
    // поэтому размер кода считаем по числу команд M в его атрибуте d,
    // а не по количеству узлов
    qrExistsSvg: qr ? qr.tagName : '',
    qrModules: qr ? ((qr.querySelector('path') || {}).getAttribute
      ? (((qr.querySelector('path') || {}).getAttribute('d') || '').match(/M/g) || []).length
      : 0) : 0,
    payload: window.PdfExporter.receiptPayload(res.payment),
    printCssLoaded: Boolean(document.querySelector('link[data-lazy-style="print"]')),
    printBlocked: getComputedStyle(document.body).overflow
  };
});

check('11.10.2 квитанция показывается и window.print() вызван',
  receipt.shown && receipt.hostExists && receipt.prints >= 1, receipt);
check('11.10.3 в квитанции есть шапка, таблица, сумма и реквизиты',
  /МОЙ ПОРЯДОК/.test(receipt.brand) && receipt.rows >= 5 &&
  /₽/.test(receipt.sum) && receipt.props >= 5, receipt);
check('11.10.4 QR-код построен и не пустой',
  receipt.qrExists && receipt.qrModules > 20, { modules: receipt.qrModules });
check('11.10.5 payload QR читается кириллицей без «кракозябр»',
  /Наз:[А-Яа-яЁё]/.test(receipt.payload) && /Сум:\d/.test(receipt.payload),
  receipt.payload.split('\n').slice(0, 3).join(' ⏎ '));
check('11.10.6 стили печати подгружены лениво ровно к моменту печати',
  receipt.printCssLoaded, receipt);

const qrPayloadReal = await page.evaluate(async () => {
  // Тот же текст, что попадает в QR, должен декодироваться: проверяем,
  // что библиотека использует UTF-8, а не обрезает байты до 0xFF
  const q = await window.Lazy.loadQrcode();
  const utf8 = q.stringToBytes && q.stringToBytes('ПЛАТЁЖ');
  return { bytes: utf8, first: utf8[0], length: utf8.length };
});
check('11.10.7 кириллица в QR кодируется полными UTF-8 байтами (2 на букву)',
  qrPayloadReal.first === 208 && qrPayloadReal.length === 12, qrPayloadReal);

await page.evaluate(() => window.PdfExporter.closePrintView());
const closed = await page.evaluate(() => ({
  host: !!document.getElementById('pdf-print-root'),
  cls: document.body.classList.contains('printing-mode'),
  overflow: getComputedStyle(document.body).overflow
}));
check('11.10.8 предпросмотр печати убирает за собой слой и блокировку скролла',
  !closed.host && !closed.cls && closed.overflow !== 'hidden', closed);

/* ================================================================
   11.11 Кнопки раздела: PDF и облако кликабельны из UI
   ================================================================ */
await gotoSection(page, 'backup', '.backup-section');
await page.click('[data-backup-action="pdf-report"]');
await page.waitForTimeout(4000);
const reportStatus = await page.evaluate(() => ({
  text: (document.querySelector('[data-backup-status="pdf"]') || {}).textContent || '',
  level: (document.querySelector('[data-backup-status="pdf"]') || {}).className || '',
  disabled: Boolean((document.querySelector('[data-backup-action="pdf-report"]') || {}).disabled)
}));
check('11.11.1 «Скачать PDF-отчёт» из UI завершается успехом и подписью',
  /Отчёт сохранён/.test(reportStatus.text) && reportStatus.disabled === false, reportStatus);

await page.click('[data-backup-action="pdf-print"]');
await page.waitForTimeout(1500);
const printStatus = await page.evaluate(() => ({
  text: (document.querySelector('[data-backup-status="pdf"]') || {}).textContent || '',
  host: !!document.getElementById('pdf-print-root'),
  tables: document.querySelectorAll('#pdf-print-root .report-table').length,
  prints: window.__prints
}));
check('11.11.2 «Печать отчёта» открывает HTML-форму с обеими таблицами',
  /предпросмотр/i.test(printStatus.text) && printStatus.host &&
  printStatus.tables >= 3 && printStatus.prints >= 1, printStatus);
await page.evaluate(() => window.PdfExporter.closePrintView());

/* ================================================================
   11.12 UI раздела «Подписка»: покупка и управление
   ================================================================ */
const buyFlow = await page.evaluate(() => ({
  buyVisible: Boolean(document.querySelector('[data-backup-action="buy-pro"]')),
  manageVisible: (() => {
    const el = document.querySelector('[data-backup-action="manage-subscription"]');
    return Boolean(el && el.offsetParent !== null);
  })(),
  price: [].slice.call(document.querySelectorAll('.backup-section__hint'))
    .map((n) => n.textContent).join(' ')
}));
check('11.12.1 PRO: показывается «Управлять подпиской», а не «Купить PRO»',
  !buyFlow.buyVisible && buyFlow.manageVisible, buyFlow);
// В PRO-разметке цены быть не должно: подписчику она уже не продаётся,
// ему нужен честный путь управления автопродлением
check('11.12.2 PRO: подсказка называет путь управления подпиской во ВКонтакте',
  /Отключить автопродление|Кошелёк|Подписки/i.test(buyFlow.price), buyFlow.price.slice(0, 120));

const manage = await page.evaluate(async () => {
  document.querySelector('[data-backup-action="manage-subscription"]').click();
  await new Promise((r) => setTimeout(r, 400));
  return {
    text: (document.querySelector('[data-backup-status="sub"]') || {}).textContent || '',
    link: /vk\.com\/settings\?act=payments/.test((document.querySelector('[data-backup-status="sub"]') || {}).textContent || '')
  };
});
check('11.12.3 «Управлять подпиской» ведёт в кошелёк VK Pay (ссылка показана)',
  manage.link && /скопирован|Откройте вручную/.test(manage.text), manage);

/* ================================================================
   11.13 Отказ в PRO-функции на уровне обработчиков
   ================================================================ */
const gate = await page.evaluate(async () => {
  window.ProManager.setTier('free');
  await new Promise((r) => setTimeout(r, 500));
  window.location.hash = 'backup';
  await new Promise((r) => setTimeout(r, 900));

  // Кнопки скрыты CSS, но узлы в DOM есть — проверка guard-а в JS
  const cloud = document.querySelector('[data-backup-action="cloud-save"]');
  const pin = document.querySelector('[data-backup-action="pin-set"]');
  if (cloud) { cloud.click(); }
  if (pin) { pin.click(); }
  await new Promise((r) => setTimeout(r, 400));

  const pdfErr = await window.PdfExporter.generateReport('month').then(
    () => 'no-error', (e) => e.message);
  const receiptErr = await window.PdfExporter.printReceipt(1);
  const pushErr = await window.CloudSync.pushNow({ force: true, silent: true });
  return {
    cloudText: (document.querySelector('[data-backup-status="cloud"]') || {}).textContent || '',
    pinText: (document.querySelector('[data-backup-status="pin"]') || {}).textContent || '',
    pdfErr: pdfErr,
    receiptErr: receiptErr,
    pushRan: pushErr.ran
  };
});
check('11.13.1 клик по скрытой PRO-кнопке в Free даёт «Доступно только в PRO»',
  /только в PRO/.test(gate.cloudText) || /только в PRO/.test(gate.pinText), gate);
check('11.13.2 PDF API в Free отказывает явно, а не падает',
  /только в PRO/.test(gate.pdfErr), gate.pdfErr);
check('11.13.3 printReceipt в Free возвращает shown:false с объяснением',
  gate.receiptErr.shown === false && /только в PRO/.test(gate.receiptErr.message), gate.receiptErr);
check('11.13.4 фоновая выгрузка в Free не выполняется',
  gate.pushRan === false, gate);

/* ================================================================
   11.14 Тяжёлые библиотеки не попадают в критический путь
   ================================================================ */
const critical = await (async () => {
  const c = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const p = await c.newPage();
  const loaded = [];
  p.on('response', (res) => {
    const u = new URL(res.url());
    if (/\.(js|css|ttf|woff2)$/.test(u.pathname)) { loaded.push(u.pathname.replace(/^\//, '')); }
  });
  await p.goto(BASE + '/#home', { waitUntil: 'load' });
  await p.waitForTimeout(2500);
  await p.evaluate(async () => {
    window.App.navigate('stats');
    await new Promise((r) => setTimeout(r, 900));
    window.App.navigate('backup');
    await new Promise((r) => setTimeout(r, 900));
  });
  const heavy = loaded.filter((n) => /jspdf|qrcode|print\.css/.test(n));
  await c.close();
  return { total: loaded.length, heavy: heavy, list: loaded };
})();
check('11.14.1 Free не скачивает jsPDF/QR/print.css ни на одном разделе',
  critical.heavy.length === 0, critical.heavy);
check('11.14.2 критический путь лёгкий: чужих модулей нет, только свои',
  critical.list.every((n) => !/unpkg|cdn|googleapis|cdnjs/.test(n)), critical.list.join(', '));

/* ================================================================
   11.15 Формат дампа совместим с обычным импортом
   ================================================================ */
await page.evaluate(() => window.ProManager.setTier('pro'));
const dumpCompat = await page.evaluate(async () => {
  const json = await window.CloudSync.buildDumpJson();
  const parsed = JSON.parse(json);
  const v = window.Backup.validateImport(parsed);
  const broken = window.CloudSync.parseDump('{"data":{"payments":1}}');
  const junk = window.CloudSync.parseDump('не json');
  const alien = window.CloudSync.parseDump(JSON.stringify({ data: { secrets: [] } }));
  return {
    stores: Object.keys(parsed.data),
    valid: v.valid,
    cloud: parsed.cloud,
    broken: broken.ok,
    junk: junk.ok,
    junkMessage: junk.message,
    alien: alien.ok,
    alienMessage: alien.message
  };
});
check('11.15.1 облачный дамп проходит обычную валидацию импорта',
  dumpCompat.valid && dumpCompat.cloud === true, dumpCompat);
check('11.15.2 в дамп не попадают настройки приложения',
  !dumpCompat.stores.includes('settings'), dumpCompat.stores);
check('11.15.3 битый JSON, мусор и чужое хранилище отклоняются до записи',
  dumpCompat.broken === false && dumpCompat.junk === false && dumpCompat.alien === false &&
  /JSON/.test(dumpCompat.junkMessage) && /хранилище/.test(dumpCompat.alienMessage), dumpCompat);

/* ================================================================
   11.16 Итог по консоли
   ================================================================ */
const bad = log();
check('11.16 итог: консоль приложения без ошибок и предупреждений',
  bad.length === 0, bad.slice(0, 8));

const fails = report('PRO 12.5', R);
await browser.close();
process.exit(fails ? 1 : 0);
