// GET /api/cabinets — список проектов (кабинетов) пользователя.
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session.js";
import { query } from "@/lib/db.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session?.user_id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await query(
    `SELECT c.cabinet_id, c.display_name, c.marketplaces, c.status, m.role
     FROM auth.cabinets c
     JOIN auth.memberships m ON m.cabinet_id = c.cabinet_id
     WHERE m.user_id = $1 AND c.status <> 'deleted'
     ORDER BY c.cabinet_id`,
    [session.user_id]
  );
  return NextResponse.json({ items: rows });
}
