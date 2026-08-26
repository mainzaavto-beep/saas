# Юнит-экономика: ширина, читаемость, персист — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Страница юнит-экономики во весь экран; строки факта/прикидки визуально различимы, редактируемое очевидно; прикидки автосохраняются в БД и переживают обновление.

**Architecture:** Миграция 046 `tenant.unit_whatif` (JSONB inputs на товар) + whatif-блок в ответе unit-API + POST-upsert; клиент — стилевое разделение строк (токены/острова), инпуты с рамкой, дебаунс-автосейв с индикатором, «⟲ к факту».

**Tech Stack:** SQL-миграция, Node/ESM (роуты), React (UnitPage).

**Спека:** `docs/superpowers/specs/2026-08-26-unit-page-usability-design.md` (9379528).

## Global Constraints

- Формулы `lib/unit` (`calcWB`/`calcOzon`) и механизм «↧ в факт» НЕ трогать (диффом доказуемо).
- Миграция — идемпотентная по конвенции 041-045; RLS tenant_iso как у соседних таблиц + политика `panel_local_ro_cab1` (правило владельца для новых tenant-таблиц — взять образец с существующей); применяет КОНТРОЛЁР (гейт в задаче 1, авторизация владельца получена 26.08).
- Только существующие токены C.*/soft; тексты по-русски.
- `git add` — ТОЛЬКО явным списком файлов задачи (в дереве возможны чужие правки).
- Сторожа после каждой задачи: `node scripts/check-profit-canon.mjs --cabinet 1`, `--cabinet 1008`, `node scripts/profit-snapshot.mjs --verify` — ALL PASS дословно (страница вне канона — не должны шевельнуться).
- Деплой только в задаче 2.

---

### Task 1: Миграция 046 + API персиста

**Files:**
- Create: `db/migrations/046_unit_whatif.sql`
- Modify: `app/api/cabinets/[id]/unit/all/route.js` (whatif в ответ), Create: `app/api/cabinets/[id]/unit/whatif/route.js` (POST upsert / очистка)

**Interfaces:**
- Produces: таблица `tenant.unit_whatif(cabinet_id, platform 'wb'|'ozon', item_id, inputs JSONB, updated_at; PK(cabinet_id, platform, item_id))`; ответ unit/all + `whatif: {wb: {nmId: inputs}, ozon: {productId: inputs}}`; `POST /unit/whatif {platform, itemId, inputs}` → upsert; `{platform, itemId, inputs: null}` → DELETE строки. Задача 2 использует.

- [ ] **Step 1: Миграция** — по конвенции (BEGIN/COMMIT, IF NOT EXISTS, «Идемпотентна», комментарий-назначение по-русски): CREATE TABLE как в спеке + `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + политика tenant_iso (образец из 040/043) + политика panel_local_ro_cab1 (образец: `SELECT ... FROM pg_policies WHERE policyname LIKE '%panel_local_ro%'` — повторить форму для новой таблицы) + GRANT'ы как у соседей (saas_app RW; saas_ro/panel_local_ro SELECT — сверить фактические роли по соседним миграциям).
- [ ] **Step 2: ГЕЙТ (контролёр)** — применение 046 к боевой БД; задача продолжается после подтверждения колонки/политик.
- [ ] **Step 3: API** — unit/all: `SELECT platform, item_id, inputs FROM unit_whatif` (через штатный db-шим роута, как остальные запросы этого роута) → whatif-блок; новый route.js whatif: POST-валидация (platform ∈ wb|ozon; itemId — число; inputs — объект разрешённых ключей WHATIF_INPUTS или null), upsert `INSERT ... ON CONFLICT ... DO UPDATE SET inputs, updated_at=now()`, при inputs:null — DELETE. Запись тем же механизмом, что «↧ в факт» POST (посмотреть unit/inputs/route.js).
- [ ] **Step 4:** `node --check`; ручная проверка API (node-вызовом или curl локально к db-функциям — как удобнее, числа в отчёт: upsert → чтение → delete); сторожа 3 команды.
- [ ] **Step 5: Commit** (явный список файлов): `feat(unit): персист прикидок — таблица unit_whatif и API (миграция 046)`

---

### Task 2: UI + деплой + приёмка

**Files:**
- Modify: `app/cabinets/[id]/unit/UnitPage.jsx`

- [ ] **Step 1: Ширина** — :175 `maxWidth: 1640` убрать.
- [ ] **Step 2: Различение строк** — строка прикидки: `borderLeft: 3px solid C.accent` (или inset boxShadow) + `background: soft("accent", 7)`; редактируемые инпуты — рамка `1px solid C.line`, фокус — `C.accent` (существующий инпут-паттерн панели); изменённый от факта вход — fontWeight 700 + маркер-точка C.accent; кнопка «⟲ к факту» в строке прикидки (сбрасывает входы к фактическим И удаляет запись из БД через POST inputs:null); легенда над таблицей (текст из спеки).
- [ ] **Step 3: Автосейв** — дебаунс 1000 мс после изменения входа → POST upsert; индикатор у легенды: «Сохранение…» → «Сохранено HH:MM» (или ✓), ошибка сети — «Не сохранилось — повторю» с ретраем; при загрузке страницы whatif-блок из unit/all накладывается на строки прикидки.
- [ ] **Step 4:** parse; сторожа → `npm run build && systemctl restart saas-web` → is-active + сторожа повторно.
- [ ] **Step 5: Приёмка** — SQL: после ввода прикидки строка в tenant.unit_whatif появилась с введёнными inputs; «⟲ к факту» удаляет; повторная загрузка страницы возвращает прикидку (проверка канон-вызовом API + SQL, числа в отчёт); calc*-файлы не в диффе.
- [ ] **Step 6: Commit** (явный список): `feat(unit): во весь экран, различимые строки прикидки, автосейв в БД`

---

### Task 3: Финализация

- [ ] Контракт: 3-4 строки в docs/metrics-contract.md (unit_whatif — пользовательские сценарии, НЕ данные площадок; в канон/сверки не входит; RLS+panel_local_ro_cab1). Commit: `docs(contract): unit_whatif — прикидки владельца вне канона`
- [ ] Финальное ревью ветки (whole-branch, fable; гейт контракт-задачи объединён) — по процессу SDD.

---

## Self-review (выполнено при написании)

- Покрытие спеки: §1→T2 Step 1; §2→T2 Steps 2; §3→T1+T2 Step 3; §4 (не в скоупе) → GC.
- Правило panel_local_ro_cab1 — из памяти владельца, в GC и T1 Step 1 явно.
- Урок git add — в GC.
- Плейсхолдеров нет; образцы политик берутся с существующих таблиц по месту.
