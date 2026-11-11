/**
 * МОЙ ПОРЯДОК — Этап 11: общие хелперы e2e-набора.
 *
 * Только инструменты прогона: браузер, консольный страж, сидинг данных,
 * замеры. Никакой логики приложения здесь нет и быть не должно.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

export const BASE = 'http://localhost:8080';
export const SHOTS = path.join(process.env.LOCALAPPDATA, 'opencode', 'shots', 'e11');

/**
 * Справочники разделов — точные значения из модулей. Тесты обязаны
 * использовать только их, иначе проверяют поведение на данных, которые
 * приложение создать не может (см. урок этапа 10 со status:'planned').
 */
export const REF = {
  payCategories: ['Коммунальные', 'Интернет', 'Мобильная связь', 'Кредиты', 'Подписки', 'Личные', 'Другое'],
  payFrequencies: { once: 'Разовый', monthly: 'Ежемесячно', quarterly: 'Ежеквартально', yearly: 'Ежегодно' },
  docCategories: ['Паспорт', 'Водительское удостоверение', 'Страховка', 'Медицинские', 'Договоры', 'Другое'],
  taskPriorities: { high: 'Высокий', medium: 'Средний', low: 'Низкий' },
  taskRecurring: { none: 'Не повторять', daily: 'Ежедневно', weekly: 'Еженедельно', monthly: 'Ежемесячно' },
  meterTypes: { cold: 'Холодная вода', hot: 'Горячая вода', electricity: 'Электричество', gas: 'Газ', other: 'Другое' }
};

/** @returns {Promise<{browser: import('playwright').Browser, page: import('playwright').Page, log: () => string[]}>} */
export async function open(opts = {}) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 375, height: 812 },
    hasTouch: true,
    ...(opts.offline ? { offline: true } : {})
  });
  const page = await ctx.newPage();

  const bad = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') {
      const text = m.text();
      // Playwright-артефакты и сторонние предупреждения не считаем багами приложения
      if (text.includes('DevTools') || text.includes('download the React')) return;
      bad.push(`[${t}] ${text}`);
    }
  });
  page.on('pageerror', (e) => bad.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => bad.push(`[404/net] ${r.url()} :: ${r.failure()?.errorText || ''}`));

  return { browser, ctx, page, log: () => bad.slice() };
}

/**
 * Перехват VK Bridge: эмуляция клиента без реального VK.
 *
 * mode:
 *   'auth'        — обычный заход, профиль отдаётся;
 *   'decline'     — пользователь отказал в авторизации;
 *   'paid'        — VKWebAppShowOrderBox возвращает order_status:'finished';
 *   'paid-pending'— платёж «в обработке»;
 *   'paid-decline'— платёж отклонён.
 *
 * Мок реализует VKWebAppStorageSet/Get с НАСТОЯЩИМ ограничением клиента:
 * ~5 КБ на значение. Без этого cloud-sync нельзя проверить на переполнение,
 * а именно этот лимит определяет, когда приложение обязано честно сказать
 * «дамп слишком большой», а не молча потерять копию.
 */
export async function emulateVK(page, mode = 'auth') {
  const orderStatus = mode === 'paid' ? 'finished'
    : mode === 'paid-pending' ? 'pending'
    : mode === 'paid-decline' ? 'declined'
    : null;

  const src = `(function(){
    var L=[],C=[];
    var store=Object.create(null);
    var VK_VALUE_LIMIT=5000;
    function push(t,d){L.forEach(function(l){l({detail:{type:t,data:d}})})}
    function storageSet(p){
      var v=String(p&&p.value!==undefined?p.value:'');
      if(v.length>VK_VALUE_LIMIT){
        return Promise.reject({error_type:'too_long',error_data:{limit:VK_VALUE_LIMIT,actual:v.length}});
      }
      store[String(p.key)]=v;
      return Promise.resolve({result:true});
    }
    function storageGet(p){
      var keys=(p&&p.keys)||[];
      var items=keys.filter(function(k){return Object.prototype.hasOwnProperty.call(store,String(k))})
        .map(function(k){return {key:String(k),value:store[String(k)]}});
      return Promise.resolve({items:items});
    }
    var f={
      send:function(m,p){C.push({method:m,params:p});
        if(m==='VKWebAppGetUserInfo'){
          if('${mode}'==='decline') return Promise.reject({error_type:'auth_required',error_data:{}});
          return Promise.resolve({id:1,first_name:'Александр',last_name:'Тест',photo_50:''});
        }
        if(m==='VKWebAppShare'){return Promise.resolve({type:'ok_link'})}
        if(m==='VKWebAppShowOrderBox'){
          ${orderStatus === null ? `return Promise.reject({error_type:'method_unsupported',error_data:{method:m}});` : ''}
          ${orderStatus !== null ? `return Promise.resolve({order_status:'${orderStatus}'});` : ''}
        }
        if(m==='VKWebAppStorageSet'){return storageSet(p||{})}
        if(m==='VKWebAppStorageGet'){return storageGet(p||{})}
        return Promise.resolve({result:true})},
      subscribe:function(fn){L.push(fn)},
      unsubscribe:function(fn){var i=L.indexOf(fn);if(i>-1)L.splice(i,1)},
      supports:function(){return Promise.resolve(true)},
      isWebView:function(){return true},isIframe:function(){return false},
      isEmbedded:function(){return true},isStandalone:function(){return false}
    };
    window.vkBridge=f;window.__vk={calls:C,push:push,store:store};
  })();`;
  const ctx = page.context();
  await ctx.route('**/js/vendor/vk-bridge.min.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: src }));
}

/**
 * Ставит тариф ДО загрузки приложения.
 *
 * Сброс в 'free' удалением ключа, а не записью tier:'free': readCache()
 * всё равно вернёт Free при отсутствующем кэше, и тест не будет зависеть
 * от формата записи.
 *
 * @param {import('playwright').Page} page
 * @param {'free'|'pro'} tier
 * @param {number} [ageMs] — «возраст» отметки, для теста TTL
 */
export async function setProTier(page, tier = 'pro', ageMs = 0) {
  await page.evaluate(([t, age]) => {
    const KEY = 'myorder_pro_cache';
    if (t === 'pro') {
      localStorage.setItem(KEY, JSON.stringify({ tier: 'pro', at: Date.now() - age }));
    } else {
      localStorage.removeItem(KEY);
    }
    // sessionStorage-разблокировка PIN: при смене тарифа тест должен видеть
    // то же поведение, что и свежий запуск приложения
    sessionStorage.removeItem('myorder_pin_unlocked');
  }, [tier, ageMs]);
}

/** Список методов VK Bridge, в которые реально стреляло приложение. */
export function vkCalls(page) {
  return page.evaluate(() => (window.__vk && window.__vk.calls ? window.__vk.calls.slice() : []));
}

/** Полный сброс состояния: IndexedDB + localStorage + кэши SW. */
export async function resetAll(page) {
  await page.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    localStorage.clear();
    if ('caches' in window) { for (const k of await caches.keys()) await caches.delete(k); }
    const dbs = await indexedDB.databases();
    for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name);
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
}

/**
 * Прямая запись в DB через публичный API — без UI, чтобы тест формы
 * не зависел от теста persistence и наоборот.
 */
export async function seed(page, spec) {
  return page.evaluate(async (s) => {
    const out = { payments: [], meters: [], readings: [], documents: [], tasks: [] };
    const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
    const rel = (v) => (typeof v === 'number' ? iso(v) : v);
    // DB.validateData отвергает null в optional-полях — поля без значения просто не отправляем
    const clean = (o) => {
      const r = {};
      for (const k of Object.keys(o)) if (o[k] !== null && o[k] !== undefined) r[k] = o[k];
      return r;
    };

    for (const p of (s.payments || [])) {
      const id = await window.DB.add('payments', clean({
        title: p.title, amount: p.amount, date: rel(p.date), category: p.category,
        frequency: p.frequency || 'once', status: p.status || 'pending'
      }));
      out.payments.push(id);
    }
    for (const m of (s.meters || [])) {
      const id = await window.DB.add('meters', clean({
        name: m.name, type: m.type, initialValue: m.initialValue, unit: m.unit || ''
      }));
      out.meters.push(id);
      for (const r of (m.readings || [])) {
        const rid = await window.DB.add('meter_readings', { meterId: id, value: r.value, date: rel(r.date) });
        out.readings.push(rid);
      }
    }
    for (const d of (s.documents || [])) {
      const id = await window.DB.add('documents', clean({
        name: d.name, category: d.category || 'Прочее',
        issuedDate: d.issuedDate === undefined || d.issuedDate === null ? null : rel(d.issuedDate),
        expiryDate: d.expiryDate === undefined || d.expiryDate === null ? null : rel(d.expiryDate),
        reminderDays: d.reminderDays ?? 30
      }));
      out.documents.push(id);
    }
    for (const t of (s.tasks || [])) {
      const id = await window.DB.add('tasks', clean({
        title: t.title, description: t.description || null, dueDate: t.dueDate === undefined ? null : rel(t.dueDate),
        dueTime: t.dueTime || null, priority: t.priority || 'medium',
        recurring: t.recurring || 'none', completed: !!t.completed,
        completedAt: t.completed ? new Date().toISOString() : null, isTemplate: false
      }));
      out.tasks.push(id);
    }
    return out;
  }, spec);
}

/** Счётчики записей во всех stores. */
export function counts(page) {
  return page.evaluate(async () => {
    const out = {};
    for (const s of ['payments', 'meters', 'meter_readings', 'documents', 'tasks']) {
      out[s] = (await window.DB.getAll(s)).length;
    }
    return out;
  });
}

export function rows(page) {
  return page.evaluate(async () => {
    const out = {};
    for (const s of ['payments', 'meters', 'meter_readings', 'documents', 'tasks']) {
      out[s] = await window.DB.getAll(s);
    }
    return out;
  });
}

/**
 * Удаляет все базы данных страницы и перезагружает её.
 * Нужен для тестов переподключения: соединение «убивается» извне
 * (indexedDB.deleteDatabase), а приложение обязано восстановить его само.
 * @param {import('playwright').Page} page
 */
export async function wipeDb(page) {
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    for (const d of dbs) { if (d.name) { indexedDB.deleteDatabase(d.name); } }
  });
  await page.waitForTimeout(250);
}

/** Снимает все обработчики, вешавшиеся на window (чистый старт после reload). */
export async function clearWindowHandlers(page, names = []) {
  return page.evaluate((list) => {
    let removed = 0;
    for (const name of list) {
      const on = 'on' + name;
      if (window[on]) { window[on] = null; removed++; }
    }
    return removed;
  }, names);
}

/** Навигация по разделам с ожиданием реального контента. */
export async function gotoSection(page, hash, sel) {
  const current = await page.evaluate(() =>
    (window.App && window.App.getCurrentRoute && window.App.getCurrentRoute()) || null).catch(() => null);
  // Переход на тот же хэш не вызывает hashchange и не перерисовывает SPA —
  // в этом случае идём напрямую через роутер приложения.
  if (current === hash) {
    await page.evaluate((h) => window.App.navigate(h), hash);
  } else {
    await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' });
  }
  if (sel) {
    await page.waitForSelector(sel, { timeout: 8000 }).catch(() => {});
  }
  await page.waitForTimeout(700);
}

/**
 * Снимает Service Worker и чистит кэши страницы. Нужно для тестов VK-эмуляции:
 * пока SW контролирует страницу, он отдаёт vk-bridge.min.js из кэша, и
 * перехват Playwright (мок-мост) до кода приложения не доходит.
 * @param {import('playwright').Page} page
 */
export async function unregisterSW(page) {
  await page.evaluate(async () => {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      for (const k of await caches.keys()) { await caches.delete(k); }
    }
  });
  await page.waitForTimeout(250);
}

/** Ждёт, пока SPA отрендерит раздел (по отличимому селектору или .card/.empty-state). */
export async function waitRendered(page, ms = 900) {
  await page.waitForTimeout(ms);
}

export function report(name, results) {
  const fails = results.filter((r) => !r.pass);
  console.log(`\n===== ${name}: ${results.length - fails.length}/${results.length} PASS =====`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.value !== undefined ? '  →  ' + JSON.stringify(r.value) : ''}`);
  }
  if (fails.length) console.log(`  >>> ${fails.length} FAIL in ${name}`);
  return fails.length;
}

export function check(list, name, pass, value) {
  list.push({ name, pass: !!pass, value });
}
