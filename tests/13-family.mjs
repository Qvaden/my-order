/**
 * МОЙ ПОРЯДОК — Этап 12.7: Семейный доступ (Shared Lists, PRO ONLY).
 *
 * Проверяемые инварианты:
 *   1. Free-пользователи не могут создавать семьи и вступать в них (PRO-gate);
 *   2. Создание семьи админом (Smith Family), генерация ссылки-приглашения;
 *   3. Вступление участника (User B) по ссылке в отдельном браузере;
 *   4. Eventual consistency синхронизация: общий платёж виден второму участнику;
 *   5. Обновление статуса вторым участником долетает до первого (latest wins);
 *   6. Удаление записи одним пользователем приводит к soft delete (tombstone) у другого;
 *   7. Приватность: личные задачи и документы не утекают в семейный обмен;
 *   8. Управление составом: админ может исключить участника, участник может выйти;
 *   9. В шапке #home отображается имя активной семьи;
 *  10. Консоль чистая от ошибок.
 */

import {
  open, resetAll, gotoSection, seed, setProTier, report, BASE
} from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const R = [];
const check = (name, pass, value) => R.push({ name, pass: !!pass, value });

// Очищаем тестовую папку .dev-family перед прогоном
const devFamilyDir = path.join(process.cwd(), '.dev-family');
try {
  if (fs.existsSync(devFamilyDir)) {
    fs.rmSync(devFamilyDir, { recursive: true, force: true });
  }
} catch (e) { /* ignore */ }

/* ================================================================
   1. FREE GATE: Free не может создать семью и не может вступить
   ================================================================ */
const { browser: browserA, ctx: ctxA, page: pageA, log: logA } = await open();
await pageA.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
await resetAll(pageA);

await setProTier(pageA, 'free');
await pageA.goto(BASE + '/#backup', { waitUntil: 'networkidle' });
await pageA.waitForTimeout(600);

const freeGate = await pageA.evaluate(async () => {
  const vis = (sel) => {
    const el = document.querySelector(sel);
    return Boolean(el && el.offsetParent !== null);
  };
  const createVisible = vis('[data-family-action="create"]');
  const createAttempt = await window.Family.create('Тестовая семья');
  return {
    createVisible: createVisible,
    createOk: createAttempt.ok,
    createMsg: createAttempt.message
  };
});

check('13.1.1 Free: форма создания семьи скрыта через CSS-гейт',
  !freeGate.createVisible, freeGate);
check('13.1.2 Free: вызов Family.create() блокируется в JS',
  !freeGate.createOk && /только в PRO/i.test(freeGate.createMsg), freeGate);

// Проверка Free при переходе по ссылке-приглашению
await pageA.goto(BASE + '/#family-invite?key=fake-key-12345&from=vk_999&name=Demo', { waitUntil: 'networkidle' });
await pageA.waitForTimeout(800);

const freeInvite = await pageA.evaluate(() => {
  return {
    hash: window.location.hash,
    activeFam: window.Family.isActive()
  };
});

check('13.1.3 Free: при открытии invite-ссылки редирект в #backup, семья не активирована',
  freeInvite.hash.includes('backup') && !freeInvite.activeFam, freeInvite);

/* ================================================================
   2. USER A (PRO): Создание семьи "Smith Family" и платежа
   ================================================================ */
await pageA.evaluate(() => window.ProManager.setTier('pro'));
await pageA.goto(BASE + '/#backup', { waitUntil: 'networkidle' });
await pageA.waitForTimeout(600);

const createRes = await pageA.evaluate(async () => {
  const nameInput = document.querySelector('[data-family-input="name"]');
  if (nameInput) {
    nameInput.value = 'Smith Family';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const createBtn = document.querySelector('[data-family-action="create"]');
  if (createBtn) {
    createBtn.click();
  }
  await new Promise((r) => setTimeout(r, 600));

  const fam = await window.Family.activeFamily();
  const invite = fam ? window.Family.inviteLink(fam) : '';
  const parsedInvite = invite ? window.Family.parseInviteUrl(invite) : null;
  return {
    isActive: window.Family.isActive(),
    name: window.Family.activeName(),
    isAdmin: window.Family.isAdmin(),
    sharedDataKey: fam ? fam.sharedDataKey : '',
    inviteLink: invite,
    parsedInvite: parsedInvite
  };
});

check('13.2.1 PRO: семья создана, пользователь стал админом',
  createRes.isActive && createRes.name === 'Smith Family' && createRes.isAdmin, createRes);
check('13.2.2 PRO: сформирована валидная ссылка-приглашение',
  Boolean(createRes.inviteLink && createRes.parsedInvite && createRes.parsedInvite.key === createRes.sharedDataKey),
  createRes);

// Проверяем отображение семьи в шапке #home
await pageA.goto(BASE + '/#home', { waitUntil: 'networkidle' });
await pageA.waitForTimeout(500);

const homeHeroFamily = await pageA.evaluate(() => {
  const el = document.querySelector('.home-hero__family');
  return {
    exists: !!el,
    text: el ? el.textContent.trim() : ''
  };
});

check('13.2.3 Шапка #home отображает название активной семьи с иконкой',
  homeHeroFamily.exists && homeHeroFamily.text.includes('Smith Family'), homeHeroFamily);

// Добавляем платёж "Интернет" (в категории Интернет по умолчанию familyScope='family')
const paymentAddRes = await pageA.evaluate(async () => {
  const data = {
    title: 'Интернет 500₽',
    amount: 50000,
    date: '2026-11-20',
    category: 'Интернет',
    status: 'pending'
  };
  window.Family.stampScope(data, 'payments', false);
  const id = await window.DB.add('payments', data);
  const pushRes = await window.Family.pushNow({ silent: true });
  return {
    id: id,
    scoped: data.familyScoped,
    scope: data.familyScope,
    pushOk: pushRes.ok
  };
});

check('13.2.4 Платёж категории «Интернет» помечен как семейный (familyScoped=true) и выгружен',
  paymentAddRes.id > 0 && paymentAddRes.scoped === true && paymentAddRes.scope === 'family' && paymentAddRes.pushOk,
  paymentAddRes);

/* ================================================================
   3. USER B (PRO, Browser 2): Вступление по ссылке-приглашению
   ================================================================ */
const { browser: browserB, ctx: ctxB, page: pageB, log: logB } = await open();
await pageB.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
await resetAll(pageB);
await pageB.evaluate(() => window.ProManager.setTier('pro'));

// User B открывает приглашение от User A
const inviteUrl = createRes.inviteLink;
await pageB.goto(inviteUrl, { waitUntil: 'networkidle' });
await pageB.waitForTimeout(1000);

const userBJoin = await pageB.evaluate(async () => {
  const fam = await window.Family.activeFamily();
  const payments = await window.DB.getAll('payments');
  return {
    isActive: window.Family.isActive(),
    name: window.Family.activeName(),
    isAdmin: window.Family.isAdmin(),
    role: window.Family.myRole(),
    paymentsCount: payments.length,
    paymentTitle: payments[0] ? payments[0].title : '',
    paymentStatus: payments[0] ? payments[0].status : '',
    paymentScoped: payments[0] ? payments[0].familyScoped : false
  };
});

check('13.3.1 User B успешно вступил в семью как member',
  userBJoin.isActive && userBJoin.name === 'Smith Family' && userBJoin.isAdmin === false && userBJoin.role === 'member',
  userBJoin);
check('13.3.2 User B получил платёж «Интернет 500₽» со статусом pending',
  userBJoin.paymentsCount === 1 && userBJoin.paymentTitle === 'Интернет 500₽' && userBJoin.paymentStatus === 'pending',
  userBJoin);

// Проверяем отображение иконки 👥 в списке платежей User B
await pageB.goto(BASE + '/#payments', { waitUntil: 'networkidle' });
await pageB.waitForTimeout(600);

const userBPaymentsUI = await pageB.evaluate(() => {
  const card = document.querySelector('.payment-card');
  const flag = card ? card.querySelector('.family-flag') : null;
  return {
    hasCard: !!card,
    hasFlag: !!flag,
    flagText: flag ? flag.textContent.trim() : ''
  };
});

check('13.3.3 В списке платежей User B отображается карточка со значком 👥',
  userBPaymentsUI.hasCard && userBPaymentsUI.hasFlag && userBPaymentsUI.flagText === '👥',
  userBPaymentsUI);

/* ================================================================
   4. USER B: Оплата платежа → USER A: Синхронизация и подтверждение
   ================================================================ */
const userBPayRes = await pageB.evaluate(async () => {
  const payments = await window.DB.getAll('payments');
  const p = payments[0];
  await window.DB.update('payments', p.id, { status: 'paid', updatedAt: new Date().toISOString() });
  const pushRes = await window.Family.pushNow({ silent: true });
  return { pushOk: pushRes.ok };
});

check('13.4.1 User B перевёл платёж в paid и выгрузил изменения', userBPayRes.pushOk, userBPayRes);

// User A забирает изменения
const userASyncRes = await pageA.evaluate(async () => {
  const pullRes = await window.Family.pullNow({ force: true, silent: true });
  const payments = await window.DB.getAll('payments');
  return {
    pullOk: pullRes.ok,
    status: payments[0] ? payments[0].status : null
  };
});

check('13.4.2 User A после синхронизации видит статус paid (latest wins)',
  userASyncRes.pullOk && userASyncRes.status === 'paid', userASyncRes);

/* ================================================================
   5. USER A: Удаление платежа → USER B: Soft delete (исчезновение)
   ================================================================ */
const userADeleteRes = await pageA.evaluate(async () => {
  const payments = await window.DB.getAll('payments');
  const p = payments[0];
  await window.DB.delete('payments', p.id);
  const pushRes = await window.Family.pushNow({ silent: true });
  return { pushOk: pushRes.ok };
});

check('13.5.1 User A удалил платёж и выгрузил tombstone', userADeleteRes.pushOk, userADeleteRes);

// User B забирает удаление
const userBDeleteRes = await pageB.evaluate(async () => {
  const pullRes = await window.Family.pullNow({ force: true, silent: true });
  const allInDb = await window.DB.getAll('payments');
  const activeInDb = allInDb.filter((x) => !window.FamilyUI.isHidden(x));
  return {
    pullOk: pullRes.ok,
    stats: pullRes.stats,
    allCount: allInDb.length,
    activeCount: activeInDb.length,
    isSoftDeleted: allInDb[0] ? allInDb[0].deleted === true : false
  };
});

check('13.5.2 User B после синхронизации: запись soft-deleted, в активном списке 0',
  userBDeleteRes.pullOk && userBDeleteRes.activeCount === 0 && userBDeleteRes.isSoftDeleted,
  userBDeleteRes);

/* ================================================================
   6. PRIVACY: Личные записи не утекают в семейный обмен
   ================================================================ */
const privacyRes = await pageB.evaluate(async () => {
  // User B создаёт личную задачу
  const taskData = {
    title: 'Купить подарок маме',
    completed: false,
    priority: 'medium',
    familyScope: 'personal',
    familyScoped: false
  };
  window.Family.stampScope(taskData, 'tasks', false);
  const id = await window.DB.add('tasks', taskData);
  const pushRes = await window.Family.pushNow({ silent: true });
  return { id: id, pushOk: pushRes.ok, scope: taskData.familyScope };
});

check('13.6.1 User B создал личную задачу с familyScope: personal',
  privacyRes.id > 0 && privacyRes.scope === 'personal', privacyRes);

// User A синхронизируется и проверяет задачи
const userACheckPrivacy = await pageA.evaluate(async () => {
  await window.Family.pullNow({ force: true, silent: true });
  const tasks = await window.DB.getAll('tasks');
  return {
    tasksCount: tasks.length,
    titles: tasks.map((t) => t.title)
  };
});

check('13.6.2 Личная задача User B НЕ попала к User A (приватность сохранена)',
  userACheckPrivacy.tasksCount === 0 && !userACheckPrivacy.titles.includes('Купить подарок маме'),
  userACheckPrivacy);

/* ================================================================
   7. MEMBER MANAGEMENT: Просмотр участников, выход и удаление
   ================================================================ */
const memberRowsCheck = await pageA.evaluate(() => {
  const members = window.Family.memberRows();
  return {
    count: members.length,
    adminExists: members.some((m) => m.role === 'admin' && m.isMe),
    memberExists: members.some((m) => m.role === 'member' && !m.isMe)
  };
});

check('13.7.1 Список участников семьи у админа содержит организатора и участника',
  memberRowsCheck.count === 2 && memberRowsCheck.adminExists && memberRowsCheck.memberExists,
  memberRowsCheck);

// User B покидает семью
const userBLeaveRes = await pageB.evaluate(async () => {
  const leaveRes = await window.Family.leave();
  return {
    ok: leaveRes.ok,
    isActive: window.Family.isActive()
  };
});

check('13.7.2 User B успешно покинул семью (активная семья сброшена)',
  userBLeaveRes.ok && userBLeaveRes.isActive === false, userBLeaveRes);

// User A забирает обновлённый список участников
const userASyncMembers = await pageA.evaluate(async () => {
  await window.Family.pullNow({ force: true, silent: true });
  const fam = await window.Family.activeFamily(true);
  return {
    membersCount: fam ? fam.members.length : 0
  };
});

check('13.7.3 User A после выхода участника видит обновлённый состав (1 участник)',
  userASyncMembers.membersCount === 1, userASyncMembers);

/* ================================================================
   8. КОНСОЛЬ И ЗАВЕРШЕНИЕ
   ================================================================ */
const cleanConsoleA = logA().filter((m) => !/DevTools|Download the React/i.test(m));
const cleanConsoleB = logB().filter((m) => !/DevTools|Download the React/i.test(m));

check('13.8 Консоль обоих браузеров чиста от ошибок',
  cleanConsoleA.length === 0 && cleanConsoleB.length === 0,
  { logA: cleanConsoleA, logB: cleanConsoleB });

await browserA.close();
await browserB.close();

// Отчёт
report('Семейный доступ (12.7)', R);
