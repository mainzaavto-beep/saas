// lib/mpValidate.js — проверка ключей маркетплейса ДО сохранения.
//
// Проверяем не «жив ли ключ», а конкретные доступы, которые нужны сбору.
// Причина: у кабинета 1009 ключ Ozon валиден и авторизацию проходит, но не имеет
// роли для финансов — простая проверка «ответил ли API» пропустила бы его, и
// клиент остался бы с пустыми отчётами, считая виноватым сервис.
//
// Неизвестный ответ ВСЕГДА трактуется как «проверить не удалось» (сохраняем с
// предупреждением), а не как отказ: если маркетплейс поменяет формат ошибки, мы
// не должны переставать пускать клиентов с рабочими ключами.

export const DEFAULT_BASES = {
  wbCommon: 'https://common-api.wildberries.ru',
  wbStats: 'https://statistics-api.wildberries.ru',
  wbPrices: 'https://discounts-prices-api.wildberries.ru',
  ozonSeller: 'https://api-seller.ozon.ru',
  ozonPerf: 'https://api-performance.ozon.ru',
};

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

// Один запрос с таймаутом. Возвращает { status, body } либо { networkError: true }.
async function call(url, opts, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  } catch {
    return { networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

// Классификация ответа в один из трёх исходов.
// 'ok' — доступ есть; 'denied' — ключ/права не годятся; 'unknown' — судить нельзя.
function classify(r) {
  if (!r || r.networkError) return 'unknown';
  if (r.status === 200) return 'ok';
  // Ozon на неверный ключ отвечает 404 с code 5 в теле — по коду HTTP не понять.
  if (r.body && Number(r.body.code) === 5) return 'denied';
  if (r.status === 401 || r.status === 403) return 'denied';
  if (r.status === 429) return 'unknown';     // нас притормозили, ключ ни при чём
  if (r.status >= 500) return 'unknown';
  return 'unknown';
}

async function checkWb(creds, bases, timeoutMs) {
  const auth = { Authorization: String(creds.token || '') };
  const [ping, stats, prices] = await Promise.all([
    call(`${bases.wbCommon}/ping`, { headers: auth }, timeoutMs),
    call(`${bases.wbStats}/api/v1/supplier/orders?dateFrom=${yesterday()}&flag=1`, { headers: auth }, timeoutMs),
    call(`${bases.wbPrices}/api/v2/list/goods/filter?limit=1&offset=0`, { headers: auth }, timeoutMs),
  ]);
  return [
    { capability: 'token', fatal: true, verdict: classify(ping),
      message: 'Токен Wildberries не принят. Проверьте, что вы скопировали его целиком и он не отозван.' },
    { capability: 'stats', fatal: true, verdict: classify(stats),
      message: 'У токена нет доступа «Статистика» — без него не собрать заказы и продажи. Выпустите токен с этой категорией в личном кабинете Wildberries.' },
    { capability: 'prices', fatal: true, verdict: classify(prices),
      message: 'У токена нет доступа «Цены и скидки» — без него не собрать цены. Добавьте эту категорию токену в личном кабинете Wildberries.' },
  ];
}

async function checkOzon(creds, bases, timeoutMs) {
  const headers = {
    'Client-Id': String(creds.client_id || ''),
    'Api-Key': String(creds.api_key || ''),
    'Content-Type': 'application/json',
  };
  const day = yesterday();
  const calls = [
    call(`${bases.ozonSeller}/v3/product/list`,
      { method: 'POST', headers, body: JSON.stringify({ filter: {}, limit: 1 }) }, timeoutMs),
    call(`${bases.ozonSeller}/v3/finance/transaction/list`,
      { method: 'POST', headers, body: JSON.stringify({ filter: { date: { from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.000Z` } }, page: 1, page_size: 1 }) }, timeoutMs),
  ];
  const hasPerf = String(creds.perf_client_id || '').trim() && String(creds.perf_client_secret || '').trim();
  if (hasPerf) {
    calls.push(call(`${bases.ozonPerf}/api/client/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: creds.perf_client_id, client_secret: creds.perf_client_secret, grant_type: 'client_credentials' }),
    }, timeoutMs));
  }
  const [products, finance, perf] = await Promise.all(calls);
  const checks = [
    { capability: 'keys', fatal: true, verdict: classify(products),
      message: 'Ozon не принял пару Client-Id и Api-Key. Проверьте, что оба значения от одного магазина и ключ не удалён.' },
    { capability: 'finance', fatal: true, verdict: classify(finance),
      message: 'Ключ Ozon принят, но у него нет доступа к финансовым отчётам и заказам — именно из них считается прибыль. Включите нужные права ключу в личном кабинете Ozon и сохраните заново.' },
  ];
  if (hasPerf) {
    checks.push({ capability: 'ads', fatal: false, verdict: classify(perf),
      message: 'Рекламные ключи Ozon не подошли — реклама собираться не будет, остальные данные соберутся. Проверьте Performance Client-Id и Client-Secret.' });
  }
  return checks;
}

export async function validateShopCreds({ mpCode, creds, bases, timeoutMs = 10_000 }) {
  const b = { ...DEFAULT_BASES, ...(bases || {}) };
  const c = creds || {};
  let raw;
  if (mpCode === 'wb') raw = await checkWb(c, b, timeoutMs);
  else if (mpCode === 'ozon') raw = await checkOzon(c, b, timeoutMs);
  else return { ok: true, unreachable: false, checks: [] };   // сборщиков нет — проверять нечего

  const checks = raw.map((r) => ({
    capability: r.capability,
    ok: r.verdict === 'ok',
    fatal: r.fatal,
    message: r.verdict === 'ok' ? '' : r.message,
  }));
  const denied = raw.some((r) => r.fatal && r.verdict === 'denied');
  const unknownFatal = raw.some((r) => r.fatal && r.verdict === 'unknown');
  return {
    ok: !denied,                       // отказ только на распознанный отказ маркетплейса
    unreachable: !denied && unknownFatal,
    checks,
  };
}
