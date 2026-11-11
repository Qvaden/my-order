/**
 * МОЙ ПОРЯДОК — Service Worker (Этап 10)
 *
 * Стратегия офлайна:
 *   - index.html:      network-first с фолбэком в кэш (свежие обновления
 *                      долетают, но офлайн страница всё равно открывается);
 *   - css/js/шрифты:   cache-first (после первой загрузки работают без сети);
 *   - VK Bridge SDK:   кэшируется как обычный скрипт — офлайн приложение
 *                      не падает без CDN;
 *   - навигация вне кэша: отдаём закешированный index.html (SPA-роутинг).
 *
 * Важно: IndexedDB Service Worker не затрагивает — у него нет доступа к
 * транзакциям страницы, поэтому локальные данные пользователя в безопасности.
 * Кэшируются только статические ресурсы (Cache API), никаких фоновых
 * запросов к API ВКонтакте отсюда не делается.
 *
 * Этап 12.6: здесь же обработчик клика по системному уведомлению. Само
 * уведомление показывает страница (js/push-manager.js через
 * registration.showNotification), а переход по клику возможен только отсюда,
 * потому что 'notificationclick' приходит только в SW.
 */

'use strict';

/**
 * @const {string} версия кэша — менять при релизе для принудительного сброса
 *
 * Этап 11: v10-1 → v11-1. Статика отдаётся по стратегии cache-first, поэтому
 * без нового имени пользователи остались бы на JS до фикса критических багов
 * №1 (самоизлечение соединения), №2 (потеря данных при импорте), №5 (искажение
 * дат) и №6 (стопка одинаковых диалогов). Смена имени приводит к install нового
 * SW и активации с удалением старого кэша (см. listener 'activate').
 *
 * Этап 12.6: v12-2 → v12-4 — добавлены js/notifications-prefs.js,
 * js/calendar-export.js, js/push-manager.js, js/quick-actions.js и правки в
 * index.html, css/styles.css, app-manifest.webmanifest. Без нового имени
 * скрипты этапа не скачались бы: стратегия cache-first отдаёт старый кэш, а
 * index.html уже ссылается на файлы, которых в том кэше нет.
 *
 * Правка главной: v12-4 → v12-5 — с css/styles.css и js/app.js. Кэш отдаёт
 * старые стили панели (иконки 40px, красная точка вместо статуса), поэтому
 * без нового имени экран остался бы в прежнем виде до жёсткой перезагрузки.
 */
var CACHE_NAME = 'myorder-v12-17';

/**
 * Core-файлы, обязательные для офлайн-работы.
 *
 * Сюда НЕ включены jsPDF (365 КБ), генератор QR (56 КБ) и кириллический
 * шрифт (25 КБ): они нужны только при первой PRO-операции. Загружать их
 * на install означало бы отдать ~450 КБ трафика в момент, когда пользователь
 * ещё смотрит на пустой экран, — это бьёт по Lighthouse. Вместо этого они
 * попадают в кэш через runtime cache-first (см. слушатель 'fetch'): первый
 * отчёт требует сети, все последующие работают офлайн.
 */
var PRECACHE_URLS = [
  './',
  'index.html',
  'app-manifest.webmanifest',
  'css/styles.css',
  'js/vendor/vk-bridge.min.js',
  'js/db.js',
  'js/lazy-loader.js',
  'js/vk-integration.js',
  'js/cloud-sync.js',
  'js/security.js',
  'js/pdf-exporter.js',
  'js/app.js',
  'js/payments.js',
  'js/meters.js',
  'js/documents.js',
  'js/tasks.js',
  'js/stats.js',
  'js/backup.js',
  'js/pro-manager.js',
  'js/notifications-prefs.js',
  'js/calendar-export.js',
  'js/push-manager.js',
  'js/quick-actions.js',
  'js/family-ui.js',
  'js/family.js',
  'js/personalization.js',
  'js/gost-qr.js',
  'js/pro-analytics-plus.js',
  'js/micro-fx.js',
  'js/value-pack.js'
];

/**
 * Этап 12.6: клик по системному напоминанию ведёт человека туда, где лежит
 * запись, а не просто поднимает приложение. Раздел пришит в data тегом
 * уведомления (см. js/push-manager.js), маршрут берём оттуда; неизвестный
 * тег — открываем главную.
 *
 * Показываем, а не перерисовываем: если вкладка уже открыта, фокусим её,
 * иначе раскрываем новый instance. Навигацию делает сама страница — она
 * услышит 'focus' и пересчитает сроки (см. bindVisibility в push-manager).
 */
self.addEventListener('notificationclick', function (event) {
  var data = event.notification && event.notification.data ? event.notification.data : {};
  var route = /^#(home|payments|meters|documents|tasks|stats|backup)$/.test(String(data.route || ''))
    ? String(data.route)
    : '#home';

  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (list) {
        for (var i = 0; i < list.length; i++) {
          if ('focus' in list[i]) {
            // Маршрут пишем через postMessage: у фоновой вкладки менять
            // location напрямую нельзя, а сообщение она примет гарантированно
            list[i].postMessage({ type: 'myorder:navigate', route: route });
            return list[i].focus();
          }
        }
        return self.clients.openWindow('./' + route);
      })
  );
});

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // ignoreMissing: приложение должно уметь ставиться, даже если один
      // фаил недоступен (например, CDN-фолбэк vk-bridge в локальной копии)
      return Promise.all(PRECACHE_URLS.map(function (url) {
        return cache.add(url).catch(function () { /* пропускаем отсутствующий */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) { return caches.delete(key); }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Кэшируем только GET — POST/PUT не перехватываем
  if (request.method !== 'GET') { return; }

  var url = new URL(request.url);

  // Этап 12.7: общий файл семьи — НЕ кэшируем никогда. Cache-first отдал бы
  // прошлую версию дампа, и «синхронизация» показывала бы несуществующие
  // данные; для обмена между людьми актуальность важнее офлайна.
  if (url.pathname.indexOf('/family/') === 0) { return; }

  // Сторонние запросы (VK, шрифты) не трогаем: bridge общается с клиентом
  // через postMessage, а не через fetch — их кэширование сломало бы CSP
  if (url.origin !== self.location.origin) { return; }

  // Навигация (HTML): network-first, офлайн — кэш
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put('index.html', copy); });
          return response;
        })
        .catch(function () {
          return caches.match('index.html').then(function (cached) {
            return cached || caches.match('./');
          });
        })
    );
    return;
  }

  // Статика: cache-first с дозагрузкой в кэш
  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) { return cached; }
      return fetch(request).then(function (response) {
        if (response && response.status === 200 && response.type === 'basic') {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      });
    })
  );
});
