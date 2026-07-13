// /api/cabinets/[id]/notifications — оповещения (триггерные ситуации).
// GET ?count=1 — кол-во непрочитанных. GET ?unread=1 — только новые.
// POST — создать. PATCH {action:read|read_all, id?} — отметить. DELETE ?id=N.
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  if (url.searchParams.get("count") === "1") {
    const rows = await tenantQuery("SELECT COUNT(*) AS c FROM tenant.notifications WHERE read = 0");
    return NextResponse.json({ count: Number(rows[0].c) });
  }
  const limit = Number(url.searchParams.get("limit") || 100);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const rows = await tenantQuery(
    `SELECT id, ts, level, source, category, title, message, ref, read FROM tenant.notifications
     ${unreadOnly ? "WHERE read = 0" : ""}
     ORDER BY ts DESC LIMIT $1`,
    [limit]
  );
  const unread = await tenantQuery("SELECT COUNT(*) AS c FROM tenant.notifications WHERE read = 0");
  return NextResponse.json({ items: rows, unread: Number(unread[0].c) });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
  const { level = "warn", source, category, title, message, ref } = body;
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
  const ts = new Date().toISOString();
  const rows = await tenantQuery(
    `INSERT INTO tenant.notifications (cabinet_id, ts, level, source, category, title, message, ref)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [ts, level, source || null, category || null, title, message || null, ref || null]
  );
  return NextResponse.json({ ok: true, id: rows[0]?.id });
});

export const PATCH = withCabinet(async (req, { cabinet }) => {
  const { action, id } = await req.json();
  if (action === "read_all") {
    await tenantQuery("UPDATE tenant.notifications SET read = 1 WHERE read = 0");
    return NextResponse.json({ ok: true });
  }
  if (action === "read" && id) {
    await tenantQuery("UPDATE tenant.notifications SET read = 1 WHERE id = $1", [Number(id)]);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Неизвестное действие." }, { status: 400 });
});

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Нужен id." }, { status: 400 });
  await tenantQuery("DELETE FROM tenant.notifications WHERE id = $1", [Number(id)]);
  return NextResponse.json({ ok: true });
});
