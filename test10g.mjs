import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));

// Anti-flash: ловим состояние DOM на самом раннем этапе, до app.js
await page.addInitScript(() => {
  window.__early = [];
  const snap = () => window.__early.push({
    when: document.readyState,
    theme: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor
  });
  document.addEventListener('DOMContentLoaded', snap);
});

for (const url of [
  'http://localhost:8080/?theme=dark#home',
  'http://localhost:8080/?vk_color_scheme=space_dark#home',
  'http://localhost:8080/#home'
]) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => ({
    early: window.__early,
    final: document.documentElement.getAttribute('data-theme')
  }));
  console.log(url.replace('http://localhost:8080', ''), '→', JSON.stringify(r));
}

// Ошибок в консоли не должно быть ни на одном из запусков
console.log('[ERRORS]', errors.length ? errors : 'none');
await browser.close();
