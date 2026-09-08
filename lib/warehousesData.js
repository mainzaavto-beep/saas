// lib/warehousesData.js — адаптер БД для витрины «Склады 2.0» (спека §5). Все запросы — под
// tenantQuery (RLS по cabinet_id), вызывается изнутри withCabinet. FBO-остатки и заказы —
// через collectTargets этапа 3 (один канон покрытия), пороги — readSupplySettings.
// Импорт db.js ленивый: модуль должен импортироваться в node --test.
//
// ⚠️ Известный риск (общий долг с /supply-plan, в бэклоге — здесь НЕ чиним): readSupplySettings
// (lib/supplyPlanData.js:91) читает auth.cabinets через пул — обычный query(), а не tenantQuery,
// — значит внутри транзакции withTenant берётся ВТОРОЕ соединение на тот же запрос. Ни RLS, ни
// консистентность витрины это не ломает (auth.cabinets — не tenant-таблица, читается один раз),
// но при пиковой нагрузке удваивает потребление пула (max: 10, lib/db.js:43). Чинится переводом
// readSupplySettings на tenantQuery/передачей settings аргументом — отдельной задачей вместе с
// /supply-plan, чтобы не расщеплять источник настроек.
import { buildMatrix, buildPlaceCards, buildSignals } from "./warehousesMetrics.js";
import { collectTargets, readSupplySettings } from "./supplyPlanData.js";
import { VELOCITY_WINDOW_DAYS } from "./stockCoverage.js";

let _db = null;
async function getDb() { if (!_db) _db = await import("./db.js"); return _db; }

export function normalizePositions(rows, skuRows) {
  const skusBy = new Map();
  for (const s of skuRows) {
    const list = skusBy.get(Number(s.ff_inventory_id)) || [];
    list.push({ platform: s.platform, sku_key: s.platform === "wb" ? (s.nm_id == null ? null : Number(s.nm_id)) : (s.product_id == null ? null : Number(s.product_id)), name: s.sku_name || null, im_url: s.im_url || null });
    skusBy.set(Number(s.ff_inventory_id), list);
  }
  return rows.map((r) => ({ id: Number(r.id), internal_name: r.internal_name, qty: Number(r.qty) || 0, unit_cost: r.unit_cost == null ? null : Number(r.unit_cost),
    location_id: r.location_id == null ? null : Number(r.location_id), skus: skusBy.get(Number(r.id)) || [] }));
}

// Отменённые задания WB не считаются спросом. Список статусов — тот же, что у авто-списания
// (worker/fbs_writeoff_core.py:48, RETURNED_WB) — исполнитель сверяет и копирует.
export const WB_TASK_CANCELLED = ["canceled_by_client", "declined_by_client", "defect", "canceled"];

export async function loadWarehousesInput(cabinetId) {
  const { tenantQuery } = await getDb();
  // Один client на транзакцию (lib/db.js:171-186) — запросы строго последовательно,
  // Promise.all тут не даёт параллелизма, а маскирует порядок и риск частичного отката.
  const posRows = await tenantQuery(`SELECT id, internal_name, qty, unit_cost, location_id FROM tenant.ff_inventory WHERE archived_at IS NULL ORDER BY id`);
  const skuRows = await tenantQuery(`SELECT ff_inventory_id, platform, nm_id, product_id, sku_name, im_url FROM tenant.ff_inventory_skus ORDER BY created_at, id`);
  const locations = await tenantQuery(`SELECT id, name, address, city, loc_type, is_active, wb_warehouse_id, ozon_warehouse_id FROM tenant.stock_ff_locations ORDER BY name`);
  // location_id — к какому месту привязан склад продавца (тот же LEFT JOIN, что
  // /inventory: app/api/cabinets/[id]/inventory/route.js:55-64). LocationsManager на
  // /warehouses («⚙ Настройки мест») ждёт это поле, чтобы показать текущую привязку.
  const sellerWarehouses = await tenantQuery(`SELECT w.platform, w.warehouse_id, w.name, w.kind, w.is_active,
                        l.id AS location_id
                 FROM tenant.mp_seller_warehouses w
                 LEFT JOIN tenant.stock_ff_locations l
                   ON l.cabinet_id = w.cabinet_id
                  AND ((w.platform = 'wb' AND l.wb_warehouse_id = w.warehouse_id)
                    OR (w.platform = 'ozon' AND l.ozon_warehouse_id = w.warehouse_id))
                 ORDER BY w.platform, w.name`);
  const fbsStock = await tenantQuery(`SELECT s.platform, s.warehouse_id, s.sku_key, s.present, s.reserved
                 FROM tenant.mp_fbs_daily_stock s
                 JOIN (SELECT platform, MAX(date) AS d FROM tenant.mp_fbs_daily_stock GROUP BY 1) m
                   ON m.platform = s.platform AND m.d = s.date`);
  const fbsVelocity = await tenantQuery(`SELECT 'wb' AS platform, warehouse_id, nm_id AS sku_key, COUNT(*)::int AS orders_qty
                 FROM tenant.wb_fbs_tasks
                 WHERE warehouse_id IS NOT NULL AND nm_id IS NOT NULL
                   AND created_at >= now() - ($1 || ' days')::interval
                   AND COALESCE(wb_status, '') <> ALL($2::text[])
                 GROUP BY 1, 2, 3
                 UNION ALL
                 SELECT 'ozon', warehouse_id, product_id, SUM(qty)::int
                 FROM tenant.ozon_orders
                 WHERE scheme = 'fbs' AND warehouse_id IS NOT NULL AND product_id IS NOT NULL
                   AND COALESCE(is_cancel, 0) = 0
                   AND order_dt >= to_char(now() - ($1 || ' days')::interval, 'YYYY-MM-DD')
                 GROUP BY 1, 2, 3`, [String(VELOCITY_WINDOW_DAYS), WB_TASK_CANCELLED]);
  const gaps = await tenantQuery(`SELECT id, platform, warehouse_id, sku_key, qty, reason, src_kind, src_ref, first_seen_at
                 FROM tenant.stock_move_gaps WHERE resolved_at IS NULL ORDER BY first_seen_at`);
  const docs = await tenantQuery(`SELECT id, platform, status, shipped_at, ship_dt, dest_warehouse_id, dest_warehouse
                 FROM tenant.ff_shipment_docs WHERE status <> 'draft' ORDER BY id`);
  const settings = await readSupplySettings(cabinetId);
  const wbTargets = await collectTargets({ platform: "wb" });
  const ozTargets = await collectTargets({ platform: "ozon" });
  return {
    settings,
    positions: normalizePositions(posRows, skuRows),
    locations: locations.map((l) => ({ ...l, id: Number(l.id), wb_warehouse_id: l.wb_warehouse_id == null ? null : Number(l.wb_warehouse_id), ozon_warehouse_id: l.ozon_warehouse_id == null ? null : Number(l.ozon_warehouse_id) })),
    sellerWarehouses: sellerWarehouses.map((w) => ({ ...w, warehouse_id: Number(w.warehouse_id), location_id: w.location_id == null ? null : Number(w.location_id) })),
    fbsStock: fbsStock.map((r) => ({ platform: r.platform, warehouse_id: Number(r.warehouse_id), sku_key: Number(r.sku_key), present: Number(r.present) || 0, reserved: Number(r.reserved) || 0 })),
    fbsVelocity: fbsVelocity.map((r) => ({ platform: r.platform, warehouse_id: Number(r.warehouse_id), sku_key: Number(r.sku_key), orders_qty: Number(r.orders_qty) || 0 })),
    fboTargets: [...wbTargets, ...ozTargets],
    gaps: gaps.map((g) => ({ ...g, id: Number(g.id), warehouse_id: g.warehouse_id == null ? null : Number(g.warehouse_id), sku_key: g.sku_key == null ? null : Number(g.sku_key), qty: Number(g.qty) || 0 })),
    docs: docs.map((d) => ({ ...d, id: Number(d.id), dest_warehouse_id: d.dest_warehouse_id == null ? null : Number(d.dest_warehouse_id) })),
  };
}

export async function loadWarehouseSignals(cabinetId, now = new Date()) {
  const input = await loadWarehousesInput(cabinetId);
  const matrix = buildMatrix(input);
  return buildSignals({ matrix, gaps: input.gaps, docs: input.docs, settings: input.settings, now });
}

export { buildMatrix, buildPlaceCards, buildSignals };
