/**
 * Локальный статический сервер для разработки и e2e-тестов.
 *
 * Сжатие по Accept-Encoding — не украшение, а условие честного замера:
 * без него Lighthouse на мобильном тарифе (1,6 Мбит/с) считает 607 КБ
 * как реальный трафик и получает FCP ~4,8 с вместо ~1,7 с. Любое
 * боевое окружение (VK Pages, nginx, CDN) отдаёт gzip/brotli, поэтому
 * дев-сервер обязан вести себя так же, иначе метрики и оптимизации
 * проверяются на профили, которых в реальности не бывает.
 *
 * Сжатые тела кэшируются в памяти по (путь + mtime + размер): на диске
 * лежит один и тот же файл, а пересобирать gzip на каждый запрос —
 * лишние миллисекунды в каждом прогоне тестов.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const rootDir = __dirname;
const port = 8080;

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

/**
 * Сжимать имеет смысл текст: картинки и шрифты уже упакованы самим
 * форматом, а попытка gzip для них только жжёт CPU.
 */
const COMPRESSIBLE = new Set([
  'text/html', 'text/css', 'application/javascript',
  'application/json', 'application/manifest+json', 'image/svg+xml'
]);

/** @type {Map<string, {key: string, gzip: Buffer, br: Buffer|null}>} */
const compressedCache = new Map();

/**
 * Возвращает сжатые варианты файла или null, если сжатие не нужно.
 * @param {string} filePath
 * @param {string} contentType
 * @param {Buffer} raw
 */
function getCompressedVariants(filePath, contentType, raw) {
  if (!COMPRESSIBLE.has(contentType) || raw.length < 1024) { return null; }

  const stat = fs.statSync(filePath);
  const key = stat.mtimeMs + ':' + stat.size;
  const cached = compressedCache.get(filePath);
  if (cached && cached.key === key) { return cached; }

  const entry = {
    key: key,
    // level 9: файлы меняются редко, а выигрыш в 10–15% на мобильной
    // сети стоит одной секунды сборки
    gzip: zlib.gzipSync(raw, { level: 9 }),
    br: zlib.brotliCompressSync ? zlib.brotliCompressSync(raw) : null
  };

  // Файлы одинакового размера, но разного содержимого (rebuild) — редкость;
  // ключ по mtime покрывает и этот случай
  compressedCache.set(filePath, entry);
  return entry;
}

/**
 * Выбирает кодировку по тому, что принял клиент. Brotli выигрывает ~15%
 * и его понимает весь Chromium/Firefox последних версий.
 * @param {http.IncomingMessage} req
 * @param {{gzip: Buffer, br: Buffer|null}} variants
 */
function pickEncoding(req, variants) {
  const accept = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (variants.br && accept.indexOf('br') !== -1) { return 'br'; }
  if (accept.indexOf('gzip') !== -1) { return 'gzip'; }
  return null;
}

/**
 * Этап 12.7: подменный канал общего файла семьи.
 *
 * Зачем он дев-серверу. Семейная синхронизация в бою идёт через File System
 * Access API: человек один раз выбирает файл в облачной папке. Этот диалог
 * нельзя пройти из автотеста (браузер требует жеста), поэтому multi-user
 * сценарий — «два пользователя, два браузера, один общий файл» — был бы
 * непроверяем. Здесь тот же контракт (прочитать/записать JSON по ключу семьи),
 * но транспортом служит localhost-хранилище.
 *
 * Границы: работает только на localhost (проверяется по Host) и только для
 * PUT/GET по пути /family/<key>. Боевое приложение этот код не содержит —
 * Family.transportRead/Write выбирают канал по hostname, и вне localhost
 * остаются только FSAA и VK Storage.
 */
const FAMILY_PREFIX = '/family/';

/** Тела общих файлов лежат на диске: два браузера должны видеть одно и то же. */
const familyDir = path.join(rootDir, '.dev-family');

/** Ключ семьи — uuid; принимаем только такой формат, чтобы путь остался безвредным. */
const FAMILY_KEY_RE = /^[0-9a-fA-F-]{8,64}$/;

function familyReply(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * Обработка /family/<key>. Возвращает true, если запрос наш и ответ готов.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} url — путь без query и hash
 * @returns {boolean}
 */
function handleFamily(req, res, url) {
  if (url.indexOf(FAMILY_PREFIX) !== 0) { return false; }

  const host = String(req.headers.host || '');
  if (!/^(localhost|127\.0\.0\.1)(:[0-9]+)?$/.test(host)) {
    familyReply(res, 403, 'Forbidden');
    return true;
  }

  const key = decodeURIComponent(url.slice(FAMILY_PREFIX.length));
  if (!FAMILY_KEY_RE.test(key)) {
    familyReply(res, 400, 'Bad key');
    return true;
  }

  const file = path.join(familyDir, key + '.json');

  if (req.method === 'GET' || req.method === 'HEAD') {
    try {
      familyReply(res, 200, fs.readFileSync(file));
    } catch (e) {
      familyReply(res, 204, '');
    }
    return true;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // Общий файл — снимок данных семьи; гигабайт в память брать не будем
      if (size > 8 * 1024 * 1024) { req.destroy(); }
      else { chunks.push(c); }
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      try {
        JSON.parse(body.toString('utf8'));
      } catch (e) {
        familyReply(res, 400, JSON.stringify({ error: 'не JSON' }));
        return;
      }
      try {
        fs.mkdirSync(familyDir, { recursive: true });
        // Запись через временный файл: читатель не должен увидеть половину тела
        const tmp = file + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, file);
        familyReply(res, 200, JSON.stringify({ ok: true, bytes: body.length }));
      } catch (e) {
        familyReply(res, 500, JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return true;
  }

  familyReply(res, 405, 'Method not allowed', 'text/plain');
  return true;
}

const server = http.createServer((req, res) => {
  // Этап 10: отрезаем query-строку и hash. Внутри ВКонтакте запрос приходит
  // вида /?vk_app_id=...&vk_user_id=...&vk_color_scheme=..., и без этой
  // нормализации сервер искал бы файл с именем «/?vk_app_id=...» → 404.
  let url = req.url.split('?')[0].split('#')[0];
  if (url === '/' || url === '') { url = '/index.html'; }

  if (handleFamily(req, res, url)) { return; }

  const filePath = path.join(rootDir, url);

  // Защита от выхода за пределы проекта («/../» в пути)
  if (!filePath.startsWith(rootDir + path.sep) && filePath !== rootDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
    if (stat.isDirectory()) { throw new Error('directory'); }
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const raw = fs.readFileSync(filePath);

  const headers = {
    'Content-Type': contentType,
    // Кэш «до переменной версии»: в проде это дал бы вечный immutable +
    // новое имя файла, но здесь SW — единственный источник обновлений,
    // и кэшировать надолго нельзя
    'Cache-Control': 'no-cache',
    'Vary': 'Accept-Encoding'
  };

  const variants = getCompressedVariants(filePath, contentType, raw);
  const encoding = variants ? pickEncoding(req, variants) : null;

  if (encoding === 'br') {
    headers['Content-Encoding'] = 'br';
    headers['Content-Length'] = variants.br.length;
  } else if (encoding === 'gzip') {
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = variants.gzip.length;
  } else {
    headers['Content-Length'] = raw.length;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  res.end(encoding === 'br' ? variants.br : (encoding === 'gzip' ? variants.gzip : raw));
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}/`);
  console.log('Сжатие: brotli при Accept-Encoding: br, иначе gzip');
});
