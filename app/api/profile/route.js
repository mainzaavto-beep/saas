// /api/profile — профиль пользователя (ФИО, телефон, смена пароля).
import { NextResponse } from "next/server";
import { getLiveSession } from "@/lib/session.js";
import { query } from "@/lib/db.js";
import { hashPassword, verifyPassword } from "@/lib/auth.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getLiveSession();
  if (!session?.user_id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await query(
    `SELECT user_id, email, first_name, last_name, patronymic, phone, name, email_verified_at FROM auth.users WHERE user_id = $1`,
    [session.user_id]
  );
  if (!rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(rows[0]);
}

export async function PUT(req) {
  const session = await getLiveSession();
  if (!session?.user_id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json();
  const sets = [];
  const vals = [];
  let i = 0;
  for (const k of ["first_name", "last_name", "patronymic", "phone"]) {
    if (b[k] !== undefined) { sets.push(`${k} = $${++i}`); vals.push(b[k] || null); }
  }
  // Собрать name из ФИО (для обратной совместимости).
  const fullName = [b.last_name, b.first_name, b.patronymic].filter(Boolean).join(" ");
  if (fullName) { sets.push(`name = $${++i}`); vals.push(fullName); }
  if (!sets.length) return NextResponse.json({ error: "no fields" }, { status: 400 });
  sets.push(`updated_at = now()`);
  vals.push(session.user_id);
  await query(`UPDATE auth.users SET ${sets.join(", ")} WHERE user_id = $${vals.length}`, vals);
  return NextResponse.json({ ok: true });
}

// Смена пароля: POST {old_password, new_password}
export async function POST(req) {
  const session = await getLiveSession();
  if (!session?.user_id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { old_password, new_password } = await req.json();
  if (!old_password || !new_password) return NextResponse.json({ error: "old_password + new_password required" }, { status: 400 });
  if (new_password.length < 8) return NextResponse.json({ error: "Пароль минимум 8 символов" }, { status: 400 });

  const rows = await query(`SELECT password_hash FROM auth.users WHERE user_id = $1`, [session.user_id]);
  if (!rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });

  const valid = verifyPassword(old_password, rows[0].password_hash);
  if (!valid) return NextResponse.json({ error: "Неверный текущий пароль" }, { status: 403 });

  const hash = hashPassword(new_password);
  await query(
    `UPDATE auth.users
        SET password_hash = $1, session_version = session_version + 1, updated_at = now()
      WHERE user_id = $2`,
    [hash, session.user_id]
  );
  // Текущее устройство остаётся в системе: переиздаём куку с новой версией.
  const fresh = await query(`SELECT session_version FROM auth.users WHERE user_id = $1`, [session.user_id]);
  session.sv = fresh[0].session_version;
  await session.save();
  return NextResponse.json({ ok: true });
}
