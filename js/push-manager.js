/**
 * МОЙ ПОРЯДОК — локальные напоминания (Этап 12.6, PRO)
 *
 * Чего здесь НЕТ и почему:
 *   • никаких Firebase/OneSignal и своего сервера — по условию этапа только
 *     нативные Web API;
 *   • никаких setInterval и фоновых будильников: закрытую вкладку разбудить
 *     нельзя, а таймер в открытой жрёт батарею и всё равно умирает вместе с
 *     процессом браузера. Гарантированные пуши отдаёт системный календарь
 *     (js/calendar-export.js), а этот модуль — второй, «веб-доступный» слой.
 *
 * Схема: проверка наступает, когда приложение уже работает — при старте,
 * при возврате фокуса и после правок данных. Дальше два канала:
 *   1. нативное уведомление (ServiceWorker.showNotification, если SW
 *      контролирует страницу, иначе new Notification) — его видно, даже когда
 *      вкладка свёрнута;
 *   2. in-app-тост — если в разрешении отказано или Notification API нет.
 * Приложение при этом обязано работать как раньше: отказ от пушей не ошибка.
 *
 * Приватность: заголовок всегда нейтральный (NotifPrefs.titleFor), название
 * записи и сумма попадают в тело только при showAmounts (NotifPrefs.bodyFor).
 *
 * Экспортирует: window.PushManager
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  /** @const {string} localStorage: память «что уже показали сегодня» */
  var KEY_SHOWN = 'myorder_notified_shown';

  /** @const {number} максимум нативных уведомлений за одну проверку */
  var MAX_PUSH = 3;

  /** @const {number} длительность in-app-тоста, мс */
  var TOAST_MS = 6500;

  /** @const {number} сколько мс не перепроверять после предыдущей проверки */
  var THROTTLE_MS = 20000;

  /** @const {string} метка канала — Notification.hide() дедуплицирует по tag */
  var TAG_PREFIX = 'myorder-';

  /**
   * Куда вести и какой фильтр поставить в разделе. Просроченное событие
   * открываем на фильтре «просрочено», сегодняшнее — на «сегодня»: человек
   * приходит за конкретной записью и не должен искать её в общем списке.
   * @param {Object} item
   * @returns {{route: string, filter: string}}
   */
  function targetFor(item) {
    if (item.type === 'task') {
      return { route: '#tasks', filter: item.overdue ? 'overdue' : 'today' };
    }
    if (item.type === 'document') {
      return { route: '#documents', filter: 'expiring' };
    }
    return { route: '#payments', filter: 'pending' };
  }

  /* ================================================================
     2. СОСТОЯНИЕ
     ================================================================ */

  /** @type {boolean} привязаны ли слушатели вкладки */
  var bound = false;

  /** @type {number} когда последний раз считали наступившие сроки */
  var lastCheckAt = 0;

  /** @type {boolean} идёт ли проверка */
  var checking = false;

  /** @type {?Promise<Array>} результат текущей проверки */
  var checkingPromise = null;

  /**
   * Кэш показанного: { 'YYYY-MM-DD': { 'payment:12': true } }.
   * Читаем один раз и пишем целиком: за день накопление меньше десятка ключей.
   * @type {Object.<string, Object<string, boolean>>}
   */
  var shown = null;

  /* ================================================================
     3. ПАМЯТЬ «НЕ ПОКАЗЫВАТЬ ПОВТОРНО»
     ================================================================ */

  /** @returns {Object.<string, Object<string, boolean>>} */
  function readShown() {
    if (shown) { return shown; }

    try {
      var raw = JSON.parse(localStorage.getItem(KEY_SHOWN) || '{}');
      shown = raw && typeof raw === 'object' ? raw : {};
    } catch (err) {
      shown = {};
    }
    return shown;
  }

  /**
   * Записывает память о показе. Храним только сегодня и вчера: старые дни
   * не нужны, а чистить их иначе как при записи нечем.
   */
  function writeShown() {
    if (!shown) { return; }

    try {
      localStorage.setItem(KEY_SHOWN, JSON.stringify(shortcut(days())));
    } catch (err) {
      console.info('[Push] Память уведомлений не сохранена:', err && err.message || err);
    }
  }

  /**
   * Дни, которые стоит сохранить: сегодня и вчера (вчера — чтобы вечерний
   * показ не повторился в полночь).
   * @returns {string[]}
   */
  function days() {
    var out = [];
    var d = new Date();

    for (var i = 0; i < 2; i++) {
      out.push(window.NotifPrefs ? window.NotifPrefs.localDay(d) : d.toISOString().slice(0, 10));
      d.setDate(d.getDate() - 1);
    }
    return out;
  }

  /**
   * Оставляет в памяти только нужные дни.
   * @param {string[]} keep
   * @returns {Object}
   */
  function shortcut(keep) {
    var out = {};
    for (var i = 0; i < keep.length; i++) {
      if (shown[keep[i]]) { out[keep[i]] = shown[keep[i]]; }
    }
    return out;
  }

  /**
   * Ключ события в памяти показов.
   * @param {Object} item
   * @returns {string}
   */
  function itemKey(item) {
    return item.type + ':' + item.id;
  }

  /**
   * Уже ли это событие показывали сегодня.
   * @param {Object} item
   * @returns {boolean}
   */
  function alreadyShown(item) {
    var mem = readShown();
    var key = window.NotifPrefs ? window.NotifPrefs.localDay() : '';
    return Boolean(mem[key] && mem[key][itemKey(item)]);
  }

  /**
   * Отмечает событие показанным.
   * @param {Object} item
   */
  function markShown(item) {
    var mem = readShown();
    var key = window.NotifPrefs ? window.NotifPrefs.localDay() : 'x';
    if (!mem[key]) { mem[key] = {}; }
    mem[key][itemKey(item)] = true;
    writeShown();
  }

  /** Забывает память показов (нужно тестам и кнопке «проверить сейчас»). */
  function resetMemory() {
    shown = {};
    try { localStorage.removeItem(KEY_SHOWN); } catch (err) { /* ignore */ }
  }

  /**
   * Полный сброс внутреннего состояния проверки: троттлинг, флаг «идёт
   * проверка» и память показов.
   *
   * Без этого тестах вторая проверка в пределах 20 секунд ALWAYS давала бы
   * 'throttled', и проверить ветку 'already-notified' было бы невозможно.
   * Пользователю функция не показывается — точка входа только диагностика.
   */
  function resetState() {
    lastCheckAt = 0;
    checking = false;
    checkingPromise = null;
    resetMemory();
  }

  /* ================================================================
     4. РАЗРЕШЕНИЕ NOTIFICATION API
     ================================================================ */

  /** @returns {boolean} есть ли в движке сам API */
  function supported() {
    return typeof window.Notification === 'function';
  }

  /**
   * Актуализирует известное разрешение.
   *
   * Notification.permission синхронный есть не везде (в Firefox он устарел),
   * поэтому результат держим в NotifPrefs, а сюда добавляется только
   * тихая дозагрузка через callback-версию, если она доступна.
   * @returns {string} 'granted' | 'denied' | 'default'
   */
  function refreshPermission() {
    if (!supported()) {
      if (window.NotifPrefs) { window.NotifPrefs.setPermission('unsupported'); }
      return 'unsupported';
    }

    var state = 'default';
    try {
      state = Notification.permission || 'default';
    } catch (err) {
      state = 'default';
    }
    if (window.NotifPrefs) { window.NotifPrefs.setPermission(state); }
    return state;
  }

  /**
   * Просит разрешение. Вызывать ОБЯЗАТЕЛЬНО из жеста пользователя: вне жеста
   * Chrome отказывает, а Safari просто игнорирует вызов.
   * @returns {Promise<{state: string, supported: boolean}>}
   */
  function requestPermission() {
    if (!supported()) {
      if (window.NotifPrefs) { window.NotifPrefs.setPermission('unsupported'); }
      return Promise.resolve({ state: 'unsupported', supported: false });
    }

    function done(state) {
      if (window.NotifPrefs) { window.NotifPrefs.setPermission(state); }
      return { state: state, supported: true };
    }

    // Promise-версия (Chrome, Safari 16+, Firefox для webextensions)
    var p;
    try {
      p = Notification.requestPermission(function (legacy) {
        if (window.NotifPrefs) { window.NotifPrefs.setPermission(legacy || refreshPermission()); }
      });
    } catch (err) {
      return Promise.resolve(done(refreshPermission()));
    }

    if (p && typeof p.then === 'function') {
      return p.then(done).catch(function () { return done('denied'); });
    }

    return Promise.resolve(done(refreshPermission()));
  }

  /* ================================================================
     5. НАСТУПИВШИЕ СОБЫТИЯ
     ================================================================ */

  /**
   * Копейки → «1 250 ₽» — формат тот же, что в календаре.
   * @param {number} kopecks
   * @returns {string}
   */
  function money(kopecks) {
    var value = Number(kopecks);
    if (!Number.isFinite(value)) { return ''; }

    var abs = Math.abs(Math.round(value));
    var rub = Math.floor(abs / 100);
    var cents = abs % 100;
    var text = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');

    return (value < 0 ? '\u2212' : '') + text + ' \u20BD' + (cents ? ' ' + cents + ' к.' : '');
  }

  /**
   * Сколько целых суток от сегодня до даты 'YYYY-MM-DD'.
   * Отрицательное — просрочено. Считаем локальными частями: Date('...T00:00:00')
   * и toISOString() расходятся на сутки после полуночи по MSK.
   * @param {string} iso
   * @param {string} today
   * @returns {number}
   */
  function dayDelta(iso, today) {
    var a = new Date(iso + 'T00:00:00');
    var b = new Date(today + 'T00:00:00');
    if (isNaN(a.getTime()) || isNaN(b.getTime())) { return NaN; }
    return Math.round((a.getTime() - b.getTime()) / 86400000);
  }

  /**
   * Собирает то, о чём пора напоминать.
   *
   * Триггеры — ровно по условию этапа:
   *   • платёж на сегодня (и просроченные — они громче);
   *   • документ, у которого срок в пределах leadDays;
   *   • просроченное или сегодняшнее дело.
   * Регулярные шаблоны и архив не трогаем: это не события, а заготовки.
   *
   * @param {Object} [options]
   * @param {Object} [options.prefs] — настройки, по умолчанию NotifPrefs.get()
   * @returns {Promise<Array>} события, отсортированные «просроченные → по сроку»
   */
  function findDueEvents(options) {
    options = options || {};

    var prefs = options.prefs || (window.NotifPrefs
      ? window.NotifPrefs.get()
      : { leadDays: 7, showAmounts: false });

    if (!window.DB) { return Promise.resolve([]); }

    var today = window.NotifPrefs ? window.NotifPrefs.localDay() : new Date().toISOString().slice(0, 10);

    return Promise.all([
      window.DB.getAll('payments'),
      window.DB.getAll('tasks'),
      window.DB.getAll('documents')
    ]).then(function (res) {
      var out = [];

      function add(type, record, date, overdue) {
        out.push({
          type: type,
          id: record.id,
          date: date,
          overdue: overdue,
          dueTime: type === 'task' ? (record.dueTime || null) : null,
          title: String(type === 'document' ? record.name : record.title || ''),
          amountLabel: type === 'payment' ? money(record.amount) : ''
        });
      }

      (res[0] || []).forEach(function (p) {
        if (p.status !== 'pending' || p.isTemplate || !p.date) { return; }
        var delta = dayDelta(String(p.date).slice(0, 10), today);
        if (isNaN(delta)) { return; }
        // Напоминание о платеже: в день срока; просрочку показываем всегда —
        // о долге напоминать нужно, пока он не закрыт
        if (delta === 0 || delta < 0) { add('payment', p, String(p.date).slice(0, 10), delta < 0); }
      });

      (res[1] || []).forEach(function (t) {
        if (t.completed || t.isTemplate || t.archived || !t.dueDate) { return; }
        var delta = dayDelta(String(t.dueDate).slice(0, 10), today);
        if (isNaN(delta)) { return; }
        if (delta <= 0) { add('task', t, String(t.dueDate).slice(0, 10), delta < 0); }
      });

      (res[2] || []).forEach(function (d) {
        if (!d.expiryDate) { return; }
        var iso = String(d.expiryDate).slice(0, 10);
        var delta = dayDelta(iso, today);
        if (isNaN(delta)) { return; }
        var lead = Number(prefs.leadDays) || 7;
        if (delta <= lead) { add('document', d, iso, delta < 0); }
      });

      out.sort(function (a, b) {
        var ao = a.overdue ? 0 : 1;
        var bo = b.overdue ? 0 : 1;
        if (ao !== bo) { return ao - bo; }
        return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
      });

      return out;
    }).catch(function (err) {
      console.info('[Push] Данные не прочитаны:', err && err.message || err);
      return [];
    });
  }

  /* ================================================================
     6. ПОКАЗ
     ================================================================ */

  /**
   * Показывает нативное уведомление.
   *
   * Сначала пробуем через ServiceWorkerRegistration.showNotification: только
   * он даёт обработчик клика (sw.js: 'notificationclick'), и его вызов не
   * зависит от того, активна ли вкладка. Если SW страницу не контролирует —
   * откатываемся на new Notification(): он показывается, но без перехода
   * по клику.
   *
   * Никаких console.error: отказ разрешения или ограничение движка — штатная
   * ситуация, тест-страж консоли считает её провалом этапа.
   * @param {Object} item
   * @returns {Promise<boolean>} удалось ли показать
   */
  function showSystem(item) {
    var title = window.NotifPrefs.titleFor(item);
    var body = window.NotifPrefs.bodyFor(item);
    var target = targetFor(item);
    var options = {
      body: body,
      tag: TAG_PREFIX + itemKey(item),
      // Иконка data:URI — офлайн и без дополнительных запросов
      icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"%3E' +
        '%3Crect width="192" height="192" rx="42" fill="%232563EB"/%3E' +
        '%3Ctext x="96" y="128" font-family="Arial,sans-serif" font-size="96" font-weight="700" ' +
        'fill="white" text-anchor="middle"%3E%D0%9C%3C/text%3E%3C/svg%3E',
      // По клику sw.js перешлёт это сообщение странице, и та откроет раздел
      // с нужным фильтром (см. applyNotificationTarget)
      data: { item: itemKey(item), route: target.route, filter: target.filter }
    };

    if (navigator.serviceWorker && navigator.serviceWorker.controller &&
        navigator.serviceWorker.getRegistration) {
      return navigator.serviceWorker.getRegistration().then(function (reg) {
        if (!reg || typeof reg.showNotification !== 'function') { return null; }
        return reg.showNotification(title, options).then(function () { return true; })
          .catch(function () { return null; });
      }).then(function (ok) {
        return ok || directNotify(title, options);
      }).catch(function () { return directNotify(title, options); });
    }

    return Promise.resolve(directNotify(title, options));
  }

  /**
   * Уведомление напрямую конструктором. Возвращает boolean без исключения
   * наружу: в Safari без Service Worker оно и должно работать, а в движках
   * без API — молча нет.
   * @param {string} title
   * @param {Object} options
   * @returns {boolean}
   */
  function directNotify(title, options) {
    if (!supported()) { return false; }
    try {
      new Notification(title, options);
      return true;
    } catch (err) {
      console.info('[Push] Уведомление не показано:', err && err.message || err);
      return false;
    }
  }

  /**
   * In-app-баннер: один тост на все наступившие сроки. Нативных пушей не
   * будет (отказ в разрешении или их нет в движке), а узнать про срок
   * пользователь обязан.
   * @param {Array} items
   * @returns {boolean}
   */
  function showInApp(items) {
    if (!items.length) { return false; }

    var message = inAppText(items);

    if (window.VK && typeof window.VK.notify === 'function') {
      window.VK.notify(message, 'info', TOAST_MS);
      return true;
    }

    // Модуль VK не поднялся (офлайн до кэша) — минимум: мягкий alert-тост
    // своего делать не будем, вместо него выводим баннер в консоль как info
    console.info('[Push] ' + message);
    return false;
  }

  /**
   * Текст in-app-баннера. Названия записей — только при showAmounts, иначе
   * остаётся счётчик («2 просроченных платежа»), который на общем экране
   * не раскрывает ничего.
   * @param {Array} items
   * @returns {string}
   */
  function inAppText(items) {
    var prefs = window.NotifPrefs ? window.NotifPrefs.get() : { showAmounts: false };
    var groups = { payment: [], task: [], document: [] };

    items.forEach(function (i) { groups[i.type].push(i); });

    var LABELS = {
      payment: ['платёж', 'платежа', 'платежей'],
      task: ['дело', 'дела', 'дел'],
      document: ['документ', 'документа', 'документов']
    };

    var parts = [];
    Object.keys(groups).forEach(function (type) {
      var list = groups[type];
      if (!list.length) { return; }

      var l = LABELS[type];
      var n = list.length;
      var word = l[n % 10 === 1 && n % 100 !== 11 ? 0 : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2)];
      var overdue = list.some(function (x) { return x.overdue; });

      if (prefs.showAmounts) {
        parts.push(list.slice(0, 2).map(function (x) {
          return x.title + (x.amountLabel ? ' — ' + x.amountLabel : '');
        }).join(', ') + (n > 2 ? ' и ещё ' + (n - 2) : '') + (overdue ? ' (просрочено)' : ''));
        return;
      }
      parts.push(n + ' ' + word + (overdue ? ' просрочено' : ' в срок'));
    });

    return 'Напоминание: ' + parts.join('; ');
  }

  /* ================================================================
     7. ПРОВЕРКА
     ================================================================ */

  /**
   * Главная точка входа: посчитать наступившие сроки и показать их.
   *
   * Что делает проверку тихой и дешёвой:
   *   • Free выходит сразу — системные пуши это PRO-функция, а визуальные
   *     подсказки на главном экране уже есть;
   *   • тумблер «системные напоминания» выключен — не показываем ничего;
   *   • то же событие в тот же день не повторяем;
   *   • не чаще одного раза в THROTTLE_MS (событие db:change может прилететь
   *     пачкой при импорте).
   *
   * @param {Object} [options]
   * @param {boolean} [options.force] — игнорировать троттлинг и память показов
   * @param {boolean} [options.system] — можно ли показывать нативные пуши
   * @returns {Promise<{items: Array, shown: number, tier: string, reason: string}>}
   */
  function checkDueEvents(options) {
    options = options || {};

    var empty = { items: [], shown: 0, tier: 'free', reason: 'free' };
    var pro = Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());

    if (!pro) { return Promise.resolve(empty); }

    if (checking) { return checkingPromise; }

    var prefs = window.NotifPrefs ? window.NotifPrefs.get() : { enabled: false, leadDays: 7, showAmounts: false };

    /* force — «пользователь явно попросил»: пропускаем и троттлинг, и память
       показов. ignoreThrottle — только троттлинг: так вторая проверка того же
       дня видит события, которые не влезли в прошлый раз (см. MAX_PUSH). */
    var skipThrottle = options.force || options.ignoreThrottle;

    if (!prefs.enabled && !options.force) {
      return Promise.resolve({ items: [], shown: 0, tier: 'pro', reason: 'disabled' });
    }

    var now = Date.now();
    if (!skipThrottle && now - lastCheckAt < THROTTLE_MS) {
      return Promise.resolve({ items: [], shown: 0, tier: 'pro', reason: 'throttled' });
    }

    lastCheckAt = now;
    checking = true;

    checkingPromise = findDueEvents({ prefs: prefs }).then(function (items) {
      checking = false;

      var fresh = options.force ? items : items.filter(function (i) { return !alreadyShown(i); });
      var result = { items: items, shown: 0, tier: 'pro', reason: 'ok' };

      if (!fresh.length) {
        result.reason = items.length ? 'already-notified' : 'nothing-due';
        return result;
      }

      // Два основания не показывать нативный пуш:
      //   'in-app'     — callers попросили только баннер (тесты, кнопка
      //                  «проверить сейчас» в разделе настроек);
      //   'permission' — разрешения нет (отказ или API отсутствует в движке).
      // Во втором случае приложение ОБЯЗАНО остаться рабочим: молча
      // пропускаем пуш и показываем in-app.
      var inAppOnly = options.system === false;
      var canSystem = !inAppOnly && window.NotifPrefs && window.NotifPrefs.canNotify();

      if (!canSystem) {
        result.reason = inAppOnly ? 'in-app' : 'permission';
        var covered = fresh.slice(0, MAX_PUSH);
        if (showInApp(covered)) {
          // В память идут ТОЛЬКО вошедшие в баннер: раньше сюда попадал весь
          // список, и четвёртое событие при лимите в три терялось до завтра
          covered.forEach(markShown);
          result.shown = covered.length;
        }
        result.left = fresh.length - result.shown;
        return result;
      }

      var queue = fresh.slice(0, MAX_PUSH);
      return queue.reduce(function (chain, item) {
        return chain.then(function (count) {
          return showSystem(item).then(function (ok) {
            if (ok) { markShown(item); return count + 1; }
            return count;
          });
        });
      }, Promise.resolve(0)).then(function (count) {
        result.shown = count;
        // Если ни одно нативное уведомление не поднялось (движок умеет API,
        // но молча режет показ) — добавляем in-app, чтобы человек не потерял срок
        if (!count) {
          result.reason = 'notification-blocked';
          if (showInApp(queue)) {
            queue.forEach(markShown);
            result.shown = queue.length;
          }
        }
        result.left = fresh.length - result.shown;
        return result;
      });
    }).catch(function (err) {
      checking = false;
      console.info('[Push] Проверка сорвалась:', err && err.message || err);
      return { items: [], shown: 0, tier: 'pro', reason: 'error' };
    });

    return checkingPromise;
  }

  /**
   * Открывает раздел по клику на системном уведомлении.
   *
   * Фильтр ставим тот же global-механизм, что использует главный экран
   * (window.__homeTaskFilter и friends): он применяется после paint(),
   * поэтому не зависит от того, успел ли раздел загрузить данные.
   * @param {{route: string, filter: string}} msg
   */
  function applyNotificationTarget(msg) {
    var route = String(msg.route || '').replace(/^#/, '');
    var filter = String(msg.filter || '');
    if (!route || !window.App || typeof window.App.navigate !== 'function') { return; }

    if (route === 'tasks' && (filter === 'today' || filter === 'overdue')) {
      window.__homeTaskFilter = filter;
    } else if (route === 'payments' && filter === 'pending') {
      window.__homePaymentFilter = 'pending';
    } else if (route === 'documents' && filter === 'expiring') {
      window.__homeDocFilter = 'expiring';
    }

    window.App.navigate(route);
  }

  /* ================================================================
     8. СОБЫТИЯ ВКЛАДКИ
     ================================================================ */

  /**
   * Слушатели: старт, возврат фокуса, смена тарифа и правки данных. Никаких
   * таймеров: каждый вызов привязан к моменту, когда приложение уже активно.
   */
  function init() {
    if (bound) { return; }
    bound = true;

    refreshPermission();

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') { return; }
      checkDueEvents();
    });
    window.addEventListener('focus', function () {
      checkDueEvents();
    });

    // Данные поменяли — возможно, наступил новый срок. Троттлинг не даст
    // перепроверять на каждую запись импорта
    window.addEventListener('db:change', function (e) {
      var store = e && e.detail && e.detail.store;
      if (store === 'settings') { return; }
      checkDueEvents();
    });

    // Покупка PRO: напоминаем про себя ОДИН раз и только когда человек
    // сам придёт в раздел настроек. Здесь намеренно нет requestPermission():
    // Chrome требует пользовательский жест, а setTier() вызывается из
    // промиса VKWebAppShowOrderBox — жест уже потерян, и браузер ответил бы
    // отказом. Разрешение спрашивает тумблер в разделе «Уведомления».
    window.addEventListener('pro:changed', function (e) {
      var tier = (e && e.detail && e.detail.tier) ||
        (window.ProManager && window.ProManager.tier && window.ProManager.tier());

      if (tier !== 'pro') { return; }

      refreshPermission();
      try {
        window.dispatchEvent(new CustomEvent('notif:state', {
          detail: (window.NotifPrefs && window.NotifPrefs.permission()) || 'default'
        }));
      } catch (err) { /* CustomEvent может быть недоступен в старых webview */ }
    });

    /**
     * Клик по уведомлению из Service Worker (см. sw.js 'notificationclick'):
     * открываем раздел и ставим нужный фильтр тем же механизмом, что и
     * переходы со главного экрана (window.__home*Filter).
     */
    window.addEventListener('message', function (e) {
      var msg = e && e.data;
      if (!msg || msg.type !== 'myorder:navigate') { return; }
      applyNotificationTarget(msg);
    });

    console.info('[Push] Модуль инициализирован. API: window.PushManager');
  }

  /* ================================================================
     9. ПУБЛИЧНЫЙ API
     ================================================================ */

  window.PushManager = {
    init: init,
    checkDueEvents: checkDueEvents,
    findDueEvents: findDueEvents,
    requestPermission: requestPermission,
    refreshPermission: refreshPermission,
    showSystem: showSystem,
    showInApp: showInApp,
    inAppText: inAppText,
    resetMemory: resetMemory,
    resetState: resetState,
    targetFor: targetFor,
    applyNotificationTarget: applyNotificationTarget,

    /** @returns {boolean} есть ли Notification API в этом движке */
    supported: supported,

    KEY_SHOWN: KEY_SHOWN,
    MAX_PUSH: MAX_PUSH,
    THROTTLE_MS: THROTTLE_MS,
    TAG_PREFIX: TAG_PREFIX
  };

  console.info('[Push] Модуль загружен. API: window.PushManager');
})();
