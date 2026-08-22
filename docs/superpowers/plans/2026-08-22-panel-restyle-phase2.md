# Рестайл панели, этап 2 «доводка» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать «острова» старой палитры, закрыть контраст-долги одним правилом «текст на акценте», привести композицию трёх главных страниц к языку одобренного макета, перевести графики на токен-палитру.

**Architecture:** Новый токен `--accentInk` + правка значений `--warn/--pink` (светлая тема) → общий модуль плашек `lib/callout.js` → механическая чистка островов по таблицам замен → композиция Обзор/Сводка/P&L (только JSX/стили) → dataviz-`SERIES` из токенов.

**Tech Stack:** CSS + JSX (Next.js). Данные/роуты/formулы не трогаются.

**Спека:** `docs/superpowers/specs/2026-08-22-panel-restyle-phase2-design.md` (6c2d1da). Язык дизайна — одобренный макет этапа 1 (артефакт c6b60865).

## Global Constraints

- НИ ОДНОГО изменения в app/api/**, lib/ozonMetrics.js, lib/wbMetrics.js, worker/** — только страницы (JSX), globals.css/cabinet.css, lib/palette.js (+ новый lib/callout.js, − lib/theme.js).
- Тексты методологии/тултипов сохраняются ДОСЛОВНО (менять можно только цвета/композицию, не слова).
- Имена существующих токенов не менять; добавка только `--accentInk`; `.light/.dark`-механика неприкосновенна.
- Деплой панели только в задаче 7: `npm run build && systemctl restart saas-web`. До неё build можно гонять для проверки синтаксиса, но НЕ рестартовать сервис.
- Сторожа после деплоя: `node scripts/check-profit-canon.mjs` (кабинеты 1, 1008), `node scripts/profit-snapshot.mjs --verify` — ALL PASS (verify сверяет JSON роутов — это и есть страховка, что JSX-правки не задели данные).
- Спарклайны — ТОЛЬКО из полей, уже имеющихся в ответах роутов; полей нет (проверено 2026-08-22) → primary-плитки без спарклайна, поля в API НЕ добавлять.
- Комментарии по-русски. Расхождение цифр = наш баг.

---

### Task 1: Токены — accentInk и контраст-долги

**Files:**
- Modify: `app/globals.css` (блоки токенов; `.btn` :74-78, `.topnav-link.active` :118, `.avatar-btn` :157-163)
- Create: `/tmp/claude-0/…/scratchpad/wcag.mjs` (одноразовый контраст-калькулятор, в git НЕ коммитить)

**Interfaces:**
- Produces: токен `--accentInk` (цвет текста на акцентном фоне; тьма `#131417`, свет `#FFFFFF`); светлые `--warn`/`--pink` затемнены до AA.

- [ ] **Step 1: Контраст-калькулятор** в scratchpad (WCAG 2.x):

```js
// node wcag.mjs '#RRGGBB' '#RRGGBB' → контраст
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const [a, b] = process.argv.slice(2).map(lum);
console.log(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
```

- [ ] **Step 2: Токены.** В оба блока добавить `--accentInk` (тьма: `#131417`; свет: `#FFFFFF`). В `.light` заменить: `--warn: #9C6414;` (стартовое значение; проверить `node wcag.mjs '#9C6414' '#FFFFFF'` ≥ 4.5 — если нет, темнить шагами #8F5B12 → пока ≥4.5) и `--pink: #9C4433;` (проверить против белого ≥4.5; бейдж-подложка 15% чуть светлее чистого белого — запас нужен ~4.7 на белом). Тёмную тему не трогать (там warn/pink читаемы). Все финальные пары (accentInk на accent в обеих темах; warn/pink на белом) — измерить калькулятором, значения в отчёт.

- [ ] **Step 3: Применение accentInk** — в `globals.css` заменить `color: #fff` на `color: var(--accentInk)` в `.btn`, `.topnav-link.active`, `.avatar-btn` (три места, найденные grep-ом Step 4 этапа 1).

- [ ] **Step 4:** grep-проверка как в этапе 1 (hex вне токенов не осталось, `#fff` на акценте больше нет). Commit: `feat(ui): accentInk и контраст-долги (рестайл этап 2, задача 1)`

---

### Task 2: Общий модуль плашек + класс .err + гибридные подложки

**Files:**
- Create: `lib/callout.js`
- Modify: 8 страниц с `const ALERT` (summary/SummaryPage.jsx:10, detail/DetailPage.jsx:13, fin-manual/OpexPage.jsx:76, fin-plan/PlanPage.jsx:6, fin-self-buyouts/SelfBuyoutsPage.jsx:6, move/MovePage.jsx:9, rnp/RnpPage.jsx:15, alerts/AlertsPage.jsx:6)
- Modify: 7 инлайн-`.err`-дублей (app/reset/…:39, app/forgot/…:43, app/register/…:82, app/invite/…:68, app/onboarding/…:160, team:78, billing/BillingPage:70,81 — искать по `rgba(255,107,107`)
- Modify: `app/cabinets/[id]/layout.js:343-344`, `app/cabinets/[id]/LoadingBanner.jsx:44-45`, `app/settings/page.js:422`

**Interfaces:**
- Produces: `lib/callout.js` — `export const ALERT = { info: {...}, warn: {...}, critical: {...} }` (стили-объекты на `C`/`soft()` из lib/palette.js).

- [ ] **Step 1:** Прочитать ДВА существующих `const ALERT` (SummaryPage и AlertsPage — самый полный) и собрать объединённый `lib/callout.js`: те же ключи/поля, что реально используются страницами (перечислить в отчёте), значения — через `C.*`/`soft("accent"|"warn"|"neg", 12)`. Ничего не изобретать: это перенос, не редизайн.
- [ ] **Step 2:** В 8 страницах: `import { ALERT } from "@/lib/callout"` (форму импорта взять как у соседних импортов lib/palette в тех же файлах), локальный const удалить. Если у какой-то страницы поле-расширение, которого нет у других — добавить его в callout.js, не оставлять локально.
- [ ] **Step 3:** 7 инлайн-err → `className="err"` (класс уже токенизирован в globals.css; сохранить локальные отступы, если стиль нёс margin — перенести margin в style, цвета убрать).
- [ ] **Step 4:** Гибридные подложки: `rgba(255,107,107,.12)` → `soft("neg", 12)`, `rgba(255,193,7,.12)` → `soft("warn", 12)`, синяя подложка settings/page.js:422 → `soft("accent", 12)` (импорт soft по месту).
- [ ] **Step 5:** `npm run build` (только сборка, БЕЗ рестарта) → чисто. Commit: `feat(ui): единые плашки lib/callout, класс err, подложки на токены`

---

### Task 3: Остров ReviewsPage + Ozon-бейджи + мелочь

**Files:**
- Modify: `app/cabinets/[id]/reviews/ReviewsPage.jsx` (~41 вхождение, :35-166 и :98-99)
- Modify: Ozon-бейджи инлайн: `app/cabinets/[id]/settings/SettingsPage.jsx:170-171`, `app/settings/page.js:422-…`, `app/cabinets/[id]/items/ItemsPage.jsx:586`, `app/cabinets/[id]/inventory/InventoryPage.jsx:893,937`
- Modify: Suspense-заглушки `#8a99b8` (reset, verify, register, detail/page, reviews, billing — искать grep-ом), `app/cabinets/[id]/content/page.js:4-7`, `app/OpsAlertsBanner.jsx:34`, `app/health/HealthPage.jsx` (статус-цвета)

Таблица замен (старое значение → токен; применять по СМЫСЛУ места — фон/линия/текст):

| Старое | Новое |
|---|---|
| `#0b1220` (фон) | `C.bg` / `var(--bg)` |
| `#131c2e` | `C.surface` |
| `#1a2540` | `C.surfaceAlt` |
| `#243049` | `C.line` |
| `#e8edf7` | `C.ink` |
| `#8a99b8` | `C.muted` |
| `#6b7a8f` | `C.faint` |
| `#4f8cff` | `C.accent` |
| `#2bd4a0` | `C.accent2` |
| `#ff6b6b` / `#f87171` | `C.neg` |
| `#4ade80` | `C.pos` |
| `#fbbf24` | `C.warn` |
| `#f97316` / `rgba(249,115,22,…)` | МП-бейдж → класс `.mp-badge .mp-ozon`; прочее → `C.pink` |
| `rgba(79,140,255,X)` | `soft("accent", X×100)` |
| `#0b1220` (ТЕКСТ на акценте) | `var(--accentInk)` |

- [ ] **Step 1: ReviewsPage** — все вхождения по таблице; у страницы, вероятно, свой const C-объект со старыми hex — заменить импортом `C`/`soft` из lib/palette.js (посмотреть, как импортируют соседние страницы). Функциональную логику (state, fetch, обработчики) НЕ трогать — только цвета.
- [ ] **Step 2: Ozon/WB-бейджи** в 4 файлах → `<span className="mp-badge mp-ozon">`/`mp-wb` (классы из cabinet.css; если элемент вне кабинета — settings/page.js — cabinet.css там не подключён: проверить, и если так, использовать `C.pink`/`soft("pink",15)` инлайн с комментарием).
- [ ] **Step 3: Мелочь** — заглушки/стаб/OpsAlertsBanner/HealthPage по таблице.
- [ ] **Step 4:** grep по всему app/ на старые значения `#131c2e|#1a2540|#243049|#4f8cff|#2bd4a0|#8a99b8|#0b1220` → ноль вхождений (кроме, возможно, комментариев). `npm run build` чисто. Commit: `feat(ui): остров ReviewsPage и бейджи на токены — старой палитры в app/ не осталось`

---

### Task 4: Чипы «текст на акценте» (4 страницы)

**Files:**
- Modify: `app/cabinets/[id]/OverviewClient.jsx:172,218`, `app/cabinets/[id]/unit/UnitPage.jsx:193`, `app/cabinets/[id]/pnl/PnlPage.jsx:321`, `app/cabinets/[id]/orders/OrdersPage.jsx:401`

- [ ] **Step 1:** В каждом месте активный чип: цвет текста `#0b1220` → `var(--accentInk)` (или `C.bg`-подобные конструкции → accentInk), фон остаётся `C.accent`. Проверить соседние состояния чипов (неактивный) — не трогать.
- [ ] **Step 2:** `npm run build` чисто. Commit: `feat(ui): текст на акценте через accentInk в чипах четырёх страниц`

---

### Task 5: Dataviz-палитра + удаление lib/theme.js

**Files:**
- Modify: `lib/palette.js` (экспорт SERIES), `app/cabinets/[id]/fin-manual/OpexPage.jsx:93` (PIE_PALETTE), `app/cabinets/[id]/detail/DetailPage.jsx` (серии `#FBBF24`, ~:382-1108 — grep)
- Delete: `lib/theme.js`

- [ ] **Step 1:** В `lib/palette.js` добавить:

```js
// Палитра серий графиков — от токенов темы (SVG принимает fill="var(--…)",
// перекрашивается со сменой темы как и всё остальное).
export const SERIES = [
  "var(--accent)", "var(--pos)", "var(--warn)", "var(--pink)",
  "var(--accent2)", "var(--blue)", "var(--neg)", "var(--muted)",
];
```

- [ ] **Step 2:** `OpexPage.jsx`: `PIE_PALETTE` → импорт `SERIES` (использование `[i % length]` сохраняется). ⚠️ Проверить рендер recharts с `var()`-fill: если библиотека где-то парсит цвет (градиенты/легенды на canvas) и `var()` не работает — фолбэк: захардкоженный массив из ФАКТИЧЕСКИХ hex-значений новой палитры с комментарием «recharts не умеет var(), значения = токены темы X на 2026-08-22» и пометкой в отчёте (это компромисс, зафиксировать).
- [ ] **Step 3:** `DetailPage.jsx`: `#FBBF24` в сериях → `var(--warn)` (или C.warn), та же ⚠️-проверка.
- [ ] **Step 4:** `grep -rn "from.*lib/theme\|theme.js" app/ lib/` → ноль импортов → `git rm lib/theme.js`. `npm run build` чисто. Commit: `feat(ui): графики на токен-палитре SERIES, мёртвый lib/theme.js удалён`

---

### Task 6: Композиция Обзор / Сводка / P&L

**Files:**
- Modify: `app/cabinets/[id]/OverviewClient.jsx` (Kpi :336 и KPI-ряд), `app/cabinets/[id]/summary/SummaryPage.jsx` (Kpi :692, KPI-ряд :292-320, числовые колонки таблицы), `app/cabinets/[id]/pnl/PnlPage.jsx` (строки таблицы)

- [ ] **Step 1: Primary-вариант Kpi** — в ОБОИХ файлах (у каждого своя функция Kpi) добавить проп `primary`: та же разметка, но value 30px/800 и плитка шире (`flex: 1.6` или аналог по месту). Спарклайн НЕ добавлять (данных в ответах нет — Global Constraints).
- [ ] **Step 2: Обзор** — первая плитка (прибыль периода) получает `primary`; порядок остальных не менять.
- [ ] **Step 3: Сводка** — KPI-ряд в порядок макета: Прибыль (primary) → Выручка → Реклама → Продано, шт → % выкупа; ДРР (общий) и Кабинетные расходы — после них (вторым рядом при переносе). Тултипы ДОСЛОВНО сохраняются. Числовые колонки таблицы: выравнивание вправо (найти рендер td — если уже вправо, зафиксировать в отчёте «уже было»).
- [ ] **Step 4: P&L** — группам строк подзаголовки-eyebrow (11px, uppercase, letter-spacing .06em, C.muted; сами группы в данных уже есть — использовать существующую структуру рендера, НЕ менять состав строк), итоговые строки: fontWeight 700 + `borderTop: 1px solid var(--line)`, числа вправо.
- [ ] **Step 5:** `npm run build` чисто. Commit: `feat(ui): композиция Обзор/Сводка/P&L — главная цифра крупно, группы P&L`

---

### Task 7: Деплой, сторожа, приёмка

- [ ] **Step 1:** Сообщение владельцу от контролёра (ДО рестарта): деплой этапа 2, что изменится, откат за минуту.
- [ ] **Step 2:** `npm run build && systemctl restart saas-web` → active.
- [ ] **Step 3:** Сторожа: check-profit-canon (1, 1008), profit-snapshot --verify → ALL PASS.
- [ ] **Step 4:** Приёмка владельцем: Отзывы, Обзор, Сводка, P&L, обе темы → «ок»/«откати»/«поправь». Откат: `git revert` коммитов задач 1-6 + build.

---

## Self-review (выполнено при написании)

- Покрытие спеки: компонент 1 (T2+T3), компонент 2 (T1+T4), компонент 3 (T6), компонент 4 (T5), приёмка (T7). «Не входит» соблюдено (API/formулы не в Files ни одной задачи).
- Согласованность: `--accentInk` вводится в T1, используется в T3 (таблица) и T4; `SERIES` в T5; `lib/callout.js` в T2.
- Честные ⚠️: recharts×var() (T5) и mp-badge вне cabinet.css (T3) — с готовыми фолбэками, не дырами.
- Строки из финального ревью этапа 1 могли сдвинуться — везде указано «искать по содержимому/grep», паттерны заданы.
