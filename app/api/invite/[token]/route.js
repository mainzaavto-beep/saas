// /api/invite/[token] — проверить/принять приглашение.
import { NextResponse } from "next/server";
import { query, getPool } from "@/lib/db.js";
import { getSession } from "@/lib/session.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Иерархия ролей — как ROLE_LEVEL в lib/withCabinet.js.
const LEVEL = { owner: 3, manager: 2, viewer: 1 };

export async function GET(req, { params }) {
  const token = params.token;
  const rows = await query(
    `SELECT i.token, i.role, i.email, i.expires_at, i.accepted_at,
            c.display_name AS cabinet_name, u.name AS inviter_name
     FROM auth.invitations i
     JOIN auth.cabinets c ON c.cabinet_id = i.cabinet_id
     JOIN auth.users u ON u.user_id = i.created_by
     WHERE i.token = $1`,
    [token]
  );
  if (!rows.length) return NextResponse.json({ valid: false, error: "Приглашение не найдено" }, { status: 404 });
  const inv = rows[0];
  if (inv.accepted_at) return NextResponse.json({ valid: false, error: "Приглашение уже использовано" });
  if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ valid: false, error: "Срок приглашения истёк" });
  return NextResponse.json({ valid: true, role: inv.role, email: inv.email, cabinet_name: inv.cabinet_name, inviter_name: inv.inviter_name });
}

// Принять приглашение (после регистрации/логина).
// 🔒 user_id — только из сессии. Правила:
//   - уже участник с ролью ≥ роли инвайта → ничего не меняем, токен НЕ жжём
//     (закрывает само-понижение владельца собственной viewer-ссылкой);
//   - иначе атомарный claim: UPDATE с условием + membership в одной транзакции
//     (гонка двух одновременных приёмов — победитель ровно один).
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

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Блокируем существующее членство, чтобы не пересечься со сменой роли.
    const mem = await client.query(
      `SELECT role FROM auth.memberships WHERE user_id = $1 AND cabinet_id = $2 FOR UPDATE`,
      [user_id, inv.cabinet_id]
    );
    if (mem.rowCount && (LEVEL[mem.rows[0].role] || 0) >= (LEVEL[inv.role] || 0)) {
      await client.query('ROLLBACK');
      return NextResponse.json({ ok: true, already_member: true, cabinet_id: inv.cabinet_id, role: mem.rows[0].role });
    }
    const claim = await client.query(
      `UPDATE auth.invitations SET accepted_by = $1, accepted_at = now()
       WHERE token = $2 AND accepted_at IS NULL AND expires_at > now()
       RETURNING cabinet_id, role`,
      [user_id, token]
    );
    if (!claim.rowCount) {
      await client.query('ROLLBACK');
      const why = inv.accepted_at ? "Уже использовано" : "Срок истёк";
      return NextResponse.json({ error: why }, { status: 403 });
    }
    // DO UPDATE безопасен: сюда доходим только при существующей роли НИЖЕ роли инвайта
    // (апгрейд viewer → manager) либо без membership вовсе.
    await client.query(
      `INSERT INTO auth.memberships (user_id, cabinet_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, cabinet_id) DO UPDATE SET role = EXCLUDED.role`,
      [user_id, claim.rows[0].cabinet_id, claim.rows[0].role]
    );
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, cabinet_id: claim.rows[0].cabinet_id, role: claim.rows[0].role });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[invite accept]', e.message);
    return NextResponse.json({ error: "Внутренняя ошибка, попробуйте позже" }, { status: 500 });
  } finally {
    client.release();
  }
}
