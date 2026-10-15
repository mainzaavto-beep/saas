// lib/deliveries.js — «Доставлено на склад» (15.10.2026, спека
// docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md). Чистые функции, без БД.
// Партия — tenant.purchases (archived), приёмка — tenant.purchase_receipt_lines.
// Конечная точка: эти цифры ни в остатки, ни в себестоимость не уходят.

const LABEL_MAX = 300;
const int = (v) => Math.round(Number(v) || 0);

export function receiptTotals(purchase, lines) {
  const ordered = int(purchase?.qty);
  const accepted = (lines || []).reduce((s, l) => s + int(l.qty_accepted), 0);
  return { ordered, accepted, diff: accepted - ordered };
}

export function receiptStatus(purchase) {
  return purchase?.receipt_done_at ? "done" : "waiting";
}

const posInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function validateLine(raw) {
  const platform = raw?.platform ? String(raw.platform) : null;
  if (platform && platform !== "wb" && platform !== "ozon") return { ok: false, error: "площадка: wb, ozon или пусто" };
  const label = String(raw?.label ?? "").trim();
  if (!label) return { ok: false, error: "укажите артикул или название" };
  if (label.length > LABEL_MAX) return { ok: false, error: `название длиннее ${LABEL_MAX} символов` };
  const q = raw?.qty_accepted;
  const qty = q === "" || q == null ? NaN : Number(q);
  if (!Number.isInteger(qty) || qty < 0) return { ok: false, error: "принято — целое число ≥ 0" };
  let nm_id = null, product_id = null;
  if (platform === "wb") {
    nm_id = posInt(raw?.nm_id);
    if (!nm_id) return { ok: false, error: "нет артикула WB (nm_id)" };
  } else if (platform === "ozon") {
    product_id = posInt(raw?.product_id);
    if (!product_id) return { ok: false, error: "нет товара Ozon (product_id)" };
  }
  const note = String(raw?.note ?? "").trim() || null;
  return { ok: true, line: { platform, nm_id, product_id, label, qty_accepted: qty, note } };
}

export function buildDeliveries(purchases, lines) {
  const byPurchase = new Map();
  for (const l of lines || []) {
    const k = Number(l.purchase_id);
    if (!byPurchase.has(k)) byPurchase.set(k, []);
    byPurchase.get(k).push(l);
  }
  const totals = { waiting: 0, done: 0 };
  const items = (purchases || []).map((p) => {
    const ls = byPurchase.get(Number(p.id)) || [];
    const status = receiptStatus(p);
    totals[status]++;
    return {
      id: Number(p.id),
      name: p.supplier_name || `Партия #${p.id}`,
      category: p.category || null,
      photo: p.photo_url || p.im_url || null,
      delivered_at: p.delivered_at || null,
      receipt_done_at: p.receipt_done_at || null,
      status,
      ...receiptTotals(p, ls),
      lines: ls,
    };
  });
  return { items, totals };
}

export function filterDeliveries(items, { status = "all", q = "" } = {}) {
  const needle = String(q || "").trim().toLowerCase();
  return (items || []).filter((it) => {
    if ((status === "waiting" || status === "done") && it.status !== status) return false;
    if (!needle) return true;
    if (String(it.name || "").toLowerCase().includes(needle)) return true;
    return (it.lines || []).some((l) => String(l.label || "").toLowerCase().includes(needle));
  });
}
