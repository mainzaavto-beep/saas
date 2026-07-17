// /api/whats-new — глобальная лента «Что нового» (changelog).
// Глобальный роут (не cabinet-ный): записи общие для всех клиентов.
// Читает shared.changelog (БЕЗ RLS). Требует только залогиненность.
//
// GET ?limit=50 — последние записи (по убыванию даты/id).
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session.js";
import { query } from "@/lib/db.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") || 50), 200);
  const rows = await query(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, type, title, body
     FROM shared.changelog
     ORDER BY date DESC, id DESC
     LIMIT $1`,
    [limit]
  );
  return NextResponse.json({ items: rows });
}
