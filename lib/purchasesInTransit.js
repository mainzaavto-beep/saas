// lib/purchasesInTransit.js — «Товар в пути» из tenant.purchases (PG+RLS).
//
// «В пути» = активные (не archived) закупки с lifecycle_status ∈ {shipped, in_transit}
// + отправки заказов (`purchase_shipments.status='transit'`), стоимость = Σ шт × себестоимость/шт.
// Стоимость партии = qty × unit_cost (как на странице закупок и склада/ФФ).
//
// ⚠ Раньше фильтр был WHERE deleted_at IS NULL — но колонка archived (boolean)
// это актуальный маркер «завершено→склад» (маршрут закупка→склад, миграция 014).
// 37 партий без lifecycle_status НЕ входят в «в пути» (неопределённый этап —
// отдельная задача проставить им lifecycle).
import { tenantQuery } from "./db.js";
import { ordersInTransit } from "./purchaseOrdersData.js";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export async function purchasesInTransit() {
  const rows = await tenantQuery(
    `SELECT id, supplier_name, qty, unit_cost, unit_cost_est, lifecycle_status
     FROM tenant.purchases
     WHERE archived IS NOT TRUE
       AND lifecycle_status IN ('shipped', 'in_transit')`
  );
  const items = [];
  let total = 0;
  for (const r of rows) {
    const ls = r.lifecycle_status;
    const uc = Number(r.unit_cost) || Number(r.unit_cost_est) || 0;
    const qty = Number(r.qty) || 0;
    const value = round2(qty * uc);
    total += value;
    items.push({ id: r.id, name: r.supplier_name || `#${r.id}`, qty, unit_cost: round2(uc), value, lifecycle: ls });
  }
  // Отправки заказов закупки в пути (спека 2026-10-27-purchase-orders-design.md §5).
  const ord = await ordersInTransit();
  for (const it of ord.items) items.push(it);
  total += ord.total;
  return { total: round2(total), count: items.length, items };
}
