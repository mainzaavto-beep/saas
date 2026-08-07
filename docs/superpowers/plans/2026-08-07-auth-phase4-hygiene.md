# Фаза 4 auth-редизайна: гигиена + хвосты биллинга — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть накопленные мелкие дефекты безопасности и удобства: выход только по POST, неотличимый по времени ответ на неверный вход, русские тексты ошибок в интерфейсе, один компонент команды вместо двух копий, видимый сигнал о платеже с неверной суммой (фаза 4 спеки `docs/superpowers/specs/2026-08-06-auth-flow-design.md` + отложенные миноры биллинга из спеки `2026-08-07-billing-design.md`).

**Architecture:** Точечные правки существующих файлов, новых подсистем нет. Два изменения схемы: `auth.users.last_login_at` и новый статус `mismatch` в `billing.payments` — платёж с несошедшейся суммой перестаёт притворяться успешным и становится видимым на `/health`. Дублирующий UI команды сводится к одному компоненту: страница кабинета и вкладка настроек начинают рендерить `TeamPage` с флагом `embedded`.

**Tech Stack:** Next.js 14 (app router), PostgreSQL (миграции `db/migrations/0NN_*.sql`), bcryptjs, systemd.

## Global Constraints

- Прод-хост = репозиторий `/opt/agents/saas`, ветка master, remote нет.
- **ЗАПРЕЩЕНО `next dev` в каталоге прода** (затирает `.next`, роняет прод — правило AGENTS.md). Верификация: `npm run build && (SAAS_YOOKASSA_MOCK=1 npx next start -p 3210 &)`, после — убить процесс **только на 3210** (на 3200 живёт прод). Процесс умеет пере-форкаться: после убийства проверить `ss -ltnp | grep 3210` дважды.
- Деплой (только задача 5): `npm run build && systemctl restart saas-web`.
- Backup боевого файла перед правкой → `/opt/agentsDB/backups/<имя>.bak-2026-08-07p4`.
- Верификаторы: `scripts/smoke-auth-phase4.mjs` (задача 1) + регресс `smoke-billing.mjs` (с `SAAS_YOOKASSA_MOCK=1`), `smoke-auth-phase3.mjs`, `phase2`, `phase1`, `phase0`. Смоуки сами чистят данные; **тестовых записей в боевой БД оставаться не должно** (`auth.users` с `%@smoke.test`, `billing.plans` с `smoke-%`, `billing.payments` — ноль). `CLEANUP FAIL` = провал.
- Миграции идемпотентны, нумерация с `036_`.
- Тексты ошибок, которые видит пользователь, — по-русски. Технические коды (`unauthorized`, `subscription_required`, `email_unverified`) остаются как есть: их читает код, а не человек.
- Комментарии — по-русски. Каждая задача — отдельный коммит с префиксом из задачи.

---

### Task 1: Смоук фазы 4 (красный)

**Files:**
- Create: `scripts/smoke-auth-phase4.mjs`

**Interfaces:**
- Produces: `node scripts/smoke-auth-phase4.mjs http://localhost:3210` — PASS/FAIL построчно, exit 0 только если всё PASS и уборка чистая.
- Consumes: сервер панели, `.env.local`, `~/.pgpass` (строка postgres).

- [ ] **Step 1: Написать скрипт**

```js
#!/usr/bin/env node
// scripts/smoke-auth-phase4.mjs — смоук фазы 4: гигиена входа и текстов.
// Использование: node scripts/smoke-auth-phase4.mjs [base_url]
// Пишет в БД только записи *@smoke.test и сам их чистит.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const { types } = pg;
types.setTypeParser(20, (v) => v === null ? null : Number(v));
types.setTypeParser(1700, (v) => v === null ? null : Number(v));

const BASE = process.argv[2] || 'http://localhost:3210';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const pgpass = readFileSync(`${homedir()}/.pgpass`, 'utf8').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split(':'))
  .find(p => p[3] === 'postgres');
if (!pgpass) { console.error('нет строки postgres в ~/.pgpass'); process.exit(2); }
const pool = new pg.Pool({
  host: 'localhost', port: Number(pgpass[1]) || 5432,
  database: process.env.SAAS_DB || 'saas', user: 'postgres', password: pgpass[4],
});
const q = (sql, p) => pool.query(sql, p).then(r => r.rows);

let failed = 0, cleanupFailed = false;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failed++;
};
async function api(method, path, { body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0] || cookie };
}
const reg = (email) => api('POST', '/api/auth/register', { body: { email, password: 'smoke-pass-123' } });

const run = Date.now();
let cabinetId = null, ownerCookie = null, ownerId = null, mgrId = null, mgrCookie = null;

try {
  // ── Подготовка: владелец с кабинетом и менеджер в нём ──
  const owner = await reg(`p4owner-${run}@smoke.test`);
  ownerCookie = owner.cookie; ownerId = owner.json?.user?.user_id;
  const onb = await api('POST', '/api/onboarding/start', {
    cookie: ownerCookie, body: { display_name: `smoke-p4-${run}`, marketplaces: ['wb'] },
  });
  cabinetId = onb.json?.cabinet?.cabinet_id;
  check('подготовка: кабинет создан', !!cabinetId, JSON.stringify(onb.json));
  const mgr = await reg(`p4mgr-${run}@smoke.test`);
  mgrCookie = mgr.cookie; mgrId = mgr.json?.user?.user_id;
  await q(`INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, 'manager')`, [mgrId, cabinetId]);

  // ── 1. Выход только по POST ──
  const logoutGet = await fetch(`${BASE}/api/auth/logout`, { headers: { cookie: ownerCookie }, redirect: 'manual' });
  check('GET на выход отклоняется (405)', logoutGet.status === 405, `got ${logoutGet.status}`);
  const stillIn = await api('GET', `/api/cabinets/${cabinetId}/me`, { cookie: ownerCookie });
  check('...сессия после GET жива', stillIn.status === 200, `got ${stillIn.status}`);
  const logoutPost = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie: ownerCookie }, redirect: 'manual' });
  check('POST на выход работает (303 на /login)', logoutPost.status === 303 && (logoutPost.headers.get('location') || '').includes('/login'), `${logoutPost.status} ${logoutPost.headers.get('location')}`);

  // ── 2. Отметка о последнем входе ──
  const beforeLogin = (await q(`SELECT last_login_at FROM auth.users WHERE user_id = $1`, [ownerId]))[0];
  check('до входа last_login_at пуст', beforeLogin?.last_login_at === null, String(beforeLogin?.last_login_at));
  const relog = await api('POST', '/api/auth/login', { body: { email: `p4owner-${run}@smoke.test`, password: 'smoke-pass-123' } });
  check('вход: 200', relog.status === 200, `got ${relog.status}`);
  ownerCookie = relog.cookie;
  const afterLogin = (await q(`SELECT last_login_at FROM auth.users WHERE user_id = $1`, [ownerId]))[0];
  check('...last_login_at проставлен', !!afterLogin?.last_login_at, String(afterLogin?.last_login_at));

  // ── 3. Заблокированный аккаунт неотличим от неверного пароля ──
  const victim = `p4blocked-${run}@smoke.test`;
  const v = await reg(victim);
  await q(`UPDATE auth.users SET status = 'suspended' WHERE user_id = $1`, [v.json?.user?.user_id]);
  const blockedTry = await api('POST', '/api/auth/login', { body: { email: victim, password: 'smoke-pass-123' } });
  const wrongPass = await api('POST', '/api/auth/login', { body: { email: `p4ghost-${run}@smoke.test`, password: 'whatever-000' } });
  check('заблокированный аккаунт: 401 как при неверном пароле', blockedTry.status === 401, `got ${blockedTry.status}`);
  check('...текст ответа совпадает с обычной ошибкой входа',
    JSON.stringify(blockedTry.json) === JSON.stringify(wrongPass.json),
    `${JSON.stringify(blockedTry.json)} vs ${JSON.stringify(wrongPass.json)}`);

  // ── 4. Ошибки управления командой — по-русски ──
  const badRole = await api('PUT', `/api/cabinets/${cabinetId}/members`, {
    cookie: ownerCookie, body: { user_id: ownerId, role: 'manager' },
  });
  check('смена роли владельца запрещена: 403', badRole.status === 403, `got ${badRole.status}`);
  check('...текст по-русски', /[а-яА-Я]/.test(badRole.json?.error || ''), String(badRole.json?.error));
  const noSuch = await api('PUT', `/api/cabinets/${cabinetId}/members`, {
    cookie: ownerCookie, body: { user_id: 999999999, role: 'viewer' },
  });
  check('несуществующий участник: текст по-русски', /[а-яА-Я]/.test(noSuch.json?.error || ''), String(noSuch.json?.error));
  const noFields = await api('PUT', `/api/cabinets/${cabinetId}/members`, { cookie: ownerCookie, body: {} });
  check('пустой запрос: текст по-русски', /[а-яА-Я]/.test(noFields.json?.error || ''), String(noFields.json?.error));

  // ── 5. Менеджер не может оплачивать подписку ──
  const mgrPay = await api('POST', `/api/cabinets/${cabinetId}/billing/pay`, {
    cookie: mgrCookie, body: { plan_code: 'whatever' },
  });
  check('менеджер не может оплатить: 403', mgrPay.status === 403, `got ${mgrPay.status} ${JSON.stringify(mgrPay.json)}`);

  // ── 6. Платёж с несошедшейся суммой виден как требующий разбора ──
  const planCode = `smoke-p4-${run}`;
  await q(`INSERT INTO billing.plans (code, months, price_rub, title, sort) VALUES ($1, 1, 100.00, 'Смоук-п4', 999)`, [planCode]);
  const pay = await api('POST', `/api/cabinets/${cabinetId}/billing/pay`, { cookie: ownerCookie, body: { plan_code: planCode } });
  const payId = pay.json?.payment_id;
  check('платёж создан', !!payId, JSON.stringify(pay.json));
  // «Провайдер» подтверждает оплату, но на другую сумму.
  await q(`UPDATE billing.payments SET raw = coalesce(raw,'{}'::jsonb) || '{"mock_status":"succeeded"}'::jsonb, amount_rub = 777.00 WHERE payment_id = $1`, [payId]);
  await api('POST', `/api/billing/webhook/${process.env.SAAS_YOOKASSA_WEBHOOK_SECRET}`, {
    body: { event: 'payment.succeeded', object: { id: payId } },
  });
  const mism = (await q(`SELECT status, paid_until_after FROM billing.payments WHERE payment_id = $1`, [payId]))[0];
  check('несовпадение суммы: статус mismatch', mism?.status === 'mismatch', JSON.stringify(mism));
  check('...подписка не продлена', mism?.paid_until_after === null, String(mism?.paid_until_after));
} finally {
  const cf = (e) => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; };
  if (cabinetId) {
    await q(`DELETE FROM billing.payments WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM jobs.collect_jobs WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  }
  await q(`DELETE FROM billing.plans WHERE code LIKE 'smoke-%'`).catch(cf);
  await q(`DELETE FROM auth.user_tokens WHERE user_id IN (SELECT user_id FROM auth.users WHERE email LIKE $1)`, [`%-${run}@smoke.test`]).catch(cf);
  await q(`DELETE FROM auth.users WHERE email LIKE $1`, [`%-${run}@smoke.test`]).catch(cf);
  await pool.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
if (cleanupFailed) {
  console.error("CLEANUP: не все тестовые записи удалены, проверь auth.users, billing.plans, billing.payments");
  process.exit(1);
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Красный прогон**

```bash
cd /opt/agents/saas && npm run build && (SAAS_YOOKASSA_MOCK=1 npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase4.mjs http://localhost:3210
```

Expected: FAIL — «GET на выход отклоняется» (сейчас GET разлогинивает, придёт 303), «до входа last_login_at пуст» и «last_login_at проставлен» (колонки ещё нет — запрос упадёт, проверка честно даст FAIL), три проверки русских текстов, «статус mismatch» и «подписка не продлена». PASS — POST-выход, вход, заблокированный аккаунт, менеджер не платит, создание платежа. Ноль CLEANUP FAIL. Убить процесс на 3210.

Если скрипт падает трассировкой из-за отсутствующей колонки `last_login_at` — оберни соответствующие запросы в `.catch(() => [{}])`, чтобы проверка давала FAIL, а не крэш; это часть задачи.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-auth-phase4.mjs
git commit -m "test(auth): смоук фазы 4 — выход по POST, отметка входа, русские тексты, платёж с неверной суммой"
```

---

### Task 2: Схема, выход только по POST, отметка о входе, равное время ответа

**Files:**
- Create: `db/migrations/036_hygiene.sql`
- Modify: `app/api/auth/logout/route.js` (бэкап → `/opt/agentsDB/backups/logout-route.js.bak-2026-08-07p4`)
- Modify: `lib/auth.js` (бэкап → `/opt/agentsDB/backups/lib-auth.js.bak-2026-08-07p4`)
- Modify: `app/api/auth/login/route.js` (бэкап → `/opt/agentsDB/backups/login-route.js.bak-2026-08-07p4`)

**Interfaces:**
- Produces: колонка `auth.users.last_login_at`; статус `mismatch` разрешён в `billing.payments.status`; `GET /api/auth/logout` → 405; `loginUser` тратит одинаковое время на несуществующий, заблокированный и существующий аккаунт.
- Consumes: `query` из `@/lib/db.js`, `hashPassword`/`verifyPassword` из `lib/auth.js`.

- [ ] **Step 1: Миграция**

`db/migrations/036_hygiene.sql`:

```sql
-- 036: гигиена. Отметка о последнем входе (для поддержки и разбора инцидентов)
-- и отдельный статус для платежа, чья сумма не сошлась с тарифом: раньше он
-- помечался succeeded, из-за чего выглядел как обычная успешная оплата.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

ALTER TABLE billing.payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE billing.payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending','succeeded','canceled','mismatch'));
```

Применить: `psql -h localhost -U postgres -d saas -f db/migrations/036_hygiene.sql`
Проверить: `psql -h localhost -U postgres -d saas -Atc "select count(*) from information_schema.columns where table_schema='auth' and table_name='users' and column_name='last_login_at'"` → `1`.

- [ ] **Step 2: Выход только по POST**

В `app/api/auth/logout/route.js` заменить блок `GET` (последние строки файла) на:

```js
// GET не разлогинивает: иначе достаточно было бы подсунуть пользователю
// картинку с этим адресом, чтобы выбросить его из панели.
export async function GET() {
  return new Response(JSON.stringify({ error: 'Выход выполняется методом POST' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' },
  });
}
```

- [ ] **Step 3: Равное время ответа и отметка о входе**

В `lib/auth.js` заменить `loginUser` целиком:

```js
// Пустой хэш известного пароля: если аккаунта нет или он заблокирован, всё
// равно тратим время на bcrypt. Иначе по скорости ответа можно было бы
// перебирать, какие адреса зарегистрированы.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

// Логин: проверяет пароль. Возвращает { user } или null.
// Заблокированный аккаунт неотличим от неверного пароля — ни текстом, ни
// временем ответа (см. app/api/auth/login/route.js).
export async function loginUser({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  const rows = await query(
    'SELECT user_id, email, name, password_hash, status, session_version FROM auth.users WHERE email = $1',
    [email]
  );
  const u = rows[0];
  const ok = verifyPassword(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) return null;
  if (u.status !== 'active') { const e = new Error('Аккаунт ' + u.status); e.code = 'inactive'; throw e; }
  await query('UPDATE auth.users SET last_login_at = now() WHERE user_id = $1', [u.user_id]);
  return { user: { user_id: u.user_id, email: u.email, name: u.name, session_version: u.session_version } };
}
```

(Проверка статуса переехала ПОСЛЕ проверки пароля — иначе заблокированный аккаунт отвечал бы быстрее. Роут `login` уже отдаёт для `code === 'inactive'` тот же 401 с тем же текстом, менять его не нужно.)

- [ ] **Step 4: Верификация**

```bash
cd /opt/agents/saas && npm run build && (SAAS_YOOKASSA_MOCK=1 npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase4.mjs http://localhost:3210
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected фаза 4: PASS — выход по POST/405 на GET, обе проверки `last_login_at`, обе проверки заблокированного аккаунта; FAIL — три проверки русских текстов (задача 3) и две про `mismatch` (задача 4). Фаза 0: ALL PASS. Убить процесс на 3210.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/036_hygiene.sql app/api/auth/logout/route.js lib/auth.js
git commit -m "fix(sec): выход только по POST, отметка о входе, одинаковое время ответа при неверном входе"
```

---

### Task 3: Русские тексты ошибок и один компонент команды

**Files:**
- Modify: `app/api/cabinets/[id]/members/route.js` (бэкап → `/opt/agentsDB/backups/members-route.js.bak-2026-08-07p4`)
- Modify: `app/api/cabinets/[id]/invites/route.js` (бэкап → `/opt/agentsDB/backups/invites-route.js.bak-2026-08-07p4`)
- Modify: `app/cabinets/[id]/team/TeamPage.jsx` (бэкап → `/opt/agentsDB/backups/TeamPage.jsx.bak-2026-08-07p4`)
- Modify: `app/settings/page.js` (бэкап → `/opt/agentsDB/backups/settings-page.js.bak-2026-08-07p4`)

**Interfaces:**
- Produces: `TeamPage({ cabinetId, embedded })` — при `embedded` не рисует заголовок и внешние отступы; вкладка «Команда» в настройках рендерит его же.
- Consumes: существующие API команды и приглашений.

- [ ] **Step 1: Тексты ошибок в API команды**

В `app/api/cabinets/[id]/members/route.js` заменить сообщения (технические коды в ответах не трогаем, меняем только то, что видит человек):

```js
  if (!b.user_id || !b.role) return NextResponse.json({ error: "Укажите сотрудника и роль" }, { status: 400 });
  if (!["manager", "viewer"].includes(b.role)) return NextResponse.json({ error: "Роль может быть «Менеджер» или «Наблюдатель»" }, { status: 400 });
```

и обе пары проверок владельца/участника (в PUT и в DELETE):

```js
  if (!existing.length) return NextResponse.json({ error: "Этот пользователь не состоит в проекте" }, { status: 404 });
  if (existing[0].role === "owner") return NextResponse.json({ error: "Роль владельца проекта изменить нельзя" }, { status: 403 });
```

```js
  if (!existing.length) return NextResponse.json({ error: "Этот пользователь не состоит в проекте" }, { status: 404 });
  if (existing[0].role === "owner") return NextResponse.json({ error: "Владельца проекта удалить нельзя" }, { status: 403 });
```

и в DELETE проверку параметра:

```js
  if (!userId) return NextResponse.json({ error: "Не указан сотрудник" }, { status: 400 });
```

В `app/api/cabinets/[id]/invites/route.js` — в DELETE:

```js
  if (!token) return NextResponse.json({ error: "Не указано приглашение" }, { status: 400 });
```

- [ ] **Step 2: `TeamPage` умеет встраиваться**

В `app/cabinets/[id]/team/TeamPage.jsx` изменить сигнатуру и обёртку:

```jsx
export default function TeamPage({ cabinetId, embedded = false }) {
```

и внешний `<div>` вместе с заголовком:

```jsx
    <div style={embedded
      ? { width: "100%", fontFamily: FONT, color: C.ink }
      : { width: "100%", maxWidth: 700, margin: 0, padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      {!embedded && <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 20px" }}>👥 Команда</h1>}
```

- [ ] **Step 3: Настройки используют тот же компонент**

В `app/settings/page.js`:
1. Добавить импорт в шапку файла: `import TeamPage from "@/app/cabinets/[id]/team/TeamPage.jsx";`
2. Удалить функцию `TeamTab` целиком (от комментария `// --- Вкладка: Команда ---` до закрывающей скобки функции) — это вторая копия того же экрана, расходившаяся с первой по поведению.
3. Строку 127 (`{tab === "team" && cabinetId && <TeamTab cabinetId={cabinetId} />}`) заменить на:

```jsx
        {tab === "team" && cabinetId && <TeamPage cabinetId={cabinetId} embedded />}
```

- [ ] **Step 4: Верификация**

```bash
cd /opt/agents/saas && npm run build && (SAAS_YOOKASSA_MOCK=1 npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase4.mjs http://localhost:3210
node scripts/smoke-auth-phase1.mjs http://localhost:3210
```

Expected фаза 4: PASS всё, кроме двух проверок `mismatch` (задача 4). Фаза 1: ALL PASS (она проверяет права на команду и скрытие контактов — правки текстов их не задевают). Дополнительно вручную: `curl -s http://localhost:3210/settings -o /dev/null -w '%{http_code}'` → 200 (страница настроек собирается с новым импортом). Убить процесс на 3210.

- [ ] **Step 5: Commit**

```bash
git add "app/api/cabinets/[id]/members/route.js" "app/api/cabinets/[id]/invites/route.js" "app/cabinets/[id]/team/TeamPage.jsx" app/settings/page.js
git commit -m "fix(ui): русские тексты ошибок команды; вкладка настроек и страница команды — один компонент"
```

---

### Task 4: Видимый сигнал о платеже с неверной суммой и мелкие хвосты биллинга

**Files:**
- Modify: `lib/billing-credit.js` (бэкап → `/opt/agentsDB/backups/lib-billing-credit.js.bak-2026-08-07p4`)
- Modify: `app/api/health/route.js` (бэкап → `/opt/agentsDB/backups/health-route.js.bak-2026-08-07p4`)
- Modify: `app/health/HealthPage.jsx` (бэкап → `/opt/agentsDB/backups/HealthPage.jsx.bak-2026-08-07p4`)
- Modify: `app/cabinets/[id]/billing/BillingPage.jsx` (бэкап → `/opt/agentsDB/backups/BillingPage.jsx.bak-2026-08-07p4`)
- Modify: `lib/billing.js` (бэкап → `/opt/agentsDB/backups/lib-billing.js.bak-2026-08-07p4`)
- Modify: `middleware.js` (бэкап → `/opt/agentsDB/backups/middleware.js.bak-2026-08-07p4`)
- Modify: `deploy/systemd/saas-web.service`, `deploy/systemd/saas-billing-reconcile.service`

**Interfaces:**
- Consumes: статус `mismatch` из миграции 036 (задача 2).
- Produces: платёж с несошедшейся суммой получает `status = 'mismatch'`; `/api/health` отдаёт `payments_mismatch` — список таких платежей; страница `/health` показывает их отдельным блоком; в истории платежей клиента такой платёж подписан «требует разбора».

- [ ] **Step 1: Статус вместо ложного «успешно»**

В `lib/billing-credit.js` в ветке несовпадения суммы заменить `SET status = 'succeeded'` на `SET status = 'mismatch'` и уточнить комментарий:

```js
    // Сумма провайдера обязана совпасть с нашей ценой. Не совпало — денег не
    // зачисляем и помечаем платёж как требующий разбора: статус succeeded
    // выглядел бы как обычная оплата и терялся среди нормальных.
    if (Number(provider.amount_rub) !== Number(p.amount_rub)) {
      await client.query(
        `UPDATE billing.payments SET status = 'mismatch', updated_at = now(),
                raw = coalesce(raw,'{}'::jsonb) || $2::jsonb
          WHERE payment_id = $1`,
        [paymentId, JSON.stringify({ mismatch: { expected: p.amount_rub, got: provider.amount_rub } })]
      );
```

- [ ] **Step 2: Сигнал на `/health`**

В `app/api/health/route.js` рядом со сбором `billing` добавить:

```js
  // Платежи, где сумма провайдера разошлась с нашей ценой: деньги не зачислены,
  // нужен ручной разбор. Пусто в норме — если непусто, это видно сразу.
  const paymentsMismatch = await query(
    `SELECT p.payment_id, p.cabinet_id, c.display_name, p.amount_rub, p.raw->'mismatch' AS mismatch, p.created_at
       FROM billing.payments p
       JOIN auth.cabinets c ON c.cabinet_id = p.cabinet_id
      WHERE p.status = 'mismatch'
      ORDER BY p.created_at DESC LIMIT 50`
  );
```

и добавить в ответ поле `payments_mismatch: paymentsMismatch`.

В `app/health/HealthPage.jsx` после блока «Подписки» (он начинается строкой `{Array.isArray(data.billing) && (` на строке 100 и заканчивается закрывающей `)}`) добавить:

```jsx
      {Array.isArray(data.payments_mismatch) && data.payments_mismatch.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px", color: "#ff6b6b" }}>
            Платежи с несошедшейся суммой ({data.payments_mismatch.length})
          </h2>
          <div style={{ fontSize: 13 }}>
            {data.payments_mismatch.map((p) => (
              <div key={p.payment_id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                {new Date(p.created_at).toLocaleDateString("ru-RU")} — {p.display_name}: ждали {p.amount_rub} ₽,
                пришло {p.mismatch?.got ?? "—"} ₽ (платёж {p.payment_id})
              </div>
            ))}
          </div>
        </div>
      )}
```

- [ ] **Step 3: Подпись статуса в истории платежей клиента**

В `app/cabinets/[id]/billing/BillingPage.jsx` в строке истории платежей заменить выражение статуса на:

```jsx
              <span>{fmtMoney(p.amount_rub)} · {p.status === "succeeded" ? "оплачен" : p.status === "pending" ? "в обработке" : p.status === "mismatch" ? "требует разбора" : "отменён"}</span>
```

- [ ] **Step 4: Мелкие хвосты**

В `lib/billing.js` — пустое значение переменной не должно означать «ноль дней отсрочки»:

```js
// Пустая строка в env — это «не задано», а не ноль: иначе опечатка в
// конфигурации закрыла бы клиентам доступ на три дня раньше срока.
const graceRaw = (process.env.SAAS_GRACE_DAYS || '').trim();
const graceEnv = graceRaw === '' ? NaN : Number(graceRaw);
export const GRACE_DAYS = Number.isFinite(graceEnv) && graceEnv >= 0 ? graceEnv : 3;
```

В `middleware.js` — поправить неточный комментарий у `PUBLIC_PATHS`: строка про `/billing` должна объяснять, что публична только страница-заглушка мок-оплаты (`/billing/mock`), а страница подписки кабинета живёт под `/cabinets/<id>/billing` и требует сессии.

В `deploy/systemd/saas-web.service` и `deploy/systemd/saas-billing-reconcile.service` — в секцию `[Service]` добавить (расчёт сроков подписки опирается на локальное время, его нельзя оставлять на волю системных настроек):

```ini
Environment=TZ=Europe/Moscow
```

- [ ] **Step 5: Верификация**

```bash
cd /opt/agents/saas && npm run build && (SAAS_YOOKASSA_MOCK=1 npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase4.mjs http://localhost:3210
SAAS_YOOKASSA_MOCK=1 node scripts/smoke-billing.mjs http://localhost:3210
node scripts/smoke-auth-phase3.mjs http://localhost:3210
node scripts/smoke-auth-phase2.mjs http://localhost:3210
node scripts/smoke-auth-phase1.mjs http://localhost:3210
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected: все шесть — ALL PASS (у phase3 строка NOTE — не FAIL). Убить процесс на 3210, проверить нулями чистоту БД.

- [ ] **Step 6: Commit**

```bash
git add lib/billing-credit.js app/api/health/route.js app/health/HealthPage.jsx "app/cabinets/[id]/billing/BillingPage.jsx" lib/billing.js middleware.js deploy/systemd/saas-web.service deploy/systemd/saas-billing-reconcile.service
git commit -m "fix(billing): платёж с неверной суммой виден отдельным статусом; часовой пояс и отсрочка не зависят от опечаток"
```

---

### Task 5: Установка юнитов и деплой

**Files:** нет правок кода.

- [ ] **Step 1: Обновить установленные юниты**

Правка `deploy/systemd/*.service` в репозитории сама по себе ничего не меняет — установленные копии живут в `/etc/systemd/system/`:

```bash
cd /opt/agents/saas && cp deploy/systemd/saas-web.service deploy/systemd/saas-billing-reconcile.service /etc/systemd/system/ && systemctl daemon-reload
```

- [ ] **Step 2: Сборка и рестарт**

```bash
cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 6 && systemctl is-active saas-web
systemctl show saas-web -p Environment | grep -o 'TZ=Europe/Moscow'
```

Expected: `active` и строка `TZ=Europe/Moscow` (подтверждает, что новая версия юнита подхвачена).

- [ ] **Step 3: Шесть смоуков против прода**

```bash
node scripts/smoke-auth-phase4.mjs http://localhost:3200
SAAS_YOOKASSA_MOCK=1 node scripts/smoke-billing.mjs http://localhost:3200
node scripts/smoke-auth-phase3.mjs http://localhost:3200
node scripts/smoke-auth-phase2.mjs http://localhost:3200
node scripts/smoke-auth-phase1.mjs http://localhost:3200
node scripts/smoke-auth-phase0.mjs http://localhost:3200
```

Expected: ALL PASS во всех шести.

- [ ] **Step 4: Проверка состояния прода**

```bash
psql -h localhost -U postgres -d saas -Atc "select count(*) from auth.users where email like '%@smoke.test'"
psql -h localhost -U postgres -d saas -Atc "select count(*) from billing.payments"
psql -h localhost -U postgres -d saas -Atc "select cabinet_id, paid_until from auth.cabinets order by cabinet_id"
curl -sk -o /dev/null -w '%{http_code}\n' -m 8 https://sysell.ru/login
```

Expected: `0`, `0`, у всех пяти кабинетов дата в сентябре, `200`.

- [ ] **Step 5: Документация и коммит**

В `AGENTS.md` в разделе про конфигурацию дополнить строку про биллинг: упомянуть, что `saas-web` и `saas-billing-reconcile` запускаются с `TZ=Europe/Moscow`, потому что расчёт сроков подписки опирается на локальное время.

```bash
git add AGENTS.md
git commit -m "docs(ops): часовой пояс сервисов зафиксирован — от него зависит расчёт сроков подписки"
```
