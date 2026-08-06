# Хотфикс инвайтов (фаза 0 auth-редизайна) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Регистрация по инвайт-ссылке и вход приглашённых сотрудников работают на проде сегодня (фаза 0 спеки `docs/superpowers/specs/2026-08-06-auth-flow-design.md`).

**Architecture:** Четыре точечные правки существующих файлов (middleware, register-роут, register-страница, lib/auth.js) без новых таблиц и зависимостей. Верификация — смоук-скриптом на dev-сервере против боевой БД (только чтение) + живой прогон на проде.

**Tech Stack:** Next.js 14 (app router), iron-session, node-postgres через `lib/db.js` (`query`), systemd-деплой.

## Global Constraints

- Прод-хост = репозиторий `/opt/agents/saas`, ветка master, remote нет; коммиты локальные.
- После правок `.js` в `app/`/`lib/`: `npm run build && systemctl restart saas-web` (юнит `saas-web.service`, порт 3200; старый `saas.service` удалён 2026-08-06).
- Backup боевого файла перед правкой → `/opt/agentsDB/backups/` (правило AGENTS.md).
- Тестового фреймворка в проекте нет — верификация смоук-скриптом `scripts/smoke-auth-phase0.mjs` (node, без зависимостей) против dev-сервера `next dev -p 3210` и БД saas (пишет только тестовые записи: email-домен `@smoke.test`, кабинет demo; скрипт сам чистит за собой).
- Каждая задача — отдельный коммит с префиксом `fix(auth):`.
- Язык UI-текстов и комментариев — русский.

---

### Task 1: Смоук-скрипт «регистрация по инвайту» (красный)

Скрипт — сначала, чтобы фиксировать текущую поломку и служить верификацией всех последующих задач.

**Files:**
- Create: `scripts/smoke-auth-phase0.mjs`

**Interfaces:**
- Produces: запуск `node scripts/smoke-auth-phase0.mjs http://localhost:3210` — выполняет сценарии, печатает `PASS/FAIL` по каждому, exit 0 если все PASS, exit 1 иначе.
- Consumes: dev-сервер (`npm run dev` слушает 3200; для смоука запускаем `npx next dev -p 3210`), БД из `.env.local` (боевая; скрипт пишет только свои записи и удаляет их в конце).

- [ ] **Step 1: Написать скрипт**

```js
#!/usr/bin/env node
// scripts/smoke-auth-phase0.mjs — смоук фазы 0 auth-редизайна.
// Использование: node scripts/smoke-auth-phase0.mjs [base_url]
// Требует: поднятый сервер панели, доступ к БД (env из .env.local).
// Пишет в БД ТОЛЬКО тестовые записи (email *@smoke.test, инвайты в тестовый кабинет),
// в конце удаляет их. Боевые данные не трогает.
import pg from 'pg';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:3210';

// env из .env.local (как у Next)
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const pool = new pg.Pool({
  host: process.env.SAAS_DB_HOST || 'localhost',
  port: Number(process.env.SAAS_DB_PORT) || 5432,
  database: process.env.SAAS_DB || 'saas',
  user: process.env.SAAS_DB_USER || 'saas_app',
  password: process.env.SAAS_DB_PASSWORD,
});
const q = (sql, p) => pool.query(sql, p).then(r => r.rows);

let failed = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failed++;
}
// fetch с ручной кукой (нужно переносить set-cookie между запросами)
async function api(method, path, { body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') || '';
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, cookie: setCookie.split(';')[0] || cookie };
}

const run = Date.now();
const CAB_NAME = `smoke-cab-${run}`;
let cabinetId, ownerId, tokenViewer, tokenExpired;

try {
  // ── Подготовка: тестовый владелец, кабинет, инвайты (прямо в БД) ──
  ownerId = (await q(
    `INSERT INTO auth.users (email, password_hash, name) VALUES ($1, 'x', 'Smoke Owner') RETURNING user_id`,
    [`owner-${run}@smoke.test`]
  ))[0].user_id;
  cabinetId = (await q(
    `INSERT INTO auth.cabinets (owner_user_id, display_name, marketplaces, status)
     VALUES ($1, $2, '{wb}', 'active') RETURNING cabinet_id`,
    [ownerId, CAB_NAME]
  ))[0].cabinet_id;
  await q(`INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, 'owner')`, [ownerId, cabinetId]);
  tokenViewer = (await q(
    `INSERT INTO auth.invitations (token, cabinet_id, role, created_by)
     VALUES (gen_random_uuid()::text, $1, 'viewer', $2) RETURNING token`,
    [cabinetId, ownerId]
  ))[0].token;
  tokenExpired = (await q(
    `INSERT INTO auth.invitations (token, cabinet_id, role, created_by, expires_at)
     VALUES (gen_random_uuid()::text, $1, 'viewer', $2, now() - interval '1 day') RETURNING token`,
    [cabinetId, ownerId]
  ))[0].token;

  // ── 1. Анонимная валидация инвайта (ловит обрыв №1: middleware 401) ──
  const v = await api('GET', `/api/invite/${tokenViewer}`);
  check('анонимный GET /api/invite/<token> отвечает 200', v.status === 200, `got ${v.status}`);
  check('...и valid=true с именем кабинета', v.json?.valid === true && v.json?.cabinet_name === CAB_NAME, JSON.stringify(v.json));

  const ve = await api('GET', `/api/invite/${tokenExpired}`);
  check('истёкший инвайт: valid=false с текстом про срок', ve.json?.valid === false && /истёк/i.test(ve.json?.error || ''), JSON.stringify(ve.json));

  // ── 2. Регистрация по инвайту без общего кода (ловит обрыв №2: SAAS_INVITE_CODE) ──
  const email = `invitee-${run}@smoke.test`;
  const reg = await api('POST', '/api/auth/register', {
    body: { email, password: 'smoke-pass-123', name: 'Smoke Invitee', invite_token: tokenViewer },
  });
  check('регистрация с invite_token без invite_code: 200', reg.status === 200, `got ${reg.status} ${JSON.stringify(reg.json)}`);
  check('...ответ ведёт в кабинет приглашения', reg.json?.next === `/cabinets/${cabinetId}`, `next=${reg.json?.next}`);

  // ── 3. Инвайт принят сервером атомарно (membership + accepted_at) ──
  const mem = await q(
    `SELECT role FROM auth.memberships m JOIN auth.users u USING (user_id)
     WHERE u.email = $1 AND m.cabinet_id = $2`, [email, cabinetId]);
  check('membership viewer создан', mem[0]?.role === 'viewer', JSON.stringify(mem));
  const inv = await q(`SELECT accepted_at FROM auth.invitations WHERE token = $1`, [tokenViewer]);
  check('инвайт помечен принятым', !!inv[0]?.accepted_at);

  // ── 4. Регистрация без кода и без инвайта по-прежнему закрыта ──
  const regNoCode = await api('POST', '/api/auth/register', {
    body: { email: `stranger-${run}@smoke.test`, password: 'smoke-pass-123' },
  });
  check('регистрация без кода и инвайта: 403', regNoCode.status === 403, `got ${regNoCode.status}`);

  // ── 5. Вход сотрудника ведёт в кабинет по membership (ловит обрыв №3: firstCabinetOf) ──
  // Пароль invitee задан регистрацией выше; логинимся заново без куки.
  const login = await api('POST', '/api/auth/login', { body: { email, password: 'smoke-pass-123' } });
  check('вход сотрудника: 200', login.status === 200, `got ${login.status}`);
  check('...active_cabinet_id = кабинет приглашения', login.json?.active_cabinet_id === cabinetId, `got ${login.json?.active_cabinet_id}`);
  check("...next не '/onboarding'", login.json?.next !== '/onboarding', `next=${login.json?.next}`);

  // ── 6. Повторное использование токена отклоняется ──
  const reuse = await api('POST', `/api/invite/${tokenViewer}`, { cookie: login.cookie });
  check('повторный приём того же инвайта: 403', reuse.status === 403, `got ${reuse.status}`);
} finally {
  // ── Уборка (в обратном порядке FK) ──
  await q(`DELETE FROM auth.invitations WHERE cabinet_id = $1`, [cabinetId]).catch(() => {});
  await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(() => {});
  await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(() => {});
  await q(`DELETE FROM auth.users WHERE email IN ($1, $2, $3)`,
    [`owner-${run}@smoke.test`, `invitee-${run}@smoke.test`, `stranger-${run}@smoke.test`]).catch(() => {});
  await pool.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Поднять dev-сервер и убедиться, что скрипт падает на текущем коде**

```bash
cd /opt/agents/saas && npx next dev -p 3210 &   # подождать "Ready"
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected: FAIL на проверках 1 («анонимный GET ... got 401»), 2 («регистрация с invite_token ... got 403»), 3, 5 и 6 (регистрация не прошла — нет ни membership, ни логина); PASS на 4. Exit 1.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-auth-phase0.mjs
git commit -m "test(auth): смоук-скрипт фазы 0 — инвайты, регистрация, вход сотрудника"
```

---

### Task 2: middleware пропускает `/api/invite/*`

**Files:**
- Modify: `middleware.js:7` (бэкап в `/opt/agentsDB/backups/` перед правкой)

**Interfaces:**
- Produces: анонимный `GET/POST /api/invite/<token>` доходит до роута (роут сам отвечает 401 на POST без сессии — `app/api/invite/[token]/route.js:34`).

- [ ] **Step 1: Правка**

В `middleware.js` заменить строку 7:

```js
const PUBLIC_API = ['/api/auth/login', '/api/auth/register', '/api/auth/logout'];
```

на:

```js
const PUBLIC_API = ['/api/auth/login', '/api/auth/register', '/api/auth/logout'];
// /api/invite/<token> публичен: GET — валидация инвайта до регистрации,
// POST сам проверяет сессию (401 внутри роута).
const PUBLIC_API_PREFIXES = ['/api/invite/'];
```

и строку 16 дополнить:

```js
  if (PUBLIC_API.some((p) => pathname === p)) return NextResponse.next();
  if (PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
```

- [ ] **Step 2: Верификация смоуком**

```bash
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected: проверки 1 (анонимный GET 200, valid=true, истёкший) — PASS. Остальные FAIL пока остаются.

- [ ] **Step 3: Commit**

```bash
git add middleware.js
git commit -m "fix(auth): /api/invite/* публичен в middleware — анонимная валидация инвайта работает"
```

---

### Task 3: инвайт-токен вместо общего кода при регистрации + принятие на сервере

Принятие инвайта переносится с клиента на сервер регистрации: клиентский «выстрелил и забыл» `POST /api/invite/...` (register/page.js:60) ненадёжен. Сервер регистрации сам валидирует токен, создаёт юзера, принимает инвайт в одной транзакции и возвращает `next: /cabinets/<id>`.

**Files:**
- Modify: `app/api/auth/register/route.js` (бэкап перед правкой)
- Modify: `app/register/page.js:56-65, 101` (бэкап перед правкой)

**Interfaces:**
- Consumes: `getPool` из `lib/db.js` (транзакция через `pool.connect()` + BEGIN/COMMIT), `registerUser` из `lib/auth.js`.
- Produces: `POST /api/auth/register` принимает `{ email, password, name?, first_name?, last_name?, invite_code?, invite_token? }`; при валидном `invite_token` — код не требуется, ответ `{ ok, user, invited_cabinet_id, next: '/cabinets/<id>' }`; без токена — поведение как раньше (`next: '/onboarding'`). Клиент шлёт `invite_token` и больше НЕ делает отдельный POST принятия.

- [ ] **Step 1: Переписать `app/api/auth/register/route.js`**

```js
// POST /api/auth/register { email, password, name, invite_token? } → создаёт юзера, логинит.
// При валидном invite_token регистрация открыта (токен = персональный пропуск),
// инвайт принимается здесь же, в одной транзакции с membership.
import { NextResponse } from 'next/server';
import { registerUser } from '@/lib/auth.js';
import { getSession } from '@/lib/session.js';
import { query, getPool } from '@/lib/db.js';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  try {
    // Валидный персональный инвайт освобождает от общего кода.
    let invite = null;
    if (body.invite_token) {
      const rows = await query(
        `SELECT token, cabinet_id, role, accepted_at, expires_at
         FROM auth.invitations WHERE token = $1`,
        [String(body.invite_token)]
      );
      const inv = rows[0];
      if (!inv) return NextResponse.json({ error: 'Приглашение не найдено' }, { status: 403 });
      if (inv.accepted_at) return NextResponse.json({ error: 'Приглашение уже использовано' }, { status: 403 });
      if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ error: 'Срок приглашения истёк' }, { status: 403 });
      invite = inv;
    }
    // 🔒 Invite-only: если задан SAAS_INVITE_CODE, регистрация только с кодом
    // или по персональному инвайту. Пустой код = открыто.
    const inviteCode = process.env.SAAS_INVITE_CODE;
    if (!invite && inviteCode && body.invite_code !== inviteCode) {
      return NextResponse.json({ error: 'Неверный invite-код. Регистрация по приглашению.' }, { status: 403 });
    }

    const { user } = await registerUser(body);

    // Принять инвайт атомарно: membership + отметка использования.
    if (invite) {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO auth.memberships (user_id, cabinet_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, cabinet_id) DO NOTHING`,
          [user.user_id, invite.cabinet_id, invite.role]
        );
        await client.query(
          `UPDATE auth.invitations SET accepted_by = $1, accepted_at = now() WHERE token = $2`,
          [user.user_id, invite.token]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    const session = await getSession();
    session.user_id = user.user_id;
    session.email = user.email;
    session.name = user.name;
    session.active_cabinet_id = invite ? invite.cabinet_id : null;
    await session.save();
    return NextResponse.json({
      ok: true, user,
      invited_cabinet_id: invite ? invite.cabinet_id : null,
      next: invite ? `/cabinets/${invite.cabinet_id}` : '/onboarding',
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
```

(Новому пользователю `ON CONFLICT DO NOTHING` не мешает — конфликтов у свежесозданного user_id быть не может; та же форма пригодится фазе 1.)

- [ ] **Step 2: Правка клиента `app/register/page.js`**

В `submit()` (строки 44-65): добавить `invite_token` в тело, убрать клиентский POST принятия, редирект по `data.next`:

```js
      const r = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email, password,
          name: [lastName, firstName].filter(Boolean).join(' ') || undefined,
          first_name: firstName || undefined,
          last_name: lastName || undefined,
          invite_code: inviteCode || undefined,
          invite_token: inviteToken || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data.error || 'Ошибка регистрации'); return; }
      // Инвайт принят сервером регистрации; идём куда он сказал.
      router.push(data.next || '/onboarding');
      router.refresh();
```

Блок `if (inviteToken && inviteInfo?.valid && data.user?.user_id) { await fetch(...) }` и комментарий над ним — удалить целиком.

- [ ] **Step 3: Верификация смоуком**

```bash
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected: проверки 2, 3, 4, 6 — PASS (регистрация по токену 200 с `next=/cabinets/<id>`, membership+accepted_at в БД, без кода — 403, повторный приём — 403). Проверка 5 (вход) ещё FAIL.

- [ ] **Step 4: Commit**

```bash
git add app/api/auth/register/route.js app/register/page.js
git commit -m "fix(auth): инвайт-токен — пропуск на регистрацию; принятие атомарно на сервере; редирект в кабинет"
```

---

### Task 4: вход ищет кабинет по membership

**Files:**
- Modify: `lib/auth.js:49-59` (бэкап перед правкой)

**Interfaces:**
- Produces: `firstCabinetOf(userId)` → первый кабинет по `auth.memberships` (владелец или сотрудник), сигнатура и формат результата не меняются (`{ cabinet_id, display_name, marketplaces } | null`). Потребитель — `app/api/auth/login/route.js:15` (без правок).

- [ ] **Step 1: Правка `firstCabinetOf`**

Заменить запрос (строки 50-59):

```js
// Найти первый кабинет юзера (для active_cabinet_id после логина).
// По membership, не по владению: сотрудник (manager/viewer) тоже должен
// попадать в свой кабинет, а не на онбординг.
export async function firstCabinetOf(userId) {
  const rows = await query(
    `SELECT c.cabinet_id, c.display_name, c.marketplaces
     FROM auth.memberships m
     JOIN auth.cabinets c ON c.cabinet_id = m.cabinet_id
     WHERE m.user_id = $1 AND c.status IN ('active','provisioning')
     ORDER BY c.cabinet_id LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}
```

- [ ] **Step 2: Верификация смоуком — всё зелёное**

```bash
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected: `ALL PASS`, exit 0. Остановить dev-сервер (порт 3210).

- [ ] **Step 3: Commit**

```bash
git add lib/auth.js
git commit -m "fix(auth): firstCabinetOf по membership — сотрудник после входа попадает в кабинет, не на онбординг"
```

---

### Task 5: деплой и живая проверка

**Files:** нет правок кода.

- [ ] **Step 1: Сборка и рестарт**

```bash
cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 5 && systemctl is-active saas-web
```

Expected: `active`.

- [ ] **Step 2: Смоук против прода**

```bash
node scripts/smoke-auth-phase0.mjs http://localhost:3200
```

Expected: `ALL PASS` (скрипт чистит свои записи; на проде это безопасно — тестовые email `@smoke.test`).

- [ ] **Step 3: Живой инвайт владельца**

Инвайт от 2026-08-04 (кабинет 1, viewer, годен до 11.08) не тронут. Сообщить владельцу: переслать наблюдателю ссылку `https://sysell.ru/register?invite=<токен из auth.invitations>` — человек регистрируется и попадает в кабинет. Это финальная приёмка фазы 0.

- [ ] **Step 4: Актуализировать AGENTS.md (деплой-команда) и закоммитить**

В AGENTS.md строка ~289: `npm run build && systemctl restart saas` → `npm run build && systemctl restart saas-web` (старый юнит `saas.service` удалён 2026-08-06 как дубликат).

```bash
git add AGENTS.md
git commit -m "docs(ops): деплой панели — юнит saas-web вместо удалённого saas"
```
