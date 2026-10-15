// /api/cabinets/[id]/deliveries — «Доставлено на склад» (15.10.2026, спека
// docs/superpowers/specs/2026-10-15-delivered-to-stock-design.md).
// GET ?status=waiting|done|all &q= → { items, totals, role } — доставленные партии закупки
//   (tenant.purchases archived) со строками приёмки (tenant.purchase_receipt_lines).
// GET ?catalog=1&q= → { catalog } — поиск артикула WB/Ozon для строки приёмки.
// POST (manager): line_add | line_update | line_delete | done | undone (owner) | return_to_purchases.
// Конечная точка: в остатки, журнал движений и себестоимость НЕ пишем.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery } from "@/lib/db.js";
import { buildDeliveries, filterDeliveries, validateLine } from "@/lib/deliveries.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bad = (error, status = 400) => NextResponse.json({ error }, { status });

async function loadCatalog(q) {
  const needle = `%${String(q || "").trim()}%`;
  const out = [];
  const wb = await tenantQuery(
    `SELECT nm_id, name, im_url FROM tenant.wb_articles
     WHERE name ILIKE $1 OR nm_id::text LIKE $1 ORDER BY name LIMIT 20`, [needle]);
  for (const r of wb) out.push({ platform: "wb", nm_id: Number(r.nm_id), label: r.name || `WB ${r.nm_id}`, im_url: r.im_url || null, article: null });
  const oz = await tenantQuery(
    `SELECT product_id, offer_id, name, im_url FROM tenant.ozon_products
     WHERE name ILIKE $1 OR offer_id ILIKE $1 OR product_id::text LIKE $1 ORDER BY name LIMIT 20`, [needle]);
  for (const r of oz) out.push({ platform: "ozon", product_id: Number(r.product_id), label: r.name || `Ozon ${r.product_id}`, im_url: r.im_url || null, article: r.offer_id || null });
  return out.slice(0, 20);
}

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  if (url.searchParams.get("catalog") === "1") {
    return NextResponse.json({ catalog: await loadCatalog(url.searchParams.get("q")) });
  }
  const purchases = await tenantQuery(
    `SELECT p.id, p.supplier_name, p.category, p.qty, p.photo_url, a.im_url,
            p.delivered_at::text AS delivered_at, p.receipt_done_at
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
  const filtered = filterDeliveries(items, { status: url.searchParams.get("status") || "all", q: url.searchParams.get("q") || "" });
  return NextResponse.json({ items: filtered, totals, role: cabinet.role });
});

// Партия под блокировкой; null — нет такой доставленной партии.
async function lockPurchase(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return (await tenantQuery(
    `SELECT id, archived, receipt_done_at FROM tenant.purchases
     WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [n]))[0] || null;
}

async function catalogLabel(line) {
  if (line.platform === "wb") {
    const r = (await tenantQuery(`SELECT name FROM tenant.wb_articles WHERE nm_id = $1`, [Number(line.nm_id)]))[0];
    return r?.name || null;
  }
  if (line.platform === "ozon") {
    const r = (await tenantQuery(`SELECT name FROM tenant.ozon_products WHERE product_id = $1`, [Number(line.product_id)]))[0];
    return r?.name || null;
  }
  return null;
}

const LINE_COLS = `id, purchase_id, platform, nm_id, product_id, label, qty_accepted, note`;

export const POST = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json();
  const action = b?.action;

  if (action === "line_add") {
    const p = await lockPurchase(b.purchase_id);
    if (!p || !p.archived) return bad("партия не найдена среди доставленных", 404);
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
    const cur = (await tenantQuery(`SELECT ${LINE_COLS} FROM tenant.purchase_receipt_lines WHERE id = $1`, [id]))[0];
    if (!cur) return bad(`строка id=${id} не найдена`, 404);
    const p = await lockPurchase(cur.purchase_id);
    if (!p) return bad("партия не найдена", 404);
    if (p.receipt_done_at) return bad("партия закрыта, снимите отметку «Учтено по артикулам»");
    if (action === "line_delete") {
      await tenantQuery(`DELETE FROM tenant.purchase_receipt_lines WHERE id = $1`, [id]);
      return NextResponse.json({ ok: true });
    }
    const v = validateLine({
      ...cur,
      qty_accepted: b.qty_accepted !== undefined ? b.qty_accepted : cur.qty_accepted,
      note: b.note !== undefined ? b.note : cur.note,
      label: b.label !== undefined ? b.label : cur.label,
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
