// lib/billing.js — состояние доступа кабинета и тарифы.
// Состояние НЕ хранится в БД: две даты (trial_ends_at, paid_until) — источник
// истины, всё остальное выводится здесь. Одна функция на всю панель, чтобы
// условие «оплачено или нет» не расползлось копиями по коду.
import { query } from './db.js';

// Пустая строка в env — это «не задано», а не ноль: иначе опечатка в
// конфигурации закрыла бы клиентам доступ на три дня раньше срока.
const graceRaw = (process.env.SAAS_GRACE_DAYS || '').trim();
const graceEnv = graceRaw === '' ? NaN : Number(graceRaw);
export const GRACE_DAYS = Number.isFinite(graceEnv) && graceEnv >= 0 ? graceEnv : 3;

const DAY_MS = 86400000;
const toDate = (v) => (v ? new Date(v) : null);

// state: trial — идёт пробный период; active — оплачено; grace — срок вышел,
// но отсрочка ещё идёт (полный доступ); locked — доступ закрыт.
export function cabinetAccess(cabinet, now = new Date()) {
  const trial = toDate(cabinet?.trial_ends_at);
  const paid = toDate(cabinet?.paid_until);
  const until = !trial && !paid ? null : new Date(Math.max(trial?.getTime() || 0, paid?.getTime() || 0));
  const graceUntil = until ? new Date(until.getTime() + GRACE_DAYS * DAY_MS) : null;
  const daysLeft = until ? Math.ceil((until.getTime() - now.getTime()) / DAY_MS) : 0;

  if (!until) return { state: 'locked', until: null, daysLeft: 0, graceUntil: null };
  if (until.getTime() > now.getTime()) {
    // Оплата важнее триала: если срок оплаты ещё не прошёл — состояние active,
    // даже когда пробный период формально длиннее.
    return { state: paid && paid.getTime() > now.getTime() ? 'active' : 'trial', until, daysLeft, graceUntil };
  }
  if (graceUntil.getTime() > now.getTime()) return { state: 'grace', until, daysLeft, graceUntil };
  return { state: 'locked', until, daysLeft, graceUntil };
}

// Новая дата окончания при оплате: продлеваем от большей из «сейчас» и
// текущего срока — оплативший заранее не теряет остаток, вернувшийся после
// блокировки не платит за прошедшее.
export function extendPaidUntil(cabinet, months, now = new Date()) {
  const { until } = cabinetAccess(cabinet, now);
  const base = until && until.getTime() > now.getTime() ? new Date(until) : new Date(now);
  const day = base.getDate();
  const next = new Date(base);
  // Сначала переводим на 1-е число: setMonth на 31-м числе переполняется
  // в следующий месяц (31 января + 1 мес. дал бы 3 марта).
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

export async function activePlans() {
  return query(
    `SELECT code, months, price_rub, title FROM billing.plans
     WHERE is_active = true ORDER BY sort, months`
  );
}

export async function planByCode(code) {
  const rows = await query(
    `SELECT code, months, price_rub, title FROM billing.plans
     WHERE code = $1 AND is_active = true`,
    [String(code || '')]
  );
  return rows[0] || null;
}

// Платежи, где сумма провайдера разошлась с нашей ценой: деньги не зачислены,
// нужен ручной разбор. В норме пусто. Живёт здесь, а не в роуте /health,
// чтобы запрос можно было проверить тестом без операторской сессии.
export async function mismatchPayments(limit = 50) {
  return query(
    `SELECT p.payment_id, p.cabinet_id, c.display_name, p.amount_rub,
            p.raw->'mismatch' AS mismatch, p.created_at
       FROM billing.payments p
       JOIN auth.cabinets c ON c.cabinet_id = p.cabinet_id
      WHERE p.status = 'mismatch'
      ORDER BY p.created_at DESC LIMIT $1`,
    [limit]
  );
}
