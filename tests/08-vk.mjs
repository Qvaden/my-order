/**
 * Этап 11 / раздел 7 — интеграция с ВКонтакте.
 * Анти-флеш тема, определение окружения, launch-параметры, гостевой режим,
 * отказ авторизации, toast-уведомления, шаринг и фолбэки, офлайн (Service
 * Worker), поведение CRUD в тёмной теме.
 *
 * VK эмулируется подменой js/vendor/vk-bridge.min.js: реальный SDK
 * перезаписывает window.vkBridge, поэтому перехватываем сам файл. Перехват
 * навешивается на контекст, поэтому все VK-сценарии живут в ОТДЕЛЬНОМ
 * контексте — иначе гостевые проверки видели мок.
 */
import { open, emulateVK, resetAll, gotoSection, report, BASE } from './harness.mjs';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });
const { browser, ctx, page, log } = await open();

const queryBeforeHash = (q, hash) => `${BASE}/?${q}${hash ? '#' + hash : ''}`;
const consoleErrors = [];
const watch = (p) => {
  p.on('console', (m) => {
    const t = m.type();
    if ((t === 'error' || t === 'warning') && !/DevTools|download the React/.test(m.text())) {
      consoleErrors.push(`[${t}] ${m.text()}`);
    }
  });
  p.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
};

/** Чистый (без мока) контекст для VK-сценариев. */
async function vkContext(mode) {
  const c = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const p = await c.newPage();
  watch(p);
  await emulateVK(p, mode);
  return { ctx: c, page: p };
}

// ---------- 7.1 Анти-флеш: тема из query-параметра до первого рендера ----------
async function firstPaintTheme(query) {
  const p = await ctx.newPage();
  watch(p);
  // Наблюдатель ставится до загрузки документа: важно поймать момент ДО app.js
  await p.addInitScript(() => {
    window.__flash = [];
    document.addEventListener('DOMContentLoaded', () => {
      const mo = new MutationObserver(() => {
        const meta = document.querySelector('meta[name="theme-color"]');
        window.__flash.push({
          theme: document.documentElement.getAttribute('data-theme') || null,
          meta: meta ? meta.getAttribute('content') : null
        });
      });
      mo.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    });
  });
  await p.goto(queryBeforeHash(query, 'home'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1400);
  const out = await p.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme') || null,
    scheme: document.documentElement.style.colorScheme || null,
    meta: (document.querySelector('meta[name="theme-color"]') || {}).content || null,
    bg: getComputedStyle(document.body).backgroundColor,
    surface: getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim(),
    text: getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim(),
    vk: window.VK ? { env: window.VK.env(), theme: window.VK.theme(), lang: window.VK.lang(), user: window.VK.user() } : null
  }));
  await p.close();
  return out;
}

const dark = await firstPaintTheme('theme=dark');
check('7.1.1 ?theme=dark ставит data-theme="dark" до первого рендера',
  dark.theme === 'dark' && dark.scheme === 'dark', dark);
check('7.1.2 в тёмной теме фон тёмный — «белой вспышки» нет',
  dark.bg !== 'rgb(255, 255, 255)' && dark.surface !== '#FFFFFF', { bg: dark.bg, surface: dark.surface });
check('7.1.3 meta theme-color подкрашен под тёмную тему', dark.meta === '#0F172A', dark.meta);
check('7.1.4 VK.theme() согласован с launch-параметром', dark.vk && dark.vk.theme === 'dark', dark.vk);

const light = await firstPaintTheme('theme=light');
check('7.1.5 ?theme=light → светлая тема', light.theme !== 'dark', light.theme);

const noParams = await firstPaintTheme('');
check('7.1.6 без параметров вне VK тема остаётся светлой (по критериям этапа)',
  noParams.theme !== 'dark', noParams.theme);

const schemeDark = await firstPaintTheme('vk_color_scheme=space_dark');
check('7.1.7 vk_color_scheme=space_dark (launch-параметр клиента) → тёмная тема',
  schemeDark.theme === 'dark', schemeDark.theme);

const schemeLight = await firstPaintTheme('vk_color_scheme=bright_light');
check('7.1.8 vk_color_scheme=bright_light → светлая тема', schemeLight.theme !== 'dark', schemeLight.theme);

const manualWins = await firstPaintTheme('theme=dark&vk_color_scheme=bright_light');
check('7.1.9 ручной ?theme= имеет приоритет над vk_color_scheme', manualWins.theme === 'dark', manualWins.theme);

// ---------- 7.2 Определение окружения вне VK ----------
check('7.2.1 вне ВКонтакте env() === "browser"', noParams.vk && noParams.vk.env === 'browser', noParams.vk);
check('7.2.2 в гостевом режиме профиля нет (user() === null)',
  noParams.vk && noParams.vk.user === null, noParams.vk);

// ---------- 7.3 Эмуляция VK: env, init, профиль, язык, события ----------
const vkA = await vkContext('auth');
const vp = vkA.page;
await vp.goto(queryBeforeHash('vk_language=ru&vk_color_scheme=space_gray', 'home'), { waitUntil: 'domcontentloaded' });
await vp.waitForTimeout(1500);

const vk = await vp.evaluate(async () => {
  await window.VK.loadUser();
  return {
    env: window.VK.env(),
    isVK: window.VK.isVK(),
    lang: window.VK.lang(),
    user: window.VK.user(),
    first: window.VK.firstName(),
    calls: (window.__vk ? window.__vk.calls : []).map((c) => c.method),
    params: window.__vk && window.__vk.calls[0] ? window.__vk.calls[0].params : null,
    bridge: typeof window.VK.bridge(),
    theme: window.VK.theme()
  };
});
check('7.3.1 внутри VK env() определяет окружение, isVK() === true',
  vk.isVK === true && (vk.env === 'vk-native' || vk.env === 'vk-web'), { env: vk.env, isVK: vk.isVK });
check('7.3.2 VKWebAppInit отправлен первым (обязательный вызов для клиентов VK)',
  vk.calls[0] === 'VKWebAppInit', vk.calls);
check('7.3.3 профиль загружен и доступен через user()/firstName()',
  !!vk.user && vk.user.first_name === 'Александр' && vk.first === 'Александр', vk.user);
check('7.3.4 язык прочитан из launch-параметра vk_language', vk.lang === 'ru', vk.lang);
check('7.3.5 space_gray (светлая схема клиента) → тема light', vk.theme === 'light', vk.theme);
check('7.3.6 bridge доступен другим модулям через VK.bridge()', vk.bridge === 'object', vk.bridge);

await gotoSection(vp, 'home', '.home-hero__greeting');
const greet = await vp.evaluate(() => {
  const el = document.querySelector('.home-hero__greeting');
  return el ? el.textContent.trim() : null;
});
check('7.3.7 приветствие на главной подставляет имя пользователя VK',
  !!greet && /Александр/.test(greet), greet);

const evtTheme = await vp.evaluate(async () => {
  window.__vk.push('VKWebAppUpdateConfig', { scheme: 'space_dark' });
  await new Promise((r) => setTimeout(r, 350));
  const afterDark = {
    theme: window.VK.theme(),
    attr: document.documentElement.getAttribute('data-theme'),
    meta: (document.querySelector('meta[name="theme-color"]') || {}).content
  };
  let fired = false;
  window.addEventListener('vk:theme', () => { fired = true; }, { once: true });
  window.__vk.push('VKWebAppUpdateConfig', { scheme: 'vk_light' });
  await new Promise((r) => setTimeout(r, 350));
  return { afterDark, fired, afterLight: window.VK.theme() };
});
check('7.3.8 событие VKWebAppUpdateConfig перекрашивает приложение в dark',
  evtTheme.afterDark.theme === 'dark' && evtTheme.afterDark.attr === 'dark' &&
  evtTheme.afterDark.meta === '#0F172A', evtTheme.afterDark);
check('7.3.9 обратная смена темы тоже применена и событие vk:theme долетело до app.js',
  evtTheme.afterLight === 'light' && evtTheme.fired === true, evtTheme);

const evtLang = await vp.evaluate(async () => {
  window.__vk.push('VKWebAppLanguageChangeUpdate', { language: 'en' });
  await new Promise((r) => setTimeout(r, 300));
  return window.VK.lang();
});
check('7.3.10 смена языка из клиента принята', evtLang === 'en', evtLang);

const manualHook = await vp.evaluate(() => {
  window.VK.setTheme('dark');
  const a = document.documentElement.getAttribute('data-theme');
  window.VK.toggleTheme();
  const b = document.documentElement.getAttribute('data-theme');
  return { a, b, theme: window.VK.theme() };
});
check('7.3.11 setTheme/toggleTheme синхронны с атрибутом data-theme',
  manualHook.a === 'dark' && manualHook.b === 'light', manualHook);

// ---------- 7.4 Toast-уведомления ----------
/** Показывает toast и возвращает ссылку на его узел + первые замеры. */
async function showToast(message, type, duration) {
  return vp.evaluate(async (m) => {
    const hostOld = document.getElementById('vk-toasts');
    if (hostOld) { hostOld.innerHTML = ''; }
    const dismiss = window.VK.notify(m.msg, m.type, m.duration);
    await new Promise((r) => setTimeout(r, 150));
    const nodes = document.querySelectorAll('#vk-toasts .vk-toast');
    const node = nodes[nodes.length - 1] || null;
    window.__t = node;
    const nav = document.querySelector('.nav-bottom');
    const rect = node ? node.getBoundingClientRect() : null;
    return {
      count: nodes.length,
      present: !!node,
      text: node ? node.textContent : null,
      inner: node ? node.innerHTML : null,
      cls: node ? node.className : null,
      live: hostOld ? hostOld.getAttribute('aria-live') : document.getElementById('vk-toasts').getAttribute('aria-live'),
      inClass: node ? /vk-toast--in/.test(node.className) : false,
      aboveNav: rect && nav ? rect.bottom <= nav.getBoundingClientRect().top + 2 : null,
      imgs: document.querySelectorAll('#vk-toasts img').length,
      scripts: document.querySelectorAll('#vk-toasts script').length,
      dismissible: typeof dismiss === 'function'
    };
  }, { msg: message, type, duration });
}

const toast = await showToast('Проверка уведомления', 'success', 2800);
check('7.4.1 notify() показывает toast с текстом, типом и aria-live',
  toast.present && toast.text === 'Проверка уведомления' && /vk-toast--success/.test(toast.cls) &&
  toast.live === 'polite', toast);
check('7.4.2 toast разворачивается (класс входа) и не перекрывает нижнюю навигацию',
  toast.inClass && toast.aboveNav === true, toast);
check('7.4.3 notify() возвращает функцию закрытия', toast.dismissible === true, toast.dismissible);

const autoClose = await vp.evaluate(async () => {
  const node = window.__t;
  const seenEarly = !!node && node.isConnected;
  await new Promise((r) => setTimeout(r, 3400));
  return { seenEarly, goneLater: !node || !node.isConnected };
});
check('7.4.4 toast живёт ~2.8s и исчезает сам (duration по умолчанию)',
  autoClose.seenEarly && autoClose.goneLater, autoClose);

const byClick = await showToast('Кликни меня', 'error', 60000);
const clicked = await vp.evaluate(async () => {
  const node = window.__t;
  node.click();
  await new Promise((r) => setTimeout(r, 500));
  return { gone: !node.isConnected, left: document.querySelectorAll('#vk-toasts .vk-toast').length };
});
check('7.4.5 закрытие по клику работает (toast с большой duration не зависает)',
  byClick.present && clicked.gone && clicked.left === 0, { byClick, clicked });

const htmlToast = await showToast('<img src=x onerror=alert(1)><b>жирный</b>', 'info', 3000);
check('7.4.6 HTML в уведомлении экранируется: тег не создаётся, текст виден буквально',
  htmlToast.present && htmlToast.imgs === 0 && htmlToast.scripts === 0 &&
  htmlToast.text.includes('<img src=x onerror=alert(1)>') && !/<img/.test(htmlToast.inner || ''),
  { text: htmlToast.text, inner: htmlToast.inner, imgs: htmlToast.imgs });

// ---------- 7.5 Шаринг ----------
const shareVK = await vp.evaluate(async () => {
  window.__vk.calls.length = 0;
  await window.VK.share();
  await new Promise((r) => setTimeout(r, 250));
  return window.__vk.calls.map((c) => ({ method: c.method, link: (c.params || {}).link }));
});
check('7.5.1 внутри VK share() вызывает VKWebAppShare', shareVK.some((c) => c.method === 'VKWebAppShare'), shareVK);
check('7.5.2 в шаринг передаётся адрес приложения, а не undefined',
  shareVK.some((c) => c.method === 'VKWebAppShare' && /localhost:8080/.test(String(c.link))), shareVK);

await gotoSection(vp, 'home', '.home-share-btn');
await vp.evaluate(() => { window.__vk.calls.length = 0; });
await vp.click('.home-share-btn');
await vp.waitForTimeout(500);
const btnShare = await vp.evaluate(() => window.__vk.calls.map((c) => c.method));
check('7.5.3 кнопка «Поделиться» на главной вызывает шаринг через VK',
  btnShare.includes('VKWebAppShare'), btnShare);

// ---------- 7.6 Гостевой режим (без мока): методы деградируют, а не падают ----------
await gotoSection(page, 'home', '.home-summary');
const guest = await page.evaluate(async () => {
  const out = { errors: [] };
  try { out.user = await window.VK.loadUser(); } catch (e) { out.errors.push('loadUser: ' + e.message); }
  try { out.after = await window.VK.loadUser(); } catch (e) { out.errors.push('repeat: ' + e.message); }
  try { await window.VK.share(); } catch (e) { out.errors.push('share: ' + e.message); }
  out.env = window.VK.env();
  out.firstName = window.VK.firstName();
  return out;
});
check('7.6.1 вне VK loadUser() возвращает null и не бросает',
  guest.user === null && guest.after === null && guest.errors.length === 0, guest);
check('7.6.2 вне VK env() === "browser", firstName пуст (приветствие без имени)',
  guest.env === 'browser' && guest.firstName === '', guest);
check('7.6.3 share() вне VK завершается без исключения (фолбэк копирования)',
  guest.errors.length === 0, guest.errors);

const guestGreet = await page.evaluate(() => {
  const el = document.querySelector('.home-hero__greeting');
  return el ? el.textContent.trim() : null;
});
check('7.6.4 гостевое приветствие не содержит «undefined»',
  !!guestGreet && !/undefined|null/.test(guestGreet), guestGreet);

// ---------- 7.7 Отказ авторизации в клиенте VK ----------
const vkD = await vkContext('decline');
await vkD.page.goto(queryBeforeHash('theme=dark', 'home'), { waitUntil: 'domcontentloaded' });
await vkD.page.waitForTimeout(1600);
const declined = await vkD.page.evaluate(async () => ({
  env: window.VK.env(),
  user: await window.VK.loadUser(),
  greeting: (document.querySelector('.home-hero__greeting') || {}).textContent || null,
  summaries: document.querySelectorAll('.home-summary').length,
  cards: !!document.querySelector('.nav-bottom'),
  theme: document.documentElement.getAttribute('data-theme')
}));
check('7.7.1 при отказе авторизации приложение работает гостем (user === null)',
  declined.user === null && declined.cards === true, declined);
check('7.7.2 гостевой интерфейс цел: сводки отрендерены, тема из параметров применена',
  declined.summaries > 0 && declined.theme === 'dark' && !!declined.greeting, declined);
check('7.7.3 отказа не считается ошибкой: profile-запрос в JS-ошибках не виден',
  !/PAGEERROR/.test(consoleErrors.join(' ')), consoleErrors.slice(0, 5));
await vkD.ctx.close();

// ---------- 7.8 Офлайн-режим: Service Worker ----------
await resetAll(page);
await page.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const swState = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) { return { supported: false }; }
  const regs = await navigator.serviceWorker.getRegistrations();
  const keys = await caches.keys();
  let precached = 0;
  let entries = [];
  if (keys.length) {
    const cache = await caches.open(keys[0]);
    const res = await cache.keys();
    precached = res.length;
    entries = res.map((r) => new URL(r.url).pathname);
  }
  return { supported: true, registered: regs.length, scope: regs[0] ? regs[0].scope : null, caches: keys, precached, entries };
});
check('7.8.1 Service Worker зарегистрирован, кэш создан',
  swState.supported && swState.registered >= 1 && swState.caches.length >= 1, { registered: swState.registered, caches: swState.caches });
check('7.8.2 прекешировано достаточно ресурсов для офлайна (≥12)',
  swState.precached >= 12, { precached: swState.precached });
check('7.8.3 в кэше есть вся критичная статика: html, css, все модули JS',
  ['index.html', 'css/styles.css', 'js/db.js', 'js/app.js', 'js/payments.js', 'js/backup.js']
    .every((p) => swState.entries.some((e) => e.endsWith(p))), swState.entries);

// Удаляем данные и уходим в офлайн: приложение обязано открыться из кэша
await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  for (const d of dbs) { if (d.name) { indexedDB.deleteDatabase(d.name); } }
});
await page.waitForTimeout(400);
await page.context().setOffline(true);
await page.goto(queryBeforeHash('theme=dark', 'payments'), { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(2000);
const offline = await page.evaluate(() => ({
  title: document.title,
  navDisplay: (() => {
    const el = document.querySelector('.nav-bottom');
    return el ? getComputedStyle(el).display : null;
  })(),
  surface: getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim(),
  dbReady: window.DB_READY,
  cards: document.querySelectorAll('.payment-card').length,
  empty: !!document.querySelector('.empty-state'),
  error: !!document.querySelector('[data-action="retry"]'),
  env: window.VK.env()
}));
check('7.8.4 офлайн приложение открывается из кэша (не «сервер не найден»)',
  /Порядок/.test(offline.title) && offline.navDisplay === 'flex', offline);
check('7.8.5 офлайн стили применены — это не «голый» HTML',
  offline.surface === '#1E293B', { surface: offline.surface });
check('7.8.6 офлайн база доступна и раздел отрендерен (данные локальны)',
  offline.dbReady === true && (offline.cards > 0 || offline.empty) && !offline.error, offline);
check('7.8.7 офлайн без VK тема берётся из launch-параметра (анти-флеш работает без сети)',
  offline.env === 'browser', offline.env);

await page.evaluate(() => {
  window.__e = null;
  try { window.VK.notify('Работаем офлайн', 'info', 300); } catch (e) { window.__e = e.message; }
});
const offlineToast = await page.evaluate(() => ({
  toast: !!document.querySelector('#vk-toasts .vk-toast'), err: window.__e
}));
check('7.8.8 VK-хелперы (toast) работают и без сети', offlineToast.toast && !offlineToast.err, offlineToast);

await page.context().setOffline(false);
await page.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

// ---------- 7.9 Перезагрузки: тема не «залипает», анти-флеш не разовый ----------
const beforeReload = await page.evaluate(() => {
  window.VK.setTheme('dark');
  return document.documentElement.getAttribute('data-theme');
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1300);
const afterReload = await page.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  meta: (document.querySelector('meta[name="theme-color"]') || {}).content
}));
check('7.9.1 вне VK тема после перезагрузки сбрасывается в светлую (не «залипшая»)',
  beforeReload === 'dark' && afterReload.theme !== 'dark', { beforeReload, ...afterReload });

const pQ = await ctx.newPage();
watch(pQ);
await pQ.goto(queryBeforeHash('theme=dark', 'home'), { waitUntil: 'domcontentloaded' });
await pQ.waitForTimeout(1200);
await pQ.reload({ waitUntil: 'domcontentloaded' });
await pQ.waitForTimeout(1200);
const qReload = await pQ.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  meta: (document.querySelector('meta[name="theme-color"]') || {}).content,
  bg: getComputedStyle(document.body).backgroundColor
}));
check('7.9.2 ?theme=dark переживает перезагрузку (анти-флеш не разовый)',
  qReload.theme === 'dark' && qReload.meta === '#0F172A' && qReload.bg !== 'rgb(255, 255, 255)', qReload);
await pQ.close();

// ---------- 7.10 Данные в тёмной теме VK живут как обычно ----------
await vp.goto(queryBeforeHash('vk_color_scheme=space_dark', 'payments'), { waitUntil: 'domcontentloaded' });
await vp.waitForTimeout(1500);
const crud = await vp.evaluate(async () => {
  const before = (await window.DB.getAll('payments')).length;
  const id = await window.DB.add('payments', {
    title: 'VK CRUD', amount: 123400, date: '2030-01-01', category: 'Другое', frequency: 'once', status: 'pending'
  });
  const added = (await window.DB.getAll('payments')).length;
  await window.DB.delete('payments', id);
  return { before, added, after: (await window.DB.getAll('payments')).length, theme: window.VK.theme() };
});
check('7.10.1 в тёмной теме VK данные пишутся и удаляются как обычно',
  crud.theme === 'dark' && crud.added === crud.before + 1 && crud.after === crud.before, crud);

const vkUi = await vp.evaluate(async () => {
  await window.DB.add('payments', {
    title: 'Тёмная карточка', amount: 500000, date: '2030-02-02', category: 'Интернет', frequency: 'once', status: 'pending'
  });
  window.Payments.invalidate();
  window.App.navigate('home');
  await new Promise((r) => setTimeout(r, 100));
  window.App.navigate('payments');
  await new Promise((r) => setTimeout(r, 1300));
  const card = document.querySelector('.payment-card');
  const cs = card ? getComputedStyle(card) : null;
  const text = card ? getComputedStyle(card.querySelector('h3, [class*="__title"]') || card) : null;
  const ids = await window.DB.getAll('payments');
  for (const p of ids) { await window.DB.delete('payments', p.id); }
  return {
    cards: card ? 1 : 0,
    bg: cs ? cs.backgroundColor : null,
    color: text ? text.color : null,
    pageBg: getComputedStyle(document.body).backgroundColor
  };
});
check('7.10.2 раздел в тёмной теме: карточка с тёмной подложкой и светлым текстом',
  vkUi.cards === 1 && vkUi.bg !== 'rgb(255, 255, 255)' && vkUi.pageBg === 'rgb(15, 23, 42)' &&
  vkUi.color !== 'rgb(15, 23, 42)', vkUi);

await vkA.ctx.close();

const bad = log().concat(consoleErrors);
check('7.11 итог: консоль чиста при всех VK-сценариях', bad.length === 0, bad.slice(0, 8));

const fails = report('VK INTEGRATION', R);
await browser.close();
process.exit(fails ? 1 : 0);
