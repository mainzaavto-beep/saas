# Онбординг нового клиента — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Клиент, пришедший с ключами маркетплейса, за десять минут доходит до своих цифр и на каждом шаге понимает, что происходит.

**Architecture:** Проверка ключей — отдельный чистый модуль `lib/mpValidate.js` с настраиваемыми базовыми адресами (проверяется против локальной заглушки, без настоящих ключей); он подключается в обработчике магазинов. Скорость первого сбора решается расписанием systemd, а не кодом. Индикатор загрузки и экран подтверждения почты — существующие механизмы баннеров и токенов, новых таблиц нет.

**Tech Stack:** Next.js 14 App Router (route handlers, server components), PostgreSQL с RLS через `lib/withCabinet.js`, systemd-таймеры, nodemailer, смоуки на чистом Node.

## Global Constraints

- Весь текст интерфейса и ошибок — по-русски, обращение на «вы», без технического жаргона в клиентских сообщениях (не «HTTP 403», а что делать).
- **Никогда не запускать `next dev` в этом каталоге** — dev-режим затирает боевую сборку в `.next/`, и следующий рестарт `saas-web` падает. Проверка только через `npm run build` и работающий `saas-web` на `http://127.0.0.1:3200`.
- После правок `.js` в `app/` или `lib/`: `npm run build && systemctl restart saas-web`.
- Запись в боевую БД идёт только через `tenantQuery` (RLS) внутри `withCabinet` либо через `query` из `lib/db.js` для не-тенантных таблиц; прямой SQL в обход не добавлять.
- Смоуки запускать так: `PGPASSFILE=/root/.pgpass-admin node scripts/<имя>.mjs http://127.0.0.1:3200`. Между повторными прогонами `smoke-auth-phase4` нужна пауза ≥65 с — иначе упрётесь в собственный лимит входов (смоук бьёт мимо Caddy, и все запросы приходят с одного «IP»).
- Адреса на доменах `.test/.invalid/.example/.localhost` в SMTP не уходят никогда (`lib/mailer.js`) — смоуки читают письма из `/tmp/saas-mail/`.
- Никаких новых зависимостей: HTTP-запросы — встроенный `fetch`, заглушка — встроенный `node:http`.
- Таймауты сетевых вызовов задаются явно; ни один запрос к маркетплейсу не должен висеть дольше 10 секунд.
- `BACKFILL_DAYS = 75` и `MAX_SHOPS_PER_CABINET = 4` берутся из `lib/mpConfig.js`, не дублировать числа.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `lib/mpValidate.js` (создать) | Чистая проверка кредов WB/Ozon. Знает про адреса маркетплейсов и формы их ошибок. Не знает про HTTP-обработчики, сессии и базу. |
| `scripts/lib/mp-stub.mjs` (создать) | Локальный http-сервер, изображающий WB и Ozon в шести режимах. Используется только тестами. |
| `scripts/check-mp-validate.mjs` (создать) | Прогон `lib/mpValidate.js` против заглушки. Без сети и без настоящих ключей. |
| `app/api/cabinets/[id]/shops/route.js` (правка) | Вызывает проверку до сохранения; отказ 422, недоступность маркетплейса — сохранение с предупреждением. |
| `deploy/systemd/saas-backfill.timer` (правка) | Разбор очереди раз в 5 минут вместо четырёх слотов в сутки. |
| `app/api/cabinets/[id]/onboarding-status/route.js` (создать) | Отдаёт, идёт ли первичная загрузка для кабинета. |
| `app/cabinets/[id]/layout.js` (правка) | Полоса «идёт загрузка» + старшинство над баннером сломанных ключей. |
| `app/cabinets/[id]/LoadingBanner.jsx` (создать) | Клиентский опрос статуса раз в 30 с, убирает полосу без перезагрузки страницы. |
| `app/verify-pending/page.js` + `VerifyPendingPage.jsx` (создать) | Экран «мы отправили письмо»: переотправка, смена адреса, автопереход. |
| `app/api/auth/email/route.js` (создать) | Смена неподтверждённого адреса + повторное письмо. |
| `app/api/auth/verify/status/route.js` (создать) | Лёгкий ответ «подтверждён ли адрес» для автоперехода. |
| `app/api/auth/register/route.js` (правка) | `next` ведёт на `/verify-pending`, а не на `/onboarding`. |
| `app/onboarding/page.js` (правка) | Неподтверждённого клиента отправляет на `/verify-pending`. |
| `scripts/smoke-onboarding.mjs` (создать) | Сквозной смоук нового пути регистрации. |

---

### Task 1: Модуль проверки ключей и заглушка маркетплейсов

**Files:**
- Create: `lib/mpValidate.js`
- Create: `scripts/lib/mp-stub.mjs`
- Create: `scripts/check-mp-validate.mjs`

**Interfaces:**
- Consumes: ничего из других задач.
- Produces: `validateShopCreds({ mpCode, creds, bases })` → `Promise<{ ok: boolean, unreachable: boolean, checks: Array<{ capability: string, ok: boolean, fatal: boolean, message: string }> }>`. `ok === true` означает «сохранять можно»; `unreachable === true` — «сохранить, но предупредить». Задача 2 использует только эту функцию.

- [ ] **Step 1: Написать заглушку маркетплейсов**

Создать `scripts/lib/mp-stub.mjs`:

```js
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
```

- [ ] **Step 2: Написать проверку, которая падает (модуля ещё нет)**

Создать `scripts/check-mp-validate.mjs`:

```js
// scripts/check-mp-validate.mjs — проверка lib/mpValidate.js против заглушки.
// Настоящие ключи и сеть не нужны: адреса маркетплейсов подменяются.
import { startStub } from './lib/mp-stub.mjs';
import { validateShopCreds } from '../lib/mpValidate.js';

let failed = 0;
const check = (name, cond, got = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${got}`}`);
  if (!cond) failed++;
};

const basesFor = (base) => ({
  wbCommon: base, wbStats: base, wbPrices: base, ozonSeller: base, ozonPerf: base,
});

// 1. Всё хорошо — сохраняем.
{
  const s = await startStub('ok');
  const r = await validateShopCreds({ mpCode: 'ozon', creds: { client_id: '1', api_key: 'k' }, bases: basesFor(s.base) });
  check('ozon, рабочие ключи: ok', r.ok === true && r.unreachable === false, JSON.stringify(r));
  await s.stop();
}

// 2. Неверный ключ Ozon — отказ, в тексте сказано про ключ.
{
  const s = await startStub('bad_key');
  const r = await validateShopCreds({ mpCode: 'ozon', creds: { client_id: '1', api_key: 'k' }, bases: basesFor(s.base) });
  const msg = r.checks.filter((c) => !c.ok).map((c) => c.message).join(' ');
  check('ozon, неверный ключ: отказ', r.ok === false && r.unreachable === false, JSON.stringify(r));
  check('ozon, неверный ключ: текст про ключ', /ключ/i.test(msg), msg);
}

// 3. Нет нужной роли (случай 1009) — отказ, в тексте сказано про доступ/роль.
{
  const s = await startStub('no_role');
  const r = await validateShopCreds({ mpCode: 'ozon', creds: { client_id: '1', api_key: 'k' }, bases: basesFor(s.base) });
  const msg = r.checks.filter((c) => !c.ok).map((c) => c.message).join(' ');
  check('ozon, нет роли: отказ', r.ok === false, JSON.stringify(r));
  check('ozon, нет роли: текст про доступ', /доступ|роль/i.test(msg), msg);
  await s.stop();
}

// 4. Просроченный токен WB — отказ.
{
  const s = await startStub('expired');
  const r = await validateShopCreds({ mpCode: 'wb', creds: { token: 't' }, bases: basesFor(s.base) });
  check('wb, просроченный токен: отказ', r.ok === false && r.unreachable === false, JSON.stringify(r));
  await s.stop();
}

// 5. Маркетплейс лежит — сохраняем с предупреждением, НЕ отказ.
{
  const s = await startStub('down');
  const r = await validateShopCreds({ mpCode: 'wb', creds: { token: 't' }, bases: basesFor(s.base) });
  check('wb, маркетплейс лежит: сохранить с предупреждением', r.ok === true && r.unreachable === true, JSON.stringify(r));
  await s.stop();
}

// 6. Таймаут — тоже предупреждение, и укладываемся в бюджет.
{
  const s = await startStub('slow');
  const t0 = Date.now();
  const r = await validateShopCreds({ mpCode: 'wb', creds: { token: 't' }, bases: basesFor(s.base), timeoutMs: 1000 });
  const spent = Date.now() - t0;
  check('wb, таймаут: сохранить с предупреждением', r.ok === true && r.unreachable === true, JSON.stringify(r));
  check('wb, таймаут: уложились в бюджет', spent < 4000, `${spent}мс`);
  await s.stop();
}

// 7. Рекламные креды Ozon необязательные: их отказ не блокирует сохранение.
{
  const s = await startStub('ok');
  const r = await validateShopCreds({
    mpCode: 'ozon',
    creds: { client_id: '1', api_key: 'k', perf_client_id: 'p', perf_client_secret: 's' },
    bases: { ...basesFor(s.base), ozonPerf: 'http://127.0.0.1:1' },  // порт закрыт
  });
  check('ozon, реклама не проверилась: всё равно сохраняем', r.ok === true, JSON.stringify(r));
  check('ozon, реклама: предупреждение отдельной строкой',
    r.checks.some((c) => c.capability === 'ads' && !c.ok && c.fatal === false), JSON.stringify(r.checks));
  await s.stop();
}

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Запустить и убедиться, что падает**

Run: `cd /opt/agents/saas && node scripts/check-mp-validate.mjs`
Expected: FAIL — `Cannot find module '../lib/mpValidate.js'`.

- [ ] **Step 4: Написать модуль проверки**

Создать `lib/mpValidate.js`:

```js
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
```

- [ ] **Step 5: Запустить проверку — должна пройти**

Run: `cd /opt/agents/saas && node scripts/check-mp-validate.mjs`
Expected: `ALL PASS`, код выхода 0.

- [ ] **Step 6: Коммит**

```bash
git add lib/mpValidate.js scripts/lib/mp-stub.mjs scripts/check-mp-validate.mjs
git commit -m "feat(mp): модуль проверки ключей маркетплейса + проверка против заглушки"
```

---

### Task 2: Проверка ключей при сохранении магазина

**Files:**
- Modify: `app/api/cabinets/[id]/shops/route.js:58-121` (POST) и `:135-186` (PUT)
- Modify: `lib/rate-limit.js:9-14` (добавить лимит)

**Interfaces:**
- Consumes: `validateShopCreds({ mpCode, creds, bases })` из Task 1.
- Produces: контракт ответов, на который опираются Task 6 и клиентские формы:
  - отказ — HTTP 422, тело `{ error: string, code: 'mp_creds_invalid', checks: [{ capability, ok, fatal, message }] }`;
  - сохранение с предупреждением — HTTP 200, тело `{ ok: true, shop_id?, warning: string }`.

- [ ] **Step 1: Добавить лимит проверок**

В `lib/rate-limit.js`, в объект `LIMITS` после строки `onboardUser`:

```js
  shopSaveUser: Number(process.env.SAAS_RL_SHOP_SAVE_USER) || 10,  // сохранений магазина в минуту на пользователя
```

- [ ] **Step 2: Подключить проверку в POST**

В `app/api/cabinets/[id]/shops/route.js` добавить импорты к существующим:

```js
import { validateShopCreds } from '@/lib/mpValidate.js';
import { hit } from '@/lib/rate-limit.js';
```

В обработчике `POST`, сразу после проверки лимита магазинов (после блока с `MAX_SHOPS_PER_CABINET`, строка ~75) и ДО шифрования кредов, вставить:

```js
  // Проверяем ключи до сохранения: молча принятый нерабочий ключ оборачивается
  // пустыми отчётами через несколько часов, и виноватым выглядит сервис.
  // Форма проверки — сохранение магазина, поэтому лимит на пользователя: иначе
  // это бесплатный перебор чужих ключей нашими руками.
  const rl = hit(`shop-save:user:${session.user_id}`, LIMITS.shopSaveUser);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Слишком много попыток. Подождите минуту.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter || 60) } }
    );
  }
  let credsWarning = null;
  const credsForCheck = b.api_creds?.[b.mp_code];
  if (credsForCheck && Object.keys(credsForCheck).length > 0) {
    const v = await validateShopCreds({ mpCode: b.mp_code, creds: credsForCheck });
    if (!v.ok) {
      const problems = v.checks.filter((c) => !c.ok && c.fatal);
      return NextResponse.json(
        { error: problems.map((c) => c.message).join(' '), code: 'mp_creds_invalid', checks: v.checks },
        { status: 422 }
      );
    }
    if (v.unreachable) {
      credsWarning = 'Проверить ключи сейчас не удалось — маркетплейс не отвечает. Мы сохранили их и попробуем собрать данные; если ключи неверны, вы увидите это в течение часа.';
    } else {
      const soft = v.checks.filter((c) => !c.ok && !c.fatal);
      if (soft.length) credsWarning = soft.map((c) => c.message).join(' ');
    }
  }
```

Заменить возврат в конце `POST` (строка ~120):

```js
  return NextResponse.json({ ok: true, shop_id: rows[0]?.shop_id, warning: credsWarning });
```

Импорт `LIMITS` добавить в ту же строку, что и `hit`:

```js
import { hit, LIMITS } from '@/lib/rate-limit.js';
```

`session` в обработчике доступен через второй аргумент `withCabinet` — проверить его имя в сигнатуре (`async (req, { cabinet, session })`) и при необходимости добавить `session` в деструктуризацию.

- [ ] **Step 3: Подключить проверку в PUT**

В обработчике `PUT`, внутри блока `if (b.api_creds) {`, ПЕРЕД шифрованием (перед строкой с `pgp_sym_encrypt`) вставить тот же лимит и проверку. Код кредов берётся из `mp_code` магазина, которого в теле нет, — прочитать его:

```js
    const shopRows = await tenantQuery(
      `SELECT mp_code FROM auth.shops WHERE shop_id = $1 AND cabinet_id = $2`,
      [Number(b.shop_id), cabinet.cabinet_id]
    );
    if (!shopRows.length) return NextResponse.json({ error: 'Магазин не найден' }, { status: 404 });
    const mpCode = shopRows[0].mp_code;
    const rl = hit(`shop-save:user:${session.user_id}`, LIMITS.shopSaveUser);
    if (rl.limited) {
      return NextResponse.json(
        { error: 'Слишком много попыток. Подождите минуту.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfter || 60) } }
      );
    }
    const credsForCheck = b.api_creds?.[mpCode];
    if (credsForCheck && Object.keys(credsForCheck).length > 0) {
      const v = await validateShopCreds({ mpCode, creds: credsForCheck });
      if (!v.ok) {
        const problems = v.checks.filter((c) => !c.ok && c.fatal);
        return NextResponse.json(
          { error: problems.map((c) => c.message).join(' '), code: 'mp_creds_invalid', checks: v.checks },
          { status: 422 }
        );
      }
      if (v.unreachable) {
        putWarning = 'Проверить ключи сейчас не удалось — маркетплейс не отвечает. Мы сохранили их и попробуем собрать данные.';
      }
    }
```

Объявить `let putWarning = null;` рядом с `const sets = [];` и вернуть его в ответе:

```js
  return NextResponse.json({ ok: true, warning: putWarning });
```

- [ ] **Step 4: Собрать и перезапустить**

Run: `cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 4 && systemctl is-active saas-web`
Expected: `active`.

- [ ] **Step 5: Проверить отказ на заведомо мусорных ключах**

Проверка вручную curl'ом требует сессии владельца, поэтому проверяем через существующий смоук + отдельный ручной прогон. Сначала регресс:

Run: `cd /opt/agents/saas && PGPASSFILE=/root/.pgpass-admin node scripts/smoke-auth-phase3.mjs http://127.0.0.1:3200`
Expected: `ALL PASS` — гейт подтверждения почты на `POST /shops` срабатывает РАНЬШЕ проверки ключей (запрос к маркетплейсу не делается вовсе).

- [ ] **Step 6: Проверить, что живой магазин с рабочими ключами сохраняется**

Взять рабочие ключи кабинета 1 (WB) из боевой базы нельзя — они зашифрованы и доставать их незачем. Вместо этого проверяем модуль на боевых адресах с заведомо мусорным ключом: он обязан дать отказ, а не «недоступен».

Run:
```bash
cd /opt/agents/saas && node -e "
import('./lib/mpValidate.js').then(async (m) => {
  const r = await m.validateShopCreds({ mpCode: 'wb', creds: { token: 'garbage' } });
  console.log(JSON.stringify({ ok: r.ok, unreachable: r.unreachable }, null, 1));
});"
```
Expected: `{"ok": false, "unreachable": false}` — настоящий WB отвечает 401 на мусорный токен, значит классификация работает на боевом API, а не только на заглушке.

- [ ] **Step 7: Коммит**

```bash
git add app/api/cabinets/\[id\]/shops/route.js lib/rate-limit.js
git commit -m "feat(shops): ключи проверяются до сохранения; авария маркетплейса не блокирует"
```

---

### Task 3: Очередь разбирается каждые 5 минут

**Files:**
- Modify: `deploy/systemd/saas-backfill.timer`

**Interfaces:**
- Consumes: ничего.
- Produces: ничего для кода; меняется только расписание.

- [ ] **Step 1: Заменить расписание**

В `deploy/systemd/saas-backfill.timer` четыре строки `OnCalendar=` заменить на одну:

```ini
OnCalendar=*:0/5
```

Комментарий над ней:

```ini
# Раз в 5 минут: клиент, только что подключивший ключи, должен увидеть данные за
# минуты, а не ждать до 3,5 часов следующего слота. Холостой прогон при пустой
# очереди — один запрос к БД и выход, сетевых обращений нет. Второй экземпляр
# юнита systemd не запустит, пока работает первый, поэтому долгий backfill
# наложений не создаёт.
```

- [ ] **Step 2: Установить и перезапустить таймер**

Run:
```bash
cd /opt/agents/saas && cp deploy/systemd/saas-backfill.timer /etc/systemd/system/ && \
systemctl daemon-reload && systemctl restart saas-backfill.timer && \
systemctl list-timers saas-backfill.timer --no-pager
```
Expected: следующий запуск — в пределах 5 минут.

- [ ] **Step 3: Убедиться, что холостой прогон дёшев и безвреден**

Run: `systemctl start saas-backfill.service && systemctl show saas-backfill.service -p ExecMainStatus --value && journalctl -u saas-backfill.service -n 5 --no-pager`
Expected: `ExecMainStatus=0`, в логе — обработка пустой очереди без обращений к маркетплейсам.

- [ ] **Step 4: Коммит**

```bash
git add deploy/systemd/saas-backfill.timer
git commit -m "feat(ops): очередь первичной загрузки разбирается раз в 5 минут"
```

---

### Task 4: Полоса «идёт первичная загрузка»

**Files:**
- Create: `app/api/cabinets/[id]/onboarding-status/route.js`
- Create: `app/cabinets/[id]/LoadingBanner.jsx`
- Modify: `app/cabinets/[id]/layout.js:82-136`

**Interfaces:**
- Consumes: ничего из других задач.
- Produces: `GET /api/cabinets/<id>/onboarding-status` → `{ loading: boolean }`. Используется только клиентским компонентом полосы.

- [ ] **Step 1: Написать эндпоинт статуса**

Создать `app/api/cabinets/[id]/onboarding-status/route.js`:

```js
// GET /api/cabinets/[id]/onboarding-status — идёт ли первичная загрузка.
// Лёгкий ответ для полосы в шапке: клиент опрашивает его раз в 30 секунд,
// чтобы полоса исчезла сама, без перезагрузки страницы.
import { NextResponse } from 'next/server';
import { withCabinet, tenantQuery } from '@/lib/withCabinet.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withCabinet(async (req, { cabinet }) => {
  const rows = await tenantQuery(
    `SELECT 1 FROM jobs.collect_jobs
      WHERE cabinet_id = $1 AND status = 'queued' LIMIT 1`,
    [cabinet.cabinet_id]
  );
  const broken = await tenantQuery(
    `SELECT 1 FROM auth.shops
      WHERE cabinet_id = $1 AND is_active = true AND auth_state <> 'ok' LIMIT 1`,
    [cabinet.cabinet_id]
  );
  // Магазин со сломанными ключами намеренно держит задание в очереди — показывать
  // при этом «загружаем» значит врать: данные не поедут, пока клиент не починит ключи.
  return NextResponse.json({ loading: rows.length > 0 && broken.length === 0 });
});
```

Если `jobs.collect_jobs` не покрыта RLS-политикой для роли панели, использовать `query` из `@/lib/db.js` с явным `cabinet_id` вместо `tenantQuery` — проверить это, выполнив запрос из-под панели и убедившись, что строки видны.

- [ ] **Step 2: Написать клиентский компонент полосы**

Создать `app/cabinets/[id]/LoadingBanner.jsx`:

```jsx
'use client';
// Полоса «идёт первичная загрузка». Сервер решает, показывать ли её при рендере;
// дальше компонент сам опрашивает статус, чтобы полоса исчезла без F5.
import { useEffect, useState } from 'react';

export default function LoadingBanner({ cabinetId }) {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/cabinets/${cabinetId}/onboarding-status`, { cache: 'no-store' });
        const j = await r.json();
        if (alive && j && j.loading === false) setLoading(false);
      } catch { /* сеть моргнула — покажем полосу дальше, следующая попытка через 30 с */ }
    };
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [cabinetId]);

  if (!loading) return null;
  return (
    <div className="banner banner-info">
      Загружаем историю за 75 дней — обычно это занимает несколько минут. Данные появятся автоматически.
    </div>
  );
}
```

Класс `banner-info` может отсутствовать в стилях — посмотреть, какие классы использует существующий рендер баннеров в `layout.js`, и взять тот же нейтральный тон (`warn`, если отдельного нет).

- [ ] **Step 3: Подключить в layout**

В `app/cabinets/[id]/layout.js` после запроса `brokenShops` (строка ~90) добавить:

```js
  // Первичная загрузка: задание в очереди означает, что данные ещё едут.
  const pendingJobs = await query(
    `SELECT 1 FROM jobs.collect_jobs WHERE cabinet_id = $1 AND status = 'queued' LIMIT 1`,
    [cabinetId]
  );
```

Импортировать компонент рядом с остальными импортами:

```js
import LoadingBanner from './LoadingBanner.jsx';
```

В блоке сборки баннеров, ПОСЛЕ цикла `for (const s of brokenShops)`, добавить условие старшинства:

```js
  // Показываем «загружаем» только если ключи целы: задание сломанного магазина
  // висит в очереди намеренно, и «вечная загрузка» скрыла бы настоящую причину.
  const showLoading = pendingJobs.length > 0 && brokenShops.length === 0;
```

В разметке, там где рендерятся `banners` (найти цикл по `banners` в JSX), сразу перед ним вставить:

```jsx
          {showLoading && <LoadingBanner cabinetId={cabinetId} />}
```

- [ ] **Step 4: Собрать и перезапустить**

Run: `cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 4 && curl -s -o /dev/null -w "%{http_code}\n" https://sysell.ru/`
Expected: `200`.

- [ ] **Step 5: Проверить оба состояния на боевых данных**

Кабинет 1009 сейчас со сломанными ключами — на нём полоса появляться НЕ должна.

Run:
```bash
psql -h localhost -U saas_ro -d saas -c \
 "select c.cabinet_id,
         (select count(*) from jobs.collect_jobs j where j.cabinet_id=c.cabinet_id and j.status='queued') as в_очереди,
         (select count(*) from auth.shops s where s.cabinet_id=c.cabinet_id and s.is_active and s.auth_state<>'ok') as сломаны
    from auth.cabinets c where c.status<>'deleted' order by 1"
```
Expected: видно, у каких кабинетов какое сочетание. Записать в отчёт, какой кабинет должен показывать полосу, а какой — баннер про ключи, и подтвердить это, открыв страницу кабинета curl'ом с сессией владельца либо описав рассуждение по данным, если сессии нет.

- [ ] **Step 6: Коммит**

```bash
git add app/api/cabinets/\[id\]/onboarding-status/route.js app/cabinets/\[id\]/LoadingBanner.jsx app/cabinets/\[id\]/layout.js
git commit -m "feat(ui): полоса первичной загрузки данных в шапке кабинета"
```

---

### Task 5: Экран подтверждения почты и смена адреса

**Files:**
- Create: `app/verify-pending/page.js`
- Create: `app/verify-pending/VerifyPendingPage.jsx`
- Create: `app/api/auth/verify/status/route.js`
- Create: `app/api/auth/email/route.js`
- Modify: `app/api/auth/register/route.js:108` (значение `next`)
- Modify: `app/onboarding/page.js` (редирект неподтверждённых)
- Modify: `lib/rate-limit.js` (лимит смены адреса)

**Interfaces:**
- Consumes: `createToken(user_id, 'verify_email')` из `lib/tokens.js`, `sendMail` из `lib/mailer.js` — оба уже существуют и используются в `app/api/auth/register/route.js:85-92`.
- Produces: `GET /api/auth/verify/status` → `{ verified: boolean, email: string }`; `PUT /api/auth/email` с телом `{ email }` → `{ ok: true }` либо 409 `{ error }`. На них опирается Task 6.

- [ ] **Step 1: Добавить лимит смены адреса**

В `lib/rate-limit.js`, в `LIMITS`:

```js
  emailChangeUser: Number(process.env.SAAS_RL_EMAIL_CHANGE_USER) || 3,  // смен неподтверждённого адреса в час на пользователя
```

Окно счётчика — минута, поэтому для «трёх в час» использовать ключ с часовой гранулярностью: `email-change:user:${user_id}:${Math.floor(Date.now() / 3_600_000)}`.

- [ ] **Step 2: Написать эндпоинт статуса подтверждения**

Создать `app/api/auth/verify/status/route.js`:

```js
// GET /api/auth/verify/status — подтверждён ли адрес текущего пользователя.
// Нужен экрану /verify-pending: клиент жмёт ссылку в письме в другой вкладке,
// а эта вкладка должна сама пустить его дальше.
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await query(
    `SELECT email, (email_verified_at IS NOT NULL) AS verified FROM auth.users WHERE user_id = $1`,
    [session.user_id]
  );
  if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ verified: rows[0].verified, email: rows[0].email });
}
```

- [ ] **Step 3: Написать смену неподтверждённого адреса**

Создать `app/api/auth/email/route.js`:

```js
// PUT /api/auth/email — сменить адрес, пока он не подтверждён, и выслать письмо.
//
// Обязательный аварийный выход: подтверждение закрывает и ключи, и приглашения,
// и оплату, поэтому опечатка в адресе иначе превращается в тупик — подтвердить
// нельзя, проект завести нельзя, а войти можно.
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
import { createToken } from '@/lib/tokens.js';
import { sendMail } from '@/lib/mailer.js';
import { hit, LIMITS } from '@/lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req) {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const hour = Math.floor(Date.now() / 3_600_000);
  const rl = hit(`email-change:user:${session.user_id}:${hour}`, LIMITS.emailChangeUser);
  if (rl.limited) {
    return NextResponse.json({ error: 'Слишком много попыток смены адреса. Попробуйте позже.' }, { status: 429 });
  }

  const b = await req.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase();
  if (!email.includes('@') || email.length < 5) {
    return NextResponse.json({ error: 'Проверьте адрес — он выглядит неверным.' }, { status: 400 });
  }

  const cur = await query(`SELECT email, email_verified_at FROM auth.users WHERE user_id = $1`, [session.user_id]);
  if (!cur.length) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (cur[0].email_verified_at) {
    return NextResponse.json({ error: 'Адрес уже подтверждён — сменить его здесь нельзя.' }, { status: 409 });
  }

  try {
    await query(`UPDATE auth.users SET email = $1 WHERE user_id = $2`, [email, session.user_id]);
  } catch (e) {
    // Занятость адреса ловим уникальным индексом lower(email) — отдельного SELECT
    // нет намеренно: он давал бы разное время ответа для занятых и свободных
    // адресов, то есть способ перебирать чужие адреса.
    if (e.code === '23505') {
      return NextResponse.json({ error: 'Этот адрес уже используется.' }, { status: 409 });
    }
    throw e;
  }

  session.email = email;
  await session.save();

  const token = await createToken(session.user_id, 'verify_email');
  const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';
  const res = await sendMail({
    to: email,
    subject: 'Подтвердите почту в SySell',
    text: `Подтвердите адрес:\n${base}/verify?token=${token}\n\nСсылка действует 7 дней.`,
  });
  if (!res.ok) {
    return NextResponse.json({ error: 'Адрес изменён, но письмо не ушло. Нажмите «Выслать ещё раз».' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, email });
}
```

- [ ] **Step 4: Написать экран ожидания**

Создать `app/verify-pending/page.js`:

```js
// Экран после регистрации: подтвердите адрес.
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
import VerifyPendingPage from './VerifyPendingPage.jsx';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const session = await getSession();
  if (!session?.user_id) redirect('/login');
  const rows = await query(
    `SELECT email, (email_verified_at IS NOT NULL) AS verified FROM auth.users WHERE user_id = $1`,
    [session.user_id]
  );
  if (rows[0]?.verified) redirect('/onboarding');
  return <VerifyPendingPage initialEmail={rows[0]?.email || ''} />;
}
```

Создать `app/verify-pending/VerifyPendingPage.jsx`:

```jsx
'use client';
import { useEffect, useState } from 'react';

export default function VerifyPendingPage({ initialEmail }) {
  const [email, setEmail] = useState(initialEmail);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialEmail);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Клиент открывает письмо в другой вкладке — эта должна сама пустить дальше.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const r = await fetch('/api/auth/verify/status', { cache: 'no-store' });
        const j = await r.json();
        if (j?.verified) window.location.href = '/onboarding';
      } catch { /* сеть моргнула — попробуем через 15 секунд */ }
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  const resend = async () => {
    setErr(''); setMsg('');
    const r = await fetch('/api/auth/verify/resend', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (r.ok) setMsg('Письмо отправлено ещё раз.');
    else setErr(j.error || 'Не удалось отправить письмо.');
  };

  const save = async () => {
    setErr(''); setMsg('');
    const r = await fetch('/api/auth/email', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: draft }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setEmail(j.email || draft); setEditing(false); setMsg('Адрес изменён, письмо отправлено.'); }
    else setErr(j.error || 'Не удалось изменить адрес.');
  };

  return (
    <div className="auth-card">
      <h1>Подтвердите почту</h1>
      <p>Мы отправили письмо на <b>{email}</b>. Перейдите по ссылке из письма — эта страница откроется дальше сама.</p>
      <p className="muted">Письма нет? Проверьте папку «Спам».</p>
      {editing ? (
        <div className="field">
          <input type="email" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="ваш@адрес" />
          <button type="button" onClick={save}>Сохранить и выслать</button>
          <button type="button" className="link" onClick={() => { setEditing(false); setDraft(email); }}>Отмена</button>
        </div>
      ) : (
        <div className="actions">
          <button type="button" onClick={resend}>Выслать ещё раз</button>
          <button type="button" className="link" onClick={() => setEditing(true)}>Ошиблись в адресе?</button>
        </div>
      )}
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}
```

Классы (`auth-card`, `field`, `actions`, `muted`, `ok`, `err`) взять те же, что используют существующие страницы входа и регистрации — посмотреть `app/login/` и `app/register/` и повторить разметку, чтобы экран не выбивался из оформления.

- [ ] **Step 5: Направить регистрацию на новый экран**

В `app/api/auth/register/route.js`, в ответе (строка ~108) заменить:

```js
      next: invite ? `/cabinets/${invite.cabinet_id}` : '/verify-pending',
```

- [ ] **Step 6: Закрыть онбординг для неподтверждённых**

`app/onboarding/page.js` начинается с `'use client'` — серверного редиректа в ней нет и быть не может. `middleware.js` тоже не подходит: он сознательно не ходит в базу (только проверяет подпись cookie), а `email_verified_at` живёт в базе, и тащить его в middleware значит добавить запрос к БД на каждый запрос панели.

Поэтому: переименовать текущий файл в `app/onboarding/OnboardingPage.jsx` (содержимое не менять, `'use client'` остаётся первой строкой) и создать серверную обёртку `app/onboarding/page.js` по образцу той, что написана в шаге 4:

```js
// /onboarding — создание проекта. Обёртка проверяет подтверждение адреса:
// без него POST /shops всё равно откажет, и клиент заполнил бы форму впустую.
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
import OnboardingPage from './OnboardingPage.jsx';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const session = await getSession();
  if (!session?.user_id) redirect('/login');
  const rows = await query(
    `SELECT (email_verified_at IS NOT NULL) AS verified FROM auth.users WHERE user_id = $1`,
    [session.user_id]
  );
  if (!rows[0]?.verified) redirect('/verify-pending');
  return <OnboardingPage />;
}
```

Если в переименованном файле есть экспорты, на которые ссылается кто-то ещё (проверить `grep -rn "onboarding/page" app/ lib/`), поправить импорты.

- [ ] **Step 7: Собрать, перезапустить, проверить руками**

Run: `cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 4 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3200/verify-pending`
Expected: `307` или `302` (редирект на `/login` без сессии) — страница отвечает, а не падает 500.

- [ ] **Step 8: Коммит**

```bash
git add app/verify-pending app/api/auth/verify/status app/api/auth/email app/api/auth/register/route.js app/onboarding lib/rate-limit.js
git commit -m "feat(auth): экран подтверждения почты после регистрации со сменой адреса"
```

---

### Task 6: Сквозной смоук нового пути и регресс

**Files:**
- Create: `scripts/smoke-onboarding.mjs`
- Modify: `AGENTS.md` (раздел «Правила работы с кодом»)

**Interfaces:**
- Consumes: контракты Task 2 (422 `mp_creds_invalid`) и Task 5 (`/api/auth/verify/status`, `PUT /api/auth/email`); хелперы `scripts/lib/mail-verify.mjs` (`lastMailFor`, `tokenFrom`) и `scripts/lib/pgpass.mjs` (`adminPgConfig`).
- Produces: ничего.

- [ ] **Step 1: Написать сквозной смоук**

Создать `scripts/smoke-onboarding.mjs` по образцу существующих (`scripts/smoke-auth-phase1.mjs` — взять оттуда каркас: разбор `.env.local`, `api()`, `check()`, пул через `adminPgConfig()`, самоочистка в `finally`). Проверяемые утверждения:

```js
// 1. Регистрация ведёт на /verify-pending, а не на /onboarding.
check('регистрация ведёт на подтверждение почты', reg.json?.next === '/verify-pending', JSON.stringify(reg.json));

// 2. Статус говорит «не подтверждён».
check('статус: адрес не подтверждён', st.json?.verified === false, JSON.stringify(st.json));

// 3. Смена адреса до подтверждения работает и шлёт письмо на новый адрес.
check('смена адреса: 200', chg.status === 200, `${chg.status} ${JSON.stringify(chg.json)}`);
check('письмо ушло на новый адрес', (await lastMailFor(newEmail)) !== null);

// 4. Занятый адрес не отдаётся.
check('занятый адрес: 409', busy.status === 409, `${busy.status}`);

// 5. Подтверждение по токену из письма открывает онбординг.
check('после подтверждения статус verified', st2.json?.verified === true, JSON.stringify(st2.json));

// 6. Ключи-мусор не сохраняются: 422 с кодом mp_creds_invalid.
check('мусорные ключи отклонены', shop.status === 422 && shop.json?.code === 'mp_creds_invalid',
  `${shop.status} ${JSON.stringify(shop.json)}`);
check('в ответе объяснено, что не так', String(shop.json?.error || '').length > 20, shop.json?.error);

// 7. Подтверждённый адрес сменить нельзя.
check('смена подтверждённого адреса: 409', chg2.status === 409, `${chg2.status}`);
```

Самоочистка обязательна: удалить созданные `auth.users`, `auth.memberships`, `auth.cabinets`, `jobs.collect_jobs` по адресам `*@smoke.test` — как это делают существующие смоуки, и вывести `CLEANUP FAIL`, если что-то осталось.

- [ ] **Step 2: Запустить новый смоук**

Run: `cd /opt/agents/saas && PGPASSFILE=/root/.pgpass-admin node scripts/smoke-onboarding.mjs http://127.0.0.1:3200`
Expected: `ALL PASS`.

- [ ] **Step 3: Полный регресс**

Run:
```bash
cd /opt/agents/saas && export PGPASSFILE=/root/.pgpass-admin && \
for s in smoke-auth-phase0 smoke-auth-phase1 smoke-auth-phase2 smoke-auth-phase3 smoke-auth-phase4 smoke-onboarding; do \
  echo -n "$s: "; node scripts/$s.mjs http://127.0.0.1:3200 </dev/null 2>&1 | tail -1; done; \
echo -n "smoke-billing: "; SAAS_YOOKASSA_MOCK=1 node scripts/smoke-billing.mjs http://127.0.0.1:3200 </dev/null 2>&1 | tail -1; \
echo -n "check-billing-lib: "; node scripts/check-billing-lib.mjs </dev/null 2>&1 | tail -1; \
echo -n "check-mp-validate: "; node scripts/check-mp-validate.mjs 2>&1 | tail -1
```
Expected: девять строк, все `ALL PASS`.

- [ ] **Step 4: Проверить, что тестовые записи убраны**

Run: `psql -h localhost -U saas_ro -d saas -Atc "select count(*) from auth.users where email like '%@smoke.test'"`
Expected: `0`.

- [ ] **Step 5: Записать порядок в AGENTS.md**

В раздел «Правила работы с кодом» добавить пункт:

```markdown
- **Ключи маркетплейса проверяются при сохранении** (`lib/mpValidate.js`): проверяются
  именно те доступы, которые нужны сборщикам (у WB — статистика и цены, у Ozon —
  каталог и финансы), потому что валидный ключ без нужной роли даёт пустые отчёты.
  Отказ маркетплейса распознан → 422 и объяснение клиенту; недоступность (5xx,
  таймаут, 429, незнакомый ответ) → сохраняем с предупреждением, чтобы авария
  маркетплейса не блокировала регистрацию. Проверять модуль — `node
  scripts/check-mp-validate.mjs` (заглушка, настоящие ключи не нужны).
```

- [ ] **Step 6: Коммит**

```bash
git add scripts/smoke-onboarding.mjs AGENTS.md
git commit -m "test(smoke): сквозная проверка нового пути онбординга"
```

---

## Проверка плана по спеке

| Требование спеки | Задача |
|---|---|
| Проверка доступов, а не живости ключа | 1, 2 |
| Формы ошибок WB и Ozon (404+code 5, 401, 403) | 1 (классификатор и заглушка) |
| Человеческие тексты ошибок | 1 (сообщения), 2 (отдача клиенту) |
| Авария маркетплейса → сохранить с предупреждением | 1 (`unreachable`), 2 (`warning`) |
| Рекламные креды не блокируют | 1 (`fatal: false`), проверка №7 |
| Таймаут 10 с, лимит на пользователя | 1 (`timeoutMs`), 2 (`shopSaveUser`) |
| Очередь раз в 5 минут | 3 |
| Полоса загрузки в шапке | 4 |
| Старшинство над баннером сломанных ключей | 4 (`showLoading`, эндпоинт) |
| Опрос статуса без перезагрузки | 4 |
| Экран `/verify-pending` после регистрации | 5 |
| Смена неподтверждённого адреса | 5 |
| Автопереход после подтверждения | 5 |
| `/onboarding` закрыт для неподтверждённых | 5 |
| Проверка модуля против заглушки, шесть режимов | 1 |
| Сквозной смоук нового пути | 6 |
| Регресс семи наборов | 6 |
| Живая приёмка владельцем | вне плана — делает владелец после деплоя |
