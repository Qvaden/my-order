/**
 * МОЙ ПОРЯДОК — семейный доступ (Этап 12.7, PRO ONLY)
 *
 * Что это. Несколько человек ведут один household: коммуналка, интернет,
 * показания счётчиков, общие дела. Каждый со своего устройства и своего
 * аккаунта ВК, без общего сервера приложения.
 *
 * Почему именно файл, а не VK Storage. CloudSync пишет бэкап в VK Storage,
 * но это хранилище привязано к АККАУНТУ: второй человек не прочитает то, что
 * положил первый. Единственный бесплатный общий канал между двумя людьми без
 * своего бэкенда — файл в облачной папке (OneDrive/Dropbox/iCloud), куда оба
 * имеют доступ. Его даёт File System Access API: на первом устройстве человек
 * один раз выбирает общий файл, дальше синхронизацию делает само облако.
 *
 * Транспорт поэтому абстрагирован (read/write по sharedDataKey):
 *   • file — FSAA, основной путь на проде;
 *   • http — localhost-only подменный канал, нужен чтобы multi-user сценарий
 *     проверялся двумя браузерами в тестах без ручного выбора папки.
 *     Вне localhost он не поднимается никогда, так что в проде второго пути
 *     наружу нет.
 *
 * Консистентность — eventual. Победило то, у что updatedAt позже (latest
 * wins); удаление — tombstone, он приоритетнее изменения. Локальные id
 * IndexedDB для слияния непригодны (у обоих участников первый платёж имеет
 * id=1), поэтому сущности сопоставляются по uid — его db.js выдаёт сам.
 *
 * Приватность. В общий файл уходит ТОЛЬКО то, что помечено familyScope =
 * 'family'. По умолчанию общие: ЖКХ/интернет/мобильная связь, дела, счётчики
 * и показания. По умолчанию личные: любые документы и категории «Кредиты» и
 * «Личные» — паспорт и медсправки в семью не утекут, даже если человек
 * забыл переключатель.
 *
 * Экспортирует: window.Family
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  /** @const {string} ключ settings: id активной семьи (null — вне семьи) */
  var SET_ACTIVE = 'activeFamilyId';

  /** @const {string} ключ settings: журнал удалений (tombstones) */
  var SET_TOMBSTONES = 'family_tombstones';

  /** @const {string} ключ settings: локальный id пользователя */
  var KEY_LOCAL_UID = 'myorder_local_uid';

  /** @const {number} tombstone «помнит» удаления столько суток */
  var TOMBSTONE_TTL_DAYS = 120;

  /** @const {number} период фоновой синхронизации, мс (условие этапа — 5 мин) */
  var SYNC_INTERVAL = 5 * 60 * 1000;

  /** @const {number} не чаще одного фонового pull за окно, мс */
  var PULL_THROTTLE = 30 * 1000;

  /**
   * Идентификатор приложения в ссылке-приглашении. Реальный app id присылает
   * сам ВКонтакте (vk_app_id в параметрах запуска); константа — только фолбэк
   * для браузера, куда эти параметры не приходят.
   * @const {string}
   */
  var FALLBACK_APP_ID = '0';

  /** @const {string} маршрут приглашения внутри приложения */
  var INVITE_ROUTE = 'family-invite';

  /**
   * Хранилища, участвующие в семейном обмене. settings и families — нет:
   * тема, язык и состав семьи не мигрируют между людьми (условие этапа).
   * @const {string[]}
   */
  var SHARED_STORES = ['payments', 'tasks', 'documents', 'meters', 'meter_readings'];

  /**
   * Категории платежей, которые по умолчанию считаются общими. ТЗ этапа
   * называет их явно; всё остальное (в т.ч. «Кредиты» и «Личные») — личное.
   * @const {string[]}
   */
  var SHARED_PAYMENT_CATEGORIES = ['Коммунальные', 'Интернет', 'Мобильная связь'];

  /** @const {Object.<string, boolean>} scope по умолчанию для новых записей */
  var SCOPE_LABELS = { family: 'Общая', personal: 'Личная' };

  /* ================================================================
     2. СОСТОЯНИЕ
     ================================================================ */

  /** @type {boolean} слушатели привязаны (только PRO) */
  var bound = false;

  /** @type {number|null} id интервала синхронизации */
  var timerId = null;

  /** @type {number} время последнего pull, мс epoch (троттлинг) */
  var lastPullAt = 0;

  /** @type {boolean} идёт ли сейчас обмен */
  var busy = false;

  /** @type {Object|null} handle общего файла (память сессии) */
  var familyFileHandle = null;

  /** @type {?Promise<Object>} кэш активной семьи, чтобы не читать БД на каждый чих */
  var activeCache = null;

  /* ================================================================
     3. УТИЛИТЫ
     ================================================================ */

  /** @returns {boolean} активен ли PRO */
  function isPro() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  /** @param {string} message @param {string} [type] */
  function toast(message, type) {
    if (window.VK && typeof window.VK.notify === 'function') {
      window.VK.notify(message, type || 'info');
    }
  }

  /**
   * Русская плюрализация: 1 участник / 2 участника / 5 участников.
   * @param {number} n @param {string} one @param {string} few @param {string} many
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
   * uuid v4. Тот же приём, что в db.js: крипто-генератор, с фолбэками для
   * движков без randomUUID.
   * @returns {string}
   */
  function uuid() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') {
      try { return c.randomUUID(); } catch (err) { /* ниже */ }
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
    var out = '';
    for (var j = 0; j < 36; j++) {
      out += (j === 8 || j === 13 || j === 18 || j === 23) ? '-'
        : (j === 14 ? '4' : Math.floor(Math.random() * 16).toString(16));
    }
    return out;
  }

  /**
   * Локальный ключ localStorage с защитой от приватного режима.
   * @param {string} key @returns {string|null}
   */
  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }

  /** @param {string} key @param {string} value @returns {boolean} */
  function lsSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (err) {
      console.info('[Family] localStorage недоступен для записи:', err && err.name);
      return false;
    }
  }

  /** @param {string} key */
  function lsRemove(key) {
    try { localStorage.removeItem(key); } catch (err) { /* игнорируем */ }
  }

  /**
   * Идентификатор «меня». Внутри VK — реальный user_id, вне — стабильный
   * локальный uuid, переживающий перезагрузку (иначе после каждого старта
   * записи «сменили бы владельца»).
   * @returns {string}
   */
  function myUserId() {
    var vk = window.VK && typeof window.VK.user === 'function' ? window.VK.user() : null;
    if (vk && (vk.id || vk.user_id)) { return 'vk_' + (vk.id || vk.user_id); }

    var cached = lsGet(KEY_LOCAL_UID);
    if (cached) { return cached; }

    var fresh = 'local_' + uuid();
    lsSet(KEY_LOCAL_UID, fresh);
    return fresh;
  }

  /** @returns {string} имя пользователя для подписи участника */
  function myDisplayName() {
    var vk = window.VK && typeof window.VK.user === 'function' ? window.VK.user() : null;
    if (vk && vk.first_name) { return vk.first_name; }
    return 'Я';
  }

  /* ================================================================
     4. SETTINGS (активная семья)
     ================================================================ */

  /**
   * Читает запись settings как объект { key, value } или null.
   * @param {string} key @returns {Promise<?>}
   */
  function readSetting(key) {
    if (!window.DB) { return Promise.resolve(null); }
    return window.DB.get('settings', key)
      .then(function (rec) { return rec && 'value' in rec ? rec.value : null; })
      .catch(function () { return null; });
  }

  /**
   * Пишет настройку settings, не зная, существует ли она (add или update).
   * @param {string} key @param {*} value @returns {Promise<void>}
   */
  function writeSetting(key, value) {
    if (!window.DB) { return Promise.reject(new Error('База данных не готова')); }

    return window.DB.get('settings', key).then(function (rec) {
      if (rec) { return window.DB.update('settings', key, { value: value }); }
      return window.DB.add('settings', { key: key, value: value });
    }).then(function () {
      if (key === SET_ACTIVE) { activeCache = null; }
    });
  }

  /* ================================================================
     5. МОДЕЛЬ СЕМЬИ
     ================================================================ */

  /**
   * Активная семья: запись из store `families` по settings.activeFamilyId.
   * Кэшируется на сессию и сбрасывается при любой смене состава.
   * @param {boolean} [force] — прочитать заново
   * @returns {Promise<?Object>}
   */
  function activeFamily(force) {
    if (!window.DB) { return Promise.resolve(null); }
    if (activeCache && !force) { return Promise.resolve(activeCache); }

    return readSetting(SET_ACTIVE).then(function (id) {
      if (!id && id !== 0) { activeCache = null; return null; }
      return window.DB.get('families', id).then(function (fam) {
        if (!fam) {
          // запись семьи удалена, а ссылка осталась — чиним молча
          activeCache = null;
          return writeSetting(SET_ACTIVE, null).then(function () { return null; });
        }
        activeCache = fam;
        return fam;
      });
    });
  }

  /** @returns {boolean} активна ли семья (синхронно, по кэшу) */
  function isActive() {
    return Boolean(activeCache);
  }

  /** @returns {?string} название активной семьи для шапки */
  function activeName() {
    return activeCache ? activeCache.name : null;
  }

  /**
   * Роль текущего пользователя в активной семье.
   * @returns {?string} 'admin' | 'member' | null (вне семьи)
   */
  function myRole() {
    if (!activeCache) { return null; }
    var me = myUserId();
    for (var i = 0; i < activeCache.members.length; i++) {
      if (activeCache.members[i].userId === me) { return activeCache.members[i].role; }
    }
    return null;
  }

  /** @returns {boolean} администрирует ли текущий пользователь семью */
  function isAdmin() {
    return myRole() === 'admin';
  }

  /**
   * Сохраняет семью в store и обновляет кэш. Состав меняется редко, поэтому
   * лишние оптимистичные блокировки не нужны.
   * @param {Object} family @returns {Promise<Object>}
   */
  function saveFamily(family) {
    family.updatedAt = new Date().toISOString();
    activeCache = family;

    return window.DB.get('families', family.id).then(function (existing) {
      if (existing) { return window.DB.update('families', family.id, family); }
      return window.DB.add('families', family);
    }).then(function () { return family; });
  }

  /* ================================================================
     6. СОЗДАНИЕ СЕМЬИ (ADMIN)
     ================================================================ */

  /**
   * Создаёт семью: uuid семьи, общий ключ, единственный участник-админ.
   *
   * PRO проверяется здесь, а не только в UI: `Family.create()` доступна из
   * консоли и из теста, и отказ должен быть в коде, а не в CSS.
   *
   * @param {string} name — название, которое ввёл человек
   * @returns {Promise<{ok: boolean, family: ?Object, message: string}>}
   */
  function create(name) {
    if (!isPro()) {
      return Promise.resolve({ ok: false, family: null, message: 'Семейный доступ доступен только в PRO.' });
    }
    if (!window.DB) {
      return Promise.resolve({ ok: false, family: null, message: 'База данных ещё не готова.' });
    }

    var clean = String(name || '').trim().slice(0, 60);
    if (!clean) {
      return Promise.resolve({ ok: false, family: null, message: 'Введите название семьи.' });
    }

    var now = new Date().toISOString();
    var family = {
      id: uuid(),
      sharedDataKey: uuid(),
      name: clean,
      adminUserId: myUserId(),
      members: [{
        userId: myUserId(),
        role: 'admin',
        name: myDisplayName(),
        joinedAt: now
      }],
      createdAt: now,
      updatedAt: now
    };

    return window.DB.add('families', family)
      .then(function () { return writeSetting(SET_ACTIVE, family.id); })
      .then(function () {
        activeCache = family;
        bind();
        return pushNow({ silent: true }).then(function () {
          console.info('[Family] Семья «' + clean + '» создана, участников 1.');
          return { ok: true, family: family, message: 'Семьёй «' + clean + '» управляете вы.' };
        });
      })
      .catch(function (err) {
        console.info('[Family] Создание семьи не удалось:', err && err.message || err);
        return { ok: false, family: null, message: 'Не удалось создать семью: ' + (err && err.message || err) };
      });
  }

  /**
   * Ссылка-приглашение. Маршрут — hash, потому что VK Mini App открывает
   * приложение по адресу вида https://vk.com/app1234567#..., и всё после
   * решётки доходит до нас без сервера.
   *
   * Ключ в параметре `key` — это и есть sharedDataKey: человек, у которого
   * есть ссылка, получает доступ к общему файлу. Поэтому ссылку нельзя
   * публиковать публично — об этом прямо сказано в UI.
   *
   * @param {Object} family
   * @returns {string}
   */
  function inviteLink(family) {
    if (!family) { return ''; }

    var params = new URLSearchParams();
    params.set('key', family.sharedDataKey);
    params.set('from', family.adminUserId);
    params.set('name', family.name);

    // Внутри VK идем на канонический адрес приложения; вне — на текущий
    // документ (локальная разработка и браузерный режим)
    var base;
    try {
      var p = new URLSearchParams(window.location.search);
      var appId = p.get('vk_app_id') || p.get('vk_ref') || '';
      var realId = /^[0-9]+$/.test(String(appId)) ? appId : null;
      base = realId
        ? 'https://vk.com/app' + realId + '/#'
        : window.location.origin + window.location.pathname + '#';
    } catch (err) {
      base = 'https://vk.com/app' + FALLBACK_APP_ID + '/#';
    }

    return base + INVITE_ROUTE + '?' + params.toString();
  }

  /**
   * Разбирает адрес приглашения. Работает и с `#family-invite?...`, и с
   * хвостом `?...&invite=<key>` (ВК умеет резать hash на своих редиректах).
   * @param {string} [href]
   * @returns {?{key: string, from: string, name: string}}
   */
  function parseInviteUrl(href) {
    var raw = href || window.location.href;
    var hashIdx = raw.indexOf('#');
    if (hashIdx === -1) { return null; }

    var hash = raw.slice(hashIdx + 1);
    var qIdx = hash.indexOf('?');
    var route = (qIdx === -1 ? hash : hash.slice(0, qIdx)).replace(/^\//, '');
    if (route !== INVITE_ROUTE) { return null; }

    var params = new URLSearchParams(qIdx === -1 ? '' : hash.slice(qIdx + 1));
    var key = params.get('key') || params.get('invite');
    if (!key) { return null; }

    return { key: key, from: params.get('from') || '', name: params.get('name') || '' };
  }

  /* ================================================================
     7. ПОЛИТИКА ВИДИМОСТИ (что уходит в семью)
     ================================================================ */

  /**
   * Значок scope по умолчанию для нового элемента формы.
   * Документы — всегда личные (паспорт, медсправки), «Кредиты» и «Личные»
   * категории платежей — тоже. Счётчики и показания общие по умолчанию:
   * их всё равно платит household.
   *
   * @param {string} store — payments | tasks | documents | meters | meter_readings
   * @param {string} [category] — категория записи, если она есть
   * @returns {'family'|'personal'}
   */
  function defaultScope(store, category) {
    if (!activeCache) { return 'personal'; }
    if (store === 'documents') { return 'personal'; }
    if (store === 'meters' || store === 'meter_readings') { return 'family'; }
    if (store === 'tasks') { return 'family'; }
    if (store === 'payments') {
      return SHARED_PAYMENT_CATEGORIES.indexOf(category) !== -1 ? 'family' : 'personal';
    }
    return 'personal';
  }

  /**
   * Участие ли запись в семейном обмене. Решает ЯВНЫЙ флаг familyScope.
   *
   * Отсутствие флага трактуем как «личная», а не как «возьми дефолт
   * хранилища»: иначе у человека, включившего семью, все его прежние
   * документы уехали бы в общий файл без спроса.
   *
   * @param {Object} record
   * @returns {boolean}
   */
  function isShared(record) {
    return Boolean(record && (record.familyScope === 'family' || record.familyScoped === true));
  }

  /**
   * Помечает новые записи при сохранении из формы: ownerId (кто создал),
   * familyScope (общая/личная) и familyId (в какой семье расшарена).
   *
   * Вызывается из модулей-форм. Вне семьи поля не проставляются: личное
   * приложение человека не должно обрастать служебными полями «на всякий
   * случай».
   *
   * @param {Object} data — объект, который пойдёт в DB.add/DB.update
   * @param {string} store
   * @param {boolean} [isUpdate] — при правке owner менять нельзя
   * @returns {Object} тот же data
   */
  function stampScope(data, store, isUpdate) {
    if (!data || typeof data !== 'object') { return data; }
    if (!activeCache) { return data; }

    if (isUpdate) {
      // Правка: владельца и семью НЕ трогаем (редактирование чужой общей
      // записи не должно «присваивать» её открывшему форму). familyScope
      // проставляем только если форма принесла явное значение — переключатель
      // «Общая/Личная». Если поля нет, DB.update сохранит прежний флаг.
      if (data.familyScope !== 'family' && data.familyScope !== 'personal') {
        delete data.familyScope;
      }
      if (data.familyScope) {
        data.familyScoped = (data.familyScope === 'family');
      }
      return data;
    }

    data.ownerId = myUserId();
    data.familyId = activeCache.id;
    if (data.familyScope !== 'family' && data.familyScope !== 'personal') {
      data.familyScope = defaultScope(store, data.category);
    }
    data.familyScoped = (data.familyScope === 'family');
    return data;
  }

  /**
   * Меняет scope конкретной записи (переключатель «Общая/Личная» в форме).
   * @param {string} store @param {(number|string)} id
   * @param {'family'|'personal'} scope @returns {Promise<void>}
   */
  function setScope(store, id, scope) {
    return window.DB.update(store, id, {
      familyScope: scope,
      familyScoped: scope === 'family'
    }).then(function () {});
  }

  /* ================================================================
     8. ТРАНСПОРТ ОБЩЕГО ФАЙЛА
     ================================================================ */

  /** @returns {boolean} доступен ли File System Access API с записью */
  function fsaaSupported() {
    return typeof window.showSaveFilePicker === 'function' &&
           typeof window.showOpenFilePicker === 'function';
  }

  /**
   * Подменный http-канал. Нужен ОДНОМУ: чтобы multi-user сценарий этапа
   * (два браузера, два пользователя) проверялся автоматически.
   *
   * Ограничен localhost — боевое приложение сюда не попадает никогда, у него
   * нет права писать в чужую файловую систему.
   * @returns {boolean}
   */
  function httpChannelAvailable() {
    return /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  }

  /** @param {string} key @returns {string} */
  function httpUrl(key) {
    return window.location.origin + '/family/' + encodeURIComponent(key);
  }

  /**
   * Разрешение на работу с handle (queryPermission не просит жест,
   * requestPermission — только из обработчика клика).
   * @param {Object} handle @param {string} mode @returns {Promise<boolean>}
   */
  function ensurePermission(handle, mode) {
    if (!handle || typeof handle.queryPermission !== 'function') { return Promise.resolve(false); }

    function grant() {
      return handle.requestPermission({ mode: mode }).then(function (s) { return s === 'granted'; });
    }

    return handle.queryPermission({ mode: mode }).then(function (s) {
      if (s === 'granted') { return true; }
      return grant().catch(function () { return false; });
    }, function () {
      return grant().catch(function () { return false; });
    });
  }

  /**
   * Просит человека выбрать общий семейный файл (или создать его). Тот же
   * сценарий, что у облачного бэкапа: выбор папки делается один раз.
   * @param {boolean} forceNew
   * @returns {Promise<?Object>} handle или null (отказ)
   */
  function obtainFamilyFile(forceNew) {
    if (!fsaaSupported()) {
      return Promise.reject(new Error('Браузер не поддерживает выбор файла.'));
    }
    if (familyFileHandle && !forceNew) {
      return ensurePermission(familyFileHandle, 'readwrite').then(function (ok) {
        return ok ? familyFileHandle : pickFamilyFile();
      });
    }
    return pickFamilyFile();
  }

  /** @returns {Promise<?Object>} */
  function pickFamilyFile() {
    var family = activeCache;
    var name = family ? 'my_order_family_' + family.sharedDataKey + '.json' : 'my_order_family.json';

    return Promise.resolve()
      .then(function () {
        return window.showSaveFilePicker({
          suggestedName: name,
          types: [{
            description: 'Общий файл семьи «Мой Порядок»',
            accept: { 'application/json': ['.json'] }
          }]
        });
      })
      .then(function (handle) {
        familyFileHandle = handle || null;
        return familyFileHandle;
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') { return null; }
        throw err;
      });
  }

  /**
   * Канал для подписи в UI.
   * @returns {{channel: 'file'|'http'|'none', label: string}}
   */
  function transportInfo() {
    if (familyFileHandle) { return { channel: 'file', label: 'Общий файл выбран: ' + (familyFileHandle.name || '') }; }
    if (fsaaSupported()) { return { channel: 'file', label: 'Нужно один раз выбрать общий файл в облачной папке' }; }
    if (httpChannelAvailable()) { return { channel: 'http', label: 'Локальный режим разработки' }; }
    return { channel: 'none', label: 'Браузер не даёт общий файл — синхронизация недоступна' };
  }

  /** @returns {boolean} выбран ли общий файл */
  function hasFamilyFile() {
    return Boolean(familyFileHandle);
  }

  /** Забывает файл (кнопка «Сменить файл»). */
  function forgetFamilyFile() {
    familyFileHandle = null;
  }

  /**
   * Пишет снимок в общий канал.
   * @param {Object} payload @returns {Promise<{ok: boolean, channel: string, message: string}>}
   */
  function transportWrite(payload) {
    var json = JSON.stringify(payload);

    if (httpChannelAvailable()) {
      return fetch(httpUrl(payload.family.sharedDataKey), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json
      }).then(function (res) {
        return res.ok
          ? { ok: true, channel: 'http', message: 'Общий файл обновлён' }
          : { ok: false, channel: 'http', message: 'Общий файл не записан (' + res.status + ')' };
      }).catch(function (err) {
        return { ok: false, channel: 'http', message: 'Общий файл недоступен: ' + (err && err.message || err) };
      });
    }

    if (!familyFileHandle) {
      return Promise.resolve({ ok: false, channel: 'none', message: 'Сначала выберите общий файл семьи.' });
    }

    return ensurePermission(familyFileHandle, 'readwrite').then(function (granted) {
      if (!granted) { return { ok: false, channel: 'file', message: 'Нет доступа к файлу семьи.' }; }
      return familyFileHandle.createWritable().then(function (writable) {
        return writable.write(json)
          .then(function () { return writable.close(); })
          .then(function () { return { ok: true, channel: 'file', message: 'Общий файл обновлён' }; });
      });
    }).catch(function (err) {
      familyFileHandle = null;
      return { ok: false, channel: 'file', message: 'Не удалось записать общий файл: ' + (err && err.message || err) };
    });
  }

  /**
   * Читает общий файл. null — файла ещё нет (первый в семье).
   * @param {string} key @returns {Promise<?Object>}
   */
  function transportRead(key) {
    if (httpChannelAvailable()) {
      return fetch(httpUrl(key), { cache: 'no-store' }).then(function (res) {
        if (res.status === 404 || res.status === 204) { return null; }
        if (!res.ok) { throw new Error('ответ ' + res.status); }
        return res.json();
      }).catch(function (err) {
        if (err instanceof SyntaxError) { throw err; }
        return null;
      });
    }

    if (!familyFileHandle) { return Promise.resolve(null); }

    return ensurePermission(familyFileHandle, 'read').then(function (granted) {
      if (!granted) { throw new Error('нет доступа к файлу'); }
      return familyFileHandle.getFile();
    }).then(function (file) { return file.text(); })
      .then(function (text) { return JSON.parse(text); })
      .catch(function () { return null; });
  }

  /* ================================================================
     9. СНИМОК СЕМЬИ И ТОМБСТОУНЫ
     ================================================================ */

  /** @returns {Promise<Object>} журнал удалений */
  function readTombstones() {
    return readSetting(SET_TOMBSTONES).then(function (map) {
      return map && typeof map === 'object' ? map : {};
    });
  }

  /** @param {Object} map @returns {Promise<void>} */
  function writeTombstones(map) {
    return writeSetting(SET_TOMBSTONES, map).then(function () {});
  }

  /**
   * Запоминает удаление, чтобы оно долетело до остальных. Вызывается из
   * обёртки DB.delete — сами модули про tombstone не знают.
   * @param {string} store @param {Object} record @returns {Promise<void>}
   */
  function rememberDeletion(store, record) {
    if (!record || !record.uid) { return Promise.resolve(); }
    if (record.familyScope !== 'family' && !record.familyScoped) { return Promise.resolve(); }

    return readTombstones().then(function (map) {
      map[store + ':' + record.uid] = {
        store: store,
        uid: record.uid,
        deletedAt: new Date().toISOString(),
        deletedBy: myUserId()
      };
      return writeTombstones(pruneTombstones(map));
    });
  }

  /**
   * Чистит журнал: память браузера не резиновая, а через TOMBSTONE_TTL_DAYS
   * удаление уже есть у всех.
   * @param {Object} map @returns {Object}
   */
  function pruneTombstones(map) {
    var limit = Date.now() - TOMBSTONE_TTL_DAYS * 86400000;
    var out = {};
    Object.keys(map).forEach(function (k) {
      var entry = map[k];
      var at = entry && entry.deletedAt ? new Date(entry.deletedAt).getTime() : 0;
      if (at >= limit) { out[k] = entry; }
    });
    return out;
  }

  /**
   * Собирает снимок того, что человек разрешил расшарить.
   * Личные записи в payload не попадают даже в поле owner — их просто нет.
   * @returns {Promise<Object>}
   */
  function buildFamilySnapshot() {
    if (!window.DB) { return Promise.reject(new Error('База данных не готова')); }
    if (!activeCache) { return Promise.reject(new Error('Активной семьи нет')); }

    var reads = SHARED_STORES.map(function (store) {
      return window.DB.getAll(store).then(function (rows) { return [store, rows || []]; });
    });

    return Promise.all(reads.concat([readTombstones()])).then(function (res) {
      var out = {};
      var tombstones = {};
      var sharedTombstones = res[res.length - 1] || {};

      for (var i = 0; i < SHARED_STORES.length; i++) {
        var store = SHARED_STORES[i];
        var rows = res[i][1];
        out[store] = rows.filter(function (r) {
          // deleted не отправляем: для удалённого элемента уже есть
          // tombstone, а дублировать его телом записи — путь к «оживанию»
          return (r.familyScope === 'family' || r.familyScoped === true) && !r.deleted && r.uid;
        }).map(function (r) {
            // familyId чужой семьи в общий файл не пишем: идентификатор
            // семьи — приватный признак, достаточно uid и данных
            var copy = Object.assign({}, r);
            delete copy.familyId;
            return copy;
          });
      }

      Object.keys(sharedTombstones).forEach(function (k) {
        var entry = sharedTombstones[k];
        if (entry && SHARED_STORES.indexOf(entry.store) !== -1) { tombstones[k] = entry; }
      });

      return {
        kind: 'myorder-family',
        version: 1,
        family: {
          id: activeCache.id,
          sharedDataKey: activeCache.sharedDataKey,
          name: activeCache.name,
          adminUserId: activeCache.adminUserId
        },
        members: activeCache.members,
        updatedAt: new Date().toISOString(),
        updatedBy: myUserId(),
        data: out,
        tombstones: tombstones
      };
    });
  }

  /**
   * Валидирует прочитанный общий файл. Проверяем жёстко: файл мог быть битым
   * (облако дописывает частями) или чужим (человек выбрал не ту папку).
   * @param {Object} payload @returns {boolean}
   */
  function looksLikeFamilySnapshot(payload) {
    return Boolean(payload &&
      typeof payload === 'object' &&
      payload.kind === 'myorder-family' &&
      payload.family && payload.family.sharedDataKey &&
      payload.data && typeof payload.data === 'object' &&
      Array.isArray(payload.members));
  }

  /**
   * Слияние общего файла с локальной базой. Правила этапа:
   *   • запись есть там и тут → берём ту, у которой updatedAt позже;
   *   • записи есть только там → добавляем (это чужая общая запись);
   *   • tombstone есть → удаление приоритетнее любого изменения;
   *   • локальная запись с таким же id, но другим uid → НЕ трогает: локальный
   *     id ничего не значит для соседа, ключ сопоставления — только uid.
   *
   * @param {Object} payload — снимок из общего файла
   * @param {Object} [options]
   * @param {boolean} [options.dryRun] — только посчитать, не писать
   * @returns {Promise<{added: number, updated: number, deleted: number, skipped: number, conflicts: number}>}
   */
  function mergeRemote(payload, options) {
    options = options || {};

    var stats = { added: 0, updated: 0, deleted: 0, skipped: 0, conflicts: 0 };
    if (!looksLikeFamilySnapshot(payload)) {
      return Promise.reject(new Error('Файл семьи повреждён или не является общим файлом «Моего Порядка».'));
    }

    var localTombPromise = readTombstones();
    var reads = SHARED_STORES.map(function (store) {
      return window.DB.getAll(store).then(function (rows) { return [store, rows || []]; });
    });

    return Promise.all(reads.concat([localTombPromise])).then(function (res) {
      var byStore = {};
      var localTomb = res[res.length - 1] || {};
      for (var i = 0; i < SHARED_STORES.length; i++) { byStore[SHARED_STORES[i]] = res[i][1]; }

      var remoteTomb = payload.tombstones || {};
      var mergedTomb = {};
      var writes = [];

      /**
       * Один проход по хранилищу. Ключ сопоставления — uid, а НЕ id: id
       * локальны для каждого браузера и у двух участников совпадают даже при
       * разных записях, поэтому слияние по id перетирало бы чужие данные.
       */
      SHARED_STORES.forEach(function (store) {
        var localByUid = {};
        (byStore[store] || []).forEach(function (r) {
          // Записи без uid — из дампов прежних этапов: ключа сопоставления у
          // них нет, в слиянии не участвуют (наружу они всё равно не уедут:
          // снимок берёт только familyScope='family' с uid)
          if (r.uid) { localByUid[r.uid] = r; }
        });

        var remoteByUid = {};
        var remote = Array.isArray(payload.data[store]) ? payload.data[store] : [];
        remote.forEach(function (rec) {
          if (rec && rec.uid) { remoteByUid[rec.uid] = rec; }
          else { stats.skipped++; }
        });

        var keys = Object.keys(remoteByUid);
        Object.keys(remoteTomb).forEach(function (key) {
          var entry = remoteTomb[key];
          if (!entry || entry.store !== store || !entry.uid) { return; }
          mergedTomb[key] = entry;
          if (keys.indexOf(entry.uid) === -1) { keys.push(entry.uid); }
        });

        keys.forEach(function (uid) {
          var key = store + ':' + uid;
          var mine = localByUid[uid];
          var rec = remoteByUid[uid];

          /* 1. Удаление приоритетнее изменения — правило этапа.
                Работает в обе стороны: чужой tombstone гасит нашу правку,
                наш локальный tombstone отбивает чужую «оживляющую» запись. */
          if (mergedTomb[key] || localTomb[key]) {
            if (mine && !mine.deleted) {
              stats.deleted++;
              if (!options.dryRun) { writes.push(softDelete(store, mine)); }
            } else {
              stats.skipped++;
            }
            return;
          }

          /* 2. Записи нет у нас — это общий элемент соседа, добавляем */
          if (!mine) {
            if (!rec) { return; }
            stats.added++;
            if (!options.dryRun) {
              var fresh = Object.assign({}, rec);
              // id выбрасываем: его отдаст локальный autoIncrement
              delete fresh.id;
              writes.push(window.DB.add(store, fresh));
            }
            return;
          }

          /* 3. Есть у обоих — решает updatedAt (latest wins) */
          var a = stampOf(mine);
          var b = rec ? stampOf(rec) : 0;

          if (rec && b > a) {
            stats.conflicts++;
            stats.updated++;
            if (!options.dryRun) { writes.push(window.DB.update(store, mine.id, rec)); }
          } else if (mine.deleted && rec && b <= a) {
            // Мы уже удалили, а сосед прислал старую версию: оставляем удаление
            stats.skipped++;
          } else {
            // Наша версия новее — при следующем push она уйдёт наружу
            stats.skipped++;
          }
        });
      });

      if (options.dryRun) { return stats; }

      return Promise.all(writes).then(function () {
        // Чужие tombstones сохраняем в свой журнал: иначе при следующем
        // push мы бы «вернули к жизни» удалённое соседом своей старой версией
        var incoming = Object.keys(mergedTomb).filter(function (k) { return !localTomb[k]; });
        if (!incoming.length) { return stats; }

        return readTombstones().then(function (map) {
          incoming.forEach(function (k) { map[k] = mergedTomb[k]; });
          return writeTombstones(pruneTombstones(map)).then(function () { return stats; });
        });
      });
    });
  }

  /**
   * Момент, по которому решается конфликт. createdAt — фолбэк для записей,
   * пришедших из дампов, где updatedAt мог не проставляться.
   * @param {Object} record @returns {number} мс epoch, 0 если дату не прочитать
   */
  function stampOf(record) {
    var raw = record.updatedAt || record.createdAt;
    var t = raw ? new Date(raw).getTime() : 0;
    return isNaN(t) ? 0 : t;
  }

  /**
   * Мягкое удаление: запись остаётся в базе, но помечается deleted и
   * перестает быть общей. Физическое удаление недопустимо — его нельзя
   * показать собеседнику, и «оживший» платёж был бы хуже лишней строки.
   * @param {string} store @param {Object} record @returns {Promise<void>}
   */
  function softDelete(store, record) {
    return window.DB.update(store, record.id, { familyScope: 'personal', familyScoped: false, deleted: true })
      .then(function () {});
  }

  /* ================================================================
     10. PUSH / PULL / SYNC
     ================================================================ */

  /**
   * Публикует семейную часть данных в общий файл.
   * @param {Object} [options]
   * @param {boolean} [options.silent] — без тостов (фон)
   * @returns {Promise<{ok: boolean, channel: string, message: string, stats: ?Object}>}
   */
  function pushNow(options) {
    options = options || {};

    if (!isPro()) {
      return Promise.resolve({ ok: false, channel: 'none', message: 'только PRO', stats: null });
    }
    if (!activeCache) {
      return Promise.resolve({ ok: false, channel: 'none', message: 'вы не в семье', stats: null });
    }
    if (busy) {
      return Promise.resolve({ ok: false, channel: 'none', message: 'обмен уже идёт', stats: null });
    }

    busy = true;

    return transportRead(activeCache.sharedDataKey)
      .then(function (remote) {
        if (remote && Array.isArray(remote.members) && remote.members.length > (activeCache.members || []).length) {
          activeCache.members = remote.members;
          if (window.DB) {
            window.DB.update('families', activeCache.id, { members: remote.members }).catch(function () {});
          }
        }
        return buildFamilySnapshot();
      })
      .then(transportWrite)
      .then(function (res) {
        if (res.ok) {
          lsSet('myorder_family_last_push', new Date().toISOString());
          if (!options.silent) { toast(res.message, 'success'); }
        }
        return { ok: res.ok, channel: res.channel, message: res.message, stats: null };
      })
      .catch(function (err) {
        var message = (err && err.message) || 'ошибка';
        console.info('[Family] Выгрузка не выполнена:', message);
        return { ok: false, channel: 'error', message: message, stats: null };
      })
      .then(function (r) { busy = false; return r; });
  }

  /**
   * Забирает общий файл и сливает его с локальной базой.
   * @param {Object} [options]
   * @param {boolean} [options.silent]
   * @param {boolean} [options.force] — игнорировать троттлинг
   * @returns {Promise<{ok: boolean, found: boolean, stats: ?Object, message: string}>}
   */
  function pullNow(options) {
    options = options || {};

    if (!isPro()) {
      return Promise.resolve({ ok: false, found: false, stats: null, message: 'только PRO' });
    }
    if (!activeCache) {
      return Promise.resolve({ ok: false, found: false, stats: null, message: 'вы не в семье' });
    }
    if (!options.force && Date.now() - lastPullAt < PULL_THROTTLE) {
      return Promise.resolve({ ok: true, found: false, stats: null, message: 'небольшая пауза между проверками' });
    }

    lastPullAt = Date.now();

    return transportRead(activeCache.sharedDataKey).then(function (payload) {
      if (!payload) { return { ok: true, found: false, stats: null, message: 'общего файла пока нет' }; }
      if (!looksLikeFamilySnapshot(payload)) {
        return { ok: false, found: true, stats: null, message: 'файл повреждён' };
      }
      if (payload.family.sharedDataKey !== activeCache.sharedDataKey) {
        return { ok: false, found: true, stats: null, message: 'файл от другой семьи' };
      }

      return mergeRemote(payload).then(function (stats) {
        if (Array.isArray(payload.members) && payload.members.length && activeCache) {
          var membersChanged = JSON.stringify(activeCache.members) !== JSON.stringify(payload.members);
          activeCache.members = payload.members;
          if (membersChanged && window.DB) {
            window.DB.update('families', activeCache.id, {
              members: payload.members,
              updatedAt: payload.updatedAt || new Date().toISOString()
            }).catch(function () {});
          }
        }
        lsSet('myorder_family_last_pull', new Date().toISOString());
        var changed = stats.added + stats.updated + stats.deleted;
        if (changed > 0) {
          // Списки должны перерисоваться: данные поменялись не из UI
          try { window.dispatchEvent(new CustomEvent('family:changed', { detail: stats })); }
          catch (err) { console.info('[Family] family:changed не отправлено'); }
        }
        if (!options.silent && changed > 0) {
          toast('Семья обновила данные: ' + changed + ' ' +
            plural(changed, 'изменение', 'изменения', 'изменений'), 'success');
        }
        return { ok: true, found: true, stats: stats, message: '' };
      });
    }).catch(function (err) {
      var message = (err && err.message) || 'ошибка чтения';
      console.info('[Family] Pull не выполнен:', message);
      return { ok: false, found: false, stats: null, message: message };
    });
  }

  /**
   * Полный цикл: сначала забираем чужое, потом отдаём своё. Порядок важен —
   * наоборот мы бы перезаписали свежую правку соседа своей старой.
   * @param {Object} [options] @param {boolean} [options.silent]
   * @returns {Promise<{ok: boolean, pull: Object, push: Object}>}
   */
  function syncNow(options) {
    options = options || {};

    if (!activeCache) {
      return Promise.resolve({ ok: false, pull: null, push: null });
    }

    return pullNow({ silent: true, force: true }).then(function (pull) {
      return pushNow({ silent: options.silent !== false ? options.silent : true }).then(function (push) {
        return { ok: push.ok, pull: pull, push: push };
      });
    });
  }

  /* ================================================================
     11. ПРИСОЕДИНЕНИЕ ПО ССЫЛКЕ (MEMBER)
     ================================================================ */

  /**
   * Вступает в семью по ключу из ссылки.
   *
   * Состав участников хранится в самом общем файле, поэтому «добавить себя в
   * members» — это не правка чужой записи в своей базе, а запись обновлённого
   * состава в общий файл. Иначе второй участник никогда бы о нас не узнал.
   *
   * @param {string} key — sharedDataKey из ссылки
   * @param {Object} [options]
   * @param {string} [options.invitedBy] — from из ссылки (для подписи)
   * @returns {Promise<{ok: boolean, family: ?Object, message: string}>}
   */
  function joinByKey(key, options) {
    options = options || {};

    if (!isPro()) {
      return Promise.resolve({ ok: false, family: null, message: 'Семейный доступ доступен только в PRO.' });
    }
    if (!key || typeof key !== 'string') {
      return Promise.resolve({ ok: false, family: null, message: 'Ссылка приглашения неполная.' });
    }
    if (!window.DB) {
      return Promise.resolve({ ok: false, family: null, message: 'База данных ещё не готова.' });
    }

    var me = myUserId();

    return transportRead(key).then(function (payload) {
      if (!looksLikeFamilySnapshot(payload)) {
        // Первый по ссылке: файла ещё нет (админ не успел выгрузиться) или он
        // чужой. Создавать его вправе только админ из ссылки, поэтому ищем
        // совпадение по ключу в уже известных семьях.
        return window.DB.getAll('families').then(function (known) {
          var match = (known || []).filter(function (f) { return f.sharedDataKey === key; })[0];
          if (!match) {
            return { ok: false, family: null, message: 'Общий файл семьи не найден. Попросите администратора создать семью и выгрузить данные.' };
          }
          return { ok: true, family: match, fromDisk: true };
        });
      }

      var fam = {
        id: payload.family.id,
        sharedDataKey: payload.family.sharedDataKey,
        name: payload.family.name,
        adminUserId: payload.family.adminUserId,
        members: payload.members || [],
        createdAt: payload.family.createdAt || payload.updatedAt,
        updatedAt: payload.updatedAt
      };

      var already = fam.members.some(function (m) { return m.userId === me; });
      if (!already) {
        fam.members.push({ userId: me, role: 'member', name: myDisplayName(), joinedAt: new Date().toISOString() });
      }

      // 1. семью — к себе, 2. состав — в общий файл, 3. данные — в базу
      return window.DB.get('families', fam.id)
        .then(function (existing) {
          if (existing) { return window.DB.update('families', fam.id, fam); }
          return window.DB.add('families', fam);
        })
        .then(function () { return writeSetting(SET_ACTIVE, fam.id); })
        .then(function () {
          activeCache = fam;
          return transportWrite(Object.assign({}, payload, { members: fam.members, updatedAt: new Date().toISOString() }));
        })
        .then(function (writeRes) {
          if (!writeRes.ok) {
            console.info('[Family] Состав не обновлён в общем файле:', writeRes.message);
          }
          return mergeRemote(payload, {});
        })
        .then(function () {
          return { ok: true, family: fam, message: 'Вы в семье «' + fam.name + '».' };
        });
    }).catch(function (err) {
      var message = (err && err.message) || 'ошибка';
      console.info('[Family] Вхождение не удалось:', message);
      return { ok: false, family: null, message: 'Не удалось присоединиться: ' + message };
    });
  }

  /**
   * Обрабатывает ссылку приглашения: маршрут, PRO-гейт, само вхождение.
   *
   * Возвращает false, если запроса нет вообще — тогда роутер работает как
   * обычно. При отсутствии PRO человека несёт в раздел подписки: это
   * единственный случай, где «не пускать» без объяснения было бы плохим UX.
   *
   * @param {string} [href]
   * @returns {Promise<boolean>} был ли обработан запрос
   */
  function handleInviteUrl(href) {
    var invite = parseInviteUrl(href);
    if (!invite) { return Promise.resolve(false); }

    if (!isPro()) {
      cleanInviteUrl('backup');
      if (window.App && window.App.navigate) { window.App.navigate('backup'); }
      toast('Семейный доступ доступен только в PRO', 'error');
      return Promise.resolve(true);
    }

    return joinByKey(invite.key, { invitedBy: invite.from }).then(function (res) {
      toast(res.message, res.ok ? 'success' : 'error');
      if (res.ok && window.App) {
        cleanInviteUrl('backup');
        if (window.App.renderSection) { window.App.renderSection('backup'); }
        else if (window.App.navigate) { window.App.navigate('backup'); }
      }
      return true;
    });
  }

  /** Убирает приглашение из адреса, чтобы «назад» не повторяло вхождение. */
  function cleanInviteUrl(targetHash) {
    try {
      window.history.replaceState({}, document.title,
        window.location.pathname + window.location.search + '#' + (targetHash || 'home'));
    } catch (err) { console.info('[Family] Адрес приглашения не очищен'); }
  }

  /* ================================================================
     12. УПРАВЛЕНИЕ СОСТАВОМ
     ================================================================ */

  /**
   * Удаляет участника. Право — только у админа; админ не может удалить саму
   * семью этой кнопкой (условие этапа: «не позволять участникам удалять
   * семью целиком» симметрично означает, что и админ делает это осознанно).
   *
   * Данные человека из общего файла НЕ вычищаются: они уже стали общими для
   * households, и молча лишать семью истории платежей было бы хуже, чем
   * оставить их.
   *
   * @param {string} userId @returns {Promise<{ok: boolean, message: string}>}
   */
  function removeMember(userId) {
    if (!activeCache) { return Promise.resolve({ ok: false, message: 'Вы не в семье.' }); }
    if (!isAdmin()) { return Promise.resolve({ ok: false, message: 'Управлять составом может только администратор.' }); }
    if (userId === activeCache.adminUserId) {
      return Promise.resolve({ ok: false, message: 'Администратора нельзя удалить из семьи.' });
    }

    var fam = Object.assign({}, activeCache);
    fam.members = fam.members.filter(function (m) { return m.userId !== userId; });

    return saveFamily(fam)
      .then(function () {
        return buildFamilySnapshot().then(function (snap) {
          snap.members = fam.members;
          return transportWrite(snap);
        });
      })
      .then(function (res) {
        return {
          ok: true,
          message: res && res.ok
            ? 'Участник удалён, общий файл обновлён.'
            : 'Участник удалён локально. Общий файл обновить не удалось: ' + (res && res.message || '')
        };
      })
      .catch(function (err) {
        return { ok: false, message: 'Не удалось удалить участника: ' + (err && err.message || err) };
      });
  }

  /**
   * Выход из семьи (member или admin). Удаление своей записи из состава
   * делается в общем файле, иначе семью нельзя было бы «покинуть» для других.
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  function leave() {
    var fam = activeCache;
    if (!fam) { return Promise.resolve({ ok: false, message: 'Вы не в семье.' }); }

    var me = myUserId();
    var isLastAdmin = fam.adminUserId === me && fam.members.length === 1;

    if (fam.adminUserId === me && fam.members.length > 1) {
      return Promise.resolve({
        ok: false,
        message: 'Администратор не может выйти, пока в семье есть другие: сначала передайте управление.'
      });
    }

    var next = Object.assign({}, fam);
    next.members = fam.members.filter(function (m) { return m.userId !== me; });

    var writeBack = isLastAdmin
      ? Promise.resolve({ ok: true })
      : buildFamilySnapshot().then(function (snap) {
          snap.members = next.members;
          return transportWrite(snap);
        });

  return writeBack
      .then(function () { return saveFamily(next); })
      .then(function () { return writeSetting(SET_ACTIVE, null); })
      .then(function () {
        activeCache = null;
        lsRemove('myorder_family_last_push');
        lsRemove('myorder_family_last_pull');
        // Наши общие записи перестают быть общими: человек уходит со своими
        // данными, но не уносит чужие.
        return demoteSharedRecords();
      })
      .then(function () {
        return { ok: true, message: 'Вы покинули семью «' + fam.name + '».' };
      })
      .catch(function (err) {
        return { ok: false, message: 'Не удалось покинуть семью: ' + (err && err.message || err) };
      });
  }

  /**
   * После выхода помечает все локальные записи как личные. Данные остаются у
   * человека — уходит только флаг участия в обмене.
   * @returns {Promise<void>}
   */
  function demoteSharedRecords() {
    if (!window.DB) { return Promise.resolve(); }

    var chain = Promise.resolve();
    SHARED_STORES.forEach(function (store) {
      chain = chain.then(function () {
        return window.DB.getAll(store).then(function (rows) {
          var writes = (rows || []).filter(function (r) { return r.familyScope === 'family'; })
            .map(function (r) { return window.DB.update(store, r.id, { familyScope: 'personal' }); });
          return Promise.all(writes);
        });
      });
    });
    return chain.then(function () {});
  }

  /* ================================================================
     13. ФОНОВЫЙ РЕЖИМ
     ================================================================ */

  function onVisibilityChange() {
    if (!activeCache) { return; }
    if (document.visibilityState === 'hidden') {
      pushNow({ silent: true });
    } else {
      pullNow({ silent: true });
    }
  }

  function tick() {
    if (!activeCache) { return; }
    syncNow({ silent: true });
  }

  var dbChangeTimer = null;
  function onDbChange(e) {
    if (!activeCache || !isPro()) { return; }
    var store = e && e.detail && e.detail.store;
    if (store && SHARED_STORES.indexOf(store) === -1) { return; }
    if (dbChangeTimer) { clearTimeout(dbChangeTimer); }
    dbChangeTimer = setTimeout(function () {
      pushNow({ silent: true });
    }, 1500);
  }

  function bind() {
    if (bound) { return; }
    bound = true;

    window.addEventListener('db:change', onDbChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onVisibilityChange);
    timerId = setInterval(tick, SYNC_INTERVAL);
    console.info('[Family] Синхронизация привязана: интервал 5 мин + видимость вкладки + db:change.');
  }

  function unbind() {
    if (!bound) { return; }
    bound = false;
    window.removeEventListener('db:change', onDbChange);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onVisibilityChange);
    if (timerId) { clearInterval(timerId); timerId = null; }
    if (dbChangeTimer) { clearTimeout(dbChangeTimer); dbChangeTimer = null; }
  }

  /**
   * Точка входа. Активную семью читаем всегда (и для Free тоже): у человека
   * могла истечь подписка, а возвращение PRO не должно выглядеть потерей
   * данных. Но ни одного сетевого действия без PRO модуль не делает.
   * @returns {Promise<void>}
   */
  function init() {
    hookDeletes();
    if (!window.DB) { return Promise.resolve(); }

    return activeFamily(true).then(function (fam) {
      if (!fam) { return; }

      if (isPro()) {
        bind();
        pullNow({ silent: true, force: true });
      }
      try { window.dispatchEvent(new CustomEvent('family:ready', { detail: { name: fam.name } })); }
      catch (err) { console.info('[Family] family:ready не отправлено'); }
    });
  }

  /** После покупки PRO: включаем обмен. */
  function activate() {
    unbind();
    bind();
    if (activeCache) { syncNow({ silent: true }); }
  }

  /** После истечения подписки: только глушим фоновый режим. */
  function deactivate() {
    unbind();
  }

  /* ================================================================
     14. ДАННЫЕ ДЛЯ UI
     ================================================================ */

  /**
   * Строки списка участников в порядке: админ, потом по дате вхождения.
   * @returns {Array<{userId: string, role: string, name: string, joinedAt: string, isMe: boolean}>}
   */
  function memberRows() {
    if (!activeCache) { return []; }
    var me = myUserId();

    return activeCache.members
      .slice()
      .sort(function (a, b) {
        if (a.role === 'admin' && b.role !== 'admin') { return -1; }
        if (b.role === 'admin' && a.role !== 'admin') { return 1; }
        return (a.joinedAt || '') < (b.joinedAt || '') ? -1 : 1;
      })
      .map(function (m) {
        return {
          userId: m.userId,
          role: m.role,
          name: m.userId === me ? (m.name || myDisplayName()) : (m.name || 'Участник'),
          joinedAt: m.joinedAt || '',
          isMe: m.userId === me
        };
      });
  }

  /** @returns {?{name: string, sharedDataKey: string, id: string}} для шапки */
  function headerInfo() {
    if (!activeCache) { return null; }
    return {
      name: activeCache.name,
      sharedDataKey: activeCache.sharedDataKey,
      id: activeCache.id
    };
  }

  /** @returns {?string} ISO-время последней выгрузки/загрузки */
  function lastPushAt() { return lsGet('myorder_family_last_push'); }
  /** @returns {?string} ISO-время последней загрузки */
  function lastPullAt2() { return lsGet('myorder_family_last_pull'); }

  /* ================================================================
     15. ОБЁРТКА УДАЛЕНИЯ (tombstone)
     ================================================================ */

  /**
   * Подписываемся на удаления centrally: модули списков вызывают DB.delete и
   * не должны знать про семью. Оборачиваем публичный метод, а не правим
   * db.js: слой этапа остаётся в одном файле.
   */
  function hookDeletes() {
    if (!window.DB || window.DB.__familyTombstoned) { return; }

    var original = window.DB.delete;
    if (typeof original !== 'function') { return; }

    window.DB.delete = function (storeName, id) {
      var isDataStore = SHARED_STORES.indexOf(storeName) !== -1;

      // Запись читаем ДО удаления: после него uid уже не достать
      var pre = isDataStore && activeCache
        ? window.DB.get(storeName, id).catch(function () { return null; })
        : Promise.resolve(null);

      return pre.then(function (record) {
        return Promise.resolve(original.call(window.DB, storeName, id)).then(function (res) {
          if (record) {
            return rememberDeletion(storeName, record).then(function () { return res; });
          }
          return res;
        });
      });
    };

    window.DB.__familyTombstoned = true;
  }

  window.Family = {
    init: init,
    activate: activate,
    deactivate: deactivate,

    // Модель
    create: create,
    activeFamily: activeFamily,
    isActive: isActive,
    activeName: activeName,
    headerInfo: headerInfo,
    myUserId: myUserId,
    myRole: myRole,
    isAdmin: isAdmin,
    memberRows: memberRows,
    removeMember: removeMember,
    leave: leave,

    // Приглашения
    inviteLink: inviteLink,
    parseInviteUrl: parseInviteUrl,
    handleInviteUrl: handleInviteUrl,
    joinByKey: joinByKey,
    INVITE_ROUTE: INVITE_ROUTE,

    // Обмен
    pushNow: pushNow,
    pullNow: pullNow,
    syncNow: syncNow,
    mergeRemote: mergeRemote,
    buildFamilySnapshot: buildFamilySnapshot,
    looksLikeFamilySnapshot: looksLikeFamilySnapshot,

    // Транспорт
    fsaaSupported: fsaaSupported,
    obtainFamilyFile: obtainFamilyFile,
    hasFamilyFile: hasFamilyFile,
    forgetFamilyFile: forgetFamilyFile,
    transportInfo: transportInfo,
    transportRead: transportRead,
    transportWrite: transportWrite,

    // Политика видимости
    defaultScope: defaultScope,
    isShared: isShared,
    stampScope: stampScope,
    setScope: setScope,
    SHARED_STORES: SHARED_STORES,
    SHARED_PAYMENT_CATEGORIES: SHARED_PAYMENT_CATEGORIES,
    SCOPE_LABELS: SCOPE_LABELS,

    // Журнал удалений
    readTombstones: readTombstones,
    rememberDeletion: rememberDeletion,
    hookDeletes: hookDeletes,

    lastPushAt: lastPushAt,
    lastPull: lastPullAt2,
    SYNC_INTERVAL: SYNC_INTERVAL
  };

  console.info('[Family] Модуль загружен. API: window.Family');
})();
