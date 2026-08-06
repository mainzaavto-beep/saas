// POST /api/auth/register { email, password, name, invite_token? } → создаёт юзера, логинит.
// При валидном invite_token регистрация открыта (токен = персональный пропуск),
// инвайт принимается здесь же, в одной транзакции с membership.
import { NextResponse } from 'next/server';
import { registerUser } from '@/lib/auth.js';
import { getSession } from '@/lib/session.js';
import { query, getPool } from '@/lib/db.js';

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  try {
    // Валидный персональный инвайт освобождает от общего кода.
    let invite = null;
    if (body.invite_token) {
      const rows = await query(
        `SELECT token, cabinet_id, role, accepted_at, expires_at
         FROM auth.invitations WHERE token = $1`,
        [String(body.invite_token)]
      );
      const inv = rows[0];
      if (!inv) return NextResponse.json({ error: 'Приглашение не найдено' }, { status: 403 });
      if (inv.accepted_at) return NextResponse.json({ error: 'Приглашение уже использовано' }, { status: 403 });
      if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ error: 'Срок приглашения истёк' }, { status: 403 });
      invite = inv;
    }
    // 🔒 Invite-only: если задан SAAS_INVITE_CODE, регистрация только с кодом
    // или по персональному инвайту. Пустой код = открыто.
    const inviteCode = process.env.SAAS_INVITE_CODE;
    if (!invite && inviteCode && body.invite_code !== inviteCode) {
      return NextResponse.json({ error: 'Неверный invite-код. Регистрация по приглашению.' }, { status: 403 });
    }

    const { user } = await registerUser(body);

    // Принять инвайт атомарно: сжигаем токен с блокировкой, потом membership.
    if (invite) {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        // Атомарное «сжигание»: условие в UPDATE закрывает гонку двух
        // одновременных регистраций с одним токеном — победит ровно один.
        const claim = await client.query(
          `UPDATE auth.invitations SET accepted_by = $1, accepted_at = now()
           WHERE token = $2 AND accepted_at IS NULL AND expires_at > now()
           RETURNING cabinet_id, role`,
          [user.user_id, invite.token]
        );
        if (!claim.rowCount) {
          await client.query('ROLLBACK');
          return NextResponse.json(
            { error: 'Приглашение уже использовано или истекло. Аккаунт создан — войдите по email и паролю и запросите новую ссылку.' },
            { status: 403 }
          );
        }
        await client.query(
          `INSERT INTO auth.memberships (user_id, cabinet_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, cabinet_id) DO NOTHING`,
          [user.user_id, claim.rows[0].cabinet_id, claim.rows[0].role]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    const session = await getSession();
    session.user_id = user.user_id;
    session.email = user.email;
    session.name = user.name;
    session.active_cabinet_id = invite ? invite.cabinet_id : null;
    await session.save();
    return NextResponse.json({
      ok: true, user,
      invited_cabinet_id: invite ? invite.cabinet_id : null,
      next: invite ? `/cabinets/${invite.cabinet_id}` : '/onboarding',
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
