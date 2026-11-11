/**
 * ЭТАП 12.12 — Автотесты пакета расширения Free + PRO (ValuePack, 7 функций):
 *   1. [FREE] Калькулятор тарифов ЖКХ («Сверь с УК») в #meters
 *   2. [FREE] Готовые умные чек-листы для дома («В один клик») в #tasks
 *   3. [FREE] Пересылка / копирование показаний счётчиков в мессенджер в #meters
 *   4. [PRO]  📦 Склад вещей, гарантийных талонов и чеков («Где что лежит?») в #documents
 *   5. [PRO]  🧾 Инспектор подписок («Детектор забытых трат») в #payments и #stats
 *   6. [PRO]  🎯 Семейная цель накоплений («Копилка») в #backup и #stats
 *   7. [PRO]  🖨️ Пакетный экспорт в Excel / CSV (UTF-8 с BOM)
 */

import { open, BASE, resetAll, setProTier, report } from './harness.mjs';

const R = [];
const check = (name, pass, value = '') => R.push({ name, pass: Boolean(pass), value });

const { browser, page } = await open();

try {
  await page.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
  await resetAll(page);
  await setProTier(page, 'free');

  /* ================================================================
     1. БАЗОВАЯ ВЕРСИЯ (FREE TIER): 3 ФУНКЦИОНАЛЬНЫХ ИНСТРУМЕНТА
     ================================================================ */

  // 1.1 Калькулятор тарифов ЖКХ («Сверь с УК»)
  const tariffCheck = await page.evaluate(async () => {
    window.ValuePack.setTariffs({ cold: 60, electricity: 6.5 });
    const tariffs = window.ValuePack.getTariffs();

    const m1Id = await window.DB.add('meters', {
      name: 'Холодная вода (кухня)',
      type: 'cold',
      unit: 'м³',
      initialValue: 100
    });
    const m2Id = await window.DB.add('meters', {
      name: 'Электросчётчик',
      type: 'electricity',
      unit: 'кВт·ч',
      initialValue: 1000
    });

    await window.DB.add('meter_readings', { meterId: m1Id, value: 105, date: '2026-11-10' }); // +5 м³ * 60 = 300 ₽
    await window.DB.add('meter_readings', { meterId: m2Id, value: 1100, date: '2026-11-10' }); // +100 кВт·ч * 6.5 = 650 ₽

    const meters = await window.DB.getAll('meters');
    const readings = await window.DB.getAll('meter_readings');
    const bill = window.ValuePack.calcMetersBillSummary(meters, readings);

    return {
      coldTariff: tariffs.cold,
      elecTariff: tariffs.electricity,
      totalRub: bill.totalRub,
      itemsCount: bill.items.length
    };
  });

  check(
    '16.1.1 [FREE] Калькулятор тарифов ЖКХ считает сумму квитанции по расходу (300 + 650 = 950 ₽)',
    tariffCheck.coldTariff === 60 && tariffCheck.elecTariff === 6.5 && tariffCheck.totalRub === 950,
    `totalRub=${tariffCheck.totalRub}`
  );

  await page.goto(BASE + '/#meters', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(350);

  const metersUi = await page.evaluate(() => {
    const bar = document.querySelector('.meters-tariff-bar');
    const totalEl = document.querySelector('[data-meters-bill-total]');
    const tariffBtn = document.querySelector('[data-action="tariffs"]');
    const shareBtn = document.querySelector('[data-action="share-readings"]');
    return {
      hasBar: Boolean(bar),
      totalText: totalEl ? totalEl.textContent : '',
      hasButtons: Boolean(tariffBtn && shareBtn)
    };
  });

  check(
    '16.1.2 [FREE] В разделе #meters отображается панель расчёта по тарифам и кнопки «Тарифы ЖКХ» / «Переслать показания»',
    metersUi.hasBar && metersUi.hasButtons && metersUi.totalText.includes('950'),
    `totalText="${metersUi.totalText}"`
  );

  // 1.2 Кнопка пересылки / копирования показаний счётчиков
  const shareCheck = await page.evaluate(async () => {
    const meters = await window.DB.getAll('meters');
    const readings = await window.DB.getAll('meter_readings');
    const text = window.ValuePack.buildReadingsShareText(meters, readings);
    const res = await window.ValuePack.shareReadings(meters, readings);
    return { text, ok: res.ok };
  });

  check(
    '16.1.3 [FREE] Генерация и копирование сводки показаний для УК / мессенджеров',
    shareCheck.ok &&
      shareCheck.text.includes('Холодная вода (кухня): 105 м³ (+5 м³') &&
      shareCheck.text.includes('Итого по тарифам:'),
    `len=${shareCheck.text.length}`
  );

  // 1.3 Готовые умные чек-листы для дома («В один клик»)
  await page.goto(BASE + '/#tasks', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(350);

  const checklistRes = await page.evaluate(async () => {
    const btn = document.querySelector('[data-task-action="checklists"]');
    const templates = window.ValuePack.getChecklistTemplates();
    const applied = await window.ValuePack.applyChecklist('vacation_pack');
    const allTasks = await window.DB.getAll('tasks');
    return {
      hasButtonInDom: Boolean(btn),
      templatesCount: templates.length,
      addedCount: applied.addedCount,
      dbTasksCount: allTasks.length,
      firstTitle: allTasks[0] ? allTasks[0].title : ''
    };
  });

  check(
    '16.1.4 [FREE] Готовые умные чек-листы добавляют пачку бытовых задач в 1 клик',
    checklistRes.hasButtonInDom &&
      checklistRes.templatesCount === 4 &&
      checklistRes.addedCount === 4 &&
      checklistRes.dbTasksCount === 4,
    `added=${checklistRes.addedCount}, first="${checklistRes.firstTitle}"`
  );

  /* ================================================================
     2. PRO-ВЕРСИЯ: ГЕЙТИНГ НА FREE + РАБОТА НА PRO (4 ФУНКЦИИ)
     ================================================================ */

  const freeGateCheck = await page.evaluate(async () => {
    window.ProManager.setTier('free');
    const wRes = await window.ValuePack.addWarranty({ title: 'Тест на Free', priceRub: 10000 });
    const sRes = await window.ValuePack.addContribution(5000, 'Алексей');
    let csvBlocked = false;
    try {
      await window.ValuePack.buildCsvDump();
    } catch (e) {
      csvBlocked = true;
    }
    return {
      warrantyBlocked: wRes.ok === false,
      savingsBlocked: sRes.ok === false,
      csvBlocked
    };
  });

  check(
    '16.2.1 [PRO Gate] На бесплатном тарифе Склад гарантий, Семейная копилка и CSV-экспорт заблокированы',
    freeGateCheck.warrantyBlocked && freeGateCheck.savingsBlocked && freeGateCheck.csvBlocked,
    JSON.stringify(freeGateCheck)
  );

  // Включаем PRO
  await setProTier(page, 'pro');
  await page.evaluate(() => {
    if (window.ProManager && window.ProManager.setTier) {
      window.ProManager.setTier('pro');
    }
  });

  // 2.1 📦 Склад вещей, гарантийных талонов и чеков («Где что лежит?»)
  const warrantyProCheck = await page.evaluate(async () => {
    const res = await window.ValuePack.addWarranty({
      title: 'Стиральная машина LG AI DD',
      priceRub: 49990,
      purchaseDate: '2026-06-15',
      warrantyMonths: 24,
      storageLocation: 'Шкаф в прихожей, верхняя полка, папка с чеками'
    });
    const list = window.ValuePack.getWarranties();
    return { ok: res.ok, count: list.length, item: list[0] };
  });

  await page.goto(BASE + '/#documents', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(350);

  const warrantyDom = await page.evaluate(() => {
    const section = document.querySelector('[data-pro-feature="warranty-vault"]');
    return {
      visible: Boolean(section),
      text: section ? section.textContent : ''
    };
  });

  check(
    '16.2.2 [PRO #4] 📦 Склад гарантий и чеков сохраняет технику, считает срок гарантии и показывает где лежит чек',
    warrantyProCheck.ok &&
      warrantyProCheck.count === 1 &&
      warrantyDom.visible &&
      warrantyDom.text.includes('Стиральная машина LG AI DD') &&
      warrantyDom.text.includes('Шкаф в прихожей'),
    `expiry=${warrantyProCheck.item?.expiryDate}`
  );

  // 2.2 🧾 Инспектор подписок («Детектор забытых трат»)
  const subCheck = await page.evaluate(async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await window.DB.add('payments', {
      title: 'Яндекс Плюс Семейный',
      amount: 39900, // 399 ₽
      category: 'Подписки',
      status: 'pending',
      recurring: true,
      date: tomorrow
    });
    await window.DB.add('payments', {
      title: 'Кинотеатр Иви',
      amount: 29900, // 299 ₽
      category: 'Подписки',
      status: 'paid',
      recurring: true,
      date: tomorrow
    });

    const payments = await window.DB.getAll('payments');
    const analysis = window.ValuePack.analyzeSubscriptions(payments);
    return analysis;
  });

  await page.goto(BASE + '/#payments', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(350);

  const subDom = await page.evaluate(() => {
    const card = document.querySelector('[data-pro-feature="subscription-inspector"]');
    const yearly = document.querySelector('[data-sub-yearly]');
    return {
      visible: Boolean(card),
      yearlyText: yearly ? yearly.textContent : ''
    };
  });

  check(
    '16.2.3 [PRO #5] 🧾 Инспектор подписок считает годовую нагрузку (698 ₽/мес → 8 376 ₽/год) и предупреждает о списании',
    subCheck.count === 2 &&
      subCheck.monthlyKopecks === 69800 &&
      subCheck.yearlyKopecks === 837600 &&
      subCheck.upcomingSoon.length === 1 &&
      subDom.visible,
    `yearly=${subDom.yearlyText}`
  );

  // 2.3 🎯 Семейная цель накоплений («Копилка»)
  const savingsCheck = await page.evaluate(async () => {
    await window.ValuePack.setSavingsGoal({
      title: 'Отпуск на море всей семьёй',
      targetRub: 200000,
      currentRub: 50000
    });
    const contrib = await window.ValuePack.addContribution(25000, 'Алексей');
    return contrib;
  });

  await page.goto(BASE + '/#backup', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(350);

  const savingsDom = await page.evaluate(() => {
    const card = document.querySelector('[data-pro-feature="savings-goal"]');
    const pct = document.querySelector('[data-savings-pct]');
    return {
      visible: Boolean(card),
      pctText: pct ? pct.textContent : '',
      hasMemberChip: card ? card.textContent.includes('Алексей') : false
    };
  });

  check(
    '16.2.4 [PRO #6] 🎯 Семейная копилка учитывает взносы участников и обновляет прогресс (75 000 / 200 000 ₽ = 38%)',
    savingsCheck.ok &&
      savingsCheck.goal.currentRub === 75000 &&
      savingsDom.visible &&
      savingsDom.pctText === '38%' &&
      savingsDom.hasMemberChip,
    `pct=${savingsDom.pctText}`
  );

  // 2.4 🖨️ Пакетный экспорт в Excel / CSV (UTF-8 с BOM)
  const csvCheck = await page.evaluate(async () => {
    const dump = await window.ValuePack.buildCsvDump();
    return {
      startsWithBom: dump.csv.charCodeAt(0) === 0xFEFF,
      rowsCount: dump.rowsCount,
      hasPayments: dump.csv.includes('"Платежи";"Яндекс Плюс Семейный"'),
      hasMeters: dump.csv.includes('"Счётчики";"Холодная вода (кухня)"'),
      hasWarranties: dump.csv.includes('"Гарантии и чеки";"Стиральная машина LG AI DD"'),
      hasTasks: dump.csv.includes('"Задачи";')
    };
  });

  check(
    '16.2.5 [PRO #7] 🖨️ Пакетный экспорт в Excel (.CSV) формирует UTF-8 с BOM и включает платежи, счётчики, гарантии и задачи',
    csvCheck.startsWithBom &&
      csvCheck.rowsCount >= 9 &&
      csvCheck.hasPayments &&
      csvCheck.hasMeters &&
      csvCheck.hasWarranties &&
      csvCheck.hasTasks,
    `rows=${csvCheck.rowsCount}, bom=${csvCheck.startsWithBom}`
  );

} finally {
  await browser.close();
}

const fails = report('ЭТАП 12.12 — ТЕСТЫ BASE + PRO VALUE PACK (7 ФУНКЦИЙ)', R);
process.exit(fails ? 1 : 0);
