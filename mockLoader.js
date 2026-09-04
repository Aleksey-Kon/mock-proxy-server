const fs = require('fs');
const path = require('path');

/**
 * Формат мок-файла (mocks/*.json):
 * {
 *   "method": "GET",              // HTTP метод (GET, POST, PUT, DELETE, PATCH...)
 *   "url": "/api/users/1",        // точный путь ИЛИ regexp-паттерн (см. ниже)
 *   "isRegex": false,             // true, если "url" нужно трактовать как регулярку
 *   "status": 200,                // код ответа (по умолчанию 200)
 *   "delay": 0,                   // искусственная задержка ответа в мс (опционально)
 *   "headers": { "X-Mock": "1" }, // дополнительные заголовки ответа (опционально)
 *   "payload": { ... }            // тело ответа, которое вернёт мок
 * }
 *
 * Примеры regexp: "url": "^/api/users/\\d+$", "isRegex": true
 */

function loadMocks(mocksDir) {
  const absDir = path.resolve(mocksDir);

  if (!fs.existsSync(absDir)) {
    console.warn(`[mock-loader] Папка с моками не найдена: ${absDir}`);
    return [];
  }

  const files = fs
    .readdirSync(absDir)
    .filter((f) => f.toLowerCase().endsWith('.json'));

  const mocks = [];

  for (const file of files) {
    const fullPath = path.join(absDir, file);
    try {
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const json = JSON.parse(raw);

      // Файл может содержать один мок-объект или массив моков
      const entries = Array.isArray(json) ? json : [json];

      for (const entry of entries) {
        if (!entry.url || !entry.method) {
          console.warn(
            `[mock-loader] Пропускаю невалидный мок в файле ${file}: нужны поля "method" и "url"`
          );
          continue;
        }

        mocks.push({
          method: String(entry.method).toUpperCase(),
          url: entry.url,
          isRegex: !!entry.isRegex,
          status: entry.status || 200,
          delay: entry.delay || 0,
          headers: entry.headers || {},
          payload: entry.payload !== undefined ? entry.payload : {},
          sourceFile: file,
        });
      }
    } catch (err) {
      console.error(`[mock-loader] Ошибка чтения ${file}:`, err.message);
    }
  }

  console.log(`[mock-loader] Загружено моков: ${mocks.length} из ${absDir}`);
  return mocks;
}

/**
 * Ищет подходящий мок под метод + путь запроса.
 * Поддерживает:
 *  - точное совпадение строки url
 *  - regexp совпадение, если isRegex === true
 *  - "*" в конце пути как простой wildcard (например "/api/users/*")
 */
function findMock(mocks, method, reqPath) {
  const upperMethod = method.toUpperCase();

  return mocks.find((mock) => {
    if (mock.method !== upperMethod) return false;

    if (mock.isRegex) {
      try {
        const re = new RegExp(mock.url);
        return re.test(reqPath);
      } catch {
        return false;
      }
    }

    if (mock.url.endsWith('*')) {
      const prefix = mock.url.slice(0, -1);
      return reqPath.startsWith(prefix);
    }

    return mock.url === reqPath;
  });
}

module.exports = { loadMocks, findMock };
