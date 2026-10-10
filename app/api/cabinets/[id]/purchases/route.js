// /api/cabinets/[id]/purchases — закупки (CRUD) + Excel-формулы + lifecycle.
// Перенесено из эталона data-presenter/app/api/purchases/route.js с адаптацией
// под PostgreSQL tenant.* (RLS по cabinet_id) через tenantQuery/DatabaseSync.
import { NextResponse } from "next/server";
import { tenantQuery, DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { applyMove } from "@/lib/stockLedger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const numOr = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function sqlSafe(v, maxLen = 200) {
  if (!v) return "";
  return String(v).slice(0, maxLen).replace(/'/g, "''");
}

// =====================================================================
//  Excel-формулы «Себес товара» (считаются НА СЕРВЕРЕ из вводных полей).
//  Эталон: data-presenter/app/api/purchases/route.js:computeExcel
//    N = L × M           (Сумма аванса ₽ = предоплата¥ × курс аванса)
//    Q = O × P           (Сумма ¥ = кол-во × цена за ед ¥)
//    R = Q − L           (Остаток оплаты ¥)
//    S = M × R           (Остаток оплаты ₽ = курс АВАНСА × остаток¥)
//    V = P × U           (Цена за ед ₽)
//    W = R × U + N       (Сумма ₽ оплаченная)
//    Z = W + (X + Y) × O (ИТОГО; X и Y — ₽ ЗА ЕДИНИЦУ, ×O = за партию)
//    AA = Z / O          (Себестоимость за ед → unit_cost = W/O + X + Y)
//  L=prepay_yuan, M=prepay_rate, O=qty, P=unit_cost_yuan, U=exchange_rate,
//  X=logistics_rub_per_unit (Логист. до МСК, ₽/ед), Y=logistics_rub (Логист.
//  МСК→ФФ, ₽/ед). Решение 2026-07-15: X и Y оба «за ед» (раньше код считал
//  их «за партию» и не умножал на O → AA занижался на величину логистики).
// =====================================================================
function computeExcel(input) {
  const L = numOr(input.prepay_yuan) || 0;
  const M = numOr(input.prepay_rate) || 0;
  const O = numOr(input.qty);
  const P = numOr(input.unit_cost_yuan) || 0;
  const U = numOr(input.exchange_rate) || 0;
  const X = numOr(input.logistics_rub_per_unit) || 0;
  const Y = numOr(input.logistics_rub) || 0;
  const hasQty = O != null && O > 0;
  const N = L * M;
  const Q = hasQty ? O * P : null;
  const R = hasQty ? (Q - L) : -L;
  const S = M * R;
  const V = hasQty ? P * U : null;
  const W = R * U + N;
  // X и Y — за единицу; за партию = (X+Y)×O.
  const Z = hasQty ? W + (X + Y) * O : W + X + Y;
  const unitCost = hasQty ? Z / O : null;
  return {
    N: round2(N), Q: hasQty ? round2(Q) : null, R: round2(R), S: round2(S),
    V: hasQty ? round2(V) : null, W: round2(W), Z: round2(Z),
    unitCost: unitCost != null ? round2(unitCost) : null,
  };
}

// Эффективный lifecycle_status (NULL → arrived если есть delivery_dt, иначе planned).
function lifecycleEffective(row) {
  if (row.lifecycle_status) return row.lifecycle_status;
  return row.delivery_dt ? "arrived" : "planned";
}

const SELECT_COLS = `id, nm_id, supplier_name, qty, unit_cost, date,
  unit_cost_yuan, exchange_rate, logistics_yuan, logistics_rub,
  order_dt, delivery_dt, status, source, supplier,
  order_no, unit_cost_est, total_amount,
  plan_order_dt, plan_ship_dt, plan_arrival_dt, lifecycle_status,
  photo_url, source_country, ship_dt,
  prepay_yuan, prepay_rate, logistics_rub_per_unit, pay_status, category`;

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const fromQ = url.searchParams.get("from") || "";
  const toQ = url.searchParams.get("to") || "";
  const supplierQ = url.searchParams.get("supplier") || "";
  const vendorQ = url.searchParams.get("vendor") || "";
  const statusQ = url.searchParams.get("status") || "";
  const categoryQ = url.searchParams.get("category") || "";
  const qQ = url.searchParams.get("q") || "";
  const archivedQ = url.searchParams.get("archived") || "";

  // Условия фильтров как [sql-фрагмент, [params...], tag].
  // tag нужен, чтобы facet-запросы могли исключить фильтр по СВОЕМУ полю
  // (чтобы count в выпадающем списке был осмысленным), корректно пересобрав
  // нумерацию $N и массив params под оставшиеся условия.
  // Раньше тут был баг (инцидент 2026-07-15): facet-запросы собирали WHERE из
  // строк с уже-пронумерованными $1..$N, но выполнялись БЕЗ params → при
  // комбинации 2+ фильтров падало «there is no parameter $1» и весь GET отдавал 0.
  // archived: по умолчанию (без ?archived=1) показываем только активные закупки
  // (завершённые→склад скрыты). ?archived=1 — показать архивные.
  const base = ["deleted_at IS NULL", archivedQ === "1" ? "archived = true" : "archived = false"];
  const filters = [];
  if (fromQ && /^\d{4}-\d{2}$/.test(fromQ)) filters.push(["COALESCE(delivery_dt, order_dt, date) >= ?", [fromQ], "date"]);
  if (toQ && /^\d{4}-\d{2}$/.test(toQ)) filters.push(["COALESCE(delivery_dt, order_dt, date) <= ?", [toQ], "date"]);
  if (supplierQ) filters.push(["supplier_name = ?", [supplierQ], "supplier"]);
  if (vendorQ === "__null__") filters.push(["(supplier IS NULL OR supplier = '')", [], "vendor"]);
  else if (vendorQ) filters.push(["supplier = ?", [vendorQ], "vendor"]);
  if (statusQ === "__null__") filters.push(["status IS NULL", [], "status"]);
  else if (statusQ) filters.push(["status = ?", [statusQ], "status"]);
  if (categoryQ === "__null__") filters.push(["category IS NULL", [], "category"]);
  else if (categoryQ) filters.push(["category = ?", [categoryQ], "category"]);
  if (qQ) filters.push(["(supplier_name ILIKE ? OR CAST(nm_id AS TEXT) ILIKE ? OR order_no ILIKE ?)", [`%${qQ}%`, `%${qQ}%`, `%${qQ}%`], "q"]);

  // Сборка WHERE с пронумерованными $N из активных условий + matching params.
  // Каждое условие может содержать несколько '?' (напр. qQ → 3 ILIKE). params
  // и нумерация $N собираются параллельно, в порядке условий.
  function buildWhere(excludeTag) {
    const use = filters.filter((f) => f[2] !== excludeTag);
    const conds = [...base, ...use.map((f) => f[0])];
    const params = [];
    const sqlParts = conds.map((cond) =>
      cond.replace(/\?/g, () => `$${params.push(undefined)}`)  // счётчик через длину
    );
    // params сейчас = массив undefined нужной длины; реальные значения в порядке условий.
    const realVals = [];
    for (const f of use) realVals.push(...f[1]);
    // realVals.length должен совпадать с кол-вом '?' (и undefined в params).
    return { sql: sqlParts.join(" AND "), params: realVals };
  }

  const mainWhere = buildWhere(null);
  const items = await tenantQuery(
    `SELECT ${SELECT_COLS} FROM tenant.purchases WHERE ${mainWhere.sql}
     ORDER BY COALESCE(delivery_dt, order_dt, date) DESC NULLS LAST, supplier_name`,
    mainWhere.params
  );

  // Фасеты: исключаем фильтр по своему полю → count по всем остальным активным фильтрам.
  const wSup = buildWhere("supplier");
  const wVendor = buildWhere("vendor");
  const wStat = buildWhere("status");
  const wCat = buildWhere("category");
  const suppliers = await tenantQuery(
    `SELECT supplier_name, COUNT(*) AS n FROM tenant.purchases WHERE ${wSup.sql} GROUP BY supplier_name ORDER BY n DESC`,
    wSup.params
  );
  const vendors = await tenantQuery(
    `SELECT COALESCE(supplier, '') AS v, COUNT(*) AS n FROM tenant.purchases WHERE ${wVendor.sql} GROUP BY 1 ORDER BY n DESC`,
    wVendor.params
  );
  const statuses = await tenantQuery(
    `SELECT COALESCE(status, '') AS s, COUNT(*) AS n FROM tenant.purchases WHERE ${wStat.sql} GROUP BY 1 ORDER BY n DESC`,
    wStat.params
  );
  const categories = await tenantQuery(
    `SELECT COALESCE(category, '') AS c, COUNT(*) AS n FROM tenant.purchases WHERE ${wCat.sql} GROUP BY 1 ORDER BY n DESC`,
    wCat.params
  );

  // Метаданные nm_id (фото/имя) из tenant.wb_articles.
  const nmMeta = {};
  const nmIds = [...new Set(items.map((i) => i.nm_id).filter(Boolean))];
  if (nmIds.length) {
    try {
      const db = new DatabaseSync("wb", { readOnly: true });
      const placeholders = nmIds.map((_, i) => `?`).join(",");
      const metaRows = await db.prepare(`SELECT nm_id, name, im_url FROM articles WHERE nm_id IN (${placeholders})`).all(...nmIds);
      for (const m of metaRows) nmMeta[m.nm_id] = { name: m.name, im_url: m.im_url };
    } catch {}
  }

  // Итоги: costTotal = Σ(Z), avgCost = взвешенная по qty себестоимость.
  let parties = 0, qtyTotal = 0, costTotal = 0, logRubTotal = 0, hasNm = 0;
  let costByUnit = 0;
  for (const it of items) {
    const f = computeExcel(it);
    parties++;
    qtyTotal += numOr(it.qty) || 0;
    costTotal += f.Z || 0;
    logRubTotal += numOr(it.logistics_rub) || 0;
    costByUnit += (numOr(it.qty) || 0) * (f.unitCost || 0);
    if (it.nm_id != null) hasNm++;
  }
  const totals = {
    parties,
    qty: qtyTotal,
    costTotal: round2(costTotal),
    avgCost: qtyTotal > 0 ? round2(costByUnit / qtyTotal) : 0,
    logisticsRubTotal: round2(logRubTotal),
    hasNm,
  };

  // Обогатить items: формульные поля Excel + метаданные + lifecycle + balance_due.
  const enriched = items.map((it) => {
    const meta = it.nm_id != null ? (nmMeta[it.nm_id] || {}) : {};
    const f = computeExcel(it);
    const balanceDue = it.pay_status === "paid" ? 0 : (f.S ?? 0);
    return {
      ...it,
      // Перезаписываем unit_cost формульным значением (на случай рассинхрона).
      unit_cost: f.unitCost,
      calc_N: f.N, calc_Q: f.Q, calc_R: f.R, calc_S: f.S,
      calc_V: f.V, calc_W: f.W, calc_Z: f.Z,
      calc_balance_due: round2(balanceDue),
      im_url: it.photo_url || meta.im_url || null,
      wb_name: meta.name || null,
      lifecycle_effective: lifecycleEffective(it),
    };
  });

  return NextResponse.json({ items: enriched, totals, facets: { suppliers, vendors, statuses, categories } });
});

export const POST = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json();
  // Автор движения остатка (stock_moves.created_by).
  const userId = session?.user_id ?? null;

  // Завершить закупку → скопировать партию в склад (ff_inventory) + archived=true.
  // Маршрут: закупка → «Завершить → склад» → товар в остатках склада (скрыт из
  // активных закупок). Себестоимость AA = «себест. до МП».
  if (b.action === "complete_to_stock") {
    if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const cur = (await tenantQuery(
      `SELECT id, supplier_name, qty, unit_cost, category, nm_id, delivery_dt, archived,
              prepay_yuan, prepay_rate, unit_cost_yuan, exchange_rate,
              logistics_yuan, logistics_rub, logistics_rub_per_unit
       FROM tenant.purchases WHERE id = $1 AND deleted_at IS NULL`, [Number(b.id)]
    ))[0];
    if (!cur) return NextResponse.json({ error: `партия id=${b.id} не найдена` }, { status: 404 });
    if (cur.archived) return NextResponse.json({ error: "партия уже завершена" }, { status: 400 });

    const f = computeExcel(cur);
    const unitCost = f.unitCost;
    const completedAt = cur.delivery_dt || new Date().toISOString().slice(0, 10);

    // (а) пометить закупку архивной
    await tenantQuery(`UPDATE tenant.purchases SET archived = true WHERE id = $1`, [Number(b.id)]);
    // (б) копировать в склад (idempotent: если уже есть строка с этим purchase_id — не дублируем)
    const exists = await tenantQuery(
      `SELECT id FROM tenant.ff_inventory WHERE purchase_id = $1 AND archived_at IS NULL`, [Number(b.id)]
    );
    let invId;
    if (exists.length) {
      invId = exists[0].id;
    } else {
      // С 2026-07-18 НЕ пишем nm_id в ff_inventory (legacy-колонка, источник правды —
      // ff_inventory_skus). Колонку оставили в INSERT ради back-compat, но значение null;
      // привязку артикула создаём отдельным INSERT ниже (если есть nm_id закупки).
      const ins = await tenantQuery(
        `INSERT INTO tenant.ff_inventory
           (cabinet_id, purchase_id, internal_name, qty, unit_cost, category, nm_id, completed_at)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, 0, $3, $4, NULL, $5) RETURNING id`,
        [Number(b.id), cur.supplier_name, unitCost, cur.category || null, completedAt]
      );
      invId = ins[0]?.id;
    }
    // (б2) количество приходит движением «in» из журнала (единственный путь к qty).
    // Идемпотентно: повторное завершение той же закупки — duplicate, qty не удваивается.
    const qtyIn = Math.round(Number(cur.qty) || 0);
    if (invId && qtyIn > 0) {
      await applyMove({ ffInventoryId: invId, kind: "in", qty: qtyIn, srcKind: "purchase",
        srcRef: String(b.id), movedAt: completedAt, note: `закупка ${cur.supplier_name || ""}`.trim(), userId });
    }
    // (в) если у закупки был nm_id (WB) — создаём привязку в ff_inventory_skus
    // (мультисвязка с 2026-07-18: именно эта таблица — источник правды для артикулов).
    // Идемпотентно (ON CONFLICT) — повторное завершение не дублирует. Имя/фото тянем
    // из каталога wb.articles, если карточка там есть; иначе привязка без кэша
    // (имя/фото подтянутся при GET из того же каталога).
    const nmId = cur.nm_id != null ? Number(cur.nm_id) : null;
    if (invId && nmId && Number.isFinite(nmId) && nmId > 0) {
      let skuName = null, imUrl = null;
      try {
        const db = new DatabaseSync("wb", { readOnly: true });
        const m = await db.prepare(`SELECT name, im_url FROM articles WHERE nm_id = ?`).get(nmId);
        if (m) { skuName = m.name; imUrl = m.im_url; }
      } catch {}
      await tenantQuery(
        `INSERT INTO tenant.ff_inventory_skus
           (cabinet_id, ff_inventory_id, platform, nm_id, sku_name, im_url)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, 'wb', $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [invId, nmId, skuName, imUrl]
      );
    }
    return NextResponse.json({ ok: true, inventory_id: invId, unit_cost: unitCost });
  }

  if (b.id) {
    // UPDATE — PATCH-семантика (merge поверх текущей строки).
    const cur = (await tenantQuery(`SELECT * FROM tenant.purchases WHERE id = $1 AND deleted_at IS NULL`, [Number(b.id)]))[0];
    if (!cur) return NextResponse.json({ error: `партия id=${b.id} не найдена` }, { status: 404 });

    const M = (field) => (b[field] !== undefined ? b[field] : cur[field]);
    // Пересчёт AA из merged-значений по формулам Excel.
    const calcM = computeExcel({
      prepay_yuan: M("prepay_yuan"), prepay_rate: M("prepay_rate"), qty: M("qty"),
      unit_cost_yuan: M("unit_cost_yuan"), exchange_rate: M("exchange_rate"),
      logistics_rub_per_unit: M("logistics_rub_per_unit"), logistics_rub: M("logistics_rub"),
    });
    const unitCost = calcM.unitCost;

    // Подхват даты доставки при переводе на этап «arrived»:
    // если frontend явно не прислал delivery_dt и в строке его ещё нет —
    // ставим сегодняшнюю дату. (Решение 2026-07-15; arrived → delivery_dt = сегодня.)
    if (b.lifecycle_status === "arrived" && b.delivery_dt === undefined && !cur.delivery_dt) {
      b.delivery_dt = new Date().toISOString().slice(0, 10);
    }

    const sets = [];
    const vals = [];
    for (const k of ["nm_id","supplier_name","date","supplier","order_dt","delivery_dt",
      "status","order_no","unit_cost_est","total_amount","plan_order_dt","plan_ship_dt",
      "plan_arrival_dt","lifecycle_status","photo_url","source_country","ship_dt",
      "prepay_yuan","prepay_rate","unit_cost_yuan","logistics_yuan","exchange_rate",
      "logistics_rub_per_unit","logistics_rub","pay_status","note","category"]) {
      if (b[k] !== undefined) { sets.push(`${k} = $${sets.length + 1}`); vals.push(b[k] === "" ? null : b[k]); }
    }
    // qty + unit_cost (формульный) всегда пересчитываем.
    if (b.qty !== undefined) { sets.push(`qty = $${sets.length + 1}`); vals.push(b.qty); }
    sets.push(`unit_cost = $${sets.length + 1}`); vals.push(unitCost);

    if (sets.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    vals.push(Number(b.id));
    await tenantQuery(`UPDATE tenant.purchases SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    return NextResponse.json({ ok: true, id: Number(b.id), unit_cost: unitCost });
  }

  // INSERT
  const calc = computeExcel(b);
  const cols = ["cabinet_id"];
  const ph = ["current_setting('app.cabinet_id')::bigint"];
  const vals = [];
  for (const k of ["nm_id","supplier_name","qty","date","supplier","order_dt","delivery_dt",
    "status","order_no","unit_cost_est","total_amount","plan_order_dt","plan_ship_dt",
    "plan_arrival_dt","lifecycle_status","photo_url","source_country","ship_dt",
    "prepay_yuan","prepay_rate","unit_cost_yuan","logistics_yuan","exchange_rate",
    "logistics_rub_per_unit","logistics_rub","pay_status","note","category"]) {
    if (b[k] !== undefined) {
      cols.push(k);
      vals.push(b[k] === "" ? null : b[k]);
      ph.push(`$${ph.length}`);
    }
  }
  // unit_cost — формульный.
  cols.push("unit_cost"); ph.push(`$${ph.length}`); vals.push(calc.unitCost);

  const rows = await tenantQuery(
    `INSERT INTO tenant.purchases (${cols.join(",")}) VALUES (${ph.join(",")}) RETURNING id`,
    vals
  );
  return NextResponse.json({ ok: true, id: rows[0]?.id, unit_cost: calc.unitCost });
}, { requireRole: 'manager' });

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await tenantQuery(`UPDATE tenant.purchases SET deleted_at = now() WHERE id = $1`, [Number(id)]);
  return NextResponse.json({ ok: true });
}, { requireRole: 'manager' });
