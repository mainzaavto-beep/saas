# Сводка по макету — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сводка выглядит как согласованный макет: KPI-ряд из 5 плиток с дельтами к прошлому периоду, спарклайн прибыли в главной плитке, ДРР-пиллы по марже в таблице.

**Architecture:** Сервер (products-summary) дополнительно отдаёт prevTotals (то же окно длиной N стыком назад, тем же batch-каноном) и profitSpark (дневной ряд «rawProfit − реклама», до налога — новые кабинетные by-day хелперы переносом существующих SELECT'ов); клиент считает дельты, рисует спарклайн-SVG по образцу макета и красит ДРР-пиллы правилом «относительно маржи».

**Tech Stack:** Node/ESM (lib, роут), React/SVG (SummaryPage).

**Спека:** `docs/superpowers/specs/2026-08-25-summary-restyle-mockup-design.md` (fa4e97a). Макет-эталон: артефакт c6b60865 «Sysell — макет Сводки (строгий стиль)»; его ключевые образцы вшиты в шаги ниже.

## Global Constraints

- Формулы канона не меняются; все новые поля ответа аддитивны; существующие числа Сводки не меняются (дельты/спарклайн/пиллы — новое отображение).
- Спарклайн — «прибыль дня ДО налога» (rawProfit − реклама дня): подпись/тултип плитки обязаны это говорить честно; хелперы кабинетного by-day — ПЕРЕНОС SELECT'ов из `ozRawProfitByDay`/`wbRawProfitByDay` (те же слагаемые/датировка, без product-фильтра, GROUP BY день).
- ДРР-пилл (решение владельца): ok если drr < margin/2; warn если margin/2 ≤ drr < margin; bad если drr ≥ margin ИЛИ (ads>0 и продаж 0 → пилл «—»); ads=0 → без пилла (прочерк как сейчас); margin ≤ 0 при drr > 0 → bad.
- prev-окно: prev_to = from−1, prev_from = prev_to−(N−1), где N — длина текущего окна в днях (для явных окон — так же).
- Стили — существующие токены C.*/soft() SummaryPage; никаких новых цветов/хексов. Тексты по-русски.
- Сторожа после каждой задачи: `node scripts/check-profit-canon.mjs --cabinet 1`, `--cabinet 1008`, `node scripts/profit-snapshot.mjs --verify` — ALL PASS дословно (snapshot зовёт products-summary с явными окнами — новые поля аддитивны, не должен шевельнуться).
- Деплой только в задаче 3.

---

### Task 1: Сервер — prevTotals и profitSpark

**Files:**
- Modify: `lib/ozonMetrics.js` (после `ozRawProfitByDay`), `lib/wbMetrics.js` (после `wbRawProfitByDay`)
- Modify: `app/api/cabinets/[id]/products-summary/route.js`

**Interfaces:**
- Produces: `ozRawProfitCabinetByDay(db, {from,to}) -> Map<'YYYY-MM-DD', aggForm>` и `wbRawProfitCabinetByDay(...)` (кабинетные, без product-фильтра); ответ products-summary + `prevTotals` (та же форма, что totals — те же поля, за prev-окно) и `profitSpark: [{date, profit}]` (по дням текущего окна, profit = rawProfitWb+rawProfitOz − adSpendДня, round2; дни без движения = 0). Задача 2 использует.

- [ ] **Step 1: Кабинетные by-day хелперы** — в каждом lib скопировать соответствующий `*RawProfitByDay` БЕЗ параметра/фильтра product/nm (SELECT, слагаемые, датировка `substr(COALESCE(sale_dt, return_dt),1,10)` — байт-в-байт), докстрока: «кабинетный дневной агрегат для спарклайна Сводки; форма и слагаемые = *RawProfitByDay, инвариант: Σ дней = *RawProfitAggregate(period) — сверяется приёмкой задачи».
- [ ] **Step 2: prevTotals** — в products-summary после вычисления totals: посчитать длину окна N (как periodDays в check-скрипте: (to−from)/86400000+1), prev-окно по формуле GC; повторить ровно те вызовы batch-канона/агрегаций, которыми строится totals, за prev-окно (вынести построение totals в локальную функцию `buildTotals(from,to)` и вызвать дважды — НЕ копировать тело); `prevTotals` в ответ. Если totals строится из построчных данных товаров — buildTotals агрегирует тем же кодом (рефактор выноса, не переписывание).
- [ ] **Step 3: profitSpark** — два кабинетных by-day вызова + реклама по дням (`SELECT date::text AS d, COALESCE(SUM(ad_spend),0) FROM daily_metrics WHERE date::text >= ? AND <= ? GROUP BY d` — обе платформенные таблицы, как их видит db-шим; сверить имена по коду соседних запросов); ряд по всем датам окна (нулевые дни = 0), profit = round2(rawWb + rawOz − ad).
- [ ] **Step 4: Приёмка-инвариант** (scratchpad, не коммитить): Σ profitSpark = (rawProfit период WB+Oz − ads период) с допуском 0,02·N ₽; prevTotals при явном окне = totals того же окна, вызванного напрямую (сдвинуть query-параметры) — числа в отчёт.
- [ ] **Step 5:** `node --check`; сторожа 3 команды ALL PASS.
- [ ] **Step 6: Commit**: `feat(summary): prevTotals и profitSpark — дельты к прошлому окну и дневной ряд до налога`

---

### Task 2: Клиент — KPI-ряд с дельтами и спарклайном

**Files:**
- Modify: `app/cabinets/[id]/summary/SummaryPage.jsx` (KPI-блок :300-330, компонент Kpi :695-706)

- [ ] **Step 1: Дельты.** Хелпер в файле:

```jsx
// Дельта к прошлому окну: {text, dir} или null (нет prev/деление на 0).
// pp=true — в процентных пунктах (для % выкупа), иначе в % отношения.
function delta(cur, prev, { pp = false } = {}) {
  if (prev == null || cur == null) return null;
  if (pp) { const d = cur - prev; return { text: `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} п.п.`, dir: d >= 0 ? "up" : "down" }; }
  if (!prev) return null;
  const d = (cur - prev) / Math.abs(prev) * 100;
  return { text: `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} % к прошлому периоду`, dir: d >= 0 ? "up" : "down" };
}
```

(короткая форма без «к прошлому периоду» для второстепенных плиток — параметром или срезом текста; up = C.pos, down = C.neg). Kpi получает проп `delta` и рендерит строку 12px под значением (как макет: `.delta.up/.down`).

- [ ] **Step 2: Спарклайн** — компонент в файле (образец макета, адаптированный под токены):

```jsx
// Спарклайн прибыли (до налога) — line+area+точка на конце, как в макете Сводки.
function Spark({ series }) {
  if (!series || series.length < 2) return null;
  const W = 120, H = 44, PAD = 3;
  const vals = series.map((p) => p.profit);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => [i * (W / (vals.length - 1)), PAD + (H - 2 * PAD) * (1 - (v - min) / span)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [ex, ey] = pts[pts.length - 1];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" style={{ flex: `0 0 ${W}px` }}>
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={soft("accent", 15)} stroke="none" />
      <path d={line} fill="none" stroke={C.accent} strokeWidth="2" />
      <circle cx={ex} cy={ey} r="2.6" fill={C.accent} />
    </svg>
  );
}
```

Главная плитка (primary) — flex-раскладка «текст слева, Spark справа» (как макет `.kpi.primary`), title плитки: «Прибыль за период; график — прибыль по дням до налога (rawProfit − реклама)».

- [ ] **Step 3: Состав ряда** — ровно 5 плиток: Прибыль (primary, spark, delta full), Выручка (delta), Реклама (подпись «ДРР N %» muted — значение текущей плитки «ДРР (общий)»), Продано шт (delta), Выкуп (delta pp). Убрать остальные плитки (Маржа/Заказано/CPA и пр.) — их метрики остаются в таблице. Grid как макет: `1.6fr 1fr 1fr 1fr 1fr` (адаптировать текущую flex/grid-обвязку).
- [ ] **Step 4:** parse-проверка; сторожа. **Commit**: `feat(summary): KPI-ряд по макету — дельты к прошлому окну и спарклайн прибыли`

---

### Task 3: ДРР-пиллы + ячейка товара + деплой

**Files:**
- Modify: `app/cabinets/[id]/summary/SummaryPage.jsx` (ячейка drr :453; ячейка товара — сверить с макетом)

- [ ] **Step 1: Пилл.** Хелпер + рендер:

```jsx
// ДРР-пилл: пороги ОТНОСИТЕЛЬНО маржи товара (решение владельца 25.08):
// ok < margin/2; warn < margin; bad ≥ margin | реклама без продаж | margin≤0.
function drrPillTone(drr, margin, ads, sold) {
  if (!ads) return null;                    // рекламы нет — пилла нет
  if (!sold || margin == null || margin <= 0) return "bad";
  if (drr < margin / 2) return "ok";
  if (drr < margin) return "warn";
  return "bad";
}
```

Рендер в ячейке: `tone == null → pct(it.drr)` как сейчас; иначе span-пилл (font 11.5/600, radius 6, padding "2px 8px", цвет C.pos/C.warn/C.neg, background soft(тон, 13)) с текстом `sold ? pct(it.drr) : "—"`. Поля margin/ads/sold — из строки it (сверить имена по коду).
- [ ] **Step 2: Ячейка товара** — сверить текущую с макетом (имя 600 + вторая строка «Площадка · артикул» цветом C.faint 12px; категория — чип `.cat`-стиля: 11px, border line, radius 5, background surfaceAlt). Привести, если отличается; если уже так — зафиксировать в отчёте «совпадает».
- [ ] **Step 3:** Сторожа → `npm run build && systemctl restart saas-web` → is-active + сторожа повторно.
- [ ] **Step 4: Приёмка:** (а) дельты: два явных окна query-параметрами (текущее и prev) — ручная сверка чисел дельт (данные в отчёт); (б) пиллы: найти в живых данных по товару на каждый тон (ok/warn/bad/«—») и показать drr vs margin (SQL/JSON); (в) спарклайн: 3 точки ряда сверить с SQL по дням. **Commit**: `feat(summary): ДРР-пиллы по марже и карточка товара по макету`

---

### Task 4: Контракт + финализация

- [ ] Контракт: подраздел Сводки — prevTotals (стык-окно), profitSpark (ДО налога — почему и как подписано), правило ДРР-пилла. Commit: `docs(contract): Сводка — дельты, спарклайн до налога, ДРР-пиллы по марже`
- [ ] Финальное ревью ветки (whole-branch, fable; гейт контракт-задачи объединён) — по процессу SDD.

---

## Self-review (выполнено при написании)

- Покрытие спеки: разрывы 1-4 → задачи 1-3; данные (prevTotals/spark) → T1; пороги ДРР — формула решения владельца в GC и коде; «до налога» — честная подпись в T2 Step 2 title.
- buildTotals-рефактор вместо копии тела — DRY по духу конвейера.
- Спарклайн: min==max (плоский ряд) → span=1, линия по центру — деление на 0 закрыто; series<2 → null.
- Плейсхолдеров нет; имена полей строк «сверить по коду» помечены явно.
