// /api/cabinets/[id]/ff-stock — остатки на складе/ФФ (CRUD через tenantQuery).
// GET ?date=YYYY-MM-DD → снапшот + locations + totals.
// GET ?history=1 → история totals.
// POST {as_of_date, balances:[...], note} → replace на дату.
// GET ?action=locations → список мест хранения.
// POST {action:"add_location", name, address} → добавить место.
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // CRUD locations
  if (action === "locations") {
    const rows = await tenantQuery(`SELECT id, name, address FROM tenant.stock_ff_locations ORDER BY name`);
    return NextResponse.json({ items: rows });
  }

  // История totals
  if (url.searchParams.get("history") === "1") {
    const rows = await tenantQuery(
      `SELECT s.as_of_date, COUNT(b.id) AS items, COALESCE(SUM(b.quantity), 0) AS qty
       FROM tenant.stock_ff_snapshots s
       LEFT JOIN tenant.stock_ff_balances b ON b.snapshot_id = s.id AND b.cabinet_id = s.cabinet_id
       GROUP BY s.as_of_date ORDER BY s.as_of_date DESC`
    );
    return NextResponse.json({ items: rows });
  }

  // Снапшот на дату
  const dateQ = url.searchParams.get("date");
  let snapRows;
  if (dateQ && ISO_DATE.test(dateQ)) {
    snapRows = await tenantQuery(
      `SELECT * FROM tenant.stock_ff_snapshots WHERE as_of_date <= $1 ORDER BY as_of_date DESC LIMIT 1`, [dateQ]
    );
  } else {
    snapRows = await tenantQuery(`SELECT * FROM tenant.stock_ff_snapshots ORDER BY as_of_date DESC LIMIT 1`);
  }
  const snap = snapRows[0] || null;
  if (!snap) return NextResponse.json({ snapshot: null, balances: [], locations: [], totals: { items: 0, qty: 0 } });

  const balances = await tenantQuery(
    `SELECT b.id, b.catalog_id, b.internal_name, b.sku_label, b.platform, b.quantity, b.location_id,
            COALESCE(l.name, '—') AS location_name
     FROM tenant.stock_ff_balances b
     LEFT JOIN tenant.stock_ff_locations l ON l.id = b.location_id AND l.cabinet_id = b.cabinet_id
     WHERE b.snapshot_id = $1`,
    [snap.id]
  );
  const locations = await tenantQuery(`SELECT id, name, address FROM tenant.stock_ff_locations ORDER BY name`);
  const qty = balances.reduce((s, b) => s + (Number(b.quantity) || 0), 0);

  return NextResponse.json({ snapshot: snap, balances, locations, totals: { items: balances.length, qty: round2(qty) } });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();

  // Add location
  if (body.action === "add_location") {
    if (!body.name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const rows = await tenantQuery(
      `INSERT INTO tenant.stock_ff_locations (cabinet_id, name, address)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2) RETURNING id`,
      [String(body.name).trim(), body.address || null]
    );
    return NextResponse.json({ ok: true, id: rows[0]?.id });
  }

  // Replace balances на дату
  const { as_of_date, balances = [], note } = body;
  if (!as_of_date) return NextResponse.json({ error: "as_of_date required" }, { status: 400 });

  // Upsert snapshot
  const existing = await tenantQuery(`SELECT id FROM tenant.stock_ff_snapshots WHERE as_of_date = $1`, [as_of_date]);
  let snapId;
  if (existing.length > 0) {
    snapId = existing[0].id;
    await tenantQuery(`DELETE FROM tenant.stock_ff_balances WHERE snapshot_id = $1`, [snapId]);
    if (note != null) await tenantQuery(`UPDATE tenant.stock_ff_snapshots SET note = $1 WHERE id = $2`, [note, snapId]);
  } else {
    const rows = await tenantQuery(
      `INSERT INTO tenant.stock_ff_snapshots (cabinet_id, as_of_date, note)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2) RETURNING id`,
      [as_of_date, note || null]
    );
    snapId = rows[0].id;
  }

  // Insert balances
  for (const b of balances) {
    await tenantQuery(
      `INSERT INTO tenant.stock_ff_balances (cabinet_id, snapshot_id, catalog_id, internal_name, sku_label, platform, quantity, location_id)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7)`,
      [snapId, b.catalog_id || null, b.internal_name || null, b.sku_label || null,
       b.platform || null, Number(b.quantity) || 0, b.location_id || null]
    );
  }

  return NextResponse.json({ ok: true, snapshot_id: snapId });
}, { requireRole: 'manager' });
