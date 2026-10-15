# Платёжный календарь и план поступлений — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Месячная сетка платежей (расходы) и поступлений поверх `tenant.dds_movements`: ручные, повторяющиеся, из «Закупок» и прогноз выплат WB/Ozon, с отметкой «оплачено/получено».

**Architecture:** Одна таблица денег `dds_movements` (planned→paid) + шаблоны `dds_recurring`. Чистое ядро `lib/paymentCalendar.js` (сетка, итоги, раскладка повторов, платежи партии, окна выплат), слой данных `lib/paymentCalendarData.js` (SQL, синхронизация партий, прогнозы), формулы выплат — в `lib/wbMetrics.js`/`lib/ozonMetrics.js`. Роут `payment-calendar`, общий React-компонент `MoneyCalendar` для двух страниц.

**Tech Stack:** Next.js 14 App Router, PostgreSQL + RLS (`lib/db.js`: `withTenant`, `tenantQuery`, `DatabaseSync`), `node:test`, inline-стили + `lib/palette.js`.

**Spec:** `docs/superpowers/specs/2026-10-15-payment-calendar-design.md`

## Global Constraints

- Только кабинет #1 для любых проб/записей/бэкфилла. Чужие кабинеты не трогать.
- Ветка `feat/payment-calendar` (уже создана, спека закоммичена). `git add` — только явный список файлов задачи, никогда `-A`/`.`.
- Миграции идемпотентны, применяются `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f …`. Читать БД — `psql -h localhost -U saas_ro -d saas`.
- Пустой `catch {}` без `console.error` запрещён; ошибка синхронизации партии = ошибка сохранения партии.
- Формулы денег — только через `lib/` (никаких инлайн-формул выплат в роутах).
- Бэкап боевого файла перед правкой: `cp <file> /opt/agentsDB/backups/<name>.$(date +%Y%m%d_%H%M%S).bak`.
- Даты в `dds_movements.date` — `text` формата `YYYY-MM-DD`. Деньги округлять до копеек (`Math.round(x*100)/100`).
- Дефолты выплат: WB — среда (`weekday: 3`, ISO 1=Пн) следующей недели за неделю Пн–Вс; Ozon — 20-е (за 1–15) и 5-е следующего месяца (за 16–конец).
- Остаток поставщику = `W − N` (= `R×U`, курс оплаты) — решение владельца 15.10.
- Запись — `requireRole: 'manager'`, настройки выплат — `owner` (как прочие настройки).
- Не запускать `next dev` в каталоге прода. После правок `app/`/`lib/` — `npm run build && systemctl restart saas-web`.
- Тесты: `node --test lib/__tests__/<file>.test.mjs`.

---

## File Structure

| Файл | Ответственность |
|---|---|
| `db/migrations/070_payment_calendar.sql` | колонки источника в `dds_movements`, таблица `dds_recurring` |
| `lib/purchaseCalc.js` | `computeExcel` (вынесен из роута закупок) |
| `lib/paymentCalendar.js` | чистое ядро: категории, сетка, итоги, повторы, платежи партии, окна выплат |
| `lib/paymentCalendarData.js` | SQL: месяц, синхронизация партии, раскладка повторов, прогнозы МП, мутации |
| `lib/wbMetrics.js` / `lib/ozonMetrics.js` | `wbCashPayoutByWeek`, `ozPayoutByDay` |
| `app/api/cabinets/[id]/payment-calendar/route.js` | GET месяц / POST действия |
| `app/api/cabinets/[id]/purchases/route.js` | импорт `computeExcel`, синхронизация платежей, `calc_balance_due = W−N` |
| `app/api/cabinets/[id]/settings/route.js` + `SettingsPage.jsx` | дни выплат |
| `app/cabinets/[id]/fin-calendar/{page.js,CalendarPage.jsx,MoneyCalendar.jsx,PaymentModal.jsx,FinanceMoneyTabs.jsx}` | UI |
| `app/cabinets/[id]/fin-income/{page.js,IncomePage.jsx}` | План поступлений |
| `scripts/backfill-purchase-payments.mjs`, `scripts/smoke-payment-calendar.mjs` | бэкфилл, смоук |
| удаляются: `app/api/cabinets/[id]/payment-plan/route.js`, `lib/calendarCalc.js` | старый «План платежей» |

---

### Task 1: Миграция 070

**Files:**
- Create: `db/migrations/070_payment_calendar.sql`

**Interfaces:**
- Produces: колонки `tenant.dds_movements.{source_kind, source_ref, amount_planned, paid_at, date_locked}`; таблица `tenant.dds_recurring`; индекс `uq_dds_movements_source`.

- [ ] **Step 1: Написать миграцию**

```sql
-- 070_payment_calendar.sql — платёжный календарь и план поступлений (15.10.2026, спека
-- docs/superpowers/specs/2026-10-15-payment-calendar-design.md). dds_movements — единственная
-- таблица денег: planned → paid. Источник строки — source_kind/source_ref. Идемпотентно.
BEGIN;

ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS source_kind    TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS source_ref     TEXT;
ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS amount_planned NUMERIC;
ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ;
ALTER TABLE tenant.dds_movements ADD COLUMN IF NOT EXISTS date_locked    BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dds_movements_source_kind_chk') THEN
    ALTER TABLE tenant.dds_movements ADD CONSTRAINT dds_movements_source_kind_chk
      CHECK (source_kind IN ('manual','recurring','purchase','mp_payout'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dds_movements_source
    ON tenant.dds_movements (cabinet_id, source_kind, source_ref)
 WHERE source_ref IS NOT NULL AND status <> 'archived';
CREATE INDEX IF NOT EXISTS ix_dds_movements_date ON tenant.dds_movements (cabinet_id, date);

CREATE TABLE IF NOT EXISTS tenant.dds_recurring (
    cabinet_id   BIGINT      NOT NULL,
    id           BIGSERIAL   NOT NULL,
    type         TEXT        NOT NULL CHECK (type IN ('income','expense')),
    amount       NUMERIC     NOT NULL CHECK (amount > 0),
    category     TEXT,
    counterparty TEXT,
    description  TEXT,
    rule         TEXT        NOT NULL CHECK (rule IN ('monthly','weekly','every_n_days')),
    rule_day     INTEGER,
    every_n      INTEGER,
    date_from    DATE        NOT NULL,
    date_to      DATE,
    is_active    BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, id),
    CHECK ((rule = 'monthly' AND rule_day BETWEEN 1 AND 31) OR
           (rule = 'weekly' AND rule_day BETWEEN 1 AND 7) OR
           (rule = 'every_n_days' AND every_n BETWEEN 1 AND 365))
);

DO $$
DECLARE t TEXT := 'dds_recurring';
BEGIN
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
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE tenant.%I TO saas_app', t || '_id_seq');
  EXECUTE format('GRANT SELECT ON tenant.%I TO panel_local_ro', t);
END $$;

COMMIT;
```

- [ ] **Step 2: Применить дважды (идемпотентность)**

Run: `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f db/migrations/070_payment_calendar.sql` — два раза подряд.
Expected: оба раза `COMMIT`, без ошибок.

- [ ] **Step 3: Проверить**

Run: `psql -h localhost -U saas_ro -d saas -Atc "select column_name from information_schema.columns where table_schema='tenant' and table_name='dds_movements' and column_name in ('source_kind','source_ref','amount_planned','paid_at','date_locked'); select count(*) from tenant.dds_recurring; select distinct source_kind from tenant.dds_movements;"`
Expected: 5 колонок, `0`, `manual`.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/070_payment_calendar.sql
git commit -m "feat(payment-calendar): миграция 070 — источник строк ДДС и шаблоны повторов"
```

---

### Task 2: `computeExcel` в lib + остаток по курсу оплаты

**Files:**
- Create: `lib/purchaseCalc.js`, `lib/__tests__/purchaseCalc.test.mjs`
- Modify: `app/api/cabinets/[id]/purchases/route.js` (функция `computeExcel` строки ~38–60 удаляется, импорт; строка ~193 `balanceDue`)

**Interfaces:**
- Produces: `computeExcel(input) → {N, Q, R, S, V, W, Z, unitCost}` (как сейчас) — `import { computeExcel } from "@/lib/purchaseCalc.js"`; `balanceDueRub(calc) → round2(W − N)`.

- [ ] **Step 1: Тест**

```js
// lib/__tests__/purchaseCalc.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { computeExcel, balanceDueRub } from "../purchaseCalc.js";

const P = { prepay_yuan: 1000, prepay_rate: 12, qty: 100, unit_cost_yuan: 30,
  exchange_rate: 12.5, logistics_rub_per_unit: 20, logistics_rub: 5 };

test("computeExcel: формулы Excel владельца", () => {
  const f = computeExcel(P);
  assert.equal(f.N, 12000);          // L×M
  assert.equal(f.Q, 3000);           // O×P
  assert.equal(f.R, 2000);           // Q−L
  assert.equal(f.S, 24000);          // M×R
  assert.equal(f.W, 37000);          // R×U+N
  assert.equal(f.Z, 39500);          // W+(X+Y)×O
  assert.equal(f.unitCost, 395);
});

test("balanceDueRub: остаток по курсу оплаты = W − N = R×U", () => {
  assert.equal(balanceDueRub(computeExcel(P)), 25000);
});

test("computeExcel: без qty", () => {
  const f = computeExcel({ prepay_yuan: 100, prepay_rate: 10 });
  assert.equal(f.Q, null);
  assert.equal(f.unitCost, null);
});
```

- [ ] **Step 2: Запустить — падает** (`node --test lib/__tests__/purchaseCalc.test.mjs` → `Cannot find module`).

- [ ] **Step 3: Вынести `computeExcel`**

Создать `lib/purchaseCalc.js`: перенести из роута ДОСЛОВНО шапочный комментарий формул (`N=L×M … AA=Z/O`), хелперы `numOr`/`round2` (скопировать из роута, если они там локальные; если роут ими пользуется и дальше — экспортировать из `lib/purchaseCalc.js` и импортировать в роут) и функцию `computeExcel` целиком, с `export`. Добавить:

```js
// Остаток к оплате поставщику — по курсу ОПЛАТЫ U (R×U = W − N), решение владельца 15.10.2026:
// сумма «предоплата + остаток» сходится с W, а значит платежи партии — с её себестоимостью Z.
// Колонка S (= M×R, курс аванса) остаётся формулой Excel владельца, но не «остатком к оплате».
export function balanceDueRub(calc) {
  return round2((calc.W ?? 0) - (calc.N ?? 0));
}
```

В роуте: удалить локальные `computeExcel` (и `numOr`/`round2`, если вынесены), добавить `import { computeExcel, balanceDueRub } from "@/lib/purchaseCalc.js";` и заменить
`const balanceDue = it.pay_status === "paid" ? 0 : (f.S ?? 0);` на
`const balanceDue = it.pay_status === "paid" ? 0 : balanceDueRub(f);`.

- [ ] **Step 4: Тесты зелёные** — `node --test lib/__tests__/purchaseCalc.test.mjs` → PASS; `node -e "import('/opt/agents/saas/lib/purchaseCalc.js').then(m=>console.log(typeof m.computeExcel))"` → `function`.

- [ ] **Step 5: Commit**

```bash
cp app/api/cabinets/[id]/purchases/route.js /opt/agentsDB/backups/purchases.route.js.$(date +%Y%m%d_%H%M%S).bak   # до правки!
git add lib/purchaseCalc.js lib/__tests__/purchaseCalc.test.mjs "app/api/cabinets/[id]/purchases/route.js"
git commit -m "refactor(purchases): computeExcel в lib; остаток к оплате по курсу оплаты (R×U)"
```

---

### Task 3: Чистое ядро `lib/paymentCalendar.js`

**Files:**
- Create: `lib/paymentCalendar.js`, `lib/__tests__/paymentCalendar.test.mjs`

**Interfaces:**
- Consumes: `computeExcel`, `balanceDueRub` из `lib/purchaseCalc.js`.
- Produces:
  - `CATEGORIES: Array<{key, label, token}>`; `categoryOf(category: string|null) → key`
  - `monthGrid(month: "YYYY-MM") → Array<Array<{date, inMonth: boolean}>>` (недели Пн–Вс)
  - `summarize(rows, {today}) → {planned, paid, left, overdue}` — по строкам `{amount, status, date}`
  - `weekSummary(rows) → {total, left}`
  - `expandRecurring(tpl, from, to) → string[]` (даты `YYYY-MM-DD`)
  - `purchasePayments(p) → Array<{key, ref, category, amount, date, description}>`
  - `wbPayoutWindows(from, to, {weekday}) → Array<{ref, winFrom, winTo, payDate}>`
  - `ozPayoutWindows(from, to, {day1, day2}) → Array<{ref, winFrom, winTo, payDate}>`
  - `PAYOUT_DEFAULTS = {wb:{weekday:3}, ozon:{day1:20, day2:5}}`; `readPayoutSettings(settings) → {wb, ozon}`

- [ ] **Step 1: Тесты**

```js
// lib/__tests__/paymentCalendar.test.mjs — ядро платёжного календаря (15.10.2026).
import test from "node:test";
import assert from "node:assert/strict";
import {
  categoryOf, monthGrid, summarize, weekSummary, expandRecurring, purchasePayments,
  wbPayoutWindows, ozPayoutWindows, readPayoutSettings,
} from "../paymentCalendar.js";
import { computeExcel } from "../purchaseCalc.js";

test("monthGrid: октябрь 2026 — с Пн 28.09 по Вс 01.11", () => {
  const g = monthGrid("2026-10");
  assert.equal(g.length, 5);
  assert.equal(g[0][0].date, "2026-09-28");
  assert.equal(g[0][0].inMonth, false);
  assert.equal(g[0][3].date, "2026-10-01");
  assert.equal(g[4][6].date, "2026-11-01");
  assert.ok(g.every((w) => w.length === 7));
});

test("monthGrid: февраль 2027 (Пн 1-го) — 4 недели", () => {
  const g = monthGrid("2027-02");
  assert.equal(g[0][0].date, "2027-02-01");
  assert.equal(g.length, 4);
});

test("categoryOf: старые категории ДДС маппятся", () => {
  assert.equal(categoryOf("Закупка"), "supplier");
  assert.equal(categoryOf("ЗП"), "salary");
  assert.equal(categoryOf("Налоги"), "tax");
  assert.equal(categoryOf("что-то своё"), "other");
  assert.equal(categoryOf(null), "other");
});

test("summarize: план/оплачено/осталось/просрочено", () => {
  const rows = [
    { amount: 100, status: "paid", date: "2026-10-01" },
    { amount: 50, status: "planned", date: "2026-10-10" },
    { amount: 30, status: "planned", date: "2026-10-20" },
  ];
  assert.deepEqual(summarize(rows, { today: "2026-10-15" }), { planned: 180, paid: 100, left: 80, overdue: 50 });
  assert.deepEqual(weekSummary(rows), { total: 180, left: 80 });
});

test("expandRecurring: monthly 31-го → последний день месяца", () => {
  const d = expandRecurring({ rule: "monthly", rule_day: 31, date_from: "2026-01-15" }, "2026-01-01", "2026-04-30");
  assert.deepEqual(d, ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("expandRecurring: weekly по пятницам, date_to обрезает", () => {
  const d = expandRecurring({ rule: "weekly", rule_day: 5, date_from: "2026-10-01", date_to: "2026-10-20" }, "2026-10-01", "2026-12-31");
  assert.deepEqual(d, ["2026-10-02", "2026-10-09", "2026-10-16"]);
});

test("expandRecurring: every_n_days от date_from", () => {
  const d = expandRecurring({ rule: "every_n_days", every_n: 10, date_from: "2026-10-01" }, "2026-10-05", "2026-10-31");
  assert.deepEqual(d, ["2026-10-11", "2026-10-21", "2026-10-31"]);
});

const PUR = { id: 7, supplier_name: "Фабрика", prepay_yuan: 1000, prepay_rate: 12, qty: 100,
  unit_cost_yuan: 30, exchange_rate: 12.5, logistics_rub_per_unit: 20, logistics_rub: 5,
  order_dt: "2026-10-01", ship_dt: null, plan_ship_dt: "2026-10-20", delivery_dt: null,
  plan_arrival_dt: "2026-11-10", date: "2026-09-30" };

test("purchasePayments: 4 платежа, сумма = Z, даты с фолбэком на план", () => {
  const p = purchasePayments(PUR);
  assert.deepEqual(p.map((x) => [x.key, x.amount, x.date]), [
    ["prepay", 12000, "2026-10-01"],
    ["balance", 25000, "2026-10-20"],
    ["cargo", 2000, "2026-11-10"],
    ["ff", 500, "2026-11-10"],
  ]);
  assert.equal(p.reduce((s, x) => s + x.amount, 0), computeExcel(PUR).Z);
  assert.equal(p[0].ref, "purchase:7:prepay");
  assert.equal(p[0].category, "Поставщик");
  assert.equal(p[2].category, "Карго/логистика");
});

test("purchasePayments: нулевые не создаются, без дат — date партии", () => {
  const p = purchasePayments({ id: 8, qty: 10, unit_cost_yuan: 5, exchange_rate: 10, date: "2026-10-03" });
  assert.deepEqual(p.map((x) => [x.key, x.amount, x.date]), [["balance", 500, "2026-10-03"]]);
});

test("wbPayoutWindows: неделя Пн–Вс → среда следующей", () => {
  const w = wbPayoutWindows("2026-10-01", "2026-10-31", { weekday: 3 });
  const first = w.find((x) => x.winFrom === "2026-09-28");
  assert.deepEqual(first, { ref: "wb:2026-09-28", winFrom: "2026-09-28", winTo: "2026-10-04", payDate: "2026-10-07" });
  assert.ok(w.every((x) => x.payDate >= "2026-10-01" && x.payDate <= "2026-10-31"));
});

test("ozPayoutWindows: 1–15 → 20-е, 16–конец → 5-е следующего", () => {
  const w = ozPayoutWindows("2026-10-01", "2026-10-31", { day1: 20, day2: 5 });
  assert.deepEqual(w, [
    { ref: "ozon:2026-09-2", winFrom: "2026-09-16", winTo: "2026-09-30", payDate: "2026-10-05" },
    { ref: "ozon:2026-10-1", winFrom: "2026-10-01", winTo: "2026-10-15", payDate: "2026-10-20" },
  ]);
});

test("readPayoutSettings: дефолты и кламп", () => {
  assert.deepEqual(readPayoutSettings(null), { wb: { weekday: 3 }, ozon: { day1: 20, day2: 5 } });
  assert.deepEqual(readPayoutSettings({ payouts: { wb: { weekday: 9 }, ozon: { day1: 25 } } }),
    { wb: { weekday: 3 }, ozon: { day1: 25, day2: 5 } });
});
```

- [ ] **Step 2: Запустить — падает** (`node --test lib/__tests__/paymentCalendar.test.mjs`).

- [ ] **Step 3: Реализация**

```js
// lib/paymentCalendar.js — чистое ядро платёжного календаря и плана поступлений (15.10.2026,
// спека docs/superpowers/specs/2026-10-15-payment-calendar-design.md). Без БД.
// Даты — строки YYYY-MM-DD, арифметика в UTC (никаких локальных часовых поясов).
import { computeExcel, balanceDueRub } from "./purchaseCalc.js";

export const CATEGORIES = [
  { key: "supplier", label: "Поставщик", token: "pink" },
  { key: "cargo", label: "Карго/логистика", token: "blue" },
  { key: "ff", label: "Фулфилмент", token: "accent" },
  { key: "tax", label: "Налоги", token: "warn" },
  { key: "salary", label: "Зарплата", token: "accent2" },
  { key: "rent", label: "Аренда", token: "muted" },
  { key: "subs", label: "Подписки", token: "faint" },
  { key: "ads", label: "Реклама", token: "neg" },
  { key: "mp", label: "Выплата МП", token: "pos" },
  { key: "other", label: "Прочее", token: "line" },
];
const LEGACY = { "Закупка": "supplier", "ЗП": "salary", "Возврат МП": "mp" };
const BY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.label, c.key]));

export function categoryOf(category) {
  if (!category) return "other";
  return BY_LABEL[category] || LEGACY[category] || "other";
}

const r2 = (x) => Math.round(x * 100) / 100;
const D = (s) => new Date(s + "T00:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const isoDow = (s) => ((D(s).getUTCDay() + 6) % 7) + 1; // 1=Пн … 7=Вс
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1..12

export function monthGrid(month) {
  const first = month + "-01";
  const [y, m] = month.split("-").map(Number);
  const last = `${month}-${String(lastDay(y, m)).padStart(2, "0")}`;
  let cur = addDays(first, 1 - isoDow(first));
  const weeks = [];
  while (cur <= last) {
    const w = [];
    for (let i = 0; i < 7; i++) { w.push({ date: cur, inMonth: cur.slice(0, 7) === month }); cur = addDays(cur, 1); }
    weeks.push(w);
  }
  return weeks;
}

export function summarize(rows, { today }) {
  let planned = 0, paid = 0, overdue = 0;
  for (const r of rows) {
    const a = Number(r.amount) || 0;
    planned += a;
    if (r.status === "paid") paid += a;
    else if (r.date < today) overdue += a;
  }
  return { planned: r2(planned), paid: r2(paid), left: r2(planned - paid), overdue: r2(overdue) };
}

export function weekSummary(rows) {
  const s = summarize(rows, { today: "0000-00-00" });
  return { total: s.planned, left: s.left };
}

export function expandRecurring(tpl, from, to) {
  const start = tpl.date_from > from ? tpl.date_from : from;
  const end = tpl.date_to && tpl.date_to < to ? tpl.date_to : to;
  const out = [];
  if (start > end) return out;
  if (tpl.rule === "monthly") {
    let [y, m] = start.split("-").map(Number);
    for (;;) {
      const d = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(tpl.rule_day, lastDay(y, m))).padStart(2, "0")}`;
      if (d > end) break;
      if (d >= start) out.push(d);
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
  } else if (tpl.rule === "weekly") {
    let d = addDays(start, (tpl.rule_day - isoDow(start) + 7) % 7);
    for (; d <= end; d = addDays(d, 7)) out.push(d);
  } else if (tpl.rule === "every_n_days") {
    const n = Number(tpl.every_n);
    const gap = Math.round((D(start) - D(tpl.date_from)) / 86400000);
    let d = addDays(tpl.date_from, Math.ceil(gap / n) * n);
    for (; d <= end; d = addDays(d, n)) out.push(d);
  }
  return out;
}

const firstDate = (...xs) => {
  for (const x of xs) if (x && /^\d{4}-\d{2}-\d{2}/.test(String(x))) return String(x).slice(0, 10);
  return null;
};

export function purchasePayments(p) {
  const f = computeExcel(p);
  const O = Number(p.qty) > 0 ? Number(p.qty) : 1;
  const fallback = firstDate(p.date) || new Date().toISOString().slice(0, 10);
  const arrival = firstDate(p.delivery_dt, p.plan_arrival_dt);
  const parts = [
    { key: "prepay", category: "Поставщик", what: "предоплата", amount: f.N, date: firstDate(p.order_dt, p.plan_order_dt) },
    { key: "balance", category: "Поставщик", what: "остаток", amount: balanceDueRub(f), date: firstDate(p.ship_dt, p.plan_ship_dt) },
    { key: "cargo", category: "Карго/логистика", what: "карго до МСК", amount: r2((Number(p.logistics_rub_per_unit) || 0) * O), date: arrival },
    { key: "ff", category: "Карго/логистика", what: "МСК→ФФ", amount: r2((Number(p.logistics_rub) || 0) * O), date: arrival },
  ];
  return parts
    .filter((x) => x.amount > 0)
    .map((x) => ({
      key: x.key, ref: `purchase:${p.id}:${x.key}`, category: x.category, amount: r2(x.amount),
      date: x.date || fallback, description: `Партия #${p.id} · ${x.what}`,
    }));
}

export const PAYOUT_DEFAULTS = { wb: { weekday: 3 }, ozon: { day1: 20, day2: 5 } };
const intIn = (v, lo, hi, dflt) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : dflt);

export function readPayoutSettings(settings) {
  const p = settings?.payouts || {};
  return {
    wb: { weekday: intIn(p.wb?.weekday, 1, 7, PAYOUT_DEFAULTS.wb.weekday) },
    ozon: { day1: intIn(p.ozon?.day1, 1, 28, PAYOUT_DEFAULTS.ozon.day1), day2: intIn(p.ozon?.day2, 1, 28, PAYOUT_DEFAULTS.ozon.day2) },
  };
}

// Окна выплат, чья ДАТА ВЫПЛАТЫ попадает в [from, to].
export function wbPayoutWindows(from, to, { weekday }) {
  const out = [];
  // понедельник недели, выплата за которую может прийти в from: окно на 1–2 недели раньше
  let mon = addDays(from, 1 - isoDow(from) - 14);
  for (; ; mon = addDays(mon, 7)) {
    const payDate = addDays(mon, 7 + weekday - 1);
    if (payDate > to) break;
    if (payDate >= from) out.push({ ref: `wb:${mon}`, winFrom: mon, winTo: addDays(mon, 6), payDate });
  }
  return out;
}

export function ozPayoutWindows(from, to, { day1, day2 }) {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  m -= 1; if (m < 1) { m = 12; y -= 1; } // начинаем с прошлого месяца: его 16–конец платится в этом
  for (let i = 0; i < 4; i++) {
    const mm = String(m).padStart(2, "0");
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const cand = [
      { ref: `ozon:${y}-${mm}-1`, winFrom: `${y}-${mm}-01`, winTo: `${y}-${mm}-15`, payDate: `${y}-${mm}-${String(day1).padStart(2, "0")}` },
      { ref: `ozon:${y}-${mm}-2`, winFrom: `${y}-${mm}-16`, winTo: `${y}-${mm}-${String(lastDay(y, m)).padStart(2, "0")}`,
        payDate: `${ny}-${String(nm).padStart(2, "0")}-${String(day2).padStart(2, "0")}` },
    ];
    for (const c of cand) if (c.payDate >= from && c.payDate <= to) out.push(c);
    y = ny; m = nm;
  }
  return out.sort((a, b) => a.payDate.localeCompare(b.payDate));
}
```

- [ ] **Step 4: Тесты зелёные** — `node --test lib/__tests__/paymentCalendar.test.mjs` → все PASS. Если какой-то ожидаемый результат в тесте неверен арифметически — перепроверить руками и исправить ТЕСТ только с объяснением в коммите (не подгонять код под ошибку).

- [ ] **Step 5: Commit**

```bash
git add lib/paymentCalendar.js lib/__tests__/paymentCalendar.test.mjs
git commit -m "feat(payment-calendar): чистое ядро — сетка, итоги, повторы, платежи партии, окна выплат"
```

---

### Task 4: Суммы выплат МП в слоях метрик + контракт

**Files:**
- Modify: `lib/wbMetrics.js` (добавить в конец), `lib/ozonMetrics.js` (добавить в конец), `docs/metrics-contract.md` (новый параграф)

**Interfaces:**
- Produces:
  - `wbCashPayoutByWeek(db, { from, to }) → Array<{ week: "YYYY-MM-DD"(понедельник), amount: number, lastDay: "YYYY-MM-DD" }>` — `db = new DatabaseSync("wb")`
  - `ozPayoutByDay(db, { from, to }) → Array<{ date, amount }>` — `db = new DatabaseSync("ozon")`

- [ ] **Step 1: WB**

```js
// =====================================================================
//  ИТОГО К ОПЛАТЕ (cashPayout, контракт §20) — деньги, которые WB перечислит за неделю
//  Пн–Вс по rr_dt: к перечислению за продажи − за возвраты − логистика − хранение − штрафы −
//  удержания (вкл. «WB Продвижение»: в прибыли не вычитается второй раз, но деньги удерживаются)
//  − платная приёмка + доплаты. Только для прогноза поступлений (платёжный календарь).
// =====================================================================
export async function wbCashPayoutByWeek(db, { from, to } = {}) {
  return (await db
    .prepare(
      `SELECT date_trunc('week', substr(rr_dt,1,10)::date)::date::text AS week,
              MAX(substr(rr_dt,1,10)) AS last_day,
              SUM(CASE WHEN doc_type_name = 'Возврат' THEN -COALESCE(ppvz_for_pay,0) ELSE COALESCE(ppvz_for_pay,0) END)
                - SUM(COALESCE(delivery_rub,0)) - SUM(COALESCE(storage_fee,0)) - SUM(COALESCE(penalty,0))
                - SUM(COALESCE(deduction,0)) - SUM(COALESCE(acceptance,0)) + SUM(COALESCE(additional_payment,0)) AS amount
       FROM finance_report
       WHERE substr(rr_dt,1,10) >= ? AND substr(rr_dt,1,10) <= ?
       GROUP BY 1 ORDER BY 1`
    )
    .all(from, to))
    .map((r) => ({ week: r.week, lastDay: r.last_day, amount: Math.round(Number(r.amount) * 100) / 100 }));
}
```

- [ ] **Step 2: Ozon**

```js
// =====================================================================
//  ВЫПЛАТА OZON по дням (контракт §20) — Σ начислений ozon_accruals.accrued (со знаком) за день.
//  Окна выплат (1–15 / 16–конец) собирает lib/paymentCalendar.js. Только для прогноза поступлений.
// =====================================================================
export async function ozPayoutByDay(db, { from, to } = {}) {
  return (await db
    .prepare(
      `SELECT date::text AS date, SUM(accrued) AS amount
       FROM tenant.ozon_accruals
       WHERE date >= ?::date AND date <= ?::date
       GROUP BY date ORDER BY date`
    )
    .all(from, to))
    .map((r) => ({ date: r.date, amount: Math.round(Number(r.amount) * 100) / 100 }));
}
```

- [ ] **Step 3: Живая проверка на #1** (скрипт в scratchpad, не в репо):

```bash
cat > /tmp/claude-0/-opt-agents-saas/*/scratchpad/payout_probe.mjs <<'EOF'
import { readFileSync } from 'node:fs';
for (const l of readFileSync('/opt/agents/saas/.env.local','utf8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2]; }
const { withTenant, DatabaseSync } = await import('/opt/agents/saas/lib/db.js');
const { wbCashPayoutByWeek } = await import('/opt/agents/saas/lib/wbMetrics.js');
const { ozPayoutByDay } = await import('/opt/agents/saas/lib/ozonMetrics.js');
await withTenant(1, async () => {
  console.log(await wbCashPayoutByWeek(new DatabaseSync('wb'), { from: '2026-09-28', to: '2026-10-11' }));
  const oz = await ozPayoutByDay(new DatabaseSync('ozon'), { from: '2026-10-01', to: '2026-10-15' });
  console.log(oz.length, oz.reduce((s, x) => s + x.amount, 0));
});
process.exit(0);
EOF
node /tmp/claude-0/-opt-agents-saas/*/scratchpad/payout_probe.mjs
```
Expected: 2 недели WB с положительной суммой порядка 100–150 тыс ₽ (неделя 05–11.10: 162 633 − 1 317 − 32 830 − 677 − 14 691 ≈ 113 тыс); Ozon — 15 дней, сумма > 0. Если `tenant.ozon_accruals` не проходит через `convertSql` — заменить на голое имя по маппингу `lib/db.js` и отметить в отчёте.

- [ ] **Step 4: Контракт** — в `docs/metrics-contract.md` добавить в конец параграф:

```markdown
## §20. Итого к оплате (cashPayout) — прогноз поступлений, 15.10.2026

Только для «Плана поступлений» (платёжный календарь), в прибыль/выручку не входит.
- **WB** (`wbCashPayoutByWeek`, `lib/wbMetrics.js`): неделя Пн–Вс по `rr_dt`:
  Σ `ppvz_for_pay` (продажи) − Σ `ppvz_for_pay` (возвраты) − логистика (`delivery_rub`) − хранение −
  штрафы − удержания (`deduction`, вкл. «WB Продвижение») − платная приёмка + `additional_payment`.
  Выплата — в настраиваемый день следующей недели (дефолт среда).
- **Ozon** (`ozPayoutByDay`, `lib/ozonMetrics.js`): Σ `ozon_accruals.accrued` за окно 1–15 / 16–конец месяца;
  выплата 20-го / 5-го следующего месяца (настраивается).
- Источник правды — фактическая сумма, введённая при отметке «получено» (`dds_movements.amount`);
  прогноз (`amount_planned`) — оценка. Сверка прогноза WB с «Итого к оплате» еженедельного финансового
  отчёта ЛК WB — приёмка владельцем.
```

- [ ] **Step 5: Commit**

```bash
git add lib/wbMetrics.js lib/ozonMetrics.js docs/metrics-contract.md
git commit -m "feat(metrics): итого к оплате WB по неделям и выплаты Ozon по дням (контракт §20)"
```

---

### Task 5: Слой данных `lib/paymentCalendarData.js` + синхронизация партий

**Files:**
- Create: `lib/paymentCalendarData.js`, `scripts/backfill-purchase-payments.mjs`
- Modify: `app/api/cabinets/[id]/purchases/route.js` (UPDATE-ветка, INSERT-ветка, DELETE)

**Interfaces:**
- Consumes: Task 3 (`purchasePayments`, `expandRecurring`, `wbPayoutWindows`, `ozPayoutWindows`, `readPayoutSettings`, `addDays`), Task 4 (`wbCashPayoutByWeek`, `ozPayoutByDay`), `tenantQuery`, `query`, `DatabaseSync` из `lib/db.js`. Все функции вызываются ВНУТРИ `withTenant` (транзакция роута).
- Produces:
  - `syncPurchasePayments(purchaseId: number) → {upserted, archived}`
  - `archivePurchasePayments(purchaseId: number) → number`
  - `ensureRecurring(today: string, horizonDays = 92) → number` (вставлено строк)
  - `loadMonth({ cabinetId, month, kind, today }) → { rows, forecasts }` — `rows`: строки `dds_movements` месяца (`id, date, type, amount, amount_planned, category, counterparty, description, status, source_kind, source_ref, date_locked, paid_at`); `forecasts`: `[{ ref, platform, date, amount, winFrom, winTo, accruing }]` (только `kind='income'`, только окна без строки `mp_payout`)
  - `createMovement(b)`, `updateMovement(id, b)`, `markPaid(id, amount?)`, `unmarkPaid(id)`, `archiveMovement(id)`, `receivePayout({ref, platform, date, amount, amount_planned})`
  - `saveRecurring(b) → id`, `deleteRecurring(id)`

- [ ] **Step 1: Реализация** (запросы СТРОГО последовательно, без `Promise.all` — один client на транзакцию)

```js
// lib/paymentCalendarData.js — данные платёжного календаря (15.10.2026). Все функции — внутри
// withTenant (одна транзакция роута); запросы последовательно. Спека
// docs/superpowers/specs/2026-10-15-payment-calendar-design.md §2.
import { tenantQuery, query, DatabaseSync } from "./db.js";
import { purchasePayments, expandRecurring, wbPayoutWindows, ozPayoutWindows, readPayoutSettings, addDays } from "./paymentCalendar.js";
import { wbCashPayoutByWeek } from "./wbMetrics.js";
import { ozPayoutByDay } from "./ozonMetrics.js";

const COLS = `id, date, type, amount::float8 AS amount, amount_planned::float8 AS amount_planned, category,
  counterparty, description, status, source_kind, source_ref, date_locked, paid_at`;

export async function syncPurchasePayments(purchaseId) {
  const p = (await tenantQuery(`SELECT * FROM tenant.purchases WHERE id = $1`, [purchaseId]))[0];
  if (!p || p.deleted_at) return { upserted: 0, archived: await archivePurchasePayments(purchaseId) };
  const want = purchasePayments(p);
  const existing = await tenantQuery(
    `SELECT id, source_ref, status, date_locked FROM tenant.dds_movements
      WHERE source_kind = 'purchase' AND source_ref LIKE $1 AND status <> 'archived'`, [`purchase:${purchaseId}:%`]);
  const byRef = new Map(existing.map((r) => [r.source_ref, r]));
  let upserted = 0, archived = 0;
  for (const w of want) {
    const cur = byRef.get(w.ref);
    byRef.delete(w.ref);
    if (!cur) {
      await tenantQuery(
        `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, category, counterparty,
           description, status, source, source_kind, source_ref)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, 'expense', $2, $2, $3, $4, $5, 'planned', 'purchase', 'purchase', $6)`,
        [w.date, w.amount, w.category, p.supplier_name || null, w.description, w.ref]);
      upserted++;
    } else if (cur.status === "planned") {
      await tenantQuery(
        `UPDATE tenant.dds_movements SET amount = $1, amount_planned = $1, counterparty = $2, description = $3,
            date = CASE WHEN date_locked THEN date ELSE $4 END, updated_at = now() WHERE id = $5`,
        [w.amount, p.supplier_name || null, w.description, w.date, cur.id]);
      upserted++;
    }
  }
  for (const stale of byRef.values()) {
    if (stale.status !== "planned") continue; // оплаченное не трогаем
    await tenantQuery(`UPDATE tenant.dds_movements SET status = 'archived', updated_at = now() WHERE id = $1`, [stale.id]);
    archived++;
  }
  return { upserted, archived };
}

export async function archivePurchasePayments(purchaseId) {
  const r = await tenantQuery(
    `UPDATE tenant.dds_movements SET status = 'archived', updated_at = now()
      WHERE source_kind = 'purchase' AND source_ref LIKE $1 AND status = 'planned' RETURNING id`,
    [`purchase:${purchaseId}:%`]);
  return r.length;
}

export async function ensureRecurring(today, horizonDays = 92) {
  const to = addDays(today, horizonDays);
  const tpls = await tenantQuery(`SELECT * FROM tenant.dds_recurring WHERE is_active`);
  let n = 0;
  for (const t of tpls) {
    const tpl = { ...t, date_from: String(t.date_from).slice(0, 10), date_to: t.date_to ? String(t.date_to).slice(0, 10) : null };
    for (const d of expandRecurring(tpl, today, to)) {
      const r = await tenantQuery(
        `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, category, counterparty,
           description, status, source, source_kind, source_ref)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $3, $4, $5, $6, 'planned', 'recurring', 'recurring', $7)
         ON CONFLICT DO NOTHING RETURNING id`,
        [d, t.type, Number(t.amount), t.category, t.counterparty, t.description, `recurring:${t.id}:${d}`]);
      n += r.length;
    }
  }
  return n;
}

export async function loadMonth({ cabinetId, month, kind, today }) {
  await ensureRecurring(today);
  const from = month + "-01";
  const to = addDays(addDays(from, 40).slice(0, 7) + "-01", -1);
  // сетка показывает соседние дни → берём с запасом в неделю
  const gFrom = addDays(from, -7), gTo = addDays(to, 7);
  const type = kind === "income" ? "income" : "expense";
  const rows = await tenantQuery(
    `SELECT ${COLS} FROM tenant.dds_movements
      WHERE status <> 'archived' AND type = $1 AND date >= $2 AND date <= $3 ORDER BY date, id`, [type, gFrom, gTo]);
  if (type !== "income") return { rows, forecasts: [] };

  const settings = readPayoutSettings((await query(`SELECT settings FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]))[0]?.settings);
  const mps = (await query(`SELECT DISTINCT mp_code FROM auth.shops WHERE cabinet_id = $1 AND is_active`, [cabinetId])).map((r) => r.mp_code);
  const taken = new Set((await tenantQuery(
    `SELECT source_ref FROM tenant.dds_movements WHERE source_kind = 'mp_payout' AND status <> 'archived'`)).map((r) => r.source_ref));
  const forecasts = [];
  if (mps.includes("wb")) {
    const wins = wbPayoutWindows(gFrom, gTo, settings.wb).filter((w) => !taken.has(w.ref));
    if (wins.length) {
      const weeks = await wbCashPayoutByWeek(new DatabaseSync("wb"), { from: wins[0].winFrom, to: wins[wins.length - 1].winTo });
      for (const w of wins) {
        const wk = weeks.find((x) => x.week === w.winFrom);
        if (!wk) continue;
        forecasts.push({ ref: w.ref, platform: "wb", date: w.payDate, amount: wk.amount, winFrom: w.winFrom, winTo: w.winTo, accruing: w.winTo >= today });
      }
    }
  }
  if (mps.includes("ozon")) {
    const wins = ozPayoutWindows(gFrom, gTo, settings.ozon).filter((w) => !taken.has(w.ref));
    if (wins.length) {
      const days = await ozPayoutByDay(new DatabaseSync("ozon"), { from: wins[0].winFrom, to: wins[wins.length - 1].winTo });
      for (const w of wins) {
        const inWin = days.filter((d) => d.date >= w.winFrom && d.date <= w.winTo);
        if (!inWin.length) continue;
        const amount = Math.round(inWin.reduce((s, d) => s + d.amount, 0) * 100) / 100;
        forecasts.push({ ref: w.ref, platform: "ozon", date: w.payDate, amount, winFrom: w.winFrom, winTo: w.winTo, accruing: w.winTo >= today });
      }
    }
  }
  return { rows, forecasts };
}

const num = (v) => Math.round(Number(v) * 100) / 100;
function validMovement(b) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ""))) return "дата обязательна (YYYY-MM-DD)";
  if (!["income", "expense"].includes(b.type)) return "type: income|expense";
  if (!(Number(b.amount) > 0)) return "сумма должна быть больше 0";
  return null;
}

export async function createMovement(b) {
  const err = validMovement(b); if (err) throw Object.assign(new Error(err), { status: 400 });
  const r = await tenantQuery(
    `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, category, counterparty,
       description, status, source, source_kind, paid_at)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $3, $4, $5, $6, $7, 'manual', 'manual',
             CASE WHEN $7 = 'paid' THEN now() END) RETURNING id`,
    [b.date, b.type, num(b.amount), b.category || null, b.counterparty || null, b.description || null, b.paid ? "paid" : "planned"]);
  return r[0].id;
}

// Правка строки. Из «Закупок» сумма/статья/контрагент правятся только в партии: здесь — дата
// (→ date_locked) и комментарий. Повторяющаяся строка при правке отвязывается от шаблона
// («изменить только этот»): source_kind → manual, source_ref сохраняется, чтобы ensureRecurring
// не вставил её заново.
export async function updateMovement(id, b) {
  const cur = (await tenantQuery(`SELECT * FROM tenant.dds_movements WHERE id = $1 AND status <> 'archived' FOR UPDATE`, [id]))[0];
  if (!cur) throw Object.assign(new Error(`платёж id=${id} не найден`), { status: 404 });
  if (b.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) throw Object.assign(new Error("дата YYYY-MM-DD"), { status: 400 });
  if (cur.source_kind === "purchase" || cur.source_kind === "mp_payout") {
    await tenantQuery(
      `UPDATE tenant.dds_movements SET date = COALESCE($1, date), date_locked = date_locked OR ($1 IS NOT NULL AND $1 <> date),
          description = COALESCE($2, description), updated_at = now() WHERE id = $3`,
      [b.date ?? null, b.description ?? null, id]);
    return;
  }
  if (b.amount !== undefined && !(Number(b.amount) > 0)) throw Object.assign(new Error("сумма должна быть больше 0"), { status: 400 });
  await tenantQuery(
    `UPDATE tenant.dds_movements SET date = COALESCE($1, date), amount = COALESCE($2, amount),
        amount_planned = CASE WHEN status = 'planned' THEN COALESCE($2, amount_planned) ELSE amount_planned END,
        category = COALESCE($3, category), counterparty = COALESCE($4, counterparty), description = COALESCE($5, description),
        source_kind = CASE WHEN source_kind = 'recurring' THEN 'manual' ELSE source_kind END, updated_at = now()
      WHERE id = $6`,
    [b.date ?? null, b.amount !== undefined ? num(b.amount) : null, b.category ?? null, b.counterparty ?? null, b.description ?? null, id]);
}

export async function markPaid(id, amount) {
  const r = await tenantQuery(
    `UPDATE tenant.dds_movements SET status = 'paid', paid_at = now(),
        amount = COALESCE($1, amount), updated_at = now()
      WHERE id = $2 AND status = 'planned' RETURNING id`, [amount != null ? num(amount) : null, id]);
  if (!r.length) throw Object.assign(new Error(`платёж id=${id} не найден или уже оплачен`), { status: 400 });
}

export async function unmarkPaid(id) {
  const cur = (await tenantQuery(`SELECT source_kind FROM tenant.dds_movements WHERE id = $1 AND status = 'paid' FOR UPDATE`, [id]))[0];
  if (!cur) throw Object.assign(new Error(`платёж id=${id} не оплачен`), { status: 400 });
  if (cur.source_kind === "mp_payout") {
    // снятие «получено» у выплаты МП — строка в архив, снова виден прогноз
    await tenantQuery(`UPDATE tenant.dds_movements SET status = 'archived', updated_at = now() WHERE id = $1`, [id]);
    return;
  }
  await tenantQuery(
    `UPDATE tenant.dds_movements SET status = 'planned', paid_at = NULL, amount = COALESCE(amount_planned, amount), updated_at = now()
      WHERE id = $1`, [id]);
}

export async function archiveMovement(id) {
  const cur = (await tenantQuery(`SELECT source_kind FROM tenant.dds_movements WHERE id = $1`, [id]))[0];
  if (!cur) throw Object.assign(new Error(`платёж id=${id} не найден`), { status: 404 });
  if (cur.source_kind === "purchase") throw Object.assign(new Error("платёж из закупки удаляется вместе с партией"), { status: 400 });
  await tenantQuery(`UPDATE tenant.dds_movements SET status = 'archived', updated_at = now() WHERE id = $1`, [id]);
}

export async function receivePayout({ ref, platform, date, amount, amount_planned }) {
  if (!/^(wb|ozon):/.test(String(ref || ""))) throw Object.assign(new Error("ref выплаты"), { status: 400 });
  if (!(Number(amount) >= 0)) throw Object.assign(new Error("сумма"), { status: 400 });
  const r = await tenantQuery(
    `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, category, counterparty,
       description, status, source, source_kind, source_ref, paid_at, platform)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, 'income', $2, $3, 'Выплата МП', $4, $5, 'paid', 'mp_payout', 'mp_payout', $6, now(), $7)
     ON CONFLICT DO NOTHING RETURNING id`,
    [date, num(amount), amount_planned != null ? num(amount_planned) : null, platform === "wb" ? "Wildberries" : "Ozon",
     `Выплата ${platform === "wb" ? "WB" : "Ozon"}`, ref, platform]);
  if (!r.length) throw Object.assign(new Error("выплата уже отмечена"), { status: 400 });
  return r[0].id;
}

export async function saveRecurring(b) {
  const rule = b.rule;
  if (!["monthly", "weekly", "every_n_days"].includes(rule)) throw Object.assign(new Error("rule"), { status: 400 });
  if (!["income", "expense"].includes(b.type) || !(Number(b.amount) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date_from || "")))
    throw Object.assign(new Error("type/amount/date_from"), { status: 400 });
  const vals = [b.type, num(b.amount), b.category || null, b.counterparty || null, b.description || null, rule,
    b.rule_day != null ? Number(b.rule_day) : null, b.every_n != null ? Number(b.every_n) : null, b.date_from, b.date_to || null];
  let id = b.id ? Number(b.id) : null;
  if (id) {
    await tenantQuery(
      `UPDATE tenant.dds_recurring SET type=$1, amount=$2, category=$3, counterparty=$4, description=$5, rule=$6,
          rule_day=$7, every_n=$8, date_from=$9, date_to=$10, updated_at=now() WHERE id=$11`, [...vals, id]);
    // будущие неоплаченные, не сдвинутые руками — пересоздаются по новому правилу
    await tenantQuery(
      `UPDATE tenant.dds_movements SET status='archived', updated_at=now()
        WHERE source_kind='recurring' AND source_ref LIKE $1 AND status='planned' AND NOT date_locked AND date >= to_char(current_date,'YYYY-MM-DD')`,
      [`recurring:${id}:%`]);
  } else {
    id = (await tenantQuery(
      `INSERT INTO tenant.dds_recurring (cabinet_id, type, amount, category, counterparty, description, rule, rule_day, every_n, date_from, date_to)
       VALUES (current_setting('app.cabinet_id')::bigint, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, vals))[0].id;
  }
  return id;
}

export async function deleteRecurring(id) {
  await tenantQuery(`UPDATE tenant.dds_recurring SET is_active = false, updated_at = now() WHERE id = $1`, [id]);
  await tenantQuery(
    `UPDATE tenant.dds_movements SET status='archived', updated_at=now()
      WHERE source_kind='recurring' AND source_ref LIKE $1 AND status='planned' AND date >= to_char(current_date,'YYYY-MM-DD')`,
    [`recurring:${id}:%`]);
}
```

Примечание к `saveRecurring`: после архивации частичный уникальный индекс (`status <> 'archived'`) освобождает `source_ref`, поэтому `ensureRecurring` вставит строки заново по новому правилу.

- [ ] **Step 2: Подключить синхронизацию в `purchases/route.js`**

Импорт: `import { syncPurchasePayments, archivePurchasePayments } from "@/lib/paymentCalendarData.js";`

- UPDATE-ветка: после `await tenantQuery(\`UPDATE tenant.purchases SET ...\`)` добавить `await syncPurchasePayments(Number(b.id));`
- INSERT-ветка: после `INSERT … RETURNING id` добавить `await syncPurchasePayments(Number(rows[0].id));`
- DELETE: после `UPDATE tenant.purchases SET deleted_at = now()` добавить `await archivePurchasePayments(Number(id));`
- Никаких `try/catch` вокруг: исключение роняет запрос в 500 и `withCabinet` откатывает транзакцию целиком (партия не сохраняется без платежей).

- [ ] **Step 3: Бэкфилл-скрипт** `scripts/backfill-purchase-payments.mjs`

```js
#!/usr/bin/env node
// scripts/backfill-purchase-payments.mjs — разовая раскладка платежей по существующим партиям
// (платёжный календарь, 15.10.2026). Идемпотентно (upsert по source_ref). Только кабинет #1, если
// владелец не разрешил иное. Запуск: node scripts/backfill-purchase-payments.mjs 1
import { readFileSync } from 'node:fs';
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { withTenant, tenantQuery } = await import('../lib/db.js');
const { syncPurchasePayments } = await import('../lib/paymentCalendarData.js');
const CAB = Number(process.argv[2]);
if (CAB !== 1) { console.error('только кабинет #1'); process.exit(2); }
const res = await withTenant(CAB, async () => {
  const ids = (await tenantQuery(`SELECT id FROM tenant.purchases WHERE deleted_at IS NULL ORDER BY id`)).map((r) => Number(r.id));
  let up = 0;
  for (const id of ids) up += (await syncPurchasePayments(id)).upserted;
  return { purchases: ids.length, upserted: up };
});
console.log(res);
process.exit(0);
```

Run: `node scripts/backfill-purchase-payments.mjs 1` — дважды. Expected: первый раз `upserted > 0`; второй — те же числа `upserted` (UPDATE planned), и
`psql -h localhost -U saas_ro -d saas -Atc "select count(*) from tenant.dds_movements where cabinet_id=1 and source_kind='purchase' and status<>'archived'"` — одинаковое после обоих прогонов.
Проверка Σ: `psql … -Atc "select source_ref ~ '^purchase:' , count(*) from tenant.dds_movements where cabinet_id=1 and source_kind='purchase' and status='planned' group by 1"` и сверка выборочно 2 партий: Σ amount по `purchase:<id>:%` = `calc_Z` из `GET /api/cabinets/1/purchases` (через смоук Task 8).

- [ ] **Step 4: Тесты ядра и сборка** — `node --test lib/__tests__/paymentCalendar.test.mjs lib/__tests__/purchaseCalc.test.mjs` → PASS; `node -e "import('/opt/agents/saas/lib/paymentCalendarData.js')"` без ошибок импорта.

- [ ] **Step 5: Commit**

```bash
git add lib/paymentCalendarData.js scripts/backfill-purchase-payments.mjs "app/api/cabinets/[id]/purchases/route.js"
git commit -m "feat(payment-calendar): слой данных; платежи партий синхронизируются при сохранении закупки"
```

---

### Task 6: API `payment-calendar` + настройки дней выплат

**Files:**
- Create: `app/api/cabinets/[id]/payment-calendar/route.js`
- Modify: `app/api/cabinets/[id]/settings/route.js`, `app/cabinets/[id]/settings/SettingsPage.jsx`, `lib/__tests__/roleGuards.test.mjs` (если он перечисляет роуты — добавить новый)

**Interfaces:**
- Consumes: Task 5 (все экспорты), Task 3 (`monthGrid`, `summarize`, `weekSummary`, `categoryOf`, `CATEGORIES`, `readPayoutSettings`).
- Produces: `GET /api/cabinets/[id]/payment-calendar?month=YYYY-MM&kind=expense|income` →
  `{ month, kind, today, categories: CATEGORIES, weeks: [{ days: [{date, inMonth, items: Item[], total}], total, left }], totals: {planned, paid, left, overdue}, recurring: Template[] }`,
  где `Item = {id|null, ref|null, date, amount, status: 'planned'|'paid'|'forecast', category, cat, counterparty, description, source_kind, date_locked, platform?, accruing?, winFrom?, winTo?}`.
  `POST {action}`: `create {date,type,amount,category,counterparty,description,paid}`, `update {id,...}`, `mark_paid {id, amount?}`, `unmark {id}`, `delete {id}`, `receive_payout {ref, platform, date, amount, amount_planned}`, `recurring_save {...template}`, `recurring_delete {id}` → `{ok:true, id?}`.
  Settings GET добавляет `payouts: {wb:{weekday}, ozon:{day1,day2}}`; PUT принимает `payouts`.

- [ ] **Step 1: Роут**

```js
// /api/cabinets/[id]/payment-calendar — платёжный календарь (kind=expense) и план поступлений
// (kind=income), 15.10.2026. Данные — tenant.dds_movements (+ прогноз выплат МП на лету).
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery } from "@/lib/db.js";
import { monthGrid, summarize, weekSummary, categoryOf, CATEGORIES } from "@/lib/paymentCalendar.js";
import {
  loadMonth, createMovement, updateMovement, markPaid, unmarkPaid, archiveMovement,
  receivePayout, saveRecurring, deleteRecurring,
} from "@/lib/paymentCalendarData.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const mskToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const today = mskToday();
  const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : today.slice(0, 7);
  const kind = url.searchParams.get("kind") === "income" ? "income" : "expense";
  const { rows, forecasts } = await loadMonth({ cabinetId: cabinet.cabinet_id, month, kind, today });

  const items = [
    ...rows.map((r) => ({ id: Number(r.id), ref: r.source_ref, date: r.date, amount: Number(r.amount), status: r.status,
      category: r.category, cat: categoryOf(r.category), counterparty: r.counterparty, description: r.description,
      source_kind: r.source_kind, date_locked: r.date_locked, amount_planned: r.amount_planned })),
    ...forecasts.map((f) => ({ id: null, ref: f.ref, date: f.date, amount: f.amount, status: "forecast",
      category: "Выплата МП", cat: "mp", counterparty: f.platform === "wb" ? "Wildberries" : "Ozon",
      description: `Выплата ${f.platform === "wb" ? "WB" : "Ozon"} за ${f.winFrom.slice(8)}.${f.winFrom.slice(5, 7)}–${f.winTo.slice(8)}.${f.winTo.slice(5, 7)}`,
      source_kind: "mp_payout", platform: f.platform, accruing: f.accruing, winFrom: f.winFrom, winTo: f.winTo })),
  ];
  const byDate = new Map();
  for (const it of items) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  const weeks = monthGrid(month).map((w) => {
    const days = w.map((d) => {
      const its = byDate.get(d.date) || [];
      return { ...d, items: its, total: Math.round(its.reduce((s, x) => s + x.amount, 0) * 100) / 100 };
    });
    const all = days.flatMap((d) => d.items).map((x) => ({ ...x, status: x.status === "forecast" ? "planned" : x.status }));
    return { days, ...weekSummary(all) };
  });
  const inMonth = items.filter((x) => x.date.slice(0, 7) === month).map((x) => ({ ...x, status: x.status === "forecast" ? "planned" : x.status }));
  const recurring = await tenantQuery(
    `SELECT id, type, amount::float8 AS amount, category, counterparty, description, rule, rule_day, every_n,
            date_from::text AS date_from, date_to::text AS date_to
       FROM tenant.dds_recurring WHERE is_active AND type = $1 ORDER BY id`, [kind]);
  return NextResponse.json({ month, kind, today, categories: CATEGORIES, weeks, totals: summarize(inMonth, { today }), recurring });
});

export const POST = withCabinet(async (req) => {
  const b = await req.json();
  try {
    switch (b.action) {
      case "create": return NextResponse.json({ ok: true, id: await createMovement(b) });
      case "update": await updateMovement(Number(b.id), b); break;
      case "mark_paid": await markPaid(Number(b.id), b.amount); break;
      case "unmark": await unmarkPaid(Number(b.id)); break;
      case "delete": await archiveMovement(Number(b.id)); break;
      case "receive_payout": return NextResponse.json({ ok: true, id: await receivePayout(b) });
      case "recurring_save": return NextResponse.json({ ok: true, id: await saveRecurring(b) });
      case "recurring_delete": await deleteRecurring(Number(b.id)); break;
      default: return NextResponse.json({ error: `неизвестное действие: ${b.action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e.status) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e; // 500 → withCabinet откатывает транзакцию
  }
}, { requireRole: "manager" });
```

⚠️ Проверить, что `withCabinet` откатывает транзакцию при ответе 4xx, возвращённом ПОСЛЕ частичной записи. Ошибки валидации в Task 5 бросаются ДО первой записи в каждой функции — так и держать.

- [ ] **Step 2: Настройки выплат** — `settings/route.js`:
  - импорт `import { readPayoutSettings } from "@/lib/paymentCalendar.js";`
  - GET: в ответ добавить `payouts: readPayoutSettings(rows[0]?.settings),`
  - PUT: перед `if (!sets.length)` добавить

```js
  // Дни выплат маркетплейсов для «Плана поступлений» (lib/paymentCalendar.js readPayoutSettings).
  if (b.payouts !== undefined) {
    const wd = Number(b.payouts?.wb?.weekday), d1 = Number(b.payouts?.ozon?.day1), d2 = Number(b.payouts?.ozon?.day2);
    if (!Number.isInteger(wd) || wd < 1 || wd > 7) return NextResponse.json({ error: "день выплаты WB: 1..7" }, { status: 400 });
    for (const v of [d1, d2]) if (!Number.isInteger(v) || v < 1 || v > 28) return NextResponse.json({ error: "числа выплат Ozon: 1..28" }, { status: 400 });
    sets.push(`settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('payouts', $${++i}::jsonb)`);
    vals.push(JSON.stringify({ wb: { weekday: wd }, ozon: { day1: d1, day2: d2 } }));
  }
```

  ⚠️ Если в одном PUT придут и пороги поставок, и `payouts` — два `settings = …` в одном UPDATE дадут ошибку «multiple assignments». Решение: собирать JSON-патч `settingsPatch` и делать ОДНО `settings = COALESCE(settings,'{}'::jsonb) || $N::jsonb` — переделать оба места на общий патч (пороги поставок кладут `supply_target_days`/`supply_min_days` в тот же объект).
  - `SettingsPage.jsx`: рядом с полями порогов поставок — блок «Дни выплат маркетплейсов»: select «WB: день недели» (Пн..Вс → 1..7), два number «Ozon: за 1–15 — число», «за 16–конец — число следующего месяца» (1..28); сохранение тем же PUT (`payouts: {wb:{weekday}, ozon:{day1, day2}}`), текст-подсказка «используются в Плане поступлений».

- [ ] **Step 3: Гард ролей** — открыть `lib/__tests__/roleGuards.test.mjs`; если он перечисляет роуты с записью и ожидаемую роль — добавить `payment-calendar` (POST → manager). Run: `node --test lib/__tests__/roleGuards.test.mjs` → PASS.

- [ ] **Step 4: Сборка и живая проверка**

```bash
cp app/api/cabinets/[id]/settings/route.js /opt/agentsDB/backups/settings.route.js.$(date +%Y%m%d_%H%M%S).bak   # до правки
npm run build && systemctl restart saas-web
```
Проверка — в Task 8 смоуком (cookie-сессия). Здесь достаточно: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/api/cabinets/1/payment-calendar` → `401` (без сессии), сборка без ошибок.

- [ ] **Step 5: Commit**

```bash
git add "app/api/cabinets/[id]/payment-calendar/route.js" "app/api/cabinets/[id]/settings/route.js" "app/cabinets/[id]/settings/SettingsPage.jsx" lib/__tests__/roleGuards.test.mjs
git commit -m "feat(payment-calendar): API месяца и действий; дни выплат МП в настройках"
```

---

### Task 7: UI — календарь, план поступлений, вкладки, меню

**Files:**
- Create: `app/cabinets/[id]/fin-calendar/MoneyCalendar.jsx`, `app/cabinets/[id]/fin-calendar/PaymentModal.jsx`, `app/cabinets/[id]/fin-calendar/FinanceMoneyTabs.jsx`, `app/cabinets/[id]/fin-income/page.js`, `app/cabinets/[id]/fin-income/IncomePage.jsx`
- Modify (переписать): `app/cabinets/[id]/fin-calendar/CalendarPage.jsx`
- Modify: `app/cabinets/[id]/layout.js` (меню «Финансы»), `app/cabinets/[id]/fin-dds/DdsPage.jsx` (вкладки сверху)
- Delete: `app/api/cabinets/[id]/payment-plan/route.js`, `lib/calendarCalc.js` (бэкап в `/opt/agentsDB/backups/` перед удалением; `grep -rn "calendarCalc\|payment-plan" app lib scripts` → пусто)

**Interfaces:**
- Consumes: Task 6 API.
- Produces: `<MoneyCalendar cabinetId kind="expense"|"income" />`; `<FinanceMoneyTabs cabinetId active="dds"|"income"|"calendar" />`.

Правила (грабли D1–D7 из AGENTS.md): компоненты принимают `{ cabinetId }`; `fetch` только в backticks `` `/api/cabinets/${cabinetId}/payment-calendar?...` ``; все хуки — до любого раннего `return`; цвета только из `C`/`soft()` (`lib/palette.js`), никаких `${C.x}33`.

- [ ] **Step 1: `FinanceMoneyTabs.jsx`**

```jsx
"use client";
import Link from "next/link";
import { C } from "@/lib/palette.js";

const TABS = [
  { key: "dds", href: "/fin-dds", label: "ДДС" },
  { key: "income", href: "/fin-income", label: "План поступлений" },
  { key: "calendar", href: "/fin-calendar", label: "Платёжный календарь" },
];

export default function FinanceMoneyTabs({ cabinetId, active }) {
  return (
    <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.line}`, marginBottom: 16 }}>
      {TABS.map((t) => (
        <Link key={t.key} href={`/cabinets/${cabinetId}${t.href}`}
          style={{ padding: "8px 14px", fontSize: 14, fontWeight: 600, textDecoration: "none",
            color: active === t.key ? C.ink : C.muted, background: active === t.key ? C.surface : "transparent",
            border: `1px solid ${active === t.key ? C.line : "transparent"}`, borderBottom: "none", borderRadius: "8px 8px 0 0",
            marginBottom: -1 }}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: `MoneyCalendar.jsx`** — поведение (спека §3.2–3.3):
  - Состояние: `month` (дефолт — текущий из ответа `today`), `data`, `error`, `modal` (`null | {mode:'new'|'edit', item?, date?}`), `dayList` (`null | {date, items}`). `month` синхронизировать с `?month=` в URL (`useSearchParams` + `router.replace`).
  - Шапка: заголовок (`kind==='income'` ? «План поступлений» : «Платёжный календарь»), кнопки `←` `→` (сдвиг месяца), «Сегодня», справа «+ Платёж»/«+ Поступление» (скрыть у viewer: роль не приходит в API — показывать всем, сервер вернёт 403; сообщение об ошибке показывать в `error`).
  - Плитки итогов месяца: «Запланировано», «Оплачено»/«Получено», «Осталось», «Просрочено» (красным, если > 0) — `data.totals`.
  - Таблица-сетка: 8 колонок (`ПН..ВС` + `ИТОГО`), строки — `data.weeks`. Ячейка дня: число (сегодня — кружок `C.accent` с текстом `var(--accentInk)`), дни не своего месяца — `opacity: 0.45`; первые 3 `items`, затем «ещё N» (кнопка → `dayList`); внизу справа `fmtK(day.total)` (`1,2 млн` / `82 тыс` / `950`), если > 0. Клик по пустому месту ячейки — `modal {mode:'new', date}`.
  - Плашка платежа: фон `soft(cat.token, 14)`, левая полоска 3px `C[cat.token]`, текст «`category · counterparty`» с `text-overflow: ellipsis`, справа `fmtK(amount)`. Слева кружок-кнопка: `planned` → пустой кружок, клик → `mark_paid` (для `kind==='income'` — сначала `prompt`-поле фактической суммы в маленьком поповере, по умолчанию = сумма); `paid` → зелёная галочка `C.pos`, текст `line-through` + `C.muted`, клик → `unmark`; `forecast` → кружок пунктиром, подпись «копится» если `accruing`, клик → `receive_payout {ref, platform, date, amount(введённая), amount_planned: amount}`. Просрочено (`status==='planned' && date < today`) — рамка `1px solid C.neg`. Клик по тексту плашки — `modal {mode:'edit', item}` (для `forecast` — не открывать).
  - Колонка «ИТОГО»: `money(week.total)` жирным, под ним `week.left === 0 ? "всё оплачено" : \`осталось ${fmtK(week.left)}\`` (у `income` — «всё получено»).
  - После любого POST — перезагрузить месяц.
  - Адаптив: при ширине < 900px сетку заменить списком дней с платежами (те же плашки), чтобы не было горизонтальной прокрутки.

  Хелперы форматирования (в файле):

```js
const money = (v) => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0) + " ₽";
const fmtK = (v) => {
  const a = Math.abs(v || 0);
  if (a >= 1e6) return (v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " млн";
  if (a >= 1e3) return Math.round(v / 1e3).toLocaleString("ru-RU") + " тыс";
  return Math.round(v).toLocaleString("ru-RU");
};
```

- [ ] **Step 3: `PaymentModal.jsx`** — props `{ cabinetId, kind, categories, initial, onClose, onSaved }`:
  - Поля: дата, сумма, статья (select из `categories` — label; для income по умолчанию «Прочее»), контрагент, комментарий, чекбокс «Уже оплачено» (только `new`).
  - «Повторять»: select `нет | ежемесячно | еженедельно | каждые N дней` + число месяца / день недели / N, «до даты» (необязательно). Если выбран повтор при `new` → `POST recurring_save {type: kind==='income'?'income':'expense', amount, category, counterparty, description, rule, rule_day, every_n, date_from: date, date_to}`; иначе → `POST create`.
  - `edit` и `item.source_kind==='purchase'`: сумма/статья/контрагент — read-only, подпись «Сумма правится в Закупках» + ссылка `/cabinets/${cabinetId}/fin-purchases`; можно менять дату и комментарий → `POST update`.
  - `edit` и `item.ref?.startsWith('recurring:')` (`source_kind==='recurring'`): две кнопки — «Сохранить только этот» (`update`) и «Изменить шаблон» (найти шаблон `id = Number(ref.split(':')[1])` в `data.recurring`, открыть его поля и `recurring_save {id,…}`), плюс «Удалить шаблон» (`recurring_delete`).
  - Кнопка «Удалить» (кроме purchase) → `POST delete` с `confirm`.
  - Ошибку сервера (`data.error`) показывать в модалке, не закрывая её.

- [ ] **Step 4: Страницы**
  - `fin-calendar/CalendarPage.jsx` (переписать целиком):

```jsx
"use client";
import FinanceMoneyTabs from "./FinanceMoneyTabs.jsx";
import MoneyCalendar from "./MoneyCalendar.jsx";

// Платёжный календарь (15.10.2026): расходы по дням поверх tenant.dds_movements.
// Спека docs/superpowers/specs/2026-10-15-payment-calendar-design.md.
export default function CalendarPage({ cabinetId }) {
  return (
    <div style={{ padding: "20px 28px" }}>
      <FinanceMoneyTabs cabinetId={cabinetId} active="calendar" />
      <MoneyCalendar cabinetId={cabinetId} kind="expense" />
    </div>
  );
}
```

  - `fin-income/page.js`:

```js
import IncomePage from './IncomePage';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  return <IncomePage cabinetId={Number(params.id)} />;
}
```

  - `fin-income/IncomePage.jsx` — как `CalendarPage`, `active="income"`, `kind="income"`, импорт из `../fin-calendar/…`.
  - `fin-dds/DdsPage.jsx`: импорт `FinanceMoneyTabs` из `../fin-calendar/FinanceMoneyTabs.jsx` и `<FinanceMoneyTabs cabinetId={cabinetId} active="dds" />` первым элементом корневого `div`. Больше в ДДС ничего не менять.
  - `layout.js`, группа «Финансы»: `{ href: "/fin-calendar", label: "План платежей" }` → `{ href: "/fin-income", label: "План поступлений" }, { href: "/fin-calendar", label: "Платёжный календарь" }` (сразу после «ДДС»).

- [ ] **Step 5: Удалить старое**

```bash
mkdir -p /opt/agentsDB/backups/payment_plan_removed_$(date +%Y%m%d)
cp "app/api/cabinets/[id]/payment-plan/route.js" lib/calendarCalc.js app/cabinets/[id]/fin-calendar/CalendarPage.jsx /opt/agentsDB/backups/payment_plan_removed_$(date +%Y%m%d)/   # до переписывания CalendarPage!
git rm -q "app/api/cabinets/[id]/payment-plan/route.js" lib/calendarCalc.js
grep -rn "calendarCalc\|payment-plan" app lib scripts   # → пусто
```

- [ ] **Step 6: Скрининги и сборка**

```bash
grep -rn 'fetch("[^"]*\${' app/cabinets/   # D3 → пусто
grep -rn 'var(--[a-z]*)[0-9A-F]\{2\}' app/ lib/   # D13 → пусто
npm run build && systemctl restart saas-web
```
Expected: сборка без ошибок, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/cabinets/1/fin-calendar` → `307`/`200` (редирект на логин без сессии — норма).

- [ ] **Step 7: Визуальная проверка** — Playwright-скриншот (skill `example-skills:webapp-testing`) страниц `/cabinets/1/fin-calendar` и `/cabinets/1/fin-income` под cookie владельца #1 (cookie — как в `scripts/smoke-deliveries.mjs`), светлая и тёмная тема, ширина 1600 и 390. Скриншоты — в scratchpad. Проверить глазами: сетка Пн–Вс, плашки партий закупки на своих датах, колонка ИТОГО, выплаты WB по средам и Ozon 5/20.

- [ ] **Step 8: Commit**

```bash
git add "app/cabinets/[id]/fin-calendar/CalendarPage.jsx" "app/cabinets/[id]/fin-calendar/MoneyCalendar.jsx" "app/cabinets/[id]/fin-calendar/PaymentModal.jsx" "app/cabinets/[id]/fin-calendar/FinanceMoneyTabs.jsx" "app/cabinets/[id]/fin-income/page.js" "app/cabinets/[id]/fin-income/IncomePage.jsx" "app/cabinets/[id]/layout.js" "app/cabinets/[id]/fin-dds/DdsPage.jsx"
git commit -m "feat(payment-calendar): страницы «Платёжный календарь» и «План поступлений», вкладки ДДС; старый «План платежей» удалён"
```
(удаление `payment-plan`/`calendarCalc` уже в индексе через `git rm`.)

---

### Task 8: Смоук, гард, документация, деплой

**Files:**
- Create: `scripts/smoke-payment-calendar.mjs`, `lib/__tests__/paymentCalendarGuard.test.mjs`
- Modify: `AGENTS.md` (TL;DR-строка + пункт в «Где что считается»), `shared.changelog` (запись «Что нового» — через админа, как в прошлых частях)

- [ ] **Step 1: Гард**

```js
// lib/__tests__/paymentCalendarGuard.test.mjs — гарды платёжного календаря (15.10.2026).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("purchases/route.js: синхронизация платежей без глушения ошибок", () => {
  const src = read("app/api/cabinets/[id]/purchases/route.js");
  assert.match(src, /syncPurchasePayments\(/);
  assert.match(src, /archivePurchasePayments\(/);
  assert.doesNotMatch(src, /catch\s*(\(\w*\))?\s*\{\s*\}/);
});

test("payment-calendar/route.js: нет инлайн-формул выплат", () => {
  const src = read("app/api/cabinets/[id]/payment-calendar/route.js");
  assert.doesNotMatch(src, /ppvz_for_pay|accrued|finance_report|ozon_accruals/);
});

test("старый «План платежей» удалён", () => {
  assert.throws(() => read("lib/calendarCalc.js"));
});
```

Run: `node --test lib/__tests__/paymentCalendarGuard.test.mjs` → PASS.

- [ ] **Step 2: Смоук** `scripts/smoke-payment-calendar.mjs` — каркас (env, сессия, `get`, `post`, `check`) скопировать из `scripts/smoke-deliveries.mjs` строки 1–40, заменив путь POST на `payment-calendar`. Проверки:

```js
const month = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7);
for (const kind of ['expense', 'income']) {
  const r = await get(`payment-calendar?month=${month}&kind=${kind}`);
  check(`GET ${kind} 200`, r.status === 200, r.data);
  const items = r.data.weeks.flatMap((w) => w.days).flatMap((d) => d.items).filter((x) => x.date.slice(0, 7) === month && x.id);
  const [{ s }] = await tq(`SELECT COALESCE(SUM(amount),0)::float8 AS s FROM tenant.dds_movements
     WHERE status <> 'archived' AND type = $1 AND substr(date,1,7) = $2`, [kind, month]);
  const fromApi = Math.round(items.reduce((a, x) => a + x.amount, 0) * 100) / 100;
  check(`${kind}: Σ строк API = Σ dds_movements за месяц`, Math.abs(fromApi - s) < 0.01, { fromApi, s });
  check(`${kind}: недели по 7 дней, начинаются с понедельника`,
    r.data.weeks.every((w) => w.days.length === 7 && new Date(w.days[0].date + 'T00:00:00Z').getUTCDay() === 1));
}
// платежи партий: ≤4 на партию, Σ planned-строк неоплаченной партии = calc_Z
const pur = await get('purchases');
for (const p of pur.data.items.slice(0, 20)) {
  const rows = await tq(`SELECT amount::float8 AS a, status FROM tenant.dds_movements
     WHERE source_kind='purchase' AND source_ref LIKE $1 AND status <> 'archived'`, [`purchase:${p.id}:%`]);
  check(`партия ${p.id}: ≤4 платежей`, rows.length <= 4, rows.length);
  if (rows.length && rows.every((x) => x.status === 'planned')) {
    const s = Math.round(rows.reduce((a, x) => a + x.a, 0) * 100) / 100;
    check(`партия ${p.id}: Σ платежей = Z`, Math.abs(s - p.calc_Z) < 0.05, { s, Z: p.calc_Z });
  }
}
// повторная раскладка не добавляет строк
const cnt = async () => (await tq(`SELECT count(*)::int AS n FROM tenant.dds_movements WHERE source_kind='recurring' AND status<>'archived'`))[0].n;
const n1 = await cnt(); await get(`payment-calendar?month=${month}&kind=expense`); const n2 = await cnt();
check('повторы идемпотентны', n1 === n2, { n1, n2 });
// (только #1, обратимо) create → mark_paid → unmark → delete
if (CAB === 1) {
  const c = await post({ action: 'create', type: 'expense', date: `${month}-28`, amount: 1.23, category: 'Прочее', description: 'smoke' });
  check('create', c.status === 200 && c.data.id, c.data);
  check('mark_paid', (await post({ action: 'mark_paid', id: c.data.id })).status === 200);
  check('unmark', (await post({ action: 'unmark', id: c.data.id })).status === 200);
  check('delete', (await post({ action: 'delete', id: c.data.id })).status === 200);
}
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
```

Run: `node scripts/smoke-payment-calendar.mjs 1` → `ALL PASS`.

- [ ] **Step 3: Полный прогон тестов** — `node --test lib/__tests__/` → все PASS (новые + старые).

- [ ] **Step 4: AGENTS.md**
  - В таблицу TL;DR: `| Платёжный календарь / план поступлений | lib/paymentCalendar.js, lib/paymentCalendarData.js, /fin-calendar, /fin-income, миграция 070 |`
  - В «Где что считается» — пункт «**Платёжный календарь и план поступлений (с 2026-10-15)**»: одна таблица `dds_movements` (planned→paid, `source_kind` manual/recurring/purchase/mp_payout), шаблоны `dds_recurring` (раскладка на 92 дня лениво при открытии), партия закупки → до 4 платежей (Σ = Z, остаток по курсу оплаты R×U — решение владельца 15.10; оплаченные и сдвинутые руками не перезаписываются), прогноз выплат WB (`wbCashPayoutByWeek`, среда след. недели) и Ozon (`ozPayoutByDay`, 20-е/5-е) — контракт §20, дни — `auth.cabinets.settings.payouts`; старый «План платежей» (`payment-plan`, `calendarCalc.js`) удалён; тесты/гард/смоук; навигацию «разделы сверху» — отдельным проектом.

- [ ] **Step 5: «Что нового»** — запись в `shared.changelog` по образцу прошлых (посмотреть формат: `psql -h localhost -U saas_ro -d saas -c "\d shared.changelog"` и последнюю строку), вставка под админом: тип `feature`, заголовок «Платёжный календарь и план поступлений», текст 2–3 предложения для клиента.

- [ ] **Step 6: Финальная сборка и деплой** — `npm run build && systemctl restart saas-web`; повторить смоук; `systemctl is-active saas-web` → `active`.

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke-payment-calendar.mjs lib/__tests__/paymentCalendarGuard.test.mjs AGENTS.md
git commit -m "test(payment-calendar): смоук и гард; карта проекта"
```

Слияние в `master` — только после показа владельцу (superpowers:finishing-a-development-branch).
