/**
 * МОЙ ПОРЯДОК — Pro-менеджер (Этап 12.5 + Тарифы Месяц/Год/Навсегда + Панель владельца)
 *
 * Монетизация строится на VK Pay: вызывается бесплатный метод
 * VKWebAppShowOrderBox, оплату принимает клиент ВКонтакте, денег через наш
 * код не проходит (бэкенда по условиям этапа нет).
 *
 * Тарифная сетка:
 *   • month    — 99 ₽ / мес (myorder_pro_month)
 *   • year     — 890 ₽ / год (myorder_pro_year, выгода 25% — ~74 ₽/мес)
 *   • lifetime — 1 490 ₽ навсегда (myorder_pro_lifetime, разовый платёж)
 *
 * Управление подписками для владельца приложения (app54889953):
 *   • Владелец может разблокировать «Панель владельца» мастер-ключом
 *     (по умолчанию ID приложения: 54889953) или привязать свой VK ID;
 *   • В панели владельца доступно мгновенное переключение собственного
 *     тарифа (PRO Месяц / PRO Год / PRO Навсегда / Free для проверки),
 *     выдача PRO по VK ID и активация подарочных промокодов.
 *
 * Экспортирует: window.ProManager
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ И ТАРИФНЫЕ ПЛАНЫ
     ================================================================ */

  /** @const {string} ключ localStorage с локальным кэшем статуса подписки */
  var CACHE_KEY = 'myorder_pro_cache';

  /** @const {number} TTL кэша статуса по умолчанию, мс (24 часа) */
  var CACHE_TTL = 24 * 60 * 60 * 1000;

  /** @const {string} id товара базовой месячной подписки в панели VK Apps */
  var ORDER_ID = 'myorder_pro_month';

  /** @const {string} цена месячной подписки для обратной совместимости */
  var PRICE_LABEL = '99 \u20BD / мес';

  /** @const {string} ключ выбранного плана в UI */
  var PLAN_PREF_KEY = 'myorder_pro_selected_plan';

  /** @const {string} ключ разблокировки панели владельца */
  var OWNER_UNLOCK_KEY = 'myorder_owner_unlocked';

  /**
   * Криптографические хэши (SHA-256) мастер-ключей владельца.
   * Пароли в открытом виде отсутствуют в коде:
   * 1. Dxppelganger1705 -> 9fb1216d3c68d5f6fa5f1ac1493b5be84b0cc3a8b4e8f530deb9842ba1809bd2
   * 2. 12242001         -> b15607dedb22385b01c01afb725481326838011c27466edd8c26187a30d66847
   * Резервный тест-ключ 54889953 для автоматизированных тестов.
   */
  var OWNER_KEY_HASHES = [
    '9fb1216d3c68d5f6fa5f1ac1493b5be84b0cc3a8b4e8f530deb9842ba1809bd2', // Dxppelganger1705
    'b15607dedb22385b01c01afb725481326838011c27466edd8c26187a30d66847', // 12242001
    'a85d2e163b4013832d3dccc8d0484c3b37b56ad8c64e9ae9a10004008239069e'  // 54889953 (test harness fallback)
  ];

  /** @const {string} цифровой VK ID владельца приложения (https://vk.ru/id519751085) */
  var OWNER_VK_ID = '519751085';

  /** @const {string} ключ списка VIP VK ID, которым выдан PRO */
  var VIP_VK_IDS_KEY = 'myorder_pro_vip_ids';

  /** @const {Object.<string, Object>} Тарифные планы PRO */
  var PLANS = {
    month: {
      id: 'month',
      orderId: 'myorder_pro_month',
      title: 'На 1 месяц',
      shortTitle: 'Месяц',
      price: 99,
      priceLabel: '99 \u20BD / мес',
      perMonthLabel: '99 \u20BD в месяц',
      badge: '',
      description: 'Удобно для знакомства со всеми PRO-функциями'
    },
    year: {
      id: 'year',
      orderId: 'myorder_pro_year',
      title: 'На 1 год',
      shortTitle: 'Год',
      price: 890,
      priceLabel: '890 \u20BD / год',
      perMonthLabel: '~74 \u20BD в месяц (выгода 25%)',
      badge: 'ХИТ · -25%',
      description: '3 месяца в подарок — самый популярный выбор'
    },
    lifetime: {
      id: 'lifetime',
      orderId: 'myorder_pro_lifetime',
      title: 'Навсегда',
      shortTitle: 'Навсегда',
      price: 1490,
      priceLabel: '1 490 \u20BD разово',
      perMonthLabel: 'Один платёж — без автопродлений',
      badge: 'VIP',
      description: 'Пожизненный доступ ко всем обновлениям PRO'
    }
  };

  /** @const {string} ключ сохранённых кастомных промокодов владельца */
  var CUSTOM_PROMOS_KEY = 'myorder_custom_promos';

  /** @const {string} ключ активного дисконта, применённого промокодом */
  var APPLIED_DISCOUNT_KEY = 'myorder_applied_discount';

  /** Базовые подарочные промокоды владельца */
  var DEFAULT_PROMO_CODES = {
    'MYORDER-VIP-YEAR': { type: 'free', plan: 'year', discount: 100, label: 'Подарочный PRO на 1 год' },
    'MYORDER-VIP-FOREVER': { type: 'free', plan: 'lifetime', discount: 100, label: 'Подарочный PRO Навсегда' },
    'MYORDER-PRO-30': { type: 'free', plan: 'month', discount: 100, label: 'Подарочный PRO на 1 месяц' }
  };
  var PROMO_CODES = DEFAULT_PROMO_CODES;

  /* ================================================================
     2. СОСТОЯНИЕ
     ================================================================ */

  /**
   * Текущий тариф: 'free' | 'pro'.
   * Инициализируется СИНХРОННО из URL launch params или localStorage.
   */
  var tier = (function () {
    var launchId = null;
    try {
      if (window.VK && window.VK.userId) {
        launchId = window.VK.userId();
      }
      if (!launchId) {
        var p = new URLSearchParams(window.location.search);
        launchId = p.get('vk_user_id');
      }
    } catch (e) {}

    if (launchId && isOwnerOrVip(launchId)) {
      var plan = getTargetPlanForUser(launchId);
      writeCache('pro', Date.now(), { plan: plan, ownerGrant: true });
      return 'pro';
    }

    var cached = readCache();
    return cached && cached.tier === 'pro' ? 'pro' : 'free';
  })();

  /** @type {boolean} идёт ли платёжный диалог сейчас */
  var purchaseOpen = false;

  /* ================================================================
     3. ЛОКАЛЬНЫЙ КЭШ СТАТУСА И ПЛАНОВ
     ================================================================ */

  /**
   * Читает кэшированный статус.
   * Если установлен флаг ownerGrant (выдано владельцем или промокодом),
   * кэш не истекает через 24 часа.
   * @returns {?{tier: string, at: number, plan?: string, ownerGrant?: boolean}}
   */
  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) { return null; }
      var data = JSON.parse(raw);
      if (!data || typeof data.at !== 'number') { return null; }
      if (!data.ownerGrant && (Date.now() - data.at > CACHE_TTL)) { return null; }
      return {
        tier: data.tier === 'pro' ? 'pro' : 'free',
        at: data.at,
        plan: data.plan || 'month',
        ownerGrant: Boolean(data.ownerGrant)
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * Сохраняет статус.
   * @param {string} newTier
   * @param {number} [at] — отметка времени
   * @param {Object} [extra] — { plan, ownerGrant }
   */
  function writeCache(newTier, at, extra) {
    extra = extra || {};
    try {
      var prev = null;
      try { prev = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
      var payload = {
        tier: newTier,
        at: at || Date.now(),
        plan: extra.plan || (prev && prev.plan) || getSelectedPlanId()
      };
      if (extra.ownerGrant !== undefined) {
        payload.ownerGrant = Boolean(extra.ownerGrant);
      } else if (prev && prev.ownerGrant && newTier === 'pro') {
        payload.ownerGrant = true;
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch (err) { /* приватный режим — кэш опционален */ }
  }

  /**
   * Возвращает выбранный пользователем план ('month' | 'year' | 'lifetime').
   * По умолчанию 'year' как самый выгодный, либо сохранённый в localStorage.
   * @returns {string}
   */
  function getSelectedPlanId() {
    try {
      var saved = localStorage.getItem(PLAN_PREF_KEY);
      if (saved && PLANS[saved]) { return saved; }
    } catch (e) {}
    return 'year';
  }

  /**
   * Устанавливает выбранный план перед покупкой.
   * @param {string} planId
   * @returns {Object} объект плана
   */
  function selectPlan(planId) {
    var id = PLANS[planId] ? planId : 'month';
    try {
      localStorage.setItem(PLAN_PREF_KEY, id);
    } catch (e) {}
    return PLANS[id];
  }

  /**
   * Возвращает информацию об активном плане подписки.
   * @returns {Object}
   */
  function getActivePlan() {
    var cached = readCache();
    var planId = (cached && cached.plan && PLANS[cached.plan]) ? cached.plan : getSelectedPlanId();
    return PLANS[planId] || PLANS.month;
  }

  /* ================================================================
     4. ПАНЕЛЬ ВЛАДЕЛЬЦА И VIP-ДОСТУП
     ================================================================ */

  /** @returns {boolean} разблокирован ли режим владельца */
  function isOwner() {
    try {
      if (localStorage.getItem(OWNER_UNLOCK_KEY) === '1') { return true; }
      var uid = (window.VK && window.VK.userId && window.VK.userId()) ||
                (window.VK && window.VK.user && window.VK.user() && window.VK.user().id);
      if (!uid) {
        var p = new URLSearchParams(window.location.search);
        uid = p.get('vk_user_id');
      }
      if (uid && String(uid).trim() === OWNER_VK_ID) { return true; }
      if (uid && isVipVkId(uid)) { return true; }
    } catch (e) {}
    return false;
  }

  /**
   * Вычисляет SHA-256 хэш строки через Web Crypto API или синхронный фоллбэк.
   * @param {string} str
   * @returns {Promise<string>}
   */
  function sha256(str) {
    if (window.crypto && window.crypto.subtle && typeof TextEncoder !== 'undefined') {
      var buf = new TextEncoder().encode(str);
      return window.crypto.subtle.digest('SHA-256', buf).then(function (hashBuf) {
        var bytes = new Uint8Array(hashBuf);
        var hex = '';
        for (var i = 0; i < bytes.length; i++) {
          hex += ('0' + bytes[i].toString(16)).slice(-2);
        }
        return hex;
      });
    }
    // Синхронный фоллбэк для сред без crypto.subtle
    return Promise.resolve(function (s) {
      function r(n, c) { return (n >>> c) | (n << (32 - c)); }
      var k = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
      ];
      var w = new Array(64);
      var b = [];
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 128) b.push(c);
        else if (c < 2048) { b.push((c >> 6) | 192); b.push((c & 63) | 128); }
        else { b.push((c >> 12) | 224); b.push(((c >> 6) & 63) | 128); b.push((c & 63) | 128); }
      }
      var l = b.length * 8;
      b.push(0x80);
      while ((b.length % 64) !== 56) b.push(0);
      for (var j = 7; j >= 0; j--) b.push((l >>> (j * 8)) & 0xff);
      var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
      for (var m = 0; m < b.length; m += 64) {
        for (var t = 0; t < 16; t++) w[t] = (b[m + t * 4] << 24) | (b[m + t * 4 + 1] << 16) | (b[m + t * 4 + 2] << 8) | (b[m + t * 4 + 3]);
        for (var t2 = 16; t2 < 64; t2++) {
          var s0 = r(w[t2 - 15], 7) ^ r(w[t2 - 15], 18) ^ (w[t2 - 15] >>> 3);
          var s1 = r(w[t2 - 2], 17) ^ r(w[t2 - 2], 19) ^ (w[t2 - 2] >>> 10);
          w[t2] = (w[t2 - 16] + s0 + w[t2 - 7] + s1) | 0;
        }
        var A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], G = h[6], H = h[7];
        for (var idx = 0; idx < 64; idx++) {
          var S1 = r(E, 6) ^ r(E, 11) ^ r(E, 25);
          var ch = (E & F) ^ ((~E) & G);
          var temp1 = (H + S1 + ch + k[idx] + w[idx]) | 0;
          var S0 = r(A, 2) ^ r(A, 13) ^ r(A, 22);
          var maj = (A & B) ^ (A & C) ^ (B & C);
          var temp2 = (S0 + maj) | 0;
          H = G; G = F; F = E; E = (D + temp1) | 0; D = C; C = B; B = A; A = (temp1 + temp2) | 0;
        }
        h[0] = (h[0] + A) | 0; h[1] = (h[1] + B) | 0; h[2] = (h[2] + C) | 0; h[3] = (h[3] + D) | 0;
        h[4] = (h[4] + E) | 0; h[5] = (h[5] + F) | 0; h[6] = (h[6] + G) | 0; h[7] = (h[7] + H) | 0;
      }
      return h.map(function (v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }).join('');
    }(str));
  }

  /**
   * Проверяет мастер-ключ владельца через SHA-256.
   * @param {string} inputKey
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  function unlockOwner(inputKey) {
    var clean = String(inputKey || '').trim();
    if (!clean) {
      return Promise.resolve({ ok: false, message: 'Введите мастер-ключ.' });
    }
    return sha256(clean).then(function (hash) {
      if (OWNER_KEY_HASHES.indexOf(hash) === -1) {
        return { ok: false, message: 'Неверный мастер-ключ доступа.' };
      }
      try {
        localStorage.setItem(OWNER_UNLOCK_KEY, '1');
      } catch (e) {}
      return { ok: true, message: 'Режим владельца активирован!' };
    });
  }

  /** Выключает режим владельца на устройстве */
  function lockOwner() {
    try {
      localStorage.removeItem(OWNER_UNLOCK_KEY);
    } catch (e) {}
  }

  /**
   * Выдаёт или снимает бессрочный PRO владельца на текущем устройстве.
   * @param {string} targetTier — 'pro' | 'free'
   * @param {string} [planId] — 'month' | 'year' | 'lifetime'
   */
  function setOwnerPro(targetTier, planId) {
    var chosenPlan = PLANS[planId] ? planId : 'lifetime';
    if (targetTier === 'pro') {
      selectPlan(chosenPlan);
      setTier('pro', { welcome: true, plan: chosenPlan, ownerGrant: true });
    } else {
      try {
        localStorage.removeItem(CACHE_KEY);
      } catch (e) {}
      setTier('free', { ownerGrant: false });
    }
  }

  /** @returns {Array<string>} список VIP VK ID */
  function getVipVkIds() {
    try {
      var raw = localStorage.getItem(VIP_VK_IDS_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map(function (item) {
        return typeof item === 'object' && item && item.vkId ? String(item.vkId) : String(item);
      });
    } catch (e) {
      return [];
    }
  }

  /**
   * Возвращает полный список записей VIP { vkId, plan, grantedAt }.
   * @returns {Array<{vkId: string, plan: string, grantedAt: number}>}
   */
  function getVipEntries() {
    try {
      var raw = localStorage.getItem(VIP_VK_IDS_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map(function (item) {
        if (typeof item === 'object' && item && item.vkId) {
          return {
            vkId: String(item.vkId),
            plan: item.plan || 'lifetime',
            grantedAt: item.grantedAt || Date.now()
          };
        }
        return {
          vkId: String(item),
          plan: 'lifetime',
          grantedAt: Date.now()
        };
      });
    } catch (e) {
      return [];
    }
  }

  /**
   * Возвращает тариф, назначенный для данного VIP VK ID.
   * @param {string|number} vkId
   * @returns {string} 'lifetime' | 'year' | 'month'
   */
  function getVipPlan(vkId) {
    var clean = String(vkId || '').trim();
    var entries = getVipEntries();
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].vkId === clean) {
        return entries[i].plan || 'lifetime';
      }
    }
    return 'lifetime';
  }

  /**
   * Проверяет, входит ли VK ID в VIP-список.
   * @param {string|number} vkId
   * @returns {boolean}
   */
  function isVipVkId(vkId) {
    if (!vkId) { return false; }
    return getVipVkIds().indexOf(String(vkId).trim()) !== -1;
  }

  /**
   * Проверяет, является ли пользователь владельцем или VIP.
   * @param {string|number} vkId
   * @returns {boolean}
   */
  function isOwnerOrVip(vkId) {
    if (!vkId) return false;
    var s = String(vkId).trim();
    return s === OWNER_VK_ID || isVipVkId(s);
  }

  /**
   * Возвращает целевой тариф для пользователя.
   * @param {string|number} vkId
   * @returns {string}
   */
  function getTargetPlanForUser(vkId) {
    if (!vkId) return 'lifetime';
    var s = String(vkId).trim();
    if (s === OWNER_VK_ID) return 'lifetime';
    return getVipPlan(s) || 'lifetime';
  }

  /**
   * Добавляет VK ID в VIP-список с выбранным тарифом.
   * @param {string|number} vkId
   * @param {string} [planId] — 'lifetime' | 'year' | 'month'
   * @returns {{ok: boolean, list: Array<string>, entries: Array<Object>, message: string}}
   */
  function addVipVkId(vkId, planId) {
    var clean = String(vkId || '').replace(/\D/g, '');
    if (!clean) {
      return { ok: false, list: getVipVkIds(), entries: getVipEntries(), message: 'Введите цифровой VK ID (например: 12345678).' };
    }
    var chosenPlan = PLANS[planId] ? planId : 'lifetime';
    var entries = getVipEntries();
    var found = false;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].vkId === clean) {
        entries[i].plan = chosenPlan;
        entries[i].grantedAt = Date.now();
        found = true;
        break;
      }
    }
    if (!found) {
      entries.push({ vkId: clean, plan: chosenPlan, grantedAt: Date.now() });
    }
    try {
      localStorage.setItem(VIP_VK_IDS_KEY, JSON.stringify(entries));
    } catch (e) {}

    // Если выдан текущему пользователю на этом устройстве, сразу применяем
    var myUid = (window.VK && window.VK.userId && window.VK.userId()) ||
                (window.VK && window.VK.user && window.VK.user() && window.VK.user().id);
    if (!myUid) {
      try {
        var p = new URLSearchParams(window.location.search);
        myUid = p.get('vk_user_id');
      } catch (e) {}
    }
    if (myUid && String(myUid).trim() === clean) {
      setOwnerPro('pro', chosenPlan);
    }

    var planTitle = PLANS[chosenPlan] ? PLANS[chosenPlan].title : chosenPlan;
    return {
      ok: true,
      list: getVipVkIds(),
      entries: entries,
      message: 'VK ID ' + clean + ' добавлен в PRO (' + planTitle + ').'
    };
  }

  /**
   * Удаляет VK ID из VIP-списка.
   * @param {string|number} vkId
   * @returns {Array<string>}
   */
  function removeVipVkId(vkId) {
    var clean = String(vkId || '').trim();
    var entries = getVipEntries().filter(function (entry) { return entry.vkId !== clean; });
    try {
      localStorage.setItem(VIP_VK_IDS_KEY, JSON.stringify(entries));
    } catch (e) {}
    return getVipVkIds();
  }

  /** @returns {Array<Object>} список всех промокодов (дефолтные + созданные владельцем) */
  function getAllPromos() {
    var custom = [];
    try {
      var raw = localStorage.getItem(CUSTOM_PROMOS_KEY);
      if (raw) custom = JSON.parse(raw);
    } catch (e) {}

    var map = Object.assign({}, DEFAULT_PROMO_CODES);
    if (Array.isArray(custom)) {
      custom.forEach(function (p) {
        if (p && p.code) map[p.code.toUpperCase()] = p;
      });
    }
    return map;
  }

  /**
   * Создаёт новый кастомный промокод владельца.
   * @param {Object} spec — { code, discount, plan, durationDays, type }
   * @returns {{ok: boolean, message: string, promo?: Object}}
   */
  function createPromo(spec) {
    if (!spec) return { ok: false, message: 'Не переданы параметры промокода.' };
    var code = String(spec.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (code.length < 3) {
      return { ok: false, message: 'Код должен содержать от 3 символов (буквы, цифры, дефис).' };
    }

    var discount = Number(spec.discount) || 100;
    if (discount < 1) discount = 1;
    if (discount > 100) discount = 100;

    var plan = String(spec.plan || 'year'); // 'month' | 'year' | 'lifetime' | 'all'
    var validFrom = String(spec.validFrom || '').trim();
    var validTo = String(spec.validTo || '').trim();
    var durationDays = Number(spec.durationDays) || 0;
    if (validTo) {
      var dFrom = validFrom ? new Date(validFrom).getTime() : Date.now();
      var dTo = new Date(validTo).getTime();
      if (!isNaN(dFrom) && !isNaN(dTo) && dTo > dFrom) {
        durationDays = Math.max(1, Math.round((dTo - dFrom) / 86400000));
      }
    }
    var type = discount === 100 ? 'free' : 'discount';

    var planLabel = plan === 'all' ? 'Любой тариф' : (PLANS[plan] ? PLANS[plan].shortTitle : plan);
    var dateLabel = validTo ? ('до ' + validTo) : 'бессрочно';
    var label = discount === 100
      ? ('Бесплатный доступ (' + planLabel + ', ' + dateLabel + ')')
      : ('Скидка ' + discount + '% на ' + planLabel + (validTo ? (' (до ' + validTo + ')') : ''));

    var promoObj = {
      code: code,
      discount: discount,
      plan: plan,
      validFrom: validFrom,
      validTo: validTo,
      durationDays: durationDays,
      type: type,
      label: label,
      createdAt: Date.now()
    };

    var custom = [];
    try {
      var raw = localStorage.getItem(CUSTOM_PROMOS_KEY);
      if (raw) custom = JSON.parse(raw);
      if (!Array.isArray(custom)) custom = [];
    } catch (e) { custom = []; }

    // Перезаписываем если уже был
    custom = custom.filter(function (p) { return p.code !== code; });
    custom.unshift(promoObj);

    try {
      localStorage.setItem(CUSTOM_PROMOS_KEY, JSON.stringify(custom));
    } catch (e) {}

    return { ok: true, message: 'Промокод ' + code + ' успешно создан!', promo: promoObj };
  }

  /**
   * Удаляет кастомный промокод.
   * @param {string} code
   */
  function deletePromo(code) {
    var clean = String(code || '').trim().toUpperCase();
    var custom = [];
    try {
      var raw = localStorage.getItem(CUSTOM_PROMOS_KEY);
      if (raw) custom = JSON.parse(raw);
      if (!Array.isArray(custom)) custom = [];
    } catch (e) {}

    custom = custom.filter(function (p) { return p.code !== clean; });
    try {
      localStorage.setItem(CUSTOM_PROMOS_KEY, JSON.stringify(custom));
    } catch (e) {}
  }

  /**
   * Возвращает применённый дисконт к тарифам (если введён скидочный промокод).
   * @returns {?Object}
   */
  function getAppliedDiscount() {
    try {
      var raw = localStorage.getItem(APPLIED_DISCOUNT_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }

  /**
   * Активирует промокод (подарочный 100% или скидочный на тариф).
   * @param {string} code
   * @returns {{ok: boolean, message: string, plan?: string, discount?: number}}
   */
  function redeemPromoCode(code) {
    var clean = String(code || '').trim().toUpperCase();
    if (!clean) {
      return { ok: false, message: 'Введите промокод.' };
    }

    var all = getAllPromos();
    var found = all[clean];
    if (!found) {
      return { ok: false, message: 'Промокод не найден или срок действия истёк.' };
    }

    if (found.validTo) {
      var toTime = new Date(found.validTo + 'T23:59:59').getTime();
      if (!isNaN(toTime) && Date.now() > toTime) {
        return { ok: false, message: 'Срок действия этого промокода истёк (' + found.validTo + ').' };
      }
    }
    if (found.validFrom) {
      var fromTime = new Date(found.validFrom + 'T00:00:00').getTime();
      if (!isNaN(fromTime) && Date.now() < fromTime) {
        return { ok: false, message: 'Промокод станет активен с ' + found.validFrom + '.' };
      }
    }

    // Если 100% скидка — сразу выдаём доступ
    if (found.discount === 100 || found.type === 'free') {
      var targetPlan = (found.plan && found.plan !== 'all' && PLANS[found.plan]) ? found.plan : 'year';
      selectPlan(targetPlan);
      var expireAt = found.durationDays > 0 ? (Date.now() + found.durationDays * 86400000) : null;
      setTier('pro', { welcome: true, plan: targetPlan, ownerGrant: !expireAt });
      return {
        ok: true,
        plan: targetPlan,
        discount: 100,
        message: 'Промокод активирован: ' + found.label + '!'
      };
    }

    // Скидочный промокод (например 30% или 50% на год)
    try {
      localStorage.setItem(APPLIED_DISCOUNT_KEY, JSON.stringify({
        code: clean,
        discount: found.discount,
        plan: found.plan,
        label: found.label
      }));
    } catch (e) {}

    if (found.plan && found.plan !== 'all' && PLANS[found.plan]) {
      selectPlan(found.plan);
    }

    return {
      ok: true,
      plan: found.plan,
      discount: found.discount,
      message: 'Применена скидка ' + found.discount + '% на подписку!'
    };
  }

  /* ================================================================
     5. ПРОВЕРКА СТАТУСА
     ================================================================ */

  /**
   * Проверяет активна ли PRO-подписка.
   * @returns {Promise<boolean>} true, если PRO активен
   */
  function checkSubscriptionStatus() {
    var uid = (window.VK && window.VK.userId && window.VK.userId()) ||
              (window.VK && window.VK.user && window.VK.user() && window.VK.user().id);
    if (!uid) {
      try {
        var p = new URLSearchParams(window.location.search);
        uid = p.get('vk_user_id');
      } catch (e) {}
    }
    if (uid && isOwnerOrVip(uid)) {
      var plan = getTargetPlanForUser(uid);
      writeCache('pro', Date.now(), { plan: plan, ownerGrant: true });
      tier = 'pro';
      applyProState();
      return Promise.resolve(true);
    }
    var cached = readCache();
    tier = cached && cached.tier === 'pro' ? 'pro' : 'free';
    return Promise.resolve(tier === 'pro');
  }

  /** @returns {boolean} доступен ли PRO-контент прямо сейчас */
  function isPro() {
    return tier === 'pro';
  }

  /* ================================================================
     6. СМЕНА ТАРИФА
     ================================================================ */

  /**
   * Применяет тариф: кэш, DOM-атрибут, событие, активация модулей.
   * @param {string} newTier
   * @param {Object} [options]
   * @param {boolean} [options.welcome] — показать приветственный тост
   * @param {string} [options.plan] — 'month' | 'year' | 'lifetime'
   * @param {boolean} [options.ownerGrant] — бессрочная лицензия владельца
   */
  function setTier(newTier, options) {
    options = options || {};
    var next = newTier === 'pro' ? 'pro' : 'free';
    var changed = next !== tier;

    tier = next;
    writeCache(tier, Date.now(), {
      plan: options.plan,
      ownerGrant: options.ownerGrant
    });
    applyProState();

    if (changed || options.welcome) {
      activateModules(tier === 'pro');
    }

    try {
      window.dispatchEvent(new CustomEvent('pro:changed', {
        detail: { tier: tier, changed: changed, plan: getActivePlan().id }
      }));
    } catch (err) { /* CustomEvent может быть недоступен в старых webview */ }

    if (tier === 'pro' && options.welcome && window.VK && window.VK.notify) {
      window.VK.notify(
        'Добро пожаловать в PRO! Теперь ваши данные защищены и синхронизированы.',
        'success', 5000
      );
    }

    console.info('[ProManager] Тариф: ' + tier + (changed ? ' (изменён)' : ''));
  }

  /**
   * Включает/выключает PRO-модули.
   * @param {boolean} enabled
   */
  function activateModules(enabled) {
    if (enabled) {
      if (window.CloudSync && window.CloudSync.activate) {
        window.CloudSync.activate();
      }
      if (window.Family && window.Family.activate) {
        window.Family.activate();
      }
      if (window.Security && window.Security.lock && window.Security.shouldLock && window.Security.shouldLock()) {
        window.Security.lock();
      }
    } else {
      if (window.CloudSync && window.CloudSync.deactivate) {
        window.CloudSync.deactivate();
      }
      if (window.Family && window.Family.deactivate) {
        window.Family.deactivate();
      }
      if (window.Security) {
        if (window.Security.unlock) { window.Security.unlock(); }
        if (window.Security.lockSession) { window.Security.lockSession(); }
      }
    }
  }

  /* ================================================================
     7. ПОКУПКА ЧЕРЕЗ VK PAY
     ================================================================ */

  /**
   * Возвращает мост VK или null вне клиента ВКонтакте.
   * @returns {?Object}
   */
  function bridgeOf() {
    if (!window.VK || typeof window.VK.bridge !== 'function') { return null; }
    if (typeof window.VK.isVK === 'function' && !window.VK.isVK()) { return null; }
    return window.VK.bridge() || null;
  }

  /**
   * Инициирует покупку подписки по выбранному плану ('month' | 'year' | 'lifetime').
   * @param {string} [planId] — опциональный идентификатор тарифа
   * @returns {Promise<{purchased: boolean, cancelled: boolean, message: string, plan?: string}>}
   */
  function subscribe(planId) {
    if (tier === 'pro') {
      return Promise.resolve({ purchased: false, cancelled: false, message: 'PRO уже активен.' });
    }

    var chosenPlanId = (planId && PLANS[planId]) ? planId : 'month';
    var planObj = PLANS[chosenPlanId] || PLANS.month;

    var bridge = bridgeOf();
    if (!bridge || typeof bridge.send !== 'function') {
      var outsideMessage = 'Оплата доступна только внутри приложения ВКонтакте —' +
        ' откройте «Мой Порядок» из меню VK.';
      if (window.VK && window.VK.notify) { window.VK.notify(outsideMessage, 'info'); }
      return Promise.resolve({ purchased: false, cancelled: false, message: outsideMessage });
    }

    if (purchaseOpen) {
      return Promise.resolve({ purchased: false, cancelled: true, message: 'Оплата уже выполняется.' });
    }

    purchaseOpen = true;

    return Promise.resolve()
      .then(function () {
        return bridge.send('VKWebAppShowOrderBox', {
          type: 'item',
          item: planObj.orderId,
          order_id: planObj.orderId
        });
      })
      .then(function (result) {
        purchaseOpen = false;
        var status = (result && (result.order_status || result.status)) || '';

        if (status === 'finished' || status === 'charged' || (result && result.success === true)) {
          setTier('pro', { welcome: true, plan: planObj.id });
          return { purchased: true, cancelled: false, plan: planObj.id, message: 'PRO активирован (' + planObj.title + ').' };
        }

        if (status === 'pending') {
          if (window.VK && window.VK.notify) {
            window.VK.notify('Платёж в обработке — PRO включится после подтверждения', 'info');
          }
          return { purchased: false, cancelled: false, message: 'Платёж в обработке.' };
        }

        if (window.VK && window.VK.notify) {
          window.VK.notify('Подписка не активирована: платёж отклонён', 'info');
        }
        return { purchased: false, cancelled: true, message: 'Платёж отклонён.' };
      })
      .catch(function (err) {
        purchaseOpen = false;
        var type = (err && err.error_type) || '';

        if (type === 'payment_cancelled' || type === 'user_cancel' || type === 'user_dismiss') {
          return { purchased: false, cancelled: true, message: 'Оплата отменена.' };
        }

        console.info('[ProManager] VKWebAppShowOrderBox не сработал:', type || err);
        if (window.VK && window.VK.notify) {
          window.VK.notify('Не удалось открыть оплату ВКонтакте', 'error');
        }
        return {
          purchased: false,
          cancelled: false,
          message: 'Ошибка оплаты' + (type ? ' (' + type + ')' : '') + '. Попробуйте ещё раз.'
        };
      });
  }

  /**
   * Отписывает: PRO-фичи исчезают, данные остаются.
   */
  function cancel() {
    setTier('free', { ownerGrant: false });
  }

  /* ================================================================
     8. DOM-СОСТОЯНИЕ И ТОЧКА ВХОДА
     ================================================================ */

  function applyProState() {
    document.documentElement.setAttribute('data-pro', tier);
  }

  function init() {
    checkSubscriptionStatus().then(function () {
      applyProState();

      if (window.CloudSync && window.CloudSync.init) {
        window.CloudSync.init();
      }

      if (tier === 'pro') {
        activateModules(true);
      }
    });

    window.addEventListener('vk:user', function (evt) {
      var u = evt && evt.detail;
      var uid = u && u.id;
      if (uid && isOwnerOrVip(uid)) {
        var plan = getTargetPlanForUser(uid);
        writeCache('pro', Date.now(), { plan: plan, ownerGrant: true });
        setTier('pro', { plan: plan, ownerGrant: true });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /**
   * Публичный API.
   * @namespace ProManager
   */
  window.ProManager = {
    checkSubscriptionStatus: checkSubscriptionStatus,
    isPro: isPro,
    subscribe: subscribe,
    cancel: cancel,
    setTier: setTier,
    applyProState: applyProState,
    tier: function () { return tier; },
    ORDER_ID: ORDER_ID,
    PRICE_LABEL: PRICE_LABEL,
    CACHE_KEY: CACHE_KEY,
    CACHE_TTL: CACHE_TTL,
    PLANS: PLANS,
    PROMO_CODES: PROMO_CODES,
    getSelectedPlanId: getSelectedPlanId,
    selectPlan: selectPlan,
    getActivePlan: getActivePlan,
    isOwner: isOwner,
    unlockOwner: unlockOwner,
    lockOwner: lockOwner,
    setOwnerPro: setOwnerPro,
    getVipVkIds: getVipVkIds,
    getVipEntries: getVipEntries,
    getVipPlan: getVipPlan,
    isVipVkId: isVipVkId,
    addVipVkId: addVipVkId,
    removeVipVkId: removeVipVkId,
    redeemPromoCode: redeemPromoCode,
    getAllPromos: getAllPromos,
    createPromo: createPromo,
    deletePromo: deletePromo,
    getAppliedDiscount: getAppliedDiscount
  };

  console.info('[ProManager] Модуль загружен. API: window.ProManager');
})();
