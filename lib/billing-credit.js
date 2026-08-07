// lib/billing-credit.js — зачисление платежа. Одна точка входа и для вебхука,
// и для скрипта сверки: логика продления не должна существовать в двух копиях.
import { getPool } from './db.js';
import { getPayment } from './yookassa.js';
import { extendPaidUntil } from './billing.js';

// Идемпотентно: продлевает подписку не более одного раза на платёж.
// Возвращает { ok, reason?, paid_until? }.
export async function creditPayment(paymentId) {
  const provider = await getPayment(paymentId);
  if (!provider) return { ok: false, reason: 'платёж не найден у провайдера' };
  if (!provider.paid) return { ok: false, reason: `платёж не оплачен (${provider.status})` };

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Блокируем строку платежа: два одновременных уведомления не пройдут оба.
    const rows = await client.query(
      `SELECT payment_id, cabinet_id, months, amount_rub, status
         FROM billing.payments WHERE payment_id = $1 FOR UPDATE`,
      [paymentId]
    );
    if (!rows.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'платёж не найден в журнале' }; }
    const p = rows.rows[0];
    if (p.status === 'succeeded') { await client.query('ROLLBACK'); return { ok: true, already: true }; }

    // Сумма провайдера обязана совпасть с нашей ценой. Не совпало — денег не
    // зачисляем и помечаем платёж как требующий разбора: статус succeeded
    // выглядел бы как обычная оплата и терялся среди нормальных.
    if (Number(provider.amount_rub) !== Number(p.amount_rub)) {
      await client.query(
        `UPDATE billing.payments SET status = 'mismatch', updated_at = now(),
                raw = coalesce(raw,'{}'::jsonb) || $2::jsonb
          WHERE payment_id = $1`,
        [paymentId, JSON.stringify({ mismatch: { expected: p.amount_rub, got: provider.amount_rub } })]
      );
      await client.query('COMMIT');
      console.error('[billing] сумма не совпала', paymentId, 'ждали', p.amount_rub, 'пришло', provider.amount_rub);
      return { ok: false, reason: 'сумма не совпадает' };
    }

    const cab = (await client.query(
      `SELECT trial_ends_at, paid_until FROM auth.cabinets WHERE cabinet_id = $1 FOR UPDATE`,
      [p.cabinet_id]
    )).rows[0];
    const next = extendPaidUntil(cab, p.months);

    await client.query(`UPDATE auth.cabinets SET paid_until = $1 WHERE cabinet_id = $2`, [next, p.cabinet_id]);
    await client.query(
      `UPDATE billing.payments
          SET status = 'succeeded', paid_until_before = $2, paid_until_after = $3, updated_at = now()
        WHERE payment_id = $1`,
      [paymentId, cab.paid_until, next]
    );
    await client.query('COMMIT');
    return { ok: true, paid_until: next };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[billing] зачисление не удалось', paymentId, e.message);
    throw e;
  } finally {
    client.release();
  }
}
