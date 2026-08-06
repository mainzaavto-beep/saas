// lib/mailer.js — отправка писем. SMTP-креды в .env.local:
//   SAAS_SMTP_HOST / SAAS_SMTP_PORT / SAAS_SMTP_USER / SAAS_SMTP_PASS / SAAS_SMTP_FROM
// Пока кредов нет, работает «раковина» (SAAS_MAIL_SINK=1): письмо пишется файлом
// в /tmp/saas-mail и логируется — панель работает, флоу проверяем смоуком.
// Когда SMTP появится, флаг убирается, код не меняется.
import nodemailer from 'nodemailer';
import { mkdirSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';

const SINK_DIR = '/tmp/saas-mail';
let _transport = null;

function transport() {
  if (_transport) return _transport;
  const host = process.env.SAAS_SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SAAS_SMTP_PORT) || 465;
  _transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: process.env.SAAS_SMTP_USER
      ? { user: process.env.SAAS_SMTP_USER, pass: process.env.SAAS_SMTP_PASS }
      : undefined,
  });
  return _transport;
}

export async function sendMail({ to, subject, text }) {
  let tx = null;
  try {
    tx = transport();
  } catch (e) {
    console.error('[mailer] не удалось создать транспорт:', e.message);
    return { ok: false, error: 'Почта настроена неверно' };
  }
  if (!tx) {
    if (process.env.SAAS_MAIL_SINK === '1') {
      try {
        mkdirSync(SINK_DIR, { recursive: true, mode: 0o700 });
        const file = `${SINK_DIR}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
        writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${text}\n`, { mode: 0o600 });
        console.warn('[mailer] SMTP не настроен — письмо записано в', file);
        return { ok: true, sink: file };
      } catch (e) {
        console.error('[mailer] раковина недоступна:', e.message);
        return { ok: false, error: e.message };
      }
    }
    console.error('[mailer] SMTP не настроен, письмо не отправлено:', subject, '→', to);
    return { ok: false, error: 'Почта не настроена' };
  }
  try {
    await tx.sendMail({
      from: process.env.SAAS_SMTP_FROM || 'no-reply@sysell.ru',
      to, subject, text,
    });
    return { ok: true };
  } catch (e) {
    console.error('[mailer]', e.message);
    return { ok: false, error: e.message };
  }
}
