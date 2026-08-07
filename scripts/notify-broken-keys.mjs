#!/usr/bin/env node
// scripts/notify-broken-keys.mjs — письмо владельцу кабинета о сломанных ключах.
// Раз в час: магазины в паузе, о которых ещё не писали. Одно письмо на эпизод —
// auth_notified_at сбрасывается только когда магазин снова заработал.
// Воркер писем не шлёт: SMTP настроен в панели (lib/mailer.js), дублировать
// его в Python не нужно.
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { query } = await import('../lib/db.js');
const { sendMail } = await import('../lib/mailer.js');

const MP_NAME = { wb: 'Wildberries', ozon: 'Ozon' };
const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';

const rows = await query(
  `SELECT s.shop_id, s.mp_code, s.shop_name, s.auth_failed_at, s.auth_last_error,
          c.cabinet_id, c.display_name, u.email
     FROM auth.shops s
     JOIN auth.cabinets c ON c.cabinet_id = s.cabinet_id
     JOIN auth.users u ON u.user_id = c.owner_user_id
    WHERE s.is_active = true AND s.auth_state = 'paused' AND s.auth_notified_at IS NULL`
);

let sent = 0, failed = 0;
for (const r of rows) {
  // Бронируем право на отправку: условие в UPDATE закрывает гонку таймера
  // с ручным запуском — второй процесс не получит строку.
  const claimed = await query(
    `UPDATE auth.shops SET auth_notified_at = now()
      WHERE shop_id = $1 AND auth_notified_at IS NULL
      RETURNING shop_id`,
    [r.shop_id]
  );
  if (!claimed.length) continue;   // кто-то уже отправляет это письмо

  const mp = MP_NAME[r.mp_code] || r.mp_code;
  const since = r.auth_failed_at ? new Date(r.auth_failed_at).toLocaleDateString('ru-RU') : '';

  // Убираем из текста внутренний префикс исключения (ozon_client.OzonError: …)
  const humanError = String(r.auth_last_error || '')
    .replace(/^[\w.]+(Error|Exception):\s*/, '')
    .trim() || '—';

  const res = await sendMail({
    to: r.email,
    subject: `SySell: ${mp} — ключи не работают`,
    text: `Здравствуйте!\n\nПанель не может получить данные ${mp} по проекту «${r.display_name}»`
      + `${r.shop_name ? ` (магазин «${r.shop_name}»)` : ''}: маркетплейс отказывает в доступе`
      + `${since ? ` с ${since}` : ''}. Пока ключи не обновлены, отчёты по этому магазину не обновляются.\n\n`
      + `Обновить ключи: ${base}/settings?cabinet=${r.cabinet_id}&tab=settings\n\n`
      + `Что обычно помогает: выпустить новый токен в личном кабинете маркетплейса и`
      + ` проверить, что у него есть нужные права.\n\nПоследняя ошибка: ${humanError}`,
  });

  if (res.ok) {
    sent++;
    console.log(`[notify-keys] письмо отправлено: кабинет ${r.cabinet_id}, магазин ${r.shop_id}`);
  } else {
    // Отправка не удалась — снимаем бронь, иначе клиент не получит письмо никогда.
    await query(`UPDATE auth.shops SET auth_notified_at = NULL WHERE shop_id = $1`, [r.shop_id]);
    failed++;
    console.error(`[notify-keys] не отправлено (кабинет ${r.cabinet_id}): ${res.error}`);
  }
}
console.log(`[notify-keys] в паузе без уведомления: ${rows.length}, отправлено ${sent}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
