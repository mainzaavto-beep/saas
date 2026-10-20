# Процент выкупа: «Одиночные / Примерки» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** разрез процента выкупа по типу заказа — одиночный вариант модели или примерка (2+ варианта одной модели в одном заказе: размеры / цвета / смешанная), плюс сводка примерок и «что оставляют».

**Architecture:** каталоги получают модель/цвет/размер (Ozon — атрибуты `/v4`, WB — `imtID`), загрузчик когорты добавляет к строкам ключи корзины/модели/варианта, чистые функции `lib/buyout.js` размечают строки (`tagFitting`), фильтруют (`filterByFitting`) и считают `fittingSummary`; роут принимает `&fit=`, страница — переключатель, плитка, блок. Канон §18 и Сводка не меняются.

**Tech Stack:** Next.js 14 (App Router), PostgreSQL (RLS), node:test, Python-сборщики (psycopg).

**Spec:** `docs/superpowers/specs/2026-10-20-buyout-fitting-design.md`

## Global Constraints

- Только кабинет #1: прогоны сборщиков `--cabinet 1`, смоуки `1`. Другие кабинеты не трогать.
- Дефолт страницы — «Все»; `/products-summary`, юнитка, `/kpi` — без изменений (смоук «Сводка = страница» должен остаться зелёным).
- Миграция идемпотентна, номер **073**; применяется админом: `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f …`.
- Перед правкой боевого файла — бэкап в `/opt/agentsDB/backups/<имя>.20261020_HHMMSS.bak`.
- Пустой `catch {}` без `console.error` запрещён.
- `git add` — только явный список файлов задачи (в рабочем дереве лежат чужие `down/`, `scratchpad/`).
- Ozon-атрибуты (проба 20.10.2026): `model_info.model_id`; цвет 10097, fallback 10096; размер 9533, fallback 4295 (несколько значений → `/`); 4508 — «размер на фото», не использовать.
- `next dev` в каталоге прода не запускать; после правок `app/`/`lib/` — `npm run build && systemctl restart saas-web`.

---

### Task 1: Каталоги — модель, цвет, размер (миграция 073 + сборщики)

**Files:**
- Create: `db/migrations/073_catalog_variants.sql`
- Modify: `worker/db_pg.py` (`_OZ_PRODUCT_COLS` ~стр. 899, `upsert_product` ~905, `upsert_article` ~113)
- Modify: `worker/collectors/ozon_catalog.py` (новая `variant_attrs`, вызов в цикле `collect()` рядом с `upsert_product`)
- Modify: `worker/collectors/wb_catalog.py` (`fetch_all_cards` → `imt_id`, `collect` → `upsert_article(..., imt_id=)`)
- Create: `worker/collectors/ozon_catalog_selftest.py`

**Interfaces:**
- Produces: колонки `tenant.ozon_products.{model_id bigint, color text, size text}`, `tenant.wb_articles.imt_id bigint`; `ozon_catalog.variant_attrs(a: dict) -> tuple[int|None, str|None, str|None]`.

- [ ] **Step 1: Миграция**

```sql
-- 073: модель/цвет/размер варианта для «Процента выкупа: одиночные / примерки» (20.10.2026,
-- спека docs/superpowers/specs/2026-10-20-buyout-fitting-design.md). Ozon — из
-- /v4/product/info/attributes (model_info.model_id, атрибуты 10097/10096 цвет, 9533/4295 размер),
-- WB — imtID карточки Content API. Гранты табличные — новые колонки их наследуют.
ALTER TABLE tenant.ozon_products
  ADD COLUMN IF NOT EXISTS model_id bigint,
  ADD COLUMN IF NOT EXISTS color text,
  ADD COLUMN IF NOT EXISTS size text;
ALTER TABLE tenant.wb_articles
  ADD COLUMN IF NOT EXISTS imt_id bigint;
```

Применить: `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -v ON_ERROR_STOP=1 -f db/migrations/073_catalog_variants.sql` (дважды — второй раз без ошибок).

- [ ] **Step 2: Падающий селф-тест `variant_attrs`**

`worker/collectors/ozon_catalog_selftest.py`:

```python
"""
Селф-тест ozon_catalog.variant_attrs (без сети и БД): модель/цвет/размер варианта из
/v4/product/info/attributes (проба каб. #1 20.10.2026).
Запуск: /opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_catalog_selftest.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ozon_catalog as m  # noqa: E402


def attr(i, *vals):
    return {"id": i, "values": [{"value": v} for v in vals]}


bra = {"model_info": {"model_id": 6175686419, "count": 30}, "attributes": [
    attr(10096, "баклажановый", "фиолетово-баклажанный"), attr(10097, "баклажановый"),
    attr(4295, "42", "44"), attr(9533, "M"), attr(4508, "S")]}
assert m.variant_attrs(bra) == (6175686419, "баклажановый", "M"), m.variant_attrs(bra)

no_letter = {"model_info": {"model_id": 1}, "attributes": [attr(10096, "коричневый", "шоколадный"), attr(4295, "42", "44")]}
assert m.variant_attrs(no_letter) == (1, "коричневый", "42/44"), m.variant_attrs(no_letter)

cover = {"model_info": {"model_id": 5315790675}, "attributes": [attr(8415, "160"), attr(10097, "коричневый")]}
assert m.variant_attrs(cover) == (5315790675, "коричневый", None), m.variant_attrs(cover)

assert m.variant_attrs({}) == (None, None, None)
assert m.variant_attrs({"model_info": {"model_id": 0}, "attributes": [attr(10097, "  ")]}) == (None, None, None)
print("ozon_catalog_selftest OK")
```

Run: `/opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_catalog_selftest.py`
Expected: FAIL — `AttributeError: module 'ozon_catalog' has no attribute 'variant_attrs'`.

- [ ] **Step 3: `variant_attrs` + запись в `ozon_catalog.collect()`**

Бэкап `ozon_catalog.py`, `wb_catalog.py`, `db_pg.py`. В `ozon_catalog.py` перед `collect()`:

```python
# Модель/цвет/размер варианта (20.10.2026, «Процент выкупа: одиночные / примерки»). Проба каб. #1:
# все цвета и размеры комплекта — один model_info.model_id; 10097 «Название цвета» (одно значение),
# 10096 «Цвет товара» (список оттенков, берём первый); 9533 — буквенный размер (M/L), 4295 —
# российский (42; 44). 4508 — «размер модели на фото», НЕ размер варианта. У накидок размера нет.
OZ_ATTR_COLOR_NAME = 10097
OZ_ATTR_COLOR = 10096
OZ_ATTR_SIZE = 9533
OZ_ATTR_SIZE_RU = 4295


def variant_attrs(a: dict) -> tuple:
    vals = {}
    for at in a.get("attributes") or []:
        vs = [str(v.get("value")).strip() for v in at.get("values") or [] if str(v.get("value") or "").strip()]
        if vs:
            vals[at.get("id")] = vs
    color = (vals.get(OZ_ATTR_COLOR_NAME) or vals.get(OZ_ATTR_COLOR) or [None])[0]
    size = (vals.get(OZ_ATTR_SIZE) or [None])[0] or ("/".join(vals[OZ_ATTR_SIZE_RU]) if vals.get(OZ_ATTR_SIZE_RU) else None)
    model_id = (a.get("model_info") or {}).get("model_id")
    return (int(model_id) if model_id else None, color, size)
```

В цикле `collect()` перед `db_pg.upsert_product(...)`: `model_id, color, size = variant_attrs(a)` и в вызов добавить `model_id=model_id, color=color, size=size,`.

- [ ] **Step 4: `db_pg.py`**

```python
_OZ_PRODUCT_COLS = ["product_id", "offer_id", "name", "barcode", "fbo_sku", "category",
                    "brand", "visibility", "commission_pct", "weight", "length", "width",
                    "height", "volume_weight", "logistics_fbo_tariff", "last_mile_pct",
                    "vat", "price", "old_price", "im_url", "description_category_id", "type_name",
                    "model_id", "color", "size"]
# Пустой ответ атрибутов не затирает модель/цвет/размер (как name) — 20.10.2026.
_OZ_COALESCE_COLS = {"name", "model_id", "color", "size"}
```

В `upsert_product`: `... if c in _OZ_COALESCE_COLS else f"{c}=EXCLUDED.{c}"` вместо `if c == "name"`.

`upsert_article`:

```python
def upsert_article(nm_id, name, brand=None, subject=None, im_url=None, imt_id=None):
    _upsert_row(
        "wb_articles", ["nm_id"],
        ["nm_id", "name", "brand", "subject", "im_url", "imt_id"],
        {"nm_id": nm_id, "name": name, "brand": brand, "subject": subject, "im_url": im_url, "imt_id": imt_id},
        coalesce_cols=["brand", "subject", "im_url", "imt_id"],
    )
```

`wb_catalog.py`: в словарь карточки `"imt_id": c.get("imtID"),`; в `collect()` — `db_pg.upsert_article(c["nm_id"], c["name"], c.get("brand"), c.get("subject"), c.get("im_url"), imt_id=c.get("imt_id"))`.

- [ ] **Step 5: Селф-тест зелёный + прогон на #1**

Run: `/opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_catalog_selftest.py` → `ozon_catalog_selftest OK`.

Run:
```bash
cd /opt/agents/saas && set -a && . /etc/saas-worker.env && . /etc/collectors.env && set +a && \
/opt/agents/data-presenter-agent/.venv/bin/python -m worker.orchestrator --cabinet 1 --collectors ozon_catalog,wb_catalog --verbose
```
Expected: оба `ok`. Проверка:
```bash
psql -h localhost -U saas_ro -d saas -Atc "select count(*), count(model_id), count(color), count(size) from tenant.ozon_products where cabinet_id=1" \
  -c "select count(*), count(imt_id), count(distinct imt_id) from tenant.wb_articles where cabinet_id=1" \
  -c "select offer_id, model_id, color, size from tenant.ozon_products where cabinet_id=1 and product_id in (6017499668,6017618242,4191173237)"
```
Expected: `model_id` заполнен у большинства Ozon; `6017499668 → 6175686419 | баклажановый | M`, `4191173237 → 5315790675 | коричневый | ` (пусто); у WB `imt_id` у всех карточек.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/073_catalog_variants.sql worker/db_pg.py worker/collectors/ozon_catalog.py \
  worker/collectors/wb_catalog.py worker/collectors/ozon_catalog_selftest.py
git commit -m "feat(catalog): модель/цвет/размер варианта Ozon и imtID WB (миграция 073)"
```

---

### Task 2: Чистые функции примерки в `lib/buyout.js`

**Files:**
- Modify: `lib/buyout.js` (добавить в конец файла)
- Test: `lib/__tests__/buyout.test.mjs` (дописать в конец)

**Interfaces:**
- Consumes: строки когорты с полями (Task 3 их заполнит): `platform, srid, nmId, name, basket, modelKey, variantKey, colorKey, sizeKey, sizeLabel, fitEstimated, selfBuyout` + поля судьбы (как сейчас).
- Produces:
  - `ozonBasket(postingNumber: string) -> string` — первые две части через `-`.
  - `FIT_VALUES = ["all","single","fitting","size","color","mixed"]`
  - `tagFitting(rows) -> rows` с `fit ∈ "single"|"fit_size"|"fit_color"|"fit_mixed"` и `basketKey`.
  - `filterByFitting(rows, kind) -> rows` (размечает, если `fit` нет; неизвестный kind = all).
  - `fittingSummary(rows, asOf) -> { baskets, fittingBaskets, basketShare, rows, fittingRows, rowShare, resolvedBaskets, basketBuyoutPct, avgVariants, avgKept, bySize: [{platform, modelKey, name, baskets, keptSmallest, keptLargest, keptMiddle, keptNone, keptSeveral, combos:[{combo, n}]}], estimated }`.

- [ ] **Step 1: Падающие тесты** (в конец `lib/__tests__/buyout.test.mjs`)

```js
import { tagFitting, filterByFitting, fittingSummary, ozonBasket, FIT_VALUES } from "../buyout.js";

// Примерка (20.10.2026): строка Ozon-формы — удобнее для разметки, судьба через status.
const oz = (o) => ({ platform: "ozon", srid: "p", nmId: 1, name: "Комплект", status: "delivered", isReturn: false,
  selfBuyout: false, orderDate: "2026-09-01", cancelAt: null, cancelReason: null,
  basket: "B1", modelKey: "m:1", variantKey: "1", colorKey: "коричн", sizeKey: "M", sizeLabel: "M", fitEstimated: false, ...o });

test("ozonBasket: номер заказа — две первые части отправления", () => {
  assert.equal(ozonBasket("0107344381-0022-1"), "0107344381-0022");
  assert.equal(ozonBasket("0107344381-0022"), "0107344381-0022");
});

test("tagFitting: размеры / цвета / смешанная / одиночный", () => {
  const rows = tagFitting([
    oz({ basket: "S", variantKey: "1", sizeKey: "S", sizeLabel: "S" }), oz({ basket: "S", variantKey: "2", sizeKey: "M", sizeLabel: "M" }),
    oz({ basket: "C", variantKey: "1", colorKey: "коричн" }), oz({ basket: "C", variantKey: "3", colorKey: "баклаж" }),
    oz({ basket: "X", variantKey: "1", colorKey: "коричн", sizeKey: "S" }), oz({ basket: "X", variantKey: "4", colorKey: "баклаж", sizeKey: "M" }),
    oz({ basket: "O", variantKey: "1" }),
  ]);
  assert.deepEqual(rows.map((r) => r.fit), ["fit_size", "fit_size", "fit_color", "fit_color", "fit_mixed", "fit_mixed", "single"]);
});

test("tagFitting: две штуки одного варианта — одиночный; разные модели в корзине — каждая одиночная", () => {
  const rows = tagFitting([
    oz({ basket: "Q", srid: "a" }), oz({ basket: "Q", srid: "b" }),
    oz({ basket: "R", modelKey: "m:1" }), oz({ basket: "R", modelKey: "m:2", variantKey: "9" }),
  ]);
  assert.deepEqual(rows.map((r) => r.fit), ["single", "single", "single", "single"]);
});

test("tagFitting: варианты одного цвета без размера (накидки) — примерка по размеру", () => {
  const rows = tagFitting([oz({ basket: "N", variantKey: "1", sizeKey: "", sizeLabel: "90*160" }),
    oz({ basket: "N", variantKey: "2", sizeKey: "", sizeLabel: "90*210" })]);
  assert.deepEqual(rows.map((r) => r.fit), ["fit_size", "fit_size"]);
});

test("tagFitting: самовыкуп не делает корзину примеркой", () => {
  const rows = tagFitting([oz({ basket: "Z", variantKey: "1" }), oz({ basket: "Z", variantKey: "2", sizeKey: "L", selfBuyout: true })]);
  assert.equal(rows[0].fit, "single");
});

test("filterByFitting: single + fitting = all по всем вёдрам; size/color/mixed = fitting", () => {
  const rows = [
    oz({ basket: "S", variantKey: "1", sizeKey: "S" }), oz({ basket: "S", variantKey: "2", sizeKey: "M", status: "cancelled", isReturn: true }),
    oz({ basket: "C", variantKey: "1" }), oz({ basket: "C", variantKey: "3", colorKey: "баклаж" }),
    oz({ basket: "X", variantKey: "1", sizeKey: "S" }), oz({ basket: "X", variantKey: "4", colorKey: "баклаж", sizeKey: "M" }),
    oz({ basket: "O", variantKey: "1", status: "delivered", isReturn: true }),
  ];
  const k = (kind) => aggregateBuyout(filterByFitting(rows, kind), ASOF).kpi;
  for (const key of ["ordered", "sold", "refused", "returned", "pending", "cancelledPre", "self"]) {
    assert.equal(k("single")[key] + k("fitting")[key], k("all")[key], key);
    assert.equal(k("size")[key] + k("color")[key] + k("mixed")[key], k("fitting")[key], key);
  }
  assert.equal(filterByFitting(rows, "bogus").length, rows.length);
  assert.deepEqual(FIT_VALUES, ["all", "single", "fitting", "size", "color", "mixed"]);
});

test("fittingSummary: выкуп по корзине, pending не судим, что оставили из размеров", () => {
  const rows = tagFitting([
    // S+M → оставили M (больший)
    oz({ basket: "A", variantKey: "1", sizeKey: "S", sizeLabel: "S", status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    oz({ basket: "A", variantKey: "2", sizeKey: "M", sizeLabel: "M" }),
    // S+M → ничего
    oz({ basket: "B", variantKey: "1", sizeKey: "S", sizeLabel: "S", status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    oz({ basket: "B", variantKey: "2", sizeKey: "M", sizeLabel: "M", status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    // S+M ещё в пути — не судим
    oz({ basket: "C", variantKey: "1", sizeKey: "S", status: "delivering" }), oz({ basket: "C", variantKey: "2", sizeKey: "M" }),
    // цвета — выкуплен один
    oz({ basket: "D", variantKey: "1" }), oz({ basket: "D", variantKey: "3", colorKey: "баклаж", status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    // одиночный
    oz({ basket: "E", variantKey: "1" }),
  ]);
  const s = fittingSummary(rows, ASOF);
  assert.equal(s.baskets, 5);
  assert.equal(s.fittingBaskets, 4);
  assert.equal(s.basketShare, 80);
  assert.equal(s.rows, 9);
  assert.equal(s.fittingRows, 8);
  assert.equal(s.resolvedBaskets, 3);                // C в пути
  assert.equal(s.basketBuyoutPct, 66.67);            // A и D выкуплены, B нет
  assert.equal(s.avgVariants, 2);
  assert.equal(s.avgKept, 0.67);
  assert.equal(s.bySize.length, 1);
  const m = s.bySize[0];
  assert.equal(m.baskets, 2);
  assert.equal(m.keptLargest, 1);
  assert.equal(m.keptNone, 1);
  assert.deepEqual(m.combos, [{ combo: "S+M → M", n: 1 }, { combo: "S+M → ничего", n: 1 }]);
  assert.equal(s.estimated, false);
  assert.equal(fittingSummary(tagFitting([oz({ fitEstimated: true })]), ASOF).estimated, true);
});
```

Run: `node --test lib/__tests__/buyout.test.mjs`
Expected: FAIL — `does not provide an export named 'tagFitting'`.

- [ ] **Step 2: Реализация** (в конец `lib/buyout.js`, бэкап файла)

```js
// Примерка (20.10.2026, спека docs/superpowers/specs/2026-10-20-buyout-fitting-design.md): 2+ варианта
// ОДНОЙ модели в одном заказе (корзине). Корзина — Ozon номер заказа, WB g_number; модель — Ozon
// model_id, WB imt_id (fallback — название / nm, fitEstimated). Тип по составу корзины в пределах
// модели, самовыкупы не считаются: цвета одинаковы → fit_size (и варианты, различимые только по id —
// накидки без атрибута размера), цвета разные при одном размере → fit_color, оба различаются →
// fit_mixed. Видна только примерка внутри ОДНОГО заказа — разные заказы человека не связать.
export const FIT_VALUES = ["all", "single", "fitting", "size", "color", "mixed"];
const FIT_PRED = {
  single: (f) => f === "single",
  fitting: (f) => f !== "single",
  size: (f) => f === "fit_size",
  color: (f) => f === "fit_color",
  mixed: (f) => f === "fit_mixed",
};

export function ozonBasket(postingNumber) {
  return String(postingNumber).split("-").slice(0, 2).join("-");
}

const fitGroupKey = (r) => `${r.platform || "wb"}|${r.basket ?? r.srid}|${r.modelKey ?? r.nmId}`;

export function tagFitting(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.selfBuyout) continue;
    const k = fitGroupKey(r);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { variants: new Set(), colors: new Set(), sizes: new Set() }));
    g.variants.add(r.variantKey ?? `${r.nmId}|${r.size}`);
    g.colors.add(r.colorKey ?? "");
    g.sizes.add(r.sizeKey ?? "");
  }
  return rows.map((r) => {
    const basketKey = fitGroupKey(r);
    const g = groups.get(basketKey);
    let fit = "single";
    if (!r.selfBuyout && g && g.variants.size > 1) {
      const c = g.colors.size > 1;
      fit = c ? (g.sizes.size > 1 ? "fit_mixed" : "fit_color") : "fit_size";
    }
    return { ...r, fit, basketKey };
  });
}

export function filterByFitting(rows, kind) {
  const tagged = rows.length && rows[0].fit ? rows : tagFitting(rows);
  const pred = FIT_PRED[kind];
  return pred ? tagged.filter((r) => pred(r.fit)) : tagged;
}

// Сводка примерок по размеченным строкам. Корзина-примерка судится, когда в ней нет pending и не все
// строки отменены до отгрузки; «выкуплена» — выкуплен (sold) хотя бы один вариант. bySize — только
// fit_size: какой размер оставили (меньший / больший / средний / ничего / несколько) и комбинации.
export function fittingSummary(rows, asOf) {
  const groups = new Map();
  let nRows = 0, nFitRows = 0, estimated = false;
  for (const r of rows) {
    if (r.selfBuyout) continue;
    nRows += 1;
    if (r.fit !== "single") nFitRows += 1;
    if (r.fitEstimated) estimated = true;
    let g = groups.get(r.basketKey);
    if (!g) groups.set(r.basketKey, (g = { fit: r.fit, platform: r.platform || "wb", modelKey: r.modelKey, name: r.name, variants: new Map() }));
    if (!g.name && r.name) g.name = r.name;
    let v = g.variants.get(r.variantKey);
    if (!v) g.variants.set(r.variantKey, (v = { size: r.sizeLabel, buckets: [] }));
    v.buckets.push(classifyRow(r, asOf));
  }
  let fitBaskets = 0, resolved = 0, bought = 0, variantsSum = 0, keptSum = 0;
  const byModel = new Map();
  for (const g of groups.values()) {
    if (g.fit === "single") continue;
    fitBaskets += 1;
    const vs = [...g.variants.values()];
    const all = vs.flatMap((v) => v.buckets);
    if (all.includes("pending") || all.every((b) => b === "cancelledPre")) continue;
    resolved += 1;
    const kept = vs.filter((v) => v.buckets.includes("sold"));
    if (kept.length) bought += 1;
    variantsSum += vs.length;
    keptSum += kept.length;
    if (g.fit !== "fit_size") continue;
    const ordered = sortSizes([...new Set(vs.map((v) => v.size))]);
    const keptSizes = sortSizes([...new Set(kept.map((v) => v.size))]);
    const mk = `${g.platform}|${g.modelKey}`;
    let m = byModel.get(mk);
    if (!m) byModel.set(mk, (m = { platform: g.platform, modelKey: g.modelKey, name: g.name, baskets: 0,
      keptSmallest: 0, keptLargest: 0, keptMiddle: 0, keptNone: 0, keptSeveral: 0, combos: new Map() }));
    m.baskets += 1;
    if (!keptSizes.length) m.keptNone += 1;
    else if (keptSizes.length > 1) m.keptSeveral += 1;
    else if (keptSizes[0] === ordered[0]) m.keptSmallest += 1;
    else if (keptSizes[0] === ordered[ordered.length - 1]) m.keptLargest += 1;
    else m.keptMiddle += 1;
    const combo = `${ordered.join("+")} → ${keptSizes.length ? keptSizes.join("+") : "ничего"}`;
    m.combos.set(combo, (m.combos.get(combo) || 0) + 1);
  }
  const pctOf = (a, b) => (b > 0 ? round2((100 * a) / b) : null);
  return {
    baskets: groups.size,
    fittingBaskets: fitBaskets,
    basketShare: pctOf(fitBaskets, groups.size),
    rows: nRows,
    fittingRows: nFitRows,
    rowShare: pctOf(nFitRows, nRows),
    resolvedBaskets: resolved,
    basketBuyoutPct: pctOf(bought, resolved),
    avgVariants: resolved ? round2(variantsSum / resolved) : null,
    avgKept: resolved ? round2(keptSum / resolved) : null,
    bySize: [...byModel.values()]
      .map((m) => ({ ...m, combos: [...m.combos].map(([combo, n]) => ({ combo, n })).sort((a, b) => b.n - a.n || (a.combo < b.combo ? -1 : a.combo > b.combo ? 1 : 0)) }))
      .sort((a, b) => b.baskets - a.baskets),
    estimated,
  };
}
```

Примечание к тесту `fittingSummary`: корзина C — `delivering` (pending) + `delivered` → не судится; групп A–E = 5. Порядок `combos` при равных `n` — по кодам символов (не `localeCompare("ru")`: в ru-локали кириллица идёт раньше латиницы), поэтому «S+M → M» раньше «S+M → ничего».

- [ ] **Step 3: Тесты зелёные**

Run: `node --test lib/__tests__/buyout.test.mjs` → все PASS (старые тоже).

- [ ] **Step 4: Commit**

```bash
git add lib/buyout.js lib/__tests__/buyout.test.mjs
git commit -m "feat(buyout): разметка примерок, фильтр и сводка (чистые функции)"
```

---

### Task 3: Загрузчик когорты — корзина, модель, вариант

**Files:**
- Modify: `lib/buyoutData.js` (`loadWbBuyoutRows`, `loadOzonBuyoutRows`)

**Interfaces:**
- Consumes: колонки Task 1; `ozonBasket` из Task 2.
- Produces: каждая строка дополнительно несёт `basket, modelKey, variantKey, colorKey, sizeKey, sizeLabel, fitEstimated`.

- [ ] **Step 1: WB** — бэкап файла. В CTE `o` добавить `g_number`; в итоговый SELECT — `o.g_number, a.imt_id`. В `rows.map` добавить:

```js
    basket: r.g_number || r.srid, // корзина покупателя (одна покупка); пусто — заказ сам себе корзина
    modelKey: r.imt_id ? `imt:${r.imt_id}` : `nm:${r.nm_id}`, // модель = imtID (цвета склеены)
    variantKey: `${r.nm_id}|${r.size}`,
    colorKey: String(r.nm_id), // у WB nm внутри imt — цвет
    sizeKey: r.size,
    sizeLabel: r.size === "0" ? "без размера" : r.size,
    fitEstimated: !r.imt_id,
```

- [ ] **Step 2: Ozon** — в итоговый SELECT добавить `p.model_id, p.color, p.size AS attr_size`; импорт `import { ozonBasket } from "./buyout.js";` в начало файла; в `rows.map`:

```js
    basket: ozonBasket(r.posting_number), // номер заказа = корзина покупателя
    modelKey: r.model_id ? `m:${r.model_id}` : `n:${r.name || r.product_id}`,
    variantKey: String(r.product_id),
    colorKey: r.color || "",
    sizeKey: r.attr_size || "",
    sizeLabel: r.attr_size || r.offer_id || String(r.product_id),
    fitEstimated: !r.model_id,
```

(`size: "0"` у Ozon остаётся как есть — это размерная разбивка таблицы, её не трогаем.)

- [ ] **Step 3: Проверка на живых данных #1**

```bash
cd /opt/agents/saas && node --input-type=module -e "
import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*\"?([^\"\n]*)\"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]]=m[2]; }
const { withTenant } = await import('./lib/db.js');
const { loadBuyoutRows } = await import('./lib/buyoutData.js');
const { tagFitting, fittingSummary } = await import('./lib/buyout.js');
await withTenant(1, async () => {
  const rows = tagFitting(await loadBuyoutRows('all', '2026-07-20', '2026-10-19'));
  const by = {}; for (const r of rows) by[r.platform+':'+r.fit] = (by[r.platform+':'+r.fit]||0)+1;
  console.log(by); const s = fittingSummary(rows, '2026-10-20'); console.log({ ...s, bySize: s.bySize.slice(0,3) });
});
process.exit(0);"
```
Expected: у Ozon `fit_*` ≈ сотни строк (117 корзин из пробы ×2), у WB `fit_size` ≈ 120 строк и есть `fit_color`; `estimated: false` (после Task 1). Если `withTenant` имеет другую сигнатуру — посмотреть `lib/db.js` и подставить.

- [ ] **Step 4: Commit**

```bash
git add lib/buyoutData.js
git commit -m "feat(buyout): корзина/модель/вариант в строках когорты"
```

---

### Task 4: API `&fit=` и страница

**Files:**
- Modify: `app/api/cabinets/[id]/buyout/route.js`
- Modify: `app/cabinets/[id]/buyout/BuyoutPage.jsx`
- Modify: `app/cabinets/[id]/buyout/BuyoutChart.jsx`

**Interfaces:**
- Consumes: `tagFitting`, `filterByFitting`, `fittingSummary`, `FIT_VALUES` (Task 2).
- Produces: GET period-ответ `{ ..., fit, fitting }`; `series=1` уважает `fit`.

- [ ] **Step 1: Роут** (бэкап). Импорт дополнить `tagFitting, filterByFitting, fittingSummary, FIT_VALUES`. В шапке-комментарии строка: `// &fit=all|single|fitting|size|color|mixed (20.10.2026) — разрез «одиночные / примерки» (спека 2026-10-20-buyout-fitting-design.md); fitting в ответе — сводка примерок по строкам после фильтра категорий, до фильтра fit.`

После `cats`: `const fitRaw = qp.get("fit"); const fit = FIT_VALUES.includes(fitRaw) ? fitRaw : "all";`

Series-ветка: `const rows = filterByFitting(filterByCategory(tagFitting(await loadBuyoutRows(platform, from, asOf)), cats), fit);`

Period-ветка:
```js
    const all = tagFitting(await loadBuyoutRows(platform, from, to));
    const categories = categoryFacets(all);
    const byCat = filterByCategory(all, cats);
    const fitting = fittingSummary(byCat, asOf);
    const { kpi, items } = aggregateBuyout(filterByFitting(byCat, fit), asOf);
    ...
    return NextResponse.json({ platform, from, to, asOf, cats, fit, fitting, categories, kpi, items: shown });
```

- [ ] **Step 2: График** — `BuyoutChart` принимает проп `fit` (дефолт `"all"`), в fetch добавить `&fit=${fit}`, в deps `useEffect` — `fit`.

- [ ] **Step 3: Страница** (бэкап). Константа и состояние:

```js
const FITS = [{ v: "all", l: "Все" }, { v: "single", l: "Одиночные" }, { v: "fitting", l: "Примерки" }, { v: "size", l: "Размеры" }, { v: "color", l: "Цвета" }];
// в компоненте:
const [fit, setFit] = useState("all");
```

fetch: `...&platform=${platform}&fit=${fit}${catQuery(cats)}`; `fit` в deps. В панели фильтров после `CategoryMultiSelect`: `<Segmented value={fit} options={FITS} onChange={(v) => { setFit(v); setSelected(null); setOpen(new Set()); }} />`. `<BuyoutChart ... fit={fit} />`.

В описание страницы (тот же `div` с пояснением) дописать абзац:
«Примерка — 2+ варианта одной модели (размеры и/или цвета) в одном заказе: покупатель меряет и оставляет один. «Одиночные» — честный выкуп модели. Видна только примерка внутри одного заказа: разные заказы одного человека маркетплейсы связать не дают.»

После плиток KPI (внутри `kpi ? (...)` добавить ещё плитку, если `data.fitting`):

```jsx
<Tile label={`Примерки${data.fitting.estimated ? " ⚙" : ""}`}
  value={pct(data.fitting.basketShare)}
  sub={`заказов-примерок · выкуп по заказу ${pct(data.fitting.basketBuyoutPct)}, оставляют ${data.fitting.avgKept ?? "—"} из ${data.fitting.avgVariants ?? "—"}`} />
```
`title` на обёртке плитки при `estimated`: «у части товаров нет модели из каталога — сгруппировано по названию».

Между графиком и таблицей — блок (компонент `FitSizeBlock` в том же файле), показывается, если `data?.fitting?.bySize?.length`:

```jsx
function FitSizeBlock({ list }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 14px", marginBottom: 16 }}>
      <div style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Что оставляют из примерок по размеру ({list.length})
      </div>
      {open ? (
        <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 8 }}>
          <thead><tr>
            <th style={{ ...th, textAlign: "left", cursor: "default" }}>Модель</th>
            {["Примерок", "Оставили меньший", "Оставили больший", "Средний", "Несколько", "Ничего"].map((h) => <th key={h} style={{ ...th, cursor: "default" }}>{h}</th>)}
            <th style={{ ...th, textAlign: "left", cursor: "default" }}>Комбинации</th>
          </tr></thead>
          <tbody>{list.map((m) => (
            <tr key={`${m.platform}|${m.modelKey}`}>
              <td style={{ ...td, textAlign: "left", whiteSpace: "normal" }}>
                <span style={{ fontWeight: 600, color: C.accent }}>{m.platform === "ozon" ? "Ozon" : "WB"}</span> {m.name || m.modelKey}
              </td>
              <td style={td}>{num(m.baskets)}</td><td style={td}>{num(m.keptSmallest)}</td><td style={td}>{num(m.keptLargest)}</td>
              <td style={td}>{num(m.keptMiddle)}</td><td style={td}>{num(m.keptSeveral)}</td><td style={td}>{num(m.keptNone)}</td>
              <td style={{ ...td, textAlign: "left", whiteSpace: "normal", color: C.muted }}>{m.combos.slice(0, 4).map((c) => `${c.combo} ×${c.n}`).join(" · ")}</td>
            </tr>))}</tbody>
        </table>
      ) : null}
      {open ? <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>Чаще оставляют больший — модель маломерит, меньший — большемерит. Только доехавшие заказы.</div> : null}
    </div>
  );
}
```
Хуки — в начале компонента (D7). Пустой список строк при фильтре: текст «Нет заказов за период» уже покрывает.

- [ ] **Step 4: Сборка и рестарт**

```bash
cd /opt/agents/saas && npm run build && systemctl restart saas-web && sleep 3 && \
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3200/
```
Expected: сборка без ошибок, `200`.

- [ ] **Step 5: Commit**

```bash
git add "app/api/cabinets/[id]/buyout/route.js" "app/cabinets/[id]/buyout/BuyoutPage.jsx" "app/cabinets/[id]/buyout/BuyoutChart.jsx"
git commit -m "feat(buyout): фильтр «Одиночные / Примерки», плитка и блок «что оставляют»"
```

---

### Task 5: Смоук, документация, финальная проверка

**Files:**
- Modify: `scripts/smoke-buyout.mjs` (дописать в конец, перед итоговым выходом по `failed`)
- Modify: `AGENTS.md` (раздел «Процент выкупа» в «Где что считается»)
- Modify: `docs/metrics-contract.md` (§18, новый подпункт)

- [ ] **Step 1: Смоук** — перед финальным `process.exit`/итогом добавить:

```js
// Разрез «одиночные / примерки» (20.10.2026): single + fitting = all, size + color + mixed = fitting
// по каждому счётчику KPI; дефолт fit=all совпадает с ответом без параметра.
for (const plat of ['all', 'wb', 'ozon']) {
  const g = async (fit) => (await get(`buyout?platform=${plat}&from=${from}&to=${to}&fit=${fit}`)).data;
  const [a, s, f, sz, c, m] = await Promise.all(['all', 'single', 'fitting', 'size', 'color', 'mixed'].map(g));
  const base = (await get(`buyout?platform=${plat}&from=${from}&to=${to}`)).data;
  check(`примерки ${plat}: fit=all = без параметра`, K.every((k) => a.kpi[k] === base.kpi[k]));
  const bad1 = K.filter((k) => s.kpi[k] + f.kpi[k] !== a.kpi[k]);
  check(`примерки ${plat}: одиночные + примерки = все`, bad1.length === 0, bad1);
  const bad2 = K.filter((k) => sz.kpi[k] + c.kpi[k] + m.kpi[k] !== f.kpi[k]);
  check(`примерки ${plat}: размеры + цвета + смешанные = примерки`, bad2.length === 0, bad2);
  check(`примерки ${plat}: сводка есть`, a.fitting && Number.isFinite(a.fitting.baskets), a.fitting);
  console.log(`      ${plat}: корзин-примерок ${a.fitting?.fittingBaskets} из ${a.fitting?.baskets} (${a.fitting?.basketShare} %), выкуп по заказу ${a.fitting?.basketBuyoutPct} %, ⚙ ${a.fitting?.estimated}`);
}
```

Run: `node scripts/smoke-buyout.mjs 1` → все `PASS` (включая прежние проверки «Сводка = страница»).

- [ ] **Step 2: Тесты целиком**

Run: `node --test lib/__tests__/buyout.test.mjs && /opt/agents/data-presenter-agent/.venv/bin/python worker/collectors/ozon_catalog_selftest.py` → PASS / OK.

- [ ] **Step 3: Документация**

`AGENTS.md`, в пункт «Процент выкупа» после абзаца про фильтр «Категория» дописать:
«Разрез «Одиночные / Примерки» (с 20.10.2026): `&fit=all|single|fitting|size|color|mixed`; примерка — 2+ варианта ОДНОЙ модели в одном заказе (корзина: Ozon номер заказа, WB `g_number`; модель: Ozon `ozon_products.model_id`, WB `wb_articles.imt_id`, миграция 073; цвет/размер Ozon — атрибуты 10097/10096 и 9533/4295 из `ozon_catalog`, WB — `nm_id`/`tech_size`); типы `fit_size`/`fit_color`/`fit_mixed`, сводка `fittingSummary` (доля, выкуп по заказу, «что оставляют» по размерам). Дефолт «Все» — канон и Сводка не меняются. Видна только примерка в одном заказе. Спека `docs/superpowers/specs/2026-10-20-buyout-fitting-design.md`; смоук проверяет single+fitting=all.»

`docs/metrics-contract.md` §18 — новый подпункт «18.x Разрез по примеркам (20.10.2026)» с определениями из спеки (корзина, модель, вариант, типы, выкуп по заказу = доля судимых корзин-примерок, где выкуплен ≥1 вариант; ограничение — только внутри заказа; дефолт — «Все»).

- [ ] **Step 4: Визуальная проверка** — открыть `/cabinets/1/buyout`, переключить «Одиночные / Примерки / Размеры / Цвета», раскрыть блок «Что оставляют». Убедиться, что плитки, график и таблица меняются, а при «Все» цифры совпадают с прежними.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-buyout.mjs AGENTS.md docs/metrics-contract.md
git commit -m "docs+smoke(buyout): разрез «одиночные / примерки»"
```
