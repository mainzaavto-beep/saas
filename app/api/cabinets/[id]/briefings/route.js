// /api/cabinets/[id]/briefings — утренний брифинг.
// Читает из agent_memory.db (SQLite) напрямую через node:sqlite.
// Брифинг — read-only текст из ВНЕШНЕЙ базы старой системы (не tenant-данные, без RLS): это личный
// брифинг владельца сервиса, поэтому отдаётся ТОЛЬКО владельцу кабинета #1 (14.10.2026; раньше роут
// не смотрел кабинет — любой участник любого кабинета увидел бы цифры владельца). Новые брифинги не
// пишутся с 10.07.2026, пункт меню убран.
const BRIEFING_CABINET_ID = 1;
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { DatabaseSync as SqliteSync } from "node:sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MEMORY_DB = process.env.MEMORY_DB_PATH || "/opt/agentsDB/agent_memory.db";

function getDb() {
  return new SqliteSync(MEMORY_DB, { readOnly: true });
}

export const GET = withCabinet(async (req, { cabinet }) => {
  if (Number(cabinet?.cabinet_id) !== BRIEFING_CABINET_ID || cabinet?.role !== "owner") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") || 1);
  const date = url.searchParams.get("date");

  let db;
  try { db = getDb(); } catch (e) { console.error("briefings: open db:", e); return NextResponse.json({ briefing: null, message: "База брифингов недоступна." }); }

  try {
    if (date) {
      const row = db.prepare("SELECT * FROM briefings WHERE report_date = ? ORDER BY id DESC LIMIT 1").get(date);
      return NextResponse.json({ briefing: row || null });
    }
    if (limit > 1) {
      const rows = db.prepare("SELECT * FROM briefings ORDER BY report_date DESC, id DESC LIMIT ?").all(limit);
      return NextResponse.json({ items: rows });
    }
    const row = db.prepare("SELECT * FROM briefings ORDER BY report_date DESC, id DESC LIMIT 1").get();
    return NextResponse.json({ briefing: row || null });
  } catch (e) {
    console.error("briefings:", e);
    return NextResponse.json({ briefing: null, message: "Брифинг недоступен." }, { status: 500 });
  } finally {
    try { db?.close(); } catch (e) { console.error("briefings: close:", e); }
  }
});
