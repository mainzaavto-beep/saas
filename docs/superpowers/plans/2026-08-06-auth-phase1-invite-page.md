# Фаза 1 auth-редизайна: страница приглашения — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полноценная страница `/invite/<токен>` с тремя сценариями приёма (новый пользователь, существующий без сессии, залогиненный), безопасные правила принятия (без само-понижения владельца, атомарно) и говорящая страница «Команда» (фаза 1 спеки `docs/superpowers/specs/2026-08-06-auth-flow-design.md`).

**Architecture:** Новая клиентская страница `app/invite/[token]/page.js` поверх расширенного API `/api/invite/[token]` (GET отдаёт имя пригласившего; POST переписан: иерархия ролей + атомарный claim в одной транзакции). Ссылки инвайтов переводятся на новый формат, старый `/register?invite=` редиректит на новую страницу. UI «Команды» перестаёт глотать ошибки; контакты сотрудников скрываются от viewer на API.

**Tech Stack:** Next.js 14 (app router, client components), iron-session, node-postgres (`lib/db.js`: `query`, `getPool`), systemd (`saas-web.service`).

## Global Constraints

- Прод-хост = репозиторий `/opt/agents/saas`, ветка master, remote нет.
- **ЗАПРЕЩЕНО гонять `next dev` в каталоге прода** (затирает `.next`, роняет прод — инцидент 2026-08-06, правило в AGENTS.md). Верификация задач: `npm run build && (npx next start -p 3210 &)` — прод-сборка на отдельном порту; после проверки убить процесс на 3210.
- Деплой (только задача 5): `npm run build && systemctl restart saas-web`.
- Backup боевого файла перед правкой → `/opt/agentsDB/backups/<имя>.bak-2026-08-06p1`.
- Верификатор — `scripts/smoke-auth-phase1.mjs` (задача 1) + регресс `scripts/smoke-auth-phase0.mjs`; оба сами готовят/чистят данные (`*@smoke.test`, роль postgres из `~/.pgpass`); строки `CLEANUP FAIL` = провал.
- Иерархия ролей везде: `owner:3, manager:2, viewer:1` (как ROLE_LEVEL в `lib/withCabinet.js:8`).
- Комментарии и UI-тексты — по-русски. Каждая задача — отдельный коммит с префиксом из задачи.

---

### Task 1: Смоук-скрипт фазы 1 (красный)

**Files:**
- Create: `scripts/smoke-auth-phase1.mjs`

**Interfaces:**
- Produces: `node scripts/smoke-auth-phase1.mjs http://localhost:3210` — PASS/FAIL по каждой проверке, exit 0 только если все PASS и уборка чистая.
- Consumes: работающий сервер панели (прод-сборка на 3210), `.env.local` (SAAS_DB, SAAS_INVITE_CODE), `~/.pgpass` (строка postgres).

- [ ] **Step 1: Написать скрипт**

```js
#!/usr/bin/env node
// scripts/smoke-auth-phase1.mjs — смоук фазы 1 auth: страница и правила приёма инвайтов.
// Использование: node scripts/smoke-auth-phase1.mjs [base_url]
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
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] || cookie };
}
// Регистрация вспомогательного юзера через API (общий код из env — фаза 2 его уберёт,
// тогда параметр станет не нужен).
const reg = (email, name) => api('POST', '/api/auth/register', {
  body: { email, password: 'smoke-pass-123', name, invite_code: process.env.SAAS_INVITE_CODE || undefined },
});

const run = Date.now();
let cabinetId, ownerId, ownerCookie, tokViewer, tokViewer2, tokManager, tokExpired;

try {
  // ── Подготовка: владелец через API (нужна сессия), кабинет и инвайты — SQL ──
  const regOwner = await reg(`owner-${run}@smoke.test`, 'Smoke Owner');
  check('подготовка: регистрация владельца 200', regOwner.status === 200, `got ${regOwner.status} ${JSON.stringify(regOwner.json)}`);
  ownerCookie = regOwner.cookie;
  ownerId = regOwner.json?.user?.user_id;
  cabinetId = (await q(
    `INSERT INTO auth.cabinets (owner_user_id, display_name, marketplaces, status)
     VALUES ($1, $2, '{wb}', 'active') RETURNING cabinet_id`,
    [ownerId, `smoke-cab-${run}`]
  ))[0].cabinet_id;
  await q(`INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, 'owner')`, [ownerId, cabinetId]);
  const mkInv = (role) => q(
    `INSERT INTO auth.invitations (token, cabinet_id, role, created_by)
     VALUES (gen_random_uuid()::text, $1, $2, $3) RETURNING token`,
    [cabinetId, role, ownerId]
  ).then(r => r[0].token);
  tokViewer = await mkInv('viewer');
  tokViewer2 = await mkInv('viewer');
  tokManager = await mkInv('manager');
  tokExpired = (await q(
    `INSERT INTO auth.invitations (token, cabinet_id, role, created_by, expires_at)
     VALUES (gen_random_uuid()::text, $1, 'viewer', $2, now() - interval '1 day') RETURNING token`,
    [cabinetId, ownerId]
  ))[0].token;

  // ── 1. GET отдаёт имя пригласившего ──
  const g = await api('GET', `/api/invite/${tokViewer}`);
  check('GET инвайта: valid=true + inviter_name', g.json?.valid === true && g.json?.inviter_name === 'Smoke Owner', JSON.stringify(g.json));

  // ── 2. Страница /invite/<token> публична ──
  const page = await fetch(`${BASE}/invite/${tokViewer}`, { redirect: 'manual' });
  check('страница /invite/<token> анониму: 200', page.status === 200, `got ${page.status}`);

  // ── 3. Анонимный POST — 401 ──
  const anonPost = await api('POST', `/api/invite/${tokViewer}`);
  check('анонимный POST: 401', anonPost.status === 401, `got ${anonPost.status}`);

  // ── 4. Существующий залогиненный юзер принимает инвайт ──
  const regEmp = await reg(`emp-${run}@smoke.test`, 'Smoke Emp');
  const empId = regEmp.json?.user?.user_id;
  const acc = await api('POST', `/api/invite/${tokViewer}`, { cookie: regEmp.cookie });
  check('приём существующим юзером: ok + cabinet_id', acc.status === 200 && acc.json?.ok === true && acc.json?.cabinet_id === cabinetId, JSON.stringify(acc.json));
  const memRole = (await q(`SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [empId, cabinetId]))[0]?.role;
  check('...membership viewer создан', memRole === 'viewer', String(memRole));

  // ── 5. Повторный POST того же токена тем же юзером — идемпотентное «уже участник» ──
  const acc2 = await api('POST', `/api/invite/${tokViewer}`, { cookie: regEmp.cookie });
  check('повторный приём: 200 already_member', acc2.status === 200 && acc2.json?.already_member === true, `${acc2.status} ${JSON.stringify(acc2.json)}`);

  // ── 6. Владелец открывает СВОЙ viewer-токен — роль не падает, токен не сгорает ──
  const own = await api('POST', `/api/invite/${tokViewer2}`, { cookie: ownerCookie });
  check('owner + свой viewer-токен: already_member', own.status === 200 && own.json?.already_member === true, `${own.status} ${JSON.stringify(own.json)}`);
  const ownerRole = (await q(`SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [ownerId, cabinetId]))[0]?.role;
  check('...роль owner не тронута', ownerRole === 'owner', String(ownerRole));
  const tok2Acc = (await q(`SELECT accepted_at FROM auth.invitations WHERE token = $1`, [tokViewer2]))[0]?.accepted_at;
  check('...токен не сожжён', tok2Acc == null, String(tok2Acc));

  // ── 7. Апгрейд: viewer принимает manager-инвайт ──
  const up = await api('POST', `/api/invite/${tokManager}`, { cookie: regEmp.cookie });
  check('viewer принимает manager-инвайт: role=manager', up.status === 200 && up.json?.role === 'manager', `${up.status} ${JSON.stringify(up.json)}`);
  const upRole = (await q(`SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2`, [empId, cabinetId]))[0]?.role;
  check('...в БД manager', upRole === 'manager', String(upRole));

  // ── 8. Истёкший токен не-участнику — 403 ──
  const regOut = await reg(`out-${run}@smoke.test`, 'Smoke Out');
  const exp = await api('POST', `/api/invite/${tokExpired}`, { cookie: regOut.cookie });
  check('истёкший токен: 403', exp.status === 403, `got ${exp.status} ${JSON.stringify(exp.json)}`);

  // ── 9. Создание инвайта отдаёт ссылку нового формата ──
  const inv = await api('POST', `/api/cabinets/${cabinetId}/invites`, { cookie: ownerCookie, body: { role: 'viewer' } });
  check('ссылка инвайта ведёт на /invite/<token>', typeof inv.json?.url === 'string' && inv.json.url.endsWith(`/invite/${inv.json?.token}`), String(inv.json?.url));

  // ── 10. Контакты команды скрыты от viewer, видны owner ──
  const regV = await reg(`v-${run}@smoke.test`, 'Smoke V');
  await q(`INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, 'viewer')`, [regV.json?.user?.user_id, cabinetId]);
  const memsV = await api('GET', `/api/cabinets/${cabinetId}/members`, { cookie: regV.cookie });
  check('members для viewer: email/phone скрыты', memsV.status === 200 && (memsV.json?.items || []).length > 0 && (memsV.json.items).every(i => i.email == null && i.phone == null), JSON.stringify((memsV.json?.items || []).slice(0, 2)));
  const memsO = await api('GET', `/api/cabinets/${cabinetId}/members`, { cookie: ownerCookie });
  check('members для owner: email видны', memsO.status === 200 && (memsO.json?.items || []).some(i => i.email), 'owner не видит email');
} finally {
  const cf = (e) => { console.error('CLEANUP FAIL:', e.message); cleanupFailed = true; };
  await q(`DELETE FROM auth.invitations WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  await q(`DELETE FROM auth.memberships WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
  await q(`DELETE FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]).catch(cf);
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

- [ ] **Step 2: Прод-сборка + сервер на 3210, прогон — убедиться, что скрипт красный по правильным причинам**

```bash
cd /opt/agents/saas && npm run build && (npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
# дождаться "Ready" в /tmp/next3210.log
node scripts/smoke-auth-phase1.mjs http://localhost:3210
```

Expected (текущий код): PASS — подготовка, «анонимный POST 401», «приём существующим», «membership viewer создан», «истёкший 403», «в БД manager» (текущий `DO UPDATE` тоже апгрейдит). FAIL — «inviter_name» (GET его не отдаёт), «страница 200» (307-редирект на /login: middleware ещё не пускает, страницы нет), «повторный приём already_member» (сейчас 403), «owner already_member» (сейчас понижает!), «роль owner не тронута» (станет viewer — синтетический владелец, не страшно), «токен не сожжён», «role=manager в ответе» (сейчас в ответе нет role), «ссылка /invite/» (сейчас /register?invite=), «контакты скрыты». Exit 1, ноль CLEANUP FAIL. Убить процесс на 3210.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-auth-phase1.mjs
git commit -m "test(auth): смоук фазы 1 — страница инвайта, правила приёма, контакты команды"
```

---

### Task 2: API `/api/invite/[token]` — имя пригласившего и безопасные правила приёма

**Files:**
- Modify: `app/api/invite/[token]/route.js` (бэкап → `/opt/agentsDB/backups/invite-token-route.js.bak-2026-08-06p1`)

**Interfaces:**
- Consumes: `query`, `getPool` из `@/lib/db.js`; `getSession` из `@/lib/session.js`.
- Produces: `GET /api/invite/<token>` → `{ valid, role, email, cabinet_name, inviter_name }` (invalid: `{ valid:false, error }`). `POST /api/invite/<token>` → 200 `{ ok:true, cabinet_id, role }` (принят) | 200 `{ ok:true, already_member:true, cabinet_id, role }` (уже участник с ролью ≥, токен НЕ сожжён) | 401 | 403 `{ error }` | 404. Задача 3 (страница) строится на этих ответах.

- [ ] **Step 1: Переписать файл целиком**

```js
// /api/invite/[token] — проверить/принять приглашение.
import { NextResponse } from "next/server";
import { query, getPool } from "@/lib/db.js";
import { getSession } from "@/lib/session.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Иерархия ролей — как ROLE_LEVEL в lib/withCabinet.js.
const LEVEL = { owner: 3, manager: 2, viewer: 1 };

export async function GET(req, { params }) {
  const token = params.token;
  const rows = await query(
    `SELECT i.token, i.role, i.email, i.expires_at, i.accepted_at,
            c.display_name AS cabinet_name, u.name AS inviter_name
     FROM auth.invitations i
     JOIN auth.cabinets c ON c.cabinet_id = i.cabinet_id
     JOIN auth.users u ON u.user_id = i.created_by
     WHERE i.token = $1`,
    [token]
  );
  if (!rows.length) return NextResponse.json({ valid: false, error: "Приглашение не найдено" }, { status: 404 });
  const inv = rows[0];
  if (inv.accepted_at) return NextResponse.json({ valid: false, error: "Приглашение уже использовано" });
  if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ valid: false, error: "Срок приглашения истёк" });
  return NextResponse.json({ valid: true, role: inv.role, email: inv.email, cabinet_name: inv.cabinet_name, inviter_name: inv.inviter_name });
}

// Принять приглашение (после регистрации/логина).
// 🔒 user_id — только из сессии. Правила:
//   - уже участник с ролью ≥ роли инвайта → ничего не меняем, токен НЕ жжём
//     (закрывает само-понижение владельца собственной viewer-ссылкой);
//   - иначе атомарный claim: UPDATE с условием + membership в одной транзакции
//     (гонка двух одновременных приёмов — победитель ровно один).
export async function POST(req, { params }) {
  const token = params.token;
  const session = await getSession();
  const user_id = session?.user_id;
  if (!user_id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await query(
    `SELECT cabinet_id, role, expires_at, accepted_at FROM auth.invitations WHERE token = $1`,
    [token]
  );
  if (!rows.length) return NextResponse.json({ error: "Приглашение не найдено" }, { status: 404 });
  const inv = rows[0];

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Блокируем существующее членство, чтобы не пересечься со сменой роли.
    const mem = await client.query(
      `SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2 FOR UPDATE`,
      [user_id, inv.cabinet_id]
    );
    if (mem.rowCount && (LEVEL[mem.rows[0].role] || 0) >= (LEVEL[inv.role] || 0)) {
      await client.query('ROLLBACK');
      return NextResponse.json({ ok: true, already_member: true, cabinet_id: inv.cabinet_id, role: mem.rows[0].role });
    }
    const claim = await client.query(
      `UPDATE auth.invitations SET accepted_by = $1, accepted_at = now()
       WHERE token = $2 AND accepted_at IS NULL AND expires_at > now()
       RETURNING cabinet_id, role`,
      [user_id, token]
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      const why = inv.accepted_at ? "Уже использовано" : "Срок истёк";
      return NextResponse.json({ error: why }, { status: 403 });
    }
    // DO UPDATE безопасен: сюда доходим только при существующей роли НИЖЕ роли инвайта
    // (апгрейд viewer → manager) либо без membership вовсе.
    await client.query(
      `INSERT INTO auth.memberships (user_id, cabinet_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, cabinet_id) DO UPDATE SET role = EXCLUDED.role`,
      [user_id, claim.rows[0].cabinet_id, claim.rows[0].role]
    );
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, cabinet_id: claim.rows[0].cabinet_id, role: claim.rows[0].role });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[invite accept]', e.message);
    return NextResponse.json({ error: "Внутренняя ошибка, попробуйте позже" }, { status: 500 });
  } finally {
    client.release();
  }
}
```

- [ ] **Step 2: Верификация**

```bash
cd /opt/agents/saas && npm run build && (npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase1.mjs http://localhost:3210
node scripts/smoke-auth-phase0.mjs http://localhost:3210   # регресс фазы 0
```

Expected фаза 1: PASS всё, кроме «страница /invite 200» и «ссылка /invite/» (задача 3) и «контакты скрыты» (задача 4). Фаза 0: ALL PASS (регресс: приём при регистрации живёт в register-роуте и не затронут). Убить процесс на 3210.

- [ ] **Step 3: Commit**

```bash
git add app/api/invite/[token]/route.js
git commit -m "fix(auth): приём инвайта — иерархия ролей, без само-понижения владельца, атомарный claim, имя пригласившего в GET"
```

---

### Task 3: Страница `/invite/[token]`, публичность, новый формат ссылок, редирект старого

**Files:**
- Create: `app/invite/[token]/page.js`
- Modify: `middleware.js:6` (бэкап → `/opt/agentsDB/backups/middleware.js.bak-2026-08-06p1`)
- Modify: `app/api/cabinets/[id]/invites/route.js:35` (бэкап → `/opt/agentsDB/backups/cabinets-invites-route.js.bak-2026-08-06p1`)
- Modify: `app/register/page.js` (бэкап → `/opt/agentsDB/backups/register-page.js.bak-2026-08-06p1`)
- Modify: `.env.local` — добавить строку `NEXT_PUBLIC_URL=https://sysell.ru` (файл вне git, бэкап не нужен; НЕ трогать другие строки)

**Interfaces:**
- Consumes: ответы GET/POST `/api/invite/<token>` из задачи 2 (форматы — в её Interfaces); `GET /api/profile` (существует, `app/api/profile/route.js:10`) — 200 = залогинен, 401 = аноним.
- Produces: публичная страница `/invite/<token>`; инвайт-ссылки вида `<NEXT_PUBLIC_URL>/invite/<token>`; старый формат `/register?invite=X` (без `from=invite`) редиректит на `/invite/X`; переход «Создать аккаунт» — `/register?invite=X&from=invite`.

- [ ] **Step 1: Страница**

```jsx
'use client';
import { C } from "@/lib/palette.js";
// /invite/[token] — страница приглашения. Три сценария:
//   аноним-новый → «Создать аккаунт» (/register?invite=<t>&from=invite),
//   аноним-с-аккаунтом → «У меня уже есть аккаунт» (/login?next=/invite/<t>),
//   залогинен → «Принять приглашение» (POST) → редирект в кабинет.
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const ROLE_LABEL = { manager: "Менеджер", viewer: "Наблюдатель" };

export default function InvitePage({ params }) {
  const token = params.token;
  const router = useRouter();
  const [invite, setInvite] = useState(null); // null = грузим; {valid,...} = ответ API
  const [me, setMe] = useState(undefined);    // undefined = грузим; null = аноним; {...} = залогинен
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/invite/${token}`)
      .then(r => r.json())
      .then(setInvite)
      .catch(() => setInvite({ valid: false, error: 'Сетевая ошибка — обновите страницу' }));
    fetch('/api/profile')
      .then(r => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => setMe(null));
  }, [token]);

  async function accept() {
    setErr(''); setBusy(true);
    try {
      const r = await fetch(`/api/invite/${token}`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || 'Не удалось принять приглашение'); return; }
      router.push(`/cabinets/${d.cabinet_id}`);
      router.refresh();
    } catch { setErr('Сетевая ошибка, попробуйте ещё раз'); }
    finally { setBusy(false); }
  }

  const box = (children) => (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "system-ui, sans-serif", display: "flex", justifyContent: "center", alignItems: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 440, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: 32, textAlign: "center" }}>
        {children}
      </div>
    </div>
  );

  if (!invite || me === undefined) return box(<p style={{ color: C.muted }}>Проверяем приглашение…</p>);

  if (!invite.valid) return box(<>
    <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Приглашение недоступно</h1>
    <p style={{ color: C.muted, fontSize: 14, margin: "0 0 20px" }}>{invite.error}</p>
    <p style={{ color: C.faint, fontSize: 13 }}>Попросите у пригласившего новую ссылку.</p>
  </>);

  const btn = { display: "block", width: "100%", padding: "12px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 15, fontFamily: "inherit", textDecoration: "none", boxSizing: "border-box" };
  const btnGhost = { ...btn, background: "transparent", color: C.accent, border: `1px solid ${C.accent}`, marginTop: 10 };

  return box(<>
    <h1 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 8px" }}>Приглашение в команду</h1>
    <p style={{ color: C.muted, fontSize: 14, margin: "0 0 24px" }}>
      {invite.inviter_name ? `${invite.inviter_name} приглашает вас` : "Вас приглашают"} в кабинет
      {" "}«{invite.cabinet_name}» с ролью «{ROLE_LABEL[invite.role] || invite.role}»
    </p>
    {err && <div style={{ background: "rgba(255,107,107,.12)", color: C.neg, padding: "10px 14px", borderRadius: 8, fontSize: 14, marginBottom: 16 }}>{err}</div>}
    {me ? (
      <button onClick={accept} disabled={busy} style={btn}>{busy ? "Принимаем…" : "Принять приглашение"}</button>
    ) : (
      <>
        <a href={`/register?invite=${token}&from=invite`} style={btn}>Создать аккаунт</a>
        <a href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} style={btnGhost}>У меня уже есть аккаунт</a>
      </>
    )}
  </>);
}
```

- [ ] **Step 2: middleware — страница публична**

В `middleware.js` строка 6:

```js
const PUBLIC_PATHS = ['/', '/login', '/register', '/invite'];
```

(`'/invite'` матчит `/invite/<token>` через существующее `startsWith(p + '/')`.)

- [ ] **Step 3: Ссылка нового формата**

В `app/api/cabinets/[id]/invites/route.js` строка 35:

```js
  const inviteUrl = `${process.env.NEXT_PUBLIC_URL || "https://sysell.ru"}/invite/${token}`;
```

И в `.env.local` добавить строку (для стендов не на sysell.ru):

```
NEXT_PUBLIC_URL=https://sysell.ru
```

- [ ] **Step 4: Редирект старого формата в `app/register/page.js`**

В `RegisterInner` после строки `const inviteToken = sp.get('invite') || '';` добавить:

```js
  const fromInvite = sp.get('from') === 'invite';
  // Старые ссылки /register?invite=X ведут на страницу приглашения — там есть
  // ветка «у меня уже есть аккаунт». Сюда возвращаются кнопкой «Создать аккаунт»
  // (она добавляет from=invite).
  useEffect(() => {
    if (inviteToken && !fromInvite) router.replace(`/invite/${inviteToken}`);
  }, [inviteToken, fromInvite, router]);
```

- [ ] **Step 5: Верификация**

```bash
cd /opt/agents/saas && npm run build && (npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase1.mjs http://localhost:3210
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected фаза 1: PASS всё, кроме «контакты скрыты» (задача 4). Фаза 0: ALL PASS — важно: проверка «ответ ведёт в кабинет приглашения» гоняет `/api/auth/register` напрямую, редирект её не касается. Дополнительно вручную: `curl -s http://localhost:3210/invite/nonexistent -o /dev/null -w '%{http_code}'` → 200 (страница рендерится, «не найдено» показывает клиент). Убить процесс на 3210.

- [ ] **Step 6: Commit**

```bash
git add app/invite/[token]/page.js middleware.js app/api/cabinets/[id]/invites/route.js app/register/page.js
git commit -m "feat(auth): страница /invite/<token> — три сценария приёма; ссылки нового формата; редирект старых"
```

---

### Task 4: «Команда» — видимые ошибки и контакты только для owner/manager

**Files:**
- Modify: `app/api/cabinets/[id]/members/route.js:9-20` (бэкап → `/opt/agentsDB/backups/members-route.js.bak-2026-08-06p1`)
- Modify: `app/cabinets/[id]/team/TeamPage.jsx` (бэкап → `/opt/agentsDB/backups/TeamPage.jsx.bak-2026-08-06p1`)
- Modify: `app/settings/page.js:338-376` (бэкап → `/opt/agentsDB/backups/settings-page.js.bak-2026-08-06p1`)

**Interfaces:**
- Consumes: `ctx.cabinet.role` — роль вызывающего, прокидывается `withCabinet` (`lib/withCabinet.js:82`: `cabinet: { ...mem[0], ... }`).
- Produces: `GET /members` для viewer — `email: null, phone: null` у всех записей (имена и роли остаются); UI обеих «Команд» показывает ошибки API.

- [ ] **Step 1: members GET — скрыть контакты от viewer**

Заменить GET в `app/api/cabinets/[id]/members/route.js`:

```js
export const GET = withCabinet(async (req, { cabinet }) => {
  const rows = await query(
    `SELECT u.user_id, u.email, u.name, u.first_name, u.last_name, u.phone,
            m.role, m.created_at AS joined_at
     FROM auth.memberships m
     JOIN auth.users u ON u.user_id = m.user_id
     WHERE m.cabinet_id = $1
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.email`,
    [cabinet.cabinet_id]
  );
  // Контакты — только owner/manager; viewer видит состав команды без email/телефонов.
  const canSeeContacts = cabinet.role === 'owner' || cabinet.role === 'manager';
  const items = canSeeContacts ? rows : rows.map(r => ({ ...r, email: null, phone: null }));
  return NextResponse.json({ items });
});
```

- [ ] **Step 2: TeamPage.jsx — ошибки видимы**

Заменить `load`, `createInvite`, `changeRole`, `removeMember` (строки 18-53):

```js
  // Ответы читаем с проверкой r.ok: 403 у /invites для не-владельца — норма
  // (раздел скрыт через canManage), остальные ошибки показываем.
  const load = () => {
    fetch(`/api/cabinets/${cabinetId}/me`).then(r => r.json()).then(d => setMyRole(d.role || null));
    fetch(`/api/cabinets/${cabinetId}/members`).then(r => r.ok ? r.json() : { items: [] }).then(d => setMembers(d.items || []));
    fetch(`/api/cabinets/${cabinetId}/invites`).then(r => r.ok ? r.json() : { items: [] }).then(d => setInvites(d.items || []));
  };
  useEffect(() => { load(); }, [cabinetId]);
  // Менять роли / приглашать / удалять может только владелец (см. withCabinet requireRole:'owner').
  const canManage = myRole === "owner";

  const createInvite = async () => {
    setInviteUrl(null); setCopied(false); setError(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/invites`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    const d = await r.json();
    if (r.ok && d.url) { setInviteUrl(d.url); load(); }
    else setError(d.error || "Не удалось создать приглашение");
  };

  const copyUrl = () => {
    if (inviteUrl) { navigator.clipboard.writeText(inviteUrl); setCopied(true); }
  };

  const changeRole = async (userId, role) => {
    setError(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/members`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, role }),
    });
    if (!r.ok) setError((await r.json()).error || "Не удалось изменить роль");
    load();
  };

  const removeMember = async (userId) => {
    if (!confirm("Удалить сотрудника из проекта?")) return;
    setError(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/members?user_id=${userId}`, { method: "DELETE" });
    if (!r.ok) setError((await r.json()).error || "Не удалось удалить сотрудника");
    load();
  };
```

И вывести ошибку в разметке — после `<h1 ...>👥 Команда</h1>` добавить:

```jsx
      {error && <div style={{ background: "rgba(255,107,107,.12)", color: C.neg, padding: "10px 14px", borderRadius: 8, fontSize: 14, marginBottom: 16 }}>{error}</div>}
```

В списке сотрудников имя может прийти без email (viewer): заменить строку 68-69 на

```jsx
              <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name || m.email || "Сотрудник"}</span>
              {m.email && <span style={{ marginLeft: 8, fontSize: 12, color: C.faint }}>{m.email}</span>}
```

- [ ] **Step 3: settings TeamTab — те же правки**

В `app/settings/page.js` заменить `load` (338-342), `changeRole` (364-370), `removeMember` (372-376) — тем же образом:

```js
  const load = () => {
    fetch(`/api/cabinets/${cabinetId}/me`).then(r => r.json()).then(d => setMyRole(d.role || null));
    fetch(`/api/cabinets/${cabinetId}/members`).then(r => r.ok ? r.json() : { items: [] }).then(d => setMembers(d.items || []));
    fetch(`/api/cabinets/${cabinetId}/invites`).then(r => r.ok ? r.json() : { items: [] }).then(d => setInvites(d.items || []));
  };
```

```js
  const changeRole = async (userId, role) => {
    setError(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/members`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, role }),
    });
    if (!r.ok) setError((await r.json()).error || "Не удалось изменить роль");
    load();
  };

  const removeMember = async (userId) => {
    if (!confirm("Удалить сотрудника из проекта?")) return;
    setError(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/members?user_id=${userId}`, { method: "DELETE" });
    if (!r.ok) setError((await r.json()).error || "Не удалось удалить сотрудника");
    load();
  };
```

Ошибка уже рендерится (`{error && ...}` на строке 382 — состояние наконец начнёт устанавливаться). Отображение имени (строки 394-395) — так же, как в TeamPage:

```jsx
                <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name || m.email || "Сотрудник"}</span>
                {m.email && <span style={{ marginLeft: 8, fontSize: 12, color: C.faint }}>{m.email}</span>}
```

- [ ] **Step 4: Верификация**

```bash
cd /opt/agents/saas && npm run build && (npx next start -p 3210 > /tmp/next3210.log 2>&1 &)
node scripts/smoke-auth-phase1.mjs http://localhost:3210
node scripts/smoke-auth-phase0.mjs http://localhost:3210
```

Expected: обе — ALL PASS. Убить процесс на 3210.

- [ ] **Step 5: Commit**

```bash
git add app/api/cabinets/[id]/members/route.js app/cabinets/[id]/team/TeamPage.jsx app/settings/page.js
git commit -m "fix(auth): команда — ошибки видимы, контакты сотрудников только для owner/manager"
```

---

### Task 5: Деплой и живая проверка

**Files:** нет правок кода.

- [ ] **Step 1: Сборка и рестарт**

```bash
cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 5 && systemctl is-active saas-web
```

Expected: `active`. (Если `systemctl` заблокирован классификатором — команду запускает владелец через `!`.)

- [ ] **Step 2: Оба смоука против прода**

```bash
node scripts/smoke-auth-phase1.mjs http://localhost:3200
node scripts/smoke-auth-phase0.mjs http://localhost:3200
```

Expected: ALL PASS оба.

- [ ] **Step 3: Живая приёмка**

Сообщить владельцу: старая ссылка `/register?invite=<токен>` теперь приводит на страницу приглашения; наблюдатель может и зарегистрироваться, и войти существующим аккаунтом. Предостережение фазы 0 («не принимать свой токен вручную») снято — правило «роль ≥ не трогаем» защищает владельца.
