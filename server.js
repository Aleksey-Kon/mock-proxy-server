require('dotenv').config();

const http = require('http');
const https = require('https');
const { URL } = require('url');
const express = require('express');
const chokidar = require('chokidar');
const path = require('path');

const { loadMocks, findMock } = require('./mockLoader');

const PORT = process.env.PORT || 4000;
const BACKEND_URL = process.env.BACKEND_URL;
const MOCKS_DIR = process.env.MOCKS_DIR || './mocks';
const VERBOSE = String(process.env.VERBOSE || 'true') === 'true';

if (!BACKEND_URL) {
  console.error('❌ Не задан BACKEND_URL в .env — некуда проксировать реальные запросы.');
  process.exit(1);
}

const backendUrl = new URL(BACKEND_URL);
const backendClient = backendUrl.protocol === 'https:' ? https : http;

const app = express();

let mocks = loadMocks(MOCKS_DIR);

// Автоматическая перезагрузка моков при изменении файлов в папке (без рестарта сервера)
chokidar.watch(path.resolve(MOCKS_DIR)).on('all', (event) => {
  if (['add', 'change', 'unlink'].includes(event)) {
    if (VERBOSE) console.log(`[watch] Изменения в моках (${event}) — перечитываю...`);
    mocks = loadMocks(MOCKS_DIR);
  }
});

/**
 * Ручной прокси-запрос на реальный бэкенд.
 * Копирует ВСЕ оригинальные заголовки клиента как есть (без вмешательства
 * сторонних библиотек) и сырое тело запроса байт-в-байт.
 * Меняется только заголовок Host — это необходимо, чтобы бэкенд понял,
 * к какому домену идёт обращение (именно так ведёт себя реальный клиент
 * при прямом запросе к бэкенду).
 */
function forwardToBackend(req, res) {
  // Копируем все заголовки клиента без изменений
  const outgoingHeaders = { ...req.headers };

  // Host обязательно должен соответствовать реальному бэкенду
  outgoingHeaders.host = backendUrl.host;

  // Убираем заголовок, который иначе укажет мок-серверу держать соединение
  // с клиентом, а не с бэкендом (может путать некоторые reverse-proxy/CDN)
  delete outgoingHeaders['content-length']; // пересчитается автоматически по факту стрима
  if (req.headers['content-length']) {
    outgoingHeaders['content-length'] = req.headers['content-length'];
  }

  const options = {
    protocol: backendUrl.protocol,
    hostname: backendUrl.hostname,
    port: backendUrl.port || (backendUrl.protocol === 'https:' ? 443 : 80),
    path: req.originalUrl, // сохраняем путь + query string как есть
    method: req.method,
    headers: outgoingHeaders,
  };

  if (VERBOSE) {
    console.log(`\n[proxy] ${req.method} ${req.originalUrl} -> ${BACKEND_URL}${req.originalUrl}`);
    console.log('[proxy] Заголовки, отправляемые на бэкенд (как получены от клиента):');
    console.log(outgoingHeaders);
  }

  const proxyReq = backendClient.request(options, (proxyRes) => {
    if (VERBOSE) {
      console.log(`[proxy] Ответ бэкенда: ${proxyRes.statusCode} ${req.method} ${req.originalUrl}`);
    }
    // Пробрасываем статус и заголовки ответа бэкенда клиенту без изменений
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[proxy] Ошибка проксирования:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Bad Gateway', message: err.message });
    }
  });

  // Пробрасываем тело запроса клиента напрямую, без парсинга — байт-в-байт
  req.pipe(proxyReq);
}

// --- Мок-миддлвар: перехватывает запрос ДО прокси, если находит совпадение ---
app.use((req, res, next) => {
  const reqPath = req.path; // без query-строки
  const mock = findMock(mocks, req.method, reqPath);

  if (!mock) {
    // Совпадений нет — отдаём запрос дальше, в прокси
    return next();
  }

  if (VERBOSE) {
    console.log(
      `[mock] ${req.method} ${req.originalUrl} -> файл "${mock.sourceFile}" (status ${mock.status})`
    );
  }

  const send = () => {
    res.status(mock.status);
    for (const [key, value] of Object.entries(mock.headers)) {
      res.setHeader(key, value);
    }
    res.json(mock.payload);
  };

  if (mock.delay > 0) {
    setTimeout(send, mock.delay);
  } else {
    send();
  }
});

// Всё, что не замокано — уходит на реальный бэкенд через ручной прокси
app.use((req, res) => {
  forwardToBackend(req, res);
});

app.listen(PORT, () => {
  console.log(`\n🚀 Мок-сервер запущен: http://localhost:${PORT}`);
  console.log(`   Реальный бэкенд:   ${BACKEND_URL}`);
  console.log(`   Папка с моками:    ${path.resolve(MOCKS_DIR)}\n`);
});
