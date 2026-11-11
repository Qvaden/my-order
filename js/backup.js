/**
 * МОЙ ПОРЯДОК — Раздел «Резервные копии» (Этап 9)
 *
 * Экспорт / импорт / очистка данных через IndexedDB (window.DB).
 * Формат дампа: { version, exportDate, appName, data: { payments, meters, meter_readings, documents, tasks } }
 *
 * Использует существующие методы DB: exportAll(), clear(), importAll().
 * Не меняет логику существующих модулей.
 *
 * Экспортирует window.Backup.
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  var APP_NAME = 'MyOrder';
  var DATA_VERSION = 1;

  /** Имена stores, участвующих в бэкапе */
  var BACKUP_STORES = ['payments', 'meters', 'meter_readings', 'documents', 'tasks'];

  /**
   * Все хранилища, которые DB.importAll вообще способен принять.
   * settings в бэкап не кладётся (это настройки приложения, а не данные
   * пользователя), но в дампе встречу с ним tolerate надо: он разрешён.
   */
  var KNOWN_STORES = BACKUP_STORES.concat(['settings', 'families', 'custom_categories']);

  /** Обязательные поля каждой записи */
  var REQUIRED_FIELDS = {
    payments:       ['id', 'title', 'amount', 'date', 'category'],
    meters:         ['id', 'name', 'type'],
    meter_readings: ['id', 'meterId', 'value', 'date'],
    documents:      ['id', 'name', 'expiryDate'],
    tasks:          ['id', 'title', 'dueDate']
  };

  /* ================================================================
     2. СОСТОЯНИЕ
     ================================================================ */

  var listenersBound = false;
  var _appEl = null;

  /**
   * Этап 12.6: слушатель 'notif:state' вешается ровно один раз — он читает
   * #app в момент события, поэтому перерисовки раздела его не размножают.
   * @type {boolean}
   */
  var notifStateBound = false;

  /**
   * Сообщение, которое нужно показать сразу после ближайшего render():
   * innerHTML раздела стирает все подписи, поэтому обычный showStatus
   * до перерисовки пользователь бы не увидел.
   * @type {?{key: string, msg: string, level: string}}
   */
  var pendingStatus = null;

  /* ================================================================
     3. УТИЛИТЫ
     ================================================================ */

  function esc(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    if (!iso) return '\u2014';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    return m ? (m[3] + '.' + m[2] + '.' + m[1]) : String(iso);
  }

  function formatDateTime(iso) {
    if (!iso) return '\u2014';
    var m = /^(\d{4})-(\d{2})-(\d{2})T?(\d{2}):?(\d{2})/.exec(String(iso));
    if (!m) return formatDate(iso);
    return m[3] + '.' + m[2] + '.' + m[1] + ' ' + m[4] + ':' + (m[5] || '00');
  }

  function getAppEl() {
    if (!_appEl) _appEl = document.getElementById('app');
    return _appEl;
  }

  /**
   * Открывает модалку в стиле design-system:
   * <div.modal-overlay><div.modal-content>…</div></div>
   * с is-open на overlay, modal-open на body, ESC-close.
   */
  function openModal(innerHtml, onMount) {
    // Защита от «стопки» одинаковых диалогов (Этап 11, баг №6): повторный
    // клик по кнопке «Импорт»/«Удалить всё» открывал несколько идентичных
    // подтверждений сразу. Диалог с тем же содержимым, который уже открыт,
    // повторно не открываем.
    var opened = document.querySelectorAll('.modal-overlay');
    for (var i = 0; i < opened.length; i++) {
      if (!opened[i]._closing && opened[i]._signature === innerHtml) { return; }
    }

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay._signature = innerHtml;

    var card = document.createElement('div');
    card.className = 'modal-content';
    card.innerHTML = innerHtml;

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add('modal-open');

    requestAnimationFrame(function () {
      overlay.classList.add('is-open');
    });

    function close() {
      closeModal(overlay);
    }

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    overlay._onKeydown = function (e) {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', overlay._onKeydown);

    if (onMount) onMount(card, close);
  }

  function closeModal(overlay) {
    if (!overlay || overlay._closing) return;
    overlay._closing = true;

    document.removeEventListener('keydown', overlay._onKeydown);
    overlay.classList.remove('is-open');

    setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (!document.querySelector('.modal-overlay')) {
        document.body.classList.remove('modal-open');
      }
    }, 250);
  }

  /* ================================================================
     4. ВАЛИДАЦИЯ ИМПОРТА
     ================================================================ */

  function validateImport(data) {
    var errors = [];
    var warnings = [];

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { valid: false, errors: ['Файл не является JSON-объектом.'] };
    }

    if (typeof data.version !== 'number' || data.version < 1) {
      errors.push('Отсутствует корректное поле «version» (должно быть числом ≥ 1).');
    } else if (data.version > DATA_VERSION) {
      warnings.push('Версия файла (' + data.version + ') новее текущей (' + DATA_VERSION + '). Некоторые функции могут не работать.');
    }

    if (typeof data.exportDate !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(data.exportDate)) {
      warnings.push('Поле «exportDate» отсутствует или имеет неверный формат.');
    }

    if (typeof data.appName !== 'string' || data.appName.length < 2) {
      warnings.push('Поле «appName» отсутствует.');
    }

    if (!data.data || typeof data.data !== 'object' || Array.isArray(data.data)) {
      errors.push('Отсутствует объект «data» со списком хранилищ.');
      return { valid: false, errors: errors, warnings: warnings };
    }

    var missingStores = [];
    for (var i = 0; i < BACKUP_STORES.length; i++) {
      if (data.data[BACKUP_STORES[i]] === undefined) missingStores.push(BACKUP_STORES[i]);
    }
    if (missingStores.length > 0) {
      errors.push('В файле отсутствуют хранилища: «' + missingStores.join('», «') + '». Ожидались все основные stores.');
    }

    var dataKeys = Object.keys(data.data);
    for (var k = 0; k < dataKeys.length; k++) {
      if (!Array.isArray(data.data[dataKeys[k]])) {
        errors.push('«data.' + dataKeys[k] + '» должно быть массивом.');
      } else if (KNOWN_STORES.indexOf(dataKeys[k]) === -1) {
        // DB.importAll отбраковывает неизвестные хранилища, но импортDump
        // к тому моменту уже очистил бы базы. Проверка обязана быть здесь,
        // пока данные целы (Этап 11, критический баг №2).
        errors.push('«data.' + dataKeys[k] + '» — неизвестное хранилище, импортировать его некуда.');
      }
    }

    for (var s = 0; s < BACKUP_STORES.length; s++) {
      var storeName = BACKUP_STORES[s];
      var arr = data.data[storeName];
      if (!Array.isArray(arr)) continue;
      var req = REQUIRED_FIELDS[storeName];
      if (!req) continue;
      for (var idx = 0; idx < arr.length; idx++) {
        var rec = arr[idx];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
          errors.push('«' + storeName + '»#' + idx + ': запись не является объектом.');
          continue;
        }
        for (var f = 0; f < req.length; f++) {
          if (rec[req[f]] === undefined || rec[req[f]] === null) {
            errors.push('«' + storeName + '»#' + idx + ': отсутствует поле «' + req[f] + '».');
          }
        }
      }
    }

    return { valid: errors.length === 0, errors: errors, warnings: warnings };
  }

  /* ================================================================
     5. ЭКСПОРТ
     ================================================================ */

  function exportData(options) {
    options = options || {};
    var includeSettings = options.includeSettings;
    if (includeSettings === undefined) {
      var chk = document.getElementById('backup-include-settings');
      includeSettings = chk ? chk.checked : true;
    }

    return new Promise(function (resolve, reject) {
      if (!window.DB || !window.DB.isReady) {
        return reject(new Error('База данных не инициализирована.'));
      }
      window.DB.exportAll().then(function (raw) {
        var dump = {
          version: DATA_VERSION,
          exportDate: new Date().toISOString(),
          appName: APP_NAME,
          data: {}
        };
        for (var i = 0; i < BACKUP_STORES.length; i++) {
          dump.data[BACKUP_STORES[i]] = raw[BACKUP_STORES[i]] || [];
        }
        if (includeSettings) {
          dump.settings = raw.settings || [];
          dump.custom_categories = raw.custom_categories || [];
          if (window.Personalization && window.Personalization.getExportPayload) {
            dump.personalization = window.Personalization.getExportPayload();
          }
        }
        resolve(dump);
      }).catch(function (err) {
        reject(new Error('Экспорт не удался: ' + err.message));
      });
    });
  }

  function downloadDump(dump) {
    return new Promise(function (resolve) {
      try {
        var json = JSON.stringify(dump, null, 2);
        var blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob);

        var now = new Date();
        var iso = now.getFullYear() + '-' +
          String(now.getMonth() + 1).padStart(2, '0') + '-' +
          String(now.getDate()).padStart(2, '0');

        var a = document.createElement('a');
        a.href = url;
        a.download = 'my_order_backup_' + iso + '.json';
        a.style.display = 'none';
        document.body.appendChild(a);

        a.click();

        setTimeout(function () {
          if (a.parentNode) a.parentNode.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1500);

        resolve(a.download);
      } catch (err) {
        resolve(null);
      }
    });
  }

  /* ================================================================
     6. ИМПОРТ
     ================================================================ */

  function clearBackupStores() {
    return new Promise(function (resolve, reject) {
      if (!window.DB) return reject(new Error('DB не загружен.'));
      var pending = BACKUP_STORES.length;
      if (pending === 0) { resolve(); return; }

      for (var i = 0; i < BACKUP_STORES.length; i++) {
        try {
          window.DB.clear(BACKUP_STORES[i], true).then(function () {
            pending--;
            if (pending <= 0) resolve();
          }).catch(reject);
        } catch (err) {
          reject(err);
          break;
        }
      }
    });
  }

  /**
   * Импорт дампа. Операция обязана быть атомарной: «импорт не удался»
   * не имеет права означать «данные пользователя удалены» (Этап 11,
   * критический баг №2 — раньше очистка происходила до того, как
   * DB.importAll обнаруживал проблему, и база оставалась пустой).
   *
   * Порядок: снимок → очистка → запись. Если запись упала — откатываем
   * снимок и сообщаем пользователю, что ничего не изменилось.
   */
  function importDump(dump) {
    // Структуру проверяем ЕЩЁ до очистки: неизвестное хранилище должно
    // быть отклонено на входе, а не после стирания базы.
    if (dump && dump.data) {
      var keys = Object.keys(dump.data);
      for (var i = 0; i < keys.length; i++) {
        if (KNOWN_STORES.indexOf(keys[i]) === -1) {
          return Promise.reject(new Error(
            'Файл содержит неизвестное хранилище «' + keys[i] + '». Импорт отменён, данные не изменены.'
          ));
        }
      }
    }

    if (!window.DB.importAll) {
      return Promise.reject(new Error('Метод DB.importAll недоступен.'));
    }

    return window.DB.exportAll().then(function (snapshot) {
      return clearBackupStores().then(function () {
        return window.DB.importAll(dump.data).then(function (stats) {
          if (window.Personalization && (dump.personalization || dump.settings || dump.custom_categories)) {
            return window.Personalization.importPersonalization(dump.personalization || dump).then(function () {
              return stats;
            });
          }
          return stats;
        }).catch(function (err) {
          // Всё или ничего: вернули то, что было
          return restoreFromSnapshot(snapshot).then(function () {
            throw err;
          }, function (restoreErr) {
            throw new Error(err.message + ' (откат не удался: ' + restoreErr.message + ')');
          });
        });
      });
    });
  }

  /**
   * Возврат к снимку после неудачного импорта. Очистка + запись в одной
   * логической операции; settings не трогаем — он не участвует в импорте.
   * @param {Object} snapshot — результат DB.exportAll()
   */
  function restoreFromSnapshot(snapshot) {
    var onlyData = {};
    for (var i = 0; i < BACKUP_STORES.length; i++) {
      onlyData[BACKUP_STORES[i]] = snapshot[BACKUP_STORES[i]] || [];
    }
    return clearBackupStores().then(function () {
      return window.DB.importAll(onlyData);
    });
  }

  /** Читает файл, валидирует. Возвращает результат без выполнения импорта. */
  function analyzeFile(file) {
    return new Promise(function (resolve) {
      if (!file || file.size === 0) {
        return resolve({ status: 'error', message: 'Файл пуст или не выбран.' });
      }

      var reader = new FileReader();
      reader.onload = function (e) {
        var dump;
        try { dump = JSON.parse(e.target.result); } catch (err) {
          return resolve({ status: 'error', message: 'Неверный формат файла: не удалось распарсить JSON.' });
        }

        var validation = validateImport(dump);

        if (!validation.valid) {
          var detail = validation.errors.slice(0, 3).map(function (e) { return '\u2022 ' + e; }).join('\n');
          return resolve({ status: 'error', message: 'Неверный формат файла.\n' + detail, errors: validation.errors });
        }

        if (validation.warnings.length > 0) {
          validation.warnings.forEach(function (w) { console.warn('[Backup]', w); });
        }

        return resolve({ status: 'ready', dump: dump, valid: true });
      };

      reader.onerror = function () {
        resolve({ status: 'error', message: 'Не удалось прочитать файл.' });
      };

      reader.readAsText(file, 'UTF-8');
    });
  }

  function clearAllData() {
    return clearBackupStores();
  }

  /* ================================================================
     7. РЕНДЕР
     ================================================================ */

  // --- HTML секций ---

  function securityNoticeHtml() {
    return '<div class="card backup-security">' +
      '<div class="backup-security__icon" aria-hidden="true">\u26A0\uFE0F</div>' +
      '<div class="backup-security__body">' +
        '<h3 class="backup-security__title">Где хранятся данные</h3>' +
        '<p class="backup-security__text">Ваши данные хранятся только на этом устройстве.</p>' +
        '<p class="backup-security__text">При очистке браузера или переустановке приложения данные будут потеряны. Регулярно делайте резервную копию!</p>' +
      '</div>' +
    '</div>';
  }

  function exportSectionHtml() {
    return '<div class="card backup-section" style="animation-delay:0s">' +
      '<h3 class="backup-section__title">Экспорт</h3>' +
      '<p class="backup-section__desc">Скачайте JSON-файл со всеми платежами, счётчиками, документами и задачами.</p>' +
      '<label class="switch backup-include-settings-switch" for="backup-include-settings">' +
        '<input type="checkbox" id="backup-include-settings" checked>' +
        '<span class="switch__track" aria-hidden="true"></span>' +
        '<span class="switch__label">Включить настройки и оформление в бэкап</span>' +
      '</label>' +
      '<button type="button" class="btn btn--primary backup-export-btn"' +
        ' data-backup-action="export">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="backup-icon" style="width:18px;height:18px;">' +
          '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
          '<polyline points="7 10 12 15 17 10"/>' +
          '<line x1="12" y1="15" x2="12" y2="3"/>' +
        '</svg>' +
        '<span class="backup-label">Скачать резервную копию</span>' +
        '<span class="backup-spinner" aria-hidden="true" style="display:none;"></span>' +
      '</button>' +
      '<div class="backup-status" data-backup-status="export"></div>' +
    '</div>';
  }

  function importSectionHtml() {
    return '<div class="card backup-section" style="animation-delay:0.05s">' +
      '<h3 class="backup-section__title">Импорт</h3>' +
      '<p class="backup-section__desc">Загрузите ранее сохранённый JSON-файл. Текущие данные будут заменены.</p>' +
      '<input type="file" accept=".json,application/json" style="display:none;" data-backup-input="file">' +
      '<button type="button" class="btn btn--secondary backup-import-btn"' +
        ' data-backup-action="import">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="backup-icon" style="width:18px;height:18px;">' +
          '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
          '<polyline points="17 8 12 3 7 8"/>' +
          '<line x1="12" y1="3" x2="12" y2="15"/>' +
        '</svg>' +
        '<span class="backup-label">Загрузить резервную копию</span>' +
      '</button>' +
      '<div class="backup-status" data-backup-status="import"></div>' +
    '</div>';
  }

  function dangerSectionHtml() {
    return '<div class="card backup-danger" style="animation-delay:0.1s">' +
      '<h3 class="backup-danger__title">Очистка данных</h3>' +
      '<p class="backup-danger__desc">Удалить все платежи, задачи, документы и счётчики. Это действие необратимо.</p>' +
      '<button type="button" class="btn btn--danger backup-clear-btn"' +
        ' data-backup-action="clear">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="backup-icon" style="width:18px;height:18px;">' +
          '<polyline points="3 6 5 6 21 6"/>' +
          '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
        '</svg>' +
        '<span class="backup-label">Удалить все данные</span>' +
      '</button>' +
      '<div class="backup-status" data-backup-status="clear"></div>' +
    '</div>';
  }

  // Подтверждение импорта: сначала читается файл, потом этот диалог
  function buildImportConfirmCard(message) {
    return '<h2 class="modal-content__title">Подтверждение импорта</h2>' +
      '<p class="modal-content__text">' + esc(message) + '</p>' +
      '<div class="flex gap-3 mt-4">' +
        '<button type="button" class="btn btn--secondary" style="flex:1" data-backup-confirm="cancel">Отмена</button>' +
        '<button type="button" class="btn btn--primary" style="flex:1" data-backup-confirm="run">Заменить данные</button>' +
      '</div>';
  }

  // Подтверждение очистки
  function buildClearConfirmCard() {
    return '<h2 class="modal-content__title">Удалить все данные?</h2>' +
      '<p class="modal-content__text">Это действие необратимо. Все платежи, задачи, документы, счётчики и их показания будут удалены.</p>' +
      '<p class="backup-danger__text" style="margin-top:var(--space-2)">Убедитесь, что у вас есть актуальная резервная копия.</p>' +
      '<div class="flex gap-3 mt-4">' +
        '<button type="button" class="btn btn--secondary" style="flex:1" data-backup-confirm="cancel">Отмена</button>' +
        '<button type="button" class="btn btn--danger" style="flex:1" data-backup-confirm="confirm">Удалить всё</button>' +
      '</div>';
  }

  /* ================================================================
     6b. PRO-СЕКЦИИ (Этап 12.5)
     ==============================================================
     *
     * Раздел «Резервные копии» — единственное место, где пользователь уже
     * думает о сохранности данных. Поэтому облачный бэкап, PIN и подписка
     * живут здесь, а не в отдельном экране: искать «где включить защиту»
     * в новом месте было бы лишним шагом.
     *
     * Разметка рендерится ВСЕГДА (и для Free), но с классом .pro-only:
     * CSS скрывает блок, а JS на всякий случай проверяет тариф в каждом
     * обработчике. Двойная проверка — потому что markup попадает в DOM и
     * его можно достать из консоли, а.guard должен быть в коде.
     ================================================================ */

  /** @const {Object.<string, string>} Подписи периодов для отчёта */
  var REPORT_PERIODS = {
    month: 'Текущий месяц',
    '3months': '3 месяца',
    year: '12 месяцев'
  };

  /** @returns {boolean} активен ли PRO */
  function isPro() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  /**
   * Русская плюрализация для «N дней назад».
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

  /**
   * Человекочитаемая давность бэкапа: «сегодня», «3 дня назад».
   * @param {?string} iso
   * @returns {string}
   */
  function backupAgeLabel(iso) {
    if (!iso) { return 'резервных копий ещё не было'; }

    var days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
    if (days === 0) { return 'копия обновлена сегодня'; }

    // Слово целиком, а не «дн» + суффикс: при 21 дне склейка давала бы
    // «21 днь». Плюс «назад» вынесено в конец, чтобы форма читалась как
    // «копия была 3 дня назад»
    return 'копия была ' + days + ' ' + plural(days, 'день', 'дня', 'дней') + ' назад';
  }

  function cloudSectionHtml() {
    var last = null;
    var dirty = false;
    var info = { label: '—', detail: '' };

    if (window.CloudSync) {
      last = window.CloudSync.getLastBackupAt();
      dirty = window.CloudSync.isDirty();
      info = window.CloudSync.storageInfo();
    }

    var age = backupAgeLabel(last);
    var tone = !last ? 'warn' : (dirty ? 'warn' : 'ok');

    return '<div class="card backup-section pro-only" style="animation-delay:0.15s">' +
        '<h3 class="backup-section__title">Облачная синхронизация ' +
          '<span class="pro-badge">PRO</span></h3>' +
        '<p class="backup-section__desc">' + esc(info.detail) + '</p>' +
        /* Строка статуса отвечает на два вопроса сразу: КУДА уходит копия и
           КАК давно она была. Разносить их по разным абзацм значило бы
           заставлять пользователя складывать смысл из двух мест. */
        '<p class="backup-cloud__status" data-backup-tone="' + tone + '">' +
          esc(info.label) + ' · ' + esc(age) +
          (dirty ? ' · есть несохранённые изменения' : '') + '</p>' +
        '<div class="backup-cloud__buttons">' +
          '<button type="button" class="btn btn--primary" data-backup-action="cloud-save">' +
            '<span class="backup-label">Сохранить в облако</span>' +
            '<span class="backup-spinner" aria-hidden="true" style="display:none;"></span>' +
          '</button>' +
          '<button type="button" class="btn btn--secondary" data-backup-action="cloud-load">' +
            'Загрузить из облака' +
          '</button>' +
        '</div>' +
        '<p class="backup-section__hint" data-backup-cloud-hint' +
          (window.CloudSync && window.CloudSync.hasAutoFile() ? '' : ' hidden') + '>' +
          'Файл выбран — изменения будут выгружаться в него автоматически.' +
          ' <button type="button" class="link-btn" data-backup-action="cloud-forget">Сменить папку</button>' +
        '</p>' +
        '<div class="backup-status" data-backup-status="cloud"></div>' +
      '</div>';
  }

  function pinSectionHtml() {
    var set = Boolean(window.Security && window.Security.isPinSet());

    return '<div class="card backup-section pro-only" style="animation-delay:0.2s">' +
        '<h3 class="backup-section__title">PIN-код ' +
          '<span class="pro-badge">PRO</span></h3>' +
        '<p class="backup-section__desc">' +
          (set
            ? 'Данные закрыты PIN из 4 цифр. При запуске приложение сначала просит его ввести.'
            : 'Закройте приложение четырьмя цифрами. Чужой телефон не покажет ваши платежи и документы.') +
        '</p>' +
        (set
          ? '<div class="backup-pin__active-badge">' +
              '<div class="backup-pin__active-icon">🔒</div>' +
              '<div class="backup-pin__active-info">' +
                '<span class="backup-pin__active-title">PIN-код установлен</span>' +
                '<span class="backup-pin__active-sub">• • • • Приложение надёжно защищено</span>' +
              '</div>' +
            '</div>' +
            '<button type="button" class="btn btn--secondary w-full" data-backup-action="pin-remove">Снять PIN</button>'
          : '<div class="backup-pin__container">' +
              '<div class="backup-pin__display" id="backup-pin-display" role="button" tabindex="0" aria-label="Ввести 4 цифры PIN">' +
                '<div class="backup-pin__cell is-active" data-pin-idx="0"></div>' +
                '<div class="backup-pin__cell" data-pin-idx="1"></div>' +
                '<div class="backup-pin__cell" data-pin-idx="2"></div>' +
                '<div class="backup-pin__cell" data-pin-idx="3"></div>' +
              '</div>' +
              '<input class="backup-pin__real-input" type="password" inputmode="numeric" pattern="[0-9]*"' +
                ' maxlength="4" placeholder="0000" data-backup-input="pin"' +
                ' aria-label="Новый PIN, 4 цифры" autocomplete="off">' +
              '<button type="button" class="btn btn--primary w-full" data-backup-action="pin-set">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;margin-right:6px;" aria-hidden="true">' +
                  '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
                  '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
                '</svg>' +
                '<span>Установить PIN</span>' +
              '</button>' +
            '</div>') +
        (window.Security && window.Security.recoveryHint()
          ? '<p class="backup-section__hint">Восстановление: VK ID ••••' +
              esc(String(window.Security.recoveryHint()).slice(-4)) + '</p>'
          : '<p class="backup-section__hint">Привяжите приложение к аккаунту ВКонтакте,' +
              ' чтобы PIN можно было восстановить.</p>') +
        '<div class="backup-status" data-backup-status="pin"></div>' +
      '</div>';
  }

  function familySectionHtml() {
    var inFam = Boolean(window.Family && window.Family.isActive && window.Family.isActive());
    var fam = inFam && window.Family.headerInfo ? window.Family.headerInfo() : null;
    var name = fam ? fam.name : '';
    var isAdmin = Boolean(window.Family && window.Family.isAdmin && window.Family.isAdmin());
    var members = inFam && window.Family.memberRows ? window.Family.memberRows() : [];
    var transport = window.Family && window.Family.transportInfo ? window.Family.transportInfo() : { channel: 'none', label: '' };

    if (!inFam) {
      return '<div class="card backup-section pro-only" style="animation-delay:0.22s">' +
          '<h3 class="backup-section__title">Семейный доступ ' +
            '<span class="pro-badge">PRO</span></h3>' +
          '<p class="backup-section__desc">' +
            'Ведите коммунальные платежи, показания счётчиков и общие дела вместе с близкими. Синхронизация через общий файл.' +
          '</p>' +
          '<div class="backup-family__create-form">' +
            '<div class="premium-input-wrap" style="margin-bottom:var(--space-3);">' +
              '<span class="premium-input-icon">' +
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                  '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' +
                '</svg>' +
              '</span>' +
              '<input class="premium-input input" type="text" maxlength="60" placeholder="Название семьи (например: Семья Ивановых)" ' +
                'data-family-input="name" aria-label="Название семьи">' +
            '</div>' +
            '<button type="button" class="btn btn--primary w-full" data-family-action="create">' +
              'Создать семью' +
            '</button>' +
          '</div>' +
          '<div class="backup-status" data-backup-status="family"></div>' +
        '</div>';
    }

    var membersHtml = members.map(function (m) {
      var roleBadge = m.role === 'admin'
        ? '<span class="family-member__badge family-member__badge--admin">Администратор</span>'
        : '<span class="family-member__badge">Участник</span>';
      var removeBtn = (isAdmin && !m.isMe && m.role !== 'admin')
        ? '<button type="button" class="btn btn--danger btn--xs" data-family-action="remove-member" data-user-id="' + esc(m.userId) + '">Удалить</button>'
        : '';
      return '<div class="family-member-row">' +
          '<div class="family-member-row__info">' +
            '<span class="family-member-row__name">' + esc(m.name) + (m.isMe ? ' (Вы)' : '') + '</span>' +
            roleBadge +
          '</div>' +
          removeBtn +
        '</div>';
    }).join('');

    return '<div class="card backup-section pro-only" style="animation-delay:0.22s">' +
        '<h3 class="backup-section__title">Моя семья: ' + esc(name) + ' ' +
          '<span class="pro-badge">PRO</span></h3>' +
        '<p class="backup-section__desc">' +
          'Общие списки и счётчики синхронизируются между участниками. Ваши личные заметки и документы остаются только у вас.' +
        '</p>' +
        '<div class="family-members-box">' +
          '<div class="family-members-title">Участники (' + members.length + ')</div>' +
          membersHtml +
        '</div>' +
        '<div class="backup-family__info">' +
          '<p class="backup-family__status">' + esc(transport.label) + '</p>' +
        '</div>' +
        '<div class="backup-cloud__buttons">' +
          '<button type="button" class="btn btn--primary" data-family-action="invite">' +
            'Ссылка-приглашение' +
          '</button>' +
          '<button type="button" class="btn btn--secondary" data-family-action="sync">' +
            'Синхронизировать' +
          '</button>' +
        '</div>' +
        '<div class="backup-family__sub-buttons">' +
          '<button type="button" class="btn btn--outline btn--sm" data-family-action="pick-file">' +
            'Сменить общий файл' +
          '</button>' +
          '<button type="button" class="btn btn--danger btn--sm" data-family-action="leave">' +
            'Покинуть семью' +
          '</button>' +
        '</div>' +
        '<div class="backup-status" data-backup-status="family"></div>' +
      '</div>';
  }

  function reportSectionHtml() {
    var stored = (window.PdfExporter && window.PdfExporter.getStoredPeriod()) || 'month';

    var options = Object.keys(REPORT_PERIODS).map(function (key) {
      return '<option value="' + key + '"' + (key === stored ? ' selected' : '') + '>' +
        REPORT_PERIODS[key] + '</option>';
    }).join('');

    return '<div class="card backup-section pro-only" style="animation-delay:0.25s">' +
        '<h3 class="backup-section__title">Отчёты и печатные формы ' +
          '<span class="pro-badge">PRO</span></h3>' +
        '<p class="backup-section__desc">' +
          'PDF-сводка платежей и счётчиков — для бухгалтера, работодателя или' +
          ' суда. Квитанция с QR-кодом печатается в один клик.' +
        '</p>' +
        '<div class="backup-report__row">' +
          '<label class="backup-report__label" for="backup-report-period">Период</label>' +
          '<select class="input" id="backup-report-period" data-backup-input="period">' + options + '</select>' +
        '</div>' +
        '<div class="backup-cloud__buttons">' +
          '<button type="button" class="btn btn--primary" data-backup-action="pdf-report">' +
            '<span class="backup-label">Скачать PDF-отчёт</span>' +
            '<span class="backup-spinner" aria-hidden="true" style="display:none;"></span>' +
          '</button>' +
          '<button type="button" class="btn btn--secondary" data-backup-action="pdf-print">' +
            'Печать отчёта' +
          '</button>' +
          '<button type="button" class="btn btn--secondary" data-backup-action="csv-export">' +
            '📊 Таблица Excel (.CSV)' +
          '</button>' +
        '</div>' +
        '<div class="backup-status" data-backup-status="pdf"></div>' +
      '</div>';
  }

  /**
   * Секция «Подписка». Видна обоим тарифам: Free должна видеть, за что
   * платит, а PRO — статус и способ управления автоплатежом.
   * @returns {string}
   */
  function subscriptionSectionHtml() {
    var pro = isPro();
    var pm = window.ProManager;
    var since = null;
    var isOwnerGrant = false;

    try {
      var cached = JSON.parse(localStorage.getItem('myorder_pro_cache') || 'null');
      since = cached && cached.at ? new Date(cached.at).toISOString() : null;
      isOwnerGrant = Boolean(cached && cached.ownerGrant);
    } catch (err) { since = null; }

    var activePlan = (pm && pm.getActivePlan) ? pm.getActivePlan() : { id: 'month', title: 'На 1 месяц', priceLabel: '99 \u20BD / мес' };
    var selectedPlanId = (pm && pm.getSelectedPlanId) ? pm.getSelectedPlanId() : 'year';
    var plans = (pm && pm.PLANS) || {
      month: { id: 'month', title: 'На 1 месяц', priceLabel: '99 \u20BD / мес', perMonthLabel: '99 \u20BD в месяц', badge: '' },
      year: { id: 'year', title: 'На 1 год', priceLabel: '890 \u20BD / год', perMonthLabel: '~74 \u20BD в месяц (выгода 25%)', badge: 'ХИТ · -25%' },
      lifetime: { id: 'lifetime', title: 'Навсегда', priceLabel: '1 490 \u20BD разово', perMonthLabel: 'Один платёж — без автопродлений', badge: 'VIP НАВСЕГДА' }
    };

    var appliedDiscount = (pm && pm.getAppliedDiscount) ? pm.getAppliedDiscount() : null;
    var planOrder = ['month', 'year', 'lifetime'];
    var plansGridHtml = !pro ? (
      '<div class="pro-plans-grid" role="radiogroup" aria-label="Выбор тарифа PRO">' +
        planOrder.map(function (pid) {
          var pl = plans[pid];
          if (!pl) return '';
          var isSel = selectedPlanId === pid;
          var hasDisc = appliedDiscount && (appliedDiscount.plan === 'all' || appliedDiscount.plan === pid);
          var finalPrice = pl.price;
          var priceLabel = pl.priceLabel;
          var badgeText = pl.badge;
          if (hasDisc) {
            finalPrice = Math.round(pl.price * (100 - appliedDiscount.discount) / 100);
            priceLabel = finalPrice + ' \u20BD' + (pid === 'month' ? ' / мес' : (pid === 'year' ? ' / год' : ' разово'));
            badgeText = '-' + appliedDiscount.discount + '% ПРОМО';
          }
          var badgeMod = pid === 'lifetime' ? ' pro-plan-card__badge--vip' : '';
          return '<button type="button" class="pro-plan-card' + (isSel ? ' pro-plan-card--selected' : '') + (pid === 'year' ? ' pro-plan-card--popular' : '') + '" ' +
            'data-pro-plan="' + esc(pid) + '" role="radio" aria-checked="' + (isSel ? 'true' : 'false') + '">' +
            '<span class="pro-plan-card__radio" aria-hidden="true"></span>' +
            '<span class="pro-plan-card__body">' +
              '<span class="pro-plan-card__top">' +
                '<span class="pro-plan-card__title">' + esc(pl.title) + '</span>' +
                (badgeText ? '<span class="pro-plan-card__badge' + badgeMod + '">' + esc(badgeText) + '</span>' : '') +
              '</span>' +
              '<span class="pro-plan-card__sub">' + esc(pl.perMonthLabel || '') + '</span>' +
            '</span>' +
            '<span class="pro-plan-card__price">' + esc(priceLabel) + '</span>' +
          '</button>';
        }).join('') +
      '</div>'
    ) : '';

    var chosenPlanObj = plans[selectedPlanId] || plans.year || plans.month;
    var chosenPriceLabel = chosenPlanObj.priceLabel;
    if (appliedDiscount && (appliedDiscount.plan === 'all' || appliedDiscount.plan === selectedPlanId)) {
      var dPrice = Math.round(chosenPlanObj.price * (100 - appliedDiscount.discount) / 100);
      chosenPriceLabel = dPrice + ' \u20BD' + (selectedPlanId === 'month' ? ' / мес' : (selectedPlanId === 'year' ? ' / год' : ' разово'));
    }

    var benefits = [
      'Оплата квитанций по банковскому QR ГОСТ Р 56042-2014',
      'Склад гарантий и чеков («Где что лежит?») и Инспектор подписок',
      'Семейный доступ, общая копилка и облачная синхронизация',
      'Аудитор переплат ЖКХ, календарь Cash Flow и прогноз расходов',
      'Выгрузка в Excel (.CSV), PDF-отчёты, календарь (.ics) и PIN-код'
    ];

    var crownSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14"/></svg>';
    var ticketSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>';
    var isOwnerUser = Boolean(pm && pm.isOwner && pm.isOwner());

    return '<div class="card backup-section backup-subscription" style="animation-delay:0.3s">' +
        '<div class="pro-sub-header">' +
          '<h3 class="backup-section__title" style="margin:0;">Подписка</h3>' +
        '</div>' +
        '<div class="backup-sub__status backup-sub__status--' + (pro ? 'active' : 'free') + '">' +
          '<span>' + (pro ? ('PRO активен · ' + esc(activePlan.title) + (isOwnerGrant ? ' (VIP)' : '')) : 'Бесплатный тариф') + '</span>' +
          (pro && since
            ? '<small>статус обновлён ' + esc(formatDate(since)) + '</small>'
            : '') +
        '</div>' +
        '<ul class="backup-sub__benefits">' +
          benefits.map(function (text) {
            return '<li class="' + (pro ? 'is-on' : '') + '">' +
              '<span class="backup-sub__check" aria-hidden="true">' + (pro ? '\u2713' : '\u2022') + '</span>' +
              esc(text) + '</li>';
          }).join('') +
        '</ul>' +
        plansGridHtml +
        (pro
          ? '<button type="button" class="btn btn--secondary w-full" data-backup-action="manage-subscription">' +
              'Управлять подпиской' +
            '</button>' +
            '<p class="backup-section__hint">' +
              'Отключить автопродление можно в платежах ВКонтакте: «Кошелёк» → «Подписки».' +
            '</p>'
          : '<div class="pro-cta-stack">' +
              '<button type="button" class="btn btn--primary pro-buy-main-btn" data-backup-action="buy-pro">' +
                '<span class="backup-label">Подключить PRO — ' + esc(chosenPriceLabel) + '</span>' +
                '<span class="backup-spinner" aria-hidden="true" style="display:none;"></span>' +
              '</button>' +
              '<button type="button" class="pro-promo-bar-btn" data-backup-action="promo-code">' +
                ticketSvg +
                '<span>У меня есть промокод или ключ активации</span>' +
              '</button>' +
            '</div>' +
            '<p class="backup-section__hint" style="text-align:center;margin-top:var(--space-2);">Безопасная оплата через VK Pay: 99 \u20BD/мес, 890 \u20BD/год или 1 490 \u20BD навсегда.</p>') +
        '<div class="backup-status" data-backup-status="sub"></div>' +
      '</div>';
  }

  /* ----------------------------------------------------------------
     СЕКЦИЯ «УВЕДОМЛЕНИЯ И КАЛЕНДАРЬ» (Этап 12.6, PRO)
     ---------------------------------------------------------------- */

  /**
   * Настройки напоминаний + экспорт в календарь.
   *
   * Почему настройки живут в backup.js, а не в отдельном разделе: своей
   * страницы настроек у приложения нет, а «Резервные копии» — единственная
   * точка, где уже собрано всё PRO (облако, PIN, отчёты, подписка).
   *
   * Тумблеры отражают состояние NotifPrefs сразу: значения лежат в памяти
   * модуля, поэтому раздел можно рисовать синхронно, не дожидаясь IndexedDB.
   * @returns {string}
   */
  function notificationsSectionHtml() {
    var prefs = (window.NotifPrefs && window.NotifPrefs.get()) ||
      (window.NotifPrefs && window.NotifPrefs.defaults()) ||
      { enabled: false, showAmounts: false, leadDays: 7, calendarHorizon: 'month', eventTime: 'morning' };

    var CE = window.CalendarExport;
    var stale = CE ? CE.isStale() : false;
    var last = CE && CE.lastExportedAt ? CE.lastExportedAt() : null;
    var times = (window.NotifPrefs && window.NotifPrefs.TIMES) || ['morning', 'evening', 'allday'];
    var leads = (window.NotifPrefs && window.NotifPrefs.LEAD_OPTIONS) || [1, 3, 7, 14];

    var timeLabels = { morning: 'Утром (09:00)', evening: 'Вечером (19:00)', allday: 'Весь день' };
    var horizonLabels = { week: 'Неделя', month: 'Месяц', quarter: 'Квартал' };

    return '<div class="card backup-section pro-only" style="animation-delay:0.28s">' +
        '<h3 class="backup-section__title">Уведомления и календарь ' +
          '<span class="pro-badge">PRO</span></h3>' +
        '<p class="backup-section__desc">' +
          'Гарантированные напоминания даёт системный календарь: выгрузите ' +
          'сроки в файл и добавьте его в Google, Apple или Outlook. Пуши ' +
          'приложения сработают, пока браузер открыт.' +
        '</p>' +

        '<label class="switch" for="backup-notif-enabled">' +
          '<input type="checkbox" id="backup-notif-enabled" data-backup-notif="enabled"' +
            (prefs.enabled ? ' checked' : '') + '>' +
          '<span class="switch__track" aria-hidden="true"></span>' +
          '<span class="switch__label">Системные напоминания</span>' +
        '</label>' +
        '<p class="backup-notif__perm" data-backup-notif-perm>' + notifPermText() + '</p>' +

        '<label class="switch" for="backup-notif-amounts">' +
          '<input type="checkbox" id="backup-notif-amounts" data-backup-notif="showAmounts"' +
            (prefs.showAmounts ? ' checked' : '') + '>' +
          '<span class="switch__track" aria-hidden="true"></span>' +
          '<span class="switch__label">Показывать названия и суммы</span>' +
        '</label>' +
        '<p class="backup-section__hint">' +
          'Выключено — на экране блокировки видно только тип напоминания и срок.' +
        '</p>' +

        '<div class="backup-notif__grid">' +
          '<div class="backup-report__row">' +
            '<label class="backup-report__label" for="backup-notif-lead">За сколько дней</label>' +
            '<select class="input" id="backup-notif-lead" data-backup-notif="leadDays">' +
              leads.map(function (n) {
                return '<option value="' + n + '"' + (Number(prefs.leadDays) === n ? ' selected' : '') +
                  '>' + n + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<div class="backup-report__row">' +
            '<label class="backup-report__label" for="backup-notif-time">Время событий</label>' +
            '<select class="input" id="backup-notif-time" data-backup-notif="eventTime">' +
              times.map(function (t) {
                return '<option value="' + t + '"' + (prefs.eventTime === t ? ' selected' : '') +
                  '>' + esc(timeLabels[t] || t) + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<div class="backup-report__row">' +
            '<label class="backup-report__label" for="backup-notif-horizon">Горизонт .ics</label>' +
            '<select class="input" id="backup-notif-horizon" data-backup-notif="calendarHorizon">' +
              Object.keys(horizonLabels).map(function (h) {
                return '<option value="' + h + '"' + (prefs.calendarHorizon === h ? ' selected' : '') +
                  '>' + esc(horizonLabels[h]) + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
        '</div>' +

        '<div class="backup-cloud__buttons">' +
          '<button type="button" class="btn btn--primary" data-backup-action="ics-export">' +
            '<span class="backup-label">Экспорт в календарь (.ics)</span>' +
            '<span class="backup-spinner" aria-hidden="true" style="display:none;"></span>' +
          '</button>' +
          '<button type="button" class="btn btn--secondary" data-backup-action="notif-check">' +
            'Проверить сейчас' +
          '</button>' +
        '</div>' +

        '<p class="backup-section__hint" data-backup-notif-stale>' +
          (stale
            ? 'Данные менялись после выгрузки — календарь в телефоне отстаёт.'
            : 'Календарь обновлён' + (last ? ' ' + formatDateTime(last) : '') + '.') +
        '</p>' +
        '<div class="backup-status" data-backup-status="notif"></div>' +
      '</div>';
  }

  /**
   * Строка про разрешение Notification API. Формулировка обязана быть
   * честной: «не выдано» и «движок не умеет» — разные ситуации, и в первой
   * пользователь ещё может разрешить, а во второй — нет.
   * @returns {string}
   */
  function notifPermText() {
    var state = window.NotifPrefs && window.NotifPrefs.permission
      ? window.NotifPrefs.permission() : 'default';

    if (state === 'granted') { return 'Разрешение выдано — напоминания видны даже со свёрнутой вкладкой.'; }
    if (state === 'denied') {
      return 'Браузер запретил уведомления. Приложение работает: сроки покажет баннер внутри него.';
    }
    if (state === 'unsupported') {
      return 'Этот браузер не умеет системные уведомления — подойдёт экспорт в календарь.';
    }
    return 'Разрешение запросим при включении тумблера.';
  }

  /* ================================================================
     СЕКЦИЯ «ОФОРМЛЕНИЕ И ПЕРСОНАЛИЗАЦИЯ» (Этап 12.8)
     ================================================================ */

  function personalizationSectionHtml() {
    var p = window.Personalization;
    var currentAccent = p ? p.getAccent() : 'blue';
    var currentContrast = p ? p.getHighContrast() : false;
    var currentFontSize = p ? p.getFontSize() : 'normal';
    var currentHaptics = p ? p.getHaptics() : false;
    var currentSound = p ? p.getSound() : false;
    var layout = p ? p.getHomeLayout() : [];

    var accents = (p && p.ACCENTS) || {};
    var accentButtonsHtml = Object.keys(accents).map(function (k) {
      var a = accents[k];
      var isActive = currentAccent === k;
      var activeCls = isActive ? ' accent-swatch--active' : '';
      return '<button type="button" class="accent-swatch' + activeCls + '" data-accent-id="' + a.id + '" ' +
        'style="background:' + a.hex + ';" aria-label="' + esc(a.name) + '" title="' + esc(a.name) + '">' +
        (isActive ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : '') +
      '</button>';
    }).join('');

    var fontSizes = (p && p.FONT_SIZES) || {};
    var fontSizesHtml = Object.keys(fontSizes).map(function (k) {
      var f = fontSizes[k];
      var isActive = currentFontSize === k;
      var activeCls = isActive ? ' font-size-btn--active' : '';
      return '<button type="button" class="font-size-btn' + activeCls + '" data-font-size-id="' + f.id + '">' +
        esc(f.name) + '</button>';
    }).join('');

    var layoutItemsHtml = layout.map(function (item, idx) {
      var isFirst = idx === 0;
      var isLast = idx === layout.length - 1;
      return '<div class="home-layout-item" data-layout-block="' + item.id + '">' +
        '<div class="home-layout-item__info">' +
          '<label class="switch" style="margin:0;">' +
            '<input type="checkbox" data-layout-toggle="' + item.id + '"' +
              (item.visible ? ' checked' : '') +
              (item.locked ? ' disabled' : '') + '>' +
            '<span class="switch__track" aria-hidden="true"></span>' +
          '</label>' +
          '<span>' + esc(item.title) + (item.locked ? ' (всегда)' : '') + '</span>' +
        '</div>' +
        '<div class="home-layout-item__actions">' +
          '<button type="button" class="layout-order-btn" data-layout-move="up" data-block-id="' + item.id + '"' +
            (isFirst ? ' disabled' : '') + ' aria-label="Поднять выше">▲</button>' +
          '<button type="button" class="layout-order-btn" data-layout-move="down" data-block-id="' + item.id + '"' +
            (isLast ? ' disabled' : '') + ' aria-label="Опустить ниже">▼</button>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="card backup-section" style="animation-delay:0.32s">' +
        '<h3 class="backup-section__title">Оформление и интерфейс</h3>' +
        '<p class="backup-section__desc">Настройте тему, размер шрифта и виджеты главного экрана под себя.</p>' +

        /* Тема оформления (Светлая / Тёмная / Как в VK) */
        (function () {
          var mode = (window.VK && window.VK.themeMode) ? window.VK.themeMode() : 'auto';
          return '<div style="margin-bottom:var(--space-4);">' +
            '<label class="form-label">Тема оформления</label>' +
            '<div class="font-size-segments" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">' +
              '<button type="button" class="font-size-btn' + (mode === 'light' ? ' font-size-btn--active' : '') + '" data-theme-mode="light">☀️ Светлая</button>' +
              '<button type="button" class="font-size-btn' + (mode === 'dark' ? ' font-size-btn--active' : '') + '" data-theme-mode="dark">🌙 Тёмная</button>' +
              '<button type="button" class="font-size-btn' + (mode === 'auto' ? ' font-size-btn--active' : '') + '" data-theme-mode="auto">🔄 Как в VK</button>' +
            '</div>' +
          '</div>';
        })() +

        /* Акцентный цвет (PRO) */
        '<div style="margin-bottom:var(--space-4);">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;">' +
            '<label class="form-label" style="margin:0;">Цвет акцента</label>' +
            '<span class="pro-badge">PRO</span>' +
          '</div>' +
          '<div class="personalization-accent-picker">' + accentButtonsHtml + '</div>' +
        '</div>' +

        /* Размер текста (FREE + PRO) */
        '<div style="margin-bottom:var(--space-4);">' +
          '<label class="form-label">Размер текста</label>' +
          '<div class="font-size-segments">' + fontSizesHtml + '</div>' +
        '</div>' +

        /* Высокий контраст (PRO) */
        '<div style="margin-bottom:var(--space-4);">' +
          '<label class="switch" for="pers-high-contrast">' +
            '<input type="checkbox" id="pers-high-contrast" data-pers="contrast"' +
              (currentContrast ? ' checked' : '') + '>' +
            '<span class="switch__track" aria-hidden="true"></span>' +
            '<span class="switch__label">Высокий контраст (для слабовидящих)</span>' +
            '<span class="pro-badge" style="margin-left:auto;">PRO</span>' +
          '</label>' +
        '</div>' +

        /* Звуковые и тактильные эффекты (PRO) */
        '<div style="margin-bottom:var(--space-4);">' +
          '<label class="switch" for="pers-haptics" style="margin-bottom:var(--space-2);">' +
            '<input type="checkbox" id="pers-haptics" data-pers="haptics"' +
              (currentHaptics ? ' checked' : '') + '>' +
            '<span class="switch__track" aria-hidden="true"></span>' +
            '<span class="switch__label">Тактильный отклик (вибрация)</span>' +
            '<span class="pro-badge" style="margin-left:auto;">PRO</span>' +
          '</label>' +
          '<label class="switch" for="pers-sound">' +
            '<input type="checkbox" id="pers-sound" data-pers="sound"' +
              (currentSound ? ' checked' : '') + '>' +
            '<span class="switch__track" aria-hidden="true"></span>' +
            '<span class="switch__label">Звуковые эффекты действий</span>' +
            '<span class="pro-badge" style="margin-left:auto;">PRO</span>' +
          '</label>' +
        '</div>' +

        /* Главный экран (FREE + PRO) */
        '<div style="margin-top:var(--space-5);border-top:1px solid var(--color-border);padding-top:var(--space-4);">' +
          '<h4 style="font-size:var(--fs-base);margin-bottom:var(--space-1);font-weight:var(--fw-semibold);">Главный экран</h4>' +
          '<p class="backup-section__hint" style="margin-bottom:var(--space-2);">Скрывайте или меняйте порядок блоков на главной.</p>' +
          '<div class="home-layout-list">' + layoutItemsHtml + '</div>' +
        '</div>' +
      '</div>';
  }

  function customCategoriesSectionHtml() {
    var p = window.Personalization;
    var cats = p ? p.getCategories('all') : [];
    var palette = (p && p.PRESET_PALETTE) || [];
    var icons = (p && p.PRESET_ICONS) || [];

    var listHtml = '';
    if (!cats.length) {
      listHtml = '<p class="backup-section__hint" style="margin:var(--space-2) 0;">Своих категорий пока нет.</p>';
    } else {
      listHtml = '<div class="custom-categories-list">' +
        cats.map(function (c) {
          var typeLabel = c.type === 'payment' ? 'Платежи' : (c.type === 'task' ? 'Дела' : 'Все');
          var bg = c.color || '#DBEAFE';
          var fg = p ? p.getCategoryColors(c.name).fg : '#0F172A';
          return '<div class="custom-category-row">' +
            '<div style="display:flex;align-items:center;gap:var(--space-2);">' +
              '<span class="custom-category-tag" style="background:' + bg + ';color:' + fg + ';">' +
                (c.icon ? c.icon + ' ' : '') + esc(c.name) +
              '</span>' +
              '<span style="font-size:11px;color:var(--color-text-secondary);">' + typeLabel + '</span>' +
            '</div>' +
            '<button type="button" class="icon-btn" data-cat-delete="' + c.id + '" aria-label="Удалить категорию">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
              '</svg>' +
            '</button>' +
          '</div>';
        }).join('') +
      '</div>';
    }

    var paletteHtml = palette.map(function (hex, idx) {
      return '<button type="button" class="palette-swatch-circle' + (idx === 0 ? ' palette-swatch-circle--active' : '') + '" ' +
        'data-swatch-color="' + hex + '" style="background:' + hex + ';" aria-label="Цвет ' + hex + '"></button>';
    }).join('');

    var iconsHtml = icons.map(function (ic, idx) {
      return '<button type="button" class="emoji-btn' + (idx === 0 ? ' emoji-btn--active' : '') + '" ' +
        'data-swatch-icon="' + ic + '">' + ic + '</button>';
    }).join('');

    return '<div class="card backup-section pro-only" style="animation-delay:0.35s">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;">' +
          '<h3 class="backup-section__title" style="margin:0;">Мои категории</h3>' +
          '<span class="pro-badge">PRO</span>' +
        '</div>' +
        '<p class="backup-section__desc">Создавайте уникальные категории для платежей и дел с собственным цветом и иконкой.</p>' +
        listHtml +
        '<div class="custom-category-add-form">' +
          '<h4 style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);margin-bottom:var(--space-2);">Новая категория</h4>' +
          '<div class="premium-input-wrap" style="margin-bottom:var(--space-2);">' +
            '<span class="premium-input-icon">' +
              '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>' +
            '</span>' +
            '<input type="text" class="premium-input input" id="cat-name-input" placeholder="Название (например, Кофе)" maxlength="30">' +
          '</div>' +
          '<div style="margin-bottom:var(--space-2);">' +
            '<label class="form-label" style="font-size:12px;font-weight:600;">Цвет категории</label>' +
            '<div class="palette-swatches">' + paletteHtml + '</div>' +
          '</div>' +
          '<div style="margin-bottom:var(--space-3);">' +
            '<label class="form-label" style="font-size:12px;font-weight:600;">Иконка или эмодзи</label>' +
            '<div class="emoji-palette">' + iconsHtml + '</div>' +
          '</div>' +
          '<div class="form-group" style="margin-bottom:var(--space-3);">' +
            '<label class="form-label" style="font-size:12px;font-weight:600;">Где использовать</label>' +
            '<div class="exec-select-wrap">' +
              '<select class="exec-select input" id="cat-type-select">' +
                '<option value="both">Платежи и дела</option>' +
                '<option value="payment">Только платежи</option>' +
                '<option value="task">Только дела</option>' +
              '</select>' +
              '<span class="exec-select-arrow" aria-hidden="true">' +
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>' +
              '</span>' +
            '</div>' +
          '</div>' +
          '<button type="button" class="btn btn--primary w-full" id="cat-add-btn">Создать категорию</button>' +
          '<div class="form-error" id="cat-form-error" style="margin-top:var(--space-2);"></div>' +
        '</div>' +
      '</div>';
  }

  function bindPersonalizationHandlers(el) {
    // 0. Выбор темы (Светлая / Тёмная / Как в VK)
    var themeBtns = el.querySelectorAll('[data-theme-mode]');
    Array.prototype.forEach.call(themeBtns, function (btn) {
      btn.addEventListener('click', function () {
        var mode = btn.getAttribute('data-theme-mode');
        if (window.VK && window.VK.setThemeMode) {
          window.VK.setThemeMode(mode);
          render();
        }
      });
    });

    var p = window.Personalization;
    if (!p) return;

    // 1. Акцентные цвета
    var swatches = el.querySelectorAll('[data-accent-id]');
    Array.prototype.forEach.call(swatches, function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-accent-id');
        p.setAccent(id).then(function (res) {
          if (res && res.ok) { render(); }
        });
      });
    });

    // 2. Размер шрифта
    var fontBtns = el.querySelectorAll('[data-font-size-id]');
    Array.prototype.forEach.call(fontBtns, function (btn) {
      btn.addEventListener('click', function () {
        var size = btn.getAttribute('data-font-size-id');
        p.setFontSize(size).then(function () {
          render();
        });
      });
    });

    // 3. Высокий контраст
    var contrastCheck = el.querySelector('#pers-high-contrast');
    if (contrastCheck) {
      contrastCheck.addEventListener('change', function () {
        p.setHighContrast(contrastCheck.checked).then(function (res) {
          if (res && !res.ok) {
            contrastCheck.checked = p.getHighContrast();
          } else {
            render();
          }
        });
      });
    }

    // 4. Тактильность и звук
    var hapticsCheck = el.querySelector('#pers-haptics');
    if (hapticsCheck) {
      hapticsCheck.addEventListener('change', function () {
        p.setHaptics(hapticsCheck.checked).then(function (res) {
          if (res && !res.ok) { hapticsCheck.checked = p.getHaptics(); }
        });
      });
    }

    var soundCheck = el.querySelector('#pers-sound');
    if (soundCheck) {
      soundCheck.addEventListener('change', function () {
        p.setSound(soundCheck.checked).then(function (res) {
          if (res && !res.ok) { soundCheck.checked = p.getSound(); }
        });
      });
    }

    // 5. Главный экран (reorder & toggle)
    var moveBtns = el.querySelectorAll('[data-layout-move]');
    Array.prototype.forEach.call(moveBtns, function (btn) {
      btn.addEventListener('click', function () {
        var dir = btn.getAttribute('data-layout-move') === 'up' ? -1 : 1;
        var blockId = btn.getAttribute('data-block-id');
        p.reorderHomeBlock(blockId, dir).then(function () {
          render();
        });
      });
    });

    var layoutToggles = el.querySelectorAll('[data-layout-toggle]');
    Array.prototype.forEach.call(layoutToggles, function (chk) {
      chk.addEventListener('change', function () {
        var blockId = chk.getAttribute('data-layout-toggle');
        p.toggleHomeBlock(blockId, chk.checked);
      });
    });

    // 6. Пользовательские категории: палитра и эмодзи
    var selectedColor = p.PRESET_PALETTE[0];
    var selectedIcon = p.PRESET_ICONS[0];

    var colorSwatches = el.querySelectorAll('.palette-swatch-circle');
    Array.prototype.forEach.call(colorSwatches, function (sw) {
      sw.addEventListener('click', function () {
        Array.prototype.forEach.call(colorSwatches, function (s) { s.classList.remove('palette-swatch-circle--active'); });
        sw.classList.add('palette-swatch-circle--active');
        selectedColor = sw.getAttribute('data-swatch-color');
      });
    });

    var emojiBtns = el.querySelectorAll('.emoji-btn');
    Array.prototype.forEach.call(emojiBtns, function (eb) {
      eb.addEventListener('click', function () {
        Array.prototype.forEach.call(emojiBtns, function (b) { b.classList.remove('emoji-btn--active'); });
        eb.classList.add('emoji-btn--active');
        selectedIcon = eb.getAttribute('data-swatch-icon');
      });
    });

    var addCatBtn = el.querySelector('#cat-add-btn');
    if (addCatBtn) {
      addCatBtn.addEventListener('click', function () {
        var nameInput = el.querySelector('#cat-name-input');
        var typeSelect = el.querySelector('#cat-type-select');
        var errEl = el.querySelector('#cat-form-error');
        if (errEl) errEl.textContent = '';

        var name = nameInput ? nameInput.value.trim() : '';
        var type = typeSelect ? typeSelect.value : 'both';

        p.addCategory({
          name: name,
          color: selectedColor,
          icon: selectedIcon,
          type: type
        }).then(function (res) {
          if (!res.ok) {
            if (errEl) errEl.textContent = res.message;
          } else {
            render();
          }
        });
      });
    }

    var delBtns = el.querySelectorAll('[data-cat-delete]');
    Array.prototype.forEach.call(delBtns, function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.getAttribute('data-cat-delete'));
        p.removeCategory(id).then(function (res) {
          if (res && res.ok) { render(); }
        });
      });
    });
  }

  /**
   * Подпись-статус в конкретной секции.
   * @param {HTMLElement} el — контейнер #app
   * @param {string} key — значение data-backup-status
   * @param {string} msg
   * @param {string} [level] — ok | error | info | warn
   */
  function showStatus(el, key, msg, level) {
    var node = el.querySelector('[data-backup-status="' + key + '"]');
    if (!node) return;
    node.textContent = msg;
    node.className = 'backup-status';
    if (level) node.classList.add('backup-status--' + level);
  }

  /** Текущая активная вкладка настроек */
  var activeSettingsTab = (function () {
    try {
      var saved = localStorage.getItem('myorder_settings_tab');
      if (saved && ['appearance', 'notifications', 'storage', 'pro'].indexOf(saved) !== -1) {
        return saved;
      }
    } catch (e) {}
    return 'storage';
  })();

  /**
   * VIP-шапка профиля пользователя в настройках
   */
  function settingsProfileCardHtml() {
    var vkUser = window.VK && window.VK.user && window.VK.user();
    var name = (vkUser && vkUser.first_name) ? (vkUser.first_name + (vkUser.last_name ? ' ' + vkUser.last_name : '')) : 'Мой Порядок';
    var photo = (vkUser && (vkUser.photo_100 || vkUser.photo_200)) || '';
    var isP = isPro();
    var pm = window.ProManager;
    var isOwn = pm && pm.isOwner && pm.isOwner();
    var activePlan = (pm && pm.getActivePlan) ? pm.getActivePlan() : { title: 'PRO' };

    var tierLabel = isP
      ? (isOwn ? 'Владелец · PRO Навсегда' : (activePlan.title + ' · VIP'))
      : 'Бесплатный тариф';

    var btnLabel = isOwn ? 'Панель' : (isP ? 'Подписка' : 'Купить PRO');
    var btnAction = isOwn ? 'owner-panel' : (isP ? 'manage-subscription' : 'buy-pro');

    var avatarHtml = photo
      ? '<img src="' + esc(photo) + '" alt="' + esc(name) + '">'
      : '<span class="settings-profile-card__crown">' + (isP ? '👑' : '⭐') + '</span>';

    return '<div class="settings-profile-card">' +
      '<div class="settings-profile-card__left">' +
        '<div class="settings-profile-card__avatar">' + avatarHtml + '</div>' +
        '<div class="settings-profile-card__meta">' +
          '<div class="settings-profile-card__title">' + esc(name) + '</div>' +
          '<div class="settings-profile-card__tier' + (isP ? '' : ' is-free') + '">' +
            '<span class="settings-profile-card__dot"></span>' +
            '<span>' + esc(tierLabel) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="settings-profile-card__btn" data-backup-action="' + btnAction + '">' +
        esc(btnLabel) +
      '</button>' +
    '</div>';
  }

  /**
   * Сегментированный переключатель вкладок в стиле iOS Glass Capsule
   */
  function settingsNavCapsuleHtml() {
    var tabs = [
      { id: 'appearance', label: 'Вид', icon: '🎨' },
      { id: 'notifications', label: 'Напоминания', icon: '🔔' },
      { id: 'storage', label: 'Данные', icon: '💾' },
      { id: 'pro', label: 'PRO', icon: '👑' }
    ];

    return '<div class="settings-nav-capsule" role="tablist" aria-label="Разделы настроек">' +
      tabs.map(function (tab) {
        var isAct = activeSettingsTab === tab.id;
        return '<button type="button" class="settings-capsule-btn' + (isAct ? ' settings-capsule-btn--active' : '') + '"' +
          ' data-settings-tab="' + tab.id + '" role="tab" aria-selected="' + (isAct ? 'true' : 'false') + '">' +
          '<span class="settings-capsule-icon">' + tab.icon + '</span>' +
          '<span class="settings-capsule-text">' + tab.label + '</span>' +
        '</button>';
      }).join('') +
    '</div>';
  }

  /**
   * Переключает активную вкладку настроек
   * @param {'appearance'|'notifications'|'storage'|'pro'} tabId
   */
  function switchSettingsTab(tabId) {
    if (['appearance', 'notifications', 'storage', 'pro'].indexOf(tabId) === -1) return;
    activeSettingsTab = tabId;
    try { localStorage.setItem('myorder_settings_tab', tabId); } catch (e) {}

    var el = getAppEl();
    if (!el) return;

    var tabBtns = el.querySelectorAll('[data-settings-tab]');
    Array.prototype.forEach.call(tabBtns, function (btn) {
      var act = btn.getAttribute('data-settings-tab') === tabId;
      btn.classList.toggle('settings-capsule-btn--active', act);
      btn.setAttribute('aria-selected', act ? 'true' : 'false');
    });

    var panels = el.querySelectorAll('[data-settings-panel]');
    Array.prototype.forEach.call(panels, function (pan) {
      var act = pan.getAttribute('data-settings-panel') === tabId;
      pan.classList.toggle('settings-tab-panel--active', act);
    });
  }

  /**
   * Рендер раздела #backup с разделением по вкладкам.
   */
  function render() {
    var el = getAppEl();
    if (!el) return;

    el.innerHTML = '<header class="page-header">Настройки</header>' +
      settingsProfileCardHtml() +
      settingsNavCapsuleHtml() +
      '<div class="settings-tab-panels">' +
        // Вкладка 1: Вид (Оформление и интерфейс)
        '<div class="settings-tab-panel' + (activeSettingsTab === 'appearance' ? ' settings-tab-panel--active' : '') + '" data-settings-panel="appearance">' +
          personalizationSectionHtml() +
          customCategoriesSectionHtml() +
        '</div>' +
        // Вкладка 2: Напоминания (Push и календарь)
        '<div class="settings-tab-panel' + (activeSettingsTab === 'notifications' ? ' settings-tab-panel--active' : '') + '" data-settings-panel="notifications">' +
          notificationsSectionHtml() +
        '</div>' +
        // Вкладка 3: Данные (Облако, Экспорт, Импорт, PDF, Очистка)
        '<div class="settings-tab-panel' + (activeSettingsTab === 'storage' ? ' settings-tab-panel--active' : '') + '" data-settings-panel="storage">' +
          securityNoticeHtml() +
          cloudSectionHtml() +
          exportSectionHtml() +
          importSectionHtml() +
          reportSectionHtml() +
          dangerSectionHtml() +
        '</div>' +
        // Вкладка 4: PRO (Подписка, PIN, Семья, Копилка)
        '<div class="settings-tab-panel' + (activeSettingsTab === 'pro' ? ' settings-tab-panel--active' : '') + '" data-settings-panel="pro">' +
          subscriptionSectionHtml() +
          pinSectionHtml() +
          familySectionHtml() +
          (window.ValuePack && window.ValuePack.renderSavingsGoalHtml ? window.ValuePack.renderSavingsGoalHtml() : '') +
        '</div>' +
      '</div>';

    /* ---------- Переключение вкладок ---------- */
    var tabBtns = el.querySelectorAll('[data-settings-tab]');
    Array.prototype.forEach.call(tabBtns, function (b) {
      b.addEventListener('click', function () {
        switchSettingsTab(b.getAttribute('data-settings-tab'));
      });
    });

    /* ---------- Кнопка экспорта ---------- */
    var expBtn = el.querySelector('[data-backup-action="export"]');
    if (expBtn) {
      expBtn.addEventListener('click', handleExport);
    }

    /* ---------- Кнопка импорта ---------- */
    var impBtn = el.querySelector('[data-backup-action="import"]');
    var fileInput = el.querySelector('[data-backup-input="file"]');
    if (impBtn && fileInput) {
      impBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', handleImport);
    }

    /* ---------- Кнопка очистки ---------- */
    var clrBtn = el.querySelector('[data-backup-action="clear"]');
    if (clrBtn) {
      clrBtn.addEventListener('click', handleClear);
    }

    bindProHandlers(el);
    bindPersonalizationHandlers(el);

    // Статус, обещанный до перерисовки, показываем в свежем DOM
    if (pendingStatus) {
      var ps = pendingStatus;
      pendingStatus = null;
      showStatus(el, ps.key, ps.msg, ps.level || 'info');
    }
  }

  /**
   * Привязка PRO-кнопок.
   *
   * Слушатели вешаются НА САМИ кнопки, а не делегатом на #app: #app живёт
   * всё время работы вкладки, и делегат, повешенный в render(), накапливался
   * бы по одному на каждую навигацию в раздел (протестировано на этапе 11 —
   * тест 10.4.2 ловит такие утечки по числу DOM-узлов и слушателей).
   *
   * @param {HTMLElement} el — контейнер #app
   */
  function bindProHandlers(el) {
    var map = {
      'cloud-save': handleCloudSave,
      'cloud-load': handleCloudLoad,
      'cloud-forget': handleCloudForget,
      'pin-set': handlePinSet,
      'pin-remove': handlePinRemove,
      'pdf-report': handlePdfReport,
      'pdf-print': handlePdfPrint,
      'csv-export': handleCsvExport,
      'ics-export': handleIcsExport,
      'notif-check': handleNotifCheck,
      'buy-pro': handleBuyPro,
      'manage-subscription': handleManageSubscription,
      'promo-code': handlePromoCodeModal,
      'owner-panel': handleOwnerPanelModal
    };

    Object.keys(map).forEach(function (action) {
      var btn = el.querySelector('[data-backup-action="' + action + '"]');
      if (btn) { btn.addEventListener('click', map[action]); }
    });

    var planBtns = el.querySelectorAll('[data-pro-plan]');
    Array.prototype.forEach.call(planBtns, function (pBtn) {
      pBtn.addEventListener('click', function () {
        var pid = pBtn.getAttribute('data-pro-plan');
        if (window.ProManager && window.ProManager.selectPlan) {
          var chosen = window.ProManager.selectPlan(pid);
          Array.prototype.forEach.call(planBtns, function (b) {
            var active = b.getAttribute('data-pro-plan') === pid;
            b.classList.toggle('pro-plan-card--selected', active);
            b.setAttribute('aria-checked', active ? 'true' : 'false');
          });
          var buyLabel = el.querySelector('[data-backup-action="buy-pro"] .backup-label');
          if (buyLabel && chosen) {
            buyLabel.textContent = 'Подключить PRO — ' + chosen.priceLabel;
          }
        }
      });
    });

    var subHeaderTitle = el.querySelector('.backup-subscription .backup-section__title');
    if (subHeaderTitle) {
      var taps = 0;
      var lastTap = 0;
      subHeaderTitle.style.cursor = 'default';
      subHeaderTitle.addEventListener('click', function () {
        var now = Date.now();
        if (now - lastTap < 600) {
          taps++;
        } else {
          taps = 1;
        }
        lastTap = now;
        if (taps === 5) {
          taps = 0;
          handleOwnerPanelModal();
        }
      });
    }

    var pinDisplay = el.querySelector('#backup-pin-display');
    var pinRealInput = el.querySelector('[data-backup-input="pin"]');
    if (pinDisplay && pinRealInput) {
      pinDisplay.addEventListener('click', function () {
        pinRealInput.focus();
      });
      pinRealInput.addEventListener('focus', function () {
        var cells = pinDisplay.querySelectorAll('.backup-pin__cell');
        var val = String(pinRealInput.value || '').replace(/\D/g, '').slice(0, 4);
        for (var i = 0; i < cells.length; i++) {
          if (i === val.length) {
            cells[i].classList.add('is-active');
          }
        }
      });
      pinRealInput.addEventListener('blur', function () {
        var cells = pinDisplay.querySelectorAll('.backup-pin__cell');
        for (var i = 0; i < cells.length; i++) {
          cells[i].classList.remove('is-active');
        }
      });
      pinRealInput.addEventListener('input', function () {
        var val = String(pinRealInput.value || '').replace(/\D/g, '').slice(0, 4);
        pinRealInput.value = val;
        var cells = pinDisplay.querySelectorAll('.backup-pin__cell');
        for (var i = 0; i < cells.length; i++) {
          var cell = cells[i];
          if (i < val.length) {
            cell.className = 'backup-pin__cell is-filled';
            cell.innerHTML = '<span class="backup-pin__cell-dot"></span>';
          } else if (i === val.length) {
            cell.className = 'backup-pin__cell is-active';
            cell.innerHTML = '';
          } else {
            cell.className = 'backup-pin__cell';
            cell.innerHTML = '';
          }
        }
        if (val.length === 4) {
          try {
            if (window.VK && window.VK.taptic) {
              window.VK.taptic('impact', 'medium');
            }
          } catch (e) {}
        }
      });
    }

    bindFamilyHandlers(el);
    bindNotifInputs(el);
    bindValuePackHandlers(el);
  }

  function bindValuePackHandlers(el) {
    if (!window.ValuePack) { return; }
    var contribBtn = el.querySelector('[data-savings-action="contribute"]');
    if (contribBtn) {
      contribBtn.addEventListener('click', function () {
        if (!isPro()) { denyPro(el, 'sub'); return; }
        window.ValuePack.openSavingsGoalModal('contribute', function () { render(); });
      });
    }
    var cfgBtn = el.querySelector('[data-savings-action="configure"]');
    if (cfgBtn) {
      cfgBtn.addEventListener('click', function () {
        if (!isPro()) { denyPro(el, 'sub'); return; }
        window.ValuePack.openSavingsGoalModal('configure', function () { render(); });
      });
    }
  }

  function handleCsvExport() {
    var el = getAppEl();
    if (!el) return;
    if (!isPro()) { denyPro(el, 'pdf'); return; }
    if (!window.ValuePack || !window.ValuePack.downloadCsv) {
      showStatus(el, 'pdf', 'Модуль выгрузки CSV не загружен.', 'error');
      return;
    }
    window.ValuePack.downloadCsv().then(function (res) {
      if (res && res.ok) {
        showStatus(el, 'pdf', 'Таблица Excel сохранена: ' + res.fileName + ' (' + res.rowsCount + ' строк).', 'ok');
      }
    }).catch(function (err) {
      showStatus(el, 'pdf', 'Ошибка CSV: ' + (err && err.message || err), 'error');
    });
  }

  /**
   * Тумблеры и селекты секции «Уведомления».
   *
   * Слушатели again навешиваются на сами элементы: обработчик на #app
   * прожил бы дольше перерисовки раздела и начал бы копироваться
   * (урок теста 10.4.2).
   * @param {HTMLElement} el — контейнер #app
   */
  function bindNotifInputs(el) {
    var switches = el.querySelectorAll('[data-backup-notif="enabled"], [data-backup-notif="showAmounts"]');

    Array.prototype.forEach.call(switches, function (input) {
      input.addEventListener('change', function () {
        saveNotifPref(input.getAttribute('data-backup-notif'), input.checked, input);
      });
    });

    var selects = el.querySelectorAll('select[data-backup-notif]');
    Array.prototype.forEach.call(selects, function (select) {
      select.addEventListener('change', function () {
        saveNotifPref(select.getAttribute('data-backup-notif'), select.value, select);
      });
    });

    // Разрешение Notification приходит асинхронно (промпт, отказ) — строку
    // статуса обновляем по событию, не перерисовывая весь раздел. Слушатель
    // ОДИН на всё время жизни модуля: он читает #app при каждом событии,
    // поэтому перерисовки раздела его не размножают.
    if (notifStateBound) { return; }
    notifStateBound = true;

    window.addEventListener('notif:state', function () {
      var live = getAppEl();
      var line = live && live.querySelector('[data-backup-notif-perm]');
      if (line) { line.textContent = notifPermText(); }
    });
  }

  /**
   * Пишет одну настройку и перерисовывает секцию.
   *
   * Включение «системных напоминаний» обязательно спрашивает разрешение —
   * именно здесь, из обработчика change, то есть из пользовательского жеста.
   * Вне жеста Chrome отказывает молча, и тумблер показал бы «включено»
   * при работающем отказе.
   * @param {string} key
   * @param {*} value
   * @param {HTMLElement} input
   * @returns {Promise<void>}
   */
  function saveNotifPref(key, value, input) {
    var el = getAppEl();
    if (!el) { return Promise.resolve(); }
    if (!isPro()) { denyPro(el, 'notif'); return Promise.resolve(); }
    if (!window.NotifPrefs) {
      showStatus(el, 'notif', 'Модуль уведомлений не загружен.', 'error');
      return Promise.resolve();
    }

    var patch = {};
    patch[key] = key === 'leadDays' ? Number(value) : value;

    // Разрешение спрашиваем ДО записи настройки и до перерисовки: requestPermission
    // обязан попасть на пользовательский жест, а render() его «съедает»
    var ask = (key === 'enabled' && value && window.PushManager)
      ? window.PushManager.requestPermission()
      : Promise.resolve(null);

    return ask.then(function (res) {
      // Отказ — не ошибка: тумблер оставляем включённым (in-app баннеры
      // работают и без разрешения), но честно говорим о причине
      if (res && res.state === 'denied') {
        pendingStatus = { key: 'notif', msg: 'Браузер запретил уведомления — сроки будут видны баннером внутри приложения.', level: 'warn' };
      } else if (res && res.state === 'unsupported') {
        pendingStatus = { key: 'notif', msg: 'В этом браузере системных уведомлений нет. Пользуйтесь экспортом в календарь.', level: 'info' };
      } else if (res && res.state === 'granted') {
        pendingStatus = { key: 'notif', msg: 'Напоминания включены.', level: 'ok' };
      }

      return window.NotifPrefs.save(patch);
    }).then(function () {
      render();
      if (key === 'enabled') { return checkNow(); }
      return null;
    }).catch(function (err) {
      pendingStatus = null;
      showStatus(el, 'notif', 'Не удалось сохранить настройку: ' + (err && err.message || err), 'error');
      if (input) { input.checked = false; }
    });
  }

  /**
   * Проверка наступивших сроков по кнопке и сразу после включения тумблера:
   * человек должен увидеть результат действия, а не ждать следующего визита.
   * @returns {Promise<void>}
   */
  function checkNow() {
    var el = getAppEl();
    if (!el) { return Promise.resolve(); }
    if (!window.PushManager) { return Promise.resolve(); }

    return window.PushManager.checkDueEvents({ force: true }).then(function (res) {
      if (!res || res.reason === 'nothing-due') {
        showStatus(el, 'notif', 'Наступивших сроков нет.', 'ok');
        return;
      }
      showStatus(el, 'notif', remindLabel(res), res.shown ? 'ok' : 'info');
    }).catch(function (err) {
      console.info('[Backup] Проверка сроков не удалась:', err && err.message || err);
    });
  }

  /**
   * Что именно показали — по результату проверки.
   *
   * `left` важен: за один показ пушей не больше MAX_PUSH, и без этой строки
   * человек решил бы, что про остальные приложение забыло.
   * @param {Object} res — {items, shown, left, reason}
   * @returns {string}
   */
  function remindLabel(res) {
    var n = res.items ? res.items.length : 0;
    var rest = res.left > 0 ? ' Ещё ' + res.left + ' ' + plural(res.left, 'срок', 'срока', 'сроков') + ' — при следующей проверке.' : '';
    if (res.reason === 'permission') { return 'Показали баннер: ' + n + ' ' + plural(n, 'срок', 'срока', 'сроков') + '.' + rest; }
    if (res.reason === 'notification-blocked') { return 'Уведомления не прошли — показываем внутри приложения.' + rest; }
    return 'Уведомлений отправлено: ' + res.shown + ' из ' + n + '.' + rest;
  }

  /* ---------- Обработчики ---------- */

  function handleExport() {
    var el = getAppEl();
    if (!el) return;
    var btn = this;

    var spinner = btn.querySelector('.backup-spinner');
    if (spinner) { spinner.style.display = 'inline-block'; }
    btn.disabled = true;

    var origLabel = btn.querySelector('.backup-label');
    if (origLabel) origLabel.textContent = 'Подготовка…';

    exportData().then(function (dump) {
      return downloadDump(dump);
    }).then(function (filename) {
      if (filename) {
        showStatus(el, 'export', 'Скачано: ' + filename, 'ok');
      } else {
        showStatus(el, 'export', 'Не удалось запустить скачивание.', 'error');
      }
    }).catch(function (err) {
      showStatus(el, 'export', 'Ошибка: ' + err.message, 'error');
    }).finally(function () {
      if (spinner) spinner.style.display = 'none';
      btn.disabled = false;
      if (origLabel) origLabel.textContent = 'Скачать резервную копию';
    });
  }

  function handleImport() {
    var el = getAppEl();
    if (!el) return;
    var input = this;
    var file = input.files && input.files[0];
    if (!file) return;

    showStatus(el, 'import', 'Чтение файла…', 'info');

    analyzeFile(file).then(function (result) {
      input.value = '';

      if (result.status !== 'ready') {
        showStatus(el, 'import', result.message, 'error');
        return;
      }

      // Показать диалог ПЕРЕД записью в базу
      openModal(buildImportConfirmCard('Импорт заменит все текущие данные. Продолжить?'),
        function (card, close) {
          card.querySelector('[data-backup-confirm="cancel"]').addEventListener('click', function () {
            showStatus(el, 'import', 'Импорт отменён.', 'info');
            close();
          });

          card.querySelector('[data-backup-confirm="run"]').addEventListener('click', function () {
            var btn = this;
            btn.disabled = true;
            btn.textContent = 'Импорт…';

            importDump(result.dump).then(function (stats) {
              showStatus(el, 'import', 'Импортировано: ' + stats.imported +
                ', пропущено: ' + stats.skipped, 'ok');
            }).catch(function (err) {
              showStatus(el, 'import', 'Ошибка импорта: ' + err.message, 'error');
            }).finally(close);
          });
        });
    });
  }

  function handleClear() {
    var el = getAppEl();
    if (!el) return;

    openModal(buildClearConfirmCard(), function (card, close) {
      card.querySelector('[data-backup-confirm="cancel"]').addEventListener('click', close);

      card.querySelector('[data-backup-confirm="confirm"]').addEventListener('click', function () {
        var btn = this;
        btn.disabled = true;
        btn.textContent = 'Удаление…';
        clearAllData().then(function () {
          close();
          window.location.hash = 'home';
        }).catch(function (err) {
          showStatus(el, 'clear', 'Ошибка: ' + err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Удалить всё';
        });
      });
    });
  }

  /* ================================================================
     7b. PRO-ОБРАБОТЧИКИ (Этап 12.5)
     ==============================================================
     *
     * Общее правило: каждый обработчик начинается с проверки тарифа.
     * CSS скрывает кнопку, но проверка в JS обязательна — разметка лежит
     * в DOM, и без guard любой смог бы вызвать действие из консоли.
     ================================================================ */

  /**
   * Единая «занятая кнопка»: спиннер + текст «Работа…», снятие в finally.
   * @param {HTMLElement} btn
   * @param {string} busyLabel
   * @returns {Function} restore
   */
  function busy(btn, busyLabel) {
    var spinner = btn.querySelector('.backup-spinner');
    var label = btn.querySelector('.backup-label');
    var original = label ? label.textContent : '';

    if (spinner) spinner.style.display = 'inline-block';
    if (label) label.textContent = busyLabel;
    btn.disabled = true;

    return function () {
      if (spinner) spinner.style.display = 'none';
      if (label) label.textContent = original;
      btn.disabled = false;
    };
  }

  /**
   * Отказ в PRO-функции. Ругаться в консоль нельзя: это штатная ситуация,
   * а не ошибка, и тест-страж консоли считает её провалом.
   * @param {HTMLElement} el
   * @param {string} key
   */
  function denyPro(el, key) {
    showStatus(el, key, 'Доступно только в PRO.', 'info');
    if (window.VK && window.VK.notify) {
      window.VK.notify('Эта функция доступна только в PRO', 'info');
    }
  }

  /**
   * Перерисовывает раздел и показывает сообщение в уже свежем DOM.
   * @param {string} key — data-backup-status
   * @param {string} msg
   * @param {string} [level]
   */
  function refreshWithStatus(key, msg, level) {
    pendingStatus = { key: key, msg: msg, level: level || '' };
    render();
  }

  /* ---------- Облако: сохранение ---------- */

  function handleCloudSave() {
    var el = getAppEl();
    if (!el) return;
    var btn = this;

    if (!isPro()) { denyPro(el, 'cloud'); return; }
    if (!window.CloudSync) {
      showStatus(el, 'cloud', 'Модуль синхронизации не загружен.', 'error');
      return;
    }

    var restore = busy(btn, 'Сохраняем…');

    // FSAA требует пользовательский жест — он у нас есть (это click),
    // поэтому диалог выбора папки покажется нормально
    if (window.CloudSync.fsaaSupported()) {
      window.CloudSync.saveToCloudFile({ forceNew: !window.CloudSync.hasAutoFile() })
        .then(function (res) {
          if (res.cancelled) {
            showStatus(el, 'cloud', 'Выбор папки отменён — ничего не сохранено.', 'info');
            return;
          }
          if (!res.saved) {
            showStatus(el, 'cloud', res.message || 'Сохранить не удалось.', 'error');
            return;
          }
          refreshWithStatus('cloud', res.message + ' · ' + backupAgeLabel(window.CloudSync.getLastBackupAt()), 'ok');
        })
        .catch(function (err) {
          console.info('[Backup] Облачное сохранение не удалось:', err && err.message || err);
          showStatus(el, 'cloud', 'Не удалось сохранить: ' + err.message +
            '. Скачайте обычную резервную копию выше.', 'error');
        })
        .finally(restore);
      return;
    }

    // FSAA нет (например Firefox desktop): пробуем VK Storage, иначе прокси
    window.CloudSync.pushNow({ force: true })
      .then(function (res) {
        if (res.ran && res.channel === 'vk') {
          refreshWithStatus('cloud', res.message, 'ok');
        } else if (res.ran) {
          refreshWithStatus('cloud', res.message +
            '. Чтобы перенести данные на другое устройство, скачайте обычную резервную копию.', 'warn');
        } else {
          refreshWithStatus('cloud', 'Облако недоступно: ' + (res.message || 'нет канала сохранения'), 'error');
        }
      })
      .catch(function (err) {
        showStatus(el, 'cloud', 'Ошибка: ' + err.message, 'error');
      })
      .finally(restore);
  }

  /* ---------- Облако: загрузка ---------- */

  function handleCloudLoad() {
    var el = getAppEl();
    if (!el) return;
    var btn = this;

    if (!isPro()) { denyPro(el, 'cloud'); return; }
    if (!window.CloudSync) {
      showStatus(el, 'cloud', 'Модуль синхронизации не загружен.', 'error');
      return;
    }

    var restore = busy(btn, 'Читаем…');

    function applyDump(dump, sourceName) {
      var validation = validateImport(dump);

      if (!validation.valid) {
        showStatus(el, 'cloud', 'Файл не пригоден для импорта:\n' +
          validation.errors.slice(0, 3).map(function (e) { return '\u2022 ' + e; }).join('\n'), 'error');
        return;
      }

      // Подтверждение ОБЯЗАТЕЛЬНО: импорт стирает текущие данные
      openModal(buildImportConfirmCard(
        'Загружаем копию из «' + sourceName + '». Текущие данные будут заменены. Продолжить?'),
        function (card, close) {
          card.querySelector('[data-backup-confirm="cancel"]').addEventListener('click', function () {
            showStatus(el, 'cloud', 'Загрузка отменена, данные не изменены.', 'info');
            close();
          });

          card.querySelector('[data-backup-confirm="run"]').addEventListener('click', function () {
            var runBtn = this;
            runBtn.disabled = true;
            runBtn.textContent = 'Импорт…';

            importDump(dump).then(function (stats) {
              refreshWithStatus('cloud', 'Загружено из облака: ' + stats.imported +
                ' записей, пропущено ' + stats.skipped, 'ok');
              if (window.CloudSync) { window.CloudSync.markDirty(); }
            }).catch(function (err) {
              refreshWithStatus('cloud', 'Ошибка загрузки: ' + err.message, 'error');
            }).finally(function () {
              close();
            });
          });
        });
    }

    if (window.CloudSync.fsaaSupported()) {
      window.CloudSync.loadFromCloudFile()
        .then(function (res) {
          if (res.cancelled) {
            showStatus(el, 'cloud', 'Выбор файла отменён.', 'info');
            return;
          }
          if (!res.dump) {
            showStatus(el, 'cloud', res.message, 'error');
            return;
          }
          applyDump(res.dump, res.fileName);
        })
        .catch(function (err) {
          showStatus(el, 'cloud', 'Не удалось прочитать файл: ' + err.message, 'error');
        })
        .finally(restore);
      return;
    }

    window.CloudSync.pullFromVkStorage()
      .then(function (res) {
        if (!res.ok) {
          showStatus(el, 'cloud', res.message, 'error');
          return;
        }
        applyDump(res.dump, 'облако ВКонтакте');
      })
      .catch(function (err) {
        showStatus(el, 'cloud', 'Ошибка: ' + err.message, 'error');
      })
      .finally(restore);
  }

  function handleCloudForget() {
    var el = getAppEl();
    if (!el) return;

    if (!isPro() || !window.CloudSync) { return; }
    window.CloudSync.forgetFile();
    refreshWithStatus('cloud', 'Папка сброшена — при следующем сохранении выберите заново.', 'info');
  }

  /* ---------- PIN ---------- */

  function handlePinSet() {
    var el = getAppEl();
    if (!el) return;

    if (!isPro()) { denyPro(el, 'pin'); return; }
    if (!window.Security) {
      showStatus(el, 'pin', 'Модуль защиты не загружен.', 'error');
      return;
    }

    var input = el.querySelector('[data-backup-input="pin"]');
    if (!input) { return; }

    var pin = String(input.value || '').replace(/\D/g, '');

    var formatError = window.Security.validatePin(pin);
    if (formatError) {
      showStatus(el, 'pin', formatError, 'error');
      return;
    }

    // Второе подтверждение: PIN ставим намеренно, потерять доступ легко
    openModal('<h2 class="modal-content__title">Закрыть данные PIN-кодом?</h2>' +
      '<p class="modal-content__text">При следующем запуске приложение попросит ' +
      'PIN из 4 цифр. ' + (recoveryAvailable()
        ? 'Доступ можно будет восстановить по вашему VK ID.'
        : 'Восстановление по VK ID будет недоступен — запомните PIN.') + '</p>' +
      '<div class="flex gap-3 mt-4">' +
        '<button type="button" class="btn btn--secondary" style="flex:1" data-backup-confirm="cancel">Отмена</button>' +
        '<button type="button" class="btn btn--primary" style="flex:1" data-backup-confirm="run">Установить</button>' +
      '</div>',
      function (card, close) {
        card.querySelector('[data-backup-confirm="cancel"]').addEventListener('click', function () {
          showStatus(el, 'pin', 'Установка отменена.', 'info');
          close();
        });

        card.querySelector('[data-backup-confirm="run"]').addEventListener('click', function () {
          var btn = this;
          btn.disabled = true;
          btn.textContent = 'Устанавливаем…';

          window.Security.setPin(pin).then(function (res) {
            if (!res.ok) {
              showStatus(el, 'pin', res.message, 'error');
              return;
            }
            input.value = '';
            refreshWithStatus('pin', res.message, 'ok');
          }).catch(function (err) {
            showStatus(el, 'pin', 'Ошибка: ' + err.message, 'error');
          }).finally(function () {
            close();
          });
        });
      });
  }

  /** @returns {boolean} есть ли VK ID для восстановления PIN */
  function recoveryAvailable() {
    return Boolean(window.Security && window.Security.recoveryHint && window.Security.recoveryHint());
  }

  function handlePinRemove() {
    var el = getAppEl();
    if (!el) return;

    if (!isPro()) { denyPro(el, 'pin'); return; }
    if (!window.Security) { return; }

    openModal('<h2 class="modal-content__title">Снять PIN-код?</h2>' +
      '<p class="modal-content__text">Любой, кто возьмёт ваш телефон, увидит' +
      ' платежи, документы и показания. Введите текущий PIN, чтобы снять защиту.</p>' +
      '<input class="input" type="password" inputmode="numeric" pattern="[0-9]*"' +
        ' maxlength="4" placeholder="Текущий PIN" data-backup-input="pin-current"' +
        ' aria-label="Текущий PIN" autocomplete="off">' +
      '<div class="backup-status" data-backup-status="pin-current"></div>' +
      '<div class="flex gap-3 mt-4">' +
        '<button type="button" class="btn btn--secondary" style="flex:1" data-backup-confirm="cancel">Отмена</button>' +
        '<button type="button" class="btn btn--danger" style="flex:1" data-backup-confirm="run">Снять PIN</button>' +
      '</div>',
      function (card, close) {
        var input = card.querySelector('[data-backup-input="pin-current"]');
        var statusEl = card.querySelector('[data-backup-status="pin-current"]');

        input.addEventListener('input', function () {
          input.value = String(input.value || '').replace(/\D/g, '').slice(0, 4);
        });

        card.querySelector('[data-backup-confirm="cancel"]').addEventListener('click', close);

        card.querySelector('[data-backup-confirm="run"]').addEventListener('click', function () {
          var btn = this;
          btn.disabled = true;
          btn.textContent = 'Проверяем…';

          window.Security.clearPin(String(input.value || '')).then(function (res) {
            if (!res.ok) {
              statusEl.textContent = res.message;
              statusEl.className = 'backup-status backup-status--error';
              btn.disabled = false;
              btn.textContent = 'Снять PIN';
              return;
            }
            close();
            refreshWithStatus('pin', res.message, 'ok');
          }).catch(function (err) {
            statusEl.textContent = 'Ошибка: ' + err.message;
            statusEl.className = 'backup-status backup-status--error';
            btn.disabled = false;
            btn.textContent = 'Снять PIN';
          });
        });
      });
  }

  /* ---------- Семейный доступ (Этап 12.7) ---------- */

  function bindFamilyHandlers(el) {
    var createBtn = el.querySelector('[data-family-action="create"]');
    if (createBtn) {
      createBtn.addEventListener('click', handleFamilyCreate);
    }

    var inviteBtn = el.querySelector('[data-family-action="invite"]');
    if (inviteBtn) {
      inviteBtn.addEventListener('click', handleFamilyInvite);
    }

    var syncBtn = el.querySelector('[data-family-action="sync"]');
    if (syncBtn) {
      syncBtn.addEventListener('click', handleFamilySync);
    }

    var pickBtn = el.querySelector('[data-family-action="pick-file"]');
    if (pickBtn) {
      pickBtn.addEventListener('click', handleFamilyPickFile);
    }

    var leaveBtn = el.querySelector('[data-family-action="leave"]');
    if (leaveBtn) {
      leaveBtn.addEventListener('click', handleFamilyLeave);
    }

    var removeBtns = el.querySelectorAll('[data-family-action="remove-member"]');
    for (var i = 0; i < removeBtns.length; i++) {
      removeBtns[i].addEventListener('click', handleFamilyRemoveMember);
    }
  }

  function handleFamilyCreate() {
    var el = getAppEl();
    if (!el) return;
    if (!isPro()) { denyPro(el, 'family'); return; }
    if (!window.Family) return;

    var input = el.querySelector('[data-family-input="name"]');
    var name = input ? input.value.trim() : '';
    if (!name) {
      showStatus(el, 'family', 'Введите название семьи.', 'error');
      return;
    }

    window.Family.create(name).then(function (res) {
      if (res.ok) {
        pendingStatus = { key: 'family', msg: res.message, level: 'ok' };
        render();
      } else {
        showStatus(el, 'family', res.message, 'error');
      }
    });
  }

  function handleFamilyInvite() {
    var el = getAppEl();
    if (!el) return;
    if (!isPro()) { denyPro(el, 'family'); return; }
    if (!window.Family) return;

    window.Family.activeFamily().then(function (fam) {
      if (!fam) { return; }
      var link = window.Family.inviteLink(fam);
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(link).then(function () {
          showStatus(el, 'family', 'Ссылка скопирована: ' + link, 'ok');
          if (window.VK && window.VK.notify) { window.VK.notify('Ссылка-приглашение скопирована', 'success'); }
        }).catch(function () {
          showStatus(el, 'family', 'Ссылка для приглашения: ' + link, 'info');
        });
      } else {
        showStatus(el, 'family', 'Ссылка для приглашения: ' + link, 'info');
      }
    });
  }

  function handleFamilySync() {
    var el = getAppEl();
    if (!el) return;
    if (!isPro()) { denyPro(el, 'family'); return; }
    if (!window.Family) return;

    showStatus(el, 'family', 'Синхронизация...', 'info');
    window.Family.syncNow({ silent: false }).then(function () {
      render();
      showStatus(el, 'family', 'Синхронизация завершена.', 'ok');
    }).catch(function (err) {
      showStatus(el, 'family', 'Ошибка синхронизации: ' + (err && err.message || err), 'error');
    });
  }

  function handleFamilyPickFile() {
    var el = getAppEl();
    if (!el) return;
    if (!isPro()) { denyPro(el, 'family'); return; }
    if (!window.Family) return;

    window.Family.obtainFamilyFile(true).then(function (handle) {
      render();
      if (handle) {
        showStatus(el, 'family', 'Общий файл выбран: ' + (handle.name || ''), 'ok');
      }
    }).catch(function (err) {
      showStatus(el, 'family', 'Не удалось выбрать файл: ' + (err && err.message || err), 'error');
    });
  }

  function handleFamilyLeave() {
    var el = getAppEl();
    if (!el) return;
    if (!isPro()) { denyPro(el, 'family'); return; }
    if (!window.Family) return;

    window.Family.leave().then(function (res) {
      if (res.ok) {
        pendingStatus = { key: 'family', msg: res.message, level: 'ok' };
        render();
      } else {
        showStatus(el, 'family', res.message, 'error');
      }
    });
  }

  function handleFamilyRemoveMember(e) {
    var el = getAppEl();
    if (!el) return;
    if (!isPro()) { denyPro(el, 'family'); return; }
    if (!window.Family) return;

    var btn = e.target.closest('[data-family-action="remove-member"]');
    if (!btn) return;
    var uid = btn.getAttribute('data-user-id');
    if (!uid) return;

    window.Family.removeMember(uid).then(function (res) {
      if (res.ok) {
        pendingStatus = { key: 'family', msg: res.message, level: 'ok' };
        render();
      } else {
        showStatus(el, 'family', res.message, 'error');
      }
    });
  }

  /* ---------- PDF и печать ---------- */

  /** @returns {string} период, выбранный в секции отчётов */
  function selectedPeriod() {
    var el = getAppEl();
    var select = el && el.querySelector('[data-backup-input="period"]');
    return select && select.value ? select.value : 'month';
  }

  function handlePdfReport() {
    var el = getAppEl();
    if (!el) return;
    var btn = this;

    if (!isPro()) { denyPro(el, 'pdf'); return; }
    if (!window.PdfExporter || !window.Lazy) {
      showStatus(el, 'pdf', 'Модуль отчётов не загружен.', 'error');
      return;
    }

    var period = selectedPeriod();
    var restore = busy(btn, 'Готовим PDF…');
    showStatus(el, 'pdf', 'Первый запуск скачивает движок PDF (~150 КБ)…', 'info');

    window.PdfExporter.rememberPeriod(period);

    window.PdfExporter.downloadReportForPeriod(period)
      .then(function (res) {
        showStatus(el, 'pdf', 'Отчёт сохранён: ' + res.fileName + ' (' +
          res.report.payments.length + ' платежей)', 'ok');
      })
      .catch(function (err) {
        console.info('[Backup] PDF не создан:', err && err.message || err);
        // pdf-движок мог не скачаться (офлайн, лимит кэша) — предлагаем печать
        showStatus(el, 'pdf', 'Не удалось создать PDF: ' + err.message +
          '. Попробуйте «Печать отчёта» — это работает без дополнительных библиотек.', 'error');
      })
      .finally(restore);
  }

  function handlePdfPrint() {
    var el = getAppEl();
    if (!el) return;
    var btn = this;

    if (!isPro()) { denyPro(el, 'pdf'); return; }
    if (!window.PdfExporter) {
      showStatus(el, 'pdf', 'Модуль отчётов не загружен.', 'error');
      return;
    }

    var restore = busy(btn, 'Готовим…');

    window.PdfExporter.printReport(selectedPeriod())
      .then(function (res) {
        if (!res.shown) {
          showStatus(el, 'pdf', 'Печать недоступна.', 'error');
          return;
        }
        showStatus(el, 'pdf', 'Открыт предпросмотр: в диалоге печати выберите' +
          ' «Сохранить как PDF» или принтер.', 'ok');
      })
      .catch(function (err) {
        showStatus(el, 'pdf', 'Ошибка: ' + err.message, 'error');
      })
      .finally(restore);
  }

  /* ---------- Календарь и напоминания (Этап 12.6) ---------- */

  /**
   * Сколько событий легло в файл — по-русски и без «платежей 0».
   * @param {Object} counts — {payment, task, document}
   * @returns {string}
   */
  function icsCountsLabel(counts) {
    var parts = [];
    if (counts.payment) { parts.push(counts.payment + ' ' + plural(counts.payment, 'платёж', 'платежа', 'платежей')); }
    if (counts.task) { parts.push(counts.task + ' ' + plural(counts.task, 'дело', 'дела', 'дел')); }
    if (counts.document) { parts.push(counts.document + ' ' + plural(counts.document, 'документ', 'документа', 'документов')); }
    return parts.length ? 'Событий: ' + parts.join(', ') + '.' : 'В горизонте событий пока нет — файл пустой.';
  }

  /**
   * Экспорт .ics. PRO-гейт дублируется в JS: скрытая CSS-ом кнопка всё
   * равно доступна через DevTools, а генератор обязан отказать сам.
   */
  function handleIcsExport() {
    var el = getAppEl();
    if (!el) { return; }
    var btn = this;

    if (!isPro()) { denyPro(el, 'notif'); return; }

    if (!window.CalendarExport) {
      showStatus(el, 'notif', 'Модуль экспорта не загружен.', 'error');
      return;
    }

    var restore = busy(btn, 'Собираем…');

    window.CalendarExport.exportNow().then(function (res) {
      showStatus(el, 'notif', 'Файл ' + res.fileName + ' скачан. ' +
        icsCountsLabel(res.counts || {}), 'ok');

      // Строка «устарел» меняется без перерисовки раздела
      var stale = el.querySelector('[data-backup-notif-stale]');
      if (stale) {
        stale.textContent = 'Календарь обновлён ' + formatDateTime(window.CalendarExport.lastExportedAt()) + '.';
      }

      if (window.VK && window.VK.notify) {
        window.VK.notify('Добавьте файл в Google/Apple/Outlook календарь — напоминания придут от него', 'info', 5200);
      }
    }).catch(function (err) {
      showStatus(el, 'notif', 'Экспорт не удался: ' + (err && err.message || err), 'error');
    }).finally(restore);
  }

  /**
   * «Проверить сейчас» — ручной запуск того же механизма, что срабатывает
   * при фокусе. Нужен и для настройки, и для диагностики: человек видит,
   * что именно приложение считает наступившим.
   */
  function handleNotifCheck() {
    var el = getAppEl();
    if (!el) { return; }

    if (!isPro()) { denyPro(el, 'notif'); return; }

    if (!window.PushManager) {
      showStatus(el, 'notif', 'Модуль напоминаний не загружен.', 'error');
      return;
    }

    checkNow();
  }

  /* ---------- Подписка ---------- */

  function handleBuyPro() {
    var el = getAppEl();
    if (!el) return;
    var btn = this;

    if (!window.ProManager || !window.ProManager.subscribe) {
      showStatus(el, 'sub', 'Модуль подписки не загружен.', 'error');
      return;
    }

    var chosenPlanId = window.ProManager.getSelectedPlanId ? window.ProManager.getSelectedPlanId() : 'month';
    var restore = busy(btn, 'Открываем оплату…');

    window.ProManager.subscribe(chosenPlanId).then(function (res) {
      if (res && res.purchased) {
        refreshWithStatus('sub', 'PRO активен: данные под PIN-защитой и синхронизируются с облаком.', 'ok');
      } else if (res && res.cancelled) {
        showStatus(el, 'sub', 'Оплата отменена.', 'info');
      } else if (res && res.message) {
        showStatus(el, 'sub', res.message, 'error');
      }
    }).catch(function (err) {
      showStatus(el, 'sub', 'Ошибка оплаты: ' + err.message, 'error');
    }).finally(restore);
  }

  /**
   * «Управлять подпиской»: копий в VK Pay у приложения нет — серверной
   * части по ограничениям этапа нет. Поэтому уводим пользователя на
   * страницу подписок ВКонтакте и показываем адрес.
   */
  function handleManageSubscription() {
    var el = getAppEl();
    if (!el) return;

    var url = 'https://vk.com/settings?act=payments';

    if (window.VK && typeof window.VK.copyText === 'function') {
      window.VK.copyText(url).then(function (ok) {
        showStatus(el, 'sub', ok
          ? 'Ссылка на «Кошелёк → Подписки» скопирована: ' + url
          : 'Откройте вручную: ' + url, 'info');
      });
      return;
    }

    showStatus(el, 'sub', 'Управление подпиской: ' + url, 'info');
  }

  /**
   * Модальное окно ввода промокода PRO (Luxury Edition).
   */
  function handlePromoCodeModal() {
    var el = getAppEl();
    if (!el || !window.ProManager) return;

    var ticketIcon = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>';

    var html = '<div class="exec-modal-head">' +
        '<div class="exec-modal-head__icon exec-modal-head__icon--blue">' + ticketIcon + '</div>' +
        '<div>' +
          '<h2 class="exec-modal-head__title">Активация промокода</h2>' +
          '<p class="exec-modal-head__sub">Введите подарочный код или ключ лицензии PRO</p>' +
        '</div>' +
      '</div>' +
      '<div class="exec-promo-input-wrap">' +
        '<input type="text" class="exec-promo-input" data-promo-input="code" placeholder="MYORDER-VIP-YEAR" autocomplete="off" spellcheck="false">' +
      '</div>' +
      '<div class="backup-status" data-promo-status></div>' +
      '<div class="exec-modal-footer">' +
        '<button type="button" class="btn btn--primary w-full" data-promo-action="apply">Активировать доступ PRO</button>' +
        '<button type="button" class="btn btn--secondary w-full" data-promo-action="cancel">Отмена</button>' +
      '</div>';

    openModal(html, function (card, close) {
      var input = card.querySelector('[data-promo-input="code"]');
      var statusEl = card.querySelector('[data-promo-status]');

      card.querySelector('[data-promo-action="cancel"]').addEventListener('click', close);
      card.querySelector('[data-promo-action="apply"]').addEventListener('click', function () {
        var code = input ? input.value : '';
        var res = window.ProManager.redeemPromoCode(code);
        if (!res.ok) {
          statusEl.textContent = res.message;
          statusEl.className = 'backup-status backup-status--error';
          return;
        }
        close();
        refreshWithStatus('sub', res.message, 'ok');
      });
    });
  }

  /**
   * Панель владельца приложения («Управление подписками PRO» — Executive Edition).
   */
  function handleOwnerPanelModal() {
    var el = getAppEl();
    if (!el || !window.ProManager) return;
    var pm = window.ProManager;

    var crownIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14"/></svg>';

    if (!pm.isOwner()) {
      var unlockHtml = '<div class="exec-modal-head">' +
          '<div class="exec-modal-head__icon exec-modal-head__icon--gold">' + crownIcon + '</div>' +
          '<div>' +
            '<h2 class="exec-modal-head__title">Доступ владельца</h2>' +
            '<p class="exec-modal-head__sub">Центр управления подписками и VIP-доступом</p>' +
          '</div>' +
        '</div>' +
        '<div class="exec-section-card">' +
          '<label class="exec-field-label">Секретный мастер-ключ</label>' +
          '<input type="password" class="exec-promo-input" data-owner-input="key" placeholder="••••••••••••" autocomplete="off">' +
          '<p class="exec-field-hint">Доступ защищён сквозным криптографическим хэшированием SHA-256</p>' +
        '</div>' +
        '<div class="backup-status" data-owner-status></div>' +
        '<div class="exec-modal-footer">' +
          '<button type="button" class="btn btn--primary w-full" data-owner-action="unlock">Открыть панель владельца</button>' +
          '<button type="button" class="btn btn--secondary w-full" data-owner-action="cancel">Отмена</button>' +
        '</div>';

      openModal(unlockHtml, function (card, close) {
        var input = card.querySelector('[data-owner-input="key"]');
        var statusEl = card.querySelector('[data-owner-status]');
        card.querySelector('[data-owner-action="cancel"]').addEventListener('click', close);
        card.querySelector('[data-owner-action="unlock"]').addEventListener('click', function () {
          var key = input ? input.value : '';
          pm.unlockOwner(key).then(function (res) {
            if (!res.ok) {
              statusEl.textContent = res.message;
              statusEl.className = 'backup-status backup-status--error';
              return;
            }
            close();
            setTimeout(handleOwnerPanelModal, 280);
          });
        });
      });
      return;
    }

    var currentPro = pm.isPro();
    var activePlan = pm.getActivePlan();
    var vipEntries = pm.getVipEntries ? pm.getVipEntries() : [];
    var vkUser = window.VK && window.VK.user && window.VK.user();
    var myVkId = (window.VK && window.VK.userId && window.VK.userId()) || (vkUser && vkUser.id ? String(vkUser.id) : '');
    var currentModeKey = !currentPro ? 'free' : (activePlan && activePlan.id ? activePlan.id : 'lifetime');

    var vipListHtml = vipEntries.length
      ? vipEntries.map(function (entry) {
          var planName = entry.plan === 'lifetime' ? 'Навсегда' : (entry.plan === 'year' ? '1 год' : '1 месяц');
          return '<span class="owner-vip-chip">' +
            '<span class="owner-vip-chip__dot"></span>' +
            '<span>VK ID ' + esc(entry.vkId) + ' <small style="opacity:0.85;font-weight:600;">· ' + esc(planName) + '</small></span>' +
            '<button type="button" class="owner-vip-chip__del" data-owner-del-vip="' + esc(entry.vkId) + '" aria-label="Удалить ID">×</button>' +
          '</span>';
        }).join('')
      : '<div class="exec-empty-vip">Пока нет выданных VIP ID</div>';

    var tierModes = [
      { key: 'lifetime', title: 'PRO Навсегда', sub: 'Вечный VIP-доступ', badge: 'VIP' },
      { key: 'year', title: 'PRO на 1 год', sub: 'Тариф 890 ₽ / год', badge: '-25%' },
      { key: 'month', title: 'PRO на 1 месяц', sub: 'Тариф 99 ₽ / мес', badge: '' },
      { key: 'free', title: 'Базовый Free', sub: 'Для теста без PRO', badge: '' }
    ];

    var todayIso = new Date().toISOString().slice(0, 10);
    var oneYearDate = new Date();
    oneYearDate.setFullYear(oneYearDate.getFullYear() + 1);
    var oneYearIso = oneYearDate.toISOString().slice(0, 10);

    var consoleHtml = '<div class="exec-owner-hero">' +
        '<div class="exec-owner-hero__top">' +
          '<div class="exec-owner-hero__badge">' + crownIcon + ' <span>OWNER CONSOLE</span></div>' +
          '<span class="exec-owner-hero__status ' + (currentPro ? 'is-pro' : 'is-free') + '">' +
            (currentPro ? ('Активен: ' + esc(activePlan.title)) : 'Режим: Free') +
          '</span>' +
        '</div>' +
        '<h2 class="exec-owner-hero__title">Управление подписками</h2>' +
        '<p class="exec-owner-hero__desc">Выдача PRO по VK ID с выбором тарифа, проверка тарифов на этом устройстве и генератор промокодов.</p>' +
      '</div>' +

      '<div class="exec-section-card">' +
        '<div class="exec-section-card__title">1. Выберите тариф для выдачи</div>' +
        '<p class="exec-field-hint" style="margin-bottom:10px;">Нажмите на тариф, который хотите выдать пользователю. Ваш личный тариф не изменится.</p>' +
        '<div class="exec-grant-grid" data-owner-grant-grid>' +
          '<button type="button" class="exec-grant-tile" data-grant-plan="month">' +
            '<div class="exec-grant-tile__top">' +
              '<span class="exec-grant-tile__dot"></span>' +
            '</div>' +
            '<div class="exec-grant-tile__name">PRO на 1 месяц</div>' +
            '<div class="exec-grant-tile__price">99 ₽ / мес</div>' +
          '</button>' +
          '<button type="button" class="exec-grant-tile" data-grant-plan="year">' +
            '<div class="exec-grant-tile__top">' +
              '<span class="exec-grant-tile__dot"></span>' +
              '<span class="exec-tier-tile__tag">-25%</span>' +
            '</div>' +
            '<div class="exec-grant-tile__name">PRO на 1 год</div>' +
            '<div class="exec-grant-tile__price">890 ₽ / год</div>' +
          '</button>' +
          '<button type="button" class="exec-grant-tile exec-grant-tile--active" data-grant-plan="lifetime">' +
            '<div class="exec-grant-tile__top">' +
              '<span class="exec-grant-tile__dot"></span>' +
              '<span class="exec-tier-tile__tag">VIP</span>' +
            '</div>' +
            '<div class="exec-grant-tile__name">PRO Навсегда</div>' +
            '<div class="exec-grant-tile__price">1 490 ₽ разово</div>' +
          '</button>' +
        '</div>' +
        '<div class="form-group" style="margin-bottom:12px;">' +
          '<label class="exec-field-label">2. Введите VK ID пользователя</label>' +
          '<div class="exec-vip-form">' +
            '<input type="text" inputmode="numeric" class="exec-vip-input" data-owner-input="vkid" placeholder="Например: 12345678">' +
            '<button type="button" class="exec-vip-add-btn" data-owner-action="add-vip">+ Выдать PRO Навсегда</button>' +
          '</div>' +
        '</div>' +
        '<label class="exec-field-label" style="margin-bottom:6px;">Активные VIP-пользователи (' + vipEntries.length + ')</label>' +
        '<div class="owner-vip-list" data-owner-vip-list>' + vipListHtml + '</div>' +
      '</div>' +

      '<div class="exec-section-card" style="opacity:0.9;">' +
        '<div class="exec-section-card__title">🔧 Тестирование на этом устройстве</div>' +
        '<p class="exec-field-hint" style="margin-bottom:10px;">Переключает тариф ТОЛЬКО на вашем экране для проверки отображения Free или других планов.</p>' +
        '<div class="exec-tier-grid">' +
          tierModes.map(function (m) {
            var isAct = currentModeKey === m.key;
            return '<button type="button" class="exec-tier-tile' + (isAct ? ' exec-tier-tile--active' : '') + '" data-owner-set-tier="' + m.key + '">' +
              '<div class="exec-tier-tile__top">' +
                '<span class="exec-tier-tile__dot"></span>' +
                (m.badge ? '<span class="exec-tier-tile__tag">' + esc(m.badge) + '</span>' : '') +
              '</div>' +
              '<div class="exec-tier-tile__name">' + esc(m.title) + '</div>' +
              '<div class="exec-tier-tile__sub">' + esc(m.sub) + '</div>' +
            '</button>';
          }).join('') +
        '</div>' +
      '</div>' +

      '<div class="exec-section-card">' +
        '<div class="exec-section-card__title">Генератор промокодов</div>' +
        '<div class="exec-creator-grid">' +
          '<div class="form-group" style="margin-bottom:10px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
              '<label class="exec-field-label" style="margin:0;">Код промокода</label>' +
              '<button type="button" class="exec-gen-magic-btn" data-owner-action="magic-code">⚡ Сгенерировать</button>' +
            '</div>' +
            '<input type="text" class="exec-vip-input" data-create-promo="code" placeholder="Например: VIP2026 или SALE50" style="text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;letter-spacing:0.5px;">' +
          '</div>' +

          '<div class="form-group" style="margin-bottom:10px;">' +
            '<label class="exec-field-label">Процент скидки (100% = Бесплатный PRO)</label>' +
            '<div class="exec-input-addon-wrap">' +
              '<input type="number" min="1" max="100" class="exec-vip-input" data-create-promo="discount" value="100" placeholder="100">' +
              '<span class="exec-input-addon">%</span>' +
            '</div>' +
            '<div class="exec-mini-pills">' +
              '<button type="button" class="exec-mini-pill" data-set-disc="100">100% (PRO)</button>' +
              '<button type="button" class="exec-mini-pill" data-set-disc="50">50%</button>' +
              '<button type="button" class="exec-mini-pill" data-set-disc="30">30%</button>' +
              '<button type="button" class="exec-mini-pill" data-set-disc="20">20%</button>' +
            '</div>' +
          '</div>' +

          '<div class="form-group" style="margin-bottom:10px;">' +
            '<label class="exec-field-label">Для какого тарифа</label>' +
            '<div class="exec-select-wrap">' +
              '<select class="exec-select" data-create-promo="plan">' +
                '<option value="year" selected>Только на 1 год (890 ₽)</option>' +
                '<option value="lifetime">Только Навсегда (1 490 ₽)</option>' +
                '<option value="month">Только на 1 месяц (99 ₽)</option>' +
                '<option value="all">На любой тариф</option>' +
              '</select>' +
              '<span class="exec-select-arrow" aria-hidden="true">' +
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>' +
              '</span>' +
            '</div>' +
          '</div>' +

          '<div class="form-group" style="margin-bottom:12px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
              '<label class="exec-field-label" style="margin:0;">Срок действия (с даты по дату)</label>' +
              '<label class="exec-check-label">' +
                '<input type="checkbox" data-create-promo="never-expire" checked>' +
                '<span>Бессрочно</span>' +
              '</label>' +
            '</div>' +
            '<div class="exec-dates-grid" data-create-promo-dates style="opacity:0.45;pointer-events:none;">' +
              '<div class="exec-date-col">' +
                '<span class="exec-date-sub">С даты</span>' +
                '<input type="date" class="exec-vip-input exec-date-input" data-create-promo="date-from" value="' + todayIso + '">' +
              '</div>' +
              '<div class="exec-date-col">' +
                '<span class="exec-date-sub">По дату</span>' +
                '<input type="date" class="exec-vip-input exec-date-input" data-create-promo="date-to" value="' + oneYearIso + '">' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<button type="button" class="btn btn--primary btn--sm w-full" data-owner-action="create-promo" style="margin-top:4px;">+ Создать промокод</button>' +
          '<div data-owner-created-result style="display:none;margin-top:10px;"></div>' +
        '</div>' +
      '</div>' +

      '<div class="backup-status" data-owner-console-status></div>' +
      '<div class="exec-modal-footer">' +
        '<button type="button" class="btn btn--primary w-full" data-owner-action="close">Готово</button>' +
        '<button type="button" class="exec-lock-link" data-owner-action="lock">Выйти из панели владельца</button>' +
      '</div>';

    openModal(consoleHtml, function (card, close) {
      var statusEl = card.querySelector('[data-owner-console-status]');

      var tierBtns = card.querySelectorAll('[data-owner-set-tier]');
      Array.prototype.forEach.call(tierBtns, function (b) {
        b.addEventListener('click', function () {
          var mode = b.getAttribute('data-owner-set-tier');
          if (mode === 'free') {
            pm.setOwnerPro('free');
            close();
            refreshWithStatus('sub', 'Владелец: включён режим Free для проверки базовой версии.', 'info');
          } else {
            pm.setOwnerPro('pro', mode);
            close();
            refreshWithStatus('sub', 'Владелец: активирован бессрочный PRO (' + pm.getActivePlan().title + ').', 'ok');
          }
        });
      });

      var selectedGrantPlan = 'lifetime';
      var grantTiles = card.querySelectorAll('[data-grant-plan]');
      var addVipBtn = card.querySelector('[data-owner-action="add-vip"]');
      var vkInput = card.querySelector('[data-owner-input="vkid"]');

      var planLabels = {
        month: 'на 1 месяц',
        year: 'на 1 год',
        lifetime: 'Навсегда'
      };

      Array.prototype.forEach.call(grantTiles, function (tile) {
        tile.addEventListener('click', function () {
          selectedGrantPlan = tile.getAttribute('data-grant-plan') || 'lifetime';
          Array.prototype.forEach.call(grantTiles, function (t) {
            t.classList.remove('exec-grant-tile--active');
          });
          tile.classList.add('exec-grant-tile--active');
          if (addVipBtn) {
            addVipBtn.textContent = '+ Выдать PRO ' + (planLabels[selectedGrantPlan] || 'Навсегда');
          }
        });
      });

      if (addVipBtn && vkInput) {
        addVipBtn.addEventListener('click', function () {
          var res = pm.addVipVkId(vkInput.value, selectedGrantPlan);
          statusEl.textContent = res.message;
          statusEl.className = 'backup-status backup-status--' + (res.ok ? 'ok' : 'error');
          if (res.ok) {
            vkInput.value = '';
            close();
            setTimeout(handleOwnerPanelModal, 280);
          }
        });
      }

      var delVipBtns = card.querySelectorAll('[data-owner-del-vip]');
      Array.prototype.forEach.call(delVipBtns, function (delBtn) {
        delBtn.addEventListener('click', function () {
          pm.removeVipVkId(delBtn.getAttribute('data-owner-del-vip'));
          close();
          setTimeout(handleOwnerPanelModal, 280);
        });
      });

      var neverExpireCheck = card.querySelector('[data-create-promo="never-expire"]');
      var datesGrid = card.querySelector('[data-create-promo-dates]');
      if (neverExpireCheck && datesGrid) {
        neverExpireCheck.addEventListener('change', function () {
          if (neverExpireCheck.checked) {
            datesGrid.style.opacity = '0.45';
            datesGrid.style.pointerEvents = 'none';
          } else {
            datesGrid.style.opacity = '1';
            datesGrid.style.pointerEvents = 'auto';
          }
        });
      }

      var discInput = card.querySelector('[data-create-promo="discount"]');
      var discPills = card.querySelectorAll('[data-set-disc]');
      Array.prototype.forEach.call(discPills, function (pill) {
        pill.addEventListener('click', function () {
          if (discInput) {
            discInput.value = pill.getAttribute('data-set-disc');
            discInput.focus();
          }
        });
      });

      var magicBtn = card.querySelector('[data-owner-action="magic-code"]');
      if (magicBtn) {
        magicBtn.addEventListener('click', function () {
          var codeInput = card.querySelector('[data-create-promo="code"]');
          var planSelect = card.querySelector('[data-create-promo="plan"]');
          var discIn = card.querySelector('[data-create-promo="discount"]');
          var planVal = planSelect ? planSelect.value : 'year';
          var discVal = discIn ? discIn.value : '100';

          var prefix = discVal === '100'
            ? (planVal === 'lifetime' ? 'VIP-FOREVER' : (planVal === 'year' ? 'VIP-YEAR' : 'VIP-PRO'))
            : ('SALE-' + discVal);
          var rand = Math.floor(1000 + Math.random() * 9000);
          if (codeInput) {
            codeInput.value = prefix + '-' + rand;
            codeInput.focus();
          }
        });
      }

      var createPromoBtn = card.querySelector('[data-owner-action="create-promo"]');
      if (createPromoBtn) {
        createPromoBtn.addEventListener('click', function () {
          var codeInput = card.querySelector('[data-create-promo="code"]');
          var discIn = card.querySelector('[data-create-promo="discount"]');
          var planSelect = card.querySelector('[data-create-promo="plan"]');
          var neverCheck = card.querySelector('[data-create-promo="never-expire"]');
          var dateFromIn = card.querySelector('[data-create-promo="date-from"]');
          var dateToIn = card.querySelector('[data-create-promo="date-to"]');
          var resultHost = card.querySelector('[data-owner-created-result]');

          var codeVal = (codeInput && codeInput.value ? codeInput.value : '').trim().toUpperCase();
          var discVal = Number(discIn ? discIn.value : 100) || 100;
          if (discVal < 1) discVal = 1;
          if (discVal > 100) discVal = 100;
          var planVal = planSelect ? planSelect.value : 'year';

          var isNever = neverCheck ? neverCheck.checked : true;
          var validFrom = !isNever && dateFromIn ? dateFromIn.value : '';
          var validTo = !isNever && dateToIn ? dateToIn.value : '';

          if (!codeVal) {
            var prefix = discVal === '100'
              ? (planVal === 'lifetime' ? 'VIP-FOREVER' : (planVal === 'year' ? 'VIP-YEAR' : 'VIP-PRO'))
              : ('SALE-' + discVal);
            codeVal = prefix + '-' + Math.floor(1000 + Math.random() * 9000);
            if (codeInput) codeInput.value = codeVal;
          }

          var res = pm.createPromo({
            code: codeVal,
            discount: discVal,
            plan: planVal,
            validFrom: validFrom,
            validTo: validTo
          });

          if (!res.ok) {
            statusEl.textContent = res.message;
            statusEl.className = 'backup-status backup-status--error';
            return;
          }

          statusEl.textContent = '';
          statusEl.className = 'backup-status';

          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(res.promo.code).catch(function () {});
          }

          if (resultHost) {
            resultHost.style.display = 'block';
            resultHost.innerHTML = '<div class="exec-created-card">' +
              '<div class="exec-created-card__head">' +
                '<span>✓ Промокод готов и скопирован!</span>' +
              '</div>' +
              '<div class="exec-created-card__body">' +
                '<code class="exec-created-card__code">' + esc(res.promo.code) + '</code>' +
                '<button type="button" class="exec-created-card__copy-btn" data-copy-res="' + esc(res.promo.code) + '">Скопировать</button>' +
              '</div>' +
              '<div class="exec-created-card__info">' + esc(res.promo.label) + '</div>' +
            '</div>';

            var cBtn = resultHost.querySelector('[data-copy-res]');
            if (cBtn) {
              cBtn.addEventListener('click', function () {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(res.promo.code).catch(function () {});
                }
                cBtn.textContent = '✓ Скопировано';
                setTimeout(function () { cBtn.textContent = 'Скопировать'; }, 1800);
              });
            }
          }
        });
      }

      card.querySelector('[data-owner-action="lock"]').addEventListener('click', function () {
        pm.lockOwner();
        close();
        refreshWithStatus('sub', 'Режим владельца закрыт.', 'info');
      });

      card.querySelector('[data-owner-action="close"]').addEventListener('click', function () {
        close();
        render();
      });
    });
  }

  /* ================================================================
     8. ПУБЛИЧНЫЙ API
     ================================================================ */

  window.Backup = {
    init: function () {
      if (listenersBound) return;
      listenersBound = true;
      console.info('[Backup] Модуль загружен. API: window.Backup');
    },
    render: render,
    switchTab: switchSettingsTab,
    activeTab: function () { return activeSettingsTab; },
    exportData: exportData,
    downloadDump: downloadDump,
    importData: analyzeFile, // public alias
    validateImport: validateImport,
    clearAllData: clearAllData,

    // Этап 12.5 (используются тестами и pro-manager)
    importDump: importDump,
    isPro: isPro,
    backupAgeLabel: backupAgeLabel,
    cloudSectionHtml: cloudSectionHtml,
    pinSectionHtml: pinSectionHtml,
    reportSectionHtml: reportSectionHtml,
    subscriptionSectionHtml: subscriptionSectionHtml,

    // Этап 12.6
    notificationsSectionHtml: notificationsSectionHtml,
    notifPermText: notifPermText,
    saveNotifPref: saveNotifPref,
    checkNow: checkNow
  };

})();
