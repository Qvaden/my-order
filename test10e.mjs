import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

await page.addInitScript(() => {
  const ctx = document.createElement('canvas').getContext('2d');
  window.__c = {
    // Любой CSS-цвет (включая color(srgb ...) от color-mix) → [r,g,b] 0..255
    toRgb(color) {
      ctx.fillStyle = '#000';
      ctx.fillStyle = color;
      const s = String(ctx.fillStyle);
      if (s.startsWith('#')) {
        return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
      }
      const m = s.match(/-?[\d.]+/g).map(Number);
      // color(srgb r g b) — компоненты в диапазоне 0..1
      if (s.indexOf('srgb') !== -1 || (m[0] <= 1 && m[1] <= 1 && m[2] <= 1)) {
        return [Math.round(m[0] * 255), Math.round(m[1] * 255), Math.round(m[2] * 255)];
      }
      return m.slice(0, 3);
    },
    alphaOf(color) {
      const m = String(color).match(/[\d.]+/g);
      return m && m.length >= 4 ? Number(m[3]) : 1;
    },
    lum(rgb) {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    },
    opaqueBg(el) {
      let node = el;
      while (node && node !== document.documentElement) {
        const s = getComputedStyle(node);
        const a = window.__c.alphaOf(s.backgroundColor);
        if (a === 1 && s.backgroundColor !== 'rgba(0, 0, 0, 0)') return window.__c.toRgb(s.backgroundColor);
        node = node.parentElement;
      }
      return window.__c.toRgb(getComputedStyle(document.body).backgroundColor);
    },
    ratio(fgColor, el) {
      const fg = window.__c.toRgb(fgColor);
      const bg = window.__c.opaqueBg(el);
      const l1 = window.__c.lum(fg), l2 = window.__c.lum(bg);
      return {
        ratio: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100,
        fg: fg.join(','),
        bg: bg.join(',')
      };
    }
  };
});

// Seed
await page.goto('http://localhost:8080/#home', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.evaluate(async () => {
  const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const rows = [['Аренда', 'Жильё', 45000], ['Коммуналка', 'Коммунальные', 3200], ['Мобильная связь', 'Связь', 650], ['Кино', 'Развлечения', 990], ['Доктор', 'Здоровье', 1200]];
  for (const [title, category, amount] of rows) {
    try { await window.DB.add('payments', { title, amount, date: plus(2), category, frequency: 'monthly', status: 'pending' }); } catch (e) {}
  }
});

for (const theme of ['dark', 'light']) {
  await page.goto(`http://localhost:8080/?theme=${theme}#payments`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  const res = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.badge').forEach((b) => {
      const st = getComputedStyle(b);
      const r = window.__c.ratio(st.color, b);
      out.push({ text: b.textContent.trim(), ...r });
    });
    return out;
  });
  console.log(`\n--- ${theme.toUpperCase()} badges ---`);
  res.forEach((b) => console.log(`  ${b.ratio >= 4.5 ? 'PASS' : 'FAIL'}  ${String(b.ratio).padStart(6)}  fg(${b.fg}) bg(${b.bg})  ${b.text}`));
}

await browser.close();
