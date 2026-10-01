#!/usr/bin/env node
// scripts/notify-triage.mjs — письма владельцу сервиса о разобранных падениях сборщиков
// (спека docs/superpowers/specs/2026-09-30-failure-triage-design.md §6). Вызывается
// worker/failure_triage.py в конце каждого тика. Одно письмо на эпизод: notified_at
// ставится только после успешной отправки, сбой SMTP — повтор на следующем тике.
// Получатели — SAAS_OPS_USER_IDS (те же, кому открыт /health).
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { query } = await import('../lib/db.js');
const { sendMail } = await import('../lib/mailer.js');
const { formatTriageMail } = await import('../lib/triageMail.js');

const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';
const ids = (process.env.SAAS_OPS_USER_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);

const to = ids.length
  ? (await query('SELECT email FROM auth.users WHERE user_id = ANY($1::bigint[]) AND email IS NOT NULL', [ids]))
      .map((u) => u.email)
  : [];
if (!to.length) {
  console.error('notify-triage: нет получателей (SAAS_OPS_USER_IDS пуст или без email)');
  process.exit(1);
}

const eps = await query(
  `SELECT t.*, r.error AS last_error
     FROM jobs.failure_triage t
     LEFT JOIN jobs.collector_runs r ON r.id = t.last_failed_run_id
    WHERE t.notified_at IS NULL
      AND (t.status IN ('done','error') OR (t.status = 'closed' AND t.finished_at IS NOT NULL))
    ORDER BY t.id`
);

let sent = 0, failed = 0;
for (const ep of eps) {
  const { subject, text } = formatTriageMail(ep, base);
  try {
    let allOk = true;
    for (const addr of to) {
      const res = await sendMail({ to: addr, subject, text });
      if (!res.ok) {
        console.error(`notify-triage: эпизод #${ep.id} не отправлен (${addr}): ${res.error}`);
        allOk = false;
      }
    }
    if (allOk) {
      await query('UPDATE jobs.failure_triage SET notified_at = now() WHERE id = $1', [ep.id]);
      sent++;
    } else {
      failed++;
    }
  } catch (e) {
    console.error(`notify-triage: эпизод #${ep.id} ошибка обработки: ${e.message}`);
    failed++;
  }
}
console.log(`notify-triage: отправлено ${sent} из ${eps.length}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
