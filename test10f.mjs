import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.env.LOCALAPPDATA, 'opencode', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

// 1. Seed + светлая тема (регрессия «как раньше»)
await page.goto('http://localhost:8080/#home', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.evaluate(async () => {
  const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const rows = [['Аренда', 'Жильё', 45000], ['Коммуналка', 'Коммунальные', 3200], ['Мобильная связь', 'Связь', 650]];
  for (const [title, category, amount] of rows) {
    try { await window.DB.add('payments', { title, amount, date: plus(2), category, frequency: 'monthly', status: 'pending' }); } catch (e) {}
  }
  try { await window.DB.add('tasks', { title: 'Передать показания', priority: 'high', dueDate: plus(0), completed: false }); } catch (e) {}
});
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '10f-light-home.png'), fullPage: true });
await page.goto('http://localhost:8080/#payments', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(OUT, '10f-light-payments.png'), fullPage: true });

// 2. SW: новая версия кэша, старый удалён
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const keys = await caches.keys();
  return {
    registered: !!reg,
    active: !!(reg && reg.active),
    cacheKeys: keys,
    entries: await (async () => {
      const out = {};
      for (const k of keys) {
        const c = await caches.open(k);
        out[k] = (await c.keys()).length;
      }
      return out;
    })()
  };
});
console.log('[SW]', JSON.stringify(sw));

// 3. Офлайн: страница + данные
await ctx.setOffline(true);
await page.goto('http://localhost:8080/#payments', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(2500);
const offline = await page.evaluate(async () => {
  let count = null;
  try { count = (await window.DB.getAll('payments')).length; } catch (e) { count = 'err'; }
  return {
    url: location.href,
    theme: document.documentElement.getAttribute('data-theme'),
    sdk: typeof window.vkBridge !== 'undefined',
    vkModule: typeof window.VK !== 'undefined',
    cards: document.querySelectorAll('.payment-card').length,
    dbCount: count,
    swControlled: !!navigator.serviceWorker.controller
  };
});
console.log('[OFFLINE]', JSON.stringify(offline));
await page.screenshot({ path: path.join(OUT, '10f-offline-payments.png'), fullPage: true });
await ctx.setOffline(false);

console.log('[ERRORS]', errors.length ? errors : 'none');
await browser.close();
