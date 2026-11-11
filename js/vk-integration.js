/**
 * МОЙ ПОРЯДОК — Интеграция с ВКонтакте (Этап 10)
 *
 * Модуль-обёртка над VK Bridge SDK. Ключевой принцип этапа:
 * graceful degradation. Вне ВКонтакте (обычный браузер / PWA) модуль
 * определяет окружение как 'browser', не делает сетевых вызовов и
 * приложение продолжает работать как раньше — гость, светлая тема.
 *
 * Реальное имя SDK: @vkontakte/vk-bridge 3.x (window.vkBridge).
 * Примечание к ТЗ: методов VKWebAppGetSettings / VKWebAppShowSnackbar /
 * VKWebAppShowErrorBox в официальном SDK НЕ существует. Тема приходит
 * через событие VKWebAppUpdateConfig (поле data.scheme) и launch-параметр
 * vk_color_scheme; вместо snackbar используется собственный toast-слой
 * (API window.VK.notify совместим с будущим переходом на нативные UI).
 *
 * Экспортирует: window.VK
 */

(function () {
  'use strict';

  /* ================================================================
     1. ОКРУЖЕНИЕ
     ================================================================ */

  /** @type {Object|null} глобальный объект VK Bridge (из index.html) */
  var bridge = null;

  /**
   * Тип окружения:
   *   'vk-web'    — iframe приложения ВКонтакте (desktop/web)
   *   'vk-native' — мобильный клиент VK (WebView)
   *   'browser'   — обычный браузер, VK недоступен
   * @type {'vk-web'|'vk-native'|'browser'}
   */
  var env = 'browser';

  /** Кэш данных пользователя из VKWebAppGetUserInfo */
  var vkUser = null;

  /** Актуальная тема: 'light' | 'dark' */
  var currentTheme = 'light';

  /** Язык интерфейса из VK (ru/en/uk...), по-русски по умолчанию */
  var currentLang = 'ru';

  /**
   * Определяет окружение запуска. Безопасно, если window.vkBridge
   * не загрузился (CDN недоступен офлайн) — остаёмся в 'browser'.
   */
  function detectEnv() {
    bridge = window.vkBridge || null;
    if (!bridge || typeof bridge.send !== 'function') {
      return 'browser';
    }
    try {
      if (bridge.isWebView && bridge.isWebView()) { return 'vk-native'; }
      if (bridge.isIframe && bridge.isIframe()) { return 'vk-web'; }
      if (bridge.isEmbedded && bridge.isEmbedded()) { return 'vk-web'; }
    } catch (e) {
      // Методы определения окружения не отвечают — считаем себя браузером
    }
    return 'browser';
  }

  /** @returns {boolean} true, если запущены внутри ВКонтакте */
  function isVK() {
    return env === 'vk-web' || env === 'vk-native';
  }

  /* ================================================================
     2. LAUNCH PARAMS (URL-параметры vk_*)
     ================================================================ */

  /** Ручной выбор пользователя: 'light' | 'dark' | 'auto' | null */
  var userThemePreference = null;
  try {
    var storedTheme = localStorage.getItem('myorder_user_theme');
    if (storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'auto') {
      userThemePreference = storedTheme === 'auto' ? null : storedTheme;
    }
  } catch (e) {}

  /**
   * Читает тему из строки запуска или сохранённого выбора пользователя.
   * 1. Сохранённый выбор пользователя (localStorage)
   * 2. Тестовый GET-параметр ?theme=dark|light
   * 3. Системный параметр ВКонтакте vk_color_scheme
   * @returns {string|null} 'dark' | 'light' | null
   */
  function themeFromLaunchParams() {
    try {
      if (userThemePreference === 'dark' || userThemePreference === 'light') {
        return userThemePreference;
      }
      var p = new URLSearchParams(window.location.search);
      var manual = p.get('theme');
      if (manual) { return String(manual).toLowerCase() === 'dark' ? 'dark' : 'light'; }
      var scheme = p.get('vk_color_scheme');
      if (!scheme) { return null; }
      return /dark/i.test(scheme) ? 'dark' : 'light';
    } catch (e) {
      return null;
    }
  }

  /**
   * Язык интерфейса пользователя ВКонтакте. Клиент передаёт его параметром
   * vk_language (ru/en/uk/...) — читаем синхронно, чтобы не ждать событий.
   * @returns {string|null}
   */
  function langFromLaunchParams() {
    try {
      var p = new URLSearchParams(window.location.search);
      var lang = p.get('vk_language');
      return lang ? String(lang).toLowerCase() : null;
    } catch (e) {
      return null;
    }
  }

  /* ================================================================
     3. ТЕМА LIGHT/DARK
     ================================================================ */

  /** Значения <meta name="theme-color"> под каждую тему */
  var THEME_COLOR = { light: '#2563EB', dark: '#0F172A' };

  /**
   * Применяет тему ко всему документу.
   * data-theme на <html> — единая точка переключения для CSS.
   * @param {'light'|'dark'} theme
   * @param {boolean} [isUserManual]
   */
  function applyTheme(theme, isUserManual) {
    currentTheme = theme === 'dark' ? 'dark' : 'light';
    if (isUserManual) {
      userThemePreference = currentTheme;
      try { localStorage.setItem('myorder_user_theme', currentTheme); } catch (e) {}
    }
    var root = document.documentElement;
    root.setAttribute('data-theme', currentTheme);
    root.style.colorScheme = currentTheme;

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) { meta.setAttribute('content', THEME_COLOR[currentTheme]); }

    // Сообщаем приложению (app.js перекрашивает canvas-зависимые виджеты)
    window.dispatchEvent(new CustomEvent('vk:theme', { detail: { theme: currentTheme } }));
  }

  /**
   * Обработчик событий VK Bridge. Нас интересует VKWebAppUpdateConfig —
   * клиент ВК присылает его при старте и каждый раз при смене темы.
   * @param {{detail?: {type: string, data?: Object}}} event
   */
  function onBridgeEvent(event) {
    var detail = event && event.detail;
    if (!detail || typeof detail !== 'object') { return; }

    if (detail.type === 'VKWebAppUpdateConfig') {
      if (userThemePreference === 'dark' || userThemePreference === 'light') {
        // Пользователь явно выбрал фиксированную тему, не перебиваем её из VK
        return;
      }
      var data = detail.data || {};
      var scheme = String(data.scheme || '');
      if (/dark/i.test(scheme)) {
        applyTheme('dark');
      } else if (scheme) {
        applyTheme('light');
      }
      if (data.appearance_id) { /* зарезервировано: токены клиента VK */ }
    }

    if (detail.type === 'VKWebAppLanguageChangeUpdate' ||
        detail.type === 'VKWebAppLangChange') {
      var lang = (detail.data && detail.data.language) || null;
      if (lang) {
        currentLang = lang;
        window.dispatchEvent(new CustomEvent('vk:lang', { detail: { lang: lang } }));
      }
    }
  }

  /* ================================================================
     4. ПОЛЬЗОВАТЕЛЬ (graceful degradation — гость без имени)
     ================================================================ */

  /**
   * Запрашивает профиль пользователя. Ошибка (пользователь закрыл окно
   * авторизации, метод недоступен) НЕ считается фатальной: остаёмся гостем.
   * @returns {Promise<?Object>}
   */
  function loadUser() {
    if (!isVK() || !bridge) { return Promise.resolve(null); }
    return Promise.resolve()
      .then(function () { return bridge.send('VKWebAppGetUserInfo'); })
      .then(function (user) {
        vkUser = user || null;
        if (vkUser) {
          window.dispatchEvent(new CustomEvent('vk:user', { detail: vkUser }));
        }
        return vkUser;
      })
      .catch(function (err) {
        // Гостевой режим: тихо, без console.error (консоль должна быть чистой)
        console.info('[VK] Профиль недоступен, работаем гостем:', err && err.error_type || err);
        return null;
      });
  }

  /* ================================================================
     5. TOAST-СЛОЙ (native-like уведомления)
     ================================================================ */

  /**
   * Показывает всплывающее уведомление над нижней навигацией.
   * Стиль — как системный snackbar на iOS/Android.
   * @param {string} message — текст
   * @param {'info'|'success'|'error'} [type='info']
   * @param {number} [duration=2800] — мс
   */
  function notify(message, type, duration) {
    type = type || 'info';
    duration = typeof duration === 'number' ? duration : 2800;

    var host = document.getElementById('vk-toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'vk-toasts';
      host.className = 'vk-toasts';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }

    var toast = document.createElement('div');
    toast.className = 'vk-toast vk-toast--' + type;
    var text = document.createElement('span');
    text.className = 'vk-toast__text';
    text.textContent = message;               //textContent = безопасная вставка
    toast.appendChild(text);
    host.appendChild(toast);

    // Вход
    requestAnimationFrame(function () { toast.classList.add('vk-toast--in'); });

    var closed = false;
    function dismiss() {
      if (closed) { return; }
      closed = true;
      toast.classList.remove('vk-toast--in');
      toast.classList.add('vk-toast--out');
      setTimeout(function () {
        if (toast.parentNode) { toast.parentNode.removeChild(toast); }
      }, 260);
    }

    toast.addEventListener('click', dismiss);
    setTimeout(dismiss, duration);
    return dismiss;
  }

  /**
   * Копирует текст в буфер обмена: VK-мост, если доступен, иначе Clipboard API.
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  function copyText(text) {
    if (isVK() && bridge) {
      return Promise.resolve()
        .then(function () { return bridge.send('VKWebAppCopyText', { text: text }); })
        .then(function () { return true; })
        .catch(function () { return fallbackCopy(text); });
    }
    return fallbackCopy(text);
  }

  /** @param {string} text @returns {Promise<boolean>} */
  function fallbackCopy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(function () { return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  /** @param {string} text @returns {boolean} */
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ================================================================
     6. ШАРИНГ
     ================================================================ */

  /**
   * Делится приложением: VKWebAppShare внутри VK, navigator.share в
   * обычном браузере, копирование ссылки — как последний fallback.
   * @returns {Promise<void>}
   */
  function shareApp() {
    var link = window.location.origin + window.location.pathname;
    var title = 'МОЙ ПОРЯДОК — порядок в платежах, документах и делах';

    if (isVK() && bridge) {
      return Promise.resolve()
        .then(function () { return bridge.send('VKWebAppShare', { link: link }); })
        .then(function (res) {
          if (res && res.type === 'wall') { notify('Опубликовано на стене', 'success'); }
        })
        .catch(function (err) {
          // Пользователь закрыл окно шаринга — не считаем это ошибкой
          var type = (err && err.error_type) || '';
          if (type !== 'user_dismiss' && type !== 'user_cancel') {
            notify('Не удалось поделиться из ВКонтакте', 'error');
          }
        });
    }

    if (navigator.share) {
      return navigator.share({ title: title, url: link })
        .catch(function () { /* отмена пользователя — тихо */ });
    }

    return copyText(link).then(function (ok) {
      notify(ok ? 'Ссылка скопирована' : 'Скопируйте ссылку из адресной строки', ok ? 'success' : 'info');
    });
  }

  /* ================================================================
     7. ИНИЦИАЛИЗАЦИЯ
     ================================================================ */

  /**
   * Точка входа. Вызывается одинжды при загрузке страницы.
   * Никаких блокирующих операций: приложение стартует мгновенно,
   * данные VK подтягиваются асинхронно.
   */
  function init() {
    env = detectEnv();

    // 0. Язык из launch-параметров доступен сразу, без ожидания событий
    var launchLang = langFromLaunchParams();
    if (launchLang) { currentLang = launchLang; }

    // 1. Тема. Источник по приоритету: ручной тест (?theme=) → launch-параметр
    //    VK → light. Системную тему ОС НЕ читаем: вне ВКонтакте приложение по
    //    критериям этапа обязано выглядеть как раньше (светлая тема).
    applyTheme(themeFromLaunchParams() || 'light');

    if (!isVK()) {
      // Browser-режим: bridge не трогаем, работает только ручной тест темы
      return;
    }

    // 2. Подписка на события клиента (тема, язык) — до VKWebAppInit
    if (bridge.subscribe) { bridge.subscribe(onBridgeEvent); }

    // 3. VKWebAppInit — обязательный первый вызов для мобильных клиентов
    Promise.resolve()
      .then(function () { return bridge.send('VKWebAppInit'); })
      .catch(function () { /* desktop web может не отвечать — не критично */ });

    // 4. Тема из launch-параметра могла отсутствовать — запрашиваем конфиг
    //    (клиент сам пришлёт VKWebAppUpdateConfig; явный запрос не нужен)

    // 5. Профиль пользователя (graceful: отказ = гостевой режим)
    loadUser();
  }

  // Стартуем сразу: модуль подключается в <head> после SDK, DOM не нужен
  init();

  /* ================================================================
     8. ЭКСПОРТ
     ================================================================ */

  /**
   * Публичный API интеграции с VK.
   * @namespace VK
   */
  window.VK = {
    /** 'vk-web' | 'vk-native' | 'browser' */
    env: function () { return env; },
    /** @returns {boolean} */
    isVK: isVK,
    /** @returns {'light'|'dark'} */
    theme: function () { return currentTheme; },
    /** @returns {string} 'ru' | 'en' | ... */
    lang: function () { return currentLang; },
    /** @returns {?Object} профиль из VK или null (гость) */
    user: function () { return vkUser; },
    /** @returns {string} имя для приветствия ('' если гость) */
    firstName: function () { return vkUser && vkUser.first_name ? String(vkUser.first_name) : ''; },
    /** @returns {Promise<?Object>} перечитать профиль */
    loadUser: loadUser,
    /** Ручное переключение темы */
    setTheme: function (t) { applyTheme(t === 'dark' ? 'dark' : 'light', true); },
    /** Текущий режим темы ('light' | 'dark' | 'auto') */
    themeMode: function () { return userThemePreference || 'auto'; },
    /** Установка режима темы ('light' | 'dark' | 'auto') */
    setThemeMode: function (mode) {
      if (mode === 'auto') {
        userThemePreference = null;
        try { localStorage.removeItem('myorder_user_theme'); } catch (e) {}
        var defaultTheme = null;
        try {
          var p = new URLSearchParams(window.location.search);
          var scheme = p.get('vk_color_scheme');
          if (scheme) { defaultTheme = /dark/i.test(scheme) ? 'dark' : 'light'; }
        } catch (e) {}
        applyTheme(defaultTheme || 'light', false);
        return currentTheme;
      }
      if (mode === 'dark' || mode === 'light') {
        applyTheme(mode, true);
        return currentTheme;
      }
      return currentTheme;
    },
    /** Циклическая смена темы — переключает светлую/тёмную */
    toggleTheme: function () {
      var next = currentTheme === 'dark' ? 'light' : 'dark';
      applyTheme(next, true);
      return next;
    },
    /** @returns {Promise<void>} */
    share: shareApp,
    /** @returns {Function} отмена показа */
    notify: notify,
    /** @returns {Promise<boolean>} */
    copyText: copyText,
    /** Ссылка на сырой bridge (для Pro-модуля и будущих этапов) */
    bridge: function () { return bridge; }
  };
})();
