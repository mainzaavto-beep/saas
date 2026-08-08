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
  shopSaveUser: Number(process.env.SAAS_RL_SHOP_SAVE_USER) || 10,  // сохранений магазина в минуту на пользователя
  emailChangeUser: Number(process.env.SAAS_RL_EMAIL_CHANGE_USER) || 3,  // смен неподтверждённого адреса в час на пользователя
  emailAttemptUser: Number(process.env.SAAS_RL_EMAIL_ATTEMPT_USER) || 30, // ЛЮБЫХ попыток PUT /api/auth/email в час на пользователя (успех + 400 + 409) — без refund, иначе счётчик успешных смен превращается в бесплатный оракул занятости чужих адресов
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

// Проверить лимит, НЕ увеличивая счётчик. windowMs — по умолчанию минута;
// шире окно (напр. час для emailChangeUser) передаётся явно третьим
// аргументом, а не через гранулярность ключа — см. hit() ниже.
export function peek(key, limit, windowMs = WINDOW_MS) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) return { limited: false, retryAfter: 0 };
  if (b.count >= limit) return { limited: true, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  return { limited: false, retryAfter: 0 };
}

// Засчитать попытку. windowMs задаёт длину окна для этого конкретного счётчика
// (по умолчанию минута, как раньше). Важно: гранулярность самого КЛЮЧА тут
// роли не играет — окно живёт `windowMs` от последнего сброса бакета
// независимо от того, что зашито в ключе. Кодировать «час» только в ключе
// (напр. `${...}:${Math.floor(Date.now()/3_600_000)}`) не работает: бакет
// всё равно обнулится через минуту после создания, и лимит фактически станет
// «N за минуту, повторяемо», а не «N за час» — поэтому здесь окно передаём
// явно.
export function hit(key, limit, windowMs = WINDOW_MS) {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) prune(now);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false, retryAfter: 0 };
  }
  b.count += 1;
  if (b.count > limit) return { limited: true, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  return { limited: false, retryAfter: 0 };
}

export function reset(key) { buckets.delete(key); }

// Вернуть попытку, которую hit() списал заранее, но действие не состоялось
// (напр. 400/409 в PUT /api/auth/email — юзер не виноват, что адрес занят
// или опечатался). НЕ трогает resetAt: окно не продлевается и не
// сокращается — это только поправка count, а не новый бакет. Не уходит
// ниже 0 (двойной refund безопасен). Если бакета уже нет (окно само
// истекло) — тихо no-op, возвращать нечего.
export function refund(key) {
  const b = buckets.get(key);
  if (!b) return;
  b.count = Math.max(0, b.count - 1);
}
