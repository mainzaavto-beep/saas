import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// =====================================================================
//  /api/mp-stock — раздел «Товары → Остатки на маркетплейсе».
//
//  Объединяет остатки ОБЩИХ контуров WB и Ozon в один список с полем
//  platform ('wb'|'ozon'). Схемы остатков различаются, поэтому каждое МП
//  приводится к единому формату:
//    • quantity      — доступно к продаже (WB: quantity; Ozon: fbo_present − fbo_reserved)
//    • quantity_full — полный остаток (WB: quantity_full; Ozon: fbo_present)
//    • in_way_to/from — в пути (WB есть; у Ozon FBO = 0)
//    • cost          — себестоимость за ЕД. из cogs (WB: cogs.cost по nm_id; Ozon: по product_id)
//    • price         — цена реализации (WB: daily_metrics.price; Ozon: products.price, если есть)
//    • category      — WB: articles.subject; Ozon: products.category (часто NULL, задача #30)
//
//  Totals считаются: общий (по всем МП) + по каждому МП отдельно (для
//  переключателя «Все / WB / Ozon»). по-складам — только WB (у Ozon складская
//  детализация в daily_stock есть, но складов мало — показываем в общем блоке).
// =====================================================================

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;




export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const qp = req ? new URL(req.url).searchParams : null;
    const dateParam = qp && qp.get("date") && ISO_DATE.test(qp.get("date")) ? qp.get("date") : null;

    const wb = await collectWB(dateParam);
    const oz = await collectOzon(dateParam);
    const items = [...wb.items, ...oz.items];
    const categories = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();

    return NextResponse.json({
      date: wb.date || oz.date || null,
      dateWb: wb.date,
      dateOzon: oz.date,
      totals: aggAll(items),
      totalsWb: aggAll(wb.items),
      totalsOzon: aggAll(oz.items),
      byWarehouse: wb.byWarehouse, // только у WB есть содержательная складская разбивка
      byWarehouseOzon: oz.byWarehouse,
      items,
      categories,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});

// ---------- Общая агрегация по списку items ----------
function aggAll(items) {
  const t = { items: 0, quantity: 0, quantityFull: 0, inWayTo: 0, inWayFrom: 0, valueCost: 0, valueRetail: 0, noCogs: 0 };
  for (const it of items) {
    t.items += 1;
    t.quantity += it.quantity || 0;
    t.quantityFull += it.quantity_full || 0;
    t.inWayTo += it.in_way_to || 0;
    t.inWayFrom += it.in_way_from || 0;
    t.valueCost += it.value_cost || 0;
    t.valueRetail += it.value_retail || 0;
    if (!(it.cost > 0)) t.noCogs += 1;
  }
  return t;
}

// ---------- WB ----------
// dateParam: если передан (YYYY-MM-DD) — берём ближайшую дату <= dateParam (как
// баланс грузит ближайший снапшот). Иначе — MAX(date) (поведение по умолчанию).
async function resolveStockDate(db, dateParam) {
  if (dateParam) {
    const r = await db.prepare("SELECT MAX(date) AS d FROM daily_stock WHERE date <= ?").get(dateParam);
    if (r?.d) return r.d;
  }
  return await db.prepare("SELECT MAX(date) AS d FROM daily_stock").get()?.d || null;
}

async function collectWB(dateParam) {
  const db = new DatabaseSync("wb", { readOnly: true });
  const date = await resolveStockDate(db, dateParam);
  if (!date) return { date: null, items: [], byWarehouse: [] };

  const items = await db.prepare(
    `SELECT st.nm_id AS sku,
            COALESCE(a.name, CAST(st.nm_id AS TEXT)) AS name,
            COALESCE(a.brand, '') AS brand,
            COALESCE(a.subject, '') AS category,
            st.quantity,
            st.quantity_full,
            st.in_way_to,
            st.in_way_from,
            COALESCE(c.cost, 0) AS cost,
            ROUND(st.quantity_full * COALESCE(c.cost, 0), 2) AS value_cost,
            COALESCE(m.price, 0) AS price,
            ROUND(st.quantity_full * COALESCE(m.price, 0), 2) AS value_retail
     FROM (
       SELECT nm_id,
              SUM(quantity)      AS quantity,
              SUM(quantity_full) AS quantity_full,
              SUM(in_way_to)     AS in_way_to,
              SUM(in_way_from)   AS in_way_from
       FROM daily_stock WHERE date = ? GROUP BY nm_id
     ) st
     LEFT JOIN articles a ON a.nm_id = st.nm_id
     LEFT JOIN cogs c     ON c.nm_id = st.nm_id
     LEFT JOIN (
       SELECT nm_id, price FROM daily_metrics
       WHERE date = (SELECT MAX(date) FROM daily_metrics)
     ) m ON m.nm_id = st.nm_id
     ORDER BY value_cost DESC`
  ).all(date).map((it) => ({ ...it, platform: "wb", article: String(it.sku) }));

  const byWarehouse = await db.prepare(
    `SELECT warehouse,
            SUM(quantity)      AS quantity,
            SUM(quantity_full) AS quantity_full,
            COUNT(DISTINCT nm_id) AS items
     FROM daily_stock WHERE date = ?
     GROUP BY warehouse ORDER BY quantity DESC LIMIT 20`
  ).all(date);

  return { date, items, byWarehouse };
}

// ---------- Ozon (FBO) ----------
// Схема Ozon: fbo_present (всего на складе), fbo_reserved (зарезервировано под заказы).
// available = fbo_present − fbo_reserved (то, что реально доступно к продаже).
// «в пути» у FBO нет — 0. Себестоимость из cogs по product_id. Цена — из products.price
// (если ozon-agent уже наполнил; №21), иначе 0 → value_retail = 0.
async function collectOzon(dateParam) {
  const db = new DatabaseSync("ozon", { readOnly: true });
  const date = await resolveStockDate(db, dateParam);
  if (!date) return { date: null, items: [], byWarehouse: [] };

  const items = await db.prepare(
    `SELECT st.product_id AS sku,
            COALESCE(MAX(p.name), MAX(p.offer_id), CAST(st.product_id AS TEXT)) AS name,
            COALESCE(MAX(p.brand), '') AS brand,
            COALESCE(MAX(p.category), '') AS category,
            MAX(p.offer_id) AS offer_id,
            st.fbo_present,
            st.fbo_reserved,
            (st.fbo_present - st.fbo_reserved) AS quantity,
            st.fbo_present AS quantity_full,
            0 AS in_way_to,
            0 AS in_way_from,
            COALESCE(MAX(c.cost), 0) AS cost,
            ROUND(st.fbo_present * COALESCE(MAX(c.cost), 0), 2) AS value_cost,
            COALESCE(MAX(p.price), 0) AS price,
            ROUND(st.fbo_present * COALESCE(MAX(p.price), 0), 2) AS value_retail
     FROM (
       SELECT product_id,
              SUM(fbo_present)  AS fbo_present,
              SUM(fbo_reserved) AS fbo_reserved
       FROM daily_stock WHERE date = ? GROUP BY product_id
     ) st
     LEFT JOIN products p ON p.product_id = st.product_id
     LEFT JOIN cogs c     ON c.product_id = st.product_id
     GROUP BY st.product_id, st.fbo_present, st.fbo_reserved
     ORDER BY value_cost DESC`
  ).all(date).map((it) => ({
    ...it,
    platform: "ozon",
    article: it.offer_id || String(it.sku),
  }));

  // Складская разбивка Ozon (складов мало, но покажем все).
  const byWarehouse = await db.prepare(
    `SELECT warehouse,
            SUM(fbo_present - fbo_reserved) AS quantity,
            SUM(fbo_present) AS quantity_full,
            COUNT(DISTINCT product_id) AS items
     FROM daily_stock WHERE date = ?
     GROUP BY warehouse ORDER BY quantity DESC`
  ).all(date);

  return { date, items, byWarehouse };
}
