// lib/purchaseNeedData.js — адаптер БД для страницы «Потребность» (lib/purchaseNeed.js).
// Все запросы — tenantQuery (RLS по cabinet_id), вызывается изнутри withCabinet; строго
// последовательно (один client на транзакцию, см. lib/warehousesData.js).
// Источники — те же, что у /stocks («Индексы OOS»), чтобы цифры совпадали:
//   остаток МП — последний снимок wb_daily_stock (quantity, in_way_from) и ozon_daily_stock
//   (fbo_present − fbo_reserved); скорость — daily_metrics.orders за N полных дней по вчера.
import { buildPurchaseNeed } from "./purchaseNeed.js";
import { normalizePositions } from "./warehousesData.js";
import { effectiveStatus, loadSupply } from "./shipmentDocs.js";

let _db = null;
async function getDb() { if (!_db) _db = await import("./db.js"); return _db; }

export async function loadPurchaseNeed({ windowDays, horizonDays, platform = "all" }) {
  const { tenantQuery } = await getDb();
  const { statusMap } = await import("./finItems.js");

  const posRows = await tenantQuery(`SELECT id, internal_name, qty, unit_cost, location_id FROM tenant.ff_inventory WHERE archived_at IS NULL ORDER BY id`);
  const skuRows = await tenantQuery(`SELECT ff_inventory_id, platform, nm_id, product_id, sku_name, im_url FROM tenant.ff_inventory_skus ORDER BY created_at, id`);

  const wbStock = await tenantQuery(
    `SELECT st.nm_id AS sku_key, st.available, st.in_way_from, a.name, a.im_url, co.cost
     FROM (SELECT nm_id, SUM(quantity)::int AS available, SUM(in_way_from)::int AS in_way_from
           FROM tenant.wb_daily_stock
           WHERE date = (SELECT MAX(date) FROM tenant.wb_daily_stock)
           GROUP BY nm_id) st
     LEFT JOIN tenant.wb_articles a ON a.nm_id = st.nm_id
     LEFT JOIN LATERAL (
       SELECT cost FROM tenant.cost_overrides
       WHERE nm_id = st.nm_id AND platform = 'wb' AND effective_from <= current_date
       ORDER BY effective_from DESC LIMIT 1
     ) co ON true`);
  const ozStock = await tenantQuery(
    `SELECT st.product_id AS sku_key, st.available, COALESCE(p.name, p.offer_id) AS name, p.offer_id, p.im_url, co.cost
     FROM (SELECT product_id, SUM(fbo_present - fbo_reserved)::int AS available
           FROM tenant.ozon_daily_stock
           WHERE date = (SELECT MAX(date) FROM tenant.ozon_daily_stock)
           GROUP BY product_id) st
     LEFT JOIN tenant.ozon_products p ON p.product_id = st.product_id
     LEFT JOIN LATERAL (
       SELECT cost FROM tenant.cost_overrides
       WHERE product_id = st.product_id AND platform = 'ozon' AND effective_from <= current_date
       ORDER BY effective_from DESC LIMIT 1
     ) co ON true`);
  // Названия артикулов, у которых нет остатка (продажи были, снимок пуст) — для строк.
  const wbNames = await tenantQuery(`SELECT nm_id AS sku_key, name, im_url FROM tenant.wb_articles`);
  const ozNames = await tenantQuery(`SELECT product_id AS sku_key, COALESCE(name, offer_id) AS name, offer_id, im_url FROM tenant.ozon_products`);

  const orders = await tenantQuery(
    `SELECT 'wb' AS platform, nm_id AS sku_key, SUM(orders)::int AS qty
     FROM tenant.wb_daily_metrics
     WHERE date >= current_date - $1::int AND date < current_date
     GROUP BY nm_id
     UNION ALL
     SELECT 'ozon', product_id, SUM(orders)::int
     FROM tenant.ozon_daily_metrics
     WHERE date >= current_date - $1::int AND date < current_date
     GROUP BY product_id`, [windowDays]);

  // В пути на МП: документы отгрузки, которые отгружены, но по факту ещё не приняты
  // (effectiveStatus — тот же, что на /shipments). Строки с уже введённым «принято» — не в пути.
  const docs = await tenantQuery(`SELECT id, platform, status, mp_supply_kind, mp_supply_id FROM tenant.ff_shipment_docs WHERE status = 'shipped'`);
  const inTransit = [];
  for (const d of docs) {
    const lines = await tenantQuery(`SELECT ff_inventory_id, qty, qty_accepted FROM tenant.ff_shipment_lines WHERE doc_id = $1`, [d.id]);
    const supply = d.mp_supply_id ? await loadSupply(tenantQuery, { kind: d.mp_supply_kind, id: d.mp_supply_id }) : null;
    if (effectiveStatus(d, lines, supply) !== "shipped") continue;
    for (const l of lines) {
      if (l.qty_accepted != null) continue;
      inTransit.push({ ff_inventory_id: Number(l.ff_inventory_id), qty: Number(l.qty) || 0, platform: d.platform });
    }
  }

  const status = await statusMap();
  const named = (rows, platform) => rows.map((r) => ({ platform, sku_key: Number(r.sku_key), available: 0, name: r.name || null, im_url: r.im_url || null, offer: r.offer_id || null }));
  const result = buildPurchaseNeed({
    positions: normalizePositions(posRows, skuRows),
    mpStock: [
      ...wbStock.map((r) => ({ platform: "wb", sku_key: Number(r.sku_key), available: Number(r.available) || 0, inWayFrom: Number(r.in_way_from) || 0, name: r.name, im_url: r.im_url, cost: r.cost == null ? null : Number(r.cost) })),
      ...ozStock.map((r) => ({ platform: "ozon", sku_key: Number(r.sku_key), available: Number(r.available) || 0, name: r.name, offer: r.offer_id || null, im_url: r.im_url, cost: r.cost == null ? null : Number(r.cost) })),
      // Нулевые записи только ради имён/фото; остаток и пустые строки не меняют.
      ...named(wbNames, "wb"), ...named(ozNames, "ozon"),
    ],
    orders: orders.map((r) => ({ platform: r.platform, sku_key: Number(r.sku_key), qty: Number(r.qty) || 0 })),
    inTransit,
    status,
    windowDays,
    horizonDays,
    platform,
  });
  const dates = await tenantQuery(`SELECT (SELECT MAX(date) FROM tenant.wb_daily_stock)::text AS wb, (SELECT MAX(date) FROM tenant.ozon_daily_stock)::text AS ozon`);
  return { ...result, stockDates: dates[0] || {} };
}
