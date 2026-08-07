// lib/yookassa.js — единственное место, где панель общается с ЮKassa.
// Пока боевых ключей нет, работает мок (SAAS_YOOKASSA_MOCK=1): платёж
// «создаётся» локально, а подтверждается страницей-заглушкой. Флоу целиком
// проверяется смоуком; при появлении ключей флаг убирается, код не меняется.
import crypto from 'node:crypto';

const API = 'https://api.yookassa.ru/v3/payments';

// Ограничение на ожидание провайдера: без него зависший запрос держит
// соединение пула и блокировку кабинета неопределённо долго.
const TIMEOUT_MS = Number(process.env.SAAS_YOOKASSA_TIMEOUT_MS) || 15000;

export function isMock() {
  return process.env.SAAS_YOOKASSA_MOCK === '1' && !process.env.SAAS_YOOKASSA_SHOP_ID;
}

export function isConfigured() {
  return isMock() || Boolean(process.env.SAAS_YOOKASSA_SHOP_ID && process.env.SAAS_YOOKASSA_SECRET_KEY);
}

function authHeader() {
  const raw = `${process.env.SAAS_YOOKASSA_SHOP_ID}:${process.env.SAAS_YOOKASSA_SECRET_KEY}`;
  return 'Basic ' + Buffer.from(raw).toString('base64');
}

// Сумма всегда строкой с двумя знаками: float в деньгах недопустим.
const money = (rub) => Number(rub).toFixed(2);

export async function createPayment({ amountRub, description, returnUrl, idempotenceKey, customerEmail }) {
  if (isMock()) {
    const id = 'mock-' + crypto.randomUUID();
    const base = process.env.NEXT_PUBLIC_URL || 'https://sysell.ru';
    return { id, status: 'pending', confirmation_url: `${base}/billing/mock?payment=${id}` };
  }
  const body = {
    amount: { value: money(amountRub), currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: returnUrl },
    description,
    receipt: {
      customer: { email: customerEmail },
      items: [{
        description,
        quantity: '1.00',
        amount: { value: money(amountRub), currency: 'RUB' },
        vat_code: Number(process.env.SAAS_YOOKASSA_VAT_CODE) || 1, // 1 = без НДС
        payment_mode: 'full_payment',
        payment_subject: 'service',
      }],
    },
  };
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotenceKey,
        Authorization: authHeader(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'ЮKassa не отвечает' : `ЮKassa недоступна: ${e.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`ЮKassa ${res.status}: ${json?.description || 'ошибка создания платежа'}`);
  }
  return { id: json.id, status: json.status, confirmation_url: json.confirmation?.confirmation_url };
}

// Перепроверка платежа у провайдера. Единственный источник правды о том,
// прошли ли деньги: телу вебхука и возврату из браузера доверять нельзя.
export async function getPayment(id) {
  if (isMock()) {
    // В моке правду хранит наша же таблица: страница-заглушка помечает
    // платёж как оплаченный в raw.mock_status.
    const { query } = await import('./db.js');
    const rows = await query(`SELECT amount_rub, raw FROM billing.payments WHERE payment_id = $1`, [id]);
    if (!rows.length) return null;
    const status = rows[0].raw?.mock_status || 'pending';
    return { id, status, amount_rub: rows[0].amount_rub, paid: status === 'succeeded' };
  }
  let res;
  try {
    res = await fetch(`${API}/${encodeURIComponent(id)}`, {
      headers: { Authorization: authHeader() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'ЮKassa не отвечает' : `ЮKassa недоступна: ${e.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ЮKassa ${res.status}: ${json?.description || 'ошибка запроса платежа'}`);
  return { id: json.id, status: json.status, amount_rub: json.amount?.value, paid: json.status === 'succeeded' && json.paid === true };
}
