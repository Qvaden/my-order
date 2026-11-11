/**
 * МОЙ ПОРЯДОК — Тестовый набор для этапа 12.10: PRO киллер-фичи без ИИ
 *
 * 1. Генератор банковских QR-кодов стандарта ГОСТ Р 56042-2014 (ST00012).
 * 2. Аудитор переплат ЖКХ и расчет сезонной экономии.
 * 3. Финансовый календарь кассовых разрывов (Cash Flow).
 */

import { open, BASE, resetAll, setProTier, report } from './harness.mjs';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });

const { browser, ctx, page, log } = await open();

try {
  await page.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
  await resetAll(page);

  /* -------------------------------------------------------------
     1. FREE GATE: Free-пользователь не видит кнопку ГОСТ QR в платежах
     ------------------------------------------------------------- */
  await setProTier(page, 'free');
  await page.goto(BASE + '/#payments', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);

  // Добавляем тестовый платёж
  await page.evaluate(async () => {
    await window.DB.clear('payments', true);
    await window.DB.add('payments', {
      title: 'Квартплата ЖКХ',
      amount: 450000,
      category: 'Коммунальные',
      frequency: 'monthly',
      status: 'pending',
      date: '2026-11-20',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    if (window.Payments && window.Payments.render) {
      window.Payments.render();
    }
  });
  await page.waitForTimeout(300);

  const freeHasGostBtn = await page.evaluate(() => {
    return Boolean(document.querySelector('[data-action="gost-qr"]'));
  });

  check('15.1.1 Free: кнопка ГОСТ QR не отображается в списке платежей', !freeHasGostBtn, { freeHasGostBtn });

  /* -------------------------------------------------------------
     2. PRO TIER: Появление ГОСТ QR кнопки и формирование валидного QR
     ------------------------------------------------------------- */
  await setProTier(page, 'pro');
  await page.evaluate(() => {
    if (window.ProManager) window.ProManager.setTier('pro');
  });
  await page.goto(BASE + '/#payments', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    if (window.Payments && window.Payments.render) window.Payments.render();
  });
  await page.waitForTimeout(300);

  const proHasGostBtn = await page.evaluate(() => {
    return Boolean(document.querySelector('[data-action="gost-qr"]'));
  });
  check('15.2.1 PRO: кнопка банковского QR ГОСТ доступна', proHasGostBtn, { proHasGostBtn });

  // Проверка генерации строки стандарта ГОСТ Р 56042-2014
  const gostPayload = await page.evaluate(() => {
    const p = { id: 42, title: 'Квартплата ЖКХ', amount: 450000 };
    return window.GostQr ? window.GostQr.buildGostPayload(p) : null;
  });

  check('15.2.2 ГОСТ QR: строка начинается со стандарта ST00012',
    Boolean(gostPayload && gostPayload.startsWith('ST00012')), { gostPayload });
  check('15.2.3 ГОСТ QR: строка содержит ИНН, БИК, р/с и сумму в копейках',
    Boolean(gostPayload && gostPayload.includes('PayeeINN=') && gostPayload.includes('BIC=') && gostPayload.includes('Sum=450000')),
    { gostPayload }
  );

  // Клик по кнопке gost-qr открывает модальное окно с SVG QR-кодом
  await page.click('[data-action="gost-qr"]');
  await page.waitForTimeout(400);

  const modalOpened = await page.evaluate(() => {
    const modal = document.querySelector('.gost-qr-modal');
    const svg = document.querySelector('.gost-qr-code-wrap svg');
    const sum = document.querySelector('.gost-qr-sum')?.textContent;
    return {
      hasModal: Boolean(modal),
      hasSvg: Boolean(svg),
      sumText: sum
    };
  });

  check('15.2.4 ГОСТ QR: модальное окно отображает QR-код и сумму',
    modalOpened.hasModal && modalOpened.hasSvg && modalOpened.sumText.includes('4500,00'),
    modalOpened
  );

  // Закрываем модальное окно
  await page.click('[data-gost-action="close"]');
  await page.waitForTimeout(200);

  /* -------------------------------------------------------------
     3. Умный аудитор ЖКХ и Cash Flow в разделе «Статистика»
     ------------------------------------------------------------- */
  // Наполняем базу счётчиками и платежами для расчёта
  await page.evaluate(async () => {
    await window.DB.clear('meters', true);
    await window.DB.clear('meter_readings', true);

    const mId = await window.DB.add('meters', {
      title: 'Холодная вода',
      type: 'cold',
      unit: 'м³',
      createdAt: new Date().toISOString()
    });

    await window.DB.add('meter_readings', {
      meterId: mId,
      value: 100,
      date: '2026-10-20'
    });
    // Аномальный скачок (+12 м3 за месяц)
    await window.DB.add('meter_readings', {
      meterId: mId,
      value: 112,
      date: '2026-11-10'
    });
  });

  await page.goto(BASE + '/#stats', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const proPlusStats = await page.evaluate(() => {
    const section = document.querySelector('.pro-analytics-plus');
    const warnItem = document.querySelector('.pro-audit-item--warn');
    const cashGrid = document.querySelector('.cashflow-grid');
    const peakWarning = document.querySelector('.pro-cashflow-warning');
    return {
      hasSection: Boolean(section),
      hasWarnItem: Boolean(warnItem),
      hasGrid: Boolean(cashGrid),
      hasPeakWarning: Boolean(peakWarning)
    };
  });

  check('15.3.1 Статистика PRO: блок Аудитора ЖКХ и Cash Flow отображается',
    proPlusStats.hasSection && proPlusStats.hasGrid,
    proPlusStats
  );
  check('15.3.2 Аудитор ЖКХ детектирует аномальный расход воды',
    proPlusStats.hasWarnItem,
    proPlusStats
  );

  /* -------------------------------------------------------------
     4. Премиум-глассморфизм и физические микро-анимации (Этап 12.11)
     ------------------------------------------------------------- */
  const fxRes = await page.evaluate(async () => {
    const hasMicroFx = Boolean(window.MicroFX && typeof window.MicroFX.burst === 'function');
    window.MicroFX.burst({ x: 180, y: 300 });
    const canvasDuring = Boolean(document.querySelector('.micro-fx-canvas'));
    await new Promise((r) => setTimeout(r, 600));
    const canvasAfter = Boolean(document.querySelector('.micro-fx-canvas'));

    const sec = document.querySelector('.stats-section');
    const cs = sec ? getComputedStyle(sec) : null;
    const blur = cs ? (cs.backdropFilter || cs.webkitBackdropFilter || '') : '';
    return {
      hasMicroFx,
      canvasDuring,
      canvasAfter,
      hasGlassBlur: /blur/.test(blur)
    };
  });

  check('15.4.1 MicroFX: салют частиц создаёт Canvas и чисто удаляет его после завершения',
    fxRes.hasMicroFx && fxRes.canvasDuring && !fxRes.canvasAfter,
    fxRes
  );
  check('15.4.2 Glassmorphism: карточки используют матовое стекло (backdrop-filter: blur)',
    fxRes.hasGlassBlur,
    fxRes
  );

  /* -------------------------------------------------------------
     5. Чистота консоли
     ------------------------------------------------------------- */
  check('15.5 Консоль чиста от ошибок за весь прогон', log().length === 0, { log: log() });

} finally {
  await browser.close();
}

// Отчёт
report('PRO киллер-фичи без ИИ (12.10)', R);
