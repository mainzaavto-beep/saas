#!/usr/bin/env node
// scripts/notify-triage.mjs — письма владельцу сервиса о разобранных падениях сборщиков
// (спека docs/superpowers/specs/2026-09-30-failure-triage-design.md §6). Вызывается
// worker/failure_triage.py в конце каждого тика. Одно письмо на эпизод: notified_at
// ставится, если ушло хотя бы одному из получателей (частичный сбой SMTP по одному
// адресату не должен держать эпизод непрочитанным для остальных) — сбой по ВСЕМ
// адресатам считается неудачей эпизода, повтор на следующем тике.
// Получатели — SAAS_OPS_USER_IDS (те же, кому открыт /health).
// closed без report_json (ревью task-9 раунд 1, 01.10.2026) — НЕ отправляем: это эпизод,
// который был в процессе повтора (queued, finished_at от неудачной попытки claude) и
// закрылся сам по возврату сборщика в ok ДО того, как разбор успел дать отчёт; без условия
// report_json IS NOT NULL formatTriageMail получала бы report_json=null и рисовала тему
// «[разбор не удался]», хотя на деле ничего разбирать было уже не нужно — ложная тревога.
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { query } = await import('../lib/db.js');
const { sendMail } = await import('../lib/mailer.js');
const { formatTriageMail } = await import('../lib/triageMail.js');

const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';

// Сначала эпизоды: если разбирать нечего, получателей не трогаем и тихо выходим (T5) —
// это и рабочий путь каждого тика (большинство тиков без новых разборов), и даёт не
// запрашивать SAAS_OPS_USER_IDS/БД пользователей впустую.
const eps = await query(
  `SELECT t.*, r.error AS last_error
     FROM jobs.failure_triage t
     LEFT JOIN jobs.collector_runs r ON r.id = t.last_failed_run_id
    WHERE t.notified_at IS NULL
      AND (t.status IN ('done','error')
           OR (t.status = 'closed' AND t.finished_at IS NOT NULL AND t.report_json IS NOT NULL))
    ORDER BY t.id`
);
if (!eps.length) {
  console.log('notify-triage: нет эпизодов к отправке');
  process.exit(0);
}

const ids = (process.env.SAAS_OPS_USER_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
const to = ids.length
  ? (await query('SELECT email FROM auth.users WHERE user_id = ANY($1::bigint[]) AND email IS NOT NULL', [ids]))
      .map((u) => u.email)
  : [];
if (!to.length) {
  console.error('notify-triage: нет получателей (SAAS_OPS_USER_IDS пуст или без email)');
  process.exit(1);
}

let sent = 0, failed = 0;
for (const ep of eps) {
  const { subject, text } = formatTriageMail(ep, base);
  try {
    // Эпизод считается отправленным, если ушло хотя бы одно письмо — неудачи по остальным
    // адресатам логируются, но не блокируют notified_at (иначе один мёртвый адрес в
    // SAAS_OPS_USER_IDS держал бы эпизод вечно непрочитанным для всех остальных).
    let anyOk = false;
    for (const addr of to) {
      const res = await sendMail({ to: addr, subject, text });
      if (res.ok) {
        anyOk = true;
      } else {
        console.error(`notify-triage: эпизод #${ep.id} не отправлен (${addr}): ${res.error}`);
      }
    }
    if (anyOk) {
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
