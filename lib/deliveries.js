// lib/deliveries.js — «Доставлено на склад» (15.10.2026, спека
// docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md). Чистые функции, без БД.
// Партия — tenant.purchases (archived), приёмка — tenant.purchase_receipt_lines.
// Конечная точка: эти цифры ни в остатки, ни в себестоимость не уходят.
// Архив «до 16.10» (решение владельца 16.10.2026, миграция 071): закупки до нового маршрута
// помечены purchases.legacy_at — статус "legacy", только чтение, скрыты из "all"/"waiting"/"done".

const LABEL_MAX = 300;
const int = (v) => Math.round(Number(v) || 0);

export function receiptTotals(purchase, lines) {
  const ordered = int(purchase?.qty);
  const accepted = (lines || []).reduce((s, l) => s + int(l.qty_accepted), 0);
  return { ordered, accepted, diff: accepted - ordered };
}

export function receiptStatus(purchase) {
  if (purchase?.legacy_at) return "legacy";
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
  const totals = { waiting: 0, done: 0, legacy: 0 };
  const items = (purchases || []).map((p) => {
    const ls = byPurchase.get(Number(p.id)) || [];
    const status = receiptStatus(p);
    totals[status]++;
    return {
      kind: "purchase", key: `p${p.id}`,
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

// Отправки заказов закупки (спека 2026-10-27-purchase-orders-design.md §5): прибывшая → ждёт приёмки,
// принятая → учтено. Принято по строке до ввода = отправлено.
export function buildShipmentDeliveries(shipments, lines) {
  const byShip = new Map();
  for (const l of lines || []) {
    const k = Number(l.shipment_id);
    if (!byShip.has(k)) byShip.set(k, []);
    byShip.get(k).push(l);
  }
  return (shipments || []).map((s) => {
    const ls = byShip.get(Number(s.id)) || [];
    const ordered = ls.reduce((t, l) => t + int(l.qty_shipped), 0);
    const accepted = ls.reduce((t, l) => t + int(l.qty_accepted ?? l.qty_shipped), 0);
    return {
      kind: "shipment", key: `s${s.id}`, id: Number(s.id), order_id: Number(s.order_id),
      name: [s.supplier, s.order_no || `заказ #${s.order_id}`, s.shipment_no || `отправка #${s.id}`].join(" · "),
      shipment_no: s.shipment_no || null, category: s.category || null,
      photo: ls.find((l) => l.photo)?.photo || null,
      delivered_at: s.arrived_dt || null, receipt_done_at: s.accepted_at || null,
      status: s.status === "accepted" ? "done" : "waiting",
      ordered, accepted, diff: accepted - ordered, lines: ls,
    };
  });
}

export function filterDeliveries(items, { status = "all", q = "" } = {}) {
  const needle = String(q || "").trim().toLowerCase();
  return (items || []).filter((it) => {
    if (status === "legacy") {
      if (it.status !== "legacy") return false;
    } else if (status === "waiting" || status === "done") {
      if (it.status !== status) return false;
    } else {
      // "all" (и любое прочее значение) — архив «до 16.10» показываем только явным фильтром «legacy».
      if (it.status === "legacy") return false;
    }
    if (!needle) return true;
    if (String(it.name || "").toLowerCase().includes(needle)) return true;
    return (it.lines || []).some((l) => String(l.label || "").toLowerCase().includes(needle));
  });
}
