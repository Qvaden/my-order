/**
 * МОЙ ПОРЯДОК — Модуль работы с IndexedDB (Этап 3)
 *
 * Универсальный слой доступа к данным:
 *   - Инициализация базы и система миграций по версиям
 *   - Универсальный CRUD для всех object stores
 *   - Поиск по индексам, подсчёт, очистка с подтверждением
 *   - Экспорт / импорт всего дампа
 *   - Автоматические поля createdAt / updatedAt
 *   - Базовая валидация (деньги — integer в копейках, даты — ISO 8601)
 *
 * Экспортируется как window.DB. Все методы возвращают Promise.
 * Внешних зависимостей нет: только нативный IndexedDB API.
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНФИГУРАЦИЯ БАЗЫ
     ================================================================ */

  /** @const {string} Имя базы данных IndexedDB */
  var DB_NAME = 'MyOrderDB';

  /** @const {number} Текущая версия базы данных (= числу применённых миграций) */
  var CURRENT_VERSION = 3;

  /** @const {number} Таймаут одной операции, мс */
  var OPERATION_TIMEOUT = 5000;

  /**
   * Хранилища, которые создаёт миграция v1. Список зафиксирован отдельно от
   * STORES: v1 обязана restoять ровно ту схему, которая была в первом релизе,
   * иначе добавление нового хранилища «задним числом» исказит историю версий.
   * @const {string[]}
   */
  var V1_STORES = ['payments', 'meters', 'meter_readings', 'documents', 'tasks', 'settings'];

  /** @const {string[]} Порядок object stores (используется при экспорте/импорте) */
  var STORES = V1_STORES.concat(['families', 'custom_categories']);

  /**
   * Схемы object stores.
   * @type {Object.<string, {keyPath: string, autoIncrement: boolean, indices: Array<{name: string, unique: boolean}>}>}
   */
  var STORE_SCHEMAS = {
    payments: {
      keyPath: 'id',
      autoIncrement: true,
      indices: [
        { name: 'date', unique: false },
        { name: 'category', unique: false },
        { name: 'status', unique: false }
      ]
    },
    meters: {
      keyPath: 'id',
      autoIncrement: true,
      indices: [
        { name: 'type', unique: false }
      ]
    },
    meter_readings: {
      keyPath: 'id',
      autoIncrement: true,
      indices: [
        { name: 'meterId', unique: false },
        { name: 'date', unique: false }
      ]
    },
    documents: {
      keyPath: 'id',
      autoIncrement: true,
      indices: [
        { name: 'expiryDate', unique: false },
        { name: 'category', unique: false }
      ]
    },
    tasks: {
      keyPath: 'id',
      autoIncrement: true,
      indices: [
        { name: 'dueDate', unique: false },
        { name: 'completed', unique: false },
        { name: 'priority', unique: false }
      ]
    },
    settings: {
      keyPath: 'key',
      autoIncrement: false,
      indices: []
    },
    /* Этап 12.7: семьи. keyPath — uuid семьи (не autoIncrement): ключ
       должен быть одинаковым на всех устройствах участников, а последователь-
       ный id IndexedDB выдаёт локально и он бы столкнулся при первой же
       синхронизации. */
    families: {
      keyPath: 'id',
      autoIncrement: false,
      indices: [
        { name: 'sharedDataKey', unique: true },
        { name: 'adminUserId', unique: false }
      ]
    },
    /* Этап 12.8: пользовательские категории платежей и задач */
    custom_categories: {
      keyPath: 'id',
      autoIncrement: true,
      indices: [
        { name: 'name', unique: false },
        { name: 'type', unique: false }
      ]
    }
  };

  /* ================================================================
     2. СИСТЕМА МИГРАЦИЙ
     ================================================================ */

  /**
   * Массив миграций базы данных.
   * Каждая миграция — { version: number, upgrade: function(db, transaction) }.
   * Версия элемента должна совпадать с его порядковым номером (1, 2, 3 ...),
   * тогда CURRENT_VERSION === MIGRATIONS.length.
   *
   * @type {Array<{version: number, upgrade: function(IDBDatabase, IDBTransaction): void}>}
   */
  var MIGRATIONS = [
    {
      version: 1,
      /**
       * Миграция v1: создаёт базовые 6 хранилищ с индексами.
       *
       * createObjectStore доступен только на объекте db внутри события
       * upgradeneeded. Индексы добавляем через transaction.objectStore(),
       * потому что хранилище в этой же транзакции уже существует.
       *
       * @param {IDBDatabase} db
       * @param {IDBTransaction} transaction — versionchange-транзакция
       */
      upgrade: function (db, transaction) {
        console.info('[DB] Миграция v1: создание хранилищ...');

        V1_STORES.forEach(function (storeName) {
          var schema = STORE_SCHEMAS[storeName];

          // Хранилище могло остаться от предыдущего частичного запуска
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, {
              keyPath: schema.keyPath,
              autoIncrement: schema.autoIncrement
            });
            console.info('[DB]   + store «' + storeName + '»');
          }

          var store = transaction.objectStore(storeName);

          schema.indices.forEach(function (idx) {
            if (!store.indexNames.contains(idx.name)) {
              store.createIndex(idx.name, idx.name, { unique: idx.unique });
              console.info('[DB]     + index «' + storeName + '.' + idx.name + '»');
            }
          });
        });

        console.info('[DB] Миграция v1 завершена: создано ' + V1_STORES.length + ' хранилищ.');
      }
    },
    {
      version: 2,
      /**
       * Миграция v2 (Этап 12.7): хранилище «families» для общего доступа.
       *
       * Только добавление нового store: старые данные не трогаем, поэтому
       * апгрейд обратим и не требует переписи записей. Отдельный store, а не
       * запись в settings, — семья это структурированный список участников,
       * который растёт и которым управляют два разных роли.
       *
       * @param {IDBDatabase} db
       * @param {IDBTransaction} transaction — versionchange-транзакция
       */
      upgrade: function (db, transaction) {
        console.info('[DB] Миграция v2: хранилище семей...');

        var schema = STORE_SCHEMAS.families;

        if (!db.objectStoreNames.contains('families')) {
          db.createObjectStore('families', {
            keyPath: schema.keyPath,
            autoIncrement: schema.autoIncrement
          });
          console.info('[DB]   + store «families»');
        }

        var store = transaction.objectStore('families');
        schema.indices.forEach(function (idx) {
          if (!store.indexNames.contains(idx.name)) {
            store.createIndex(idx.name, idx.name, { unique: idx.unique });
            console.info('[DB]     + index «families.' + idx.name + '»');
          }
        });

        console.info('[DB] Миграция v2 завершена.');
      }
    },
    {
      version: 3,
      /**
       * Миграция v3 (Этап 12.8): хранилище «custom_categories» для пользовательских категорий.
       * @param {IDBDatabase} db
       * @param {IDBTransaction} transaction — versionchange-транзакция
       */
      upgrade: function (db, transaction) {
        console.info('[DB] Миграция v3: создание хранилища custom_categories...');
        var schema = STORE_SCHEMAS.custom_categories;
        if (!db.objectStoreNames.contains('custom_categories')) {
          db.createObjectStore('custom_categories', {
            keyPath: schema.keyPath,
            autoIncrement: schema.autoIncrement
          });
          console.info('[DB]   + store «custom_categories»');
        }

        var store = transaction.objectStore('custom_categories');
        schema.indices.forEach(function (idx) {
          if (!store.indexNames.contains(idx.name)) {
            store.createIndex(idx.name, idx.name, { unique: idx.unique });
            console.info('[DB]     + index «custom_categories.' + idx.name + '»');
          }
        });
        console.info('[DB] Миграция v3 завершена.');
      }
    }
  ];

  /**
   * Применяет все миграции с version > oldVersion.
   * При ошибке откатывает versionchange-транзакцию, чтобы не осталось
   * частичной схемы, и возвращает текст ошибки.
   *
   * @param {IDBDatabase} db
   * @param {IDBVersionChangeEvent} event
   * @param {IDBOpenDBRequest} [request] — запрос открытия (фолбэк транзакции)
   * @returns {string|null} текст ошибки или null, если всё успешно
   */
  function runMigrations(db, event, request) {
    var oldVersion = event.oldVersion || 0;
    // В некоторых движках event.transaction недоступен на upgradeneeded —
    // берём versionchange-транзакцию из запроса открытия.
    var transaction = event.transaction || (request && request.transaction) || null;

    console.info('[DB] Требуется миграция: v' + oldVersion + ' → v' + CURRENT_VERSION);

    var applicable = MIGRATIONS.filter(function (m) {
      return m.version > oldVersion;
    });

    if (applicable.length === 0) {
      console.info('[DB] Миграции не требуются — база уже актуальна.');
      return null;
    }

    for (var i = 0; i < applicable.length; i++) {
      var migration = applicable[i];
      try {
        migration.upgrade(db, transaction);
        console.info('[DB] Миграция v' + migration.version + ' применена успешно.');
      } catch (err) {
        console.error('[DB] Ошибка миграции v' + migration.version + ':', err);
        try {
          transaction.abort();
        } catch (ignored) {
          // Транзакция могла быть уже закрыта браузером
        }
        return 'Ошибка применения миграции v' + migration.version + ': ' + err.message;
      }
    }

    return null;
  }

  /* ================================================================
     3. СОЕДИНЕНИЕ И ТРАНЗАКЦИИ
     ================================================================ */

  /** @type {IDBDatabase|null} Единственное открытое соединение — переиспользуется */
  var dbConnection = null;

  /** @type {Promise|null} Промис инициализации: защищает от повторного открытия */
  var initPromise = null;

  /**
   * Оборачивает промис таймаутом.
   * @param {Promise} promise
   * @param {number} timeoutMs
   * @returns {Promise}
   */
  function withTimeout(promise, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('Превышен таймаут операции (' + timeoutMs + ' мс). База данных не отвечает.'));
      }, timeoutMs);

      promise.then(
        function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        function (err) {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  /**
   * Открывает соединение с IndexedDB и применяет миграции.
   * @returns {Promise<IDBDatabase>}
   */
  function openDatabase() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('Браузер не поддерживает IndexedDB. Работа приложения невозможна.'));
        return;
      }

      var request = indexedDB.open(DB_NAME, CURRENT_VERSION);

      /** @type {string|null} Ошибка миграции — если задана, соединение не отдаём */
      var migrationError = null;

      request.onupgradeneeded = function (event) {
        migrationError = runMigrations(event.target.result, event, request);
      };

      request.onsuccess = function (event) {
        var db = event.target.result;

        if (migrationError) {
          db.close();
          reject(new Error(migrationError));
          return;
        }

        // Соединение закрылось извне: другая вкладка обновила схему или база удалена
        db.onversionchange = function () {
          console.info('[DB] Соединение закрыто: versionchange.');
          db.close();
          dbConnection = null;
          initPromise = null;
        };

        // Браузер закрыл соединение сам (нехватка места, выгрузка вкладки
        // из памяти на мобильных, очистка сайта пользователем). Без этого
        // обработчика dbConnection остался бы указывать на мёртвое соединение,
        // и любая операция падала бы с InvalidStateError навсегда.
        db.onclose = function () {
          console.info('[DB] Соединение закрыто браузером (close).');
          dbConnection = null;
          initPromise = null;
        };

        db.onabort = function () {
          console.error('[DB] Соединение прервано (abort).');
          dbConnection = null;
          initPromise = null;
        };

        console.info('[DB] База «' + DB_NAME + '» открыта, версия ' + db.version + '.');
        resolve(db);
      };

      request.onerror = function (event) {
        var err = event.target.error;
        console.error('[DB] Ошибка открытия базы:', err);

        var reason = err && err.name === 'VersionError'
          ? 'База данных имеет более новую версию, чем приложение. Обновите страницу.'
          : 'Не удалось открыть базу данных: ' + (err ? err.message : 'неизвестная ошибка');

        reject(new Error(reason));
      };

      request.onblocked = function () {
        console.error('[DB] Открытие заблокировано: база занята другой вкладкой.');
        reject(new Error('База данных занята другой вкладкой. Закройте её и обновите страницу.'));
      };
    });
  }

  /**
   * Возвращает активное соединение или бросает ошибку.
   * @returns {IDBDatabase}
   */
  function getConnection() {
    if (!dbConnection) {
      throw new Error('База данных не инициализирована. Сначала вызовите DB.init().');
    }
    return dbConnection;
  }

  /**
   * Ошибка «соединение мертво»: db.transaction() на закрытой базе бросает
   * InvalidStateError, а операции, выполненные до того, как наш обработчик
   * успел обнулить dbConnection, отдают DatabaseClosedError.
   * @param {*} err
   * @returns {boolean}
   */
  function isDeadConnectionError(err) {
    var name = err && (err.name || (err.error && err.error.name));
    if (name === 'InvalidStateError' || name === 'DatabaseClosedError') { return true; }
    // withStore/withConnection оборачивают нативную ошибку в текст —
    // поэтому смотрим и на сообщение: оно содержит name исходной ошибки.
    var text = String((err && err.message) || '');
    return /InvalidStateError|DatabaseClosedError|не инициализирована/i.test(text);
  }

  /** @type {Promise|null} Одновременные попытки переподключения схлопываем в одну */
  var reconnectPromise = null;

  /**
   * Закрывает мёртвое соединение и открывает новое. Параллельные вызовы
   * получают один и тот же промис — иначе N упавших операций открыли бы
   * N соединений и оставили бы лишние ссылки на IDBDatabase.
   * @returns {Promise<IDBDatabase>}
   */
  function reconnect() {
    if (reconnectPromise) { return reconnectPromise; }

    try { if (dbConnection) { dbConnection.close(); } } catch (ignored) { /* уже закрыто */ }
    dbConnection = null;
    initPromise = null;

    reconnectPromise = init()
      .then(function () {
        reconnectPromise = null;
        if (!dbConnection) {
          throw new Error('Не удалось восстановить соединение с базой данных.');
        }
        return dbConnection;
      })
      .catch(function (err) {
        reconnectPromise = null;
        throw err;
      });

    return reconnectPromise;
  }

  /**
   * Выполняет action(db) на живом соединении, при необходимости
   * восстанавливая его.
   *
   * Точка самолечения (Этап 11, критический баг №1). Раньше при потере
   * соединения (другая вкладка удалила базу или подняла версию схемы,
   * браузер закрыл соединение в мобильном WebView) dbConnection
   * становился null или «протухшим», а приложение продолжало считать,
   * что база готова: window.DB_READY оставался true. Все разделы
   * показывали «База данных не инициализирована», а кнопка «Попробовать
   * снова» не помогала — данные были целы, но недоступны до перезагрузки.
   *
   * Теперь каждая операция берёт соединение через этот helper: в норме
   * это готовый объект без лишних транзакций (важно для скорости), а при
   * InvalidStateError — одно переподключение и один повтор. Повтор
   * безопасен: отменённая транзакция IndexedDB атомарна, изменений нет.
   *
   * @param {function(IDBDatabase): Promise} action
   * @returns {Promise}
   */
  function withConnection(action) {
    var ready = dbConnection
      ? Promise.resolve(dbConnection)
      : init().then(function () { return dbConnection; });

    return ready.then(action).catch(function (err) {
      if (!isDeadConnectionError(err)) { throw err; }

      console.warn('[DB] Соединение оказалось нерабочим — переподключаемся и повторяем операцию.');
      return reconnect().then(action);
    });
  }

  /**
   * Проверяет имя хранилища по белому списку.
   * @param {string} storeName
   */
  function assertStore(storeName) {
    if (STORES.indexOf(storeName) === -1) {
      throw new Error('Неизвестное хранилище: «' + storeName + '». Доступные: ' + STORES.join(', ') + '.');
    }
  }

  /**
   * Выполняет операцию над одним хранилищем в отдельной транзакции с таймаутом.
   * Транзакция закрывается браузером автоматически по завершении —
   * ссылок на неё не держим, утечек памяти нет.
   *
   * @param {string} storeName — имя object store
   * @param {string} mode — 'readonly' | 'readwrite'
   * @param {function(IDBObjectStore): Promise} callback — должна вернуть Promise результата
   * @returns {Promise}
   */
  function withStore(storeName, mode, callback) {
    try {
      assertStore(storeName);
    } catch (err) {
      return Promise.reject(err);
    }

    // Соединение берём через withConnection: если оно было потеряно
    // (versionchange, onclose, нехватка места) — операция повторится сама.
    return withConnection(function (db) {
      var operation = new Promise(function (resolve, reject) {
      var transaction;
      try {
        transaction = db.transaction(storeName, mode);
      } catch (err) {
        reject(new Error('Не удалось открыть транзакцию в «' + storeName + '»: ' + err.message));
        return;
      }

      var settled = false;
      var store = transaction.objectStore(storeName);

      // Результат callback перехватываем сами: throw внутри может оставить
      // транзакцию незавершённой
      try {
        Promise.resolve(callback(store)).then(
          function (value) {
            settled = true;
            resolve(value);
          },
          function (err) {
            settled = true;
            reject(err);
          }
        );
      } catch (err) {
        settled = true;
        reject(err);
      }

      transaction.onerror = function (event) {
        if (settled) { return; }
        var err = event.target.error;
        console.error('[DB] Ошибка транзакции [' + storeName + ']:', err);
        reject(new Error('Ошибка транзакции в «' + storeName + '»: ' + (err ? err.message : 'неизвестно')));
      };

      transaction.onabort = function (event) {
        if (settled) { return; }
        var err = event.target.error;
        console.error('[DB] Транзакция отменена [' + storeName + ']:', err);
        reject(new Error('Операция отменена в «' + storeName + '» — данные не изменены: ' + (err ? err.message : 'неизвестно')));
      };
      });

      return withTimeout(operation, OPERATION_TIMEOUT);
    });
  }

  /* ================================================================
     4. ВАЛИДАЦИЯ ДАННЫХ
     ================================================================ */

  /**
   * Проверяет, что значение — валидная дата (ISO 8601 строка или Date).
   * Числа-таймстампы считаются невалидными: по контракту храним строки.
   *
   * Строгая календарная проверка обязательна (Этап 11, критический баг №5):
   * new Date('2026-02-31') не является Invalid Date — JS молча переносит его
   * на 3 марта. Из-за этого несуществующая дата попадала в базу, а UI
   * показывал «03.03.2026»: данные хранились одни, пользователю демонстрировались
   * другие, и никакой ошибки не было видно. Теперь день проверяется по
   * фактической длине месяца, а для строк дополнительно сверяется формат.
   * @param {*} value
   * @returns {boolean}
   */
  function isValidDate(value) {
    if (typeof value === 'number') {
      return false;
    }

    if (value instanceof Date) {
      return !isNaN(value.getTime());
    }

    if (typeof value !== 'string' || !value) {
      return false;
    }

    // Разбираем YYYY-MM-DD (допускается время и часовой пояс в хвосте)
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(value);
    if (!m) {
      return false;
    }

    var year = Number(m[1]);
    var month = Number(m[2]);
    var day = Number(m[3]);

    if (month < 1 || month > 12 || day < 1) {
      return false;
    }

    // Фактическая длина месяца: 31.02 и 29.02 в невисокосном году — не даты
    var daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day > daysInMonth) {
      return false;
    }

    return !isNaN(new Date(value).getTime());
  }

  /**
   * Поля-даты, которые должны существовать в конкретном хранилище.
   * @type {Object.<string, string[]>}
   */
  var DATE_FIELDS = {
    payments: ['date'],
    tasks: ['dueDate'],
    documents: ['issuedDate', 'expiryDate'],
    meter_readings: ['date']
  };

  /**
   * Валидаторы по хранилищам. Каждый возвращает текст ошибки или null.
   * @type {Object.<string, function(Object): (string|null)>}
   */
  var VALIDATORS = {
    payments: function (data) {
      if (data.amount !== undefined && !Number.isInteger(data.amount)) {
        return 'payments.amount должно быть целым числом копеек. Получено: ' + JSON.stringify(data.amount);
      }
      return null;
    },
    meter_readings: function (data) {
      if (data.meterId !== undefined && !Number.isInteger(data.meterId)) {
        return 'meter_readings.meterId должно быть целым числом.';
      }
      return null;
    },
    meters: function (data) {
      if (data.type !== undefined && typeof data.type !== 'string') {
        return 'meters.type должно быть строкой.';
      }
      return null;
    },
    settings: function (data) {
      // key обязателен только при добавлении — см. assertRequiredKey
      if (data.key !== undefined && typeof data.key !== 'string') {
        return 'settings.key должен быть строкой.';
      }
      return null;
    }
  };

  /**
   * Проверяет наличие первичного ключа при добавлении записи.
   * Для хранилищ с autoIncrement ключ генерируется автоматически.
   * @param {string} storeName
   * @param {Object} data
   * @throws {Error} если ключ обязателен и отсутствует
   */
  function assertRequiredKey(storeName, data) {
    var schema = STORE_SCHEMAS[storeName];

    if (schema.autoIncrement) {
      return;
    }

    if (data[schema.keyPath] === undefined || data[schema.keyPath] === null) {
      throw new Error(
        'Валидация не пройдена — ' + storeName + '.' + schema.keyPath +
        ' обязателен: это первичный ключ хранилища.'
      );
    }
  }

  /**
   * Прогоняет данные через валидатор хранилища и проверку дат.
   * @param {string} storeName
   * @param {Object} data
   * @throws {Error} при невалидных данных
   */
  function validateData(storeName, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Данные для «' + storeName + '» должны быть объектом.');
    }

    var validator = VALIDATORS[storeName];
    if (validator) {
      var error = validator(data);
      if (error) {
        throw new Error('Валидация не пройдена — ' + error);
      }
    }

    var dateFields = DATE_FIELDS[storeName];
    if (dateFields) {
      for (var i = 0; i < dateFields.length; i++) {
        var field = dateFields[i];
        if (data[field] !== undefined && !isValidDate(data[field])) {
          throw new Error(
            'Валидация не пройдена — ' + storeName + '.' + field +
            ' должно быть строкой ISO 8601. Получено: ' + JSON.stringify(data[field])
          );
        }
      }
    }
  }

  /**
   * Проставляет служебные поля.
   * createdAt — только при добавлении; updatedAt — всегда.
   * uid — стабильный глобальный идентификатор записи (Этап 12.7).
   *
   * Зачем uid, если есть id: id выдаёт IndexedDB локально (autoIncrement),
   * поэтому у двух участников семьи первый платёж будет иметь один и тот же
   * id=1. Слияние по id породило бы дубликаты и «перетирание» чужих записей.
   * uid — uuid создателя+счётчик, он уникален между устройствами и переживает
   * экспорт/импорт, поэтому именно он ключ слияния.
   *
   * @param {Object} record — запись (мутируется и возвращается)
   * @param {boolean} isNew — true для add
   * @returns {Object}
   */
  function stampTimestamps(record, isNew) {
    var now = new Date().toISOString();

    if (isNew && !record.createdAt) {
      record.createdAt = now;
    }
    record.updatedAt = now;

    if (isNew && !record.uid) {
      record.uid = makeUid();
    }

    return record;
  }

  /**
   * uuid v4 (нативный крипто-генератор, с фолбэком на Math.random для
   * старых движков без crypto.randomUUID).
   * @returns {string}
   */
  function makeUid() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') {
      try { return c.randomUUID(); } catch (err) { /* уходим на ручной вариант */ }
    }
    if (c && typeof c.getRandomValues === 'function') {
      var b = new Uint8Array(16);
      c.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var hex = [];
      for (var i = 0; i < 16; i++) { hex.push((b[i] + 0x100).toString(16).slice(1)); }
      return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
        hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
        hex.slice(10, 16).join('');
    }
    var fallback = '';
    for (var j = 0; j < 36; j++) {
      fallback += (j === 8 || j === 13 || j === 18 || j === 23) ? '-'
        : (j === 14 ? '4' : Math.floor(Math.random() * 16).toString(16));
    }
    return fallback;
  }

  /* ================================================================
     5. ИНИЦИАЛИЗАЦИЯ
     ================================================================ */

  /**
   * Открывает базу и применяет миграции.
   * Повторные вызовы переиспользуют то же соединение.
   * @returns {Promise<{db: IDBDatabase, version: number}>}
   */
  function init() {
    if (dbConnection) {
      console.info('[DB] init(): соединение уже открыто, пропускаем.');
      return Promise.resolve({ db: dbConnection, version: dbConnection.version });
    }

    if (!initPromise) {
      initPromise = openDatabase().then(function (db) {
        dbConnection = db;
        return { db: db, version: db.version };
      }).catch(function (err) {
        // Разрешаем повторную попытку после неудачи
        initPromise = null;
        dbConnection = null;
        console.error('[DB] init() завершился ошибкой:', err.message);
        throw err;
      });
    }

    return initPromise;
  }

  /* ================================================================
     6. УНИВЕРСАЛЬНЫЙ CRUD
     ================================================================ */

  /**
   * Добавляет запись.
   * @param {string} storeName — имя хранилища
   * @param {Object} data — данные (без id: он автоинкрементный)
   * @returns {Promise<number>} id новой записи
   */
  function add(storeName, data) {
    var record;

    try {
      validateData(storeName, data);
      assertRequiredKey(storeName, data);
      // Копия: не мутируем объект вызывающего кода
      record = stampTimestamps(Object.assign({}, data), true);
    } catch (err) {
      return Promise.reject(err);
    }

    return withStore(storeName, 'readwrite', function (store) {
      return new Promise(function (resolve, reject) {
        var request = store.add(record);
        request.onsuccess = function () {
          console.info('[DB] add(«' + storeName + '») → id=' + request.result);
          resolve(request.result);
        };
        request.onerror = function (event) {
          console.error('[DB] add(«' + storeName + '») — ошибка:', event.target.error);
          reject(new Error('Не удалось добавить запись в «' + storeName + '»: ' + event.target.error.message));
        };
      });
    });
  }

  /**
   * Получает одну запись по ключу.
   * @param {string} storeName — имя хранилища
   * @param {(number|string)} id — ключ записи
   * @returns {Promise<Object|null>} запись или null, если не найдена
   */
  function get(storeName, id) {
    return withStore(storeName, 'readonly', function (store) {
      return new Promise(function (resolve, reject) {
        var request = store.get(id);
        request.onsuccess = function () {
          resolve(request.result === undefined ? null : request.result);
        };
        request.onerror = function (event) {
          console.error('[DB] get(«' + storeName + '») — ошибка:', event.target.error);
          reject(new Error('Не удалось прочитать запись из «' + storeName + '»: ' + event.target.error.message));
        };
      });
    });
  }

  /**
   * Получает все записи хранилища.
   * @param {string} storeName — имя хранилища
   * @returns {Promise<Object[]>}
   */
  function getAll(storeName) {
    return withStore(storeName, 'readonly', function (store) {
      return new Promise(function (resolve, reject) {
        var request = store.getAll();
        request.onsuccess = function () {
          console.info('[DB] getAll(«' + storeName + '») → ' + request.result.length + ' записей');
          resolve(request.result || []);
        };
        request.onerror = function (event) {
          console.error('[DB] getAll(«' + storeName + '») — ошибка:', event.target.error);
          reject(new Error('Не удалось получить записи из «' + storeName + '»: ' + event.target.error.message));
        };
      });
    });
  }

  /**
   * Обновляет запись: merge с существующей.
   * createdAt не перезаписывается, updatedAt обновляется.
   * Первичный ключ защищён от изменения.
   *
   * @param {string} storeName — имя хранилища
   * @param {(number|string)} id — ключ записи
   * @param {Object} data — новые значения полей
   * @returns {Promise<Object>} обновлённая запись
   */
  function update(storeName, id, data) {
    try {
      assertStore(storeName);
      validateData(storeName, data);
    } catch (err) {
      return Promise.reject(err);
    }

    var keyPath = STORE_SCHEMAS[storeName].keyPath;

    return withStore(storeName, 'readwrite', function (store) {
      return new Promise(function (resolve, reject) {
        var getRequest = store.get(id);

        getRequest.onsuccess = function () {
          var existing = getRequest.result;

          if (!existing) {
            reject(new Error('Запись с ключом ' + JSON.stringify(id) + ' не найдена в «' + storeName + '».'));
            return;
          }

          var updated = Object.assign({}, existing, data);

          // Первичный ключ и createdAt неприкосновенны
          updated[keyPath] = existing[keyPath];
          if (existing.createdAt) {
            updated.createdAt = existing.createdAt;
          }
          updated.updatedAt = new Date().toISOString();

          // Все наши хранилища используют in-line ключи (keyPath),
          // поэтому ключ передавать вторым аргументом нельзя — Chrome бросит DataError.
          var putRequest = store.put(updated);
          putRequest.onsuccess = function () {
            console.info('[DB] update(«' + storeName + '») → id=' + id);
            resolve(updated);
          };
          putRequest.onerror = function (event) {
            console.error('[DB] update(«' + storeName + '») — ошибка:', event.target.error);
            reject(new Error('Не удалось обновить запись в «' + storeName + '»: ' + event.target.error.message));
          };
        };

        getRequest.onerror = function (event) {
          console.error('[DB] update: чтение перед записью не удалось:', event.target.error);
          reject(new Error('Не удалось прочитать запись перед обновлением: ' + event.target.error.message));
        };
      });
    });
  }

  /**
   * Удаляет запись по ключу.
   * Внутреннее имя remove: delete — зарезервированное слово, оно недопустимо
   * как имя объявления функции. Наружу отдаётся как DB.delete.
   *
   * @param {string} storeName — имя хранилища
   * @param {(number|string)} id — ключ записи
   * @returns {Promise<void>}
   */
  function remove(storeName, id) {
    return withStore(storeName, 'readwrite', function (store) {
      return new Promise(function (resolve, reject) {
        var request = store.delete(id);
        request.onsuccess = function () {
          console.info('[DB] delete(«' + storeName + '») → id=' + id);
          resolve();
        };
        request.onerror = function (event) {
          console.error('[DB] delete(«' + storeName + '») — ошибка:', event.target.error);
          reject(new Error('Не удалось удалить запись из «' + storeName + '»: ' + event.target.error.message));
        };
      });
    });
  }

  /**
   * Полностью очищает хранилище. Требует явного подтверждения.
   * @param {string} storeName — имя хранилища
   * @param {boolean} confirm — должно быть строго true
   * @returns {Promise<void>}
   */
  function clear(storeName, confirm) {
    if (confirm !== true) {
      return Promise.reject(new Error(
        'DB.clear(«' + storeName + '») требует подтверждения: передайте confirm=true, ' +
        'чтобы случайно не удалить данные.'
      ));
    }

    return withStore(storeName, 'readwrite', function (store) {
      return new Promise(function (resolve, reject) {
        var request = store.clear();
        request.onsuccess = function () {
          console.info('[DB] Хранилище «' + storeName + '» очищено.');
          resolve();
        };
        request.onerror = function (event) {
          console.error('[DB] clear(«' + storeName + '») — ошибка:', event.target.error);
          reject(new Error('Не удалось очистить «' + storeName + '»: ' + event.target.error.message));
        };
      });
    });
  }

  /* ================================================================
     7. СПЕЦИФИЧНЫЕ ЗАПРОСЫ
     ================================================================ */

  /**
   * Выбирает записи по значению индекса.
   * @param {string} storeName — имя хранилища
   * @param {string} indexName — имя индекса
   * @param {*} value — точное значение или IDBKeyRange
   * @returns {Promise<Object[]>}
   */
  function getByIndex(storeName, indexName, value) {
    try {
      assertStore(storeName);
    } catch (err) {
      return Promise.reject(err);
    }

    return withStore(storeName, 'readonly', function (store) {
      if (!store.indexNames.contains(indexName)) {
        throw new Error(
          'Индекс «' + indexName + '» не существует в «' + storeName + '». ' +
          'Доступные: ' + Array.prototype.slice.call(store.indexNames).join(', ') + '.'
        );
      }

      return new Promise(function (resolve, reject) {
        var request = store.index(indexName).getAll(value);
        request.onsuccess = function () {
          console.info('[DB] getByIndex(«' + storeName + '.' + indexName + '») → ' + request.result.length + ' записей');
          resolve(request.result || []);
        };
        request.onerror = function (event) {
          console.error('[DB] getByIndex — ошибка:', event.target.error);
          reject(new Error('Не удалось выполнить поиск по индексу «' + indexName + '»: ' + event.target.error.message));
        };
      });
    });
  }

  /**
   * Количество записей в хранилище.
   * @param {string} storeName — имя хранилища
   * @returns {Promise<number>}
   */
  function count(storeName) {
    return withStore(storeName, 'readonly', function (store) {
      return new Promise(function (resolve, reject) {
        var request = store.count();
        request.onsuccess = function () {
          resolve(request.result);
        };
        request.onerror = function (event) {
          console.error('[DB] count(«' + storeName + '») — ошибка:', event.target.error);
          reject(new Error('Не удалось подсчитать записи в «' + storeName + '»: ' + event.target.error.message));
        };
      });
    });
  }

  /* ================================================================
     8. ЭКСПОРТ / ИМПОРТ
     ================================================================ */

  /**
   * Экспортирует все данные из всех хранилищ в один объект.
   * Одна readonly-транзакция на все stores — согласованный снимок.
   * @returns {Promise<Object>} — { payments: [...], meters: [...], ... }
   */
  function exportAll() {
    return withConnection(function (db) {
    var operation = new Promise(function (resolve, reject) {
      var transaction;
      try {
        transaction = db.transaction(STORES, 'readonly');
      } catch (err) {
        reject(new Error('Не удалось открыть транзакцию экспорта: ' + err.message));
        return;
      }

      var result = {};

      STORES.forEach(function (storeName) {
        var request = transaction.objectStore(storeName).getAll();
        request.onsuccess = function () {
          result[storeName] = request.result || [];
        };
      });

      // Резолвим только на oncomplete: к этому моменту все данные собраны
      transaction.oncomplete = function () {
        var summary = STORES.map(function (s) {
          return s + ': ' + (result[s] || []).length;
        }).join(', ');
        console.info('[DB] Экспорт завершён — ' + summary);
        resolve(result);
      };

      transaction.onerror = function (event) {
        console.error('[DB] Ошибка экспорта:', event.target.error);
        reject(new Error('Экспорт данных не удался: ' + (event.target.error ? event.target.error.message : 'неизвестно')));
      };

      transaction.onabort = function (event) {
        reject(new Error('Экспорт отменён: ' + (event.target.error ? event.target.error.message : 'неизвестно')));
      };
    });

    return withTimeout(operation, OPERATION_TIMEOUT);
    });
  }

  /**
   * Импортирует данные из дампа exportAll().
   * Структура проверяется до начала запис; существующие ключи НЕ перезаписываются.
   * Служебные поля createdAt / updatedAt сохраняются как в дампе.
   *
   * @param {Object} data — объект { payments: [...], ... }
   * @returns {Promise<{imported: number, skipped: number, errors: string[]}>}
   */
  function importAll(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return Promise.reject(new Error('Данные импорта должны быть объектом — результатом DB.exportAll().'));
    }

    var storeNames = Object.keys(data);

    // Проверка структуры выполняется до начала записи
    for (var i = 0; i < storeNames.length; i++) {
      var name = storeNames[i];
      if (STORES.indexOf(name) === -1) {
        return Promise.reject(new Error(
          'Неизвестное хранилище в импорте: «' + name + '». Ожидаемые: ' + STORES.join(', ') + '.'
        ));
      }
      if (!Array.isArray(data[name])) {
        return Promise.reject(new Error('Поле «' + name + '» в импорте должно быть массивом.'));
      }
    }

    var stats = { imported: 0, skipped: 0, errors: [] };

    return withConnection(function (db) {
    var operation = new Promise(function (resolve, reject) {
      var transaction;
      try {
        transaction = db.transaction(STORES, 'readwrite');
      } catch (err) {
        reject(new Error('Не удалось открыть транзакцию импорта: ' + err.message));
        return;
      }

      var aborted = false;

      transaction.onabort = function (event) {
        aborted = true;
        console.error('[DB] Транзакция импорта отменена:', event.target.error);
        reject(new Error('Импорт отменён — данные не изменены.'));
      };

      storeNames.forEach(function (storeName) {
        var keyPath = STORE_SCHEMAS[storeName].keyPath;
        var store = transaction.objectStore(storeName);

        data[storeName].forEach(function (record) {
          if (aborted) { return; }

          if (!record || typeof record !== 'object' || Array.isArray(record)) {
            stats.skipped++;
            stats.errors.push('«' + storeName + '»: запись не является объектом — пропущена.');
            return;
          }

          var key = record[keyPath];
          if (key === undefined || key === null) {
            stats.skipped++;
            stats.errors.push('«' + storeName + '»: отсутствует ключ «' + keyPath + '» — пропущена.');
            return;
          }

          // Импорт — прямая запись в обход DB.add, поэтому валидация нужна
          // здесь (Этап 11, критический баг №5): иначе файл с несуществующей
          // датой вроде «2026-02-31» лёг бы в базу и UI показал бы другую дату.
          try {
            validateData(storeName, record);
          } catch (err) {
            stats.skipped++;
            stats.errors.push('«' + storeName + '» key=' + key + ': ' + err.message);
            return;
          }

          // Проверяем конфликт и НЕ перезаписываем существующую запись
          var checkRequest = store.get(key);

          checkRequest.onsuccess = function () {
            if (aborted) { return; }

            if (checkRequest.result !== undefined) {
              stats.skipped++;
              return;
            }

            var putRequest = store.put(record);
            putRequest.onsuccess = function () {
              stats.imported++;
            };
            putRequest.onerror = function (event) {
              stats.skipped++;
              stats.errors.push('«' + storeName + '» key=' + key + ': ' + event.target.error.message);
            };
          };

          checkRequest.onerror = function (event) {
            stats.skipped++;
            stats.errors.push('«' + storeName + '» key=' + key + ' (чтение): ' + event.target.error.message);
          };
        });
      });

      transaction.oncomplete = function () {
        console.info('[DB] Импорт завершён: добавлено ' + stats.imported + ', пропущено ' + stats.skipped + '.');
        resolve(stats);
      };

      transaction.onerror = function (event) {
        if (aborted) { return; }
        console.error('[DB] Ошибка импорта:', event.target.error);
        reject(new Error('Импорт данных не удался: ' + (event.target.error ? event.target.error.message : 'неизвестно')));
      };
    });

    return withTimeout(operation, OPERATION_TIMEOUT);
    });
  }

  /* ================================================================
     9. ПУБЛИЧНЫЙ API — window.DB
     ================================================================ */

  window.DB = {
    /** @returns {Promise<{db: IDBDatabase, version: number}>} Инициализация базы */
    init: init,

    // --- Универсальный CRUD ---
    /** @returns {Promise<number>} id новой записи */
    add: add,
    /** @returns {Promise<Object|null>} */
    get: get,
    /** @returns {Promise<Object[]>} */
    getAll: getAll,
    /** @returns {Promise<Object>} обновлённая запись */
    update: update,
    /** @returns {Promise<void>} */
    delete: remove,
    /** @returns {Promise<void>} */
    clear: clear,

    // --- Запросы ---
    /** @returns {Promise<Object[]>} */
    getByIndex: getByIndex,
    /** @returns {Promise<number>} */
    count: count,

    // --- Дамп ---
    /** @returns {Promise<Object>} */
    exportAll: exportAll,
    /** @returns {Promise<{imported: number, skipped: number, errors: string[]}>} */
    importAll: importAll,

    // --- Инспекция ---
    /** @returns {number} Текущая версия схемы */
    getVersion: function () {
      return CURRENT_VERSION;
    },
    /** @returns {string} Имя базы */
    getName: function () {
      return DB_NAME;
    },
    /** @returns {string[]} Список хранилищ */
    getStores: function () {
      return STORES.slice();
    },
    /** @returns {boolean} Открыто ли соединение */
    isReady: function () {
      return dbConnection !== null;
    }
  };

  /* ================================================================
     10. СОБЫТИЕ ИЗМЕНЕНИЯ ДАННЫХ (Этап 12.5, PRO)
     ================================================================
     *
     * Модулям нужен сигнал «в базе что-то поменялось», не привязанный к
     * конкретному вызову: запись может прийти из UI, из импорта резервной
     * копии или напрямую через window.DB (тесты, cloud-sync). Поэтому
     * событие рассылает сам публичный API, а не каждый модуль-вызыватель.
     *
     * Обёрнуты ТОЛЬКО мутаторы. Читающие методы (get/getAll/count/...)
     * остаются нетронутыми — на них завязана производительность статистики
     * и списков, и лишних Promise там быть не должно.
     *
     * Тип события: 'db:change', detail = { store, kind }.
     * kind: 'create' | 'update' | 'delete' | 'clear' | 'import'.
     */

  /**
   * Рассылает событие об изменении. Ошибку диспатча не считаем ошибкой
   * записи: данные уже в IndexedDB, а подписчики (cloud-sync) — факультативны.
   * @param {string} store
   * @param {string} kind
   */
  function emitChange(store, kind) {
    try {
      window.dispatchEvent(new CustomEvent('db:change', {
        detail: { store: store, kind: kind, at: Date.now() }
      }));
    } catch (err) {
      console.warn('[DB] Не удалось отправить событие db:change:', err);
    }
  }

  /**
   * Обёртывает мутатор, возвращая Promise с побочным эффектом — событием.
   * @param {Function} fn — исходный метод
   * @param {string} kind — тип изменения
   * @param {number} storeArg — позиция имени хранилища в аргументах
   * @returns {Function}
   */
  function withChangeNotification(fn, kind, storeArg) {
    return function () {
      var store = typeof arguments[storeArg] === 'string' ? arguments[storeArg] : 'all';
      var result;

      try {
        result = fn.apply(null, arguments);
      } catch (err) {
        return Promise.reject(err);
      }

      return Promise.resolve(result).then(function (value) {
        emitChange(store, kind);
        return value;
      });
    };
  }

  window.DB.add = withChangeNotification(add, 'create', 0);
  window.DB.update = withChangeNotification(update, 'update', 0);
  window.DB.delete = withChangeNotification(remove, 'delete', 0);
  window.DB.clear = withChangeNotification(clear, 'clear', 0);
  window.DB.importAll = withChangeNotification(importAll, 'import', -1);

  console.info('[DB] Модуль загружен. API: window.DB + событие db:change');
})();
