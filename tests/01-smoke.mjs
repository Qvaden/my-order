/**
 * Этап 11 / раздел 1 — базовый smoke-тест.
 * Разделы, консоль, горизонтальный скролл на 375px, touch targets.
 */
import { open, gotoSection, resetAll, report, check, BASE } from './harness.mjs';

const R = [];
const { browser, page, log } = await open();

// 1.1 Время до первого рендера
const t0 = Date.now();
await page.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.home-summary', { timeout: 8000 });
const firstPaint = Date.now() - t0;
check(R, '1.1 главный экран отрендерен < 2000 мс', firstPaint < 2000, firstPaint + ' мс');

const SECTIONS = [
  ['home', '.home-summary'],
  ['payments', '.payment-card, .empty-state'],
  ['meters', '.meter-card, .empty-state'],
  ['documents', '.document-card, .empty-state'],
  ['tasks', '.task-card, .empty-state'],
  ['stats', '.stats-section__title, .empty-state'],
  ['backup', '.backup-section']
];

// 1.2/1.3 каждый раздел открывается и консоль чистая
for (const [hash, sel] of SECTIONS) {
  const before = log().length;
  await gotoSection(page, hash, sel);
  const rendered = await page.evaluate((s) => !!document.querySelector(s), sel);
  check(R, `1.2 раздел #${hash} рендерится`, rendered, sel);
  check(R, `1.3 #${hash}: консоль чистая`, log().length === before, log().slice(before));
}

// 1.4 нет горизонтального скролла на 375px
for (const [hash] of SECTIONS) {
  await gotoSection(page, hash);
  const over = await page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [];
    document.querySelectorAll('#app *, .nav-bottom').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > doc.clientWidth + 1) {
        wide.push(el.className || el.tagName);
      }
    });
    return { scrollW: doc.scrollWidth, clientW: doc.clientWidth, offenders: wide.slice(0, 4) };
  });
  check(R, `1.4 #${hash}: нет горизонтального скролла`,
    over.scrollW <= over.clientW + 1, `${over.scrollW}>${over.clientW} ${over.offenders.join(',')}`);
}

// 1.5 touch targets >= 48px
await gotoSection(page, 'home', '.home-summary');
await gotoSection(page, 'payments', '.payment-card, .empty-state');
await gotoSection(page, 'tasks', '.task-item, .empty-state');
const small = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('button, a, input[type=checkbox], .nav-bottom__item').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return; // скрытые не считаем
    if (r.height < 44 || r.width < 44) {
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 40),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
        w: Math.round(r.width), h: Math.round(r.height)
      });
    }
  });
  return out;
});
check(R, '1.5 touch targets ≥44px (48 целевых, допуск 44)', small.length === 0,
  small.length ? small.slice(0, 8) : 'ok');

const bad = log();
check(R, '1.6 итог: 0 ошибок и 0 предупреждений', bad.length === 0, bad.slice(0, 6));

const fails = report('SMOKE', R);
await browser.close();
process.exit(fails ? 1 : 0);
