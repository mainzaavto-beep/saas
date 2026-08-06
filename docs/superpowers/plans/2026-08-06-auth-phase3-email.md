# Фаза 3 auth-редизайна: почта, подтверждение email, сброс пароля — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Клиент может подтвердить свой email и восстановить забытый пароль письмом; смена пароля выкидывает все чужие сессии (фаза 3 спеки `docs/superpowers/specs/2026-08-06-auth-flow-design.md`).

**Architecture:** Транспорт писем — nodemailer поверх SMTP из env. **SMTP-креды у владельца пока нет**, поэтому вводим режим «почтовая раковина» (`SAAS_MAIL_SINK=1`): письмо пишется файлом в `/tmp/saas-mail/` и логируется, панель при этом работает и флоу тестируется; когда креды появятся — флаг убирается, письма идут по-настоящему, код не меняется. Одноразовые токены хранятся только SHA-256-хэшем (`auth.user_tokens`). Серверная инвалидация сессий — счётчик `auth.users.session_version`, который сверяется в уже существующих запросах membership (лишних обращений к БД нет). Гейт «без подтверждения нельзя подключать API-ключи МП и звать команду» ставится за флагом `SAAS_REQUIRE_VERIFIED_EMAIL`, выключенным до появления SMTP: иначе новый клиент не сможет завершить онбординг, не получив письма.

**Tech Stack:** Next.js 14 (app router), nodemailer, node:crypto, PostgreSQL (миграции `db/migrations/0NN_*.sql`), iron-session, systemd (`saas-web.service`).

## Global Constraints

- Прод-хост = репозиторий `/opt/agents/saas`, ветка master, remote нет.
- **ЗАПРЕЩЕНО `next dev` в каталоге прода** (затирает `.next`, роняет прод — правило AGENTS.md). Верификация: `npm run build && (npx next start -p 3210 &)`, после — убить процесс **только на 3210** (на 3200 живёт прод).
- Деплой (только задача 5): `npm run build && systemctl restart saas-web`.
- Backup боевого файла перед правкой → `/opt/agentsDB/backups/<имя>.bak-2026-08-06p3`.
- Верификаторы: `scripts/smoke-auth-phase3.mjs` (задача 1) + регресс `smoke-auth-phase2.mjs`, `smoke-auth-phase1.mjs`, `smoke-auth-phase0.mjs`. Все сами готовят/чистят данные (`*@smoke.test`, прямой SQL под ролью postgres из `~/.pgpass`); `CLEANUP FAIL` = провал. **Тестовые записи в боевой БД оставлять нельзя.**
- Миграции идемпотентны, нумерация продолжается с `033_`; новым таблицам — явный `GRANT` для `saas_app` (роль приложения; DDL и DELETE у неё нет).
- Токены: в БД только `sha256(token)`, сам токен — только в письме. Сроки: подтверждение email — 7 дней, сброс пароля — 1 час. Одноразовые; выдача нового гасит прежние того же вида.
- Ответ `/api/auth/forgot` одинаков для существующего и несуществующего адреса (без раскрытия наличия аккаунта).
- Комментарии и UI-тексты — по-русски. Каждая задача — отдельный коммит с префиксом из задачи.

---

### Task 1: Смоук-скрипт фазы 3 (красный)

**Files:**
- Create: `scripts/smoke-auth-phase3.mjs`

**Interfaces:**
- Produces: `node scripts/smoke-auth-phase3.mjs http://localhost:3210` — PASS/FAIL построчно, exit 0 только если всё PASS и уборка чистая. Читает письма из `/tmp/saas-mail/` (раковина), чтобы достать токен.
- Consumes: сервер панели (прод-сборка на 3210), `.env.local`, `~/.pgpass`.

- [ ] **Step 1: Написать скрипт**

```js
#!/usr/bin/env node
// scripts/smoke-auth-phase3.mjs — смоук фазы 3: подтверждение email, сброс
// пароля, серверная инвалидация сессий.
// Использование: node scripts/smoke-auth-phase3.mjs [base_url]
// Токены берёт из «почтовой раковины» /tmp/saas-mail (SAAS_MAIL_SINK=1) —
// пока SMTP не настроен, письма пишутся туда файлами.
import pg from 'pg';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const { types } = pg;
types.setTypeParser(20, (v) => v === null ? null : Number(v));
types.setTypeParser(1700, (v) => v === null ? null : Number(v));

const BASE = process.argv[2] || 'http://localhost:3210';
const SINK_DIR = '/tmp/saas-mail';
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
const note = (msg) => console.log(`NOTE  ${msg}`);

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
  return { status: res.status, json, setCookie, cookie: setCookie.split(';')[0] || cookie };
}

// Последнее письмо для адреса из раковины: возвращает текст или null.
function lastMailFor(email) {
  if (!existsSync(SINK_DIR)) return null;
  const files = readdirSync(SINK_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => `${SINK_DIR}/${f}`)
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const body = readFileSync(files[i], 'utf8');
    if (body.includes(email)) return body;
  }
  return null;
}
const tokenFrom = (mailBody, path) => {
  const m = mailBody && mailBody.match(new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
};

const run = Date.now();
const email = `verify-${run}@smoke.test`;
const PASS1 = 'smoke-pass-123';
const PASS2 = 'smoke-pass-456';
let cabinetId = null, userId = null;

try {
  if (process.env.SAAS_MAIL_SINK !== '1' && !process.env.SAAS_SMTP_HOST) {
    console.error('Ни SAAS_MAIL_SINK=1, ни SAAS_SMTP_HOST не заданы — писем не будет, смоук бессмысленен');
    process.exit(2);
  }

  // ── 1. Регистрация: email не подтверждён, письмо ушло ──
  const reg = await api('POST', '/api/auth/register', { body: { email, password: PASS1, first_name: 'Проверка' } });
  check('регистрация: 200', reg.status === 200, `got ${reg.status} ${JSON.stringify(reg.json)}`);
  userId = reg.json?.user?.user_id;
  const u1 = (await q(`SELECT email_verified_at, session_version FROM auth.users WHERE user_id = $1`, [userId]))[0];
  check('email не подтверждён при регистрации', u1 && u1.email_verified_at === null, JSON.stringify(u1));
  check('session_version = 1', u1?.session_version === 1, String(u1?.session_version));
  const mail1 = lastMailFor(email);
  check('письмо с подтверждением создано', !!mail1, 'нет письма в раковине');
  const vToken = tokenFrom(mail1, '/verify');
  check('в письме ссылка /verify?token=', !!vToken, String(mail1 && mail1.slice(0, 120)));
  const tokRow = vToken ? (await q(`SELECT kind, used_at FROM auth.user_tokens WHERE user_id = $1 AND kind = 'verify_email'`, [userId]))[0] : null;
  check('токен лежит в БД непогашенным', !!tokRow && tokRow.used_at === null, JSON.stringify(tokRow));
  check('сырой токен в БД не хранится', !!vToken && !(await q(`SELECT 1 FROM auth.user_tokens WHERE token_hash = $1`, [vToken])).length);

  // ── 2. Подтверждение по токену ──
  const ver = await api('POST', '/api/auth/verify', { body: { token: vToken } });
  check('подтверждение: 200', ver.status === 200, `got ${ver.status} ${JSON.stringify(ver.json)}`);
  const u2 = (await q(`SELECT email_verified_at FROM auth.users WHERE user_id = $1`, [userId]))[0];
  check('email_verified_at проставлен', !!u2?.email_verified_at, JSON.stringify(u2));

  // ── 3. Повторное использование токена отклоняется ──
  const ver2 = await api('POST', '/api/auth/verify', { body: { token: vToken } });
  check('повторное подтверждение: 400', ver2.status === 400, `got ${ver2.status}`);

  // ── 4. Онбординг (нужен кабинет для проверок сессии) ──
  const onb = await api('POST', '/api/onboarding/start', { cookie: reg.cookie, body: { display_name: `smoke-p3-${run}`, marketplaces: ['wb'] } });
  check('онбординг: 200', onb.status === 200, `got ${onb.status} ${JSON.stringify(onb.json)}`);
  cabinetId = onb.json?.cabinet?.cabinet_id;

  // ── 5. Гейт «без подтверждения нельзя звать команду» ──
  // Активен только при SAAS_REQUIRE_VERIFIED_EMAIL=1 (включается вместе с SMTP).
  const gateOn = process.env.SAAS_REQUIRE_VERIFIED_EMAIL === '1';
  const unvEmail = `unverified-${run}@smoke.test`;
  const unv = await api('POST', '/api/auth/register', { body: { email: unvEmail, password: PASS1 } });
  const unvOnb = await api('POST', '/api/onboarding/start', { cookie: unv.cookie, body: { display_name: `smoke-p3u-${run}`, marketplaces: ['wb'] } });
  const unvCab = unvOnb.json?.cabinet?.cabinet_id;
  const inviteTry = await api('POST', `/api/cabinets/${unvCab}/invites`, { cookie: unv.cookie, body: { role: 'viewer' } });
  if (gateOn) {
    check('неподтверждённый не может создать инвайт: 403 email_unverified',
      inviteTry.status === 403 && inviteTry.json?.code === 'email_unverified', `${inviteTry.status} ${JSON.stringify(inviteTry.json)}`);
  } else {
    check('гейт выключен — инвайт создаётся: 200', inviteTry.status === 200, `${inviteTry.status} ${JSON.stringify(inviteTry.json)}`);
    note('SAAS_REQUIRE_VERIFIED_EMAIL не выставлен — гейт подтверждения email НЕ проверен (включить вместе с SMTP)');
  }
  if (unvCab) {
    await q(`DELETE FROM auth.invitations WHERE cabinet_id = $1`, [unvCab]).catch(() => {});
    await q(`DELETE FROM jobs.collect_jobs WHERE cabinet_id = $1`, [unvCab]).catch(() => {});
    await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [unvCab]).catch(() => {});
    await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [unvCab]).catch(() => {});
  }

  // ── 6. Забыли пароль: одинаковый ответ для существующего и нет ──
  const f1 = await api('POST', '/api/auth/forgot', { body: { email } });
  const f2 = await api('POST', '/api/auth/forgot', { body: { email: `nobody-${run}@smoke.test` } });
  check('forgot для существующего: 200', f1.status === 200, `got ${f1.status}`);
  check('forgot для несуществующего: тот же ответ', f2.status === f1.status && JSON.stringify(f2.json) === JSON.stringify(f1.json), `${f2.status} ${JSON.stringify(f2.json)}`);
  const mailR = lastMailFor(email);
  const rToken = tokenFrom(mailR, '/reset');
  check('письмо со ссылкой /reset?token=', !!rToken, String(mailR && mailR.slice(0, 120)));
  check('несуществующему письмо не отправлено', !lastMailFor(`nobody-${run}@smoke.test`));

  // ── 7. Сброс пароля: новый пароль работает, старая сессия мертва ──
  const beforeSessions = await api('GET', `/api/cabinets/${cabinetId}/me`, { cookie: reg.cookie });
  check('до сброса старая сессия жива', beforeSessions.status === 200, `got ${beforeSessions.status}`);
  const rst = await api('POST', '/api/auth/reset', { body: { token: rToken, password: PASS2 } });
  check('сброс пароля: 200', rst.status === 200, `got ${rst.status} ${JSON.stringify(rst.json)}`);
  const afterSessions = await api('GET', `/api/cabinets/${cabinetId}/me`, { cookie: reg.cookie });
  check('после сброса старая сессия мертва: 401', afterSessions.status === 401, `got ${afterSessions.status}`);
  const oldLogin = await api('POST', '/api/auth/login', { body: { email, password: PASS1 } });
  check('старый пароль больше не подходит: 401', oldLogin.status === 401, `got ${oldLogin.status}`);
  const newLogin = await api('POST', '/api/auth/login', { body: { email, password: PASS2 } });
  check('новый пароль работает: 200', newLogin.status === 200, `got ${newLogin.status}`);
  const u3 = (await q(`SELECT session_version FROM auth.users WHERE user_id = $1`, [userId]))[0];
  check('session_version увеличен', u3?.session_version === 2, String(u3?.session_version));

  // ── 8. Токен сброса одноразовый ──
  const rst2 = await api('POST', '/api/auth/reset', { body: { token: rToken, password: 'smoke-pass-789' } });
  check('повторный сброс тем же токеном: 400', rst2.status === 400, `got ${rst2.status}`);
} finally {
  const cf = (e) => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; };
  if (cabinetId) {
    await q(`DELETE FROM auth.invitations WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM jobs.collect_jobs WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
    await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  }
  await q(`DELETE FROM auth.user_tokens WHERE user_id IN (SELECT user_id FROM auth.users WHERE email LIKE $1)`, [`%-${run}@smoke.test`]).catch(cf);
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

- [ ] **Step 2: Красный прогон**

Раковина ещё не существует и `SAAS_MAIL_SINK` в `.env.local` не задан — скрипт на этом сознательно выходит с кодом 2 («писем не будет»). Это и есть красный результат задачи 1: убедись, что скрипт печатает сообщение и выходит 2, а не падает трассировкой.

```bash
cd /opt/agents/saas && node scripts/smoke-auth-phase3.mjs http://localhost:3200
echo "exit=$?"
```

Expected: сообщение «Ни SAAS_MAIL_SINK=1, ни SAAS_SMTP_HOST не заданы…», `exit=2`.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-auth-phase3.mjs
git commit -m "test(auth): смоук фазы 3 — подтверждение email, сброс пароля, инвалидация сессий"
```

---

### Task 2: Схема, токены, почта

**Files:**
- Create: `db/migrations/033_email_verify_tokens.sql`
- Create: `lib/tokens.js`
- Create: `lib/mailer.js`
- Modify: `package.json` (зависимость `nodemailer`)
- Modify: `.env.local` — добавить `SAAS_MAIL_SINK=1` (файл вне git; SMTP-креды придут позже)

**Interfaces:**
- Produces: `createToken(userId, kind) → Promise<string>` (сырой токен, в БД только хэш; гасит прежние того же вида), `consumeToken(token, kind) → Promise<number|null>` (одноразовое погашение → user_id), `TOKEN_TTL_MIN = { verify_email: 10080, reset_password: 60 }`; `sendMail({ to, subject, text }) → Promise<{ ok, error?, sink? }>`; таблица `auth.user_tokens`, колонки `auth.users.email_verified_at`, `auth.users.session_version`.
- Consumes: `query` из `@/lib/db.js`.

- [ ] **Step 1: Миграция**

`db/migrations/033_email_verify_tokens.sql`:

```sql
-- 033: подтверждение email, серверная инвалидация сессий, одноразовые токены.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 1;

-- Существующие пользователи (регистрировались до фазы 3) считаются подтверждёнными.
-- Условие по дате делает повторный прогон миграции безопасным: новых
-- неподтверждённых пользователей backfill не тронет.
UPDATE auth.users
   SET email_verified_at = created_at
 WHERE email_verified_at IS NULL
   AND created_at < timestamptz '2026-08-07 00:00:00+03';

-- Одноразовые токены. В БД только SHA-256 от токена: сам токен живёт в письме.
CREATE TABLE IF NOT EXISTS auth.user_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES auth.users(user_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('verify_email','reset_password')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_tokens_live_idx
  ON auth.user_tokens (user_id, kind) WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON auth.user_tokens TO saas_app;
```

Применить: `psql -h localhost -U postgres -d saas -f db/migrations/033_email_verify_tokens.sql`
Проверить: `psql -h localhost -U postgres -d saas -Atc "select count(*) from auth.users where email_verified_at is null"` → `0` (все существующие подтверждены).

- [ ] **Step 2: Зависимость nodemailer**

```bash
cd /opt/agents/saas && npm install nodemailer@9.0.4 --save
```

(Ставится ровно эта версия; `package.json` и `package-lock.json` идут в коммит.)

- [ ] **Step 3: `lib/tokens.js`**

```js
// lib/tokens.js — одноразовые токены для писем (подтверждение email, сброс пароля).
// В БД хранится только SHA-256 от токена: утечка дампа не даёт войти по ссылке.
import crypto from 'node:crypto';
import { query } from './db.js';

// Срок жизни в минутах. Подтверждение живёт неделю, сброс пароля — час.
export const TOKEN_TTL_MIN = { verify_email: 7 * 24 * 60, reset_password: 60 };

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// Выдать токен. Прежние живые токены того же вида гасим — действующим должен
// остаться ровно один (иначе старое письмо продолжало бы работать).
export async function createToken(userId, kind) {
  const ttl = TOKEN_TTL_MIN[kind];
  if (!ttl) throw new Error('Неизвестный вид токена: ' + kind);
  await query(
    `UPDATE auth.user_tokens SET used_at = now()
     WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`,
    [userId, kind]
  );
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO auth.user_tokens (token_hash, user_id, kind, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [hashToken(token), userId, kind, ttl]
  );
  return token;
}

// Погасить токен. Возвращает user_id или null (не найден / погашен / просрочен).
// Погашение и проверка — одним UPDATE: два одновременных перехода по ссылке
// не смогут сработать оба.
export async function consumeToken(token, kind) {
  if (!token) return null;
  const rows = await query(
    `UPDATE auth.user_tokens SET used_at = now()
     WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashToken(token), kind]
  );
  return rows.length ? rows[0].user_id : null;
}
```

- [ ] **Step 4: `lib/mailer.js`**

```js
// lib/mailer.js — отправка писем. SMTP-креды в .env.local:
//   SAAS_SMTP_HOST / SAAS_SMTP_PORT / SAAS_SMTP_USER / SAAS_SMTP_PASS / SAAS_SMTP_FROM
// Пока кредов нет, работает «раковина» (SAAS_MAIL_SINK=1): письмо пишется файлом
// в /tmp/saas-mail и логируется — панель работает, флоу проверяем смоуком.
// Когда SMTP появится, флаг убирается, код не меняется.
import nodemailer from 'nodemailer';
import { mkdirSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';

const SINK_DIR = '/tmp/saas-mail';
let _transport = null;

function transport() {
  if (_transport) return _transport;
  const host = process.env.SAAS_SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SAAS_SMTP_PORT) || 465;
  _transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: process.env.SAAS_SMTP_USER
      ? { user: process.env.SAAS_SMTP_USER, pass: process.env.SAAS_SMTP_PASS }
      : undefined,
  });
  return _transport;
}

export async function sendMail({ to, subject, text }) {
  const tx = transport();
  if (!tx) {
    if (process.env.SAAS_MAIL_SINK === '1') {
      try {
        mkdirSync(SINK_DIR, { recursive: true });
        const file = `${SINK_DIR}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
        writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${text}\n`, { mode: 0o600 });
        console.warn('[mailer] SMTP не настроен — письмо записано в', file);
        return { ok: true, sink: file };
      } catch (e) {
        console.error('[mailer] раковина недоступна:', e.message);
        return { ok: false, error: e.message };
      }
    }
    console.error('[mailer] SMTP не настроен, письмо не отправлено:', subject, '→', to);
    return { ok: false, error: 'Почта не настроена' };
  }
  try {
    await tx.sendMail({
      from: process.env.SAAS_SMTP_FROM || 'no-reply@sysell.ru',
      to, subject, text,
    });
    return { ok: true };
  } catch (e) {
    console.error('[mailer]', e.message);
    return { ok: false, error: e.message };
  }
}
```

- [ ] **Step 5: `.env.local`** — добавить строку `SAAS_MAIL_SINK=1` (остальное не трогать).

- [ ] **Step 6: Верификация**

Проверка транспорта и токенов без сервера — одноразовым скриптом (после проверки удалить, в коммит не класть):

```bash
cd /opt/agents/saas && node --input-type=module -e "
process.env.SAAS_MAIL_SINK='1';
const { sendMail } = await import('./lib/mailer.js');
const r = await sendMail({ to: 'check@smoke.test', subject: 'проверка', text: 'ссылка https://sysell.ru/verify?token=ABC' });
console.log('mailer:', r.ok, r.sink);
"
```

Expected: `mailer: true /tmp/saas-mail/...txt`, файл существует и содержит ссылку. Затем удалить созданный файл.

Проверка токенов против БД:

```bash
cd /opt/agents/saas && node --input-type=module -e "
import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^([A-Z_0-9]+)=(.*)$/); if(m) process.env[m[1]]=m[2]; }
const { createToken, consumeToken } = await import('./lib/tokens.js');
const { query } = await import('./lib/db.js');
const u = (await query(\"INSERT INTO auth.users (email, password_hash) VALUES ('tok-check@smoke.test','x') RETURNING user_id\"))[0].user_id;
const t1 = await createToken(u, 'verify_email');
const t2 = await createToken(u, 'verify_email');
console.log('первый погашен выдачей второго:', await consumeToken(t1,'verify_email') === null);
console.log('второй работает:', await consumeToken(t2,'verify_email') === u);
console.log('повторно не работает:', await consumeToken(t2,'verify_email') === null);
console.log('чужой вид не подходит:', await consumeToken(t2,'reset_password') === null);
process.exit(0);
"
```

Expected: четыре `true`. **Уборка обязательна** (у `saas_app` нет DELETE, поэтому под postgres):

```bash
psql -h localhost -U postgres -d saas -c "DELETE FROM auth.user_tokens WHERE user_id IN (SELECT user_id FROM auth.users WHERE email='tok-check@smoke.test'); DELETE FROM auth.users WHERE email='tok-check@smoke.test';"
psql -h localhost -U postgres -d saas -Atc "select count(*) from auth.users where email like '%@smoke.test'"
```

Expected: последняя команда → `0`.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/033_email_verify_tokens.sql lib/tokens.js lib/mailer.js package.json package-lock.json
git commit -m "feat(auth): схема подтверждения email и токенов, отправка писем (SMTP + раковина)"
```

---

### Task 3: Подтверждение email

**Files:**
- Create: `app/api/auth/verify/route.js`
- Create: `app/api/auth/verify/resend/route.js`
- Create: `app/verify/page.js`
- Modify: `app/api/auth/register/route.js` (бэкап → `/opt/agentsDB/backups/register-route.js.bak-2026-08-06p3`)
- Modify: `lib/withCabinet.js` (бэкап → `/opt/agentsDB/backups/lib-withCabinet.js.bak-2026-08-06p3`)
- Modify: `app/api/cabinets/[id]/invites/route.js` (бэкап → `/opt/agentsDB/backups/cabinets-invites-route.js.bak-2026-08-06p3`)
- Modify: `app/api/cabinets/[id]/shops/route.js` (бэкап → `/opt/agentsDB/backups/shops-route.js.bak-2026-08-06p3`)
- Modify: `middleware.js` (бэкап → `/opt/agentsDB/backups/middleware.js.bak-2026-08-06p3`)
- Modify: `app/cabinets/[id]/layout.js` (бэкап → `/opt/agentsDB/backups/cabinet-layout.js.bak-2026-08-06p3`)

**Interfaces:**
- Consumes: `createToken`/`consumeToken` (задача 2), `sendMail` (задача 2), `query` из `@/lib/db.js`.
- Produces: `POST /api/auth/verify {token}` → 200 `{ok:true}` | 400 `{error}`; `POST /api/auth/verify/resend` (по сессии) → 200 `{ok:true}` | 401 | 429 | 500; публичная страница `/verify?token=`; `withCabinet` кладёт в `ctx.user = { email_verified_at, session_version }` и поддерживает `opts.requireVerifiedEmail`; баннер «подтвердите почту» в шапке кабинета.

- [ ] **Step 1: Письмо при регистрации**

В `app/api/auth/register/route.js` добавить импорты:

```js
import { createToken } from '@/lib/tokens.js';
import { sendMail } from '@/lib/mailer.js';
```

Перед формированием сессии (после успешного `registerUser` и блока приёма инвайта) вставить:

```js
    // Приглашённый переходил по персональной ссылке из своей почты — адрес
    // считаем подтверждённым сразу. Остальным шлём письмо; сбой почты
    // регистрацию не отменяет (человек уже внутри, письмо перезапросит сам).
    if (invite) {
      await query(`UPDATE auth.users SET email_verified_at = now() WHERE user_id = $1`, [user.user_id]);
    } else {
      try {
        const token = await createToken(user.user_id, 'verify_email');
        const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';
        await sendMail({
          to: user.email,
          subject: 'Подтвердите почту в SySell',
          text: `Здравствуйте!\n\nПодтвердите адрес, чтобы подключать магазины и приглашать сотрудников:\n${base}/verify?token=${token}\n\nСсылка действует 7 дней. Если вы не регистрировались — просто удалите это письмо.`,
        });
      } catch (e) {
        console.error('[register] письмо с подтверждением не ушло:', e.message);
      }
    }
```

- [ ] **Step 2: Роут подтверждения**

`app/api/auth/verify/route.js`:

```js
// POST /api/auth/verify { token } — подтвердить адрес по ссылке из письма.
import { NextResponse } from 'next/server';
import { consumeToken } from '@/lib/tokens.js';
import { query } from '@/lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  const userId = await consumeToken(body?.token, 'verify_email');
  if (!userId) {
    return NextResponse.json({ error: 'Ссылка недействительна или устарела. Запросите новую в панели.' }, { status: 400 });
  }
  await query(`UPDATE auth.users SET email_verified_at = now() WHERE user_id = $1`, [userId]);
  return NextResponse.json({ ok: true });
}
```

`app/api/auth/verify/resend/route.js`:

```js
// POST /api/auth/verify/resend — выслать письмо с подтверждением заново.
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session.js';
import { createToken } from '@/lib/tokens.js';
import { sendMail } from '@/lib/mailer.js';
import { query } from '@/lib/db.js';
import { hit } from '@/lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Не чаще раза в минуту на пользователя — письма стоят денег и репутации домена.
  const rl = hit(`verify-resend:user:${session.user_id}`, 1);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Письмо уже отправлено. Проверьте почту и попробуйте через минуту.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter || 60) } }
    );
  }

  const rows = await query(`SELECT email, email_verified_at FROM auth.users WHERE user_id = $1`, [session.user_id]);
  if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (rows[0].email_verified_at) return NextResponse.json({ ok: true, already: true });

  const token = await createToken(session.user_id, 'verify_email');
  const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';
  const res = await sendMail({
    to: rows[0].email,
    subject: 'Подтвердите почту в SySell',
    text: `Подтвердите адрес:\n${base}/verify?token=${token}\n\nСсылка действует 7 дней.`,
  });
  if (!res.ok) {
    return NextResponse.json({ error: 'Не удалось отправить письмо, попробуйте позже.' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Страница `/verify`**

`app/verify/page.js`:

```jsx
'use client';
import { C } from "@/lib/palette.js";
// /verify?token=… — подтверждение адреса по ссылке из письма.
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function VerifyInner() {
  const token = useSearchParams().get('token') || '';
  const [state, setState] = useState('loading'); // loading | ok | error
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!token) { setState('error'); setErr('В ссылке нет токена'); return; }
    fetch('/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.ok) setState('ok');
        else { setState('error'); setErr(d.error || 'Не удалось подтвердить адрес'); }
      })
      .catch(() => { setState('error'); setErr('Сетевая ошибка — обновите страницу'); });
  }, [token]);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "system-ui, sans-serif", display: "flex", justifyContent: "center", alignItems: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 420, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: 32, textAlign: "center" }}>
        {state === 'loading' && <p style={{ color: C.muted }}>Подтверждаем адрес…</p>}
        {state === 'ok' && (<>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Почта подтверждена</h1>
          <p style={{ color: C.muted, fontSize: 14, margin: "0 0 20px" }}>Теперь доступны подключение магазинов и приглашения сотрудников.</p>
          <a href="/" style={{ display: "block", padding: "12px", borderRadius: 8, background: C.accent, color: "#fff", fontWeight: 700, textDecoration: "none" }}>В панель</a>
        </>)}
        {state === 'error' && (<>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Не получилось</h1>
          <p style={{ color: C.muted, fontSize: 14, margin: "0 0 20px" }}>{err}</p>
          <a href="/" style={{ color: C.accent }}>В панель</a>
        </>)}
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return <Suspense fallback={<div style={{ padding: 40, color: "#8a99b8" }}>Загрузка…</div>}><VerifyInner /></Suspense>;
}
```

- [ ] **Step 4: middleware — страница и роут подтверждения публичны**

В `middleware.js`: в `PUBLIC_PATHS` добавить `'/verify'`, в `PUBLIC_API` добавить `'/api/auth/verify'` (именно точный путь: `/api/auth/verify/resend` требует сессии и публичным быть не должен).

Строки становятся:

```js
const PUBLIC_PATHS = ['/', '/login', '/register', '/invite', '/verify'];
const PUBLIC_API = ['/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/auth/verify'];
```

- [ ] **Step 5: `withCabinet` отдаёт статус подтверждения и умеет требовать его**

В `lib/withCabinet.js` заменить membership-запрос (он же станет местом сверки версии сессии в задаче 4):

```js
    const mem = await query(
      `SELECT m.role, c.cabinet_id, c.display_name, c.marketplaces, c.status,
              u.email_verified_at, u.session_version
       FROM auth.memberships m
       JOIN auth.cabinets c ON c.cabinet_id = m.cabinet_id
       JOIN auth.users u ON u.user_id = m.user_id
       WHERE m.user_id = $1 AND m.cabinet_id = $2`,
      [session.user_id, cabinetId]
    );
```

После проверки роли (`requireRole`) добавить:

```js
    // Гейт подтверждения почты. Включается вместе с настроенным SMTP
    // (SAAS_REQUIRE_VERIFIED_EMAIL=1): до этого письма писать некуда, и запрет
    // просто остановил бы онбординг новых клиентов.
    if (opts?.requireVerifiedEmail
        && process.env.SAAS_REQUIRE_VERIFIED_EMAIL === '1'
        && !mem[0].email_verified_at) {
      return NextResponse.json(
        { error: 'Подтвердите почту — мы отправили письмо на ваш адрес.', code: 'email_unverified' },
        { status: 403 }
      );
    }
```

И в вызов handler'а добавить пользователя (строка с `handler(req, { ...ctx, cabinet: ... })`):

```js
      return await withTenant(cabinetId, () =>
        handler(req, {
          ...ctx,
          cabinet: { ...mem[0], shop_names, shopTax },
          user: { email_verified_at: mem[0].email_verified_at, session_version: mem[0].session_version },
        })
      );
```

- [ ] **Step 6: Гейт на приглашениях и ключах МП**

В `app/api/cabinets/[id]/invites/route.js` у `POST` заменить опции на:

```js
}, { requireRole: 'owner', requireVerifiedEmail: true });
```

В `app/api/cabinets/[id]/shops/route.js` — у `POST` и `PUT` (строки с `}, { requireRole: 'owner' });` на 121 и 171 соответственно; `DELETE` не трогать:

```js
}, { requireRole: 'owner', requireVerifiedEmail: true });
```

- [ ] **Step 7: Баннер «подтвердите почту»**

В `app/cabinets/[id]/layout.js` дополнить запрос кабинета полем пользователя:

```js
  const mem = await query(
    `SELECT c.display_name, c.marketplaces, c.trial_ends_at, u.email_verified_at
     FROM auth.memberships m
     JOIN auth.cabinets c ON c.cabinet_id = m.cabinet_id
     JOIN auth.users u ON u.user_id = m.user_id
     WHERE m.user_id = $1 AND m.cabinet_id = $2`,
    [session.user_id, cabinetId]
  );
```

И сразу после баннера триала (блок `{trialText && (...)}`) добавить:

```jsx
      {!cab.email_verified_at && (
        <div style={{
          padding: "8px 16px", textAlign: "center", fontSize: 13,
          background: "rgba(255,193,7,.12)", color: "var(--warn, #d9a400)",
          borderBottom: "1px solid var(--border)",
        }}>
          Подтвердите почту — мы отправили письмо на {session.email}.{" "}
          <a href="/settings" style={{ color: "inherit", textDecoration: "underline" }}>Выслать ещё раз</a>
        </div>
      )}
```

- [ ] **Step 8: Верификация**

```bash
cd /opt/agents/saas && npm run build && (npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase3.mjs http://localhost:3210
node scripts/smoke-auth-phase2.mjs http://localhost:3210
node scripts/smoke-auth-phase1.mjs http://localhost:3210
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected фаза 3: PASS проверки 1-5 (регистрация без подтверждения, письмо, токен, подтверждение, повтор отклонён, гейт-строка со статусом NOTE «гейт выключен»); FAIL проверки 6-8 (forgot/reset — задача 4). Фазы 2, 1, 0: ALL PASS. Убить процесс на 3210.

- [ ] **Step 9: Commit**

```bash
git add app/api/auth/verify app/verify app/api/auth/register/route.js lib/withCabinet.js "app/api/cabinets/[id]/invites/route.js" "app/api/cabinets/[id]/shops/route.js" middleware.js "app/cabinets/[id]/layout.js"
git commit -m "feat(auth): подтверждение email — письмо при регистрации, страница /verify, повторная отправка, баннер и гейт"
```

---

### Task 4: Сброс пароля и инвалидация сессий

**Files:**
- Create: `app/api/auth/forgot/route.js`
- Create: `app/api/auth/reset/route.js`
- Create: `app/forgot/page.js`
- Create: `app/reset/page.js`
- Modify: `lib/withCabinet.js` (сверка версии сессии; бэкап → `/opt/agentsDB/backups/lib-withCabinet.js.bak-2026-08-06p3b`)
- Modify: `app/api/auth/login/route.js` (бэкап → `/opt/agentsDB/backups/login-route.js.bak-2026-08-06p3`)
- Modify: `app/api/auth/register/route.js` (бэкап → `/opt/agentsDB/backups/register-route.js.bak-2026-08-06p3b`)
- Modify: `app/api/profile/route.js` (бэкап → `/opt/agentsDB/backups/profile-route.js.bak-2026-08-06p3`)
- Modify: `app/login/page.js` (бэкап → `/opt/agentsDB/backups/login-page.js.bak-2026-08-06p3`)
- Modify: `middleware.js` (бэкап → `/opt/agentsDB/backups/middleware.js.bak-2026-08-06p3b`)

**Interfaces:**
- Consumes: `createToken`/`consumeToken`, `sendMail`, `hashPassword` из `@/lib/auth.js`, `clientIp`/`hit` из `@/lib/rate-limit.js`.
- Produces: `POST /api/auth/forgot {email}` → всегда 200 `{ok:true}` (429 при переборе); `POST /api/auth/reset {token,password}` → 200 `{ok:true}` | 400 `{error}`; страницы `/forgot`, `/reset`; сессия несёт `sv` (session_version), `withCabinet` отклоняет устаревшие сессии 401.

- [ ] **Step 1: Запрос ссылки**

`app/api/auth/forgot/route.js`:

```js
// POST /api/auth/forgot { email } — выслать ссылку для сброса пароля.
// Ответ одинаков для существующего и несуществующего адреса: иначе форма
// превращается в проверялку «есть ли такой аккаунт».
import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { createToken } from '@/lib/tokens.js';
import { sendMail } from '@/lib/mailer.js';
import { clientIp, hit } from '@/lib/rate-limit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OK = { ok: true, message: 'Если такой аккаунт есть, мы отправили письмо со ссылкой.' };

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  const email = String(body?.email || '').trim().toLowerCase();

  const rl = hit(`forgot:ip:${clientIp(req)}`, 10);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Слишком много запросов. Попробуйте через минуту.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter || 60) } }
    );
  }

  const rows = await query(
    `SELECT user_id, email FROM auth.users WHERE lower(email) = $1 AND status = 'active'`,
    [email]
  );
  if (rows.length) {
    try {
      const token = await createToken(rows[0].user_id, 'reset_password');
      const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';
      await sendMail({
        to: rows[0].email,
        subject: 'Восстановление пароля в SySell',
        text: `Чтобы задать новый пароль, перейдите по ссылке:\n${base}/reset?token=${token}\n\nСсылка действует 1 час и работает один раз. Если вы не запрашивали смену пароля — просто удалите это письмо, пароль останется прежним.`,
      });
    } catch (e) {
      console.error('[forgot]', e.message);
    }
  }
  return NextResponse.json(OK);
}
```

- [ ] **Step 2: Смена пароля по токену**

`app/api/auth/reset/route.js`:

```js
// POST /api/auth/reset { token, password } — задать новый пароль по ссылке.
// Успешная смена поднимает session_version: все ранее выданные куки умирают,
// включая те, что мог унести злоумышленник.
import { NextResponse } from 'next/server';
import { consumeToken } from '@/lib/tokens.js';
import { hashPassword } from '@/lib/auth.js';
import { query } from '@/lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  const password = String(body?.password || '');
  if (password.length < 8) return NextResponse.json({ error: 'Пароль минимум 8 символов' }, { status: 400 });

  const userId = await consumeToken(body?.token, 'reset_password');
  if (!userId) {
    return NextResponse.json({ error: 'Ссылка недействительна или устарела. Запросите новую.' }, { status: 400 });
  }
  await query(
    `UPDATE auth.users
        SET password_hash = $1, session_version = session_version + 1, updated_at = now()
      WHERE user_id = $2`,
    [hashPassword(password), userId]
  );
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Страницы `/forgot` и `/reset`**

`app/forgot/page.js`:

```jsx
'use client';
import { C } from "@/lib/palette.js";
// /forgot — запрос ссылки для сброса пароля.
import { useState } from 'react';

export default function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await fetch('/api/auth/forgot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error || 'Не удалось отправить письмо'); return; }
      setSent(true);
    } catch { setErr('Сетевая ошибка'); }
    finally { setBusy(false); }
  }

  const card = { width: "100%", maxWidth: 400, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: 32 };
  const wrap = { minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "system-ui, sans-serif", display: "flex", justifyContent: "center", alignItems: "center", padding: 20 };

  if (sent) return (
    <div style={wrap}><div style={{ ...card, textAlign: "center" }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Проверьте почту</h1>
      <p style={{ color: C.muted, fontSize: 14, margin: "0 0 20px" }}>Если такой аккаунт есть, мы отправили письмо со ссылкой. Она действует 1 час.</p>
      <a href="/login" style={{ color: C.accent }}>Вернуться ко входу</a>
    </div></div>
  );

  return (
    <div style={wrap}>
      <form onSubmit={submit} style={card}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 4px" }}>Забыли пароль?</h1>
        <p style={{ color: C.muted, fontSize: 14, margin: "0 0 24px" }}>Укажите email — пришлём ссылку для смены пароля</p>
        {err && <div style={{ background: "rgba(255,107,107,.12)", color: C.neg, padding: "10px 14px", borderRadius: 8, fontSize: 14, marginBottom: 16 }}>{err}</div>}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus style={{ width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4 }} />
        </div>
        <button type="submit" disabled={busy} style={{ width: "100%", padding: "12px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: busy ? "default" : "pointer", fontWeight: 700, fontSize: 15, fontFamily: "inherit" }}>
          {busy ? "Отправляем…" : "Прислать ссылку"}
        </button>
        <div style={{ textAlign: "center", marginTop: 16, fontSize: 14, color: C.muted }}>
          Вспомнили? <a href="/login" style={{ color: C.accent }}>Войти</a>
        </div>
      </form>
    </div>
  );
}
```

`app/reset/page.js`:

```jsx
'use client';
import { C } from "@/lib/palette.js";
// /reset?token=… — установка нового пароля по ссылке из письма.
import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function ResetInner() {
  const router = useRouter();
  const token = useSearchParams().get('token') || '';
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (password !== password2) { setErr('Пароли не совпадают'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error || 'Не удалось сменить пароль'); return; }
      router.push('/login?reset=1');
    } catch { setErr('Сетевая ошибка'); }
    finally { setBusy(false); }
  }

  const input = { width: "100%", padding: "10px 12px", background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, color: C.ink, fontSize: 15, marginTop: 4 };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "system-ui, sans-serif", display: "flex", justifyContent: "center", alignItems: "center", padding: 20 }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 400, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: 32 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: "0 0 4px" }}>Новый пароль</h1>
        <p style={{ color: C.muted, fontSize: 14, margin: "0 0 24px" }}>Придумайте пароль — не короче 8 символов</p>
        {err && <div style={{ background: "rgba(255,107,107,.12)", color: C.neg, padding: "10px 14px", borderRadius: 8, fontSize: 14, marginBottom: 16 }}>{err}</div>}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Пароль</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoFocus style={input} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: C.muted }}>Повторите пароль</label>
          <input type="password" value={password2} onChange={e => setPassword2(e.target.value)} required minLength={8} style={{ ...input, border: `1px solid ${password2 && password2 !== password ? C.neg : C.line}` }} />
        </div>
        <button type="submit" disabled={busy} style={{ width: "100%", padding: "12px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: busy ? "default" : "pointer", fontWeight: 700, fontSize: 15, fontFamily: "inherit" }}>
          {busy ? "Сохраняем…" : "Сохранить пароль"}
        </button>
      </form>
    </div>
  );
}

export default function ResetPage() {
  return <Suspense fallback={<div style={{ padding: 40, color: "#8a99b8" }}>Загрузка…</div>}><ResetInner /></Suspense>;
}
```

- [ ] **Step 4: middleware — новые публичные пути**

```js
const PUBLIC_PATHS = ['/', '/login', '/register', '/invite', '/verify', '/forgot', '/reset'];
const PUBLIC_API = ['/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/auth/verify', '/api/auth/forgot', '/api/auth/reset'];
```

- [ ] **Step 5: Версия сессии в куке и её сверка**

В `app/api/auth/login/route.js` — при успешном входе класть версию в сессию. Заменить блок присвоений сессии на:

```js
    const session = await getSession();
    session.user_id = user.user_id;
    session.email = user.email;
    session.name = user.name;
    session.sv = user.session_version;
    session.active_cabinet_id = cabinet ? cabinet.cabinet_id : null;
    session.touched_at = Date.now();
    await session.save();
```

В `lib/auth.js` `loginUser` — вернуть версию: в SELECT добавить `session_version`, в возвращаемый объект — `session_version: u.session_version`:

```js
  const rows = await query(
    'SELECT user_id, email, name, password_hash, status, session_version FROM auth.users WHERE email = $1',
    [email]
  );
  const u = rows[0];
  if (!u) return null;
  if (u.status !== 'active') { const e = new Error('Аккаунт ' + u.status); e.code = 'inactive'; throw e; }
  if (!verifyPassword(password, u.password_hash)) return null;
  return { user: { user_id: u.user_id, email: u.email, name: u.name, session_version: u.session_version } };
```

В `app/api/auth/register/route.js` — новый пользователь всегда версии 1: рядом с `session.touched_at = Date.now();` добавить `session.sv = 1;`.

В `lib/withCabinet.js` — сверка сразу после проверки membership (`if (!mem.length) ...`), до гейта почты:

```js
    // Версия сессии: смена/сброс пароля увеличивает счётчик в БД, и все ранее
    // выданные куки перестают работать. Старые сессии без поля sv считаем
    // первой версией (до фазы 3 счётчика не было).
    if ((session.sv || 1) !== mem[0].session_version) {
      return NextResponse.json({ error: 'Сессия устарела, войдите заново' }, { status: 401 });
    }
```

В `app/api/profile/route.js` (смена пароля, POST) — заменить `UPDATE`:

```js
  const hash = hashPassword(new_password);
  await query(
    `UPDATE auth.users
        SET password_hash = $1, session_version = session_version + 1, updated_at = now()
      WHERE user_id = $2`,
    [hash, session.user_id]
  );
  // Текущее устройство остаётся в системе: переиздаём куку с новой версией.
  const fresh = await query(`SELECT session_version FROM auth.users WHERE user_id = $1`, [session.user_id]);
  session.sv = fresh[0].session_version;
  await session.save();
  return NextResponse.json({ ok: true });
```

и в шапке файла заменить прямой bcrypt на общий хелпер: убрать `import bcrypt from "bcryptjs";`, добавить `import { hashPassword, verifyPassword } from "@/lib/auth.js";`, а проверку старого пароля переписать на `const valid = verifyPassword(old_password, rows[0].password_hash);`.

- [ ] **Step 6: Ссылка «Забыли пароль?» и сообщение после сброса**

В `app/login/page.js` в блоке `.foot` (строка со ссылкой на регистрацию) добавить вторую строку:

```jsx
        <div className="foot">Нет аккаунта? <a href="/register">Зарегистрироваться</a></div>
        <div className="foot"><a href="/forgot">Забыли пароль?</a></div>
```

И перед `{err && ...}` — сообщение об успешном сбросе:

```jsx
        {params.get('reset') === '1' && !err && (
          <div className="err" style={{ background: "rgba(46,204,113,.12)", color: "#2ecc71" }}>Пароль изменён — войдите с новым паролем</div>
        )}
```

- [ ] **Step 7: Верификация**

```bash
cd /opt/agents/saas && npm run build && (npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase3.mjs http://localhost:3210
node scripts/smoke-auth-phase2.mjs http://localhost:3210
node scripts/smoke-auth-phase1.mjs http://localhost:3210
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected: все четыре — ALL PASS (у фазы 3 строка NOTE про выключенный гейт — это не FAIL). Убить процесс на 3210.

- [ ] **Step 8: Commit**

```bash
git add app/api/auth/forgot app/api/auth/reset app/forgot app/reset lib/withCabinet.js lib/auth.js app/api/auth/login/route.js app/api/auth/register/route.js app/api/profile/route.js app/login/page.js middleware.js
git commit -m "feat(auth): восстановление пароля письмом; смена пароля разлогинивает все устройства"
```

---

### Task 5: Деплой и проверка на проде

**Files:** нет правок кода.

- [ ] **Step 1: Сборка и рестарт**

```bash
cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 6 && systemctl is-active saas-web
```

Expected: `active`.

- [ ] **Step 2: Все четыре смоука против прода**

```bash
node scripts/smoke-auth-phase3.mjs http://localhost:3200
node scripts/smoke-auth-phase2.mjs http://localhost:3200
node scripts/smoke-auth-phase1.mjs http://localhost:3200
node scripts/smoke-auth-phase0.mjs http://localhost:3200
```

Expected: ALL PASS во всех четырёх.

- [ ] **Step 3: Проверка миграции и чистоты БД**

```bash
psql -h localhost -U postgres -d saas -Atc "select count(*) from auth.users where email_verified_at is null"
psql -h localhost -U postgres -d saas -Atc "select count(*) from auth.users where email like '%@smoke.test'"
```

Expected: `0` и `0`.

- [ ] **Step 4: Прибрать раковину**

```bash
rm -f /tmp/saas-mail/*.txt
```

- [ ] **Step 5: Сообщить владельцу**

Что сделано и что от него нужно: письма сейчас пишутся в `/tmp/saas-mail/` вместо отправки (SMTP не настроен). Как только он даст `SAAS_SMTP_HOST/PORT/USER/PASS/FROM`, их надо добавить в `.env.local`, убрать `SAAS_MAIL_SINK=1`, добавить `SAAS_REQUIRE_VERIFIED_EMAIL=1` (включит запрет на подключение ключей МП и приглашения без подтверждённой почты) и перезапустить `saas-web`. До этого момента подтверждение и сброс пароля технически работают, но письмо клиенту не доходит — значит, сообщать клиентам про «забыли пароль» рано.
