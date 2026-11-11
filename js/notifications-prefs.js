/**
 * МОЙ ПОРЯДОК — настройки уведомлений и календаря (Этап 12.6, PRO)
 *
 * Почему отдельный модуль, а не localStorage как остальное:
 * по условию этапа настройки уведомлений хранятся в IndexedDB (`settings`),
 * и этот хранилище до этапа 12.6 приложение не трогало вовсе. Плюс к этому
 * и calendar-export.js, и push-manager.js, и секция в backup.js должны
 * читать ОДНИ и те же значения: дублировать их по трём модулям значило бы
 * получить расхождение после первого же изменения тумблера.
 *
 * буфер в памяти:
 *   чтение настроек асинхронное (IndexedDB), а UI-код синхронный. Поэтому
 *   при старте значения загружаются один раз в кэш, и все последующие
 *   обращения к ним — синхронные get(). До окончания загрузки отдаются
 *   значения по умолчанию, поэтому приложение работает корректно и если
 *   база недоступна.
 *
 * Приватность (критерий этапа): showAmounts по умолчанию false — текст
 * системного уведомления не должен раскрывать суммы на экране блокировки.
 *
 * Экспортирует: window.NotifPrefs
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  /** @const {string} ключ записи settings со настройками уведомлений */
  var SETTING_KEY = 'notifications';

  /** @const {number[]} сколько дней до срока считать напоминанием о документе */
  var LEAD_OPTIONS = [1, 3, 7, 14];

  /** @const {string[]} варианты времени события в календаре */
  var TIMES = ['morning', 'evening', 'allday'];

  /** @const {Object} значения по умолчанию */
  var DEFAULTS = {
    /** системные (нативные) уведомления включены */
    enabled: false,
    /** показывать суммы в текстах — приватность по умолчанию важнее */
    showAmounts: false,
    /** за сколько дней предупреждать об истекающем документе */
    leadDays: 7,
    /** сколько событий класть в .ics */
    calendarHorizon: 'month',
    /** во сколько ставить события без точного времени */
    eventTime: 'morning'
  };

  /**
   * Локальный ключ дня ('YYYY-MM-DD') — по московским суткам, как и всё
   * приложение. toISOString() после полуночи по MSK дал бы вчерашний день.
   * @param {Date} [date]
   * @returns {string}
   */
  function localDay(date) {
    var d = date || new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* ================================================================
     2. СОСТОЯНИЕ
     ================================================================ */

  /** @type {Object} актуальные настройки (синхронный источник для UI) */
  var prefs = Object.assign({}, DEFAULTS);

  /** @type {boolean} идёт ли загрузка из БД */
  var loading = false;

  /** @type {?Promise<Object>} */
  var loadingPromise = null;

  /** @type {boolean} настроен ли слушатель смены тарифа */
  var tierBound = false;

  /**
   * Разрешение Notification API на момент последней проверки.
   * Держим в памяти, потому что синхронный Notification.permission есть не
   * во всех движках (в Firefox он устарел и отдаёт Promise), а спрашивать
   * про него каждый раз через await — значит сделать весь UI асинхронным.
   * @type {string}
   */
  var permission = 'default';

  /* ================================================================
     3. ЗАГРУЗКА И СОХРАНЕНИЕ
     ================================================================ */

  /**
   * Приводит сохранённый объект к известной форме: незнакомые поля отбрасываем,
   * отсутствующие берём из DEFAULTS. Ручная правка localStorage или дамп из
   * другой версии не должны уронить чтение настроек.
   * @param {*} raw
   * @returns {Object}
   */
  function normalize(raw) {
    var out = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== 'object') { return out; }

    if (typeof raw.enabled === 'boolean') { out.enabled = raw.enabled; }
    if (typeof raw.showAmounts === 'boolean') { out.showAmounts = raw.showAmounts; }

    if (LEAD_OPTIONS.indexOf(Number(raw.leadDays)) !== -1) { out.leadDays = Number(raw.leadDays); }
    if (['week', 'month', 'quarter'].indexOf(raw.calendarHorizon) !== -1) {
      out.calendarHorizon = raw.calendarHorizon;
    }
    if (TIMES.indexOf(raw.eventTime) !== -1) { out.eventTime = raw.eventTime; }

    return out;
  }

  /**
   * Читает настройки из IndexedDB (идемпотентно: повторные вызовы ждут
   * ту же загрузку). Ошибку считаем отсутствием настроек — приложение
   * обязано работать и на пустых значениях по умолчанию.
   * @returns {Promise<Object>}
   */
  function load(options) {
    if (loadingPromise && !(options && options.force)) { return loadingPromise; }
    if (options && options.force) { loadingPromise = null; }

    loading = true;
    loadingPromise = Promise.resolve()
      .then(function () {
        if (!window.DB || typeof window.DB.get !== 'function') { return null; }
        return window.DB.get('settings', SETTING_KEY);
      })
      .then(function (record) {
        prefs = normalize(record && record.value);
        loading = false;
        return prefs;
      })
      .catch(function (err) {
        loading = false;
        console.info('[NotifPrefs] Настройки не прочитаны, берём значения по умолчанию:',
          err && err.message || err);
        return prefs;
      });

    return loadingPromise;
  }

  /**
   * Сохраняет настройки. DB.add и DB.update при этом дают событие
   * `db:change`, то есть облачный бэкап честно помечает данные грязными —
   * настройки пользователя тоже должны попадать в резервную копию.
   * @param {Object} patch — только меняемые поля
   * @returns {Promise<Object>} актуальные настройки
   */
  function save(patch) {
    var next = normalize(Object.assign({}, prefs, patch || {}));
    prefs = next;

    if (!window.DB || typeof window.DB.add !== 'function') {
      return Promise.resolve(next);
    }

    return window.DB.get('settings', SETTING_KEY).then(function (record) {
      if (record) { return window.DB.update('settings', SETTING_KEY, { value: next }); }
      return window.DB.add('settings', { key: SETTING_KEY, value: next });
    }).catch(function (err) {
      console.info('[NotifPrefs] Настройки не сохранены в базу:', err && err.message || err);
      return null;
    }).then(function () { return prefs; });
  }

  /* ================================================================
     4. ДОСТУП К НАСТРОЙКАМ
     ================================================================ */

  /** @returns {boolean} активен ли PRO */
  function proActive() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  /**
   * Реально ли уведомления доступны прямо сейчас: PRO + тумблер + выданное
   * браузером разрешение. Все три условия нужны: без PRO показывать системный
   * пуш нельзя, а без разрешения он просто не появится.
   * @returns {boolean}
   */
  function canNotify() {
    return proActive() && prefs.enabled && permission === 'granted' &&
      typeof window.Notification === 'function';
  }

  /**
   * Запоминает результат проверки разрешения (и обновляет строку состояния,
   * если раздел настроек открыт).
   *
   * 'unsupported' — движок вообще без Notification API: это не отказ, и
   * UI должен показать нейтральную формулировку, а не «вы не разрешили».
   * @param {string} state 'granted' | 'denied' | 'default' | 'unsupported'
   * @returns {string}
   */
  function setPermission(state) {
    permission = ['granted', 'denied', 'unsupported'].indexOf(state) !== -1 ? state : 'default';
    try {
      window.dispatchEvent(new CustomEvent('notif:state', { detail: permission }));
    } catch (err) { /* CustomEvent мог быть недоступен в старых webview */ }
    return permission;
  }

  /* ================================================================
     5. ТЕКСТЫ УВЕДОМЛЕНИЙ (приватность по умолчанию)
     ================================================================ */

  /**
   * Формат «13 ноября» из 'YYYY-MM-DD' — локальные части, без UTC-сдвига.
   * Сегодня и завтра пишем словами: в уведомлении «срок сегодня» читается
   * быстрее, чем дата, которую ещё надо сверить с календарём.
   * @param {string} iso
   * @returns {string}
   */
  function dayLabel(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) { return ''; }

    var today = localDay();
    if (m[0] === today) { return 'сегодня'; }
    if (m[0] === localDay(offsetDays(1))) { return 'завтра'; }
    if (m[0] === localDay(offsetDays(-1))) { return 'вчера'; }

    var names = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
      'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    return Number(m[3]) + ' ' + names[Number(m[2]) - 1];
  }

  /**
   * Дата через n суток от сегодняшней (локальные части, без UTC-сдвига).
   * @param {number} n
   * @returns {Date}
   */
  function offsetDays(n) {
    var d = new Date();
    d.setDate(d.getDate() + n);
    return d;
  }

  /**
   * Заголовок уведомления. Он обязан быть НЕЙТРАЛЬНЫМ: на экране
   * блокировки не должно появляться ни названия платежа, ни имени документа.
   * @param {Object} item — событие из календаря
   * @returns {string}
   */
  function titleFor(item) {
    switch (item.type) {
      case 'payment': return item.overdue ? 'Просрочен платёж' : 'Напоминание о платеже';
      case 'task': return item.overdue ? 'Задача просрочена' : 'Напоминание: дело';
      case 'document': return 'Срок действия документа';
      default: return 'Напоминание';
    }
  }

  /**
   * Тело уведомления. Название записи и сумму добавляем ТОЛЬКО когда
   * пользователь явно включил показ чувствительных данных (showAmounts).
   * При выключенном тумблере остаётся нейтральный срок — этого достаточно,
   * чтобы понять, зачем открывать приложение, и не видно ничего лишнего.
   * @param {Object} item — событие из push-manager.findDueEvents()
   * @returns {string}
   */
  function bodyFor(item) {
    var when = dayLabel(item.date);

    if (prefs.showAmounts) {
      var money = item.amountLabel ? ' — ' + item.amountLabel : '';
      var time = item.dueTime ? ', ' + item.dueTime : '';
      return item.title + money + time;
    }

    if (item.overdue) { return 'Просрочено' + (when ? ' — ' + when : ''); }
    if (item.type === 'document') { return when ? 'Истекает ' + when : 'Проверьте срок действия'; }
    if (item.dueTime) { return 'На ' + item.dueTime; }
    return when ? 'Срок — ' + when : 'Откройте приложение';
  }

  /* ================================================================
     6. РЕАКЦИЯ НА СМЕНУ ТАРИФА
     ================================================================ */

  /**
   * Подписка могла истечь, пока вкладка открыта: тогда системные пуши
   * должны прекратиться немедленно, даже если тумблер остался включённым.
   */
  function bindTierEvents() {
    if (tierBound) { return; }
    tierBound = true;

    window.addEventListener('pro:changed', function (e) {
      var tier = (e && e.detail && e.detail.tier) ||
        (window.ProManager && window.ProManager.tier && window.ProManager.tier());

      if (tier === 'pro') { load(); return; }

      // Free: уведомления выключаются сами, настройки НЕ удаляем — при
      // возврате в PRO человек получит прежние тумблеры (данные его, а не наши)
      prefs.enabled = false;
      setPermission(permission);
    });
  }

  /* ================================================================
     7. ПУБЛИЧНЫЙ API
     ================================================================ */

  window.NotifPrefs = {
    load: load,
    save: save,
    get: function () { return Object.assign({}, prefs); },
    defaults: function () { return Object.assign({}, DEFAULTS); },
    isLoaded: function () { return !loading; },

    canNotify: canNotify,
    permission: function () { return permission; },
    setPermission: setPermission,

    titleFor: titleFor,
    bodyFor: bodyFor,

    LEAD_OPTIONS: LEAD_OPTIONS,
    TIMES: TIMES,
    SETTING_KEY: SETTING_KEY,
    localDay: localDay
  };

  /* Настройки читаем сразу при загрузке модуля: к моменту первого рендера
     раздела они уже должны быть в памяти, иначе тумблеры на секунду
     показали бы значения по умолчанию. */
  bindTierEvents();
  load();
  if (typeof window.Notification === 'function') {
    try { setPermission(Notification.permission || 'default'); } catch (err) { /* ignore */ }
  }

  console.info('[NotifPrefs] Модуль загружен. API: window.NotifPrefs');
})();
