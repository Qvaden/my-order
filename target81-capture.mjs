import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.env.LOCALAPPDATA, 'opencode', 'shots');
fs.mkdirSync(OUT, { recursive: true });

console.log('[start] Launching browser...');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

// === Stats page: Bug 1 (progress) + Bug 3 (chart dots) ===
console.log('[1] Navigating to #stats...');
await page.goto('http://localhost:8080/#stats', { waitUntil: 'networkidle', timeout: 12000 });
// Ждём появления ключевых элементов — SPA роутит асинхронно
try { await page.locator('.stats-section__title').first().waitFor({ state: 'visible', timeout: 6000 }) } catch(e) {}
try { await page.locator('.stats-chart__graph').first().waitFor({ state: 'attached', timeout: 5000 }) } catch(e) {}
await page.waitForTimeout(500);

await page.screenshot({ path: path.join(OUT, '81-stats-full.png') });
console.log('[✓] 81-stats-full.png');

// Progress circle close-up
const progressEl = page.locator('.stats-progress');
if (await progressEl.count() > 0) {
  const rect = await progressEl.boundingBox();
  if (rect) {
    await progressEl.scrollIntoViewIfNeeded();
    await page.screenshot({ 
      path: path.join(OUT, '81-progress-circle.png'), 
      clip: { x: Math.max(0, rect.x - 20), y: Math.max(0, rect.y - 20), width: rect.width + 40, height: rect.height + 40 } 
    });
    console.log('[✓] 81-progress-circle.png');
  }
}

// Chart dots close-up
const chartGraphs = page.locator('.stats-chart__graph');
if (await chartGraphs.count() > 0) {
  const rect = await chartGraphs.first().boundingBox();
  if (rect) {
    await chartGraphs.first().scrollIntoViewIfNeeded();
    await page.screenshot({ 
      path: path.join(OUT, '81-chart-dots.png'), 
      clip: { x: Math.max(0, rect.x - 10), y: Math.max(0, rect.y - 60), width: rect.width + 20, height: rect.height + 80 } 
    });
    console.log('[✓] 81-chart-dots.png');
  }
}

// Measure dots
const dotMeasure = await page.evaluate(() => {
  var dots = document.querySelectorAll('.stats-chart__dot');
  var svgs = document.querySelectorAll('.stats-chart__svg');
  return {
    dotCount: dots.length,
    svgCount: svgs.length,
    dots: Array.from(dots).slice(0, 4).map(function(d, i) {
      var r = d.getBoundingClientRect();
      return { idx: i, left: parseFloat(getComputedStyle(d).left), top: parseFloat(getComputedStyle(d).top), pxW: Math.round(r.width * 10) / 10, pxH: Math.round(r.height * 10) / 10 };
    })
  };
});
console.log('[measure] Dot details:', JSON.stringify(dotMeasure));

// === Home: Bug 2 (summary cards) ===
console.log('[2] Navigating to #home...');
await page.goto('http://localhost:8080/#home', { waitUntil: 'networkidle', timeout: 12000 });
await page.waitForTimeout(800);

await page.screenshot({ path: path.join(OUT, '81-home-summary.png') });
console.log('[✓] 81-home-summary.png');

var cardMeasure = await page.evaluate(function() {
  var cards = document.querySelectorAll('.home-summary');
  return {
    count: cards.length,
    cards: Array.from(cards).map(function(c) {
      var s = getComputedStyle(c);
      var valEl = c.querySelector('.home-summary__value');
      var hintEl = c.querySelector('.home-summary__hint');
      return {
        label: c.querySelector('.home-summary__label').textContent.trim(),
        value: valEl ? valEl.textContent.trim() : '',
        hasValueUnit: !!valEl && valEl.querySelector('.home-summary__unit'),
        hint: hintEl ? hintEl.textContent.trim() : '',
        display: s.display,
        flexDirection: s.flexDirection,
        justifyContent: s.justifyContent,
        alignItems: s.alignItems,
        minHeight: s.minHeight,
        height: Math.round(c.getBoundingClientRect().height),
        width: Math.round(c.getBoundingClientRect().width)
      };
    })
  };
});
console.log('[measure] Card details:', JSON.stringify(cardMeasure));

await browser.close();
console.log('[done] All screenshots captured.');
