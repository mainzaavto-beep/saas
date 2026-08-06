// lib/tokens.js — одноразовые токены для писем (подтверждение email, сброс пароля).
// В БД хранится только SHA-256 от токена: утечка дампа не даёт войти по ссылке.
import crypto from 'node:crypto';
import { query } from './db.js';

// Срок жизни в минутах. Подтверждение живёт неделю, сброс пароля — час.
export const TOKEN_TTL_MIN = { verify_email: 7 * 24 * 60, reset_password: 60 };

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// Выдать токен. Прежние живые токены того же вида гасим — действующим должен
// остаться ровно один (иначе старое письмо продолжало бы работать).
export async function createToken(userId, kind) {
  const ttl = TOKEN_TTL_MIN[kind];
  if (!ttl) throw new Error('Неизвестный вид токена: ' + kind);
  await query(
    `UPDATE auth.user_tokens SET used_at = now()
     WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`,
    [userId, kind]
  );
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO auth.user_tokens (token_hash, user_id, kind, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [hashToken(token), userId, kind, ttl]
  );
  return token;
}

// Погасить токен. Возвращает user_id или null (не найден / погашен / просрочен).
// Погашение и проверка — одним UPDATE: два одновременных перехода по ссылке
// не смогут сработать оба.
export async function consumeToken(token, kind) {
  if (!token) return null;
  const rows = await query(
    `UPDATE auth.user_tokens SET used_at = now()
     WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashToken(token), kind]
  );
  return rows.length ? rows[0].user_id : null;
}
