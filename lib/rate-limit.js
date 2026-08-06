// lib/rate-limit.js — счётчик попыток в памяти процесса (панель — один инстанс
// Next, внешних зависимостей не заводим). Скользящее окно в 1 минуту.
// Перезапуск сервиса обнуляет счётчики — приемлемо: защищаемся от скриптового
// перебора, а не от терпеливого распределённого.
const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;
const buckets = new Map(); // key → { count, resetAt }

export const LIMITS = {
  loginAccount: Number(process.env.SAAS_RL_LOGIN_ACCOUNT) || 5,   // неудачных входов в минуту на аккаунт
  loginIp: Number(process.env.SAAS_RL_LOGIN_IP) || 20,            // неудачных входов в минуту с IP
  registerIp: Number(process.env.SAAS_RL_REGISTER_IP) || 30,      // регистраций в минуту с IP
  onboardUser: Number(process.env.SAAS_RL_ONBOARD_USER) || 3,     // попыток создать проект в минуту на пользователя
};

function prune(now) {
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

// Реальный IP: Caddy проксирует на localhost и проставляет X-Forwarded-For.
export function clientIp(req) {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'local';
}

// Проверить лимит, НЕ увеличивая счётчик.
export function peek(key, limit) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) return { limited: false, retryAfter: 0 };
  if (b.count >= limit) return { limited: true, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  return { limited: false, retryAfter: 0 };
}

// Засчитать попытку.
export function hit(key, limit) {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) prune(now);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { limited: false, retryAfter: 0 };
  }
  b.count += 1;
  if (b.count > limit) return { limited: true, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  return { limited: false, retryAfter: 0 };
}

export function reset(key) { buckets.delete(key); }
