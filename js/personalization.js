/**
 * МОЙ ПОРЯДОК — Персонализация и пользовательские категории (Этап 12.8)
 *
 * Возможности:
 *   1. Цветовые схемы акцентов (PRO ONLY, 5 вариантов, плавная смена 300мс).
 *   2. Пользовательские категории платежей и задач (PRO ONLY, store 'custom_categories').
 *   3. Настройка главного экрана (FREE + PRO, toggle блоков и сортировка вверх/вниз).
 *   4. Размер шрифта (FREE + PRO, 16/18/20px) и Высокий контраст (PRO ONLY).
 *   5. Звуковые и тактильные эффекты (PRO ONLY, Web Audio API + VK Bridge / vibrate).
 *   6. Экспорт и импорт персонализации.
 *
 * Экспортирует window.Personalization.
 */

(function () {
  'use strict';

  /* ================================================================
     1. КОНСТАНТЫ
     ================================================================ */

  var SET_ACCENT = 'accentColor';
  var SET_CONTRAST = 'highContrast';
  var SET_FONT_SIZE = 'fontSize';
  var SET_HAPTICS = 'vibrationEnabled';
  var SET_SOUND = 'soundEnabled';
  var SET_HOME_LAYOUT = 'homeLayout';

  var ACCENT_COLORS = {
    blue:   { id: 'blue',   name: 'Синий',       hex: '#2563EB', hover: '#1D4ED8' },
    purple: { id: 'purple', name: 'Фиолетовый',  hex: '#7C3AED', hover: '#6D28D9' },
    green:  { id: 'green',  name: 'Зелёный',     hex: '#059669', hover: '#047857' },
    orange: { id: 'orange', name: 'Оранжевый',   hex: '#EA580C', hover: '#C2410C' },
    pink:   { id: 'pink',   name: 'Розовый',     hex: '#DB2777', hover: '#BE185D' }
  };

  var FONT_SIZES = {
    normal: { id: 'normal', name: 'Стандартный',   size: '16px' },
    large:  { id: 'large',  name: 'Крупный',       size: '18px' },
    xlarge: { id: 'xlarge', name: 'Очень крупный', size: '20px' }
  };

  var DEFAULT_HOME_LAYOUT = [
    { id: 'summary',      visible: true, title: 'Сводка за месяц' },
    { id: 'quickActions', visible: true, title: 'Быстрые действия', locked: true },
    { id: 'upcoming',     visible: true, title: 'Ближайшие события' },
    { id: 'proBanner',    visible: true, title: 'Баннер PRO' }
  ];

  var PRESET_PALETTE = [
    '#EF4444', '#F97316', '#F59E0B', '#EAB308', '#84CC16', '#10B981',
    '#14B8A6', '#06B6D4', '#0EA5E9', '#3B82F6', '#6366F1', '#8B5CF6',
    '#A855F7', '#D946EF', '#EC4899', '#F43F5E', '#FB7185', '#64748B',
    '#475569', '#0F172A', '#92400E', '#059669'
  ];

  var PRESET_ICONS = [
    '☕', '🛒', '🛍️', '💳', '💰', '🎁', '🍔', '🍕', '🍣', '🍷',
    '🏠', '⚡', '💧', '🔥', '🧹', '🛋️', '🔧', '🛠️', '📦', '🌿',
    '🚗', '⛽', '🚕', '🚌', '🚇', '✈️', '🚲', '🅿️', '🎫', '🏖️',
    '💊', '🩺', '👶', '🐾', '🐶', '🐱', '🎓', '📚', '💼', '💻',
    '📱', '🎧', '🎮', '🎬', '🏋️', '⚽', '🎨', '👗', '💈', '✨'
  ];

  /* ================================================================
     2. СОСТОЯНИЕ В ПАМЯТИ
     ================================================================ */

  var cachedAccent = 'blue';
  var cachedContrast = false;
  var cachedFontSize = 'normal';
  var cachedHaptics = false;
  var cachedSound = false;
  var cachedHomeLayout = clone(DEFAULT_HOME_LAYOUT);
  var cachedCategories = [];

  var audioCtx = null;
  var isInitialized = false;

  function clone(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
  }

  function isPro() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  function toast(msg, type) {
    if (window.VK && window.VK.notify) {
      window.VK.notify(msg, type || 'info');
    } else {
      console.info('[Personalization]', msg);
    }
  }

  /* ================================================================
     3. БАЗА ДАННЫХ И LOCALSTORAGE
     ================================================================ */

  function readSetting(key) {
    if (!window.DB) { return Promise.resolve(null); }
    return window.DB.get('settings', key)
      .then(function (rec) { return rec ? rec.value : null; })
      .catch(function () { return null; });
  }

  function writeSetting(key, val) {
    if (!window.DB) { return Promise.resolve(); }
    return window.DB.get('settings', key).then(function (rec) {
      if (rec) { return window.DB.update('settings', key, { value: val }); }
      return window.DB.add('settings', { key: key, value: val });
    }).catch(function (err) {
      console.warn('[Personalization] Ошибка записи настройки ' + key + ':', err);
    });
  }

  function lsGet(k) {
    try { return localStorage.getItem('myorder_' + k); } catch (e) { return null; }
  }

  function lsSet(k, v) {
    try { localStorage.setItem('myorder_' + k, String(v)); } catch (e) {}
  }

  /* ================================================================
     4. ПРИМЕНЕНИЕ ОФОРМЛЕНИЯ В DOM
     ================================================================ */

  /**
   * Применяет акцентный цвет с плавной анимацией 300мс.
   * @param {string} accentId
   * @param {boolean} [animate]
   */
  function applyAccent(accentId, animate) {
    var valid = ACCENT_COLORS[accentId] ? accentId : 'blue';
    cachedAccent = valid;
    lsSet('accent', valid);

    var docEl = document.documentElement;
    if (animate) {
      docEl.classList.add('color-transition');
      setTimeout(function () {
        docEl.classList.remove('color-transition');
      }, 320);
    }

    if (valid === 'blue') {
      docEl.removeAttribute('data-accent');
    } else {
      docEl.setAttribute('data-accent', valid);
    }
  }

  /**
   * Применяет высокий контраст.
   * @param {boolean} enabled
   */
  function applyHighContrast(enabled) {
    cachedContrast = Boolean(enabled);
    lsSet('contrast', cachedContrast ? 'high' : 'normal');

    var docEl = document.documentElement;
    if (cachedContrast) {
      docEl.setAttribute('data-contrast', 'high');
    } else {
      docEl.removeAttribute('data-contrast');
    }
  }

  /**
   * Применяет базовый размер шрифта.
   * @param {string} sizeKey — 'normal' | 'large' | 'xlarge'
   */
  function applyFontSize(sizeKey) {
    var opt = FONT_SIZES[sizeKey] || FONT_SIZES.normal;
    cachedFontSize = opt.id;
    lsSet('font_size', opt.id);

    var docEl = document.documentElement;
    docEl.style.setProperty('--base-font-size', opt.size);
    docEl.setAttribute('data-font-size', opt.id);
  }

  /**
   * Применяет все визуальные токены сразу.
   */
  function applyAll() {
    applyAccent(cachedAccent, false);
    applyHighContrast(cachedContrast);
    applyFontSize(cachedFontSize);
  }

  /* ================================================================
     5. ЗВУКИ И ВИБРАЦИЯ (WEB AUDIO API + VK BRIDGE / VIBRATE)
     ================================================================ */

  function getAudioContext() {
    if (!audioCtx) {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        audioCtx = new AudioCtx();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(function () {});
    }
    return audioCtx;
  }

  function playTone(freq1, freq2, duration) {
    try {
      var ctx = getAudioContext();
      if (!ctx) return;

      var now = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq1, now);
      if (freq2 && freq2 !== freq1) {
        osc.frequency.exponentialRampToValueAtTime(freq2, now + duration * 0.7);
      }

      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + duration);
    } catch (err) {
      /* Web Audio API безопасен к ошибкам фонового режима */
    }
  }

  function playSuccessSound() {
    playTone(523.25, 659.25, 0.18); // мягкий восходящий chime C5 -> E5
  }

  function playAlertSound() {
    playTone(349.23, 293.66, 0.22); // мягкое предупреждение F4 -> D4
  }

  function triggerVibrate(pattern) {
    // 1. VK Bridge
    if (window.vkBridge && typeof window.vkBridge.send === 'function') {
      try {
        var tapticType = 'light';
        if (pattern === 'error') { tapticType = 'error'; }
        else if (pattern === 'success') { tapticType = 'success'; }

        window.vkBridge.send('VKWebAppTapticNotificationOccurred', { result_type: tapticType })
          .catch(function () {
            // fallback к impact
            window.vkBridge.send('VKWebAppTapticImpactOccurred', { style: 'light' }).catch(function () {});
          });
      } catch (e) {}
    }

    // 2. Navigator.vibrate
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        if (pattern === 'error') {
          navigator.vibrate([40, 40, 40]);
        } else if (pattern === 'success') {
          navigator.vibrate(35);
        } else {
          navigator.vibrate(30);
        }
      } catch (err) {}
    }
  }

  /**
   * Вызов тактильного и звукового отклика при ключевых событиях.
   * @param {'task_done'|'payment_saved'|'validation_error'} type
   */
  function triggerFeedback(type) {
    if (!isPro()) { return; }

    if (cachedHaptics) {
      if (type === 'validation_error') {
        triggerVibrate('error');
      } else {
        triggerVibrate('success');
      }
    }

    if (cachedSound) {
      if (type === 'validation_error') {
        playAlertSound();
      } else {
        playSuccessSound();
      }
    }
  }

  /* ================================================================
     6. УПРАВЛЕНИЕ НАСТРОЙКАМИ (API)
     ================================================================ */

  function setAccentColor(accentId) {
    if (!isPro()) {
      toast('Смена цвета акцента доступна только в PRO', 'error');
      return Promise.resolve({ ok: false, message: 'Только в PRO' });
    }
    applyAccent(accentId, true);
    return writeSetting(SET_ACCENT, cachedAccent).then(function () {
      dispatchChanged('accent');
      return { ok: true, accent: cachedAccent };
    });
  }

  function setContrast(enabled) {
    if (!isPro()) {
      toast('Высокий контраст доступен только в PRO', 'error');
      return Promise.resolve({ ok: false, message: 'Только в PRO' });
    }
    applyHighContrast(enabled);
    return writeSetting(SET_CONTRAST, cachedContrast).then(function () {
      dispatchChanged('contrast');
      return { ok: true, contrast: cachedContrast };
    });
  }

  function setFontSizeMode(sizeKey) {
    applyFontSize(sizeKey);
    return writeSetting(SET_FONT_SIZE, cachedFontSize).then(function () {
      dispatchChanged('fontSize');
      return { ok: true, fontSize: cachedFontSize };
    });
  }

  function setHapticsEnabled(enabled) {
    if (!isPro()) {
      toast('Тактильный отклик доступен только в PRO', 'error');
      return Promise.resolve({ ok: false, message: 'Только в PRO' });
    }
    cachedHaptics = Boolean(enabled);
    lsSet('haptics', cachedHaptics ? '1' : '0');
    return writeSetting(SET_HAPTICS, cachedHaptics).then(function () {
      dispatchChanged('haptics');
      return { ok: true, haptics: cachedHaptics };
    });
  }

  function setSoundEnabled(enabled) {
    if (!isPro()) {
      toast('Звуковые эффекты доступны только в PRO', 'error');
      return Promise.resolve({ ok: false, message: 'Только в PRO' });
    }
    cachedSound = Boolean(enabled);
    lsSet('sound', cachedSound ? '1' : '0');
    if (cachedSound) { getAudioContext(); }
    return writeSetting(SET_SOUND, cachedSound).then(function () {
      dispatchChanged('sound');
      return { ok: true, sound: cachedSound };
    });
  }

  function dispatchChanged(key) {
    try {
      window.dispatchEvent(new CustomEvent('personalization:changed', { detail: { key: key } }));
    } catch (e) {}
  }

  /* ================================================================
     7. ГЛАВНЫЙ ЭКРАН (LAYOUT)
     ================================================================ */

  function getHomeLayout() {
    return clone(cachedHomeLayout);
  }

  function setHomeLayout(layout) {
    if (!Array.isArray(layout) || !layout.length) {
      layout = clone(DEFAULT_HOME_LAYOUT);
    }
    cachedHomeLayout = clone(layout);
    return writeSetting(SET_HOME_LAYOUT, cachedHomeLayout).then(function () {
      try { window.dispatchEvent(new CustomEvent('home:layout-changed', { detail: cachedHomeLayout })); }
      catch (e) {}
      return cachedHomeLayout;
    });
  }

  function reorderHomeBlock(blockId, direction) {
    var list = clone(cachedHomeLayout);
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === blockId) { idx = i; break; }
    }
    if (idx === -1) { return Promise.resolve(list); }

    var targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= list.length) {
      return Promise.resolve(list);
    }

    var item = list.splice(idx, 1)[0];
    list.splice(targetIdx, 0, item);
    return setHomeLayout(list);
  }

  function toggleHomeBlock(blockId, visible) {
    var list = clone(cachedHomeLayout);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === blockId) {
        if (list[i].locked) { return Promise.resolve(list); }
        list[i].visible = Boolean(visible);
        break;
      }
    }
    return setHomeLayout(list);
  }

  /* ================================================================
     8. ПОЛЬЗОВАТЕЛЬСКИЕ КАТЕГОРИИ
     ================================================================ */

  function refreshCategories() {
    if (!window.DB) { return Promise.resolve([]); }
    return window.DB.getAll('custom_categories').then(function (rows) {
      cachedCategories = rows || [];
      return cachedCategories;
    }).catch(function () {
      cachedCategories = [];
      return [];
    });
  }

  function getCategories(type) {
    if (!type || type === 'all') { return cachedCategories.slice(); }
    return cachedCategories.filter(function (c) {
      return !c.type || c.type === 'both' || c.type === type;
    });
  }

  function getCategoryColors(name) {
    if (!name) return null;
    for (var i = 0; i < cachedCategories.length; i++) {
      var c = cachedCategories[i];
      if (c.name && c.name.toLowerCase() === name.toLowerCase()) {
        return {
          bg: c.color || '#DBEAFE',
          fg: getContrastingText(c.color || '#DBEAFE'),
          icon: c.icon || '🏷️',
          isCustom: true
        };
      }
    }
    return null;
  }

  function getContrastingText(hexColor) {
    var hex = String(hexColor || '').replace('#', '');
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    var r = parseInt(hex.substr(0, 2), 16) || 0;
    var g = parseInt(hex.substr(2, 2), 16) || 0;
    var b = parseInt(hex.substr(4, 2), 16) || 0;
    // YIQ formula
    var yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 140) ? '#0F172A' : '#FFFFFF';
  }

  function addCategory(data) {
    if (!isPro()) {
      toast('Создание своих категорий доступно только в PRO', 'error');
      return Promise.resolve({ ok: false, message: 'Только в PRO' });
    }
    if (!window.DB) {
      return Promise.resolve({ ok: false, message: 'База данных не готова' });
    }

    var name = String(data.name || '').trim();
    if (!name) {
      return Promise.resolve({ ok: false, message: 'Введите название категории' });
    }
    if (name.length > 30) {
      return Promise.resolve({ ok: false, message: 'Слишком длинное название (макс. 30 символов)' });
    }

    var exists = cachedCategories.some(function (c) {
      return c.name.toLowerCase() === name.toLowerCase();
    });
    if (exists) {
      return Promise.resolve({ ok: false, message: 'Категория с таким названием уже существует' });
    }

    var item = {
      name: name,
      color: data.color || PRESET_PALETTE[0],
      icon: String(data.icon || '🏷️').trim().slice(0, 4) || '🏷️',
      type: data.type || 'both' // 'payment' | 'task' | 'both'
    };

    return window.DB.add('custom_categories', item).then(function (id) {
      item.id = id;
      return refreshCategories().then(function () {
        try { window.dispatchEvent(new CustomEvent('categories:changed')); } catch (e) {}
        return { ok: true, category: item };
      });
    });
  }

  function removeCategory(id) {
    if (!isPro()) {
      toast('Управление категориями доступно только в PRO', 'error');
      return Promise.resolve({ ok: false, message: 'Только в PRO' });
    }
    if (!window.DB) {
      return Promise.resolve({ ok: false, message: 'База данных не готова' });
    }

    return window.DB.delete('custom_categories', id).then(function () {
      return refreshCategories().then(function () {
        try { window.dispatchEvent(new CustomEvent('categories:changed')); } catch (e) {}
        return { ok: true };
      });
    });
  }

  /**
   * Формирует HTML-опции для выбора категории (сначала пользовательские, потом стандартные).
   * @param {'payment'|'task'} type
   * @param {string} [currentValue]
   * @param {Array<{name: string}>} [standardCategories]
   * @returns {string}
   */
  function buildCategorySelectOptions(type, currentValue, standardCategories) {
    var custom = getCategories(type);
    var html = '';

    if (custom.length) {
      html += '<optgroup label="Мои категории">';
      for (var i = 0; i < custom.length; i++) {
        var c = custom[i];
        var sel = currentValue === c.name ? ' selected' : '';
        html += '<option value="' + esc(c.name) + '"' + sel + '>' +
          esc((c.icon ? c.icon + ' ' : '') + c.name) + '</option>';
      }
      html += '</optgroup>';
    }

    if (standardCategories && standardCategories.length) {
      html += (custom.length ? '<optgroup label="Стандартные">' : '');
      for (var j = 0; j < standardCategories.length; j++) {
        var s = standardCategories[j];
        var sSel = currentValue === s.name ? ' selected' : '';
        html += '<option value="' + esc(s.name) + '"' + sSel + '>' + esc(s.name) + '</option>';
      }
      html += (custom.length ? '</optgroup>' : '');
    }

    return html;
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ================================================================
     9. ЭКСПОРТ И ИМПОРТ НАСТРОЕК
     ================================================================ */

  function getExportPayload() {
    return {
      accentColor: cachedAccent,
      highContrast: cachedContrast,
      fontSize: cachedFontSize,
      vibrationEnabled: cachedHaptics,
      soundEnabled: cachedSound,
      homeLayout: cachedHomeLayout,
      customCategories: cachedCategories,
      tariffs: window.ValuePack && window.ValuePack.getTariffs ? window.ValuePack.getTariffs() : undefined,
      warranties: window.ValuePack && window.ValuePack.getWarranties ? window.ValuePack.getWarranties() : undefined,
      savingsGoal: window.ValuePack && window.ValuePack.getSavingsGoal ? window.ValuePack.getSavingsGoal() : undefined
    };
  }

  function importPersonalization(payload) {
    if (!payload || typeof payload !== 'object') { return Promise.resolve(false); }

    var p = payload.personalization || payload;
    var writes = [];

    if (p.accentColor && ACCENT_COLORS[p.accentColor]) {
      cachedAccent = p.accentColor;
      applyAccent(cachedAccent, false);
      writes.push(writeSetting(SET_ACCENT, cachedAccent));
    }

    if (typeof p.highContrast === 'boolean') {
      cachedContrast = p.highContrast;
      applyHighContrast(cachedContrast);
      writes.push(writeSetting(SET_CONTRAST, cachedContrast));
    }

    if (p.fontSize && FONT_SIZES[p.fontSize]) {
      cachedFontSize = p.fontSize;
      applyFontSize(cachedFontSize);
      writes.push(writeSetting(SET_FONT_SIZE, cachedFontSize));
    }

    if (typeof p.vibrationEnabled === 'boolean') {
      cachedHaptics = p.vibrationEnabled;
      lsSet('haptics', cachedHaptics ? '1' : '0');
      writes.push(writeSetting(SET_HAPTICS, cachedHaptics));
    }

    if (typeof p.soundEnabled === 'boolean') {
      cachedSound = p.soundEnabled;
      lsSet('sound', cachedSound ? '1' : '0');
      writes.push(writeSetting(SET_SOUND, cachedSound));
    }

    if (Array.isArray(p.homeLayout) && p.homeLayout.length) {
      cachedHomeLayout = clone(p.homeLayout);
      writes.push(writeSetting(SET_HOME_LAYOUT, cachedHomeLayout));
    }

    if (p.tariffs && window.ValuePack && window.ValuePack.setTariffs) {
      window.ValuePack.setTariffs(p.tariffs);
    }
    if (Array.isArray(p.warranties)) {
      try { localStorage.setItem('myorder_warranties', JSON.stringify(p.warranties)); } catch (e) {}
    }
    if (p.savingsGoal && typeof p.savingsGoal === 'object') {
      try { localStorage.setItem('myorder_savings_goal', JSON.stringify(p.savingsGoal)); } catch (e) {}
    }

    // Восстановление категорий
    var cats = Array.isArray(p.customCategories) ? p.customCategories
      : (Array.isArray(payload.custom_categories) ? payload.custom_categories : null);

    if (cats && window.DB) {
      writes.push(
        window.DB.clear('custom_categories', true).then(function () {
          var adds = cats.map(function (c) {
            var item = {
              name: c.name,
              color: c.color,
              icon: c.icon || '🏷️',
              type: c.type || 'both'
            };
            return window.DB.add('custom_categories', item);
          });
          return Promise.all(adds).then(refreshCategories);
        })
      );
    }

    return Promise.all(writes).then(function () {
      applyAll();
      try {
        window.dispatchEvent(new CustomEvent('personalization:changed'));
        window.dispatchEvent(new CustomEvent('home:layout-changed', { detail: cachedHomeLayout }));
      } catch (e) {}
      return true;
    });
  }

  /* ================================================================
     10. ИНИЦИАЛИЗАЦИЯ
     ================================================================ */

  function init() {
    if (isInitialized) { return Promise.resolve(); }
    isInitialized = true;

    // Сначала быстро восстанавливаем из localStorage (без задержки)
    var savedAccent = lsGet('accent');
    if (savedAccent && ACCENT_COLORS[savedAccent]) { cachedAccent = savedAccent; }

    var savedContrast = lsGet('contrast');
    if (savedContrast === 'high') { cachedContrast = true; }

    var savedFs = lsGet('font_size');
    if (savedFs && FONT_SIZES[savedFs]) { cachedFontSize = savedFs; }

    cachedHaptics = lsGet('haptics') === '1';
    cachedSound = lsGet('sound') === '1';

    applyAll();

    if (!window.DB) { return Promise.resolve(); }

    return Promise.all([
      readSetting(SET_ACCENT),
      readSetting(SET_CONTRAST),
      readSetting(SET_FONT_SIZE),
      readSetting(SET_HAPTICS),
      readSetting(SET_SOUND),
      readSetting(SET_HOME_LAYOUT),
      refreshCategories()
    ]).then(function (res) {
      if (res[0] && ACCENT_COLORS[res[0]]) { cachedAccent = res[0]; }
      if (typeof res[1] === 'boolean') { cachedContrast = res[1]; }
      if (res[2] && FONT_SIZES[res[2]]) { cachedFontSize = res[2]; }
      if (typeof res[3] === 'boolean') { cachedHaptics = res[3]; }
      if (typeof res[4] === 'boolean') { cachedSound = res[4]; }
      if (Array.isArray(res[5]) && res[5].length) {
        cachedHomeLayout = res[5];
      }

      applyAll();
    }).catch(function (err) {
      console.warn('[Personalization] Ошибка инициализации:', err);
    });
  }

  /* ================================================================
     11. ЭКСПОРТ МОДУЛЯ
     ================================================================ */

  window.Personalization = {
    init: init,
    applyAll: applyAll,

    // Акценты
    ACCENTS: ACCENT_COLORS,
    getAccent: function () { return cachedAccent; },
    setAccent: setAccentColor,

    // Контраст
    getHighContrast: function () { return cachedContrast; },
    setHighContrast: setContrast,
    setContrast: setContrast,

    // Шрифт
    FONT_SIZES: FONT_SIZES,
    getFontSize: function () { return cachedFontSize; },
    setFontSize: setFontSizeMode,

    // Звуки и тактильность
    getHaptics: function () { return cachedHaptics; },
    setHaptics: setHapticsEnabled,
    getSound: function () { return cachedSound; },
    setSound: setSoundEnabled,
    triggerFeedback: triggerFeedback,

    // Главный экран
    DEFAULT_LAYOUT: DEFAULT_HOME_LAYOUT,
    getHomeLayout: getHomeLayout,
    setHomeLayout: setHomeLayout,
    reorderHomeBlock: reorderHomeBlock,
    toggleHomeBlock: toggleHomeBlock,

    // Категории
    PRESET_PALETTE: PRESET_PALETTE,
    PRESET_ICONS: PRESET_ICONS,
    getCategories: getCategories,
    getCategoryColors: getCategoryColors,
    addCategory: addCategory,
    removeCategory: removeCategory,
    buildCategorySelectOptions: buildCategorySelectOptions,

    // Экспорт / импорт
    getExportPayload: getExportPayload,
    importPersonalization: importPersonalization
  };

  console.info('[Personalization] Модуль загружен.');
})();
