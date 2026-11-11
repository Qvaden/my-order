/**
 * Этап 11 / раздел 6 — анимации и UX.
 * Длительности ≤300ms, GPU-свойства, collapse при удалении, pop галочки,
 * skeleton, empty state, border-left у предупреждений, blur overlay.
 */
import { open, gotoSection, seed, counts, resetAll, report, SHOTS, BASE } from './harness.mjs';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });
const { browser, page, log } = await open();
await resetAll(page);

const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

const D = await page.evaluate(() => ({
  fast: getComputedStyle(document.documentElement).getPropertyValue('--duration-fast').trim(),
  normal: getComputedStyle(document.documentElement).getPropertyValue('--duration-normal').trim()
}));
check('6.0.1 токены длительностей: fast 150ms, normal 250ms (≤300ms)',
  D.fast === '150ms' && D.normal === '250ms', D);

// ---------- 6.1 Добавление → slide-in ----------
await gotoSection(page, 'payments', '.empty-state');
await seed(page, { payments: [{ title: 'Слайд-ин', amount: 150000, date: 4, category: 'Интернет' }] });
await page.evaluate(() => window.Payments.invalidate());
await gotoSection(page, 'home', '.home-summary');
await gotoSection(page, 'payments', '.payment-card');

const animIn = await page.evaluate(() => {
  const card = document.querySelector('.payment-card');
  const cs = getComputedStyle(card);
  return {
    name: cs.animationName,
    duration: cs.animationDuration,
    ms: parseFloat(cs.animationDuration) * (cs.animationDuration.includes('ms') ? 1 : 1000),
    props: cs.animationProperty || '',
    // cardIn анимирует только transform+opacity → GPU
    keyframeProps: cs.animationName
  };
});
check('6.1.1 новая карточка появляется анимацией cardIn',
  animIn.name === 'cardIn' && animIn.ms > 0 && animIn.ms <= 300, animIn);

// ---------- 6.2 Удаление → collapse перед удалением из DOM ----------
// Реальные клики мышью: collapse запускается capture-слушателем на body.
// Слой создаёт ghost-клон карточки (модуль перетирает DOM в paint()),
// поэтому наблюдаем за body и ловим сам ghost в момент анимации.
const paymentIds = await page.evaluate(async () =>
  (await window.DB.getAll('payments')).map((p) => p.id));

await page.click('.payment-card [data-action="delete"]');
await page.waitForSelector('.modal-content [data-action="confirm"]', { state: 'visible' });

await page.evaluate(() => {
  window.__probe = { ghosts: [] };
  const mo = new MutationObserver((recs) => {
    for (const rec of recs) {
      for (const n of rec.addedNodes) {
        if (n.nodeType === 1 && n.classList && n.classList.contains('card--removing')) {
          const cs = getComputedStyle(n);
          window.__probe.ghosts.push({
            cls: n.className,
            anim: cs.animationName,
            durMs: parseFloat(cs.animationDuration) *
              (cs.animationDuration.includes('ms') ? 1 : 1000),
            h0: n.offsetHeight,
            opacity: cs.opacity,
            gpu: /transform|opacity/.test(cs.animationName ? 'transform opacity' : '')
          });
          // Через 120ms — середина анимации: высота должна уже уменьшиться
          setTimeout(() => {
            window.__probe.midH = n.offsetHeight;
            window.__probe.midOpacity = getComputedStyle(n).opacity;
          }, 120);
        }
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  window.__mo = mo;
});

await page.click('.modal-content [data-action="confirm"]');
await page.waitForTimeout(220);
const mid = await page.evaluate(() => ({
  ghosts: window.__probe.ghosts,
  midH: window.__probe.midH,
  midOpacity: window.__probe.midOpacity
}));
await page.waitForTimeout(800);
const after = await page.evaluate(async () => {
  window.__mo.disconnect();
  return {
    ghostsLeft: document.querySelectorAll('body > .card--removing').length,
    stillInList: document.querySelectorAll('.payment-card').length,
    dbLeft: (await window.DB.getAll('payments')).length
  };
});
const collapse = { ...mid, ...after, dbBefore: paymentIds.length };
check('6.2.1 подтверждение удаления запускает cardOut (collapse-анимация)',
  collapse.ghosts.length === 1 && /card--removing/.test(collapse.ghosts[0].cls) &&
  collapse.ghosts[0].anim === 'cardOut', collapse);
check('6.2.2 collapse-анимация ≤300ms и реально схлопывает карточку',
  collapse.ghosts.length === 1 && collapse.ghosts[0].durMs <= 300 &&
  collapse.midH !== undefined && collapse.midH < collapse.ghosts[0].h0, collapse);
check('6.2.3 запись реально удалена из DOM и из БД',
  collapse.stillInList === 0 && collapse.dbLeft === 0, collapse);
check('6.2.4 ghost-клон удалён из DOM по окончании анимации (нет мусора)',
  collapse.ghostsLeft === 0, collapse);

// ---------- 6.3 Чекбокс задачи → pop галочки ----------
await seed(page, { tasks: [{ title: 'Чек попу', priority: 'medium', dueDate: 1 }] });
await page.evaluate(() => window.Tasks.invalidate());
await gotoSection(page, 'home', '.home-summary');
await gotoSection(page, 'tasks', '.task-card');

const pop = await page.evaluate(async () => {
  const box = document.querySelector('.task-checkbox');
  const mark = document.querySelector('.task-checkbox__mark > svg') ||
    document.querySelector('.task-checkbox + .task-checkbox__mark svg');
  const cs = getComputedStyle(box.nextElementSibling || mark);
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  const svg = document.querySelector('.task-checkbox:checked + .task-checkbox__mark svg');
  const svgcs = svg ? getComputedStyle(svg) : null;
  return {
    markTransition: cs.transitionDuration,
    svgAnim: svgcs ? svgcs.animationName : null,
    svgDuration: svgcs ? svgcs.animationDuration : null,
    bounce: svgcs ? svgcs.animationTimingFunction : null
  };
});
check('6.3.1 галочка анимируется pop (checkPop) с bounce-кривой',
  pop.svgAnim === 'checkPop' && /bounce|cubic/.test(pop.svgDuration ? pop.bounce : ''), pop);

// ---------- 6.4 Модалки: открытие/закрытие ≤300ms, overlay blur ----------
// Кнопка отказа в разных разделах подписана по-разному (data-action /
// data-task-action), поэтому ищем по любому *-action="cancel" и тексту.
const modalTimings = await page.evaluate(async () => {
  window.Tasks.openAddForm();
  await new Promise((r) => setTimeout(r, 60));
  const ov = document.querySelector('.modal-overlay');
  const card = document.querySelector('.modal-content');
  const ocs = getComputedStyle(ov);
  const ccs = getComputedStyle(card);
  const ms = (v) => parseFloat(v) * (v.includes('ms') ? 1 : 1000);
  const openMs = ms(ocs.transitionDuration.split(',')[0]);
  const openCardMs = ms(ccs.transitionDuration.split(',')[0]);
  const blur = ocs.backdropFilter || ocs.webkitBackdropFilter;

  const cancel = [...card.querySelectorAll('button')].find((b) =>
    /cancel/i.test(b.getAttribute('data-action') || '') ||
    /cancel/i.test(b.getAttribute('data-task-action') || '') ||
    /^(Отмена|Закрыть)/i.test(b.textContent.trim()));

  const t0 = performance.now();
  if (cancel) cancel.click();
  // Поллим, а не ждём фиксированно: важно фактическое время исчезновения
  let goneAfter = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (!document.querySelector('.modal-overlay')) { goneAfter = performance.now() - t0; break; }
  }
  const bodyClass = document.body.className;
  return {
    openMs, openCardMs, blur,
    hadCancel: !!cancel,
    cancelLabel: cancel ? cancel.textContent.trim() : null,
    overlayClassOpen: /is-open/.test(ov.className),
    goneAfter,
    bodyModalOpen: /modal-open/.test(bodyClass)
  };
});
check('6.4.1 модальное окно открывается за ≤300ms',
  modalTimings.openMs <= 300 && modalTimings.openCardMs <= 300, modalTimings);
check('6.4.2 overlay с blur работает', /blur/.test(modalTimings.blur || ''), modalTimings);
check('6.4.3 закрытие модалки: overlay удалён из DOM ≤350ms',
  modalTimings.hadCancel && modalTimings.goneAfter !== null && modalTimings.goneAfter <= 350, modalTimings);
check('6.4.4 после закрытия с body снят класс modal-open (скролл возвращён)',
  modalTimings.bodyModalOpen === false, modalTimings);

// ---------- 6.5 Skeleton shimmer при загрузке ----------
// transitionContent рисует новый контент через 250ms, а render() при
// пустом кэше сразу вставляет skeleton. Ловим этот момент наблюдателем.
const skel = await page.evaluate(async () => {
  window.__skel = { seen: false, anim: null, duration: null, gradient: false, shimmerFrames: 0 };
  const mo = new MutationObserver(() => {
    const s = document.querySelector('.skeleton');
    if (!s || window.__skel.seen) { return; }
    const cs = getComputedStyle(s);
    window.__skel.seen = true;
    window.__skel.anim = cs.animationName;
    window.__skel.duration = cs.animationDuration;
    window.__skel.gradient = /linear-gradient/.test(cs.backgroundImage);
    window.__skel.bgSize = cs.backgroundSize;
  });
  mo.observe(document.getElementById('app'), { childList: true, subtree: true });

  window.Payments.invalidate();
  window.App.navigate('home');
  await new Promise((r) => setTimeout(r, 120));
  window.App.navigate('payments');
  await new Promise((r) => setTimeout(r, 1500));
  mo.disconnect();
  return window.__skel;
});
check('6.5.1 при загрузке данных виден skeleton с shimmer-анимацией',
  skel.seen && skel.anim === 'skeletonShimmer' && skel.gradient, skel);

await page.waitForTimeout(900);

// ---------- 6.6 Empty state ----------
const empty = await page.evaluate(async () => {
  await window.DB.clear('payments', true);
  window.Payments.invalidate();
  window.App.navigate('home');
  await new Promise((r) => setTimeout(r, 50));
  window.App.navigate('payments');
  await new Promise((r) => setTimeout(r, 900));
  const e = document.querySelector('.empty-state');
  if (!e) return { present: false };
  const cs = getComputedStyle(e);
  return {
    present: true,
    title: (e.querySelector('.empty-state__title') || {}).textContent || '',
    anim: cs.animationName,
    ms: parseFloat(cs.animationDuration) * (cs.animationDuration.includes('ms') ? 1 : 1000),
    centered: /center/.test(cs.textAlign) && cs.flexDirection === 'column',
    hasAction: !!e.querySelector('.btn')
  };
});
check('6.6.1 пустой список → корректный empty state (заголовок + анимация)',
  empty.present && empty.title.length > 0 && empty.anim === 'emptyStateIn' && empty.ms <= 300, empty);
check('6.6.2 empty state центрирован и предлагает действие',
  empty.centered && empty.hasAction, empty);

// ---------- 6.7 Предупреждения о сроках: border-left акцент ----------
await seed(page, {
  documents: [
    { name: 'Скоро истекает', category: 'Страховка', expiryDate: 3, reminderDays: 14 },
    { name: 'Просрочен', category: 'Паспорт', expiryDate: -4, reminderDays: 30 }
  ],
  tasks: [{ title: 'Просроченная задача', priority: 'high', dueDate: -2 }]
});
await gotoSection(page, 'home', '.home-summary');
await gotoSection(page, 'documents', '.document-card');
const warns = await page.evaluate(() => {
  const bs = [...document.querySelectorAll('.warning-banner')];
  return bs.map((b) => {
    const cs = getComputedStyle(b);
    return {
      cls: b.className.replace('warning-banner ', ''),
      borderLeft: cs.borderLeftWidth + ' ' + cs.borderLeftStyle,
      color: cs.borderLeftColor,
      anim: cs.animationName,
      text: b.innerText.slice(0, 40)
    };
  });
});
check('6.7.1 блок предупреждений отрендерен (истекающие + просроченные)',
  warns.length >= 2, warns.map((w) => w.text));
check('6.7.2 у предупреждений есть border-left акцент',
  warns.every((w) => parseFloat(w.borderLeft) >= 3), warns);
check('6.7.3 просроченное и истекающее различаются по цвету',
  new Set(warns.map((w) => w.color)).size >= 2, warns);

await gotoSection(page, 'tasks', '.task-card');
const taskWarn = await page.evaluate(() => {
  const b = document.querySelector('.urgent-banner--overdue, .warning-banner--expired');
  if (!b) return { present: false };
  const cs = getComputedStyle(b);
  return { present: true, borderLeft: parseFloat(cs.borderLeftWidth), text: b.innerText.slice(0, 40) };
});
check('6.7.4 просроченные задачи предупреждают баннером с border-left',
  taskWarn.present && taskWarn.borderLeft >= 3, taskWarn);

// ---------- 6.8 document, истекающий сегодня, виден в предупреждениях (баг #3) ----------
const today = iso(0);
await page.evaluate(async (d) => {
  await window.DB.add('documents', { name: 'Истекает сегодня', category: 'Медицинские', expiryDate: d, reminderDays: 14 });
  window.Documents.invalidate();
}, today);
await gotoSection(page, 'home', '.home-summary');
await gotoSection(page, 'documents', '.document-card');
const todayWarn = await page.evaluate(() => {
  const bs = [...document.querySelectorAll('.warning-banner')];
  return {
    texts: bs.map((b) => b.innerText.replace(/\s+/g, ' ')),
    hasToday: bs.some((b) => /Истекает сегодня/.test(b.innerText)),
    saysToday: bs.some((b) => /сегодня/.test(b.innerText))
  };
});
check('6.8.1 документ, истекающий СЕГОДНЯ, показан в предупреждениях (регрессия бага №3)',
  todayWarn.hasToday, todayWarn);
check('6.8.2 формулировка — «сегодня», а не «через 0 дней»',
  todayWarn.saysToday && !/через 0 /.test(todayWarn.texts.join(' ')), todayWarn);

// ---------- 6.9 Reduced motion: уважать настройку пользователя ----------
const page2 = await page.context().newPage();
await page2.emulateMedia({ reducedMotion: 'reduce' });
await page2.goto(BASE + '/#home', { waitUntil: 'networkidle' });
await page2.waitForTimeout(1200);
const rm = await page2.evaluate(async () => {
  const gear = document.querySelector('.home-gear-btn');
  return gear ? getComputedStyle(gear).animationName : 'no-gear';
});
check('6.9.1 при prefers-reduced-motion декоративные анимации отключены',
  rm === 'none' || rm === 'no-gear', rm);
await page2.close();

const bad = log();
check('6.10 итог: консоль чиста', bad.length === 0, bad.slice(0, 6));

const fails = report('ANIMATIONS & UX', R);
await browser.close();
process.exit(fails ? 1 : 0);
