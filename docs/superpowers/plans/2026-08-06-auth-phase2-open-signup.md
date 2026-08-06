# Фаза 2 auth-редизайна: открытая регистрация и триал — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Любой продавец может зарегистрироваться сам, получает кабинет с пробным периодом 14 дней и видимым сроком; вход и регистрация защищены от перебора; сессия продлевается при активности (фаза 2 спеки `docs/superpowers/specs/2026-08-06-auth-flow-design.md`).

**Architecture:** Убираем общий секретный код; уникальность email делаем регистронезависимой на уровне БД и ловим дубль через `ON CONFLICT` вместо гонкоопасного SELECT. Пробный период — колонка `auth.cabinets.trial_ends_at` (уже в схеме), заполняется онбордингом и показывается баннером в шапке кабинета; доступ по истечении НЕ блокируется (это отдельная спека оплаты). Ограничение попыток — счётчик в памяти процесса панели (один инстанс Next, внешних зависимостей нет).

**Tech Stack:** Next.js 14 (app router), iron-session, node-postgres (`lib/db.js`), PostgreSQL (миграции `db/migrations/0NN_*.sql`), systemd (`saas-web.service`), Caddy как обратный прокси (проставляет `X-Forwarded-For`).

## Global Constraints

- Прод-хост = репозиторий `/opt/agents/saas`, ветка master, remote нет.
- **ЗАПРЕЩЕНО `next dev` в каталоге прода** (затирает `.next`, роняет прод — правило AGENTS.md). Верификация: `npm run build && (npx next start -p 3210 &)`, после — убить процесс **только на 3210** (на 3200 живёт прод).
- Деплой (только задача 5): `npm run build && systemctl restart saas-web`.
- Backup боевого файла перед правкой → `/opt/agentsDB/backups/<имя>.bak-2026-08-06p2`.
- Верификаторы: `scripts/smoke-auth-phase2.mjs` (задача 1) + регресс `smoke-auth-phase1.mjs` и `smoke-auth-phase0.mjs`. Все три сами готовят/чистят данные (`*@smoke.test`, прямой SQL под ролью postgres из `~/.pgpass`); строки `CLEANUP FAIL` = провал.
- Миграции идемпотентны (`IF NOT EXISTS`), нумерация продолжается с `032_`.
- Лимиты попыток (константы, env-переопределяемые): неудачных входов — 5/мин на аккаунт (`SAAS_RL_LOGIN_ACCOUNT`), 20/мин на IP (`SAAS_RL_LOGIN_IP`); регистраций — 30/мин на IP (`SAAS_RL_REGISTER_IP`). Успешный вход лимит НЕ расходует.
- Пробный период: `SAAS_TRIAL_DAYS`, дефолт 14.
- Комментарии и UI-тексты — по-русски. Каждая задача — отдельный коммит с префиксом из задачи.

---

### Task 1: Смоук-скрипт фазы 2 (красный)

**Files:**
- Create: `scripts/smoke-auth-phase2.mjs`

**Interfaces:**
- Produces: `node scripts/smoke-auth-phase2.mjs http://localhost:3210` — PASS/FAIL построчно, exit 0 только если всё PASS и уборка чистая.
- Consumes: сервер панели (прод-сборка на 3210), `.env.local`, `~/.pgpass` (строка postgres).

- [ ] **Step 1: Написать скрипт**

```js
#!/usr/bin/env node
// scripts/smoke-auth-phase2.mjs — смоук фазы 2: открытая регистрация, триал,
// ограничение попыток, сохранение next, продление сессии.
// Использование: node scripts/smoke-auth-phase2.mjs [base_url]
// Пишет в БД только записи *@smoke.test и сам их чистит (прямой SQL — под postgres
// из ~/.pgpass: у saas_app осознанно нет DELETE на auth.*).
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const { types } = pg;
// Те же парсеры типов, что в lib/db.js — bigint/numeric как Number.
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
  const setCookie = res.headers.get('set-cookie') || '';
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, setCookie, cookie: setCookie.split(';')[0] || cookie, headers: res.headers };
}

const run = Date.now();
let cabinetId = null;

try {
  // ── 1. Открытая регистрация: без invite_code и без токена ──
  const email = `open-${run}@smoke.test`;
  const reg = await api('POST', '/api/auth/register', {
    body: { email, password: 'smoke-pass-123', first_name: 'Иван', last_name: 'Петров' },
  });
  check('открытая регистрация без кода: 200', reg.status === 200, `got ${reg.status} ${JSON.stringify(reg.json)}`);
  const userId = reg.json?.user?.user_id;

  // ── 2. Имя и фамилия сохранены ──
  const u = (await q(`SELECT first_name, last_name, name, email FROM auth.users WHERE user_id = $1`, [userId]))[0];
  check('first_name/last_name сохранены', u?.first_name === 'Иван' && u?.last_name === 'Петров', JSON.stringify(u));

  // ── 3. Дубль email в другом регистре — 409 с человеческим текстом ──
  const dup = await api('POST', '/api/auth/register', {
    body: { email: email.toUpperCase(), password: 'smoke-pass-123' },
  });
  check('дубль email (другой регистр): 409', dup.status === 409, `got ${dup.status} ${JSON.stringify(dup.json)}`);
  check('...текст человеческий, без деталей БД', typeof dup.json?.error === 'string' && !/duplicate key|constraint|violates/i.test(dup.json.error), String(dup.json?.error));
  check('...код email_taken для клиента', dup.json?.code === 'email_taken', String(dup.json?.code));

  // ── 4. Онбординг ставит пробный период ──
  const onb = await api('POST', '/api/onboarding/start', {
    cookie: reg.cookie, body: { display_name: `smoke-proj-${run}`, marketplaces: ['wb'] },
  });
  check('онбординг: 200', onb.status === 200, `got ${onb.status} ${JSON.stringify(onb.json)}`);
  cabinetId = onb.json?.cabinet?.cabinet_id;
  const cab = (await q(`SELECT trial_ends_at FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]))[0];
  const days = cab?.trial_ends_at ? Math.round((new Date(cab.trial_ends_at) - Date.now()) / 86400000) : null;
  check('...trial_ends_at ≈ +14 дней', days === 14, `got ${days} (${cab?.trial_ends_at})`);
  check('...кабинет вернул trial_ends_at в ответе', !!onb.json?.cabinet?.trial_ends_at, JSON.stringify(onb.json?.cabinet));

  // ── 5. Сессия не переиздаётся на каждый запрос (rolling раз в сутки) ──
  const me = await api('GET', `/api/cabinets/${cabinetId}/me`, { cookie: reg.cookie });
  check('withCabinet-роут отвечает 200', me.status === 200, `got ${me.status}`);
  check('...сессия не переиздана (нет Set-Cookie)', !me.setCookie, String(me.setCookie).slice(0, 60));

  // ── 6. Успешный вход лимит не расходует: 6 подряд успешных входов ──
  let allOk = true;
  for (let i = 0; i < 6; i++) {
    const r = await api('POST', '/api/auth/login', { body: { email, password: 'smoke-pass-123' } });
    if (r.status !== 200) { allOk = false; check(`успешный вход #${i + 1}: 200`, false, `got ${r.status}`); break; }
  }
  check('6 успешных входов подряд не блокируются', allOk);

  // ── 7. Перебор пароля: 6-я неудачная попытка — 429 ──
  const victim = `victim-${run}@smoke.test`;
  await api('POST', '/api/auth/register', { body: { email: victim, password: 'smoke-pass-123' } });
  let sawLimited = null;
  for (let i = 1; i <= 6; i++) {
    const r = await api('POST', '/api/auth/login', { body: { email: victim, password: 'wrong-pass-000' } });
    if (r.status === 429) { sawLimited = i; break; }
    if (r.status !== 401) { check(`неудачный вход #${i}: 401`, false, `got ${r.status}`); break; }
  }
  check('перебор пароля упирается в лимит на 6-й попытке', sawLimited === 6, `сработало на попытке ${sawLimited}`);

  // ── 8. Правильный пароль под лимитом тоже отбивается (лимит на аккаунт) ──
  const blocked = await api('POST', '/api/auth/login', { body: { email: victim, password: 'smoke-pass-123' } });
  check('под лимитом даже верный пароль: 429', blocked.status === 429, `got ${blocked.status}`);
  check('...ответ содержит Retry-After', !!blocked.headers.get('retry-after'), String(blocked.headers.get('retry-after')));

  // ── 9. middleware сохраняет query в next ──
  const guarded = await fetch(`${BASE}/cabinets/${cabinetId}/summary?period=month`, { redirect: 'manual' });
  const loc = guarded.headers.get('location') || '';
  check('редирект на /login с сохранением query', loc.includes('/login?next=') && decodeURIComponent(loc).includes(`/cabinets/${cabinetId}/summary?period=month`), loc);
} finally {
  const cf = (e) => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; };
  if (cabinetId) {
    await q(`DELETE FROM jobs.collect_jobs WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  }
  await q(`DELETE FROM auth.users WHERE email LIKE $1`, [`%-${run}@smoke.test`]).catch(cf);
  await pool.end();
}
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
if (cleanupFailed) {
  console.error("CLEANUP: не все тестовые записи удалены, проверь auth.users WHERE email LIKE '%@smoke.test'");
  process.exit(1);
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Прод-сборка на 3210 и красный прогон**

```bash
cd /opt/agents/saas && npm run build && (npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
# дождаться "Ready" в /tmp/next3210.log
node scripts/smoke-auth-phase2.mjs http://localhost:3210
```

Expected на текущем коде: FAIL — «открытая регистрация без кода» (403, код ещё требуется) и следом всё, что зависит от созданного пользователя (имя/фамилия, дубль, онбординг, триал, сессия, входы, лимиты); «редирект с сохранением query» тоже FAIL (middleware теряет search). Exit 1, ноль CLEANUP FAIL. Убить процесс на 3210.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-auth-phase2.mjs
git commit -m "test(auth): смоук фазы 2 — открытая регистрация, триал, лимиты попыток"
```

---

### Task 2: Открытая регистрация и регистронезависимый email

**Files:**
- Create: `db/migrations/032_users_email_lower_unique.sql`
- Modify: `lib/auth.js:17-33` (бэкап → `/opt/agentsDB/backups/lib-auth.js.bak-2026-08-06p2`)
- Modify: `app/api/auth/register/route.js` (бэкап → `/opt/agentsDB/backups/register-route.js.bak-2026-08-06p2`)
- Modify: `app/register/page.js` (бэкап → `/opt/agentsDB/backups/register-page.js.bak-2026-08-06p2`)
- Modify: `.env.local` — удалить строку `SAAS_INVITE_CODE=...` (файл вне git; остальные строки не трогать)

**Interfaces:**
- Consumes: `query` из `@/lib/db.js`.
- Produces: `registerUser({ email, password, name?, first_name?, last_name? })` → `{ user: { user_id, email, name } }`; кидает `Error` с `err.code === 'validation'` (некорректный email / короткий пароль) либо `err.code === 'email_taken'`. `POST /api/auth/register` → 200 (как раньше, `next` и приём инвайта сохраняются) | 400 `{error}` | 409 `{error, code:'email_taken'}` | 500 `{error:'Внутренняя ошибка, попробуйте позже'}`.

- [ ] **Step 1: Миграция**

`db/migrations/032_users_email_lower_unique.sql`:

```sql
-- 032: регистронезависимая уникальность email.
-- До этого UNIQUE был по точному значению: user@x.ru и User@x.ru — два аккаунта,
-- при том что приложение нормализует email в нижний регистр при входе.
-- Проверено 2026-08-06: дублей по lower(email) в проде нет.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq ON auth.users (lower(email));
```

Применить: `psql -h localhost -U postgres -d saas -f db/migrations/032_users_email_lower_unique.sql`
Проверить: `psql -h localhost -U postgres -d saas -Atc "select indexname from pg_indexes where schemaname='auth' and indexname='users_email_lower_uniq'"` → `users_email_lower_uniq`.

- [ ] **Step 2: `lib/auth.js` — вставка с ON CONFLICT, имя и фамилия**

Заменить `registerUser` (строки 17-33):

```js
// Регистрация: создаёт user. Возвращает { user } или кидает Error.
// err.code: 'validation' — показать текст пользователю; 'email_taken' — дубль.
export async function registerUser({ email, password, name, first_name, last_name }) {
  email = String(email || '').trim().toLowerCase();
  const bad = (msg) => { const e = new Error(msg); e.code = 'validation'; return e; };
  if (!email || !email.includes('@')) throw bad('Некорректный email');
  if (!password || password.length < 8) throw bad('Пароль минимум 8 символов');

  const fn = first_name ? String(first_name).trim() : null;
  const ln = last_name ? String(last_name).trim() : null;
  const fullName = (name && String(name).trim()) || [ln, fn].filter(Boolean).join(' ') || null;
  const hash = hashPassword(password);

  // Дубль ловим уникальным индексом lower(email), а не предварительным SELECT:
  // проверка «сначала посмотреть, потом вставить» гонкоопасна.
  let rows;
  try {
    rows = await query(
      `INSERT INTO auth.users (email, password_hash, name, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, email, name`,
      [email, hash, fullName, fn, ln]
    );
  } catch (e) {
    if (e.code === '23505') {
      const err = new Error('Аккаунт с таким email уже зарегистрирован');
      err.code = 'email_taken';
      throw err;
    }
    throw e;
  }
  return { user: rows[0] };
}
```

- [ ] **Step 3: `app/api/auth/register/route.js` — убрать общий код, разделить ошибки**

Заменить блок проверки кода (строки 27-32) — удалить целиком, вместе с комментарием про invite-only. Заменить финальный `catch` (строки 82-84) на:

```js
  } catch (e) {
    if (e.code === 'email_taken') {
      return NextResponse.json({ error: e.message, code: 'email_taken' }, { status: 409 });
    }
    if (e.code === 'validation') {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    console.error('[register]', e.message);
    return NextResponse.json({ error: 'Внутренняя ошибка, попробуйте позже' }, { status: 500 });
  }
```

И в шапке файла первой строкой комментария — актуализировать:

```js
// POST /api/auth/register { email, password, name, first_name, last_name, invite_token? }
// → создаёт юзера, логинит. Регистрация открытая (общий SAAS_INVITE_CODE убран
// в фазе 2). При валидном invite_token инвайт принимается здесь же, в одной
// транзакции с membership.
```

- [ ] **Step 4: `app/register/page.js` — убрать поле кода, показать ссылку на вход при дубле**

Удалить состояние `const [inviteCode, setInviteCode] = useState('');` (строка 24), блок поля «Invite-код» целиком (строки 101-106 — весь `{!inviteToken && (...)}`) и `invite_code: inviteCode || undefined,` из тела запроса.

Добавить состояние рядом с `err`:

```js
  const [emailTaken, setEmailTaken] = useState(false);
```

В `submit()` перед `setBusy(true)` добавить `setEmailTaken(false);`, а обработку ответа заменить на:

```js
      const data = await r.json();
      if (!r.ok) {
        setErr(data.error || 'Ошибка регистрации');
        if (data.code === 'email_taken') setEmailTaken(true);
        return;
      }
```

И в разметке — сразу после блока `{err && ...}` добавить:

```jsx
        {emailTaken && (
          <div style={{ fontSize: 14, marginBottom: 16 }}>
            <a href={`/login${inviteToken ? `?next=${encodeURIComponent(`/invite/${inviteToken}`)}` : ''}`} style={{ color: C.accent }}>Войти в существующий аккаунт</a>
          </div>
        )}
```

- [ ] **Step 5: `.env.local` — удалить строку `SAAS_INVITE_CODE=...`**

- [ ] **Step 6: Верификация**

```bash
cd /opt/agents/saas && npm run build && (npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase2.mjs http://localhost:3210
node scripts/smoke-auth-phase1.mjs http://localhost:3210
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected фаза 2: PASS — регистрация, имя/фамилия, все три проверки дубля; FAIL — триал (задача 3), лимиты и next-с-query (задача 4); проверка «сессия не переиздана» может пройти уже сейчас (куки переиздаются только при `save()`) — это нормально. Фазы 1 и 0: ALL PASS — **важно**: в них есть проверка «регистрация без кода и инвайта: 403», которая теперь обязана поменяться. Если она красная — это ожидаемо: **обнови её** в `scripts/smoke-auth-phase0.mjs` на новую семантику (регистрация открыта):

```js
  // ── 4. Регистрация без инвайта теперь открыта (фаза 2 убрала общий код) ──
  const regNoCode = await api('POST', '/api/auth/register', {
    body: { email: `stranger-${run}@smoke.test`, password: 'smoke-pass-123' },
  });
  check('регистрация без инвайта: 200 (открытая)', regNoCode.status === 200, `got ${regNoCode.status}`);
```

Аналогично в `scripts/smoke-auth-phase1.mjs` вспомогательная функция `reg()` передаёт `invite_code` из env — это поле теперь игнорируется сервером, удалять не обязательно, но если оставляешь — убедись, что фаза 1 зелёная. Убить процесс на 3210.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/032_users_email_lower_unique.sql lib/auth.js app/api/auth/register/route.js app/register/page.js scripts/smoke-auth-phase0.mjs
git commit -m "feat(auth): открытая регистрация — общий код убран, email регистронезависим, дубль ловится индексом"
```

---

### Task 3: Пробный период

**Files:**
- Modify: `app/api/onboarding/start/route.js` (бэкап → `/opt/agentsDB/backups/onboarding-start-route.js.bak-2026-08-06p2`)
- Modify: `app/onboarding/page.js:74-85` (бэкап → `/opt/agentsDB/backups/onboarding-page.js.bak-2026-08-06p2`)
- Modify: `app/cabinets/[id]/layout.js:68-77, 93-96` (бэкап → `/opt/agentsDB/backups/cabinet-layout.js.bak-2026-08-06p2`)

**Interfaces:**
- Consumes: колонка `auth.cabinets.trial_ends_at` (уже в схеме, `001_tenant_core.sql`), у существующих кабинетов `NULL` — баннер им не показывается.
- Produces: `POST /api/onboarding/start` → `{ ok, cabinet: { cabinet_id, display_name, status, trial_ends_at } }`; баннер в шапке кабинета.

- [ ] **Step 1: Онбординг ставит срок**

В `app/api/onboarding/start/route.js` после константы `BACKFILL_DAYS` (строка 16) добавить:

```js
// Пробный период нового кабинета. Доступ по истечении НЕ блокируется —
// блокировка появится вместе с оплатой подписки (отдельная спека).
const TRIAL_DAYS = Number(process.env.SAAS_TRIAL_DAYS) || 14;
```

Заменить INSERT кабинета (строки 47-52):

```js
    const { rows } = await cl.query(
      `INSERT INTO auth.cabinets (owner_user_id, display_name, marketplaces, tax_mode, status, trial_ends_at)
       VALUES ($1, $2, $3, $4, 'active', now() + make_interval(days => $5))
       RETURNING cabinet_id, display_name, status, trial_ends_at`,
      [userId, displayName, marketplaces, JSON.stringify(taxMode), TRIAL_DAYS]
    );
```

- [ ] **Step 2: Онбординг не проглатывает ошибку добавления магазина**

В `app/onboarding/page.js` заменить цикл добавления магазинов (строки 74-85):

```js
      // Добавляем магазины с налоговым режимом. Ошибку не проглатываем:
      // проект уже создан, но без магазина данные собираться не будут.
      for (const s of shops) {
        const shopR = await fetch(`/api/cabinets/${cabinetId}/shops`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mp_code: s.mp_code,
            shop_name: s.shop_name,
            legal_name: s.legal_name,
            tax_mode: s.tax,
            api_creds: { [s.mp_code]: s.creds },
          }),
        });
        if (!shopR.ok) {
          const d = await shopR.json().catch(() => ({}));
          setErr(`Проект создан, но магазин «${s.shop_name || s.mp_code}» не добавлен: ${d.error || 'ошибка сервера'}. Добавьте его в настройках проекта.`);
          return;
        }
      }
```

- [ ] **Step 3: Баннер в шапке кабинета**

В `app/cabinets/[id]/layout.js` расширить запрос кабинета (строки 68-73):

```js
  const mem = await query(
    `SELECT c.display_name, c.marketplaces, c.trial_ends_at
     FROM auth.memberships m
     JOIN auth.cabinets c ON c.cabinet_id = m.cabinet_id
     WHERE m.user_id = $1 AND m.cabinet_id = $2`,
    [session.user_id, cabinetId]
  );
```

После `const basePath = ...` (строка 78) добавить расчёт:

```js
  // Пробный период: показываем срок, доступ не ограничиваем (оплата — отдельно).
  // У кабинетов, созданных до фазы 2, trial_ends_at = NULL — баннера нет.
  const trialEnds = cab.trial_ends_at ? new Date(cab.trial_ends_at) : null;
  const trialDaysLeft = trialEnds ? Math.ceil((trialEnds - Date.now()) / 86400000) : null;
  const trialText = !trialEnds ? null
    : trialDaysLeft > 0
      ? `Пробный период — осталось ${trialDaysLeft} дн. (до ${trialEnds.toLocaleDateString('ru-RU')})`
      : `Пробный период закончился ${trialEnds.toLocaleDateString('ru-RU')}`;
```

И в разметке — сразу после `</header>`, перед `<main className="main">`:

```jsx
      {trialText && (
        <div style={{
          padding: "8px 16px", textAlign: "center", fontSize: 13,
          background: trialDaysLeft > 0 ? "rgba(255,193,7,.12)" : "rgba(255,107,107,.12)",
          color: trialDaysLeft > 0 ? "var(--warn, #d9a400)" : "var(--neg, #ff6b6b)",
          borderBottom: "1px solid var(--border)",
        }}>
          {trialText}
        </div>
      )}
```

- [ ] **Step 4: Верификация**

```bash
cd /opt/agents/saas && npm run build && (npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase2.mjs http://localhost:3210
node scripts/smoke-auth-phase1.mjs http://localhost:3210
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected фаза 2: PASS всё, кроме лимитов и next-с-query (задача 4). Фазы 1 и 0: ALL PASS. Убить процесс на 3210.

- [ ] **Step 5: Commit**

```bash
git add app/api/onboarding/start/route.js app/onboarding/page.js "app/cabinets/[id]/layout.js"
git commit -m "feat(auth): пробный период 14 дней — срок при онбординге, баннер в шапке, ошибка магазина видна"
```

---

### Task 4: Ограничение попыток, сохранение next, продление сессии

**Files:**
- Create: `lib/rate-limit.js`
- Modify: `app/api/auth/login/route.js` (бэкап → `/opt/agentsDB/backups/login-route.js.bak-2026-08-06p2`)
- Modify: `app/api/auth/register/route.js` (бэкап → `/opt/agentsDB/backups/register-route.js.bak-2026-08-06p2-rl`)
- Modify: `middleware.js:27-31` (бэкап → `/opt/agentsDB/backups/middleware.js.bak-2026-08-06p2`)
- Modify: `lib/session.js` (бэкап → `/opt/agentsDB/backups/lib-session.js.bak-2026-08-06p2`)
- Modify: `lib/withCabinet.js` (бэкап → `/opt/agentsDB/backups/lib-withCabinet.js.bak-2026-08-06p2`)

**Interfaces:**
- Produces: `lib/rate-limit.js` экспортирует `clientIp(req) → string`, `peek(key, limit) → { limited, retryAfter }` (не считает), `hit(key, limit) → { limited, retryAfter }` (считает), `reset(key)`; `LIMITS = { loginAccount, loginIp, registerIp }`. `lib/session.js` экспортирует `touchSession(session)`.
- Consumes: `getSession` (login/register уже используют), `withCabinet` вызывает `touchSession` после проверки membership.

- [ ] **Step 1: Счётчик попыток**

`lib/rate-limit.js`:

```js
// lib/rate-limit.js — счётчик попыток в памяти процесса (панель — один инстанс
// Next, внешних зависимостей не заводим). Скользящее окно в 1 минуту.
// Перезапуск сервиса обнуляет счётчики — приемлемо: защищаемся от скриптового
// перебора, а не от терпеливого распределённого.
const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;
const buckets = new Map(); // key → { count, resetAt }

export const LIMITS = {
  loginAccount: Number(process.env.SAAS_RL_LOGIN_ACCOUNT) || 5,   // неудачных входов в минуту на аккаунт
  loginIp: Number(process.env.SAAS_RL_LOGIN_IP) || 20,            // неудачных входов в минуту с IP
  registerIp: Number(process.env.SAAS_RL_REGISTER_IP) || 30,      // регистраций в минуту с IP
};

function prune(now) {
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

// Реальный IP: Caddy проксирует на localhost и проставляет X-Forwarded-For.
export function clientIp(req) {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'local';
}

// Проверить лимит, НЕ увеличивая счётчик.
export function peek(key, limit) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) return { limited: false, retryAfter: 0 };
  if (b.count >= limit) return { limited: true, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  return { limited: false, retryAfter: 0 };
}

// Засчитать попытку.
export function hit(key, limit) {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) prune(now);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { limited: false, retryAfter: 0 };
  }
  b.count += 1;
  if (b.count > limit) return { limited: true, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  return { limited: false, retryAfter: 0 };
}

export function reset(key) { buckets.delete(key); }
```

- [ ] **Step 2: Вход — лимит на неудачные попытки**

Заменить `app/api/auth/login/route.js` целиком:

```js
// POST /api/auth/login { email, password } → логин, возвращает куда идти дальше.
import { NextResponse } from 'next/server';
import { loginUser, firstCabinetOf } from '@/lib/auth.js';
import { getSession } from '@/lib/session.js';
import { clientIp, peek, hit, reset, LIMITS } from '@/lib/rate-limit.js';

const tooMany = (retryAfter) => NextResponse.json(
  { error: 'Слишком много попыток входа. Попробуйте через минуту.' },
  { status: 429, headers: { 'Retry-After': String(retryAfter || 60) } }
);

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }

  const email = String(body?.email || '').trim().toLowerCase();
  const ip = clientIp(req);
  const acctKey = `login:acct:${email}`;
  const ipKey = `login:ip:${ip}`;

  // Считаем только НЕУДАЧНЫЕ попытки: успешный вход лимит не расходует,
  // иначе рабочий день в общем офисе (один внешний IP) упирался бы в потолок.
  const acct = peek(acctKey, LIMITS.loginAccount);
  if (acct.limited) return tooMany(acct.retryAfter);
  const byIp = peek(ipKey, LIMITS.loginIp);
  if (byIp.limited) return tooMany(byIp.retryAfter);

  try {
    const result = await loginUser({ email, password: body?.password });
    if (!result) {
      hit(acctKey, LIMITS.loginAccount);
      hit(ipKey, LIMITS.loginIp);
      console.warn('[login] неудачная попытка', email, 'ip', ip);
      return NextResponse.json({ error: 'Неверный email или пароль' }, { status: 401 });
    }
    const { user } = result;
    reset(acctKey);
    const cabinet = await firstCabinetOf(user.user_id);
    const session = await getSession();
    session.user_id = user.user_id;
    session.email = user.email;
    session.name = user.name;
    session.active_cabinet_id = cabinet ? cabinet.cabinet_id : null;
    session.touched_at = Date.now();
    await session.save();
    return NextResponse.json({
      ok: true, user,
      active_cabinet_id: session.active_cabinet_id,
      next: cabinet ? '/' : '/onboarding',
    });
  } catch (e) {
    // Заблокированный аккаунт (status != active) — тот же ответ, что и неверный
    // пароль: разный текст позволял бы перебирать существующие аккаунты.
    hit(acctKey, LIMITS.loginAccount);
    hit(ipKey, LIMITS.loginIp);
    console.warn('[login]', e.message, email, 'ip', ip);
    return NextResponse.json({ error: 'Неверный email или пароль' }, { status: 401 });
  }
}
```

- [ ] **Step 3: Регистрация — лимит на IP**

В `app/api/auth/register/route.js` добавить импорт рядом с существующими:

```js
import { clientIp, hit, LIMITS } from '@/lib/rate-limit.js';
```

И в начале `POST`, сразу после разбора `body`:

```js
  const rl = hit(`register:ip:${clientIp(req)}`, LIMITS.registerIp);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Слишком много регистраций подряд. Попробуйте через минуту.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter || 60) } }
    );
  }
```

Также в этом файле проставить `session.touched_at = Date.now();` рядом с остальными полями сессии (перед `await session.save()`).

- [ ] **Step 4: middleware сохраняет query**

В `middleware.js` заменить ветку редиректа (строки 27-31):

```js
    const url = req.nextUrl.clone();
    // Сохраняем и путь, и параметры: без search человек после входа терял
    // фильтры/период, с которыми пришёл по ссылке.
    const target = pathname + req.nextUrl.search;
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', target);
    return NextResponse.redirect(url);
```

- [ ] **Step 5: Продление сессии при активности**

В `lib/session.js` после `getSession` добавить:

```js
// Продление сессии при активности: кука переиздаётся не чаще раза в сутки,
// иначе Set-Cookie шёл бы на каждый запрос. Вызывать ТОЛЬКО из route handlers —
// в серверных компонентах запись cookies запрещена (Next 14).
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

export async function touchSession(session) {
  if (!session?.user_id) return;
  const now = Date.now();
  if (session.touched_at && now - session.touched_at < TOUCH_AFTER_MS) return;
  session.touched_at = now;
  await session.save();
}
```

В `lib/withCabinet.js` заменить строку 22:

```js
import { getSession, touchSession } from '@/lib/session.js';
```

и сразу после успешной проверки membership (после блока `if (!mem.length) return ...`, перед запросом магазинов) добавить:

```js
    // Активность пользователя — продлеваем сессию (не чаще раза в сутки).
    await touchSession(session);
```

- [ ] **Step 6: Верификация**

```bash
cd /opt/agents/saas && npm run build && (npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase2.mjs http://localhost:3210
node scripts/smoke-auth-phase1.mjs http://localhost:3210
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected: все три — ALL PASS. Если фаза 1 или 0 упрётся в лимит регистраций (30/мин с одного IP при трёх наборах подряд) — подождать минуту и перегнать; если повторяется, это реальная находка, сообщить в отчёте. Убить процесс на 3210.

- [ ] **Step 7: Commit**

```bash
git add lib/rate-limit.js app/api/auth/login/route.js app/api/auth/register/route.js middleware.js lib/session.js lib/withCabinet.js
git commit -m "feat(sec): лимит попыток входа и регистрации, next с параметрами, продление сессии при активности"
```

---

### Task 5: Деплой и проверка на проде

**Files:** нет правок кода.

- [ ] **Step 1: Сборка и рестарт**

```bash
cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 5 && systemctl is-active saas-web
```

Expected: `active`.

- [ ] **Step 2: Все три смоука против прода**

```bash
node scripts/smoke-auth-phase2.mjs http://localhost:3200
node scripts/smoke-auth-phase1.mjs http://localhost:3200
node scripts/smoke-auth-phase0.mjs http://localhost:3200
```

Expected: ALL PASS во всех трёх.

- [ ] **Step 3: Проверка миграции на проде**

```bash
psql -h localhost -U postgres -d saas -Atc "select indexname from pg_indexes where schemaname='auth' and indexname='users_email_lower_uniq'"
```

Expected: `users_email_lower_uniq`.

- [ ] **Step 4: Сообщить владельцу**

Регистрация открыта: `https://sysell.ru/register` доступен всем, новый кабинет получает 14 дней пробного периода с баннером в шапке. Существующие кабинеты (в т.ч. его собственные) — без баннера, `trial_ends_at` у них `NULL`. Блокировки по истечении пока нет — это спека оплаты.
