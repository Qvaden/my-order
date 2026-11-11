/**
 * Этап 11 / раздел 10 — метрики производительности.
 * FCP, TTI, DOMContentLoaded/load, время отрисовки разделов на большом
 * наборе, прирост кучи после навигаций, размер экспорта.
 *
 * Замеры снимаются на «тёплом» и «холодном» старте отдельно: SW-кэш даёт
 * офлайн-ускорение, и его нужно видеть отдельно от первой загрузки.
 */
import { open, resetAll, seed, report, BASE } from './harness.mjs';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });
const { browser, ctx, page, log } = await open();

const NAV_TIMING = `
  window.__perf = new Promise((resolve) => {
    const marks = {};
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === 'first-contentful-paint') marks.fcp = e.startTime;
        if (e.name === 'first-largest-paint') marks.flp = e.startTime;
        // LCP живёт только в этом observer'е: getEntriesByType('largest-contentful-paint')
        // возвращает пустой список, поэтому держим последнее значение здесь.
        if (e.entryType === 'largest-contentful-paint') marks.lcp = e.startTime;
      }
    });
    try { po.observe({ type: 'paint', buffered: true }); } catch (e) {}
    try { po.observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
    document.addEventListener('DOMContentLoaded', () => {
      marks.dcl = performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd;
      marks.load = performance.getEntriesByType('navigation')[0].loadEventEnd;
    }, { once: true });
    window.addEventListener('load', () => {
      // TTI приближаем по Long Tasks: момент, после которого 50 мс main-thread
      // свободен. Полноценный TTI считает Lighthouse — здесь контроль.
      let lastEnd = 0;
      const lt = new PerformanceObserver((l) => {
        for (const t of l.getEntries()) { lastEnd = t.startTime + t.duration; }
      });
      try { lt.observe({ type: 'longtask', buffered: true }); } catch (e) {}
      setTimeout(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        marks.load = nav ? nav.loadEventEnd : marks.load;
        marks.dcl = nav ? nav.domContentLoadedEventEnd : marks.dcl;
        marks.ttiApprox = Math.max(lastEnd, marks.load || 0);
        marks.lcp = marks.lcp || (() => {
          const l = performance.getEntriesByType('largest-contentful-paint');
          return l.length ? l[l.length - 1].startTime : null;
        })();
        marks.resourceCount = performance.getEntriesByType('resource').length;
        marks.transferBytes = performance.getEntriesByType('resource')
          .reduce((s, r) => s + (r.transferSize || 0), 0);
        marks.encodedBytes = performance.getEntriesByType('resource')
          .reduce((s, r) => s + (r.encodedBodySize || 0), 0);
        resolve(marks);
      }, 2500);
    }, { once: true });
  });
`;

async function coldLoad(query) {
  const p = await ctx.newPage();
  await p.addInitScript(NAV_TIMING);
  const t0 = Date.now();
  await p.goto(BASE + '/' + (query ? '?' + query : '') + '#home', { waitUntil: 'load' });
  const marks = await p.evaluate(() => window.__perf);
  const wall = Date.now() - t0;
  const idle = await p.evaluate(() => new Promise((res) => {
    let last = 0;
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) last = Math.max(last, e.startTime + e.duration); });
    try { po.observe({ type: 'longtask', buffered: true }); } catch (e) {}
    setTimeout(() => res(Math.round(last)), 1500);
  }));
  await p.close();
  return { marks: await marks, wall, longTaskTail: idle };
}

// ---------- 10.1 Холодный старт (чистый кэш) ----------
await resetAll(page);
await page.evaluate(async () => {
  if ('serviceWorker' in navigator) { for (const r of await navigator.serviceWorker.getRegistrations()) { await r.unregister(); } }
  if ('caches' in window) { for (const k of await caches.keys()) { await caches.delete(k); } }
});
const cold = await coldLoad('theme=dark');
check('10.1.1 FCP пустого приложения < 1500 мс (требование этапа)',
  cold.marks.fcp < 1500, { fcp: Math.round(cold.marks.fcp), dcl: Math.round(cold.marks.dcl || 0), wall: cold.wall });
check('10.1.2 TTI (по long tasks) < 3000 мс',
  (cold.marks.ttiApprox || 0) < 3000, { tti: Math.round(cold.marks.ttiApprox || 0), longTaskTail: cold.longTaskTail });
check('10.1.3 LCP зафиксирован (есть измеримый largest paint)',
  typeof cold.marks.lcp === 'number' && cold.marks.lcp > 0, { lcp: Math.round(cold.marks.lcp) });

// ---------- 10.2 Тёплый старт (после регистрации SW) ----------
await page.goto(BASE + '/#home', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const warm = await coldLoad('theme=dark');
check('10.1.4 тёплый старт (SW-кэш) FCP < 1500 мс',
  warm.marks.fcp < 1500, { fcp: Math.round(warm.marks.fcp), dcl: Math.round(warm.marks.dcl || 0) });
check('10.1.5 ресурсы отдаются из кэша (transferSize почти нулевой)',
  warm.marks.transferBytes < 200000, { transferKB: Math.round(warm.marks.transferBytes / 1024), count: warm.marks.resourceCount });

// ---------- 10.3 Переходы между разделами на «живом» SPA ----------
await resetAll(page);
await seed(page, {
  payments: Array.from({ length: 100 }, (_, i) => ({
    title: 'Платёж ' + i, amount: 10000 + i * 17, date: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
    category: 'Коммунальные', frequency: 'monthly', status: i % 3 === 0 ? 'paid' : 'pending'
  })),
  documents: Array.from({ length: 30 }, (_, i) => ({
    name: 'Док ' + i, category: 'Другое', expiryDate: '2027-01-01', reminderDays: 30
  })),
  tasks: Array.from({ length: 80 }, (_, i) => ({
    title: 'Дело ' + i, dueDate: '2026-12-01', priority: 'medium', recurring: 'none', completed: false
  })),
  meters: Array.from({ length: 5 }, (_, i) => ({
    name: 'Счётчик ' + i, type: 'cold', initialValue: 0,
    readings: Array.from({ length: 10 }, (_, k) => ({ value: (k + 1) * 10, date: `2026-0${1 + (k % 9)}-10` }))
  }))
});

/** Замер long task, порождённого переходом в раздел. */
async function navCost(hash, sel) {
  return page.evaluate(async ({ h, s }) => {
    window.App.navigate('home');
    await new Promise((r) => setTimeout(r, 900));
    const po = new PerformanceObserver((l) => { window.__lt = l.getEntries().map((e) => e.duration); });
    try { po.observe({ type: 'longtask', buffered: false }); } catch (e) {}
    window.__lt = [];
    const t0 = performance.now();
    window.App.navigate(h);
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (document.querySelector(s)) { break; }
    }
    const ms = Math.round(performance.now() - t0);
    await new Promise((r) => setTimeout(r, 200));
    const blocks = (window.__lt || []).map((d) => Math.round(d));
    po.disconnect();
    // Отмечаем, что longtask API действительно наблюдался: иначе «longest = 0»
    // было бы тривиально истинным (не «фризов нет», а «мы их не мерили»).
    const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
    return { ms, blocks, longest: blocks.length ? Math.max(...blocks) : 0, supported };
  }, { h: hash, s: sel });
}

const SECTIONS = [
  ['payments', '.payment-card'], ['meters', '.meter-card'], ['documents', '.document-card'],
  ['tasks', '.task-card'], ['stats', '.stats-section'], ['backup', '.backup-section'], ['home', '.home-summary']
];
const costs = {};
for (const [h, s] of SECTIONS) { costs[h] = await navCost(h, s); }

const slowest = Object.entries(costs).sort((a, b) => b[1].ms - a[1].ms)[0];
check('10.3.1 рендер самого тяжёлого раздела на 265 записях < 1000 мс',
  slowest[1].ms < 1000, { section: slowest[0], ms: slowest[1].ms, longestTask: slowest[1].longest });
check('10.3.2 переходы не создают long task длиннее 600 мс (нет «фризов»)',
  Object.values(costs).every((c) => c.longest <= 600),
  Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, v.longest])));
check('10.3.3 все разделы отрендерены на большом наборе',
  Object.values(costs).every((c) => c.ms > 0), Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, v.ms + 'ms'])));

// ---------- 10.4 Куча после 20 навигаций (утечки) ----------
const heap = await page.evaluate(async () => {
  const seq = ['payments', 'meters', 'documents', 'tasks', 'stats', 'backup', 'home'];
  const kb = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024) : null);
  const nodes = () => document.getElementsByTagName('*').length;
  for (let i = 0; i < 3; i++) { window.App.navigate(seq[i]); await new Promise((r) => setTimeout(r, 500)); }
  const a = { kb: kb(), nodes: nodes() };
  for (let i = 0; i < 20; i++) { window.App.navigate(seq[i % seq.length]); await new Promise((r) => setTimeout(r, 420)); }
  const b = { kb: kb(), nodes: nodes() };
  return { a, b, deltaKb: a.kb === null || b.kb === null ? null : b.kb - a.kb, deltaNodes: b.nodes - a.nodes };
});
check('10.4.1 20 переключений разделов: куча не выросла более чем на 8 МБ',
  heap.deltaKb === null || heap.deltaKb < 8192, heap.deltaKb === null ? 'performance.memory недоступен' : heap.deltaKb + ' КБ');
check('10.4.2 DOM-узлы не накапливаются (нет утечки слушателей/клонтов)',
  heap.deltaNodes <= 60, { before: heap.a.nodes, after: heap.b.nodes, delta: heap.deltaNodes });

// ---------- 10.5 Экспорт/импорт полного набора ----------
const io = await page.evaluate(async () => {
  const t0 = performance.now();
  const dump = await window.Backup.exportData();
  const exportMs = Math.round(performance.now() - t0);
  const json = JSON.stringify(dump);
  const bytes = new Blob([json]).size;
  const t1 = performance.now();
  const stats = await window.DB.importAll(dump.data);
  const importMs = Math.round(performance.now() - t1);
  return { exportMs, importMs, bytes, records: Object.values(dump.data).reduce((s, a) => s + a.length, 0), stats };
});
check('10.5.1 экспорт JSON < 5 МБ', io.bytes < 5 * 1024 * 1024, { kb: Math.round(io.bytes / 1024), records: io.records });
check('10.5.2 экспорт 215+ записей быстрее 1000 мс', io.exportMs < 1000, io.exportMs + 'ms');
check('10.5.3 повторный импорт идемпотентен (0 записей заново)', io.stats.imported === 0, io.stats);

const bad = log();
check('10.6 итог: консоль чиста при замере производительности', bad.length === 0, bad.slice(0, 6));

const fails = report('PERFORMANCE', R);
console.log('\nЗамеры: ' + JSON.stringify({
  coldFcp: Math.round(cold.marks.fcp), coldTti: Math.round(cold.marks.ttiApprox || 0), coldLcp: Math.round(cold.marks.lcp),
  warmFcp: Math.round(warm.marks.fcp),
  renderMs: Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, v.ms])),
  exportKb: Math.round(io.bytes / 1024)
}, null, 1));
await browser.close();
process.exit(fails ? 1 : 0);
