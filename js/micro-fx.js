/**
 * МОЙ ПОРЯДОК — Премиальные микро-анимации и физический отклик (Этап 12.11)
 *
 * 1. MicroFX.burst(target) — легковесный салют из микро-частиц (Canvas 2D, 0 КБ библиотек)
 *    при выполнении задачи или оплате счёта. Полностью удаляет canvas после завершения
 *    (480 мс), не оставляя лишних DOM-узлов.
 * 2. Интерактивный световой блик (Specular Glare) на карточках при касании/наведении.
 * 3. Полное соблюдение prefers-reduced-motion: reduce.
 *
 * Экспортирует window.MicroFX
 */

(function () {
  'use strict';

  var activeCanvas = null;
  var cleanupTimer = null;

  function isReducedMotion() {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  /**
   * Запускает микро-всплеск частиц из центра указанного элемента или координат.
   * @param {Element|{x: number, y: number}| null} target
   */
  function burst(target) {
    if (isReducedMotion()) { return; }

    var x = window.innerWidth / 2;
    var y = window.innerHeight / 2;

    if (target && typeof target.getBoundingClientRect === 'function') {
      var rect = target.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
      }
    } else if (target && typeof target.x === 'number' && typeof target.y === 'number') {
      x = target.x;
      y = target.y;
    }

    // Если предыдущий canvas ещё есть — удаляем сразу, чтобы не плодить узлы
    if (activeCanvas && activeCanvas.parentNode) {
      activeCanvas.parentNode.removeChild(activeCanvas);
      activeCanvas = null;
    }
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }

    var canvas = document.createElement('canvas');
    canvas.className = 'micro-fx-canvas';
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = window.innerWidth;
    var h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);
    activeCanvas = canvas;

    var ctx = canvas.getContext('2d');
    if (!ctx) {
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      activeCanvas = null;
      return;
    }
    ctx.scale(dpr, dpr);

    var primaryColor = '#2563EB';
    try {
      var cs = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim();
      if (cs) primaryColor = cs;
    } catch (e) { /* ignore */ }

    var palette = [primaryColor, '#10B981', '#F59E0B', '#8B5CF6', '#38BDF8'];
    var count = 20;
    var particles = [];

    for (var i = 0; i < count; i++) {
      var angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
      var speed = 2.2 + Math.random() * 4.2;
      particles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.4,
        size: 3 + Math.random() * 3.5,
        color: palette[i % palette.length],
        alpha: 1,
        shape: i % 3 === 0 ? 'diamond' : 'circle',
        rotation: Math.random() * Math.PI
      });
    }

    var start = performance.now();
    var duration = 440;

    function finish() {
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
      }
      if (canvas && canvas.parentNode) {
        canvas.parentNode.removeChild(canvas);
      }
      if (activeCanvas === canvas) {
        activeCanvas = null;
      }
    }

    cleanupTimer = setTimeout(finish, duration + 60);

    function frame(now) {
      if (activeCanvas !== canvas) { return; }
      var elapsed = now - start;
      if (elapsed >= duration) {
        finish();
        return;
      }

      var progress = elapsed / duration;
      ctx.clearRect(0, 0, w, h);

      for (var j = 0; j < particles.length; j++) {
        var p = particles[j];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.14; // лёгкая гравитация
        p.vx *= 0.96; // сопротивление воздуха
        p.alpha = Math.max(0, 1 - progress * progress);

        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.translate(p.x, p.y);

        if (p.shape === 'diamond') {
          ctx.rotate(p.rotation + progress * 2);
          var s = p.size;
          ctx.beginPath();
          ctx.moveTo(0, -s);
          ctx.lineTo(s, 0);
          ctx.lineTo(0, s);
          ctx.lineTo(-s, 0);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size * 0.65, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  function bindGlobalListeners() {
    // 1. Всплеск частиц при отметке чекбокса задачи
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains('task-checkbox') && t.checked) {
        burst(t.nextElementSibling || t);
      }
    }, true);

    // 2. Всплеск частиц при переводе платежа в «Оплачено»
    document.addEventListener('click', function (e) {
      if (!e.target || typeof e.target.closest !== 'function') return;

      var statusBtn = e.target.closest('[data-action="toggle-status"]');
      if (statusBtn && !statusBtn.classList.contains('status-toggle--paid')) {
        burst(statusBtn);
        return;
      }

      var gostPaidBtn = e.target.closest('[data-gost-action="mark-paid"]');
      if (gostPaidBtn) {
        burst(gostPaidBtn);
      }
    }, true);

    // 3. Мягкий интерактивный блик на карточках при наведении / касании
    document.addEventListener('pointermove', function (e) {
      if (isReducedMotion()) return;
      if (!e.target || typeof e.target.closest !== 'function') return;
      var card = e.target.closest('.card, .home-summary, .stats-card');
      if (!card) return;
      var rect = card.getBoundingClientRect();
      var x = Math.round(e.clientX - rect.left);
      var y = Math.round(e.clientY - rect.top);
      card.style.setProperty('--spot-x', x + 'px');
      card.style.setProperty('--spot-y', y + 'px');
    }, { passive: true });
  }

  bindGlobalListeners();

  window.MicroFX = {
    burst: burst,
    isReducedMotion: isReducedMotion
  };
})();
