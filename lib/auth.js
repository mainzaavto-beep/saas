// lib/auth.js — регистрация и логин пользователей (Node route handlers).
// bcryptjs — НЕ Edge-совместим, поэтому живёт ТОЛЬКО в route handlers.
import bcrypt from 'bcryptjs';
import { query } from './db.js';

const BCRYPT_ROUNDS = 10;

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain, hash) {
  if (!hash) return false;
  try { return bcrypt.compareSync(plain, hash); } catch { return false; }
}

// Регистрация: создаёт user. Возвращает { user } или кидает Error.
export async function registerUser({ email, password, name }) {
  email = String(email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('Некорректный email');
  if (!password || password.length < 8) throw new Error('Пароль минимум 8 символов');

  const existing = await query('SELECT user_id FROM auth.users WHERE email = $1', [email]);
  if (existing.length) throw new Error('Пользователь с таким email уже зарегистрирован');

  const hash = hashPassword(password);
  const rows = await query(
    `INSERT INTO auth.users (email, password_hash, name) VALUES ($1, $2, $3)
     RETURNING user_id, email, name`,
    [email, hash, name || null]
  );
  return { user: rows[0] };
}

// Логин: проверяет пароль. Возвращает { user } или null.
export async function loginUser({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  const rows = await query(
    'SELECT user_id, email, name, password_hash, status FROM auth.users WHERE email = $1',
    [email]
  );
  const u = rows[0];
  if (!u) return null;
  if (u.status !== 'active') throw new Error('Аккаунт ' + u.status);
  if (!verifyPassword(password, u.password_hash)) return null;
  return { user: { user_id: u.user_id, email: u.email, name: u.name } };
}

// Найти первый кабинет юзера (для active_cabinet_id после логина).
export async function firstCabinetOf(userId) {
  const rows = await query(
    `SELECT c.cabinet_id, c.display_name, c.marketplaces
     FROM auth.cabinets c
     WHERE c.owner_user_id = $1 AND c.status IN ('active','provisioning')
     ORDER BY c.cabinet_id LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}
