#!/usr/bin/env node
// scripts/notify-broken-keys.mjs — письмо владельцу кабинета о сломанных ключах.
// Раз в час: магазины в паузе ИЛИ отключённые (disabled — контрольные попытки
// паузы исчерпаны, см. worker/shop_auth.py), о которых ещё не писали. Два
// письма на эпизод: №1 при входе в paused, №2 при эскалации в disabled —
// mark_failure сбрасывает auth_notified_at на этом переходе специально для
// второго письма. auth_notified_at сбрасывается в NULL и когда магазин снова
// заработал (одно письмо на эпизод внутри каждого состояния).
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

let rows = [];
try {
  rows = await query(
    `SELECT s.shop_id, s.mp_code, s.shop_name, s.auth_state, s.auth_failed_at, s.auth_last_error,
            c.cabinet_id, c.display_name, u.email
       FROM auth.shops s
       JOIN auth.cabinets c ON c.cabinet_id = s.cabinet_id
       JOIN auth.users u ON u.user_id = c.owner_user_id
      WHERE s.is_active = true AND s.auth_state IN ('paused', 'disabled') AND s.auth_notified_at IS NULL`
  );
} catch (e) {
  console.error(`[notify-keys] не удалось получить список магазинов: ${e.message}`);
  process.exit(1);
}

let sent = 0, failed = 0;
for (const r of rows) {
  try {
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
    const disabled = r.auth_state === 'disabled';

    // Убираем из текста внутренний префикс исключения (ozon_client.OzonError: …)
    const humanError = String(r.auth_last_error || '')
      .replace(/^[\w.]+(Error|Exception):\s*/, '')
      .trim() || '—';

    const res = await sendMail({
      to: r.email,
      subject: disabled
        ? `SySell: ${mp} — сбор данных остановлен`
        : `SySell: ${mp} — ключи не работают`,
      text: (disabled
        ? `Здравствуйте!\n\nСбор данных ${mp} по проекту «${r.display_name}»`
          + `${r.shop_name ? ` (магазин «${r.shop_name}»)` : ''} остановлен — обновите ключи в настройках.`
          + ` Мы регулярно пробовали получить доступ${since ? ` с ${since}` : ''}, но маркетплейс`
          + ` продолжает отказывать, и автоматические попытки прекращены.\n\n`
        : `Здравствуйте!\n\nПанель не может получить данные ${mp} по проекту «${r.display_name}»`
          + `${r.shop_name ? ` (магазин «${r.shop_name}»)` : ''}: маркетплейс отказывает в доступе`
          + `${since ? ` с ${since}` : ''}. Пока ключи не обновлены, отчёты по этому магазину не обновляются.\n\n`)
        + `Обновить ключи: ${base}/settings?cabinet=${r.cabinet_id}&tab=settings\n\n`
        + `Что обычно помогает: выпустить новый токен в личном кабинете маркетплейса и`
        + ` проверить, что у него есть нужные права.\n\nПоследняя ошибка: ${humanError}`,
    });

    if (res.ok) {
      sent++;
      console.log(`[notify-keys] письмо отправлено: кабинет ${r.cabinet_id}, магазин ${r.shop_id}`);
    } else {
      // Отправка не удалась — снимаем бронь, иначе клиент не получит письмо никогда.
      try {
        await query(`UPDATE auth.shops SET auth_notified_at = NULL WHERE shop_id = $1`, [r.shop_id]);
      } catch (e) {
        console.error(`[notify-keys] БРОНЬ НЕ СНЯТА (магазин ${r.shop_id}): ${e.message} — письмо не уйдёт, снимите auth_notified_at вручную`);
      }
      failed++;
      console.error(`[notify-keys] не отправлено (кабинет ${r.cabinet_id}): ${res.error}`);
    }
  } catch (e) {
    // Сбой на одном магазине не должен обрывать рассылку остальным.
    failed++;
    console.error(`[notify-keys] ошибка обработки (кабинет ${r.cabinet_id}, магазин ${r.shop_id}): ${e.message}`);
  }
}
console.log(`[notify-keys] paused/disabled без уведомления: ${rows.length}, отправлено ${sent}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
