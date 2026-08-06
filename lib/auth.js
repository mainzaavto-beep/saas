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
// err.code: 'validation' — показать текст пользователю; 'email_taken' — дубль.
export async function registerUser({ email, password, name, first_name, last_name }) {
  email = String(email || '').trim().toLowerCase();
  const bad = (msg) => { const e = new Error(msg); e.code = 'validation'; return e; };
  if (!email || !email.includes('@')) throw bad('Некорректный email');
  if (!password || password.length < 8) throw bad('Пароль минимум 8 символов');

  const fn = first_name ? String(first_name).trim() : null;
  const ln = last_name ? String(last_name).trim() : null;
  const fullName = (name && String(name).trim()) || [ln, fn].filter(Boolean).join(' ') || null;
  const hash = hashPassword(password);

  // Дубль ловим уникальным индексом lower(email), а не предварительным SELECT:
  // проверка «сначала посмотреть, потом вставить» гонкоопасна.
  let rows;
  try {
    rows = await query(
      `INSERT INTO auth.users (email, password_hash, name, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, email, name`,
      [email, hash, fullName, fn, ln]
    );
  } catch (e) {
    if (e.code === '23505') {
      const err = new Error('Аккаунт с таким email уже зарегистрирован');
      err.code = 'email_taken';
      throw err;
    }
    throw e;
  }
  return { user: rows[0] };
}

// Логин: проверяет пароль. Возвращает { user } или null.
export async function loginUser({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  const rows = await query(
    'SELECT user_id, email, name, password_hash, status, session_version FROM auth.users WHERE email = $1',
    [email]
  );
  const u = rows[0];
  if (!u) return null;
  if (u.status !== 'active') { const e = new Error('Аккаунт ' + u.status); e.code = 'inactive'; throw e; }
  if (!verifyPassword(password, u.password_hash)) return null;
  return { user: { user_id: u.user_id, email: u.email, name: u.name, session_version: u.session_version } };
}

// Найти первый кабинет юзера (для active_cabinet_id после логина).
// По membership, не по владению: сотрудник (manager/viewer) тоже должен
// попадать в свой кабинет, а не на онбординг.
export async function firstCabinetOf(userId) {
  const rows = await query(
    `SELECT c.cabinet_id, c.display_name, c.marketplaces
     FROM auth.memberships m
     JOIN auth.cabinets c ON c.cabinet_id = m.cabinet_id
     WHERE m.user_id = $1 AND c.status IN ('active','provisioning')
     ORDER BY c.cabinet_id LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}
