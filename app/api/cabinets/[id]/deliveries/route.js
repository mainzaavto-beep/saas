// /api/cabinets/[id]/deliveries — «Доставлено на склад» (15.10.2026, спека
// docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md; приёмка отправок заказов
// закупки — 27.10.2026, спека docs/superpowers/specs/2026-10-27-purchase-orders-design.md §5).
// GET ?status=waiting|done|all &q= → { items, totals, role } — старые партии закупки
//   (tenant.purchases archived, kind:"purchase") + прибывшие/принятые отправки заказов закупки
//   (tenant.purchase_shipments, kind:"shipment"), обе ленты в одном списке.
// GET ?catalog=1&q= → { catalog } — поиск артикула WB/Ozon для строки приёмки.
// POST (manager): line_add | line_update | line_delete | done | undone (owner) | return_to_purchases
//   — старые партии; ship_accept_line | ship_link_line | ship_done | ship_undone (owner) — отправки.
// Конечная точка: в остатки, журнал движений и себестоимость НЕ пишем.
// Архив «до 16.10» (решение владельца 16.10.2026, миграция 071): партии с legacy_at — только
// чтение, любая правка приёмки отклоняется 400 ДО записи.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery } from "@/lib/db.js";
import { buildDeliveries, buildShipmentDeliveries, filterDeliveries, validateLine } from "@/lib/deliveries.js";
import { searchCatalog, catalogLabel, catalogPhoto } from "@/lib/catalogSearch.js";
import { lockShipment, loadOrder, refreshOrderStatus } from "@/lib/purchaseOrdersData.js";
import { validateLineInput } from "@/lib/purchaseOrders.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bad = (error, status = 400) => NextResponse.json({ error }, { status });

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  if (url.searchParams.get("catalog") === "1") {
    return NextResponse.json({ catalog: await searchCatalog(url.searchParams.get("q")) });
  }
  const purchases = await tenantQuery(
    `SELECT p.id, p.supplier_name, p.category, p.qty, p.photo_url, a.im_url,
            p.delivered_at::text AS delivered_at, p.receipt_done_at, p.legacy_at::text AS legacy_at
     FROM tenant.purchases p
     LEFT JOIN tenant.wb_articles a ON a.cabinet_id = p.cabinet_id AND a.nm_id = p.nm_id
     WHERE p.archived AND p.deleted_at IS NULL
     ORDER BY (p.receipt_done_at IS NOT NULL), p.delivered_at DESC NULLS LAST, p.id DESC`, []);
  const lines = await tenantQuery(
    `SELECT l.id, l.purchase_id, l.platform, l.nm_id, l.product_id, l.label, l.qty_accepted, l.note,
            COALESCE(a.im_url, o.im_url) AS im_url, o.offer_id AS article
     FROM tenant.purchase_receipt_lines l
     LEFT JOIN tenant.wb_articles a ON l.platform = 'wb' AND a.cabinet_id = l.cabinet_id AND a.nm_id = l.nm_id
     LEFT JOIN tenant.ozon_products o ON l.platform = 'ozon' AND o.cabinet_id = l.cabinet_id AND o.product_id = l.product_id
     ORDER BY l.purchase_id, l.id`, []);
  const { items, totals } = buildDeliveries(purchases, lines);
  const ships = await tenantQuery(
    `SELECT s.id, s.order_id, o.order_no, o.supplier, o.category, s.shipment_no, s.status,
            s.arrived_dt::text AS arrived_dt, s.accepted_at::text AS accepted_at
       FROM tenant.purchase_shipments s
       JOIN tenant.purchase_orders o ON o.cabinet_id = s.cabinet_id AND o.id = s.order_id AND o.deleted_at IS NULL
      WHERE s.deleted_at IS NULL AND s.status IN ('arrived','accepted')
      ORDER BY (s.status = 'accepted'), s.arrived_dt DESC NULLS LAST, s.id DESC`, []);
  const shipLines = await tenantQuery(
    `SELECT sl.id, sl.shipment_id, sl.line_id, sl.qty_shipped, sl.qty_accepted,
            l.label, l.variant, l.platform, l.nm_id, l.product_id,
            COALESCE(l.photo_url, a.im_url, o.im_url) AS photo, o.offer_id AS article
       FROM tenant.purchase_shipment_lines sl
       JOIN tenant.purchase_order_lines l ON l.cabinet_id = sl.cabinet_id AND l.id = sl.line_id
       LEFT JOIN tenant.wb_articles a ON l.platform = 'wb' AND a.cabinet_id = l.cabinet_id AND a.nm_id = l.nm_id
       LEFT JOIN tenant.ozon_products o ON l.platform = 'ozon' AND o.cabinet_id = l.cabinet_id AND o.product_id = l.product_id
      ORDER BY sl.shipment_id, sl.id`, []);
  const shipItems = buildShipmentDeliveries(ships, shipLines);
  for (const it of shipItems) totals[it.status]++;
  const filtered = filterDeliveries([...shipItems, ...items], { status: url.searchParams.get("status") || "all", q: url.searchParams.get("q") || "" });
  return NextResponse.json({ items: filtered, totals, role: cabinet.role });
});

// Партия под блокировкой; null — нет такой доставленной партии.
async function lockPurchase(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return (await tenantQuery(
    `SELECT id, archived, receipt_done_at, legacy_at FROM tenant.purchases
     WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [n]))[0] || null;
}

const LEGACY_ERROR = "партия в архиве (до 16.10), правка недоступна";

const LINE_COLS = `id, purchase_id, platform, nm_id, product_id, label, qty_accepted, note`;

export const POST = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json();
  const action = b?.action;

  if (action === "ship_accept_line" || action === "ship_link_line" || action === "ship_done" || action === "ship_undone") {
    // Порядок блокировок как в /purchase-orders (заказ → строки): сперва узнаём order_id
    // обычным SELECT (без блокировки), берём заказ FOR UPDATE, и только потом — отправку.
    // Иначе два запроса, один из которых идёт через /purchase-orders, могут взять эти же
    // две блокировки в разном порядке и словить deadlock.
    const row = (await tenantQuery(
      `SELECT order_id FROM tenant.purchase_shipments WHERE id = $1 AND deleted_at IS NULL`, [Number(b.shipment_id)]))[0];
    if (!row) return bad("отправка не найдена", 404);
    const bundle = await loadOrder(row.order_id, { lock: true });
    if (!bundle) return bad("заказ не найден", 404);
    const ship = await lockShipment(b.shipment_id);
    if (!ship) return bad("отправка не найдена", 404);
    if (action === "ship_undone") {
      if (cabinet.role !== "owner") return bad("снять отметку может только владелец", 403);
      if (ship.status !== "accepted") return bad("отправка ещё не принята");
      await tenantQuery(`UPDATE tenant.purchase_shipments SET status = 'arrived', accepted_at = NULL, accepted_by = NULL, updated_at = now() WHERE id = $1`, [ship.id]);
      await refreshOrderStatus(ship.order_id);
      return NextResponse.json({ ok: true });
    }
    if (ship.status !== "arrived") return bad(ship.status === "accepted" ? "отправка принята, снимите отметку" : "отправка ещё в пути");
    if (action === "ship_done") {
      await tenantQuery(`UPDATE tenant.purchase_shipment_lines SET qty_accepted = qty_shipped WHERE shipment_id = $1 AND qty_accepted IS NULL`, [ship.id]);
      await tenantQuery(`UPDATE tenant.purchase_shipments SET status = 'accepted', accepted_at = now(), accepted_by = $2, updated_at = now() WHERE id = $1`,
        [ship.id, session?.user_id ?? null]);
      await refreshOrderStatus(ship.order_id);
      return NextResponse.json({ ok: true });
    }
    const sl = (await tenantQuery(
      `SELECT id, line_id FROM tenant.purchase_shipment_lines WHERE id = $1 AND shipment_id = $2 FOR UPDATE`, [Number(b.id), ship.id]))[0];
    if (!sl) return bad("строка отправки не найдена", 404);
    if (action === "ship_accept_line") {
      const q = Number(b.qty_accepted);
      if (!Number.isInteger(q) || q < 0) return bad("принято — целое число ≥ 0");
      await tenantQuery(`UPDATE tenant.purchase_shipment_lines SET qty_accepted = $2 WHERE id = $1`, [sl.id, q]);
      return NextResponse.json({ ok: true });
    }
    // ship_link_line — привязать артикул к позиции заказа (пишется в позицию, видно и в «Закупках»).
    // Привязка меняет только идентификатор товара: имя позиции (label) остаётся введённым при заказе.
    const cur = (await tenantQuery(`SELECT * FROM tenant.purchase_order_lines WHERE id = $1 FOR UPDATE`, [sl.line_id]))[0];
    const raw = { ...cur, platform: b.platform || null, nm_id: b.nm_id, product_id: b.product_id };
    if (raw.platform) { raw.photo_url = cur.photo_url || await catalogPhoto(raw); }
    const v = validateLineInput(raw);
    if (!v.ok) return bad(v.error);
    await tenantQuery(
      `UPDATE tenant.purchase_order_lines SET platform = $2, nm_id = $3, product_id = $4, photo_url = $5, updated_at = now() WHERE id = $1`,
      [cur.id, v.value.platform, v.value.nm_id, v.value.product_id, v.value.photo_url]);
    return NextResponse.json({ ok: true });
  }

  if (action === "line_add") {
    const p = await lockPurchase(b.purchase_id);
    if (!p || !p.archived) return bad("партия не найдена среди доставленных", 404);
    if (p.legacy_at) return bad(LEGACY_ERROR);
    if (p.receipt_done_at) return bad("партия закрыта, снимите отметку «Учтено по артикулам»");
    const raw = { ...b };
    if (raw.platform && !String(raw.label || "").trim()) raw.label = await catalogLabel(raw) || "";
    const v = validateLine(raw);
    if (!v.ok) return bad(v.error);
    const l = v.line;
    const ins = await tenantQuery(
      `INSERT INTO tenant.purchase_receipt_lines
         (cabinet_id, purchase_id, platform, nm_id, product_id, label, qty_accepted, note)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7)
       RETURNING ${LINE_COLS}`,
      [p.id, l.platform, l.nm_id, l.product_id, l.label, l.qty_accepted, l.note]);
    return NextResponse.json({ ok: true, line: ins[0] });
  }

  if (action === "line_update" || action === "line_delete") {
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) return bad("id required");
    // Первое чтение — только чтобы узнать purchase_id и взять блокировку партии.
    const cur = (await tenantQuery(`SELECT purchase_id FROM tenant.purchase_receipt_lines WHERE id = $1`, [id]))[0];
    if (!cur) return bad(`строка id=${id} не найдена`, 404);
    const p = await lockPurchase(cur.purchase_id);
    if (!p) return bad("партия не найдена", 404);
    if (p.legacy_at) return bad(LEGACY_ERROR);
    if (p.receipt_done_at) return bad("партия закрыта, снимите отметку «Учтено по артикулам»");
    // Повторное чтение строки ПОД БЛОКИРОВКОЙ (после lockPurchase) — иначе два
    // параллельных line_update смешивают поля по устаревшему снимку (lost update).
    const fresh = (await tenantQuery(`SELECT ${LINE_COLS} FROM tenant.purchase_receipt_lines WHERE id = $1 FOR UPDATE`, [id]))[0];
    if (!fresh) return bad(`строка id=${id} не найдена`, 404);
    if (action === "line_delete") {
      await tenantQuery(`DELETE FROM tenant.purchase_receipt_lines WHERE id = $1`, [id]);
      return NextResponse.json({ ok: true });
    }
    const v = validateLine({
      ...fresh,
      qty_accepted: b.qty_accepted !== undefined ? b.qty_accepted : fresh.qty_accepted,
      note: b.note !== undefined ? b.note : fresh.note,
      label: b.label !== undefined ? b.label : fresh.label,
    });
    if (!v.ok) return bad(v.error);
    const upd = await tenantQuery(
      `UPDATE tenant.purchase_receipt_lines SET qty_accepted = $2, note = $3, label = $4, updated_at = now()
       WHERE id = $1 RETURNING ${LINE_COLS}`, [id, v.line.qty_accepted, v.line.note, v.line.label]);
    return NextResponse.json({ ok: true, line: upd[0] });
  }

  if (action === "done" || action === "undone" || action === "return_to_purchases") {
    const p = await lockPurchase(b.purchase_id);
    if (!p || !p.archived) return bad("партия не найдена среди доставленных", 404);
    if (p.legacy_at) return bad(LEGACY_ERROR);
    const [{ n }] = await tenantQuery(
      `SELECT count(*)::int AS n FROM tenant.purchase_receipt_lines WHERE purchase_id = $1`, [p.id]);
    if (action === "done") {
      if (p.receipt_done_at) return bad("партия уже учтена");
      if (!n) return bad("добавьте хотя бы одну строку приёмки");
      await tenantQuery(`UPDATE tenant.purchases SET receipt_done_at = now(), receipt_done_by = $2 WHERE id = $1`,
        [p.id, session?.user_id ?? null]);
      return NextResponse.json({ ok: true });
    }
    if (action === "undone") {
      if (cabinet.role !== "owner") return bad("снять отметку может только владелец", 403);
      if (!p.receipt_done_at) return bad("партия ещё не учтена");
      await tenantQuery(`UPDATE tenant.purchases SET receipt_done_at = NULL, receipt_done_by = NULL WHERE id = $1`, [p.id]);
      return NextResponse.json({ ok: true });
    }
    // return_to_purchases
    if (p.receipt_done_at || n) return bad("у партии уже есть приёмка — сначала удалите строки");
    await tenantQuery(`UPDATE tenant.purchases SET archived = false, delivered_at = NULL WHERE id = $1`, [p.id]);
    return NextResponse.json({ ok: true });
  }

  return bad("неизвестное действие");
}, { requireRole: "manager" });
