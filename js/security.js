/**
 * МОЙ ПОРЯДОК — защита данных PIN-кодом (Этап 12.5, PRO ONLY)
 *
 * Угроза, от которой мы защищаем: чужой человек с открытым телефоном
 * (друг, ребёнок, коллега) видит финансы, документы и счета пользователя.
 * Полноценное шифрование IndexedDB требует криптобиблиотеки и ключа, который
 * всё равно лежал бы в этом же браузере, — по ограничениям этапа это
 * запрещено. Поэтому реализуется блокировка UI: до ввода PIN приложение
 * не рендерит ни одного раздела и не даёт прочитать базу.
 *
 * Что здесь есть:
 *   • PIN 4 цифры, хранится ТОЛЬКО хэш (Web Crypto SHA-256 + соль, если
 *     доступно; иначе FNV-1a — встроенная реализация, без библиотек).
 *   • Оверлей поверх всего: перехватывает клики, блокирует прокрутку,
 *     игнорирует Escape, не даёт hash-роутингу отрисовать разделы.
 *   • Инкремент задержки после ошибок: 5 неудач → пауза 30 секунд.
 *   • Восстановление: подтверждение привязанного VK ID (он был виден при
 *     установке PIN) ИЛИ полное удаление данных с двумя подтверждениями.
 *   • Разблокика живёт в sessionStorage: F5 не требует вводить PIN заново,
 *     но новая вкладка/перезапуск приложения — требует.
 *
 * PIN — свойство PRO. После истечения подписки данные остаются доступными
 * (CRUD блокировать нельзя), а PIN-настройка скрывается; сам хэш не удаляем,
 * чтобы возврат подписки не выглядел как «данные пропали».
 *
 * Экспортирует: window.Security
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  /** @const {string} ключ localStorage с записью PIN */
  var PIN_KEY = 'myorder_pin';

  /** @const {string} ключ sessionStorage: текущая сессия разблокирована */
  var UNLOCK_KEY = 'myorder_pin_unlocked';

  /** @const {string} ключ localStorage: привязанный VK ID (подсказка восстановления) */
  var RECOVERY_KEY = 'myorder_pin_recovery';

  /** @const {string} ключ localStorage: время до конца блокировки ввода */
  var LOCKUNTIL_KEY = 'myorder_pin_lock_until';

  /** @const {number} длина PIN */
  var PIN_LENGTH = 4;

  /** @const {number} сколько ошибок до паузы */
  var MAX_ATTEMPTS = 5;

  /** @const {number} длительность паузы, мс */
  var COOLDOWN_MS = 30 * 1000;

  /** @const {string} класс оверлея */
  var OVERLAY_CLASS = 'pin-overlay';

  /* ================================================================
     2. СОСТОЯНИЕ
     ================================================================ */

  /** @type {Object|null} активный оверлей */
  var overlayEl = null;

  /** @type {number} неудачных попыток в текущей сессии показа */
  var attempts = 0;

  /* ================================================================
     3. ХРАНИЛИЩЕ
     ================================================================ */

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (err) { return false; }
  }

  function lsRemove(key) {
    try { localStorage.removeItem(key); return true; } catch (err) { return false; }
  }

  /** @returns {boolean} PRO ли сейчас (Security мог загрузиться раньше ProManager) */
  function proActive() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  /**
   * Читает запись PIN.
   * @returns {?{alg: string, hash: string, salt: string, setAt: string}}
   */
  function readPinRecord() {
    var raw = lsGet(PIN_KEY);
    if (!raw) { return null; }
    try {
      var rec = JSON.parse(raw);
      if (!rec || typeof rec.hash !== 'string' || typeof rec.alg !== 'string') { return null; }
      return rec;
    } catch (err) {
      return null;
    }
  }

  /* ================================================================
     4. ХЭШИРОВАНИЕ (без криптобиблиотек)
     ================================================================
     *
     * Основной путь — нативный Web Crypto SHA-256: он есть в браузере,
     * ничего не подгружается. crypto.subtle работает только в «secure
     * context»: на plain http (кроме localhost) он undefined. Тогда
     * используется резерв FNV-1a — это НЕ криптозащита, а просто отказ
     * хранить PIN открытым текстом.
     *
     * Алгоритм пишется рядом с хэшем, и при проверке берётся ИМЕННО он.
     * Иначе PIN, поставленный на HTTPS, нельзя было бы проверить на http
     * (и наоборот), а пользователь получил бы заблокированные данные без
     * внятной причины.
     */

  /** @returns {boolean} доступен ли Web Crypto в текущем контексте */
  function subtleAvailable() {
    return Boolean(window.crypto && window.crypto.subtle && typeof TextEncoder !== 'undefined');
  }

  /**
   * SHA-256 от (salt:pin) в hex.
   * @param {string} salt
   * @param {string} pin
   * @returns {Promise<string>} rejects, если Web Crypto недоступен
   */
  function sha256Hex(salt, pin) {
    if (!subtleAvailable()) {
      return Promise.reject(new Error('Web Crypto недоступен: нужен HTTPS или localhost.'));
    }

    var bytes = new TextEncoder().encode(salt + ':' + pin);
    return Promise.resolve(window.crypto.subtle.digest('SHA-256', bytes)).then(function (buf) {
      var view = new Uint8Array(buf);
      var hex = '';
      for (var i = 0; i < view.length; i++) {
        hex += view[i].toString(16).padStart(2, '0');
      }
      return hex;
    });
  }

  /**
   * FNV-1a 32 бита в hex — резервный путь.
   * @param {string} salt
   * @param {string} pin
   * @returns {Promise<string>}
   */
  function fnvHex(salt, pin) {
    var text = salt + ':' + pin;
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return Promise.resolve(hash.toString(16));
  }

  /**
   * Считает хэш строго заданным алгоритмом.
   * @param {string} alg — 'sha256' | 'fnv'
   * @param {string} salt
   * @param {string} pin
   * @returns {Promise<string>}
   */
  function computeHash(alg, salt, pin) {
    return alg === 'sha256' ? sha256Hex(salt, pin) : fnvHex(salt, pin);
  }

  /**
   * Считает хэш предпочтительным ДОСТУПНЫМ алгоритмом и сообщает, какой
   * реально сработал.
   * @param {string} salt
   * @param {string} pin
   * @returns {Promise<{alg: string, hash: string}>}
   */
  function digest(salt, pin) {
    return sha256Hex(salt, pin)
      .then(function (hash) { return { alg: 'sha256', hash: hash }; })
      .catch(function () {
        return fnvHex(salt, pin).then(function (hash) { return { alg: 'fnv', hash: hash }; });
      });
  }

  /** @returns {string} случайная соль (hex 16 символов или fallback) */
  function randomSalt() {
    try {
      var arr = new Uint8Array(8);
      if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(arr);
      } else {
        for (var i = 0; i < arr.length; i++) { arr[i] = Math.floor(Math.random() * 256); }
      }
      var hex = '';
      for (var j = 0; j < arr.length; j++) { hex += arr[j].toString(16).padStart(2, '0'); }
      return hex;
    } catch (err) {
      return String(Date.now());
    }
  }

  /* ================================================================
     5. НАСТРОЙКА PIN
     ================================================================ */

  /** @returns {boolean} установлен ли PIN */
  function isPinSet() {
    return readPinRecord() !== null;
  }

  /**
   * Устанавливает PIN. Валидация — жёсткая: ровно 4 цифры.
   * @param {string} pin
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  function setPin(pin) {
    var err = validatePin(pin);
    if (err) { return Promise.resolve({ ok: false, message: err }); }

    var salt = randomSalt();

    return digest(salt, pin).then(function (res) {
      var saved = lsSet(PIN_KEY, JSON.stringify({
        alg: res.alg,
        hash: res.hash,
        salt: salt,
        setAt: new Date().toISOString()
      }));

      if (!saved) {
        return { ok: false, message: 'Браузер запретил сохранять настройки (приватный режим).' };
      }

      // Запоминаем VK ID как опору для восстановления
      var userId = currentVkUserId();
      if (userId) { lsSet(RECOVERY_KEY, String(userId)); }

      unlockSession();
      console.info('[Security] PIN установлен (' + res.alg + ').');
      return {
        ok: true,
        message: res.alg === 'sha256'
          ? 'PIN установлен.'
          : 'PIN установлен. Шифрование хэша упрощённое: откройте приложение по HTTPS, чтобы включить SHA-256.'
      };
    });
  }

  /**
   * Снимает PIN. Требует текущий PIN — иначе блокировка была бы декоративной.
   * @param {string} pin
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  function clearPin(pin) {
    if (!isPinSet()) {
      return Promise.resolve({ ok: true, message: 'PIN не был установлен.' });
    }

    return verify(pin).then(function (res) {
      if (!res.ok) { return { ok: false, message: res.message }; }
      lsRemove(PIN_KEY);
      lsRemove(RECOVERY_KEY);
      lsRemove(LOCKUNTIL_KEY);
      console.info('[Security] PIN снят.');
      return { ok: true, message: 'PIN снят. Данные больше не блокируются.' };
    });
  }

  /**
   * Проверяет формат PIN.
   * @param {string} pin
   * @returns {?string} текст ошибки или null
   */
  function validatePin(pin) {
    if (typeof pin !== 'string') { return 'PIN должен быть строкой.'; }
    if (pin.length !== PIN_LENGTH) { return 'PIN — ровно ' + PIN_LENGTH + ' цифры.'; }
    if (!/^\d{4}$/.test(pin)) { return 'PIN состоит только из цифр.'; }
    if (/^(\d)\1{3}$/.test(pin)) { return 'Слишком простой PIN: четыре одинаковые цифры.'; }
    if (/^(0123|1234|2345|3456|4567|5678|6789|9876|4321|3210|2109|1098)$/.test(pin)) {
      return 'Слишком простой PIN: последовательность цифр.';
    }
    return null;
  }

  /** @returns {?number} VK ID текущего пользователя */
  function currentVkUserId() {
    if (!window.VK || typeof window.VK.user !== 'function') { return null; }
    var user = window.VK.user();
    return user && user.id ? Number(user.id) : null;
  }

  /**
   * Подсказка для восстановления: последние 4 цифры привязанного VK ID.
   * @returns {?string}
   */
  function recoveryHint() {
    var saved = lsGet(RECOVERY_KEY);
    if (!saved) { return null; }
    var s = String(saved);

    // Ровно последние 4 символа с дополнением нулями: у коротких VK ID
    // (id=1) показать «1» значило бы выдать подсказку, по которой чужой
    // человек угадал бы аккаунт владельца
    return '••••' + s.slice(-4).padStart(4, '0');
  }

  /* ================================================================
     6. ПРОВЕРКА PIN
     ================================================================ */

  /**
   * Сверяет введённый PIN с сохранённым хэшем.
   *
   * Отдельно различаем «неверный PIN» и «нечем проверить»: если запись
   * сделана по SHA-256, а Web Crypto в этом контексте недоступен (например
   * приложение открыли по http в сети), сказать «неверный» было бы ложью —
   * пользователь бы мучил правильный PIN. В таком случае объясняем причину.
   *
   * @param {string} pin
   * @returns {Promise<{ok: boolean, message: string, blocked: boolean}>}
   */
  function verify(pin) {
    var rec = readPinRecord();
    if (!rec) { return Promise.resolve({ ok: false, message: 'PIN не установлен.', blocked: false }); }

    if (!/^\d{4}$/.test(String(pin || ''))) {
      return Promise.resolve({ ok: false, message: 'Введите 4 цифры.', blocked: false });
    }

    if (rec.alg === 'sha256' && !subtleAvailable()) {
      return Promise.resolve({
        ok: false,
        blocked: true,
        message: 'Проверка PIN недоступна: приложение открыто без HTTPS, а PIN был создан с SHA-256. ' +
          'Откройте его по защищённому адресу или восстановите доступ.'
      });
    }

    return computeHash(rec.alg, rec.salt, pin).then(function (hash) {
      return { ok: hash === rec.hash, message: hash === rec.hash ? '' : 'Неверный PIN.', blocked: false };
    }).catch(function (err) {
      return { ok: false, blocked: true, message: 'Не удалось проверить PIN: ' + (err && err.message || err) };
    });
  }

  /** @returns {number} мс, оставшиеся до конца паузы (0 — паузы нет) */
  function cooldownLeft() {
    var until = Number(lsGet(LOCKUNTIL_KEY) || 0);
    var left = until - Date.now();
    return left > 0 ? left : 0;
  }

  /**
   * Учитывает неудачную попытку, при превышении лимита ставит паузу.
   * @returns {number} мс до конца паузы (0 если её нет)
   */
  function registerFailure() {
    attempts += 1;
    if (attempts >= MAX_ATTEMPTS) {
      lsSet(LOCKUNTIL_KEY, String(Date.now() + COOLDOWN_MS));
      attempts = 0;
    }
    return cooldownLeft();
  }

  /* ================================================================
     7. СЕССИЯ
     ================================================================ */

  function unlockSession() {
    try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch (err) { /* приватный режим */ }
  }

  function lockSession() {
    try { sessionStorage.removeItem(UNLOCK_KEY); } catch (err) { /* игнорируем */ }
    attempts = 0;
  }

  /** @returns {boolean} разблокирована ли текущая сессия */
  function isUnlocked() {
    try { return sessionStorage.getItem(UNLOCK_KEY) === '1'; } catch (err) { return true; }
  }

  /** Нужен ли ввод PIN прямо сейчас. */
  function shouldLock() {
    return proActive() && isPinSet() && !isUnlocked();
  }

  /* ================================================================
     8. ОВЕРЛЕЙ БЛОКИРОВКИ
     ================================================================ */

  /**
   * Строит разметку оверлея. Никаких данных пользователя здесь нет —
   * только заголовок, поле и кнопки.
   * @param {number} cooldownMs
   * @returns {string}
   */
  function overlayHtml(cooldownMs) {
    var hint = recoveryHint();

    return '' +
      '<div class="pin-card" role="dialog" aria-modal="true" aria-labelledby="pin-title">' +
        '<div class="pin-card__lock" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
            ' stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
            '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
          '</svg>' +
        '</div>' +
        '<h2 class="pin-card__title" id="pin-title">Приложение защищено</h2>' +
        '<p class="pin-card__text">Введите PIN из 4 цифр, чтобы открыть «Мой Порядок».</p>' +
        '<div class="pin-dots" aria-hidden="true">' +
          '<span class="pin-dot"></span><span class="pin-dot"></span>' +
          '<span class="pin-dot"></span><span class="pin-dot"></span>' +
        '</div>' +
        '<input class="pin-input" type="password" inputmode="numeric" autocomplete="one-time-code"' +
          ' pattern="[0-9]*" maxlength="' + PIN_LENGTH + '" placeholder="••••"' +
          ' aria-label="PIN-код из четырёх цифр">' +
        '<div class="pin-card__error" role="alert"></div>' +
        '<button type="button" class="btn btn--primary pin-card__submit"' +
          (cooldownMs > 0 ? ' disabled' : '') + '>Разблокировать</button>' +
        '<p class="pin-card__cooldown"' + (cooldownMs > 0 ? '' : ' hidden') + '>' +
          'Слишком много попыток. Повторите через <span class="pin-card__seconds">' +
          Math.ceil(cooldownMs / 1000) + '</span> с.' +
        '</p>' +
        '<button type="button" class="pin-card__forgot">Забыли PIN?</button>' +
        (hint
          ? '<p class="pin-card__hint">Привязанный VK ID: ' + hint + '</p>'
          : '') +
      '</div>';
  }

  /**
   * Показывает оверлей. Идемпотентен: повторный вызов не удваивает слой
   * (тот же урок, что и баг №6 этапа 11 — стопка одинаковых диалогов).
   */
  function lock() {
    if (overlayEl && document.body.contains(overlayEl)) { return; }

    var host = document.createElement('div');
    host.className = OVERLAY_CLASS;
    host.innerHTML = overlayHtml(cooldownLeft());
    document.body.appendChild(host);
    document.body.classList.add('pin-locked');
    overlayEl = host;

    bindOverlay(host);

    var input = host.querySelector('.pin-input');
    if (input && cooldownLeft() === 0) {
      // autofocus атрибут не ставим: он дёргает клавиатуру на мобильных
      // до нажатия пользователя
      setTimeout(function () { try { input.focus(); } catch (err) { /* ок */ } }, 120);
    }
  }

  /** Скрывает оверлей и разблокирует приложение. */
  function unlock() {
    unlockSession();
    attempts = 0;

    // Соседям сообщаем о разблокировке: app.js держит рендер раздела
    // на очереди до этого момента, чтобы данные не попадали в DOM
    // до ввода PIN
    try {
      window.dispatchEvent(new CustomEvent('pin:unlocked'));
    } catch (err) { /* CustomEvent может быть недоступен в старых webview */ }

    if (!overlayEl) { return; }
    var host = overlayEl;
    overlayEl = null;

    host.classList.add('pin-overlay--out');
    setTimeout(function () {
      if (host.parentNode) { host.parentNode.removeChild(host); }
      document.body.classList.remove('pin-locked');
    }, 220);
  }

  /** @param {HTMLElement} host */
  function bindOverlay(host) {
    var input = host.querySelector('.pin-input');
    var errorEl = host.querySelector('.pin-card__error');
    var submitBtn = host.querySelector('.pin-card__submit');
    var forgotBtn = host.querySelector('.pin-card__forgot');
    var dots = host.querySelectorAll('.pin-dot');
    var secondsEl = host.querySelector('.pin-card__seconds');

    function paint() {
      var value = String(input.value || '');
      for (var i = 0; i < dots.length; i++) {
        dots[i].classList.toggle('pin-dot--filled', i < value.length);
      }
    }

    function showError(text) {
      errorEl.textContent = text;
      host.querySelector('.pin-card').classList.remove('pin-card--shake');
      // reflow нужен, чтобы анимация перезапустилась
      void host.querySelector('.pin-card').offsetWidth;
      host.querySelector('.pin-card').classList.add('pin-card--shake');
    }

    function startCooldown(ms) {
      var until = Date.now() + ms;
      submitBtn.disabled = true;
      input.disabled = true;
      var line = host.querySelector('.pin-card__cooldown');
      line.hidden = false;

      // Первую цифру ставим СРАЗУ: интервал тикает только через 500 мс,
      // и без этой строки пользователь видел «Повторите через 0 с.» —
      // то есть будто пауза уже закончилась
      if (secondsEl) { secondsEl.textContent = String(Math.ceil(ms / 1000)); }

      var id = setInterval(function () {
        var left = until - Date.now();
        if (left <= 0) {
          clearInterval(id);
          line.hidden = true;
          submitBtn.disabled = false;
          input.disabled = false;
          input.value = '';
          paint();
          input.focus();
          return;
        }
        secondsEl.textContent = String(Math.ceil(left / 1000));
      }, 500);
    }

    function submit() {
      if (cooldownLeft() > 0) { return; }

      var pin = String(input.value || '');
      if (pin.length !== PIN_LENGTH) {
        showError('Введите все 4 цифры.');
        return;
      }

      verify(pin).then(function (res) {
        if (res.ok) {
          unlock();
          return;
        }

        // «Нечем проверить» — не вина пользователя: Паузу не включаем,
        // попытку не считаем, зато объясняем, что делать
        if (res.blocked) {
          showError(res.message);
          return;
        }

        input.value = '';
        paint();
        var left = registerFailure();
        showError(left > 0
          ? 'Неверный PIN.'
          : 'Неверный PIN. Осталось попыток: ' + (MAX_ATTEMPTS - attempts) + '.');
        if (left > 0) { startCooldown(left); }
      });
    }

    input.addEventListener('input', function () {
      // Фильтруем не-цифры до проверки: на мобильных с русской раскладкой
      // в поле легко прилетает «рщ» вместо «12»
      input.value = String(input.value || '').replace(/\D/g, '').slice(0, PIN_LENGTH);
      errorEl.textContent = '';
      paint();
      if (input.value.length === PIN_LENGTH) { submit(); }
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    submitBtn.addEventListener('click', submit);

    forgotBtn.addEventListener('click', function () {
      showRecovery(host, errorEl);
    });

    // Escape не должен закрывать блокировку
    host.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); }
    }, true);

    paint();
  }

  /**
   * Экран восстановления. Два честных пути:
   *   1. Подтвердить привязанный VK ID — разблокировать и снять PIN.
   *   2. Удалить все данные — без возврата.
   * @param {HTMLElement} host
   * @param {HTMLElement} errorEl
   */
  function showRecovery(host, errorEl) {
    var hint = recoveryHint();
    var card = host.querySelector('.pin-card');

    card.innerHTML = '' +
      '<h2 class="pin-card__title">Восстановление доступа</h2>' +
      '<p class="pin-card__text">' +
        (hint
          ? 'Введите VK ID, к которому привязан PIN (' + hint + '). После восстановления PIN будет сброшен.'
          : 'PIN не был привязан к аккаунту ВКонтакте, поэтому единственный способ — удалить данные и начать заново.') +
      '</p>' +
      (hint
        ? '<input class="pin-recovery__id" type="text" inputmode="numeric" pattern="[0-9]*"' +
            ' placeholder="VK ID" aria-label="VK ID для восстановления">' +
          '<div class="pin-card__error" role="alert"></div>' +
          '<button type="button" class="btn btn--primary pin-recovery__confirm">Подтвердить</button>'
        : '') +
      '<button type="button" class="btn btn--danger pin-recovery__wipe">Удалить все данные</button>' +
      '<button type="button" class="pin-card__forgot pin-recovery__back">Назад к вводу PIN</button>';

    var back = card.querySelector('.pin-recovery__back');
    if (back) {
      back.addEventListener('click', function () {
        overlayEl = null;
        if (host.parentNode) { host.parentNode.removeChild(host); }
        document.body.classList.remove('pin-locked');
        lock();
      });
    }

    var confirmBtn = card.querySelector('.pin-recovery__confirm');
    if (confirmBtn) {
      var idInput = card.querySelector('.pin-recovery__id');
      var recError = card.querySelector('.pin-card__error');

      idInput.addEventListener('input', function () {
        idInput.value = String(idInput.value || '').replace(/\D/g, '').slice(0, 12);
      });

      confirmBtn.addEventListener('click', function () {
        var entered = String(idInput.value || '');
        var saved = String(lsGet(RECOVERY_KEY) || '');

        if (!/^\d+$/.test(entered)) {
          recError.textContent = 'Введите VK ID цифрами.';
          return;
        }
        if (entered !== saved) {
          recError.textContent = 'Этот VK ID не совпадает с привязанным.';
          return;
        }

        lsRemove(PIN_KEY);
        lsRemove(RECOVERY_KEY);
        lsRemove(LOCKUNTIL_KEY);
        unlock();
        if (window.VK && window.VK.notify) {
          window.VK.notify('PIN сброшен. Данные сохранены.', 'success');
        }
      });
    }

    card.querySelector('.pin-recovery__wipe').addEventListener('click', function () {
      var btn = this;
      var line = card.querySelector('.pin-card__error') || errorEl;

      if (btn.getAttribute('data-armed') !== '1') {
        btn.setAttribute('data-armed', '1');
        btn.textContent = 'Точно удалить всё? Нажмите ещё раз';
        if (line) {
          line.textContent = 'Будут удалены ВСЕ платежи, счётчики, документы и задачи. ' +
            'Восстановить нельзя. Если у вас есть резервная копия — сначала загрузите её после сброса.';
        }
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Удаляем…';

      wipeEverything().then(function () {
        lsRemove(PIN_KEY);
        lsRemove(RECOVERY_KEY);
        lsRemove(LOCKUNTIL_KEY);
        unlockSession();
        overlayEl = null;
        if (host.parentNode) { host.parentNode.removeChild(host); }
        document.body.classList.remove('pin-locked');
        window.location.hash = 'home';
        window.location.reload();
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Удалить все данные';
        if (line) { line.textContent = 'Не удалось удалить данные: ' + err.message; }
      });
    });
  }

  /**
   * Полное стирание: и данные, и настройки. Settings чистим отдельно —
   * там живут подписки и кэш, их тоже надо снять.
   * @returns {Promise<void>}
   */
  function wipeEverything() {
    if (!window.DB || typeof window.DB.clear !== 'function') {
      return Promise.reject(new Error('База данных недоступна.'));
    }

    var stores = ['payments', 'meters', 'meter_readings', 'documents', 'tasks', 'settings'];

    return stores.reduce(function (chain, store) {
      return chain.then(function () { return window.DB.clear(store, true); });
    }, Promise.resolve()).then(function () {
      ['myorder_cloud_dirty', 'myorder_cloud_last_backup', 'myorder_cloud_proxy',
        'myorder_pro_cache', 'myorder_stats_period'].forEach(lsRemove);
    });
  }

  /* ================================================================
     9. СТАРТ ПРИЛОЖЕНИЯ
     ================================================================ */

  /**
   * Вешает блокировку. Вызывается на DOMContentLoaded — то есть ДО того,
   * как app.js дойдёт до инициализации IndexedDB и рендера разделов.
   */
  function gateOnStart() {
    if (!shouldLock()) { return; }
    lock();
    console.info('[Security] Данные закрыты PIN: показан оверлей.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', gateOnStart);
  } else {
    gateOnStart();
  }

  // Подписка могла истечь, пока вкладка открыта: блокировка снимается,
  // данные остаются доступны (CRUD не запрещаем).
  window.addEventListener('pro:changed', function (e) {
    var tier = (e && e.detail && e.detail.tier) || (window.ProManager && window.ProManager.tier && window.ProManager.tier());
    if (tier === 'pro') {
      gateOnStart();
    } else {
      if (overlayEl && document.body.contains(overlayEl)) {
        overlayEl.parentNode.removeChild(overlayEl);
        overlayEl = null;
        document.body.classList.remove('pin-locked');
      }
      unlockSession();
    }
  });

  /* ================================================================
     10. ПУБЛИЧНЫЙ API
     ================================================================ */

  window.Security = {
    isPinSet: isPinSet,
    setPin: setPin,
    clearPin: clearPin,
    validatePin: validatePin,
    verify: verify,
    recoveryHint: recoveryHint,
    cooldownLeft: cooldownLeft,

    shouldLock: shouldLock,
    isUnlocked: isUnlocked,
    lock: lock,
    unlock: unlock,
    lockSession: lockSession,

    PIN_LENGTH: PIN_LENGTH,
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    COOLDOWN_MS: COOLDOWN_MS
  };

  console.info('[Security] Модуль загружен. API: window.Security');
})();
