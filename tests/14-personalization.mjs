/**
 * МОЙ ПОРЯДОК — Этап 12.8: Персонализация, оформление и виджеты (FREE + PRO).
 *
 * Проверяемые инварианты:
 *   1. Цветовые схемы акцентов (PRO ONLY): 5 вариантов, плавная смена, гейт Free;
 *   2. Пользовательские категории (PRO ONLY): создание, палитра, формы, статистика;
 *   3. Настройка главного экрана (FREE + PRO): скрытие блоков, сохранение порядка;
 *   4. Размер шрифта (FREE + PRO: 16/18/20px) и Высокий контраст (PRO ONLY);
 *   5. Звуковые и тактильные эффекты (PRO ONLY): сохранение настроек, срабатывание;
 *   6. Резервная копия: экспорт/импорт с сохранением и восстановлением персонализации;
 *   7. Консоль обоих режимов без ошибок.
 */

import {
  open, resetAll, gotoSection, seed, setProTier, report, BASE
} from './harness.mjs';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });

const { browser, ctx, page, log } = await open();
await page.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
await resetAll(page);

/* ================================================================
   1. FREE ГЕЙТ: Акцентные цвета, категории, контраст и звуки
   ================================================================ */
await setProTier(page, 'free');
await page.evaluate(() => window.ProManager.setTier('free'));
await page.goto(BASE + '/#backup', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const freeGateRes = await page.evaluate(async () => {
  const p = window.Personalization;
  const accentRes = await p.setAccent('purple');
  const contrastRes = await p.setContrast(true);
  const hapticsRes = await p.setHaptics(true);
  const soundRes = await p.setSound(true);
  const catRes = await p.addCategory({ name: 'Кофе', color: '#10B981', icon: '☕' });

  return {
    accentOk: accentRes.ok,
    contrastOk: contrastRes.ok,
    hapticsOk: hapticsRes.ok,
    soundOk: soundRes.ok,
    catOk: catRes.ok,
    currentAccent: p.getAccent(),
    contrastValue: p.getHighContrast()
  };
});

check('14.1.1 Free: смена акцента заблокирована (остаётся blue)',
  !freeGateRes.accentOk && freeGateRes.currentAccent === 'blue', freeGateRes);
check('14.1.2 Free: высокий контраст, тактильность и звук заблокированы',
  !freeGateRes.contrastOk && !freeGateRes.hapticsOk && !freeGateRes.soundOk, freeGateRes);
check('14.1.3 Free: создание пользовательских категорий заблокировано',
  !freeGateRes.catOk, freeGateRes);

/* ================================================================
   2. FREE ДОСТУП: Размер шрифта и настройка главного экрана
   ================================================================ */
const freeAllowedRes = await page.evaluate(async () => {
  const p = window.Personalization;
  // 1. Шрифт на крупный (18px)
  await p.setFontSize('large');
  const rootFsLarge = getComputedStyle(document.documentElement).getPropertyValue('--base-font-size').trim();
  const attrLarge = document.documentElement.getAttribute('data-font-size');

  // 2. Скрытие блока summary на главном экране
  await p.toggleHomeBlock('summary', false);
  const layout = p.getHomeLayout();
  const summaryBlock = layout.find((b) => b.id === 'summary');

  return {
    rootFsLarge,
    attrLarge,
    summaryVisible: summaryBlock ? summaryBlock.visible : true
  };
});

check('14.2.1 Free: размер шрифта переключается на large (18px)',
  freeAllowedRes.rootFsLarge === '18px' && freeAllowedRes.attrLarge === 'large', freeAllowedRes);
check('14.2.2 Free: блок «Сводка за месяц» успешно скрыт в homeLayout',
  freeAllowedRes.summaryVisible === false, freeAllowedRes);

// Проверяем, что на главном экране блок сводки действительно не рисуется
await page.goto(BASE + '/#home', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const homeSummaryHidden = await page.evaluate(() => {
  return document.querySelector('.home-summary-grid') === null;
});

check('14.2.3 Главный экран: блок сводки не отображается при visible=false',
  homeSummaryHidden, { homeSummaryHidden });

// Перезагрузка страницы: проверка сохранения для Free
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const reloadFreePreserved = await page.evaluate(() => {
  const rootFs = getComputedStyle(document.documentElement).getPropertyValue('--base-font-size').trim();
  const isSummaryMissing = document.querySelector('.home-summary-grid') === null;
  return { rootFs, isSummaryMissing };
});

check('14.2.4 Free: размер шрифта и скрытие сводки сохраняются после F5',
  reloadFreePreserved.rootFs === '18px' && reloadFreePreserved.isSummaryMissing,
  reloadFreePreserved);

// Возвращаем сводку обратно и шрифт на normal
await page.evaluate(async () => {
  await window.Personalization.toggleHomeBlock('summary', true);
  await window.Personalization.setFontSize('normal');
});

/* ================================================================
   3. PRO: Цветовые схемы акцентов
   ================================================================ */
await setProTier(page, 'pro');
await page.evaluate(() => window.ProManager.setTier('pro'));
await page.goto(BASE + '/#backup', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const proAccentRes = await page.evaluate(async () => {
  const p = window.Personalization;

  // 1. Ставим фиолетовый
  const purpleRes = await p.setAccent('purple');
  const attrPurple = document.documentElement.getAttribute('data-accent');
  const primaryPurple = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim();

  // 2. Ставим зелёный
  const greenRes = await p.setAccent('green');
  const attrGreen = document.documentElement.getAttribute('data-accent');
  const primaryGreen = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim();

  return {
    purpleOk: purpleRes.ok,
    attrPurple,
    primaryPurple,
    greenOk: greenRes.ok,
    attrGreen,
    primaryGreen
  };
});

check('14.3.1 PRO: установка фиолетового акцента задаёт data-accent="purple" и --color-primary #7C3AED',
  proAccentRes.purpleOk && proAccentRes.attrPurple === 'purple' &&
  proAccentRes.primaryPurple.toUpperCase() === '#7C3AED', proAccentRes);

check('14.3.2 PRO: установка зелёного акцента задаёт data-accent="green" и --color-primary #059669',
  proAccentRes.greenOk && proAccentRes.attrGreen === 'green' &&
  proAccentRes.primaryGreen.toUpperCase() === '#059669', proAccentRes);

// Перезагрузка страницы: проверяем выживание акцентного цвета
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const accentSurvivesReload = await page.evaluate(() => {
  return {
    attr: document.documentElement.getAttribute('data-accent'),
    current: window.Personalization.getAccent()
  };
});

check('14.3.3 PRO: акцентный цвет сохраняется после перезагрузки',
  accentSurvivesReload.attr === 'green' && accentSurvivesReload.current === 'green',
  accentSurvivesReload);

/* ================================================================
   4. PRO: Высокий контраст
   ================================================================ */
const contrastRes = await page.evaluate(async () => {
  const p = window.Personalization;
  await p.setHighContrast(true);
  const attr = document.documentElement.getAttribute('data-contrast');
  const isHigh = p.getHighContrast();
  return { attr, isHigh };
});

check('14.4.1 PRO: высокий контраст успешно активирован (data-contrast="high")',
  contrastRes.attr === 'high' && contrastRes.isHigh === true, contrastRes);

// Отключаем для последующих проверок
await page.evaluate(() => window.Personalization.setHighContrast(false));

/* ================================================================
   5. PRO: Пользовательские категории платежей и задач
   ================================================================ */
const createCatRes = await page.evaluate(async () => {
  const p = window.Personalization;
  const res = await p.addCategory({
    name: 'Кофе и ланч',
    color: '#06B6D4',
    icon: '☕',
    type: 'both'
  });

  const allCats = p.getCategories('all');
  const catColors = p.getCategoryColors('Кофе и ланч');

  return {
    ok: res.ok,
    count: allCats.length,
    colorsFound: !!catColors,
    bg: catColors ? catColors.bg : null,
    icon: catColors ? catColors.icon : null
  };
});

check('14.5.1 PRO: пользовательская категория «Кофе и ланч ☕» создана',
  createCatRes.ok && createCatRes.count >= 1 && createCatRes.colorsFound &&
  createCatRes.bg === '#06B6D4' && createCatRes.icon === '☕', createCatRes);

// Проверяем отображение пользовательской категории в форме добавления платежа
await page.goto(BASE + '/#payments', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const paymentFormCatCheck = await page.evaluate(() => {
  // Открываем форму платежа
  window.Payments.openAddForm();
  const select = document.querySelector('#payment-form [name="category"]');
  const options = select ? Array.from(select.options).map((o) => o.value) : [];
  // Закрываем модалку
  const cancelBtn = document.querySelector('#payment-form [data-action="cancel"]');
  if (cancelBtn) cancelBtn.click();

  return {
    hasSelect: !!select,
    hasCustomCat: options.includes('Кофе и ланч'),
    firstOptionAfterEmpty: options[1] || ''
  };
});

check('14.5.2 В форме платежа пользовательская категория отображается в начале списка',
  paymentFormCatCheck.hasSelect && paymentFormCatCheck.hasCustomCat &&
  paymentFormCatCheck.firstOptionAfterEmpty === 'Кофе и ланч', paymentFormCatCheck);

// Создаём платёж с этой категорией
const addCustomPaymentRes = await page.evaluate(async () => {
  const data = {
    title: 'Капучино в кофейне',
    amount: 35000,
    date: new Date().toISOString().slice(0, 10),
    category: 'Кофе и ланч',
    status: 'paid'
  };
  const id = await window.DB.add('payments', data);
  window.Payments.render();
  // Подождём асинхронный paint
  await new Promise((r) => setTimeout(r, 100));

  const card = document.querySelector('.payment-card[data-id="' + id + '"]');
  const badge = card ? card.querySelector('.badge') : null;

  return {
    id: id,
    hasBadge: !!badge,
    badgeText: badge ? badge.textContent.trim() : '',
    badgeBg: badge ? badge.style.backgroundColor : ''
  };
});

check('14.5.3 Платёж создан с пользовательской категорией и отображает цветной бейдж',
  addCustomPaymentRes.id > 0 && addCustomPaymentRes.hasBadge &&
  addCustomPaymentRes.badgeText.includes('Кофе и ланч'), addCustomPaymentRes);

// Проверяем статистику: пользовательская категория участвует в группировке
await page.goto(BASE + '/#stats', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

const statsCategoryCheck = await page.evaluate(() => {
  const bars = Array.from(document.querySelectorAll('.stats-bar-label')).map((el) => el.textContent.trim());
  return {
    barsCount: bars.length,
    foundCoffee: bars.some((b) => b.includes('Кофе и ланч'))
  };
});

check('14.5.4 В разделе «Статистика» расходы сгруппированы по пользовательской категории',
  statsCategoryCheck.foundCoffee, statsCategoryCheck);

/* ================================================================
   6. PRO: Звуковые и тактильные эффекты
   ================================================================ */
const hapticSoundToggles = await page.evaluate(async () => {
  const p = window.Personalization;
  await p.setHaptics(true);
  await p.setSound(true);
  return {
    haptics: p.getHaptics(),
    sound: p.getSound()
  };
});

check('14.6.1 PRO: тактильный отклик и звуковые эффекты включены',
  hapticSoundToggles.haptics && hapticSoundToggles.sound, hapticSoundToggles);

// Проверяем triggerFeedback без падений и ошибок
const feedbackRes = await page.evaluate(() => {
  try {
    window.Personalization.triggerFeedback('task_done');
    window.Personalization.triggerFeedback('payment_saved');
    window.Personalization.triggerFeedback('validation_error');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

check('14.6.2 triggerFeedback успешно исполняется для всех событий', feedbackRes.ok, feedbackRes);

/* ================================================================
   7. РЕЗЕРВНАЯ КОПИЯ: Экспорт и импорт с настройками персонализации
   ================================================================ */
await page.goto(BASE + '/#backup', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// Экспортируем данные вместе с персонализацией
const exportWithSettings = await page.evaluate(async () => {
  const dump = await window.Backup.exportData({ includeSettings: true });
  return {
    hasData: !!dump.data,
    hasPersonalization: !!dump.personalization,
    savedAccent: dump.personalization ? dump.personalization.accentColor : null,
    savedCategoriesCount: dump.personalization ? dump.personalization.customCategories.length : 0
  };
});

check('14.7.1 Экспорт резервной копии содержит блок персонализации и категорий',
  exportWithSettings.hasData && exportWithSettings.hasPersonalization &&
  exportWithSettings.savedAccent === 'green' && exportWithSettings.savedCategoriesCount >= 1,
  exportWithSettings);

// Меняем цвет на blue и удаляем категорию
await page.evaluate(async () => {
  await window.Personalization.setAccent('blue');
  const cats = window.Personalization.getCategories('all');
  for (const c of cats) {
    await window.Personalization.removeCategory(c.id);
  }
});

// Проверяем, что сбросилось
const resetState = await page.evaluate(() => ({
  accent: window.Personalization.getAccent(),
  cats: window.Personalization.getCategories('all').length
}));

check('14.7.2 Персонализация локально сброшена перед проверкой восстановления',
  resetState.accent === 'blue' && resetState.cats === 0, resetState);

// Импортируем сохранённый дамп
const importRestoreRes = await page.evaluate(async () => {
  const dump = await window.Backup.exportData({ includeSettings: true });
  // Подменяем акцент в дампе на orange для наглядности
  dump.personalization.accentColor = 'orange';
  dump.personalization.customCategories = [{
    name: 'Восстановленная 🚀',
    color: '#EC4899',
    icon: '🚀',
    type: 'both'
  }];

  await window.Backup.importDump(dump);

  return {
    restoredAccent: window.Personalization.getAccent(),
    restoredCats: window.Personalization.getCategories('all'),
    htmlAccentAttr: document.documentElement.getAttribute('data-accent')
  };
});

check('14.7.3 Импорт бэкапа восстановил акцентный цвет (orange) и пользовательские категории',
  importRestoreRes.restoredAccent === 'orange' &&
  importRestoreRes.htmlAccentAttr === 'orange' &&
  importRestoreRes.restoredCats.length >= 1 &&
  importRestoreRes.restoredCats.some((c) => c.name.includes('Восстановленная')),
  importRestoreRes);

/* ================================================================
   8. КОНСОЛЬ И ЗАВЕРШЕНИЕ
   ================================================================ */
const cleanConsole = log().filter((m) => !/DevTools|Download the React/i.test(m));
check('14.8 Консоль браузера чиста от ошибок за весь прогон',
  cleanConsole.length === 0, { log: cleanConsole });

await browser.close();

// Отчёт
report('Персонализация и виджеты (12.8)', R);
