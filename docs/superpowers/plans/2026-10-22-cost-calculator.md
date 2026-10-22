# Калькулятор себестоимости (Китай → ФФ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Страница `/cost-calc` («Закупки» → «Калькулятор себестоимости»): ввод веса/цены ¥/карго $/кг/логистики/курсов/кол-ва → себестоимость 1 шт на лету + сохранённые расчёты.

**Architecture:** Чистая формула `lib/costCalc.js` (общая для страницы и API) → таблица `tenant.cost_calcs` (миграция 074, только ввод) → роут `/api/cabinets/[id]/cost-calc` (GET список + результат, POST save/delete) → клиентская страница.

**Tech Stack:** Next.js 14 App Router, PostgreSQL + RLS (`withCabinet`/`tenantQuery`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-22-cost-calculator-design.md`

## Global Constraints
- Вес — за 1 шт (кг); карго — $/кг; доставка по Китаю — ¥ за партию; логистика карго→ФФ — ₽ за партию.
- Храним только ввод; результат всегда `calcCost`. Ничего не пишем в закупки/`cost_overrides`.
- POST — `requireRole: "manager"`; GET — любая роль. `created_by` — из `session.user_id`, не из тела.
- Миграция идемпотентна; применять `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f …`.
- Ручные проверки — только кабинет #1. После правок — `npm run build && systemctl restart saas-web`; `next dev` в каталоге прода запрещён.
- Палитра — `C`/`soft` из `lib/palette.js`; `fetch` к `/api/cabinets/${cabinetId}/…` в бэктиках; хуки до ранних `return`.

---

### Task 1: Формула `lib/costCalc.js`

**Files:** Create `lib/costCalc.js`, `lib/__tests__/costCalc.test.mjs`

**Interfaces — Produces:**
- `CALC_FIELDS: string[]` — `["qty","weight_kg","price_cny","china_delivery_cny","cargo_usd_per_kg","ff_logistics_rub","rate_cny","rate_usd"]`
- `COST_LINES: {key,label}[]` — goods/china/cargo/ff
- `calcCost(input) → { weightTotal, totalRub, unitRub|null, lines: [{key,label,rub,perUnit|null,share|null}] }`
- `parseCalcInput(body) → { value: {name, note, ...CALC_FIELDS} } | { error: string }`

- [ ] Step 1: тест (пример: qty 100, вес 0,5, цена 30 ¥, Китай 200 ¥, карго 3,5 $/кг, ФФ 5000 ₽, ¥ 12, $ 90 → товар 36 000, Китай 2 400, карго 15 750, ФФ 5 000, итого 59 150, 591,5 ₽/шт, вес 50 кг; qty 0 → unitRub/perUnit null; всё пусто → share null; parseCalcInput: пустое имя, отрицательное, NaN, пустая строка → 0).
- [ ] Step 2: `node --test lib/__tests__/costCalc.test.mjs` → FAIL (нет модуля).
- [ ] Step 3: реализация (код ниже в репо — `lib/costCalc.js`).
- [ ] Step 4: тест → PASS. Step 5: commit.

### Task 2: Миграция 074 + API

**Files:** Create `db/migrations/074_cost_calcs.sql`, `app/api/cabinets/[id]/cost-calc/route.js`; Modify `lib/__tests__/roleGuards.test.mjs` (добавить `"cost-calc"` в `MANAGER_FIN`).

**Interfaces — Consumes:** `calcCost`, `parseCalcInput`, `CALC_FIELDS`. **Produces:**
- GET → `{ items: [{id,name,note,created_at,updated_at,...CALC_FIELDS, result}], defaults: {china_delivery_cny,cargo_usd_per_kg,ff_logistics_rub,rate_cny,rate_usd}|null, role }`
- POST `{action:"save", id?, ...}` → `{ok, id}`; `{action:"delete", id}` → `{ok}`; ошибки 400/404.

Таблица: `cabinet_id BIGINT, id BIGSERIAL, name TEXT, qty…rate_usd NUMERIC NOT NULL DEFAULT 0, note TEXT DEFAULT '', created_by BIGINT, created_at/updated_at TIMESTAMPTZ`, PK `(cabinet_id,id)`; RLS + `panel_local_ro_cab1` + гранты (+ `USAGE,SELECT` на `cost_calcs_id_seq`) по образцу 069.

- [ ] Step 1: добавить `"cost-calc"` в `MANAGER_FIN`; `node --test lib/__tests__/roleGuards.test.mjs` → FAIL «нет роута cost-calc».
- [ ] Step 2: миграция, применить под админом, проверить `\d tenant.cost_calcs` под `saas_ro`.
- [ ] Step 3: роут. Step 4: roleGuards → PASS. Step 5: commit.

### Task 3: Страница и меню

**Files:** Create `app/cabinets/[id]/cost-calc/page.js`, `app/cabinets/[id]/cost-calc/CostCalcPage.jsx`; Modify `lib/cabinetNav.js` (пункт `{ key: "cost-calc", label: "Калькулятор себестоимости", icon: "🧮", href: "/cost-calc" }` после «Закупок»).

- [ ] Step 1: `node --test lib/__tests__/cabinetNav.test.mjs` после создания `page.js` без пункта меню → FAIL (страница не учтена).
- [ ] Step 2: пункт меню → PASS.
- [ ] Step 3: `CostCalcPage.jsx`: форма (поля спеки), результат на лету `calcCost`, кнопки «Сохранить» / «Сохранить как новый» / «Новый расчёт», список с поиском, загрузка по клику, удаление с confirm; viewer — без кнопок записи; новый расчёт берёт курсы/ставки из `defaults`.
- [ ] Step 4: commit.

### Task 4: Сборка, проверка на #1, документация

- [ ] `node --test lib/__tests__/*.test.mjs` — всё зелёное.
- [ ] Бэкап `lib/cabinetNav.js`, `AGENTS.md` в `/opt/agentsDB/backups/`; `npm run build && systemctl restart saas-web`.
- [ ] Ручная проверка на кабинете #1 (через curl с сессией либо в браузере владельцем): страница 200, создать → появился в списке с 591,5 ₽/шт на примере, изменить, «как новый», удалить; тестовые записи удалить.
- [ ] Строка в TL;DR `AGENTS.md`; commit.
