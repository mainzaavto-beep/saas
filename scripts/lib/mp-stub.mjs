// scripts/lib/mp-stub.mjs — локальный сервер, изображающий API WB и Ozon.
// Нужен, чтобы проверять lib/mpValidate.js без настоящих ключей и без сети:
// формы ответов взяты с боевых API (проверено вживую 2026-08-08).
import http from 'node:http';

// Режимы: ok | bad_key | no_role | expired | down | slow
export function startStub(mode = 'ok', { slowMs = 30_000 } = {}) {
  const server = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (mode === 'slow') return;                    // ответа не будет вовсе
    if (mode === 'down') return json(503, { error: 'service unavailable' });
    if (mode === 'bad_key') {
      // Ozon на неверный ключ отвечает именно так: 404 + code 5 в теле.
      if (req.url.startsWith('/v3') || req.url.startsWith('/api/client/token')) {
        return json(404, { code: 5, message: 'Invalid Api-Key, please check the key and try again' });
      }
      return json(401, { title: 'unauthorized', detail: 'access token problem; token is malformed' });
    }
    if (mode === 'expired') {
      return json(401, { title: 'unauthorized', detail: 'access token problem; token expired' });
    }
    if (mode === 'no_role') {
      // Ключ валиден, но нужной роли нет — случай кабинета 1009.
      const needsRole = req.url.includes('finance') || req.url.includes('supplier/orders');
      if (needsRole) return json(403, { code: 7, message: 'Api-Key is missing a required role for a method' });
      return json(200, { result: { items: [] } });
    }
    return json(200, { result: { items: [] }, access_token: 'stub-token' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(r)) });
    });
  });
}
