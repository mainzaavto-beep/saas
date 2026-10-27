// lib/purchaseOrdersData.js — БД заказов закупки (спека 2026-10-27-purchase-orders-design.md).
// Всё внутри withTenant (одна транзакция роута), запросы последовательно. Расчёт — lib/purchaseOrders.js.
import { tenantQuery } from "./db.js";
import { calcOrder, autoOrderStatus } from "./purchaseOrders.js";

const ORDER_COLS = `id, order_no, supplier, supplier_contact, source_country, category, note,
  order_dt::text AS order_dt, rate_cny::float8 AS rate_cny, status, archived_at::text AS archived_at,
  created_at::text AS created_at`;
const PAY_COLS = `id, order_id, kind, currency, amount::float8 AS amount, rate::float8 AS rate,
  plan_date::text AS plan_date, note`;
const LINE_COLS = `l.id, l.order_id, l.platform, l.nm_id, l.product_id, l.label, l.variant, l.qty,
  l.price_cny::float8 AS price_cny, l.weight_kg::float8 AS weight_kg, l.note, l.photo_url,
  COALESCE(l.photo_url, a.im_url, o.im_url) AS photo, o.offer_id AS article`;
const LINE_JOIN = `LEFT JOIN tenant.wb_articles a ON l.platform = 'wb' AND a.cabinet_id = l.cabinet_id AND a.nm_id = l.nm_id
  LEFT JOIN tenant.ozon_products o ON l.platform = 'ozon' AND o.cabinet_id = l.cabinet_id AND o.product_id = l.product_id`;
const SHIP_COLS = `id, order_id, shipment_no, carrier, ship_dt::text AS ship_dt, eta::text AS eta,
  arrived_dt::text AS arrived_dt, status, cargo_rub::float8 AS cargo_rub, ff_rub::float8 AS ff_rub,
  accepted_at::text AS accepted_at, note`;
const SL_COLS = `sl.id, sl.shipment_id, sl.line_id, sl.qty_shipped, sl.qty_accepted`;

export async function loadOrder(id, { lock = false } = {}) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const order = (await tenantQuery(
    `SELECT ${ORDER_COLS} FROM tenant.purchase_orders WHERE id = $1 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`, [n]))[0];
  if (!order) return null;
  const payments = await tenantQuery(
    `SELECT ${PAY_COLS} FROM tenant.purchase_order_payments WHERE order_id = $1 AND deleted_at IS NULL ORDER BY id`, [n]);
  const lines = await tenantQuery(
    `SELECT ${LINE_COLS} FROM tenant.purchase_order_lines l ${LINE_JOIN}
      WHERE l.order_id = $1 AND l.deleted_at IS NULL ORDER BY l.id`, [n]);
  const shipments = await tenantQuery(
    `SELECT ${SHIP_COLS} FROM tenant.purchase_shipments WHERE order_id = $1 AND deleted_at IS NULL ORDER BY id`, [n]);
  const shipmentLines = await tenantQuery(
    `SELECT ${SL_COLS} FROM tenant.purchase_shipment_lines sl
       JOIN tenant.purchase_shipments s ON s.cabinet_id = sl.cabinet_id AND s.id = sl.shipment_id
      WHERE s.order_id = $1 AND s.deleted_at IS NULL ORDER BY sl.id`, [n]);
  return { order, payments, lines, shipments, shipmentLines };
}

export async function loadOrderView(id) {
  const b = await loadOrder(id);
  if (!b) return null;
  const dds = await tenantQuery(
    `SELECT source_ref, status, paid_at::text AS paid_at FROM tenant.dds_movements
      WHERE source_kind = 'purchase' AND source_ref LIKE $1 AND status <> 'archived'`, [`order:${b.order.id}:%`]);
  return { ...b, calc: calcOrder(b), dds };
}

// Список: грузим всё живое разом (масштаб — десятки заказов) и считаем тем же calcOrder.
async function loadAllBundles() {
  const orders = await tenantQuery(`SELECT ${ORDER_COLS} FROM tenant.purchase_orders WHERE deleted_at IS NULL ORDER BY COALESCE(order_dt, created_at::date) DESC, id DESC`);
  const payments = await tenantQuery(`SELECT ${PAY_COLS} FROM tenant.purchase_order_payments WHERE deleted_at IS NULL`);
  const lines = await tenantQuery(`SELECT ${LINE_COLS} FROM tenant.purchase_order_lines l ${LINE_JOIN} WHERE l.deleted_at IS NULL`);
  const shipments = await tenantQuery(`SELECT ${SHIP_COLS} FROM tenant.purchase_shipments WHERE deleted_at IS NULL`);
  const shipmentLines = await tenantQuery(
    `SELECT ${SL_COLS} FROM tenant.purchase_shipment_lines sl
       JOIN tenant.purchase_shipments s ON s.cabinet_id = sl.cabinet_id AND s.id = sl.shipment_id
      WHERE s.deleted_at IS NULL`);
  const by = (rows, key) => {
    const m = new Map();
    for (const r of rows) { const k = Number(r[key]); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  };
  const P = by(payments, "order_id"), L = by(lines, "order_id"), S = by(shipments, "order_id"), SL = by(shipmentLines, "shipment_id");
  return orders.map((order) => {
    const ships = S.get(Number(order.id)) || [];
    const b = { order, payments: P.get(Number(order.id)) || [], lines: L.get(Number(order.id)) || [], shipments: ships,
      shipmentLines: ships.flatMap((s) => SL.get(Number(s.id)) || []) };
    return { ...b, calc: calcOrder(b) };
  });
}

export async function listOrders({ status = "", supplier = "", category = "", closed = false } = {}) {
  const needle = String(supplier || "").trim().toLowerCase();
  return (await loadAllBundles())
    // Фильтр «Закрыт» в селекте статусов показывает закрытые и без галочки «закрытые».
    .filter(({ order }) => (closed || status === "closed" ? true : order.status !== "closed")
      && (!status || order.status === status)
      && (!category || order.category === category)
      && (!needle || String(order.supplier || "").toLowerCase().includes(needle) || String(order.order_no || "").toLowerCase().includes(needle)))
    .map(({ order, lines, calc }) => ({
      id: Number(order.id), order_no: order.order_no, supplier: order.supplier, category: order.category,
      order_dt: order.order_dt, status: order.status, lines: lines.length, qty: calc.qty,
      totalCny: calc.totalCny, goodsRub: calc.goodsRub, totalRub: calc.totalRub, paidCny: calc.paidCny,
      shippedQty: calc.shippedQty, acceptedQty: calc.acceptedQty, shortageQty: calc.shortageQty,
      avgUnitCost: calc.qty > 0 ? calc.totalRub / calc.qty : null, photo: lines.find((l) => l.photo)?.photo || null,
    }));
}

// Оплаченные строки ДДС заказа (source_ref): суммы по ним правке не подлежат, пока в календаре
// не снята отметка «оплачено». Только чтение dds_movements — запись по-прежнему лишь через
// lib/paymentCalendarData.js.
export async function paidRefs(orderId) {
  const rows = await tenantQuery(
    `SELECT source_ref FROM tenant.dds_movements
      WHERE source_kind = 'purchase' AND source_ref LIKE $1 AND status = 'paid'`, [`order:${Number(orderId)}:%`]);
  return new Set(rows.map((r) => r.source_ref));
}

export async function refreshOrderStatus(id) {
  const b = await loadOrder(id);
  if (!b) return null;
  const next = autoOrderStatus(b.order.status, b.lines, b.shipments, b.shipmentLines);
  if (next !== b.order.status) {
    await tenantQuery(
      `UPDATE tenant.purchase_orders SET status = $2,
         archived_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`,
      [b.order.id, next]);
  }
  return next;
}

export async function lockShipment(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return (await tenantQuery(
    `SELECT ${SHIP_COLS} FROM tenant.purchase_shipments WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [n]))[0] || null;
}

// «Товар в пути» для «Баланса»: отправки status='transit', стоимость = Σ шт × себестоимость/шт.
export async function ordersInTransit() {
  const items = [];
  let total = 0;
  for (const { order, calc, shipments } of await loadAllBundles()) {
    for (const s of calc.shipments) {
      if (s.status !== "transit") continue;
      const raw = shipments.find((x) => Number(x.id) === s.id);
      const value = Math.round(s.value * 100) / 100;
      total += value;
      items.push({ id: `s${s.id}`, name: `${order.supplier} · ${order.order_no || `заказ #${order.id}`} · ${raw?.shipment_no || `отправка #${s.id}`}`,
        qty: s.qty, unit_cost: s.qty > 0 ? Math.round((s.value / s.qty) * 100) / 100 : 0, value, lifecycle: "in_transit" });
    }
  }
  return { total: Math.round(total * 100) / 100, items };
}
