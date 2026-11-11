import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.env.LOCALAPPDATA, 'opencode', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });

/**
 * Подменяем сам файл VK Bridge SDK (route), чтобы фейк жил ДО выполнения
 * vk-integration.js: обычная перезапись window.vkBridge в addInitScript
 * не работает — реальный SDK в <head> присваивает window.vkBridge позже.
 */
function fakeSdkSource(mode) {
  // mode: 'auth' — профиль отдаётся; 'decline' — пользователь отказался
  return `
    (function () {
      var listeners = [];
      var calls = [];
      function push(type, data) {
        listeners.forEach(function (l) { l({ detail: { type: type, data: data } }); });
      }
      var fake = {
        send: function (method, params) {
          calls.push({ method: method, params: params });
          if (method === 'VKWebAppGetUserInfo') {
            if ('${mode}' === 'decline') {
              return Promise.reject({ error_type: 'auth_required', error_data: {} });
            }
            return Promise.resolve({ id: 1, first_name: 'Максимилиан', last_name: 'Тест', photo_50: '' });
          }
          if (method === 'VKWebAppShare') {
            push('VKWebAppShareResult', { type: 'ok_link' });
            return Promise.resolve({ type: 'ok_link' });
          }
          return Promise.resolve({ result: true });
        },
        subscribe: function (fn) { listeners.push(fn); },
        unsubscribe: function (fn) { var i = listeners.indexOf(fn); if (i > -1) listeners.splice(i, 1); },
        supports: function () { return Promise.resolve(true); },
        isWebView: function () { return true; },
        isIframe: function () { return false; },
        isEmbedded: function () { return true; },
        isStandalone: function () { return false; }
      };
      window.vkBridge = fake;
      window.__vk = { calls: calls, push: push, listeners: listeners };
    })();
  `;
}

async function seedData(page) {
  await page.goto('http://localhost:8080/#home', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.evaluate(async () => {
    const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const mk = (t) => ({ title: t, amount: 4500, date: plus(2), category: 'Жильё', frequency: 'monthly', status: 'pending' });
    try { await window.DB.add('payments', mk('Аренда')); } catch (e) {}
    try { await window.DB.add('payments', { ...mk('Коммуналка'), category: 'Коммунальные' }); } catch (e) {}
    try { await window.DB.add('documents', { name: 'Договор аренды', category: 'Договор', expireDate: plus(2), reminderDays: 3 }); } catch (e) {}
    try { await window.DB.add('tasks', { title: 'Передать показания', priority: 'high', dueDate: plus(0), completed: false }); } catch (e) {}
  });
}

/* ================================================================
   B. Запуск внутри VK: тема из launch-параметров + имя пользователя
   ================================================================ */
{
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/js/vendor/vk-bridge.min.js', (route) => {
    route.fulfill({ status: 200, contentType: 'application/javascript', body: fakeSdkSource('auth') });
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

  await seedData(page);

  await page.goto('http://localhost:8080/?vk_color_scheme=space_dark&vk_app_id=56818021&vk_user_id=1#home', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1600);

  const vk = await page.evaluate(() => ({
    env: window.VK.env(),
    isVK: window.VK.isVK(),
    theme: window.VK.theme(),
    attr: document.documentElement.getAttribute('data-theme'),
    firstName: window.VK.firstName(),
    greeting: document.querySelector('.home-hero__greeting')?.textContent,
    calls: window.__vk.calls.map((c) => c.method),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    metaTheme: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    cards: document.querySelectorAll('.home-summary').length
  }));
  console.log('[B] VK dark + user:', JSON.stringify(vk, null, 1));

  // Динамическая смена темы свет → тёмная (эмуляция theme_changed)
  const dyn = await page.evaluate(() => {
    window.__vk.push('VKWebAppUpdateConfig', { scheme: 'bright_light', app_id: 56818021 });
    const light = { theme: window.VK.theme(), attr: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor };
    window.__vk.push('VKWebAppUpdateConfig', { scheme: 'space_dark' });
    const dark = { theme: window.VK.theme(), attr: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor };
    return { light, dark };
  });
  console.log('[B] dynamic theme:', JSON.stringify(dyn));

  // Клик «Поделиться» → VKWebAppShare
  await page.locator('.home-share-btn').click();
  await page.waitForTimeout(700);
  const share = await page.evaluate(() => ({
    shareCalled: window.__vk.calls.some((c) => c.method === 'VKWebAppShare'),
    toast: document.querySelector('.vk-toast')?.textContent || null
  }));
  console.log('[B] share:', JSON.stringify(share));

  // Раскладка при длинном имени
  const layout = await page.evaluate(() => {
    const g = document.querySelector('.home-hero__greeting');
    const hero = document.querySelector('.home-hero');
    return {
      text: g.textContent,
      clipped: g.scrollWidth > g.clientWidth + 1,
      heroRight: Math.round(hero.getBoundingClientRect().right),
      shareBtn: (() => { const b = document.querySelector('.home-share-btn').getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) }; })(),
      gearBtn: (() => { const b = document.querySelector('.home-gear-btn').getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) }; })(),
      overlap: (() => {
        const a = document.querySelector('.home-share-btn').getBoundingClientRect();
        const c = document.querySelector('.home-gear-btn').getBoundingClientRect();
        return a.right > c.left && a.left < c.right;
      })()
    };
  });
  console.log('[B] layout:', JSON.stringify(layout));

  await page.screenshot({ path: path.join(OUT, '10c-vk-dark-home.png'), fullPage: true });

  // Статистика и разделы в тёмной теме внутри VK
  await page.goto('http://localhost:8080/?vk_color_scheme=space_dark#payments', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const badge = await page.evaluate(() => {
    const b = document.querySelector('.badge');
    if (!b) return { present: false };
    const s = getComputedStyle(b);
    return { present: true, bg: s.backgroundColor, color: s.color, rows: document.querySelectorAll('.payment-card').length };
  });
  console.log('[B] dark badge:', JSON.stringify(badge));
  await page.screenshot({ path: path.join(OUT, '10c-vk-dark-payments.png'), fullPage: true });

  await page.goto('http://localhost:8080/?vk_color_scheme=space_dark#stats', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, '10c-vk-dark-stats.png'), fullPage: true });

  console.log('[B] errors:', errors.length ? errors : 'none');
  await ctx.close();
}

/* ================================================================
   C. Гость в VK: отказ от авторизации — приложение живёт дальше
   ================================================================ */
{
  const errors = [];
  const warns = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/js/vendor/vk-bridge.min.js', (route) => {
    route.fulfill({ status: 200, contentType: 'application/javascript', body: fakeSdkSource('decline') });
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('[console] ' + m.text());
    if (m.type() === 'warning') warns.push('[warn] ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

  await page.goto('http://localhost:8080/?vk_color_scheme=bright_light&vk_app_id=56818021#home', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const guest = await page.evaluate(() => ({
    env: window.VK.env(),
    firstName: window.VK.firstName(),
    user: window.VK.user(),
    greeting: document.querySelector('.home-hero__greeting')?.textContent,
    theme: window.VK.theme(),
    cards: document.querySelectorAll('.home-summary').length,
    shareBtn: !!document.querySelector('.home-share-btn')
  }));
  console.log('[C] guest in VK:', JSON.stringify(guest));
  console.log('[C] errors:', errors.length ? errors : 'none');
  console.log('[C] warnings:', warns.length ? warns : 'none');
  await ctx.close();
}

/* ================================================================
   D. Обычный браузер: никаких VK-вызовов, консоль чистая
   ================================================================ */
{
  const errors = [];
  const warns = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('[console] ' + m.text());
    if (m.type() === 'warning') warns.push('[warn] ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

  await seedData(page);
  await page.goto('http://localhost:8080/#home', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const browserMode = await page.evaluate(() => ({
    env: window.VK.env(),
    isVK: window.VK.isVK(),
    theme: window.VK.theme(),
    attr: document.documentElement.getAttribute('data-theme'),
    firstName: window.VK.firstName(),
    greeting: document.querySelector('.home-hero__greeting')?.textContent,
    sdkLoaded: typeof window.vkBridge !== 'undefined',
    bodyBg: getComputedStyle(document.body).backgroundColor,
    pro: window.ProManager.isPro(),
    swActive: !!navigator.serviceWorker.controller
  }));
  console.log('[D] browser mode:', JSON.stringify(browserMode));

  // Шаринг в браузере без navigator.share → копирование + toast
  const shareFallback = await page.evaluate(async () => {
    window.VK.share();
    await new Promise((r) => setTimeout(r, 500));
    return { toast: document.querySelector('.vk-toast')?.textContent || null };
  });
  console.log('[D] share fallback:', JSON.stringify(shareFallback));

  console.log('[D] errors:', errors.length ? errors : 'none');
  console.log('[D] warnings:', warns.length ? warns : 'none');
  await ctx.close();
}

await browser.close();
