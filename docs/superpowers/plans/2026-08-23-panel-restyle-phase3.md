# Рестайл панели, этап 3 «текст на акценте» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ноль инлайн-текстов на акцентном фоне мимо `--accentInk`; палитры-сироты на токенах; два устаревших комментария поправлены.

**Architecture:** Grep-управляемый механический свип с обязательной проверкой контекста каждого места (фон акцентный?); никаких новых значений — только уже существующие токены этапов 1-2.

**Tech Stack:** JSX/CSS. Данные/роуты не трогаются.

**Спека:** `docs/superpowers/specs/2026-08-23-panel-restyle-phase3-design.md`.

## Global Constraints

- Замена на `var(--accentInk)` допустима ТОЛЬКО при акцентном фоне элемента (`C.accent`/`var(--accent)`/`C.blue`). Исключения НЕ трогать: OpexPage (фон C.neg), InventoryPage (фон C.pink), TimingPage (heatmap), disabled-состояния. Каждое пропущенное место — в отчёт с причиной.
- Тексты/тултипы/логика — неприкосновенны; только цветовые значения.
- Деплой только в задаче 4. `npm run build` для проверки — можно.
- Сторожа после деплоя: check-profit-canon (1, 1008), profit-snapshot --verify → ALL PASS.
- Комментарии по-русски.

---

### Task 1: Семейство `color:"#fff"` на акценте (~27 мест)

**Files:** по grep `color:\s*["']#fff` в app/ (ревью этапа 2 называло: settings/page.js ×11, SettingsPage.jsx ×7, onboarding ×2, reset/forgot/invite/register/verify, TeamPage:115, BillingPage:95, cabinets/page.js:69, app/page.js:33,63 — лендинг-CTA).

- [ ] **Step 1:** Полный grep (включая `#ffffff`), для КАЖДОГО места — проверка фона по контексту: акцентный → `var(--accentInk)`; не акцентный → не трогать, в отчёт. Auth-страницы: если элемент — полноценная кнопка с фоном var(--accent) и на странице доступен класс `.btn` (globals.css глобален) — предпочесть `className="btn"` с удалением дублирующего инлайна (структуру/отступы сохранить).
- [ ] **Step 2:** `npm run build` чисто. Итоговый grep: `color:\s*["']#fff` рядом (±3 строки) с `accent` — ноль.
- [ ] **Step 3: Commit**: `feat(ui): текст на акценте — семейство #fff на accentInk (этап 3)`

### Task 2: Семейство `color:"#0A1A1C"` (~50 мест)

**Files:** по grep `#0A1A1C` (регистронезависимо) в app/ (ревью: fin-balance, purchases, self-buyouts, inventory, abc, geo, timing, plan, alerts, briefing, calendar, dds, shipments, move, rnp, summary, support, mp-stock, ff-stock…).

- [ ] **Step 1:** Тот же протокол: акцентный фон → `var(--accentInk)`; иначе не трогать + отчёт (ожидаемые не-акцентные: тексты на C.warn/C.pos-плашках — там #0A1A1C может быть осмысленным тёмным на цветном, решать по контрасту: если фон — token-цвет светлой природы (warn/pos светлые в light) — оставить с пометкой).
- [ ] **Step 2:** `npm run build` чисто; grep `#0A1A1C` → остаток только в задокументированных не-акцентных местах (список = отчёт).
- [ ] **Step 3: Commit**: `feat(ui): текст на акценте — семейство #0A1A1C на accentInk (этап 3)`

### Task 3: Палитры-сироты + комментарии

**Files:** `app/cabinets/[id]/fin-purchases/PurchasesPage.jsx` (LIFECYCLE_COLOR: rgba(33,150,243)/rgba(76,175,80)/#64b5f6/#ffd54f), `app/cabinets/[id]/detail/DetailPage.jsx` (декоративные серии #7DD3FC/#86EFAC/#A78BFA и соседние), `app/cabinets/[id]/LoadingBanner.jsx:46` + `app/cabinets/[id]/layout.js:350` (fallback `var(--neg, #ff6b6b)` → `var(--neg)`), `lib/opsAlerts.js:62` (комментарий «±30 мин»), `deploy/systemd/saas-worker.service` (комментарий «14 сборщиков» → «17 сборщиков» — только текст, БЕЗ cp/daemon-reload: значения Environment не меняются, живой юнит уже совпадает по поведению; репо-файл разъезжается только комментарием — cp сделает контролёр при следующем случае).

- [ ] **Step 1:** LIFECYCLE_COLOR → маппинг на токены (`var(--accent)`, `var(--pos)`, `var(--warn)`, `soft(...)` подложки); серии DetailPage → `SERIES[i]` или color-mix-производные от токенов (светлее/темнее через color-mix с transparent/ink) — сохранить РАЗЛИЧИМОСТЬ серий (не схлопнуть в один цвет), решение в отчёт.
- [ ] **Step 2:** Fallback-хвосты и оба комментария.
- [ ] **Step 3:** `npm run build` чисто; grep старых значений → ноль. Commit: `feat(ui): палитры-сироты на токены + комментарии-хвосты (этап 3)`

### Task 4: Деплой и приёмка

- [ ] **Step 1:** Контролёр предупреждает владельца → `npm run build && systemctl restart saas-web` → active (если рестарт заблокирован — контролёр сам).
- [ ] **Step 2:** Сторожа: check-profit-canon (1, 1008), profit-snapshot --verify → ALL PASS.
- [ ] **Step 3:** Приёмка владельцем: Обзор, P&L, Заказы, Закупки, Детальная — обе темы.

---

## Self-review (выполнено при написании)

Покрытие спеки: компонент 1 (T1+T2), 2+3 (T3), приёмка (T4). Исключения из ревью перенесены в Global Constraints дословно. Плейсхолдеров нет; списки файлов — ориентиры с обязательным полным grep-ом (числа мест из ревью могли дрейфовать).
