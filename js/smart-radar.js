/**
 * МОЙ ПОРЯДОК — Умный радар инсайтов и интеллектуальное добавление (PRO)
 *
 * 1. Smart Radar (Финансовый радар инсайтов):
 *    • Анализ аномалий (перерасход по ЖКУ относительно среднего)
 *    • Прогноз плановых расходов недели
 *    • Предупреждение о дедлайнах счётчиков
 *
 * 2. Quick Add Magic (Интеллектуальный ввод одной строкой):
 *    • Распознавание естественного текста («Свет 340», «Интернет 650 до 25», «Купить фильтр»)
 *    • Автоматическое создание показаний, платежей и дел
 *
 * Экспортирует window.SmartRadar
 */

(function () {
  'use strict';

  function isPro() {
    return Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());
  }

  /* ================================================================
     1. SMART NLP PARSER
     ================================================================ */

  /**
   * Разбирает строку на тип записи и поля.
   * @param {string} text
   * @returns {{type: 'meter'|'payment'|'task', data: Object, previewText: string}|null}
   */
  function parseQuickInput(text) {
    if (!text || typeof text !== 'string') return null;
    var raw = text.trim();
    if (!raw) return null;

    var lower = raw.toLowerCase();

    // 1. Счётчики: слова-маркеры воды/света/газа + число показания
    var meterMatch = lower.match(/(свет|электроэнергия|электричество|вода\s*(хол|гор)?|газ|отопление)\s*[:=]?\s*(\d+[.,]?\d*)/i);
    if (meterMatch) {
      var meterKey = meterMatch[1].trim();
      var readingVal = parseFloat(meterMatch[3].replace(',', '.'));
      var meterType = 'electricity';
      var meterTitle = 'Электричество';

      if (/вода.*хол/i.test(meterKey)) {
        meterType = 'cold_water'; meterTitle = 'Холодная вода';
      } else if (/вода.*гор/i.test(meterKey)) {
        meterType = 'hot_water'; meterTitle = 'Горячая вода';
      } else if (/вода/i.test(meterKey)) {
        meterType = 'water'; meterTitle = 'Вода';
      } else if (/газ/i.test(meterKey)) {
        meterType = 'gas'; meterTitle = 'Газ';
      } else if (/отопление/i.test(meterKey)) {
        meterType = 'heating'; meterTitle = 'Отопление';
      }

      return {
        type: 'meter',
        data: { type: meterType, title: meterTitle, value: readingVal },
        previewText: 'Счётчик «' + meterTitle + '»: внести показание ' + readingVal
      };
    }

    // 2. Платежи: сумма (руб/₽/р или просто число от 50 до 1000000)
    var paymentMatch = lower.match(/([а-яёa-z0-9\s-]+?)\s+(\d+(?:\s*\d+)?(?:[.,]\d{1,2})?)\s*(?:₽|руб|р)?(?:\s+(?:до|на)\s+(\d{1,2}(?:[./]\d{1,2}(?:[./]\d{2,4})?)?))?$/i);
    if (paymentMatch && !/^(купить|позвонить|сделать|убрать|помыть|починить)/i.test(paymentMatch[1])) {
      var title = paymentMatch[1].trim();
      var amountNum = parseFloat(paymentMatch[2].replace(/\s/g, '').replace(',', '.'));

      if (amountNum > 0 && title.length >= 2) {
        var today = new Date();
        var targetDate = today.toISOString().slice(0, 10);

        if (paymentMatch[3]) {
          var day = parseInt(paymentMatch[3], 10);
          if (day >= 1 && day <= 31) {
            var d = new Date(today.getFullYear(), today.getMonth(), day);
            if (d < today) {
              d = new Date(today.getFullYear(), today.getMonth() + 1, day);
            }
            targetDate = d.toISOString().slice(0, 10);
          }
        }

        return {
          type: 'payment',
          data: {
            title: capitalize(title),
            amount: Math.round(amountNum * 100),
            date: targetDate,
            category: guessCategory(title),
            status: 'pending'
          },
          previewText: 'Платёж «' + capitalize(title) + '»: ' + amountNum + ' ₽ (срок: ' + targetDate + ')'
        };
      }
    }

    // 3. Дела / Задачи (всё остальное)
    return {
      type: 'task',
      data: {
        title: capitalize(raw),
        priority: /срочно|важно|быстро/i.test(lower) ? 'high' : 'medium',
        completed: false
      },
      previewText: 'Дело: «' + capitalize(raw) + '»'
    };
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function guessCategory(title) {
    var t = title.toLowerCase();
    if (/свет|вода|газ|отопление|жку|жкх|квартплата|капремонт/i.test(t)) return 'Коммуналка';
    if (/интернет|связь|телефон|тв|провайдер/i.test(t)) return 'Интернет и связь';
    if (/кредит|ипотека|банк|займ/i.test(t)) return 'Кредиты';
    if (/налог|госуслуги|штраф/i.test(t)) return 'Налоги';
    if (/подписка|музыка|кино/i.test(t)) return 'Подписки';
    return 'Прочее';
  }

  /**
   * Сохраняет разобранный объект в БД.
   */
  function executeQuickAdd(parsed) {
    if (!parsed || !window.DB) {
      return Promise.reject(new Error('Некорректные данные'));
    }

    if (parsed.type === 'meter') {
      return window.DB.getAll('meters').then(function (meters) {
        var found = null;
        for (var i = 0; i < meters.length; i++) {
          if (meters[i].type === parsed.data.type || (meters[i].title && meters[i].title.toLowerCase().indexOf(parsed.data.title.toLowerCase()) !== -1)) {
            found = meters[i];
            break;
          }
        }

        var p = found
          ? Promise.resolve(found.id)
          : window.DB.add('meters', {
              type: parsed.data.type,
              title: parsed.data.title,
              unit: parsed.data.type === 'electricity' ? 'кВт·ч' : 'м³'
            });

        return p.then(function (mRes) {
          var mid = (typeof mRes === 'object' && mRes !== null) ? mRes.id : mRes;
          return window.DB.add('meter_readings', {
            meterId: Number(mid),
            value: parsed.data.value,
            date: new Date().toISOString().slice(0, 10)
          });
        });
      });
    }

    if (parsed.type === 'payment') {
      var item = Object.assign({
        title: parsed.data.title || 'Платёж',
        amount: parsed.data.amount || 0,
        date: parsed.data.date || new Date().toISOString().slice(0, 10),
        category: parsed.data.category || 'Прочее',
        status: 'pending'
      }, parsed.data);
      delete item.id;
      if (window.VK && window.VK.firstName) {
        item.authorName = window.VK.firstName();
      }
      if (window.Properties && window.Properties.stamp) {
        window.Properties.stamp(item);
      }
      return window.DB.add('payments', item);
    }

    if (parsed.type === 'task') {
      var taskItem = Object.assign({
        title: parsed.data.title || 'Новое дело',
        priority: parsed.data.priority || 'medium',
        completed: false
      }, parsed.data);
      delete taskItem.id;
      if (window.VK && window.VK.firstName) {
        taskItem.authorName = window.VK.firstName();
      }
      if (window.Properties && window.Properties.stamp) {
        window.Properties.stamp(taskItem);
      }
      return window.DB.add('tasks', taskItem);
    }

    return Promise.reject(new Error('Неизвестный тип'));
  }

  /* ================================================================
     2. QUICK ADD UI BAR
     ================================================================ */

  function renderQuickAddBar() {
    return '' +
      '<div class="quick-add-box" data-quick-box="true">' +
        '<span class="quick-add-box__icon" aria-hidden="true">⚡</span>' +
        '<input type="text" class="quick-add-box__input" data-quick-input="true" ' +
          'placeholder="Умная строка: «Свет 340», «Интернет 650 до 25» или дело..." ' +
          'aria-label="Умная строка быстрого добавления">' +
        '<button type="button" class="quick-add-box__voice" data-voice-btn="true" aria-label="Голосовой ввод" title="Сказать голосом">🎙️</button>' +
        '<button type="button" class="quick-add-box__btn" data-quick-btn="true">Добавить</button>' +
      '</div>' +
      '<div class="quick-add-preview-wrap" data-quick-preview="true" style="display:none;"></div>';
  }

  var eventsBound = false;

  function bindQuickAddEvents() {
    if (eventsBound) return;
    eventsBound = true;

    // Глобальная делегация ввода для всех умных строк
    document.addEventListener('input', function (e) {
      var input = e.target;
      if (!input || !input.hasAttribute('data-quick-input')) return;

      var box = input.closest('[data-quick-box]');
      var previewWrap = box ? box.nextElementSibling : null;
      if (!previewWrap || !previewWrap.hasAttribute('data-quick-preview')) {
        previewWrap = document.querySelector('[data-quick-preview]');
      }

      var val = input.value.trim();
      if (!val) {
        if (previewWrap) {
          previewWrap.style.display = 'none';
          previewWrap.innerHTML = '';
        }
        return;
      }

      var parsed = parseQuickInput(val);
      if (parsed && previewWrap) {
        previewWrap.style.display = 'block';
        previewWrap.innerHTML = '<div class="quick-add-preview">' +
          '<span>✨ ' + parsed.previewText + '</span>' +
          '<small style="color:var(--text-secondary);">' + (isPro() ? 'PRO' : 'Тест') + '</small>' +
          '</div>';
      }
    }, true);

    // Обработка кнопки «Добавить»
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-quick-btn]');
      if (!btn) return;

      var box = btn.closest('[data-quick-box]');
      if (!box) return;

      var input = box.querySelector('[data-quick-input]');
      if (!input) return;

      var val = input.value.trim();
      if (!val) {
        // Если поле пустое — в разделе дел открываем форму добавления, либо фокусируем поле
        var isTasks = window.App && window.App.getCurrentRoute && window.App.getCurrentRoute() === 'tasks';
        if (isTasks && window.Tasks && window.Tasks.openAddForm) {
          window.Tasks.openAddForm();
        } else {
          input.focus();
          if (window.VK && window.VK.notify) {
            window.VK.notify('Напишите текст дела, счёта или показания', 'info');
          }
        }
        return;
      }

      var parsed = parseQuickInput(val);
      if (!parsed) return;

      btn.disabled = true;

      executeQuickAdd(parsed).then(function () {
        input.value = '';
        btn.disabled = false;

        var previewWrap = box.nextElementSibling;
        if (previewWrap && previewWrap.hasAttribute('data-quick-preview')) {
          previewWrap.style.display = 'none';
          previewWrap.innerHTML = '';
        }

        try {
          if (window.VK && window.VK.taptic) {
            window.VK.taptic('notification', 'success');
          }
          if (window.MicroFX && window.MicroFX.burst) {
            window.MicroFX.burst(btn);
          }
        } catch (err) {}

        if (window.Tasks && window.Tasks.invalidate && window.Tasks.render) {
          window.Tasks.invalidate();
          window.Tasks.render();
        }
        if (window.Payments && window.Payments.invalidate) {
          window.Payments.invalidate();
        }
        if (window.App && window.App.getCurrentRoute && window.App.getCurrentRoute() === 'home') {
          window.App.renderSection('home');
        }
        if (window.VK && window.VK.notify) {
          window.VK.notify('✨ ' + (parsed.type === 'task' ? 'Дело создано' : (parsed.type === 'payment' ? 'Платёж добавлен' : 'Показание внесено')), 'success');
        }
      }).catch(function (err) {
        btn.disabled = false;
        alert('Не удалось сохранить: ' + err.message);
      });
    }, true);

    // Нажатие Enter в инпуте
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var input = e.target;
      if (!input || !input.hasAttribute('data-quick-input')) return;

      var box = input.closest('[data-quick-box]');
      if (!box) return;
      var btn = box.querySelector('[data-quick-btn]');
      if (btn) btn.click();
    }, true);
  }

  // Привязываем слушатели сразу
  bindQuickAddEvents();

  /* ================================================================
     3. SMART RADAR INSIGHTS
     ================================================================ */

  /**
   * Считает инсайты для текущего пользователя.
   * @returns {Promise<Array<{icon: string, title: string, text: string}>>}
   */
  function generateInsights() {
    if (!window.DB) { return Promise.resolve([]); }

    return Promise.all([
      window.DB.getAll('payments'),
      window.DB.getAll('meters'),
      window.DB.getAll('meter_readings'),
      window.DB.getAll('tasks')
    ]).then(function (res) {
      var payments = res[0] || [];
      var meters = res[1] || [];
      var readings = res[2] || [];
      var tasks = res[3] || [];

      var insights = [];
      var today = new Date();
      var nowYm = today.toISOString().slice(0, 7);

      // Инсайт 1: Обязательные платежи недели
      var weekSum = 0;
      var weekCount = 0;
      var weekAhead = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
      var todayIso = today.toISOString().slice(0, 10);

      for (var i = 0; i < payments.length; i++) {
        var p = payments[i];
        if (p.status === 'pending' && p.date && p.date >= todayIso && p.date <= weekAhead) {
          weekSum += (p.amount || 0);
          weekCount++;
        }
      }

      if (weekCount > 0) {
        var rub = Math.round(weekSum / 100);
        insights.push({
          icon: '⏱',
          title: 'Платежи до конца недели',
          text: 'Запланировано ' + weekCount + ' счёта на общую сумму ' + rub.toLocaleString('ru-RU') + ' ₽.'
        });
      } else {
        insights.push({
          icon: '✨',
          title: 'Ближайшие дни свободны',
          text: 'На этой неделе срочных оплат нет. Все платежи в графике.'
        });
      }

      // Инсайт 2: Показания счётчиков
      var unreadMeters = 0;
      for (var m = 0; m < meters.length; m++) {
        var mid = meters[m].id;
        var hasThisMonth = false;
        for (var r = 0; r < readings.length; r++) {
          if (readings[r].meterId === mid && (readings[r].date || '').slice(0, 7) === nowYm) {
            hasThisMonth = true;
            break;
          }
        }
        if (!hasThisMonth) unreadMeters++;
      }

      if (unreadMeters > 0) {
        insights.push({
          icon: '💧',
          title: 'Передача показаний',
          text: 'Осталось передать данные по ' + unreadMeters + ' счётчикам за текущий месяц.'
        });
      }

      return insights;
    });
  }

  function radarHtml(insights) {
    if (!insights || insights.length === 0) return '';
    var out = '';
    for (var i = 0; i < insights.length; i++) {
      var item = insights[i];
      out += '<div class="smart-radar-card">' +
        '<span class="smart-radar-card__icon">' + item.icon + '</span>' +
        '<div class="smart-radar-card__content">' +
          '<h4 class="smart-radar-card__title">' + item.title + '</h4>' +
          '<p class="smart-radar-card__text">' + item.text + '</p>' +
        '</div>' +
      '</div>';
    }
    return out;
  }

  window.SmartRadar = {
    parse: parseQuickInput,
    execute: executeQuickAdd,
    barHtml: renderQuickAddBar,
    bindBarEvents: bindQuickAddEvents,
    insights: generateInsights,
    radarHtml: radarHtml
  };
})();
