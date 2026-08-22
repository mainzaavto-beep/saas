# Рестайл панели, этап 1 «фундамент» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Панель перестаёт выглядеть самодельно: строгая палитра, табличные цифры, единые контролы — только внешний слой, ни одной цифры/формулы/роута.

**Architecture:** Замена ЗНАЧЕНИЙ CSS-токенов в `app/globals.css` (имена сохраняются — 30 страниц перекрашиваются сами через `lib/palette.js`), глобальная типографика, перевод захардкоженных цветов общих классов на токены.

**Tech Stack:** CSS (globals.css, cabinet.css). JS/JSX не трогаем.

**Спека:** `docs/superpowers/specs/2026-08-22-panel-restyle-phase1-design.md` (d6f2ee4). Макет одобрен владельцем (артефакт c6b60865).

## Global Constraints

- Деплой панели ТОЛЬКО `npm run build && systemctl restart saas-web` — и только в задаче 3, с предупреждением владельца ДО рестарта.
- НИ ОДНОГО изменения в .js/.jsx/роутах/данных. Только два CSS-файла.
- Имена токенов НЕ менять (inline-стили страниц читают их через `lib/palette.js`); `.light`-класс и `color-scheme` сохранить (next-themes вешает классы на `<html>`).
- Тёмная тема остаётся дефолтом (`:root, .dark`).
- После деплоя: `node scripts/check-profit-canon.mjs` (кабинеты 1, 1008) и `node scripts/profit-snapshot.mjs --verify` — ALL PASS (правки не про данные; расхождение = баг).
- Комментарии в CSS — по-русски.

---

### Task 1: Токены и типографика — app/globals.css

**Files:**
- Modify: `app/globals.css` (:8-61 токены и база; :79 `.err`; :131 тень дропдауна; :146 `.topnav-sublink.active`)

**Interfaces:**
- Produces: новые значения существующих токенов + новый токен `--shadow`; глобальный `font-variant-numeric: tabular-nums`.

- [ ] **Step 1: Блок токенов** — заменить значения в `:root, .dark` (:8-32) и `.light` (:34-56), имена и структуру (алиасы) сохранить:

```css
:root,
.dark {
  color-scheme: dark;
  --bg: #131417;        /* нейтральный графит вместо синего */
  --panel: #1B1C20;
  --panel2: #222327;
  --text: #ECECEA;
  --muted: #9A9CA3;
  --accent: #6B8DF2;    /* один сдержанный акцент */
  --accent2: #3FA796;   /* приглушён (был неоновый #2bd4a0) */
  --danger: #E5636A;
  --border: #2A2B30;
  --radius: 10px;
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 4px 16px rgba(0,0,0,.3);
  --surface: var(--panel);
  --surfaceAlt: var(--panel2);
  --ink: var(--text);
  --faint: #6E7076;
  --line: var(--border);
  --pos: #4CC38A;
  --neg: #E5636A;
  --warn: #D9A44A;
  --pink: #D07B62;      /* терракот вместо оранжевого неона */
  --blue: var(--accent);
}

.light {
  color-scheme: light;
  --bg: #FAFAF9;        /* тёплый камень вместо голубоватого */
  --panel: #FFFFFF;
  --panel2: #F4F4F2;
  --text: #1C1D21;
  --muted: #6E7076;
  --accent: #2E5CE6;
  --accent2: #0F766E;
  --danger: #C6373C;
  --border: #E7E6E3;
  --radius: 10px;
  --shadow: 0 1px 2px rgba(28,29,33,.05), 0 4px 16px rgba(28,29,33,.04);
  --surface: var(--panel);
  --surfaceAlt: var(--panel2);
  --ink: var(--text);
  --faint: #9A9CA0;
  --line: var(--border);
  --pos: #177E4D;
  --neg: #C6373C;
  --warn: #B7791F;
  --pink: #B45341;
  --blue: var(--accent);
}
```

- [ ] **Step 2: Типографика** — в правило `html, body` (:58-59) добавить `font-variant-numeric: tabular-nums;` и `-webkit-font-smoothing: antialiased;`; после него добавить `h1, h2, h3 { letter-spacing: -0.01em; }`.

- [ ] **Step 3: Захардкоженные цвета globals.css → токены** (иначе с новой палитрой разъедутся):
  - `.err` (:79): `background: color-mix(in srgb, var(--danger) 12%, transparent);`
  - `.topnav-dropdown` (:131): `box-shadow: var(--shadow);`
  - `.topnav-sublink.active` (:146): `background: color-mix(in srgb, var(--accent) 10%, transparent);`

- [ ] **Step 4: Проверка** — в файле не осталось hex/rgba-цветов вне блоков токенов: `grep -nE "#[0-9a-fA-F]{3,6}|rgba?\(" app/globals.css` — допустимы только строки внутри `:root/.dark/.light` и `#fff` на кнопках-акцентах (`.btn`, `.topnav-link.active`, `.avatar-btn` — белый на акценте валиден в обеих темах).

- [ ] **Step 5: Commit**: `git add app/globals.css && git commit -m "feat(ui): строгая палитра токенов, табличные цифры, тень-токен (рестайл этап 1)"`

---

### Task 2: Общие классы кабинета — app/cabinets/[id]/cabinet.css

**Files:**
- Modify: `app/cabinets/[id]/cabinet.css` (93 строки, классы .kpi-card/.section/.table/.mp-badge/.positive/.negative/.filters/.btn-small)

- [ ] **Step 1: Захардкоженные цвета → токены:**
  - `.table tr:hover td` (:42): `background: color-mix(in srgb, var(--accent) 5%, transparent);`
  - `.positive` (:55): `color: var(--pos);` `.negative` (:56): `color: var(--neg);`
  - `.mp-wb` (:51): `background: color-mix(in srgb, var(--blue) 15%, transparent); color: var(--blue);`
  - `.mp-ozon` (:52): `background: color-mix(in srgb, var(--pink) 15%, transparent); color: var(--pink);`

- [ ] **Step 2: «Дорогая» таблица** — `.table th` (:30-…): добавить `font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted);` (существующие padding/границы сохранить); числовым ячейкам ничего не делать (tabular-nums уже глобально; выравнивание — этап 2).

- [ ] **Step 3: Карточки** — `.kpi-card` и `.section`: `box-shadow: var(--shadow);` и `border-radius: var(--radius);` (если жёсткие px — заменить на токен).

- [ ] **Step 4: Проверка hex/rgba** как в задаче 1 Step 4 — вне токенов цветов не осталось.

- [ ] **Step 5: Commit**: `git add app/cabinets/[id]/cabinet.css && git commit -m "feat(ui): общие классы кабинета на токены — таблицы, карточки, бейджи"`

---

### Task 3: Деплой, сторожа, приёмка владельцем

- [ ] **Step 1: Предупредить владельца** (сообщением в сессии): «деплою рестайл, панель сменит вид в обеих темах; если не понравится — откат за минуту». Ответа не ждать (владелец одобрил порядок в спеке), но сообщение — ДО рестарта.
- [ ] **Step 2: Деплой**: `npm run build && systemctl restart saas-web`; `systemctl is-active saas-web` → active.
- [ ] **Step 3: Сторожа**: `node scripts/check-profit-canon.mjs` (оба кабинета), `node scripts/profit-snapshot.mjs --verify` → ALL PASS (данные не тронуты — verify сравнивает JSON роутов, CSS его не меняет).
- [ ] **Step 4: Приёмка**: попросить владельца открыть панель (обе темы: переключатель темы в топбаре) и сказать «ок»/«откати»/«поправь X». Инструкция отката в отчёте задачи: `git revert <коммиты задач 1-2> && npm run build && systemctl restart saas-web`.

---

## Self-review (выполнено при написании)

- Покрытие спеки: токены+типографика (T1), базовые контролы (T2), деплой/приёмка/откат (T3). «Не входит» соблюдено: ни одного .js/.jsx в Files.
- Значения палитры сверены с одобренным макетом 1:1 (light/dark, accent/pos/neg/warn, shadow).
- Ловушка проверена: `color-mix` уже используется в проде (`lib/palette.js` soft()) — поддержка браузеров подтверждена комментарием там же.
- Плейсхолдеров нет.
