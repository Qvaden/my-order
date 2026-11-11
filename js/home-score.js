/**
 * МОЙ ПОРЯДОК — Геймификация: Рейтинг «Идеальный хозяин» (Home Score & Achievements)
 *
 * Индекс порядка дома (0–100%), динамический ранг, серия месяцев (стрик)
 * и интерактивная коллекция медалей за образцовый порядок.
 *
 * Экспортирует window.HomeScore
 */

(function () {
  'use strict';

  var BADGES_DEF = [
    {
      id: 'bill_master',
      title: 'Гроза счетов',
      desc: 'Все обязательные платежи закрыты вовремя без задолженностей.',
      icon: '⚡'
    },
    {
      id: 'meter_keeper',
      title: 'Хранитель счётчиков',
      desc: 'Все показания воды, света и тепла переданы в срок.',
      icon: '💧'
    },
    {
      id: 'task_hero',
      title: 'Мастер порядка',
      desc: 'Ни одного просроченного домашнего дела.',
      icon: '🎯'
    },
    {
      id: 'safe_home',
      title: 'Мой дом — крепость',
      desc: 'Приложение надёжно защищено персональным PIN-кодом.',
      icon: '🛡️'
    },
    {
      id: 'pro_vip',
      title: 'Золотой хозяин',
      desc: 'Активен статус PRO с безграничными возможностями.',
      icon: '👑'
    }
  ];

  /**
   * Считает индекс порядка и состояние ачивок.
   * @returns {Promise<Object>}
   */
  function calculate() {
    if (!window.DB) {
      return Promise.resolve(fallbackResult());
    }

    var today = new Date();
    var nowYm = today.toISOString().slice(0, 7);
    var todayIso = today.toISOString().slice(0, 10);

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

      var deductions = 0;

      // 1. Платежи
      var overduePayments = 0;
      var pendingPayments = 0;
      for (var i = 0; i < payments.length; i++) {
        var p = payments[i];
        if (p.status === 'pending') {
          pendingPayments++;
          if (p.date && p.date < todayIso) {
            overduePayments++;
          }
        }
      }
      deductions += (overduePayments * 20);
      deductions += (pendingPayments * 4);

      // 2. Счётчики
      var unreadMeters = 0;
      for (var m = 0; m < meters.length; m++) {
        var mid = meters[m].id;
        var has = false;
        for (var r = 0; r < readings.length; r++) {
          if (readings[r].meterId === mid && (readings[r].date || '').slice(0, 7) === nowYm) {
            has = true; break;
          }
        }
        if (!has) unreadMeters++;
      }
      deductions += (unreadMeters * 15);

      // 3. Задачи
      var overdueTasks = 0;
      for (var t = 0; t < tasks.length; t++) {
        var task = tasks[t];
        if (!task.completed && !task.archived && task.dueDate && task.dueDate < todayIso) {
          overdueTasks++;
        }
      }
      deductions += (overdueTasks * 10);

      var score = Math.max(15, Math.min(100, 100 - deductions));

      // Если в базе совсем пусто — ставим дружелюбные 95%
      if (payments.length === 0 && tasks.length === 0) {
        score = 95;
      }

      var isPin = Boolean(window.Security && window.Security.isPinSet && window.Security.isPinSet());
      var isPro = Boolean(window.ProManager && window.ProManager.isPro && window.ProManager.isPro());

      var badges = BADGES_DEF.map(function (b) {
        var unlocked = false;
        if (b.id === 'bill_master') unlocked = (overduePayments === 0 && payments.length > 0);
        if (b.id === 'meter_keeper') unlocked = (unreadMeters === 0 && meters.length > 0);
        if (b.id === 'task_hero') unlocked = (overdueTasks === 0 && tasks.length > 0);
        if (b.id === 'safe_home') unlocked = isPin;
        if (b.id === 'pro_vip') unlocked = isPro;
        return Object.assign({}, b, { unlocked: unlocked });
      });

      var rank = 'Идеальный порядок';
      var rankIcon = '🏆';
      if (score < 50) {
        rank = 'Требует внимания';
        rankIcon = '⚡';
      } else if (score < 75) {
        rank = 'Порядок наводится';
        rankIcon = '🌱';
      } else if (score < 90) {
        rank = 'Домашний мастер';
        rankIcon = '⭐';
      }

      var streakMonths = 1;
      try {
        var savedStreak = parseInt(localStorage.getItem('myorder_streak_months') || '1', 10);
        streakMonths = Math.max(1, savedStreak);
      } catch (e) {}

      return {
        score: score,
        rank: rank,
        rankIcon: rankIcon,
        streakMonths: streakMonths,
        badges: badges,
        unlockedCount: badges.filter(function (x) { return x.unlocked; }).length
      };
    });
  }

  function fallbackResult() {
    return {
      score: 100,
      rank: 'Идеальный порядок',
      rankIcon: '🏆',
      streakMonths: 1,
      badges: BADGES_DEF.map(function (b) { return Object.assign({}, b, { unlocked: false }); }),
      unlockedCount: 0
    };
  }

  /**
   * HTML плашки рейтинга для Bento-виджета.
   */
  function scoreBadgeHtml(data) {
    if (!data) return '';
    return '<button type="button" class="home-score-pill" id="home-score-trigger" ' +
      'aria-label="Индекс порядка дома: ' + data.score + '%. Нажмите для просмотра наград.">' +
      '<span class="home-score-pill__icon">' + data.rankIcon + '</span>' +
      '<span class="home-score-pill__score">' + data.score + '%</span>' +
      '<span class="home-score-pill__streak">🔥 ' + data.streakMonths + ' мес.</span>' +
      '<span class="home-score-pill__medals">🎖️ ' + data.unlockedCount + '/' + data.badges.length + '</span>' +
    '</button>';
  }

  /**
   * Модальное окно ачивок.
   */
  function openAchievementsModal() {
    calculate().then(function (data) {
      try {
        if (window.VK && window.VK.taptic) {
          window.VK.taptic('impact', 'light');
        }
      } catch (e) {}

      var listHtml = data.badges.map(function (b) {
        var un = b.unlocked;
        return '<div class="achievement-card' + (un ? ' is-unlocked' : ' is-locked') + '">' +
          '<div class="achievement-card__icon">' + b.icon + '</div>' +
          '<div class="achievement-card__content">' +
            '<div class="achievement-card__header">' +
              '<h4 class="achievement-card__title">' + b.title + '</h4>' +
              '<span class="achievement-card__badge">' + (un ? 'Получено' : 'В процессе') + '</span>' +
            '</div>' +
            '<p class="achievement-card__desc">' + b.desc + '</p>' +
          '</div>' +
        '</div>';
      }).join('');

      var html = '<div class="modal-overlay" id="achievements-modal">' +
        '<div class="modal-card modal-card--glass" role="dialog" aria-modal="true" style="max-width:440px;">' +
          '<div class="modal-header">' +
            '<h3 class="modal-title">' + data.rankIcon + ' Индекс порядка: ' + data.score + '%</h3>' +
            '<button type="button" class="modal-close" data-action="close" aria-label="Закрыть">&times;</button>' +
          '</div>' +
          '<div class="modal-body">' +
            '<div class="achievement-hero">' +
              '<div class="achievement-hero__ring">' +
                '<span class="achievement-hero__val">' + data.score + '%</span>' +
              '</div>' +
              '<div class="achievement-hero__info">' +
                '<strong>' + data.rank + '</strong>' +
                '<small>Серия образцового дома: ' + data.streakMonths + ' месяц подряд 🔥</small>' +
              '</div>' +
            '</div>' +
            '<h4 style="font-size:13px;font-weight:700;margin:16px 0 10px 0;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;">Коллекция наград</h4>' +
            '<div class="achievement-list">' + listHtml + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

      var div = document.createElement('div');
      div.innerHTML = html;
      var modal = div.firstElementChild;
      document.body.appendChild(modal);

      function closeModal() {
        modal.classList.add('modal-overlay--closing');
        setTimeout(function () {
          if (modal.parentNode) modal.parentNode.removeChild(modal);
        }, 200);
      }

      modal.addEventListener('click', function (e) {
        if (e.target === modal || e.target.closest('[data-action="close"]')) {
          closeModal();
        }
      });
    });
  }

  // Привязка клика по бейджу рейтинга
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest('#home-score-trigger')) {
      openAchievementsModal();
    }
  });

  window.HomeScore = {
    calculate: calculate,
    badgeHtml: scoreBadgeHtml,
    openModal: openAchievementsModal
  };
})();
