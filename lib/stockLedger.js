// lib/stockLedger.js — журнал движений остатка (спека «Склады 2.0» §3.3).
// ЕДИНСТВЕННОЕ место в панели, где меняется tenant.ff_inventory.qty. Работает
// внутри транзакции withTenant (tenantQuery): при throw вся операция роута откатывается.
// Контракт с worker/stock_ledger.py: тот же уникальный индекс stock_moves_src_uq —
// повторное движение с тем же (src_kind, src_ref, kind) = no-op {duplicate:true}.
import { tenantQuery } from "@/lib/db.js";
import { normalizeMove } from "@/lib/stockMoves.js";

export async function applyMove(input) {
  const n = normalizeMove(input);
  if (!n.ok) throw new Error(`stock move: ${n.error}`);
  const m = n.move;
  const row = (await tenantQuery(
    `SELECT id, qty, location_id FROM tenant.ff_inventory WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
    [m.ffInventoryId]
  ))[0];
  if (!row) throw new Error(`not found: ff_inventory_id=${m.ffInventoryId}`);
  const ins = await tenantQuery(
    `INSERT INTO tenant.stock_moves
       (cabinet_id, ff_inventory_id, location_id, kind, qty, src_kind, src_ref, moved_at, note, created_by)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (cabinet_id, src_kind, src_ref, kind) DO NOTHING
     RETURNING id`,
    [m.ffInventoryId, row.location_id, m.kind, m.qty, m.srcKind, m.srcRef, m.movedAt, m.note, m.userId]
  );
  if (!ins.length) return { applied: false, duplicate: true };
  const upd = await tenantQuery(
    `UPDATE tenant.ff_inventory SET qty = qty + $1, updated_at = now()
     WHERE id = $2 AND ($3 OR qty + $1 >= 0)
     RETURNING qty`,
    [m.qty, m.ffInventoryId, m.kind === "adjust"]
  );
  if (!upd.length) throw new Error(`insufficient: ff_inventory_id=${m.ffInventoryId}`);
  return { applied: true, id: ins[0].id, newQty: upd[0].qty };
}

// Перемещение одной строки документа ФФ→ФФ: transfer_out у источника + transfer_in у
// приёмника. Приёмник — активная позиция на месте назначения с тем же internal_name и
// unit_cost; нет — создаётся копия строки с qty=0 и теми же привязками артикулов.
export async function applyTransfer({ ffInventoryId, toLocationId, qty, docId, lineNo, movedAt, userId }) {
  const src = (await tenantQuery(
    `SELECT id, internal_name, unit_cost, category, im_url, completed_at, location_id
     FROM tenant.ff_inventory WHERE id = $1 AND archived_at IS NULL`, [ffInventoryId]
  ))[0];
  if (!src) throw new Error(`not found: ff_inventory_id=${ffInventoryId}`);
  let dst = (await tenantQuery(
    `SELECT id FROM tenant.ff_inventory
     WHERE archived_at IS NULL AND location_id = $1 AND id <> $2
       AND internal_name IS NOT DISTINCT FROM $3 AND unit_cost IS NOT DISTINCT FROM $4
     ORDER BY id LIMIT 1`,
    [toLocationId, src.id, src.internal_name, src.unit_cost]
  ))[0];
  if (!dst) {
    dst = (await tenantQuery(
      `INSERT INTO tenant.ff_inventory
         (cabinet_id, purchase_id, internal_name, qty, unit_cost, category, im_url, completed_at, location_id)
       VALUES (current_setting('app.cabinet_id')::bigint, NULL, $1, 0, $2, $3, $4, $5, $6) RETURNING id`,
      [src.internal_name, src.unit_cost, src.category, src.im_url, src.completed_at, toLocationId]
    ))[0];
    await tenantQuery(
      `INSERT INTO tenant.ff_inventory_skus (cabinet_id, ff_inventory_id, platform, nm_id, product_id, sku_name, im_url)
       SELECT cabinet_id, $1, platform, nm_id, product_id, sku_name, im_url
       FROM tenant.ff_inventory_skus WHERE ff_inventory_id = $2
       ON CONFLICT DO NOTHING`,
      [dst.id, src.id]
    );
  }
  const ref = `${docId}:${lineNo}`;
  await applyMove({ ffInventoryId: src.id, kind: "transfer_out", qty, srcKind: "transfer_doc", srcRef: ref, movedAt, userId });
  await applyMove({ ffInventoryId: dst.id, kind: "transfer_in", qty, srcKind: "transfer_doc", srcRef: ref, movedAt, userId });
  return { toFfInventoryId: dst.id };
}
