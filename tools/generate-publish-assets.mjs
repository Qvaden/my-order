/**
 * МОЙ ПОРЯДОК — Генератор публикационных ассетов VK Mini Apps (Этап 12.9 / 12.11)
 *
 * Снимает 5 реальных скриншотов интерфейса (750x1334px) с реальными данными,
 * активным PRO-тарифом, ГОСТ QR, PRO-аналитикой, Семейным доступом и Тёмной темой с фиолетовым акцентом.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'publish');
const SHOTS_DIR = path.join(OUT_DIR, 'screenshots');

fs.mkdirSync(SHOTS_DIR, { recursive: true });

async function run() {
  console.log('--- Снятие 5 реальных скриншотов интерфейса 750x1334 ---');
  const browser = await chromium.launch({ headless: true });

  // Вьюпорт: ширина 375, высота 667, масштаб 2 = ровно 750x1334 px (стандарт iPhone 6/7/8 для VK)
  const appCtx = await browser.newContext({
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    hasTouch: true
  });
  const page = await appCtx.newPage();

  // Открываем приложение
  await page.goto('http://localhost:8080/#home', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  // Наполняем базу реалистичными данными по точным схемам БД
  await page.evaluate(async () => {
    // 1. Активируем PRO через кэш и ProManager
    localStorage.setItem('myorder_pro_cache', JSON.stringify({ tier: 'pro', at: Date.now() }));
    if (window.ProManager && typeof window.ProManager.setTier === 'function') {
      window.ProManager.setTier('pro');
    }

    // 2. Очищаем старые данные
    await window.DB.clear('payments', true);
    await window.DB.clear('meters', true);
    await window.DB.clear('meter_readings', true);
    await window.DB.clear('documents', true);
    await window.DB.clear('tasks', true);
    await window.DB.clear('families', true);

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const todayStr = `${y}-${m}-${d}`;

    const futureDate = (days) => {
      const dt = new Date(now.getTime() + days * 86400000);
      return dt.getFullYear() + '-' +
        String(dt.getMonth() + 1).padStart(2, '0') + '-' +
        String(dt.getDate()).padStart(2, '0');
    };

    const pastMonthDate = (monthsAgo, dayNum) => {
      const dt = new Date(now.getFullYear(), now.getMonth() - monthsAgo, dayNum);
      return dt.getFullYear() + '-' +
        String(dt.getMonth() + 1).padStart(2, '0') + '-' +
        String(dt.getDate()).padStart(2, '0');
    };

    // Платежи текущего месяца (суммы в копейках!)
    await window.DB.add('payments', {
      title: 'Квартплата и ЖКХ',
      amount: 485000, // 4 850 ₽
      category: 'Коммунальные',
      frequency: 'monthly',
      date: todayStr,
      status: 'pending',
      familyScope: 'family'
    });
    await window.DB.add('payments', {
      title: 'Мобильная связь (Семья)',
      amount: 120000, // 1 200 ₽
      category: 'Мобильная связь',
      frequency: 'monthly',
      date: todayStr,
      status: 'paid',
      familyScope: 'family'
    });
    await window.DB.add('payments', {
      title: 'Домашний интернет 500 Мбит',
      amount: 85000, // 850 ₽
      category: 'Интернет',
      frequency: 'monthly',
      date: todayStr,
      status: 'paid',
      familyScope: 'family'
    });
    await window.DB.add('payments', {
      title: 'Подписка VK Музыка',
      amount: 16900, // 169 ₽
      category: 'Подписки',
      frequency: 'monthly',
      date: todayStr,
      status: 'paid',
      familyScope: 'private'
    });

    // Счётчики и показания
    const coldMeter = await window.DB.add('meters', {
      name: 'Холодная вода (кухня)',
      type: 'cold',
      initialValue: 120
    });
    const elecMeter = await window.DB.add('meters', {
      name: 'Электричество Т1/Т2',
      type: 'electricity',
      initialValue: 3400
    });

    const cId = typeof coldMeter === 'object' ? coldMeter.id : coldMeter;
    const eId = typeof elecMeter === 'object' ? elecMeter.id : elecMeter;

    await window.DB.add('meter_readings', { meterId: cId, value: 128, date: pastMonthDate(2, 20) });
    await window.DB.add('meter_readings', { meterId: cId, value: 134, date: pastMonthDate(1, 20) });
    await window.DB.add('meter_readings', { meterId: cId, value: 145, date: todayStr });

    await window.DB.add('meter_readings', { meterId: eId, value: 3580, date: pastMonthDate(2, 20) });
    await window.DB.add('meter_readings', { meterId: eId, value: 3760, date: pastMonthDate(1, 20) });
    await window.DB.add('meter_readings', { meterId: eId, value: 3950, date: todayStr });

    // Документы
    await window.DB.add('documents', {
      name: 'Полис ОСАГО (Автомобиль)',
      category: 'Страховка',
      issuedDate: '2025-11-20',
      expiryDate: futureDate(9), // истекает через 9 дней
      reminderDays: 14
    });
    await window.DB.add('documents', {
      name: 'Паспорт гражданина РФ',
      category: 'Паспорт',
      issuedDate: '2020-05-14',
      expiryDate: '2035-08-20',
      reminderDays: 30
    });

    // Задачи
    await window.DB.add('tasks', {
      title: 'Передать показания воды до 25 числа',
      category: 'Коммунальные',
      priority: 'high',
      dueDate: todayStr,
      recurring: 'monthly',
      completed: false,
      familyScope: 'family'
    });
    await window.DB.add('tasks', {
      title: 'Продлить полис ОСАГО онлайн',
      category: 'Личные',
      priority: 'high',
      dueDate: futureDate(2),
      recurring: 'none',
      completed: false,
      familyScope: 'family'
    });
    await window.DB.add('tasks', {
      title: 'Оплатить домашний интернет',
      category: 'Интернет',
      priority: 'medium',
      dueDate: todayStr,
      recurring: 'monthly',
      completed: true,
      familyScope: 'family'
    });

    // Семья
    const nowIso = new Date().toISOString();
    const famRes = await window.Family.create('Семья Смирновых');
    if (famRes && famRes.family) {
      famRes.family.members = [
        { userId: famRes.family.adminUserId, name: 'Александр (Вы)', role: 'admin', joinedAt: nowIso },
        { userId: 'vk_87654321', name: 'Елена (Супруга)', role: 'member', joinedAt: nowIso },
        { userId: 'vk_55554444', name: 'Максим (Сын)', role: 'member', joinedAt: nowIso }
      ];
      await window.DB.update('families', famRes.family.id, famRes.family);
      await window.Family.activeFamily(true);
      await window.Family.pushNow({ silent: true });
    }
  });

  // Перезагружаем интерфейс для чистого старта без всплывающих тостов
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // Удаляем любые тосты, если они появились при инициализации
  const clearToasts = async () => {
    await page.evaluate(() => {
      document.querySelectorAll('.vk-toasts, .vk-toast').forEach((el) => el.remove());
    });
  };

  // Скриншот 1: Главный экран (Светлая тема, синий акцент, сводка + быстрые действия)
  console.log('Снимаем скриншот 1 (Home)...');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    if (window.Personalization) window.Personalization.setAccent('blue');
    window.location.hash = '#home';
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(700);
  await clearToasts();
  await page.screenshot({ path: path.join(SHOTS_DIR, 'screenshot-1-home.png') });
  console.log('✓ screenshot-1-home.png');

  // Скриншот 2: Платежи (с кнопками ГОСТ QR, бейджами семьи 👥 и сводкой в рублях)
  console.log('Снимаем скриншот 2 (Payments)...');
  await page.evaluate(() => {
    window.Payments.invalidate();
    window.location.hash = '#payments';
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(700);
  await clearToasts();
  await page.screenshot({ path: path.join(SHOTS_DIR, 'screenshot-2-payments.png') });
  console.log('✓ screenshot-2-payments.png');

  // Скриншот 3: Статистика и прогноз PRO (добавляем историю за 3 прошлых месяца и прокручиваем к прогнозу)
  console.log('Снимаем скриншот 3 (Stats PRO)...');
  await page.evaluate(async () => {
    const now = new Date();
    const pastMonthDate = (monthsAgo, dayNum) => {
      const dt = new Date(now.getFullYear(), now.getMonth() - monthsAgo, dayNum);
      return dt.getFullYear() + '-' +
        String(dt.getMonth() + 1).padStart(2, '0') + '-' +
        String(dt.getDate()).padStart(2, '0');
    };
    for (let ma = 1; ma <= 3; ma++) {
      await window.DB.add('payments', {
        title: 'Квартплата и ЖКХ',
        amount: (4600 + ma * 120) * 100,
        category: 'Коммунальные',
        frequency: 'monthly',
        date: pastMonthDate(ma, 15),
        status: 'paid'
      });
      await window.DB.add('payments', {
        title: 'Домашний интернет 500 Мбит',
        amount: 85000,
        category: 'Интернет',
        frequency: 'monthly',
        date: pastMonthDate(ma, 10),
        status: 'paid'
      });
      await window.DB.add('payments', {
        title: 'Мобильная связь (Семья)',
        amount: 120000,
        category: 'Мобильная связь',
        frequency: 'monthly',
        date: pastMonthDate(ma, 12),
        status: 'paid'
      });
    }
    window.location.hash = '#stats';
  });
  await page.waitForTimeout(900);
  await clearToasts();
  await page.evaluate(() => {
    const forecastEl = document.querySelector('[data-pro-only="forecast"]');
    if (forecastEl) {
      forecastEl.scrollIntoView({ behavior: 'instant', block: 'start' });
      window.scrollBy(0, -16);
    }
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'screenshot-3-stats.png') });
  console.log('✓ screenshot-3-stats.png');

  // Скриншот 4: Семейный доступ в разделе Настройки (#backup)
  console.log('Снимаем скриншот 4 (Family Access)...');
  await page.evaluate(() => {
    window.location.hash = '#backup';
  });
  await page.waitForTimeout(800);
  await clearToasts();
  await page.evaluate(() => {
    const famSection = document.querySelector('[data-backup-section="family"], .family-section, [data-family-action]')?.closest('.backup-section, .card');
    if (famSection) {
      famSection.scrollIntoView({ behavior: 'instant', block: 'start' });
      window.scrollBy(0, -16);
    }
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'screenshot-4-family.png') });
  console.log('✓ screenshot-4-family.png');

  // Скриншот 5: Тёмная тема с фиолетовым акцентом (PRO) на Главной с шапкой и сводкой
  console.log('Снимаем скриншот 5 (Dark theme + Purple accent)...');
  await page.evaluate(async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.colorScheme = 'dark';
    if (window.Personalization) {
      await window.Personalization.setAccent('purple');
    }
    window.location.hash = '#home';
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(700);
  await clearToasts();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'screenshot-5-dark-theme.png') });
  console.log('✓ screenshot-5-dark-theme.png');

  await browser.close();
  console.log('--- ВСЕ 5 СКРИНШОТОВ УСПЕШНО ОБНОВЛЕНЫ ---');
}

run().catch(err => {
  console.error('Ошибка генерации:', err);
  process.exit(1);
});
