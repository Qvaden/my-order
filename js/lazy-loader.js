/**
 * МОЙ ПОРЯДОК — ленивый загрузчик тяжёлых библиотек (Этап 12.5, PRO)
 *
 * jsPDF (365 КБ) и генератор QR-кодов (56 КБ) нужны только при первой
 * PRO-операции: скачать PDF-отчёт или распечатать квитанцию. Если вписать их
 * в index.html обычными тегами, они станут render-blocking и утянут First
 * Contentful Paint — а по критериям этапа Lighthouse должен остаться ≥ 85.
 * Поэтому библиотека подставляется <script> только по требованию и только
 * один раз: повторные вызовы получают тот же resolved Promise.
 *
 * Вне PRO модуль не вызывается вообще — Free-пользователь не скачивает ни байта.
 *
 * Экспортирует: window.Lazy
 */

(function () {
  'use strict';

  /**
   * Реестр ленивых ресурсов. Ключ — имя модуля, значение — путь.
   * @const {Object.<string, string>}
   */
  var RESOURCES = {
    jspdf: 'js/vendor/jspdf.umd.min.js',
    pdfFont: 'js/vendor/jspdf-font-ptsans.js',
    qrcode: 'js/vendor/qrcode-generator.js'
  };

  /**
   * Реестр ленивых стилей. Печатные правила (css/print.css) весят немного,
   * но как render-blocking CSS они ухудшили бы FCP — поэтому тоже по требованию.
   * @const {Object.<string, string>}
   */
  var STYLES = {
    print: 'css/print.css'
  };

  /**
   * Уже запущенные загрузки: имя → Promise. Нужен именно кэш, иначе два
   * быстрых клика «Скачать PDF» вставят один скрипт дважды.
   * @type {Object.<string, Promise<void>>}
   */
  var inflight = {};

  /**
   * Загрузка стилей: имя → Promise.
   * @type {Object.<string, Promise<void>>}
   */
  var inflightStyles = {};

  /**
   * Вставляет скрипт и ждёт его исполнения.
   * @param {string} name — ключ реестра
   * @param {string} src
   * @returns {Promise<void>}
   */
  function injectScript(name, src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.charset = 'utf-8';

      var settled = false;

      function done(err) {
        if (settled) { return; }
        settled = true;
        el.onload = null;
        el.onerror = null;
        if (err) {
          // Ошибочную загрузку выбрасываем из кэша: следующий клик должен
          // иметь шанс повторить попытку, а не вечно получать тот же reject.
          delete inflight[name];
          reject(err);
          return;
        }
        resolve();
      }

      el.onload = function () { done(null); };
      el.onerror = function () {
        done(new Error('Не удалось загрузить ' + src + '. Проверьте соединение и повторите.'));
      };

      document.head.appendChild(el);
    });
  }

  /**
   * Загружает модуль по имени из реестра (идемпотентно).
   * @param {'jspdf'|'pdfFont'|'qrcode'} name
   * @returns {Promise<void>}
   */
  function load(name) {
    if (inflight[name]) { return inflight[name]; }

    var src = RESOURCES[name];
    if (!src) {
      return Promise.reject(new Error('Неизвестный ленивый ресурс: ' + name));
    }

    inflight[name] = injectScript(name, src).then(function () {
      console.info('[Lazy] Загружено: ' + name);
    });

    return inflight[name];
  }

  /**
   * Вставляет stylesheet и ждёт его исполнения.
   * @param {string} name — ключ реестра
   * @param {string} href
   * @returns {Promise<void>}
   */
  function injectStyle(name, href) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('link[data-lazy-style="' + name + '"]')) {
        return resolve();
      }

      var el = document.createElement('link');
      el.rel = 'stylesheet';
      el.href = href;
      el.setAttribute('data-lazy-style', name);

      var settled = false;

      function done(err) {
        if (settled) { return; }
        settled = true;
        el.onload = null;
        el.onerror = null;
        if (err) {
          delete inflightStyles[name];
          reject(err);
          return;
        }
        resolve();
      }

      el.onload = function () { done(null); };
      el.onerror = function () {
        done(new Error('Не удалось загрузить стили ' + href + '.'));
      };

      document.head.appendChild(el);
    });
  }

  /**
   * Загружает стиль по имени из реестра (идемпотентно).
   * @param {'print'} name
   * @returns {Promise<void>}
   */
  function loadStyle(name) {
    if (inflightStyles[name]) { return inflightStyles[name]; }

    var href = STYLES[name];
    if (!href) {
      return Promise.reject(new Error('Неизвестный ленивый стиль: ' + name));
    }

    inflightStyles[name] = injectStyle(name, href).then(function () {
      console.info('[Lazy] Стиль загружен: ' + name);
    });

    return inflightStyles[name];
  }

  /**
   * Загружает jsPDF вместе с кириллическим шрифтом и возвращает конструктор.
   * Шрифт обязателен: встроенные Helvetica/Times не умеют русские буквы.
   * @returns {Promise<Function>} jsPDF constructor
   */
  function loadPdfKit() {
    return Promise.all([load('jspdf'), load('pdfFont')]).then(function () {
      var ctor = window.jspdf && (window.jspdf.jsPDF || window.jspdf);
      if (typeof ctor !== 'function') {
        throw new Error('Библиотека jsPDF загрузилась, но window.jspdf.jsPDF недоступен.');
      }
      var font = window.PdfFontCyrillic;
      if (!font || !font.base64) {
        throw new Error('Не загружен шрифт с кириллицей (jspdf-font-ptsans.js).');
      }
      ctor.__myorderFont = font;
      return ctor;
    });
  }

  /**
   * Загружает генератор QR-кодов.
   * @returns {Promise<Function>} qrcode(typeNumber, ecLevel)
   */
  function loadQrcode() {
    return load('qrcode').then(function () {
      if (typeof window.qrcode !== 'function') {
        throw new Error('Генератор QR-кодов загрузился, но window.qrcode недоступен.');
      }
      // Умолчальная кодировка библиотеки режет символы > 0xFF (c & 0xff) —
      // русские буквы в payload превратились бы в мусор. UTF-8 включает
      // встроенный в библиотеку табличный конвертер.
      if (window.qrcode.stringToBytesFuncs && window.qrcode.stringToBytesFuncs['UTF-8']) {
        window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs['UTF-8'];
      }
      return window.qrcode;
    });
  }

  /** @returns {boolean} грузится ли ресурс прямо сейчас */
  function isLoading(name) {
    return Boolean(inflight[name]);
  }

  /**
   * Публичный API.
   * @namespace Lazy
   */
  window.Lazy = {
    load: load,
    loadStyle: loadStyle,
    loadPdfKit: loadPdfKit,
    loadQrcode: loadQrcode,
    isLoading: isLoading,
    resources: function () { return Object.assign({}, RESOURCES); },
    styles: function () { return Object.assign({}, STYLES); }
  };

  console.info('[Lazy] Модуль загружен. API: window.Lazy');
})();
