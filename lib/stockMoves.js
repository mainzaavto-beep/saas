// lib/stockMoves.js — чистые правила движения остатка (спека «Склады 2.0» §3.2).
// Никакой БД: только нормализация входа для applyMove/applyTransfer (lib/stockLedger.js)
// и роутов. Знак qty задаётся kind'ом, кроме adjust (ручная корректировка со знаком).
export const KINDS = ["in", "out_fbo", "out_fbs", "transfer_out", "transfer_in", "adjust", "return_in"];
export const SRC_KINDS = ["purchase", "ff_shipment_doc", "wb_fbs_task", "ozon_posting", "transfer_doc", "manual", "wb_fbs_return", "ozon_return"];
export const SIGN = { in: 1, return_in: 1, transfer_in: 1, out_fbo: -1, out_fbs: -1, transfer_out: -1, adjust: 0 };

const posInt = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

export function normalizeMove(input) {
  const ffInventoryId = Number(input.ffInventoryId);
  if (!posInt(ffInventoryId)) return { ok: false, error: "ffInventoryId must be a positive integer" };
  const kind = String(input.kind || "");
  if (!KINDS.includes(kind)) return { ok: false, error: `unknown kind: ${kind}` };
  const srcKind = String(input.srcKind || "");
  if (!SRC_KINDS.includes(srcKind)) return { ok: false, error: `unknown srcKind: ${srcKind}` };
  const srcRef = String(input.srcRef ?? "").trim();
  if (!srcRef) return { ok: false, error: "srcRef required" };
  const raw = Number(input.qty);
  if (!Number.isInteger(raw)) return { ok: false, error: "qty must be an integer" };
  let qty;
  const note = input.note == null ? null : String(input.note).trim() || null;
  if (kind === "adjust") {
    if (raw === 0) return { ok: false, error: "adjust: qty must be a non-zero integer" };
    if (!note) return { ok: false, error: "adjust: note required" };
    qty = raw;
  } else {
    if (raw <= 0) return { ok: false, error: `${kind}: qty must be a positive integer` };
    qty = raw * SIGN[kind];
  }
  const movedAt = input.movedAt ? String(input.movedAt) : new Date().toISOString();
  const userId = input.userId == null ? null : Number(input.userId);
  return { ok: true, move: { ffInventoryId, kind, qty, srcKind, srcRef, movedAt, note, userId } };
}

export function normalizeTransferDoc(body) {
  const fromLocationId = Number(body.from_location_id);
  const toLocationId = Number(body.to_location_id);
  if (!posInt(fromLocationId) || !posInt(toLocationId)) return { ok: false, error: "from_location_id and to_location_id required" };
  if (fromLocationId === toLocationId) return { ok: false, error: "from and to locations must differ" };
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) return { ok: false, error: "нужна хотя бы одна строка товара" };
  const seen = new Set();
  const norm = [];
  for (const [i, ln] of lines.entries()) {
    const ffInventoryId = Number(ln.ff_inventory_id);
    const qty = Number(ln.qty);
    if (!posInt(ffInventoryId)) return { ok: false, error: `строка ${i + 1}: ff_inventory_id required` };
    if (!posInt(qty)) return { ok: false, error: `строка ${i + 1}: qty должно быть целым ≥ 1` };
    if (seen.has(ffInventoryId)) return { ok: false, error: `позиция id=${ffInventoryId} повторяется в составе` };
    seen.add(ffInventoryId);
    norm.push({ ffInventoryId, qty });
  }
  const movedAt = (body.moved_at || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const note = String(body.note ?? "").trim() || null;
  return { ok: true, doc: { fromLocationId, toLocationId, movedAt, note, lines: norm } };
}
