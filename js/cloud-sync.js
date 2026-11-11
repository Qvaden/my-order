/**
 * МОЙ ПОРЯДОК — облачный бэкап и синхронизация (Этап 12.5, PRO ONLY)
 *
 * Задача: данные пользователя живут в IndexedDB на одном устройстве и
 * гибнут при очистке браузера. PRO должен уметь их беречь без собственного
 * бэкенда — только бесплатные методы VK Bridge и нативные Web API.
 *
 * Гибридная схема (по убыванию надёжности):
 *
 *   1. Файл в облачной папке (File System Access API).
 *      «Сохранить в облако» → showSaveFilePicker: пользователь выбирает папку
 *      OneDrive / Dropbox / iCloud Drive / Google Drive, приложение пишет туда
 *      my_order_backup.json. Дальше синхронизацию делает само облако, а на
 *      втором устройстве жмётся «Загрузить из облака» (showOpenFilePicker).
 *      Это единственный вариант, который реально работает между устройствами
 *      без нашего сервера. Handle держится в памяти сессии: повторные записи
 *      идут молча, без диалога.
 *
 *   2. VK Storage (VKWebAppStorageSet / VKWebAppStorageGet) — бесплатные
 *      methods, ключ-значение на аккаунт пользователя. Ограничения жёсткие:
 *      ~5 КБ на значение и ~100 ключей, поэтому дамп режется на чанки по
 *      4 КБ и хранится под ключами myorder_bk_0..N + myorder_bk_meta.
 *      Если дамп больше лимита — пишемся НЕ молча, а честно сообщаем об этом.
 *
 *   3. localStorage-прокси. Если ни первого, ни второго нет (вне VK,
 *      Safari без FSAA, переполненный дамп) — снимок кладётся сюда, а
 *      пользователю показывается подсказка скачать резервную копию вручную.
 *
 * Флаг dirty ставится на событие db:change (см. db.js, п. 10), проверка —
 * каждые 5 минут и при уходе со страницы. Никаких фоновых запросов на
 * сторонние серверы модуль не делает.
 *
 * Экспортирует: window.CloudSync
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  /** @const {string} ключ localStorage: есть ли несохранённые изменения */
  var KEY_DIRTY = 'myorder_cloud_dirty';

  /** @const {string} ключ localStorage: ISO-время последнего успешного бэкапа */
  var KEY_LAST = 'myorder_cloud_last_backup';

  /** @const {string} префикс localStorage-прокси (снимок) */
  var KEY_PROXY = 'myorder_cloud_proxy';

  /** @const {string} ключ localStorage: день последнего напоминания (YYYY-MM-DD) */
  var KEY_REMINDER = 'myorder_cloud_reminder';

  /** @const {string} имя файла по умолчанию для showSaveFilePicker */
  var FILE_NAME = 'my_order_backup.json';

  /** @const {number} период проверки dirty, мс (5 минут) */
  var CHECK_INTERVAL = 5 * 60 * 1000;

  /** @const {number} сколько дней без бэкапа считаем критичным */
  var REMIND_AFTER_DAYS = 7;

  /** @const {number} лимит одного значения VK Storage, символы (с запасом от 5 КБ) */
  var VK_CHUNK_SIZE = 4000;

  /** @const {number} максимум чанков VK Storage (запас под другие ключи приложения) */
  var VK_MAX_CHUNKS = 24;

  /** @const {string} префикс ключей дампа в VK Storage */
  var VK_KEY_PREFIX = 'myorder_bk_';

  /** @const {number} потолок размера localStorage-прокси, байты JSON */
  var PROXY_MAX_BYTES = 400 * 1024;

  /* ================================================================
     2. СОСТОЯНИЕ
     ================================================================ */

  /** @type {boolean} обработчики привязаны */
  var bound = false;

  /** @type {boolean} привязан ли сборщик dirty-флага (есть и у Free) */
  var dirtyBound = false;

  /** @type {number|null} id интервала проверки */
  var timerId = null;

  /**
   * Захваченный handle файла из showSaveFilePicker (память сессии).
   * В localStorage его не сериализуем: Permission API всё равно требует
   * пользовательский жест, так что «вечный» handle лишь illusion.
   * @type {Object|null}
   */
  var fileHandle = null;

  /** @type {boolean} идёт ли сейчас фоновая выгрузка */
  var pushing = false;

  /* ================================================================
     3. УТИЛИТЫ ХРАНЕНИЯ
     ================================================================ */

  /**
   * Безопасный чтение localStorage.
   * @param {string} key
   * @returns {string|null}
   */
  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }

  /**
   * Безопасная запись localStorage.
   * @param {string} key
   * @param {string} value
   * @returns {boolean} успех
   */
  function lsSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (err) {
      console.info('[CloudSync] localStorage недоступен для записи:', err && err.name);
      return false;
    }
  }

  function lsRemove(key) {
    try { localStorage.removeItem(key); return true; } catch (err) { return false; }
  }

  /** @returns {boolean} активен ли PRO (модуль мог загрузиться раньше ProManager) */
  function proActive() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  /** @returns {string} 'YYYY-MM-DD' локального времени */
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /**
   * Доступен ли File System Access API с записью на диск.
   * @returns {boolean}
   */
  function fsaaSupported() {
    return typeof window.showSaveFilePicker === 'function' &&
           typeof window.showOpenFilePicker === 'function';
  }

  /**
   * Есть ли в окружении рабочий VK Bridge (внутри клиента VK).
   * @returns {?Object} объект bridge или null
   */
  function bridgeOf() {
    if (!window.VK || typeof window.VK.bridge !== 'function') { return null; }
    if (typeof window.VK.isVK === 'function' && !window.VK.isVK()) { return null; }
    return window.VK.bridge() || null;
  }

  /** @param {string} message @param {string} [type] */
  function toast(message, type) {
    if (window.VK && typeof window.VK.notify === 'function') {
      window.VK.notify(message, type || 'info');
    }
  }

  /* ================================================================
     4. ДОЛЖНОСТЬ (dirty flag)
     ================================================================ */

  /** Ставит флаг «данные изменились и ещё не в облаке». */
  function markDirty() {
    lsSet(KEY_DIRTY, '1');
  }

  /** Снимает флаг и фиксирует время бэкапа. */
  function markClean() {
    lsRemove(KEY_DIRTY);
    lsSet(KEY_LAST, new Date().toISOString());
  }

  /** @returns {boolean} есть ли несохранённые в облако изменения */
  function isDirty() {
    return lsGet(KEY_DIRTY) === '1';
  }

  /** @returns {?string} ISO-время последнего успешного бэкапа */
  function getLastBackupAt() {
    var raw = lsGet(KEY_LAST);
    return raw && !isNaN(new Date(raw).getTime()) ? raw : null;
  }

  /**
   * Сколько дней прошло с последнего бэкапа.
   * @returns {number} Infinity, если бэкапов ещё не было
   */
  function daysSinceBackup() {
    var last = getLastBackupAt();
    if (!last) { return Infinity; }
    var diff = Date.now() - new Date(last).getTime();
    return Math.max(0, Math.floor(diff / 86400000));
  }

  /* ================================================================
     5. СНИМОК ДАННЫХ
     ================================================================ */

  /**
   * Собирает JSON-дампа в том же формате, что и ручной экспорт (backup.js):
   * { version, exportDate, appName, data: { payments: [], ... } }.
   * @returns {Promise<string>}
   */
  function buildDumpJson() {
    if (!window.DB || typeof window.DB.exportAll !== 'function') {
      return Promise.reject(new Error('База данных недоступна.'));
    }

    return window.DB.exportAll().then(function (raw) {
      var stores = ['payments', 'meters', 'meter_readings', 'documents', 'tasks'];
      var data = {};
      for (var i = 0; i < stores.length; i++) {
        data[stores[i]] = raw[stores[i]] || [];
      }
      return JSON.stringify({
        version: 1,
        exportDate: new Date().toISOString(),
        appName: 'MyOrder',
        cloud: true,
        data: data
      });
    });
  }

  /**
   * Проверяет, что загруженный файл — наш дамп. Отдельная от backup.js
   * валидация: здесь мы должны поймать мусор до подтверждения импорта.
   * @param {string} text
   * @returns {{ok: boolean, dump: ?Object, message: string}}
   */
  function parseDump(text) {
    var dump;
    try {
      dump = JSON.parse(text);
    } catch (err) {
      return { ok: false, dump: null, message: 'Файл не является корректным JSON.' };
    }

    if (!dump || typeof dump !== 'object' || !dump.data || typeof dump.data !== 'object') {
      return { ok: false, dump: null, message: 'В файле нет раздела «data» — это не резервная копия «Моего Порядка».' };
    }

    var known = ['payments', 'meters', 'meter_readings', 'documents', 'tasks', 'settings'];
    var keys = Object.keys(dump.data);
    for (var i = 0; i < keys.length; i++) {
      if (known.indexOf(keys[i]) === -1) {
        return { ok: false, dump: null, message: 'Неизвестное хранилище «' + keys[i] + '» — импорт отменён.' };
      }
      if (!Array.isArray(dump.data[keys[i]])) {
        return { ok: false, dump: null, message: 'Поле «' + keys[i] + '» должно быть списком.' };
      }
    }

    return { ok: true, dump: dump, message: '' };
  }

  /* ================================================================
     6. КАНАЛ 1 — ФАЙЛ В ОБЛАЧНОЙ ПАПКЕ (File System Access API)
     ================================================================ */

  /**
   * Запрашивает файл на запись. Первый раз — диалог выбора папки,
   * дальше переиспользуем handle из памяти сессии.
   * @param {boolean} forceNew — игнорировать уже выбранный handle
   * @returns {Promise<?Object>} handle или null (пользователь отменил)
   */
  function obtainWriteHandle(forceNew) {
    if (!fsaaSupported()) {
      return Promise.reject(new Error('Браузер не поддерживает выбор папки (File System Access API).'));
    }

    if (fileHandle && !forceNew) {
      return ensurePermission(fileHandle, 'readwrite').then(function (granted) {
        return granted ? fileHandle : pickWriteFile();
      });
    }

    return pickWriteFile();
  }

  /** @returns {Promise<?Object>} */
  function pickWriteFile() {
    var suggestedName = FILE_NAME;
    if (window.Family && window.Family.isActive && window.Family.isActive()) {
      var fam = window.Family.headerInfo ? window.Family.headerInfo() : null;
      if (fam && fam.sharedDataKey) {
        suggestedName = 'my_order_family_' + fam.sharedDataKey + '.json';
      }
    }

    return Promise.resolve()
      .then(function () {
        return window.showSaveFilePicker({
          suggestedName: suggestedName,
          types: [{
            description: 'Резервная копия «Мой Порядок»',
            accept: { 'application/json': ['.json'] }
          }]
        });
      })
      .then(function (handle) {
        fileHandle = handle || null;
        return fileHandle;
      })
      .catch(function (err) {
        if (err && (err.name === 'AbortError')) { return null; }
        throw err;
      });
  }

  /**
   * Разрешение на запись handle-файла. queryPermission не просит жест,
   * requestPermission показывает браузерный промпт — поэтому он вызывается
   * только из обработчика клика.
   * @param {Object} handle
   * @param {string} mode
   * @returns {Promise<boolean>}
   */
  function ensurePermission(handle, mode) {
    if (!handle || typeof handle.queryPermission !== 'function') {
      return Promise.resolve(false);
    }

    function grant() {
      return handle.requestPermission({ mode: mode }).then(function (state) {
        return state === 'granted';
      });
    }

    return handle.queryPermission({ mode: mode }).then(function (state) {
      if (state === 'granted') { return true; }
      return grant().catch(function () { return false; });
    }, function () {
      return grant().catch(function () { return false; });
    });
  }

  /**
   * Сохраняет дамп в выбранный файл. Возвращает результат с пометкой,
   * был ли показан диалог (для теста и для текста уведомления).
   * @param {Object} options
   * @param {boolean} [options.forceNew] — заново выбрать папку
   * @returns {Promise<{saved: boolean, fileName: string, cancelled: boolean, message: string}>}
   */
  function saveToCloudFile(options) {
    options = options || {};

    if (!proActive()) {
      return Promise.resolve({ saved: false, fileName: '', cancelled: false, message: 'Доступно только в PRO.' });
    }

    return obtainWriteHandle(Boolean(options.forceNew)).then(function (handle) {
      if (!handle) {
        return { saved: false, fileName: '', cancelled: true, message: 'Выбор папки отменён.' };
      }

      return handle.createWritable().then(function (writable) {
        return buildDumpJson().then(function (json) {
          return writable.write(json).then(function () { return writable.close(); })
            .then(function () {
              markClean();
              clearProxy();
              console.info('[CloudSync] Дамп записан в файл «' + (handle.name || FILE_NAME) + '».');
              return {
                saved: true,
                fileName: handle.name || FILE_NAME,
                cancelled: false,
                message: 'Облако обновлено: ' + (handle.name || FILE_NAME)
              };
            });
        });
      }).catch(function (err) {
        // handle мог устареть (файл удалён/перемещён) — сбрасываем и просим снова
        fileHandle = null;
        throw new Error('Не удалось записать файл: ' + (err && err.message || err));
      });
    });
  }

  /**
   * Показывает диалог выбора файла и читает его содержимое.
   * ВАЖНО: метод только читает. Применение данных — ответственность вызывающей
   * стороны (backup.js показывает подтверждение и вызывает Backup.importDump).
   * @returns {Promise<{cancelled: boolean, dump: ?Object, fileName: string, message: string}>}
   */
  function loadFromCloudFile() {
    if (!proActive()) {
      return Promise.resolve({ cancelled: false, dump: null, fileName: '', message: 'Доступно только в PRO.' });
    }

    if (!fsaaSupported()) {
      return Promise.resolve({ cancelled: false, dump: null, fileName: '', message: 'Браузер не поддерживает выбор файла — используйте обычный импорт.' });
    }

    return Promise.resolve()
      .then(function () {
        return window.showOpenFilePicker({
          multiple: false,
          types: [{
            description: 'Резервная копия «Мой Порядок»',
            accept: { 'application/json': ['.json'] }
          }]
        });
      })
      .then(function (handles) {
        if (!handles || !handles.length) {
          return { cancelled: true, dump: null, fileName: '', message: 'Выбор отменён.' };
        }

        var handle = handles[0];
        return ensurePermission(handle, 'read').then(function () { return handle.getFile(); })
          .then(function (file) {
            return file.text();
          })
          .then(function (text) {
            var parsed = parseDump(text);
            if (!parsed.ok) {
              return { cancelled: false, dump: null, fileName: handle.name || '', message: parsed.message };
            }
            fileHandle = fileHandle || handle;
            return { cancelled: false, dump: parsed.dump, fileName: handle.name || FILE_NAME, message: '' };
          });
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          return { cancelled: true, dump: null, fileName: '', message: 'Выбор отменён.' };
        }
        return { cancelled: false, dump: null, fileName: '', message: 'Не удалось прочитать файл: ' + (err && err.message || err) };
      });
  }

  /* ================================================================
     7. КАНАЛ 2 — VK STORAGE (бесплатные методы)
     ================================================================ */

  /**
   * Режет строку на чанки фиксированного размера.
   * @param {string} text
   * @param {number} size
   * @returns {string[]}
   */
  function chunk(text, size) {
    var parts = [];
    for (var i = 0; i < text.length; i += size) {
      parts.push(text.slice(i, i + size));
    }
    return parts;
  }

  /** @returns {boolean} влезает ли дамп в VK Storage целиком */
  function fitsInVk(json) {
    return json.length <= VK_CHUNK_SIZE * VK_MAX_CHUNKS;
  }

  /**
   * Пишет дамп в VK Storage по чанкам. Методы VKWebAppStorageSet/Get
   * бесплатные и работают без нашего сервера; лимит ~5 КБ на значение.
   * @returns {Promise<{saved: boolean, message: string, reason: string}>}
   */
  function pushToVkStorage(json) {
    var bridge = bridgeOf();
    if (!bridge || typeof bridge.send !== 'function') {
      return Promise.resolve({ saved: false, message: '', reason: 'no-bridge' });
    }

    if (!fitsInVk(json)) {
      return Promise.resolve({
        saved: false,
        message: 'Данные слишком большие для хранилища ВКонтакте.',
        reason: 'too-large'
      });
    }

    var parts = chunk(json, VK_CHUNK_SIZE);
    var meta = JSON.stringify({ n: parts.length, len: json.length, at: new Date().toISOString() });

    return Promise.resolve()
      .then(function () {
        return bridge.send('VKWebAppStorageSet', { key: VK_KEY_PREFIX + 'meta', value: meta });
      })
      .then(function () {
        // Последовательно: параллельные записи одного пользователя VK не гарантирует
        return parts.reduce(function (chain, part, index) {
          return chain.then(function () {
            return bridge.send('VKWebAppStorageSet', {
              key: VK_KEY_PREFIX + index,
              value: part
            });
          });
        }, Promise.resolve());
      })
      .then(function () {
        return { saved: true, message: 'Резервная копия обновлена в ВКонтакте.', reason: 'ok' };
      })
      .catch(function (err) {
        var type = (err && (err.error_type || err.name)) || 'unknown';
        console.info('[CloudSync] VK Storage недоступен (' + type + ') — используем локальный прокси.');
        return { saved: false, message: '', reason: 'vk-error' };
      });
  }

  /**
   * Читает дамп из VK Storage по чанкам.
   * @returns {Promise<{ok: boolean, dump: ?Object, message: string}>}
   */
  function pullFromVkStorage() {
    var bridge = bridgeOf();
    if (!bridge || typeof bridge.send !== 'function') {
      return Promise.resolve({ ok: false, dump: null, message: 'Хранилище ВКонтакте доступно только внутри приложения VK.' });
    }

    return Promise.resolve()
      .then(function () {
        return bridge.send('VKWebAppStorageGet', { keys: [VK_KEY_PREFIX + 'meta'] });
      })
      .then(function (res) {
        var items = (res && res.items) || [];
        var raw = items.length ? items[0].value : null;
        if (!raw) {
          return { ok: false, dump: null, message: 'В облаке ВКонтакте копии пока нет.' };
        }

        var meta = JSON.parse(raw);
        var keys = [];
        for (var i = 0; i < meta.n; i++) { keys.push(VK_KEY_PREFIX + i); }

        return bridge.send('VKWebAppStorageGet', { keys: keys }).then(function (chunksRes) {
          var got = (chunksRes && chunksRes.items) || [];
          // VK возвращает только существующие ключи — собираем по имени, а не по порядку
          var byKey = {};
          got.forEach(function (item) { byKey[item.key] = item.value; });

          var text = '';
          for (var j = 0; j < meta.n; j++) {
            var part = byKey[VK_KEY_PREFIX + j];
            if (typeof part !== 'string') {
              return { ok: false, dump: null, message: 'Копия в ВКонтакте повреждена (нет куска ' + (j + 1) + ' из ' + meta.n + ').' };
            }
            text += part;
          }

          if (meta.len && text.length !== meta.len) {
            return { ok: false, dump: null, message: 'Копия в ВКонтакте неполная: размер не совпадает.' };
          }

          var parsed = parseDump(text);
          if (!parsed.ok) { return { ok: false, dump: null, message: parsed.message }; }
          return { ok: true, dump: parsed.dump, message: '' };
        });
      })
      .catch(function (err) {
        return { ok: false, dump: null, message: 'Не удалось прочитать облако ВКонтакте: ' + (err && (err.error_type || err.message) || err) };
      });
  }

  /* ================================================================
     8. КАНАЛ 3 — LOCALSTORAGE-ПРОКСИ (последний шанс)
     ================================================================ */

  /**
   * Кладёт снимок в localStorage, чтобы он пережил перезагрузку и был
   * доступен для ручного экспорта. При переполнении — честно ничего не
   * сохраняет и подсказывает скачать копию.
   * @param {string} json
   * @returns {boolean}
   */
  function writeProxy(json) {
    if (json.length > PROXY_MAX_BYTES) {
      clearProxy();
      return false;
    }
    return lsSet(KEY_PROXY, json);
  }

  function readProxy() {
    var raw = lsGet(KEY_PROXY);
    if (!raw) { return null; }
    var parsed = parseDump(raw);
    return parsed.ok ? parsed.dump : null;
  }

  function clearProxy() {
    lsRemove(KEY_PROXY);
  }

  /* ================================================================
     9. ИНТЕЛЛЕКТУАЛЬНАЯ ВЫГРУЗКА
     ================================================================ */

  /**
   * Куда сейчас реально можно выгрузить данные — для подписей в UI.
   * @returns {{channel: 'file'|'vk'|'manual', label: string, detail: string}}
   */
  function storageInfo() {
    if (fileHandle) {
      return {
        channel: 'file',
        label: 'Файл в облачной папке',
        detail: 'Обновляется автоматически: ' + (fileHandle.name || FILE_NAME)
      };
    }
    if (fsaaSupported()) {
      return {
        channel: 'file',
        label: 'Файл в облачной папке',
        detail: 'OneDrive, Dropbox, iCloud Drive или Google Drive — выберите папку один раз'
      };
    }
    if (bridgeOf()) {
      return { channel: 'vk', label: 'Хранилище ВКонтакте', detail: 'Автоматически, если данные влезают в лимит' };
    }
    return {
      channel: 'manual',
      label: 'Ручное резервное копирование',
      detail: 'Браузер не даёт писать в облачную папку — скачивайте копию сами'
    };
  }

  /**
   * Выгружает, если есть что выгружать. Порядок: файл → VK Storage → прокси.
   * Ошибки канала не считаются провалом: данные остаются в IndexedDB, флаг
   * dirty снимается только при реальной записи.
   * @param {Object} [options]
   * @param {boolean} [options.force] — выгрузить даже без флага dirty
   * @param {boolean} [options.silent] — не показывать тосты (фоновый режим)
   * @returns {Promise<{ran: boolean, channel: string, message: string}>}
   */
  function pushNow(options) {
    options = options || {};

    if (!proActive()) {
      return Promise.resolve({ ran: false, channel: 'none', message: 'только PRO' });
    }
    if (!options.force && !isDirty()) {
      return Promise.resolve({ ran: false, channel: 'none', message: 'нет изменений' });
    }
    if (pushing) {
      return Promise.resolve({ ran: false, channel: 'none', message: 'выгрузка уже идёт' });
    }

    pushing = true;

    return buildDumpJson().then(function (json) {
      // 1. Файл, если папка уже выбрана в этой сессии — пишем молча
      if (fileHandle) {
        return ensurePermission(fileHandle, 'readwrite').then(function (granted) {
          if (!granted) { return null; }
          return fileHandle.createWritable().then(function (writable) {
            return writable.write(json).then(function () { return writable.close(); })
              .then(function () {
                markClean();
                clearProxy();
                return { ran: true, channel: 'file', message: 'Облако обновлено' };
              });
          });
        }).catch(function (err) {
          console.info('[CloudSync] Запись в файл не удалась:', err && err.message || err);
          fileHandle = null;
          return null;
        }).then(function (res) {
          return res !== null && res !== undefined ? res : fallbackPush(json);
        });
      }

      return fallbackPush(json);
    }).catch(function (err) {
      console.info('[CloudSync] Выгрузка не выполнена:', err && err.message || err);
      return { ran: false, channel: 'error', message: (err && err.message) || 'ошибка' };
    }).then(function (result) {
      pushing = false;
      if (window.Family && window.Family.isActive && window.Family.isActive()) {
        window.Family.pushNow({ silent: true });
      }
      if (!options.silent && result && result.ran) { toast(result.message, 'success'); }
      return result;
    });
  }

  /**
   * Каналы 2 и 3: VK Storage, затем localStorage-прокси.
   * @param {string} json
   * @returns {Promise<{ran: boolean, channel: string, message: string}>}
   */
  function fallbackPush(json) {
    return pushToVkStorage(json).then(function (res) {
      if (res.saved) {
        markClean();
        clearProxy();
        return { ran: true, channel: 'vk', message: res.message };
      }

      var stored = writeProxy(json);
      if (!stored) {
        return { ran: false, channel: 'none', message: 'Не удалось сохранить локальную копию' };
      }
      // dirty НЕ снимаем: прокси — это отладочный снимок, а не настоящая
      // синхронизация; напоминание о бэкапе должно оставаться
      return {
        ran: true,
        channel: 'manual',
        message: res.reason === 'too-large'
          ? 'Дамп больше лимита ВКонтакте — скачайте резервную копию вручную'
          : 'Облако недоступно — копия хранится локально, скачайте её вручную'
      };
    });
  }

  /* ================================================================
     10. НАПОМИНАНИЕ О БЭКАПЕ
     ================================================================ */

  /**
   * Еженедельное напоминание PRO-пользователю. Не чаще одного раза в сутки
   * и только когда копия реально устарела.
   * @returns {Promise<boolean>} было ли показано
   */
  function checkReminder() {
    if (!proActive()) { return Promise.resolve(false); }

    var days = daysSinceBackup();
    if (days < REMIND_AFTER_DAYS) { return Promise.resolve(false); }
    if (lsGet(KEY_REMINDER) === todayKey()) { return Promise.resolve(false); }

    lsSet(KEY_REMINDER, todayKey());

    var text = days === Infinity
      ? 'У вас ещё не было резервных копий. Нажмите «Сохранить в облако».'
      : 'Ваш последний бэкап был ' + days + ' ' + plural(days, 'день', 'дня', 'дней') +
        ' назад. Нажмите «Сохранить в облако».';

    toast(text, 'info');
    console.info('[CloudSync] Напоминание о бэкапе показано (' + days + ' дн.).');
    return Promise.resolve(true);
  }

  /**
   * Русская плюрализация: 1 день / 2 дня / 5 дней.
   * @param {number} n
   * @param {string} one
   * @param {string} few
   * @param {string} many
   * @returns {string}
   */
  function plural(n, one, few, many) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) { return one; }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) { return few; }
    return many;
  }

  /* ================================================================
     11. ПЕРИОДИЧЕСКАЯ ПРОВЕРКА И СОБЫТИЯ ВКЛАДКИ
     ================================================================ */

  function onDbChange() {
    markDirty();
  }

  function tick() {
    if (!proActive()) { return; }
    if (!isDirty()) {
      checkReminder();
      return;
    }
    pushNow({ silent: true }).then(function (res) {
      // Молчаливая фоновая выгрузка не должна оставить dirty без объяснений:
      // если канал не найден, напомним пользователю в явном виде
      if (res && res.ran && res.channel === 'manual') { checkReminder(); }
    });
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden' && proActive() && isDirty()) {
      // pagehide/hidden: sendBeacon тут не при чём — пишем в файл/прокси синхронно-асинхронно
      pushNow({ silent: true });
    }
  }

  /** Привязка слушателей — один раз за сессию. */
  function bind() {
    if (bound) { return; }
    bound = true;
    dirtyBound = true;

    window.addEventListener('db:change', onDbChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onVisibilityChange);

    timerId = setInterval(tick, CHECK_INTERVAL);
    console.info('[CloudSync] Слушатели привязаны: db:change, visibilitychange, интервал 5 мин.');
  }

  /** Отвязка PRO-слушателей. Сборщик dirty остаётся: он нужен и Free. */
  function unbind() {
    if (!bound) { return; }
    bound = false;

    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onVisibilityChange);
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  /** Единственный лёгкий слушатель для Free: помечать изменения, больше ничего. */
  function bindDirtyOnly() {
    if (dirtyBound) { return; }
    dirtyBound = true;
    window.addEventListener('db:change', onDbChange);
  }

  /* ================================================================
     12. ПУБЛИЧНЫЙ API
     ================================================================ */

  /**
   * Точка входа. Вызывается из app.js после готовности БД и только при PRO:
   * Free не должен платить ни за таймеры, ни за лишние слушатели.
   */
  function init() {
    if (!proActive()) {
      // Free тоже слушает db:change: один обработчик и одна запись в
      // localStorage, без таймеров и без сетевых попыток. Иначе после покупки
      // PRO потерялась бы история изменений, случившаяся до неё.
      bindDirtyOnly();
      return;
    }

    bind();
    checkReminder();
    if (window.Family && window.Family.isActive && window.Family.isActive()) {
      window.Family.pullNow({ silent: true });
    }
  }

  /** Вызывается после успешной покупки PRO (pro-manager.js). */
  function activate() {
    unbind();
    bind();
    pushNow({ force: true, silent: true });
    checkReminder();
  }

  /** Останавливает таймеры (после истечения подписки). */
  function deactivate() {
    unbind();
  }

  /** @returns {boolean} выбран ли уже файл для автосинхронизации */
  function hasAutoFile() {
    return Boolean(fileHandle);
  }

  /** Забывает выбранный файл (кнопка «Сменить папку»). */
  function forgetFile() {
    fileHandle = null;
    console.info('[CloudSync] Файл для автосинхронизации сброшен.');
  }

  window.CloudSync = {
    init: init,
    activate: activate,
    deactivate: deactivate,

    // Должность
    markDirty: markDirty,
    isDirty: isDirty,
    getLastBackupAt: getLastBackupAt,
    daysSinceBackup: daysSinceBackup,
    checkReminder: checkReminder,
    REMIND_AFTER_DAYS: REMIND_AFTER_DAYS,

    // Канал 1 — файл
    fsaaSupported: fsaaSupported,
    saveToCloudFile: saveToCloudFile,
    loadFromCloudFile: loadFromCloudFile,
    hasAutoFile: hasAutoFile,
    forgetFile: forgetFile,

    // Канал 2 — VK Storage
    pullFromVkStorage: pullFromVkStorage,

    // Канал 3 — прокси
    readProxy: readProxy,

    // Управление выгрузкой
    pushNow: pushNow,
    storageInfo: storageInfo,
    buildDumpJson: buildDumpJson,
    parseDump: parseDump,

    // Проверяемые границы канала: тестам и диагностике нужен честный
    // лимит, а не догадка «примерно 100 КБ»
    VK_CHUNK_SIZE: VK_CHUNK_SIZE,
    VK_MAX_CHUNKS: VK_MAX_CHUNKS,
    VK_LIMIT_CHARS: VK_CHUNK_SIZE * VK_MAX_CHUNKS
  };

  console.info('[CloudSync] Модуль загружен. API: window.CloudSync');
})();
