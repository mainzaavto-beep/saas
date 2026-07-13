// lib/purchasesInTransit.js — «Товар в пути» из tenant.purchases (PG+RLS).
import { tenantQuery } from "./db.js";

const IN_TRANSIT_STATES = new Set(["shipped", "in_transit"]);
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function lifecycleEffective(row) {
  if (row.lifecycle_status) return row.lifecycle_status;
  return row.delivery_dt ? "arrived" : "planned";
}

export async function purchasesInTransit() {
  const rows = await tenantQuery(
    `SELECT id, supplier_name, qty, unit_cost, unit_cost_est,
            lifecycle_status, delivery_dt
     FROM tenant.purchases WHERE deleted_at IS NULL`
  );
  const items = [];
  let total = 0;
  for (const r of rows) {
    const ls = lifecycleEffective(r);
    if (!IN_TRANSIT_STATES.has(ls)) continue;
    const uc = Number(r.unit_cost) || Number(r.unit_cost_est) || 0;
    const qty = Number(r.qty) || 0;
    const value = round2(qty * uc);
    total += value;
    items.push({ id: r.id, name: r.supplier_name || `#${r.id}`, qty, unit_cost: round2(uc), value, lifecycle: ls });
  }
  return { total: round2(total), count: items.length, items };
}
