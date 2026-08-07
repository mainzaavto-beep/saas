// POST /api/billing/webhook/<secret> — уведомление от ЮKassa.
// Уведомления не подписываются, поэтому телу не верим: секрет в URL отсекает
// случайных гостей, список сетей — посторонние адреса, а решает всё
// перепроверка платежа через API провайдера внутри creditPayment.
import { NextResponse } from 'next/server';
import { creditPayment } from '@/lib/billing-credit.js';
import { query } from '@/lib/db.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Сети ЮKassa (список из их документации, переопределяется через env).
const DEFAULT_NETS = ['185.71.76.', '185.71.77.', '77.75.153.', '77.75.156.', '77.75.154.', '77.75.155.', '2a02:5180:'];

function ipInfo(req) {
  const nets = (process.env.SAAS_YOOKASSA_IPS || DEFAULT_NETS.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return { nets, ip };
}

function allowedIp(req, { nets, ip }) {
  if (process.env.SAAS_YOOKASSA_MOCK === '1') return true; // мок ходит с localhost
  return nets.some((n) => ip.startsWith(n));
}

export async function POST(req, { params }) {
  const secret = process.env.SAAS_YOOKASSA_WEBHOOK_SECRET;
  // Неверный секрет — 404, а не 403: адрес вебхука не должен подтверждаться.
  if (!secret || params.secret !== secret) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const info = ipInfo(req);
  if (!allowedIp(req, info)) {
    // Пишем и что пришло, и с чем сравнивали — иначе при боевом запуске
    // непонятно, обновился ли список сетей ЮKassa или проблема в другом.
    console.warn('[billing webhook] чужой адрес', info.ip || '(пусто — X-Forwarded-For не пришёл)', '— сверяли со списком сетей:', info.nets.join(', '));
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }
  const paymentId = body?.object?.id;
  if (!paymentId) return NextResponse.json({ ok: true, ignored: 'нет id платежа' });

  // Тело сохраняем как есть — пригодится при разборе спорных случаев.
  await query(
    `UPDATE billing.payments SET raw = coalesce(raw,'{}'::jsonb) || $2::jsonb, updated_at = now()
      WHERE payment_id = $1`,
    [paymentId, JSON.stringify({ webhook: body })]
  ).catch((e) => console.error('[billing webhook] не удалось сохранить тело', e.message));

  if (body?.event !== 'payment.succeeded') return NextResponse.json({ ok: true, ignored: body?.event });

  try {
    const res = await creditPayment(paymentId);
    // Всегда 200: провайдер иначе будет слать повторы, а разбираться нам всё
    // равно по журналу и скрипту сверки.
    return NextResponse.json({ ok: true, credited: res.ok });
  } catch {
    return NextResponse.json({ ok: true, credited: false });
  }
}
