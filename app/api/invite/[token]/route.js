// /api/invite/[token] — проверить/принять приглашение.
import { NextResponse } from "next/server";
import { query } from "@/lib/db.js";
import { getSession } from "@/lib/session.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  const token = params.token;
  const rows = await query(
    `SELECT i.token, i.role, i.email, i.expires_at, i.accepted_at,
            c.display_name AS cabinet_name
     FROM auth.invitations i
     JOIN auth.cabinets c ON c.cabinet_id = i.cabinet_id
     WHERE i.token = $1`,
    [token]
  );
  if (!rows.length) return NextResponse.json({ valid: false, error: "Приглашение не найдено" }, { status: 404 });
  const inv = rows[0];
  if (inv.accepted_at) return NextResponse.json({ valid: false, error: "Приглашение уже использовано" });
  if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ valid: false, error: "Срок приглашения истёк" });
  return NextResponse.json({ valid: true, role: inv.role, email: inv.email, cabinet_name: inv.cabinet_name });
}

// Принять приглашение (после регистрации/логина).
// 🔒 user_id берётся ТОЛЬКО из сессии. Раньше он приходил в теле запроса —
// любой залогиненный мог принять чужой токен на произвольный user_id
// (и поднять себе роль до указанной в инвайте).
export async function POST(req, { params }) {
  const token = params.token;
  const session = await getSession();
  const user_id = session?.user_id;
  if (!user_id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await query(
    `SELECT cabinet_id, role, expires_at, accepted_at FROM auth.invitations WHERE token = $1`,
    [token]
  );
  if (!rows.length) return NextResponse.json({ error: "Приглашение не найдено" }, { status: 404 });
  const inv = rows[0];
  if (inv.accepted_at) return NextResponse.json({ error: "Уже использовано" }, { status: 403 });
  if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ error: "Срок истёк" }, { status: 403 });

  // Создать membership.
  await query(
    `INSERT INTO auth.memberships (user_id, cabinet_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, cabinet_id) DO UPDATE SET role = EXCLUDED.role`,
    [user_id, inv.cabinet_id, inv.role]
  );
  // Пометить как принято.
  await query(`UPDATE auth.invitations SET accepted_by = $1, accepted_at = now() WHERE token = $2`, [user_id, token]);
  return NextResponse.json({ ok: true, cabinet_id: inv.cabinet_id });
}
