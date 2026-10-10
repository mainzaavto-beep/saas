# Менеджеры площадок и раздел «Премия» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** менеджер видит и правит всё, кроме «Баланса» (и настроек/команды/подписки); раздел «Премия» считает премию менеджера площадки по модели листа KPI владельца, каждый видит только свою.

**Architecture:** права — переопределение роли `manager` через `requireRole` в `withCabinet`. Премия — чистое ядро `lib/bonus.js` (формула, окно месяца, правило доступа), адаптер `lib/bonusData.js` (канон прибыли + 4 tenant-таблицы), роут `/api/cabinets/[id]/bonus`, страница `/cabinets/[id]/bonus`.

**Tech Stack:** Next.js 14 App Router, PostgreSQL + RLS (`lib/db.js`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-08-managers-bonus-design.md`

## Global Constraints

- Только роли `owner` / `manager` / `viewer`, иерархия `ROLE_LEVEL` в `lib/withCabinet.js` не меняется.
- Остаются `requireRole: 'owner'` ровно в: `balance` (GET/POST/DELETE), `settings`, `shops`, `members`, `invites`, `billing/pay`, `bonus` (POST).
- Факт премии — только канон: `wbProfitCabinet` / `ozProfitCabinet` (`.revenue`, `.profit`) и `wbProfitProductBatch` / `ozProfitProductBatch`; своих формул прибыли нет.
- Налоговый режим — `normalizeTaxMode(cabinet.shopTax?.[platform])` (как `/pnl`).
- Дефолты сотрудника: оклад 40000, `bonus_pct` 0.04, `threshold` 0.65. Потолка нет.
- Окно текущего месяца — с 1-го по вчера включительно; прошлые месяцы — целиком.
- Менеджер видит только свою карточку: `user_id` берётся из сессии, параметр запроса игнорируется.
- Запросы внутри одного handler'а — последовательно, без `Promise.all` (один client на транзакцию).
- Пустой `catch {}` без `console.error` запрещён (правило по финансам AGENTS.md).
- UI: палитра `{ C, soft }` из `@/lib/palette.js`; хуки до ранних `return` (D7); fetch только в backticks (D3); компонент принимает `{ cabinetId }` (D1).
- Бэкап перед правкой боевого файла: `/opt/agentsDB/backups/<имя>.<YYYYMMDD_HHMMSS>.bak`.
- Эксперименты и смоуки — только на кабинете #1. Запись в боевую БД (миграция) — `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas`.
- `git add` — только явным списком файлов задачи (урок «дисциплина git add»).
- Не запускать `next dev` в каталоге прода; после правок `app/`/`lib/` — `npm run build && systemctl restart saas-web`.
- Коммиты оканчиваются строками:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` и
  `Claude-Session: https://claude.ai/code/session_012TA5vJmmNQiZwqMDYrr5y3`.

Отклонение от спеки §5 (упрощение): пункт меню «Премия» виден owner и manager всегда (участие в программе живёт в tenant-таблице под RLS, layout читает `auth.*` без транзакции); менеджер не из программы на странице видит «Раздел недоступен». Спеку поправить в задаче 6.

---

### Task 1: Ядро премии `lib/bonus.js`

**Files:**
- Create: `lib/bonus.js`
- Test: `lib/__tests__/bonus.test.mjs`

**Interfaces:**
- Produces:
  - `computeBonus({ salesPlan, profitPlan, salesFact, profitFact, exclusions, salary, bonusPct, threshold }) → { status: 'ok'|'no_plan', plan: {sales, profit, margin}, fact: {sales, profit, margin}, indicators: [{key:'sales'|'profit'|'margin', plan, fact, pct, below}], avg, eligible, bonusBase, bonus, payout }`. `exclusions = [{ revenue, profit, salesPlanOff, profitPlanOff }]`.
  - `monthWindow(period: 'YYYY-MM', today: 'YYYY-MM-DD') → { from, to } | null` (null — месяц ещё не начался или начался сегодня).
  - `isValidPeriod(period) → boolean`.
  - `resolveBonusViewer({ role, sessionUserId, requestedUserId, employees: [{user_id}] }) → { mode: 'owner'|'self'|'denied', userId: number|null }`.

- [ ] **Step 1: Написать падающий тест**

```js
// lib/__tests__/bonus.test.mjs — ядро премии менеджеров (спека 2026-10-08).
import test from "node:test";
import assert from "node:assert/strict";
import { computeBonus, monthWindow, isValidPeriod, resolveBonusViewer } from "../bonus.js";

const base = { salary: 40000, bonusPct: 0.04, threshold: 0.65, exclusions: [] };
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≈ ${b}`);

test("контрольный пример листа KPI владельца: 146 667 ₽", () => {
  const r = computeBonus({ ...base, salesPlan: 10_000_000, profitPlan: 1_500_000, salesFact: 20_000_000, profitFact: 2_000_000 });
  assert.equal(r.status, "ok");
  near(r.indicators[0].pct, 2);
  near(r.indicators[1].pct, 1.3333);
  near(r.indicators[2].pct, 0.6667);
  near(r.avg, 1.3333);
  assert.equal(r.eligible, true);
  near(r.bonusBase, 80000);
  near(r.bonus, 106666.67);
  near(r.payout, 146666.67);
});

test("порог: один показатель ниже 65 % — бонус 0, оклад платится", () => {
  const r = computeBonus({ ...base, salesPlan: 1_000_000, profitPlan: 100_000, salesFact: 640_000, profitFact: 100_000 });
  assert.equal(r.indicators[0].below, true);
  assert.equal(r.eligible, false);
  assert.equal(r.bonus, 0);
  assert.equal(r.payout, 40000);
});

test("план не задан или 0 — no_plan, бонус 0", () => {
  for (const p of [{ salesPlan: 0, profitPlan: 100 }, { salesPlan: 100, profitPlan: 0 }, { salesPlan: null, profitPlan: null }]) {
    const r = computeBonus({ ...base, ...p, salesFact: 500, profitFact: 50 });
    assert.equal(r.status, "no_plan");
    assert.equal(r.bonus, 0);
    assert.equal(r.payout, 40000);
  }
});

test("исключение артикула снимает факт и план вместе — % растёт", () => {
  const without = computeBonus({ ...base, salesPlan: 1_000_000, profitPlan: 200_000, salesFact: 800_000, profitFact: 150_000 });
  const withEx = computeBonus({ ...base, salesPlan: 1_000_000, profitPlan: 200_000, salesFact: 800_000, profitFact: 150_000,
    exclusions: [{ revenue: 50_000, profit: 5_000, salesPlanOff: 300_000, profitPlanOff: 60_000 }] });
  near(withEx.fact.sales, 750_000);
  near(withEx.plan.sales, 700_000);
  near(withEx.fact.profit, 145_000);
  near(withEx.plan.profit, 140_000);
  assert.ok(withEx.avg > without.avg);
});

test("отрицательная прибыль — бонус 0", () => {
  const r = computeBonus({ ...base, salesPlan: 1_000_000, profitPlan: 100_000, salesFact: 1_000_000, profitFact: -10_000 });
  assert.equal(r.eligible, false);
  assert.equal(r.bonus, 0);
});

test("нулевые продажи — маржа факта 0, ниже порога", () => {
  const r = computeBonus({ ...base, salesPlan: 1_000_000, profitPlan: 100_000, salesFact: 0, profitFact: 0 });
  assert.equal(r.fact.margin, 0);
  assert.equal(r.indicators[2].below, true);
  assert.equal(r.bonus, 0);
});

test("monthWindow: текущий месяц по вчера, прошлый целиком, будущий — null", () => {
  assert.deepEqual(monthWindow("2026-10", "2026-10-10"), { from: "2026-10-01", to: "2026-10-09" });
  assert.deepEqual(monthWindow("2026-09", "2026-10-10"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(monthWindow("2026-02", "2026-10-10"), { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(monthWindow("2026-10", "2026-10-01"), null);
  assert.equal(monthWindow("2026-11", "2026-10-10"), null);
});

test("isValidPeriod", () => {
  assert.equal(isValidPeriod("2026-10"), true);
  assert.equal(isValidPeriod("2026-13"), false);
  assert.equal(isValidPeriod("2026-1"), false);
  assert.equal(isValidPeriod(null), false);
});

test("resolveBonusViewer: менеджер видит только себя, чужой user_id игнорируется", () => {
  const employees = [{ user_id: 10 }, { user_id: 11 }];
  assert.deepEqual(resolveBonusViewer({ role: "manager", sessionUserId: 10, requestedUserId: 11, employees }), { mode: "self", userId: 10 });
  assert.deepEqual(resolveBonusViewer({ role: "manager", sessionUserId: 12, requestedUserId: null, employees }), { mode: "denied", userId: null });
  assert.deepEqual(resolveBonusViewer({ role: "viewer", sessionUserId: 10, requestedUserId: null, employees }), { mode: "denied", userId: null });
  assert.deepEqual(resolveBonusViewer({ role: "owner", sessionUserId: 1, requestedUserId: 11, employees }), { mode: "owner", userId: 11 });
  assert.deepEqual(resolveBonusViewer({ role: "owner", sessionUserId: 1, requestedUserId: null, employees }), { mode: "owner", userId: 10 });
  assert.deepEqual(resolveBonusViewer({ role: "owner", sessionUserId: 1, requestedUserId: 99, employees }), { mode: "owner", userId: 10 });
  assert.deepEqual(resolveBonusViewer({ role: "owner", sessionUserId: 1, requestedUserId: null, employees: [] }), { mode: "owner", userId: null });
});
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `node --test lib/__tests__/bonus.test.mjs`
Expected: FAIL — `Cannot find module '../bonus.js'`.

- [ ] **Step 3: Реализация**

```js
// lib/bonus.js — премия менеджеров площадок (спека docs/superpowers/specs/2026-10-08-managers-bonus-design.md).
// Чистые функции, БД не трогают. Модель — лист «KPI (копия)» владельца + порог из листа «KPI»:
//   три показателя (продажи, прибыль, маржа) × % выполнения; любой ниже порога → бонус 0;
//   бонус = bonusPct × факт прибыли × среднее трёх %; к оплате = оклад + бонус. Потолка нет.
// Исключённый артикул снимает и свой факт (канон по товару), и введённую владельцем долю плана.

const round2 = (v) => Math.round(((v || 0) + Number.EPSILON) * 100) / 100;
const num = (v) => (v == null || v === "" ? 0 : Number(v) || 0);

export function computeBonus({ salesPlan, profitPlan, salesFact, profitFact, exclusions = [], salary, bonusPct, threshold }) {
  const ex = exclusions.reduce((a, e) => ({
    revenue: a.revenue + num(e.revenue), profit: a.profit + num(e.profit),
    salesOff: a.salesOff + num(e.salesPlanOff), profitOff: a.profitOff + num(e.profitPlanOff),
  }), { revenue: 0, profit: 0, salesOff: 0, profitOff: 0 });

  const fact = { sales: round2(num(salesFact) - ex.revenue), profit: round2(num(profitFact) - ex.profit) };
  fact.margin = fact.sales > 0 ? fact.profit / fact.sales : 0;
  const plan = { sales: round2(num(salesPlan) - ex.salesOff), profit: round2(num(profitPlan) - ex.profitOff) };
  plan.margin = plan.sales > 0 ? plan.profit / plan.sales : 0;

  const sal = num(salary);
  if (!(plan.sales > 0) || !(plan.profit > 0)) {
    return { status: "no_plan", plan, fact, indicators: [], avg: null, eligible: false, bonusBase: 0, bonus: 0, payout: round2(sal) };
  }

  const thr = num(threshold);
  const indicators = [
    { key: "sales", plan: plan.sales, fact: fact.sales },
    { key: "profit", plan: plan.profit, fact: fact.profit },
    { key: "margin", plan: plan.margin, fact: fact.margin },
  ].map((i) => {
    const pct = i.fact / i.plan;
    return { ...i, pct, below: pct < thr };
  });
  const avg = indicators.reduce((a, i) => a + i.pct, 0) / indicators.length;
  const eligible = fact.profit > 0 && indicators.every((i) => !i.below);
  const bonusBase = round2(num(bonusPct) * Math.max(fact.profit, 0));
  const bonus = eligible ? round2(bonusBase * avg) : 0;
  return { status: "ok", plan, fact, indicators, avg, eligible, bonusBase, bonus, payout: round2(sal + bonus) };
}

export function isValidPeriod(period) {
  return typeof period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
}

// Окно факта: прошлый месяц — целиком; текущий — с 1-го по вчера; будущий или начавшийся сегодня — null.
export function monthWindow(period, today) {
  const [y, m] = period.split("-").map(Number);
  const from = `${period}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = `${period}-${String(last).padStart(2, "0")}`;
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  const yesterday = t.toISOString().slice(0, 10);
  const to = monthEnd < yesterday ? monthEnd : yesterday;
  return to < from ? null : { from, to };
}

// Кто какую карточку видит. Менеджер — только свою (параметр запроса игнорируется),
// и только если он в программе; наблюдатель — никогда; владелец — любую из программы.
export function resolveBonusViewer({ role, sessionUserId, requestedUserId, employees }) {
  const ids = employees.map((e) => Number(e.user_id));
  if (role === "owner") {
    const req = Number(requestedUserId);
    return { mode: "owner", userId: ids.includes(req) ? req : (ids[0] ?? null) };
  }
  if (role === "manager" && ids.includes(Number(sessionUserId))) {
    return { mode: "self", userId: Number(sessionUserId) };
  }
  return { mode: "denied", userId: null };
}
```

- [ ] **Step 4: Запустить — должно пройти**

Run: `node --test lib/__tests__/bonus.test.mjs`
Expected: PASS, 9 тестов.

- [ ] **Step 5: Commit**

```bash
git add lib/bonus.js lib/__tests__/bonus.test.mjs
git commit -m "feat(bonus): ядро расчёта премии менеджеров площадок"
```

---

### Task 2: Права менеджера — всё, кроме «Баланса»

**Files:**
- Modify (бэкап каждого перед правкой): `app/api/cabinets/[id]/{dds,purchases,plan,plan/targets,plan/approve,opex,self-buyouts,purchase-plan}/route.js` — `requireRole: 'owner'` → `'manager'`.
- Modify: `app/api/cabinets/[id]/balance/route.js:35` — GET получает `{ requireRole: 'owner' }`.
- Modify: `lib/withCabinet.js:14-19` — комментарий об уровнях ролей.
- Modify: `app/cabinets/[id]/layout.js` — `m.role` в запрос membership, фильтр пунктов меню по `ownerOnly`/`roles`.
- Modify: `app/cabinets/[id]/fin-balance/page.js` — серверная проверка роли.
- Test: `lib/__tests__/roleGuards.test.mjs` (статический гард по исходникам роутов).

**Interfaces:**
- Produces: в `MENU` у пункта поле `roles: ["owner"]` (видимость по роли); layout фильтрует `item.items` и верхние пункты по `!x.roles || x.roles.includes(role)`. Задача 5 добавит пункт `{ href: "/bonus", label: "Премия", roles: ["owner", "manager"] }`.

- [ ] **Step 1: Падающий гард-тест**

```js
// lib/__tests__/roleGuards.test.mjs — гард прав (спека 2026-10-08 §1): requireRole 'owner'
// остаётся ровно у баланса, настроек, ключей, команды, оплаты и записи премии; «Баланс» GET — тоже owner.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../app/api/cabinets/[id]/", import.meta.url).pathname;
const OWNER_ONLY = new Set(["balance", "settings", "shops", "members", "invites", "billing/pay", "bonus"]);
const MANAGER_FIN = ["dds", "purchases", "plan", "plan/targets", "plan/approve", "opex", "self-buyouts", "purchase-plan"];

function routes(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...routes(p));
    else if (n === "route.js") out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p).replace(/\/route\.js$/, "");
const all = routes(ROOT).map((p) => ({ key: rel(p), src: readFileSync(p, "utf8") }));

test("requireRole 'owner' только у разрешённого списка", () => {
  const owners = all.filter((r) => /requireRole:\s*['"]owner['"]/.test(r.src)).map((r) => r.key).sort();
  for (const k of owners) assert.ok(OWNER_ONLY.has(k), `неожиданный owner-only роут: ${k}`);
});

test("финансовые роуты пишет менеджер", () => {
  for (const k of MANAGER_FIN) {
    const r = all.find((x) => x.key === k);
    assert.ok(r, `нет роута ${k}`);
    assert.ok(!/requireRole:\s*['"]owner['"]/.test(r.src), `${k} всё ещё owner`);
    assert.ok(/requireRole:\s*['"]manager['"]/.test(r.src), `${k} без requireRole manager`);
  }
});

test("«Баланс»: все экспортируемые методы owner-only, включая GET", () => {
  const src = all.find((x) => x.key === "balance").src;
  const methods = [...src.matchAll(/export const (GET|POST|PUT|DELETE|PATCH)\s*=/g)].length;
  const guards = [...src.matchAll(/requireRole:\s*['"]owner['"]/g)].length;
  assert.equal(guards, methods);
});
```

- [ ] **Step 2: Запустить — должно упасть**

Run: `node --test lib/__tests__/roleGuards.test.mjs`
Expected: FAIL — «неожиданный owner-only роут: dds» и «Баланс… 2 !== 3».

- [ ] **Step 3: Бэкап и замена роли в финансовых роутах**

```bash
cd /opt/agents/saas; TS=$(date +%Y%m%d_%H%M%S)
for r in dds purchases plan plan/targets plan/approve opex self-buyouts purchase-plan balance; do
  f="app/api/cabinets/[id]/$r/route.js"; cp "$f" "/opt/agentsDB/backups/$(echo $r | tr / _).route.js.$TS.bak"
done
cp lib/withCabinet.js /opt/agentsDB/backups/withCabinet.js.$TS.bak
cp "app/cabinets/[id]/layout.js" /opt/agentsDB/backups/cabinet_layout.js.$TS.bak
cp "app/cabinets/[id]/fin-balance/page.js" /opt/agentsDB/backups/fin-balance.page.js.$TS.bak
for r in dds purchases plan plan/targets plan/approve opex self-buyouts purchase-plan; do
  sed -i "s/requireRole: *'owner'/requireRole: 'manager'/" "app/api/cabinets/[id]/$r/route.js"
done
grep -rn "requireRole" app/api/cabinets/\[id\]/{dds,purchases,plan,opex,self-buyouts,purchase-plan}/route.js app/api/cabinets/\[id\]/plan/*/route.js
```

Expected: везде `requireRole: 'manager'`.

- [ ] **Step 4: «Баланс» GET — только владелец**

В `app/api/cabinets/[id]/balance/route.js` найти конец обработчика GET (строка `});` перед `export const POST`) и заменить на `}, { requireRole: 'owner' });`. Над `export const GET` добавить комментарий:

```js
// Баланс (активы/пассивы, деньги на счетах) — только владелец, включая чтение
// (спека «Менеджеры и премия» 2026-10-08 §1): менеджер видит всё, кроме этой страницы.
```

- [ ] **Step 5: Запустить гард — должен пройти**

Run: `node --test lib/__tests__/roleGuards.test.mjs`
Expected: PASS, 3 теста.

- [ ] **Step 6: Комментарий в `lib/withCabinet.js`**

Строки 18-19 (`// Уровни: viewer — только чтение; manager — товары/реклама/себестоимость + всё чтение;` / `// owner — добавляет финансы/настройки/команду. …`) заменить на:

```js
// Уровни (спека 2026-10-08 «Менеджеры и премия»): viewer — только чтение (кроме «Баланса»);
// manager — запись в товары/склады/себестоимость И финансы (ДДС, закупки, план, расходы,
// самовыкупы, план закупок), чтение всего, кроме «Баланса»; owner — добавляет «Баланс»,
// настройки и API-ключи, команду, подписку и управление премией. GET обычно без requireRole.
```

- [ ] **Step 7: Меню по роли в `app/cabinets/[id]/layout.js`**

1. В пункт `{ href: "/fin-balance", label: "Баланс" }` добавить `roles: ["owner"]`.
2. В запрос membership (`SELECT c.display_name, c.marketplaces, …`) добавить `m.role` первой колонкой.
3. После `const cab = mem[0];` добавить:

```js
  // Видимость пунктов меню по роли (поле roles у пункта; нет поля — видят все).
  // Только витрина: доступ режет сервер (requireRole в роутах).
  const canSee = (x) => !x.roles || x.roles.includes(cab.role);
  const menu = MENU.filter(canSee).map((x) => (x.items ? { ...x, items: x.items.filter(canSee) } : x));
```

4. В JSX `{MENU.map((item) => {` заменить на `{menu.map((item) => {`. Проверить `grep -n "MENU" "app/cabinets/[id]/layout.js"` — других использований `MENU` в рендере нет (если есть — тоже на `menu`).

- [ ] **Step 8: Страница «Баланс» — серверная заглушка**

`app/cabinets/[id]/fin-balance/page.js` целиком:

```js
import BalancePage from './BalancePage';
import { getSession } from '@/lib/session.js';
import { query } from '@/lib/db.js';
export const dynamic = 'force-dynamic';
// «Баланс» — только владелец (спека 2026-10-08 §1). API тоже 403 — это витрина.
export default async function Page({ params }) {
  const cabinetId = Number(params.id);
  const session = await getSession();
  const mem = session?.user_id
    ? await query('SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2', [session.user_id, cabinetId])
    : [];
  if (mem[0]?.role !== 'owner') {
    return <div style={{ padding: 32, color: 'var(--muted)' }}>Нет доступа: раздел «Баланс» доступен только владельцу.</div>;
  }
  return <BalancePage cabinetId={cabinetId} />;
}
```

- [ ] **Step 9: Сборка**

Run: `cd /opt/agents/saas && npm run build 2>&1 | tail -5`
Expected: сборка без ошибок. (Рестарт — в задаче 6 вместе с остальным.)

- [ ] **Step 10: Commit**

```bash
git add lib/__tests__/roleGuards.test.mjs lib/withCabinet.js "app/cabinets/[id]/layout.js" "app/cabinets/[id]/fin-balance/page.js" \
  "app/api/cabinets/[id]/dds/route.js" "app/api/cabinets/[id]/purchases/route.js" "app/api/cabinets/[id]/plan/route.js" \
  "app/api/cabinets/[id]/plan/targets/route.js" "app/api/cabinets/[id]/plan/approve/route.js" "app/api/cabinets/[id]/opex/route.js" \
  "app/api/cabinets/[id]/self-buyouts/route.js" "app/api/cabinets/[id]/purchase-plan/route.js" "app/api/cabinets/[id]/balance/route.js"
git commit -m "feat(roles): менеджер пишет в финансы, «Баланс» только владельцу"
```

---

### Task 3: Миграция `064_bonus.sql`

**Files:**
- Create: `db/migrations/064_bonus.sql`

**Interfaces:**
- Produces: таблицы `tenant.bonus_employees`, `tenant.bonus_plans`, `tenant.bonus_exclusions`, `tenant.bonus_closings` (колонки — ниже), RLS `tenant_iso_<t>` + `panel_local_ro_cab1`.

- [ ] **Step 1: Написать миграцию**

```sql
-- 064_bonus.sql — премия менеджеров площадок (спека 2026-10-08 «Менеджеры и премия»).
-- bonus_employees — кто в программе (площадка, оклад, % бонуса, порог);
-- bonus_plans — план месяца (продажи, прибыль) на сотрудника, правит только владелец;
-- bonus_exclusions — исключённые артикулы месяца + снятая доля плана;
-- bonus_closings — зафиксированные месяцы: снимок входов и результата (JSONB).
-- user_id — auth.users.user_id (FK не ставим: tenant ↔ auth живут раздельно, как везде). Идемпотентно.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant.bonus_employees (
    cabinet_id  BIGINT  NOT NULL,
    user_id     BIGINT  NOT NULL,
    platform    TEXT    NOT NULL CHECK (platform IN ('wb','ozon')),
    salary      NUMERIC(14,2) NOT NULL DEFAULT 40000,
    bonus_pct   NUMERIC(6,4)  NOT NULL DEFAULT 0.04,
    threshold   NUMERIC(6,4)  NOT NULL DEFAULT 0.65,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, user_id)
);

CREATE TABLE IF NOT EXISTS tenant.bonus_plans (
    cabinet_id  BIGINT NOT NULL,
    user_id     BIGINT NOT NULL,
    period      TEXT   NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    sales_plan  NUMERIC(14,2) NOT NULL DEFAULT 0,
    profit_plan NUMERIC(14,2) NOT NULL DEFAULT 0,
    updated_by  BIGINT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, user_id, period)
);

CREATE TABLE IF NOT EXISTS tenant.bonus_exclusions (
    cabinet_id      BIGINT NOT NULL,
    id              BIGSERIAL,
    user_id         BIGINT NOT NULL,
    period          TEXT   NOT NULL,
    sku_key         BIGINT NOT NULL,          -- WB nm_id / Ozon product_id (по площадке сотрудника)
    sales_plan_off  NUMERIC(14,2) NOT NULL DEFAULT 0,
    profit_plan_off NUMERIC(14,2) NOT NULL DEFAULT 0,
    reason          TEXT NOT NULL,
    created_by      BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    UNIQUE (cabinet_id, user_id, period, sku_key)
);

CREATE TABLE IF NOT EXISTS tenant.bonus_closings (
    cabinet_id  BIGINT NOT NULL,
    user_id     BIGINT NOT NULL,
    period      TEXT   NOT NULL,
    snapshot    JSONB  NOT NULL,
    closed_by   BIGINT,
    closed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, user_id, period)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bonus_employees','bonus_plans','bonus_exclusions','bonus_closings'] LOOP
    EXECUTE format('ALTER TABLE tenant.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='tenant_iso_'||t) THEN
      EXECUTE format($p$CREATE POLICY %I ON tenant.%I FOR ALL TO saas_app
                       USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
                       WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint)$p$, 'tenant_iso_'||t, t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename=t AND policyname='panel_local_ro_cab1') THEN
      EXECUTE format('CREATE POLICY panel_local_ro_cab1 ON tenant.%I FOR SELECT TO panel_local_ro USING (cabinet_id = 1)', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.%I TO saas_app', t);
    EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
  END LOOP;
  GRANT USAGE, SELECT ON SEQUENCE tenant.bonus_exclusions_id_seq TO saas_app;
END $$;

COMMIT;
```

- [ ] **Step 2: Применить и проверить идемпотентность**

Run:
```bash
cd /opt/agents/saas
PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f db/migrations/064_bonus.sql
PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f db/migrations/064_bonus.sql
psql -h localhost -U saas_ro -d saas -Atc "select tablename, count(*) from pg_policies where schemaname='tenant' and tablename like 'bonus_%' group by 1 order by 1"
```
Expected: оба прогона `COMMIT` без ошибок; 4 строки, у каждой `2` политики.

- [ ] **Step 3: Commit**

```bash
git add db/migrations/064_bonus.sql
git commit -m "feat(bonus): миграция 064 — таблицы премии менеджеров"
```

---

### Task 4: Данные и API `/api/cabinets/[id]/bonus`

**Files:**
- Create: `lib/bonusData.js`
- Create: `app/api/cabinets/[id]/bonus/route.js`

**Interfaces:**
- Consumes: `computeBonus`, `monthWindow`, `isValidPeriod`, `resolveBonusViewer` (Task 1); таблицы Task 3; `wbProfitCabinet(db, taxMode, {from,to})`, `wbProfitProductBatch(db, taxMode, {from,to}) → Map<nm_id, {revenue, profit,…}>` (`lib/wbMetrics.js`), `ozProfitCabinet`, `ozProfitProductBatch` (`lib/ozonMetrics.js`, Map по product_id); `tenantQuery(sql, params)`, `query(sql, params)`, `DatabaseSync` (`lib/db.js`); `normalizeTaxMode` (`lib/tax.js`).
- Produces:
  - `loadEmployees() → [{user_id, platform, salary, bonus_pct, threshold, is_active, name, email}]` (имена — из `auth.users` вторым запросом через `query`).
  - `buildCard({ employee, period, today, taxMode }) → card` — форма из спеки §4: `{ employee, period, status: 'live'|'closed'|'no_plan'|'no_data', closedAt, closedBy, window, plan, fact, exclusions: [{id, sku_key, name, revenue, profit, sales_plan_off, profit_plan_off, reason}], indicators, avg, eligible, bonusBase, bonus, payout }`.
  - `loadCandidates(cabinetId) → [{user_id, name, email, role}]` — участники кабинета, не в программе.
  - GET `?period=YYYY-MM&user_id=N` → owner: `{ mode:'owner', employees, candidates, card }`; manager в программе: `{ mode:'self', card }`; иначе 403 `{ error: 'Раздел недоступен' }`.
  - POST `{ action, … }` (owner): `employee_upsert`, `plan_set`, `exclusion_add`, `exclusion_delete`, `close`, `reopen`.

- [ ] **Step 1: `lib/bonusData.js`**

```js
// lib/bonusData.js — адаптер БД для премии менеджеров (спека 2026-10-08 §2-4).
// Вызывается ВНУТРИ withCabinet (RLS-транзакция): tenant.* — через tenantQuery, канон
// прибыли — через DatabaseSync. Запросы строго последовательно (один client на транзакцию).
import { DatabaseSync, tenantQuery, query } from "@/lib/db.js";
import { wbProfitCabinet, wbProfitProductBatch } from "@/lib/wbMetrics.js";
import { ozProfitCabinet, ozProfitProductBatch } from "@/lib/ozonMetrics.js";
import { computeBonus, monthWindow } from "@/lib/bonus.js";

const CANON = {
  wb: { cabinet: wbProfitCabinet, batch: wbProfitProductBatch },
  ozon: { cabinet: ozProfitCabinet, batch: ozProfitProductBatch },
};

export async function loadEmployees() {
  const rows = await tenantQuery(
    `SELECT user_id, platform, salary::float8 AS salary, bonus_pct::float8 AS bonus_pct,
            threshold::float8 AS threshold, is_active
       FROM tenant.bonus_employees ORDER BY platform, user_id`);
  if (!rows.length) return [];
  const users = await query(`SELECT user_id, name, email FROM auth.users WHERE user_id = ANY($1::bigint[])`,
    [rows.map((r) => r.user_id)]);
  const byId = new Map(users.map((u) => [Number(u.user_id), u]));
  return rows.map((r) => ({ ...r, user_id: Number(r.user_id), name: byId.get(Number(r.user_id))?.name || null,
    email: byId.get(Number(r.user_id))?.email || null }));
}

export async function loadCandidates(cabinetId) {
  const inProgram = (await tenantQuery(`SELECT user_id FROM tenant.bonus_employees`)).map((r) => Number(r.user_id));
  const rows = await query(
    `SELECT m.user_id, m.role, u.name, u.email FROM auth.memberships m JOIN auth.users u ON u.user_id = m.user_id
      WHERE m.cabinet_id = $1 ORDER BY m.user_id`, [cabinetId]);
  return rows.map((r) => ({ ...r, user_id: Number(r.user_id) })).filter((r) => !inProgram.includes(r.user_id));
}

async function skuNames(platform, keys) {
  if (!keys.length) return new Map();
  const rows = platform === "wb"
    ? await tenantQuery(`SELECT nm_id AS k, name FROM tenant.wb_articles WHERE nm_id = ANY($1::bigint[])`, [keys])
    : await tenantQuery(`SELECT product_id AS k, COALESCE(name, offer_id) AS name FROM tenant.ozon_products WHERE product_id = ANY($1::bigint[])`, [keys]);
  return new Map(rows.map((r) => [Number(r.k), r.name]));
}

// Живой расчёт карточки сотрудника за месяц (без учёта закрытия).
export async function buildLiveCard({ employee, period, today, taxMode }) {
  const [plan] = await tenantQuery(
    `SELECT sales_plan::float8 AS sales_plan, profit_plan::float8 AS profit_plan FROM tenant.bonus_plans
      WHERE user_id = $1 AND period = $2`, [employee.user_id, period]);
  const exRows = await tenantQuery(
    `SELECT id, sku_key, sales_plan_off::float8 AS sales_plan_off, profit_plan_off::float8 AS profit_plan_off, reason
       FROM tenant.bonus_exclusions WHERE user_id = $1 AND period = $2 ORDER BY id`, [employee.user_id, period]);

  const window = monthWindow(period, today);
  let salesFact = 0, profitFact = 0, perSku = new Map();
  if (window) {
    const canon = CANON[employee.platform];
    const db = new DatabaseSync(employee.platform, { readOnly: true });
    const cab = await canon.cabinet(db, taxMode, window);
    salesFact = cab.revenue || 0;
    profitFact = cab.profit || 0;
    if (exRows.length) perSku = await canon.batch(db, taxMode, window);
  }
  const names = await skuNames(employee.platform, exRows.map((e) => Number(e.sku_key)));
  const exclusions = exRows.map((e) => {
    const f = perSku.get(Number(e.sku_key)) || {};
    return { id: Number(e.id), sku_key: Number(e.sku_key), name: names.get(Number(e.sku_key)) || null,
      revenue: f.revenue || 0, profit: f.profit || 0,
      sales_plan_off: e.sales_plan_off, profit_plan_off: e.profit_plan_off, reason: e.reason };
  });

  const r = computeBonus({
    salesPlan: plan?.sales_plan, profitPlan: plan?.profit_plan, salesFact, profitFact,
    exclusions: exclusions.map((e) => ({ revenue: e.revenue, profit: e.profit, salesPlanOff: e.sales_plan_off, profitPlanOff: e.profit_plan_off })),
    salary: employee.salary, bonusPct: employee.bonus_pct, threshold: employee.threshold,
  });
  const status = !window ? "no_data" : r.status === "no_plan" ? "no_plan" : "live";
  // ...r первым: computeBonus тоже отдаёт поле status ('ok'|'no_plan') — карточный статус важнее.
  return { ...r, employee, period, window, status, closedAt: null, closedBy: null,
    platformFact: { revenue: salesFact, profit: profitFact }, exclusions };
}

// Карточка с учётом фиксации: закрытый месяц отдаётся из снимка.
export async function buildCard(args) {
  const [closed] = await tenantQuery(
    `SELECT snapshot, closed_by, closed_at FROM tenant.bonus_closings WHERE user_id = $1 AND period = $2`,
    [args.employee.user_id, args.period]);
  if (closed) return { ...closed.snapshot, status: "closed", closedAt: closed.closed_at, closedBy: Number(closed.closed_by) };
  return buildLiveCard(args);
}

export async function isClosed(userId, period) {
  const r = await tenantQuery(`SELECT 1 FROM tenant.bonus_closings WHERE user_id = $1 AND period = $2`, [userId, period]);
  return r.length > 0;
}
```

- [ ] **Step 2: Роут `app/api/cabinets/[id]/bonus/route.js`**

```js
// /api/cabinets/[id]/bonus — премия менеджеров площадок (спека 2026-10-08 §4).
// GET: владелец — любой сотрудник программы; менеджер — только своя карточка (user_id из
// сессии, параметр запроса игнорируется — resolveBonusViewer); остальные — 403.
// POST: только владелец. Закрытый месяц — план/исключения/закрытие → 409.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery, query } from "@/lib/db.js";
import { normalizeTaxMode } from "@/lib/tax.js";
import { isValidPeriod, resolveBonusViewer } from "@/lib/bonus.js";
import { loadEmployees, loadCandidates, buildCard, buildLiveCard, isClosed } from "@/lib/bonusData.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const todayMsk = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const curPeriod = () => todayMsk().slice(0, 7);
const bad = (error, status = 400) => NextResponse.json({ error }, { status });
const numOr = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));

export const GET = withCabinet(async (req, { cabinet, session }) => {
  const url = new URL(req.url);
  const period = url.searchParams.get("period") || curPeriod();
  if (!isValidPeriod(period)) return bad("period must be YYYY-MM");

  const employees = await loadEmployees();
  const v = resolveBonusViewer({ role: cabinet.role, sessionUserId: session.user_id,
    requestedUserId: url.searchParams.get("user_id"), employees });
  if (v.mode === "denied") return bad("Раздел недоступен", 403);

  const employee = employees.find((e) => e.user_id === v.userId) || null;
  const card = employee
    ? await buildCard({ employee, period, today: todayMsk(), taxMode: normalizeTaxMode(cabinet.shopTax?.[employee.platform]) })
    : null;
  if (v.mode === "self") return NextResponse.json({ mode: "self", period, card });
  const candidates = await loadCandidates(cabinet.cabinet_id);
  return NextResponse.json({ mode: "owner", period, employees, candidates, card });
});

export const POST = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json().catch(() => ({}));
  const uid = Number(b.user_id);
  const me = session.user_id;

  if (b.action === "employee_upsert") {
    if (!["wb", "ozon"].includes(b.platform)) return bad("platform must be wb|ozon");
    const mem = await query(`SELECT 1 FROM auth.memberships WHERE cabinet_id = $1 AND user_id = $2`, [cabinet.cabinet_id, uid]);
    if (!mem.length) return bad("пользователь не участник кабинета");
    const salary = numOr(b.salary, 40000), pct = numOr(b.bonus_pct, 0.04), thr = numOr(b.threshold, 0.65);
    if (![salary, pct, thr].every(Number.isFinite) || salary < 0 || pct < 0 || pct > 1 || thr < 0 || thr > 1)
      return bad("оклад ≥ 0, % бонуса и порог — доли 0..1");
    await tenantQuery(
      `INSERT INTO tenant.bonus_employees (cabinet_id, user_id, platform, salary, bonus_pct, threshold, is_active)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (cabinet_id, user_id) DO UPDATE SET platform = EXCLUDED.platform, salary = EXCLUDED.salary,
         bonus_pct = EXCLUDED.bonus_pct, threshold = EXCLUDED.threshold, is_active = EXCLUDED.is_active, updated_at = now()`,
      [uid, b.platform, salary, pct, thr, b.is_active !== false]);
    return NextResponse.json({ ok: true });
  }

  if (b.action === "exclusion_delete") {
    const [row] = await tenantQuery(`SELECT user_id, period FROM tenant.bonus_exclusions WHERE id = $1`, [Number(b.id)]);
    if (!row) return bad("исключение не найдено", 404);
    if (await isClosed(Number(row.user_id), row.period)) return bad("месяц зафиксирован", 409);
    await tenantQuery(`DELETE FROM tenant.bonus_exclusions WHERE id = $1`, [Number(b.id)]);
    return NextResponse.json({ ok: true });
  }

  // Остальные действия — по сотруднику программы и месяцу.
  if (!isValidPeriod(b.period)) return bad("period must be YYYY-MM");
  const employee = (await loadEmployees()).find((e) => e.user_id === uid);
  if (!employee) return bad("сотрудник не в программе", 404);

  if (b.action === "reopen") {
    await tenantQuery(`DELETE FROM tenant.bonus_closings WHERE user_id = $1 AND period = $2`, [uid, b.period]);
    return NextResponse.json({ ok: true });
  }
  if (await isClosed(uid, b.period)) return bad("месяц зафиксирован — сначала снимите фиксацию", 409);

  if (b.action === "plan_set") {
    const s = Number(b.sales_plan), p = Number(b.profit_plan);
    if (!Number.isFinite(s) || !Number.isFinite(p) || s < 0) return bad("план продаж ≥ 0, план прибыли — число");
    await tenantQuery(
      `INSERT INTO tenant.bonus_plans (cabinet_id, user_id, period, sales_plan, profit_plan, updated_by)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5)
       ON CONFLICT (cabinet_id, user_id, period) DO UPDATE SET sales_plan = EXCLUDED.sales_plan,
         profit_plan = EXCLUDED.profit_plan, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [uid, b.period, s, p, me]);
    return NextResponse.json({ ok: true });
  }

  if (b.action === "exclusion_add") {
    const sku = Number(b.sku_key), so = numOr(b.sales_plan_off, 0), po = numOr(b.profit_plan_off, 0);
    const reason = String(b.reason || "").trim();
    if (!Number.isInteger(sku) || sku <= 0) return bad("sku_key — артикул площадки");
    if (!Number.isFinite(so) || !Number.isFinite(po) || so < 0) return bad("снятый план — числа, продажи ≥ 0");
    if (!reason) return bad("причина обязательна");
    await tenantQuery(
      `INSERT INTO tenant.bonus_exclusions (cabinet_id, user_id, period, sku_key, sales_plan_off, profit_plan_off, reason, created_by)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (cabinet_id, user_id, period, sku_key) DO UPDATE SET sales_plan_off = EXCLUDED.sales_plan_off,
         profit_plan_off = EXCLUDED.profit_plan_off, reason = EXCLUDED.reason`,
      [uid, b.period, sku, so, po, reason, me]);
    return NextResponse.json({ ok: true });
  }

  if (b.action === "close") {
    const card = await buildLiveCard({ employee, period: b.period, today: todayMsk(),
      taxMode: normalizeTaxMode(cabinet.shopTax?.[employee.platform]) });
    if (card.status === "no_data") return bad("месяц ещё не начался — фиксировать нечего");
    await tenantQuery(
      `INSERT INTO tenant.bonus_closings (cabinet_id, user_id, period, snapshot, closed_by)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3::jsonb, $4)`,
      [uid, b.period, JSON.stringify(card), me]);
    return NextResponse.json({ ok: true });
  }

  return bad("unknown action");
}, { requireRole: "owner" });
```

- [ ] **Step 3: Проверка `current_setting` в INSERT**

Run: `grep -rn "current_setting('app.cabinet_id')" app/api | head -3`
Expected: паттерн уже используется в других роутах. Если нет — посмотреть, как соседние роуты (`app/api/cabinets/[id]/opex/route.js` POST) передают `cabinet_id` в INSERT, и сделать так же (`cabinet.cabinet_id` параметром).

- [ ] **Step 4: Сборка**

Run: `cd /opt/agents/saas && npm run build 2>&1 | tail -5`
Expected: без ошибок.

- [ ] **Step 5: Commit**

```bash
git add lib/bonusData.js "app/api/cabinets/[id]/bonus/route.js"
git commit -m "feat(bonus): API премии — карточка, план, исключения, фиксация месяца"
```

---

### Task 5: Страница «Премия»

**Files:**
- Create: `app/cabinets/[id]/bonus/page.js`
- Create: `app/cabinets/[id]/bonus/BonusPage.jsx`
- Modify: `app/cabinets/[id]/layout.js` — пункт меню.

**Interfaces:**
- Consumes: GET/POST `/api/cabinets/${cabinetId}/bonus` (Task 4), поле `roles` у пунктов меню (Task 2).

- [ ] **Step 1: Пункт меню**

В `app/cabinets/[id]/layout.js`, группа «Финансы», сразу после `{ href: "/fin-balance", label: "Баланс", roles: ["owner"] },` добавить:

```js
      { href: "/bonus", label: "Премия", roles: ["owner", "manager"] },
```

- [ ] **Step 2: `page.js`**

```js
import BonusPage from './BonusPage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <BonusPage cabinetId={Number(params.id)} />;
}
```

- [ ] **Step 3: `BonusPage.jsx`**

```jsx
"use client";
// Премия менеджеров площадок (спека 2026-10-08 §5). Владелец — вкладки сотрудников, план,
// исключения, параметры, фиксация; менеджер — только своя карточка, без правки.
import { useEffect, useState, useCallback } from "react";
import { C, soft } from "@/lib/palette.js";

const rub = (v) => (v == null ? "—" : Math.round(v).toLocaleString("ru-RU") + " ₽");
const pct = (v) => (v == null ? "—" : (v * 100).toFixed(1).replace(".", ",") + " %");
const PL = { wb: "WB", ozon: "Ozon" };
const IND = { sales: "Продажи", profit: "Операционная прибыль", margin: "Маржа, %" };
const box = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, marginBottom: 16 };
const inp = { padding: "6px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 13 };
const btn = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, cursor: "pointer", fontSize: 13 };

function curPeriod() { return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7); }

export default function BonusPage({ cabinetId }) {
  const [period, setPeriod] = useState(curPeriod());
  const [userId, setUserId] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [planForm, setPlanForm] = useState({ sales_plan: "", profit_plan: "" });
  const [exForm, setExForm] = useState({ sku_key: "", sales_plan_off: "", profit_plan_off: "", reason: "" });
  const [empForm, setEmpForm] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    const q = new URLSearchParams({ period });
    if (userId) q.set("user_id", String(userId));
    const r = await fetch(`/api/cabinets/${cabinetId}/bonus?${q}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setData(null); setErr(d.error || `Ошибка ${r.status}`); return; }
    setData(d);
    // card.plan — план ПОСЛЕ снятия исключений; в форму — исходный введённый план.
    const c = d.card;
    setPlanForm(c ? { sales_plan: String(Math.round(c.plan.sales + sumOff(c, "sales_plan_off"))),
      profit_plan: String(Math.round(c.plan.profit + sumOff(c, "profit_plan_off"))) } : { sales_plan: "", profit_plan: "" });
  }, [cabinetId, period, userId]);

  useEffect(() => { load(); }, [load]);

  const post = async (body) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/bonus`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { alert(d.error || `Ошибка ${r.status}`); return false; }
      await load();
      return true;
    } finally { setBusy(false); }
  };

  if (err) return <div style={{ padding: 32, color: C.muted }}>{err}</div>;
  if (!data) return <div style={{ padding: 32, color: C.muted }}>Загрузка…</div>;

  const owner = data.mode === "owner";
  const card = data.card;
  const closed = card?.status === "closed";
  const uid = card?.employee?.user_id;

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto", color: C.ink }}>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Премия</h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} style={inp} />
        {owner && data.employees.map((e) => (
          <button key={e.user_id} onClick={() => setUserId(e.user_id)}
            style={{ ...btn, borderColor: e.user_id === uid ? C.accent : C.line, background: e.user_id === uid ? soft("accent", 15) : C.surfaceAlt }}>
            {PL[e.platform]} · {e.name || e.email}{e.is_active ? "" : " (неактивен)"}
          </button>
        ))}
        {owner && <button style={btn} onClick={() => setEmpForm({ user_id: data.candidates[0]?.user_id || "", platform: "wb", salary: 40000, bonus_pct: 4, threshold: 65, is_active: true, isNew: true })}>+ сотрудник</button>}
        {owner && card && <button style={btn} onClick={() => setEmpForm({ user_id: uid, platform: card.employee.platform, salary: card.employee.salary, bonus_pct: card.employee.bonus_pct * 100, threshold: card.employee.threshold * 100, is_active: card.employee.is_active })}>⚙ Параметры</button>}
      </div>

      {empForm && (
        <div style={box}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {empForm.isNew ? (
              <select value={empForm.user_id} onChange={(e) => setEmpForm({ ...empForm, user_id: e.target.value })} style={inp}>
                {data.candidates.length === 0 && <option value="">нет участников вне программы — пригласите в «Команде»</option>}
                {data.candidates.map((c) => <option key={c.user_id} value={c.user_id}>{c.name || c.email} ({c.role})</option>)}
              </select>
            ) : <b>{card?.employee?.name || card?.employee?.email}</b>}
            <select value={empForm.platform} onChange={(e) => setEmpForm({ ...empForm, platform: e.target.value })} style={inp}>
              <option value="wb">WB</option><option value="ozon">Ozon</option>
            </select>
            <label>Оклад <input style={{ ...inp, width: 100 }} value={empForm.salary} onChange={(e) => setEmpForm({ ...empForm, salary: e.target.value })} /></label>
            <label>% от прибыли <input style={{ ...inp, width: 60 }} value={empForm.bonus_pct} onChange={(e) => setEmpForm({ ...empForm, bonus_pct: e.target.value })} /></label>
            <label>Порог, % <input style={{ ...inp, width: 60 }} value={empForm.threshold} onChange={(e) => setEmpForm({ ...empForm, threshold: e.target.value })} /></label>
            <label><input type="checkbox" checked={empForm.is_active} onChange={(e) => setEmpForm({ ...empForm, is_active: e.target.checked })} /> активен</label>
            <button style={btn} disabled={busy || !empForm.user_id} onClick={async () => {
              const ok = await post({ action: "employee_upsert", user_id: Number(empForm.user_id), platform: empForm.platform,
                salary: Number(empForm.salary), bonus_pct: Number(empForm.bonus_pct) / 100, threshold: Number(empForm.threshold) / 100, is_active: empForm.is_active });
              if (ok) { if (empForm.isNew) setUserId(Number(empForm.user_id)); setEmpForm(null); }
            }}>Сохранить</button>
            <button style={btn} onClick={() => setEmpForm(null)}>Отмена</button>
          </div>
        </div>
      )}

      {!card && <div style={{ ...box, color: C.muted }}>{owner ? "В программе пока никого нет — добавьте сотрудника." : "Нет данных."}</div>}

      {card && (
        <>
          <div style={{ ...box, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <b>{PL[card.employee.platform]} · {card.employee.name || card.employee.email}</b>
            <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 12,
              background: closed ? soft("pos", 15) : soft("warn", 15), color: closed ? C.pos : C.warn }}>
              {closed ? `зафиксировано ${new Date(card.closedAt).toLocaleDateString("ru-RU")}` : "предварительно"}
            </span>
            {card.window && <span style={{ color: C.muted, fontSize: 12 }}>факт за {card.window.from} — {card.window.to}</span>}
            {card.status === "no_data" && <span style={{ color: C.muted }}>месяц ещё не начался</span>}
            {owner && !closed && card.status !== "no_data" && <button style={btn} disabled={busy}
              onClick={() => confirm("Зафиксировать месяц? Цифры заморозятся.") && post({ action: "close", user_id: uid, period })}>Зафиксировать месяц</button>}
            {owner && closed && <button style={btn} disabled={busy}
              onClick={() => confirm("Снять фиксацию? Расчёт снова станет живым.") && post({ action: "reopen", user_id: uid, period })}>Снять фиксацию</button>}
          </div>

          {owner && !closed && (
            <div style={{ ...box, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <b>План месяца:</b>
              <label>продажи <input style={{ ...inp, width: 130 }} value={planForm.sales_plan} onChange={(e) => setPlanForm({ ...planForm, sales_plan: e.target.value })} /></label>
              <label>прибыль <input style={{ ...inp, width: 130 }} value={planForm.profit_plan} onChange={(e) => setPlanForm({ ...planForm, profit_plan: e.target.value })} /></label>
              <button style={btn} disabled={busy} onClick={() => post({ action: "plan_set", user_id: uid, period, sales_plan: Number(planForm.sales_plan), profit_plan: Number(planForm.profit_plan) })}>Сохранить план</button>
            </div>
          )}

          <div style={box}>
            {card.status === "no_plan" ? <div style={{ color: C.muted }}>План на месяц не задан — премия не считается, показан только оклад.</div> : card.status !== "no_data" && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead><tr style={{ color: C.muted, textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: 6 }}>Показатель</th><th style={{ padding: 6 }}>План</th><th style={{ padding: 6 }}>Факт</th><th style={{ padding: 6 }}>% выполнения</th>
                </tr></thead>
                <tbody>
                  {card.indicators.map((i) => (
                    <tr key={i.key} style={{ borderTop: `1px solid ${C.line}`, textAlign: "right" }}>
                      <td style={{ textAlign: "left", padding: 6 }}>{IND[i.key]}</td>
                      <td style={{ padding: 6 }}>{i.key === "margin" ? pct(i.plan) : rub(i.plan)}</td>
                      <td style={{ padding: 6 }}>{i.key === "margin" ? pct(i.fact) : rub(i.fact)}</td>
                      <td style={{ padding: 6, color: i.below ? C.neg : C.ink, fontWeight: i.below ? 700 : 400 }}>{pct(i.pct)}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: `2px solid ${C.line}`, textAlign: "right", fontWeight: 700 }}>
                    <td style={{ textAlign: "left", padding: 6 }}>Итого (среднее)</td><td /><td /><td style={{ padding: 6 }}>{pct(card.avg)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>

          <div style={{ ...box, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <div><div style={{ color: C.muted, fontSize: 12 }}>Оклад</div><b>{rub(card.employee.salary)}</b></div>
            <div><div style={{ color: C.muted, fontSize: 12 }}>Бонусная часть ({(card.employee.bonus_pct * 100).toFixed(1).replace(".", ",")} % прибыли)</div><b>{rub(card.bonusBase)}</b></div>
            <div><div style={{ color: C.muted, fontSize: 12 }}>Коэффициент</div>
              <b>{["no_plan", "no_data"].includes(card.status) ? "—" : card.eligible ? pct(card.avg) : `0 — ниже ${Math.round(card.employee.threshold * 100)} %`}</b></div>
            <div><div style={{ color: C.muted, fontSize: 12 }}>Бонус</div><b>{rub(card.bonus)}</b></div>
            <div><div style={{ color: C.muted, fontSize: 12 }}>К оплате</div><b style={{ fontSize: 18, color: C.accent }}>{rub(card.payout)}</b></div>
          </div>

          <div style={box}>
            <b>Исключённые артикулы</b>
            {card.exclusions.length === 0 && <div style={{ color: C.muted, marginTop: 8 }}>Нет.</div>}
            {card.exclusions.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 }}>
                <thead><tr style={{ color: C.muted, textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: 6 }}>Товар</th><th style={{ padding: 6 }}>Факт продаж</th><th style={{ padding: 6 }}>Факт прибыли</th>
                  <th style={{ padding: 6 }}>Снято плана продаж</th><th style={{ padding: 6 }}>Снято плана прибыли</th><th style={{ textAlign: "left", padding: 6 }}>Причина</th><th />
                </tr></thead>
                <tbody>{card.exclusions.map((e) => (
                  <tr key={e.id} style={{ borderTop: `1px solid ${C.line}`, textAlign: "right" }}>
                    <td style={{ textAlign: "left", padding: 6 }}>{e.name || "—"} <span style={{ color: C.muted }}>{e.sku_key}</span></td>
                    <td style={{ padding: 6 }}>{rub(e.revenue)}</td><td style={{ padding: 6 }}>{rub(e.profit)}</td>
                    <td style={{ padding: 6 }}>{rub(e.sales_plan_off)}</td><td style={{ padding: 6 }}>{rub(e.profit_plan_off)}</td>
                    <td style={{ textAlign: "left", padding: 6 }}>{e.reason}</td>
                    <td>{owner && !closed && <button style={btn} disabled={busy} onClick={() => confirm("Убрать исключение?") && post({ action: "exclusion_delete", id: e.id })}>✕</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            {owner && !closed && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                <input placeholder={card.employee.platform === "wb" ? "nm_id" : "product_id"} style={{ ...inp, width: 120 }} value={exForm.sku_key} onChange={(e) => setExForm({ ...exForm, sku_key: e.target.value })} />
                <input placeholder="снять план продаж" style={{ ...inp, width: 140 }} value={exForm.sales_plan_off} onChange={(e) => setExForm({ ...exForm, sales_plan_off: e.target.value })} />
                <input placeholder="снять план прибыли" style={{ ...inp, width: 140 }} value={exForm.profit_plan_off} onChange={(e) => setExForm({ ...exForm, profit_plan_off: e.target.value })} />
                <input placeholder="причина" style={{ ...inp, flex: 1, minWidth: 160 }} value={exForm.reason} onChange={(e) => setExForm({ ...exForm, reason: e.target.value })} />
                <button style={btn} disabled={busy} onClick={async () => {
                  const ok = await post({ action: "exclusion_add", user_id: uid, period, sku_key: Number(exForm.sku_key),
                    sales_plan_off: Number(exForm.sales_plan_off || 0), profit_plan_off: Number(exForm.profit_plan_off || 0), reason: exForm.reason });
                  if (ok) setExForm({ sku_key: "", sales_plan_off: "", profit_plan_off: "", reason: "" });
                }}>+ исключить</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function sumOff(card, key) { return (card.exclusions || []).reduce((a, e) => a + (e[key] || 0), 0); }
```

Примечание к форме плана: `card.plan` — план ПОСЛЕ снятия исключений, поэтому в поле подставляется `plan + Σ снятого` (исходный введённый план). Статус карточки — `live|closed|no_plan|no_data` (у закрытого месяца снимок мог быть `no_plan` — тогда показывается «зафиксировано» и оклад); блок «Коэффициент» показывает `—` для `no_plan`/`no_data`.

- [ ] **Step 4: Скрининги D3/D7**

Run:
```bash
cd /opt/agents/saas
grep -n 'fetch("[^"]*\${' "app/cabinets/[id]/bonus/BonusPage.jsx"   # пусто (D3)
grep -n "useState\|useEffect\|useCallback\|return <div" "app/cabinets/[id]/bonus/BonusPage.jsx" | head -20   # все хуки выше первого return (D7)
npm run build 2>&1 | tail -5
```
Expected: первый grep пуст; хуки — до строки `if (err) return`; сборка без ошибок.

- [ ] **Step 5: Commit**

```bash
git add "app/cabinets/[id]/bonus/page.js" "app/cabinets/[id]/bonus/BonusPage.jsx" "app/cabinets/[id]/layout.js"
git commit -m "feat(bonus): страница «Премия» — карточка, план, исключения, фиксация"
```

---

### Task 6: Смоук, деплой, документация

**Files:**
- Create: `scripts/smoke-bonus.mjs`
- Modify: `AGENTS.md` (раздел «Где что считается» + TL;DR), `docs/superpowers/specs/2026-10-08-managers-bonus-design.md` §5 (меню).

**Interfaces:**
- Consumes: GET `/api/cabinets/1/bonus`, GET `/api/cabinets/1/pnl?from=&to=`, GET `/api/cabinets/1/balance` (Task 2, 4).

- [ ] **Step 1: Смоук (только чтение)**

```js
#!/usr/bin/env node
// scripts/smoke-bonus.mjs — смоук премии менеджеров и прав (спека 2026-10-08). Только чтение.
//   1) владелец: GET /bonus 200, mode=owner;
//   2) у каждого сотрудника программы живой факт площадки = /pnl за то же окно (Δ = 0);
//   3) если в кабинете есть manager: /bonus → только своя карточка (чужой user_id игнорируется)
//      или 403, /balance → 403, POST /bonus → 403.
// Запуск: node scripts/smoke-bonus.mjs [cabinetId=1] [baseUrl]
import { readFileSync } from 'node:fs';
import { sealData } from 'iron-session';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { query } = await import('../lib/db.js');
const CAB = Number(process.argv[2] || 1);
const BASE = process.argv[3] || 'http://127.0.0.1:3200';
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail).slice(0, 400)}`); if (!cond) failed++; };

async function cookieFor(userId) {
  const [u] = await query('SELECT user_id, email, name, session_version FROM auth.users WHERE user_id = $1', [userId]);
  const seal = await sealData({ user_id: u.user_id, email: u.email, name: u.name, sv: u.session_version, active_cabinet_id: null, touched_at: Date.now() },
    { password: process.env.SAAS_SESSION_SECRET, ttl: 7 * 86400 });
  return `saas_session=${encodeURIComponent(seal)}`;
}
const call = async (cookie, path, init = {}) => {
  const r = await fetch(`${BASE}/api/cabinets/${CAB}/${path}`, { ...init, headers: { cookie, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const [{ owner_user_id }] = await query('SELECT owner_user_id FROM auth.cabinets WHERE cabinet_id = $1', [CAB]);
const own = await cookieFor(owner_user_id);
const period = new Date(Date.now() + 3 * 3600e3 - 86400e3 * 15).toISOString().slice(0, 7);
const ob = await call(own, `bonus?period=${period}`);
check('владелец: /bonus 200, mode=owner', ob.status === 200 && ob.data.mode === 'owner', ob);
console.log(`      сотрудников в программе: ${ob.data.employees?.length ?? 0}, период ${period}`);

for (const e of ob.data.employees || []) {
  const c = (await call(own, `bonus?period=${period}&user_id=${e.user_id}`)).data.card;
  if (!c?.window || c.status === 'closed') { console.log(`      ${e.platform}/${e.user_id}: окно пусто или месяц закрыт — пропуск`); continue; }
  const pnl = (await call(own, `pnl?from=${c.window.from}&to=${c.window.to}`)).data;
  const mp = pnl?.[e.platform] || pnl?.current?.[e.platform];
  check(`${e.platform}/${e.user_id}: выручка = /pnl`, mp && Math.abs(mp.revenue - c.platformFact.revenue) < 0.01, { pnl: mp?.revenue, bonus: c.platformFact.revenue });
  check(`${e.platform}/${e.user_id}: прибыль = /pnl`, mp && Math.abs(mp.profit - c.platformFact.profit) < 0.01, { pnl: mp?.profit, bonus: c.platformFact.profit });
}

const managers = await query(`SELECT user_id FROM auth.memberships WHERE cabinet_id = $1 AND role = 'manager'`, [CAB]);
for (const { user_id } of managers) {
  const mc = await cookieFor(user_id);
  const other = (ob.data.employees || []).find((e) => Number(e.user_id) !== Number(user_id));
  const mb = await call(mc, `bonus?period=${period}${other ? `&user_id=${other.user_id}` : ''}`);
  check(`manager ${user_id}: /bonus — своя карточка или 403`,
    (mb.status === 200 && mb.data.mode === 'self' && Number(mb.data.card?.employee?.user_id) === Number(user_id)) || mb.status === 403, mb);
  check(`manager ${user_id}: /balance → 403`, (await call(mc, 'balance')).status === 403);
  check(`manager ${user_id}: POST /bonus → 403`, (await call(mc, 'bonus', { method: 'POST', body: JSON.stringify({ action: 'reopen' }) })).status === 403);
}
if (!managers.length) console.log('      менеджеров в кабинете нет — проверки доступа менеджера пропущены');

console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);
```

Перед запуском свериться с формой ответа `/pnl` (`grep -n "NextResponse.json" "app/api/cabinets/[id]/pnl/route.js"`): если блок площадки лежит не в `data.wb` / `data.current.wb`, поправить строку `const mp = …` под фактический путь.

- [ ] **Step 2: Деплой и смоук**

Run:
```bash
cd /opt/agents/saas
node --test lib/__tests__/bonus.test.mjs lib/__tests__/roleGuards.test.mjs
npm run build 2>&1 | tail -3 && systemctl restart saas-web && sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3200/
node scripts/smoke-bonus.mjs 1
node scripts/smoke-purchase-need.mjs 1
```
Expected: тесты PASS; HTTP 200 (или 307 на /login); `smoke-bonus` — ALL PASS (при пустой программе — только проверка владельца); соседний смоук не сломан.

- [ ] **Step 3: Ручная приёмка владельцем на кабинете #1** (не автоматизируется — запись в боевую БД делает владелец через UI)

1. «Команда» → пригласить тестового пользователя с ролью «Менеджер», принять приглашение.
2. «Премия» → «+ сотрудник» → площадка WB → план месяца (продажи, прибыль).
3. Под менеджером: «Баланса» в меню нет, `/fin-balance` — «Нет доступа»; «Премия» показывает только его карточку; ДДС/закупки сохраняются.
4. `node scripts/smoke-bonus.mjs 1` — ALL PASS, включая проверки менеджера.
5. «Зафиксировать месяц» → цифры не меняются; «Снять фиксацию» → снова живые.

- [ ] **Step 4: Документация**

В `AGENTS.md`, раздел «Где что считается», после пункта «Потребность в закупке» добавить:

```markdown
- **Премия менеджеров площадок (с 2026-10-10)** — страница `/bonus` (меню «Финансы»), API
  `/api/cabinets/[id]/bonus`. Модель — лист KPI владельца: продажи / опер. прибыль / маржа ×
  % выполнения; любой < порога (0,65) → бонус 0; бонус = `bonus_pct` (0,04) × факт прибыли ×
  среднее трёх %; к оплате = оклад (40 000) + бонус, потолка нет. Факт — канон площадки
  (`wbProfitCabinet`/`ozProfitCabinet`: `revenue`, `profit` — как `/pnl`), исключённые
  артикулы снимают свой факт (`…ProfitProductBatch`) и введённую владельцем долю плана.
  Текущий месяц — по вчера; владелец фиксирует месяц (`bonus_closings.snapshot`). Ядро
  `lib/bonus.js` (тесты `lib/__tests__/bonus.test.mjs`), данные `lib/bonusData.js`, миграция
  064. Менеджер видит только свою карточку (user_id из сессии), наблюдатель — 403.
  Смоук `node scripts/smoke-bonus.mjs 1`. Спека `docs/superpowers/specs/2026-10-08-managers-bonus-design.md`.
- **Роли (с 2026-10-10)**: `manager` пишет и в финансы (ДДС, закупки, план, расходы,
  самовыкупы, план закупок); «Баланс» (включая чтение), настройки/ключи, команда, подписка,
  запись премии — только `owner`. Гард `lib/__tests__/roleGuards.test.mjs`.
```

В TL;DR-таблицу добавить строку: `| Премия менеджеров / роли | lib/bonus.js, lib/bonusData.js, app/api/cabinets/[id]/bonus/route.js |`.

В спеке §5 первый абзац заменить на: «Пункт «Премия» в меню «Финансы» (после «Баланса»): виден владельцу и менеджеру. Менеджер не из программы и наблюдатель на странице видят «Раздел недоступен» (наблюдателю пункт скрыт).»

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-bonus.mjs AGENTS.md docs/superpowers/specs/2026-10-08-managers-bonus-design.md
git commit -m "docs+smoke(bonus): смоук премии и прав, AGENTS.md"
```
