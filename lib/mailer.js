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

// Домены, которых по стандарту не существует (RFC 2606/6761): на них наши же
// смоуки регистрируют тестовых пользователей (*@smoke.test), и демо-аккаунты
// сидят на saas.test. Слать туда по-настоящему нельзя: каждое письмо вернётся
// возвратом, а массовые возвраты портят репутацию отправителя и приводят к
// блокировке рассылок. Такие адреса всегда уходят в раковину, даже когда SMTP
// настроен — это не режим отладки, а защита боевой отправки.
const UNDELIVERABLE_TLDS = ['.test', '.invalid', '.example', '.localhost'];

function isUndeliverable(to) {
  const domain = String(to || '').split('@').pop().toLowerCase().trim();
  return UNDELIVERABLE_TLDS.some((tld) => domain === tld.slice(1) || domain.endsWith(tld));
}

function writeToSink(to, subject, text, reason) {
  mkdirSync(SINK_DIR, { recursive: true, mode: 0o700 });
  const file = `${SINK_DIR}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
  writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${text}\n`, { mode: 0o600 });
  console.warn(`[mailer] ${reason} — письмо записано в ${file}`);
  return file;
}

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
  // Проверка до создания транспорта: несуществующий домен не должен доходить
  // до SMTP ни при какой настройке.
  if (isUndeliverable(to)) {
    try {
      return { ok: true, sink: writeToSink(to, subject, text, `адрес ${to} на несуществующем домене`) };
    } catch (e) {
      console.error('[mailer] раковина недоступна:', e.message);
      return { ok: false, error: e.message };
    }
  }
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
        return { ok: true, sink: writeToSink(to, subject, text, 'SMTP не настроен') };
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
