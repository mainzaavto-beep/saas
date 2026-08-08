// scripts/lib/mail-verify.mjs — общий доступ к «почтовой раковине» /tmp/saas-mail
// и подтверждение email тем же путём, которым идёт живой клиент.
//
// SAAS_REQUIRE_VERIFIED_EMAIL=1 закрывает часть действий (сохранение ключей
// магазина, приглашение сотрудника, оплата подписки) до подтверждения почты
// владельца — см. lib/withCabinet.js. Смоуки регистрируют тестовых юзеров на
// *@smoke.test, и lib/mailer.js всегда шлёт им письма в раковину, а не в SMTP
// (несуществующий домен). Отсюда берём токен и вызываем публичный
// /api/auth/verify — ровно то, что делает пользователь по ссылке из письма.
//
// Изначально реализовано в scripts/smoke-auth-phase3.mjs; вынесено сюда,
// чтобы остальные фазы не подставляли email_verified_at в обход продукта.
import { readFileSync, readdirSync, existsSync } from 'node:fs';

export const SINK_DIR = '/tmp/saas-mail';

// Последнее письмо для адреса из раковины: возвращает текст или null.
export function lastMailFor(email) {
  if (!existsSync(SINK_DIR)) return null;
  const files = readdirSync(SINK_DIR)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => `${SINK_DIR}/${f}`)
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const body = readFileSync(files[i], 'utf8');
    if (body.includes(email)) return body;
  }
  return null;
}

export function tokenFrom(mailBody, path) {
  const m = mailBody && mailBody.match(new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
}

// Подтверждает почту адреса `email` штатным путём продукта: достаёт токен из
// письма в раковине и вызывает POST /api/auth/verify — тот же эндпоинт, что и
// ссылка в реальном письме. `apiFn` — локальная функция api(method, path, opts)
// вызывающего скрипта (нужна, чтобы использовать тот же BASE и формат ответа).
// Бросает исключение с понятным текстом, если письмо/токен не нашлись или
// подтверждение не прошло — вызывающий смоук должен упасть, а не тихо продолжить.
export async function verifyEmailViaSink(apiFn, email) {
  const mail = lastMailFor(email);
  if (!mail) throw new Error(`нет письма с подтверждением для ${email} в ${SINK_DIR}`);
  const token = tokenFrom(mail, '/verify');
  if (!token) throw new Error(`в письме для ${email} нет ссылки /verify?token=`);
  const res = await apiFn('POST', '/api/auth/verify', { body: { token } });
  if (res.status !== 200) {
    throw new Error(`подтверждение email для ${email} не прошло: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res;
}
