// /api/cabinets/[id]/move — заявки на перемещение между складами WB.
// GET → список заявок + товары каталога (для выбора).
// POST {nm_id, from_warehouse, to_warehouse, quantity, note} → создать.
// POST {id, status} → обновить статус.
// DELETE ?id=N → удалить.
import { NextResponse } from "next/server";
import { tenantQuery, DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const statusQ = url.searchParams.get("status") || "";

  const conds = [];
  const params = [];
  if (statusQ) { conds.push("status = $" + (params.length + 1)); params.push(statusQ); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";

  const items = await tenantQuery(
    `SELECT * FROM tenant.wb_realloc_requests ${where} ORDER BY created_at DESC`,
    params
  );

  // Метаданные nm_id из articles
  const nmMeta = {};
  const nmIds = [...new Set(items.map((i) => i.nm_id).filter(Boolean))];
  if (nmIds.length) {
    try {
      const db = new DatabaseSync("wb", { readOnly: true });
      const ph = nmIds.map(() => "?").join(",");
      for (const m of await db.prepare(`SELECT nm_id, name, im_url FROM articles WHERE nm_id IN (${ph})`).all(...nmIds)) {
        nmMeta[m.nm_id] = { name: m.name, im_url: m.im_url };
      }
    } catch {}
  }

  // Список складов из daily_stock
  let warehouses = [];
  try {
    const db = new DatabaseSync("wb", { readOnly: true });
    warehouses = (await db.prepare(`SELECT DISTINCT warehouse_name FROM orders WHERE warehouse_name IS NOT NULL ORDER BY warehouse_name`).all())
      .map((r) => r.warehouse_name);
  } catch {}

  return NextResponse.json({
    items: items.map((it) => ({ ...it, nm_meta: nmMeta[it.nm_id] || null })),
    warehouses,
  });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();

  if (b.id) {
    // Update status
    const sets = [];
    const vals = [];
    if (b.status) { sets.push(`status = $${sets.length + 1}`); vals.push(b.status); }
    if (b.note !== undefined) { sets.push(`note = $${sets.length + 1}`); vals.push(b.note); }
    if (!sets.length) return NextResponse.json({ error: "No fields" }, { status: 400 });
    vals.push(Number(b.id));
    await tenantQuery(`UPDATE tenant.wb_realloc_requests SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    return NextResponse.json({ ok: true });
  }

  // Create
  const rows = await tenantQuery(
    `INSERT INTO tenant.wb_realloc_requests (cabinet_id, nm_id, from_warehouse, to_warehouse, quantity, status, note)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6) RETURNING id`,
    [b.nm_id ? Number(b.nm_id) : null, b.from_warehouse || null, b.to_warehouse || null,
     Number(b.quantity) || 0, b.status || "new", b.note || null]
  );
  return NextResponse.json({ ok: true, id: rows[0]?.id });
});

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await tenantQuery(`DELETE FROM tenant.wb_realloc_requests WHERE id = $1`, [Number(id)]);
  return NextResponse.json({ ok: true });
});
