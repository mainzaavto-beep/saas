// /api/cabinets/[id]/briefings — утренний брифинг.
// Читает из agent_memory.db (SQLite) напрямую через node:sqlite.
// Брифинг — read-only текст, не требует RLS (один брифинг на день, общий для кабинета).
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
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") || 1);
  const date = url.searchParams.get("date");

  let db;
  try { db = getDb(); } catch { return NextResponse.json({ briefing: null, message: "База брифингов недоступна." }); }

  try {
    if (date) {
      const row = db.prepare("SELECT * FROM briefings WHERE report_date = ? ORDER BY created_at DESC LIMIT 1").get(date);
      return NextResponse.json({ briefing: row || null });
    }
    if (limit > 1) {
      const rows = db.prepare("SELECT * FROM briefings ORDER BY report_date DESC, created_at DESC LIMIT ?").all(limit);
      return NextResponse.json({ items: rows });
    }
    const row = db.prepare("SELECT * FROM briefings ORDER BY report_date DESC, created_at DESC LIMIT 1").get();
    return NextResponse.json({ briefing: row || null });
  } catch (e) {
    return NextResponse.json({ briefing: null, message: "Таблица briefings не найдена." });
  } finally {
    try { db?.close(); } catch {}
  }
});
