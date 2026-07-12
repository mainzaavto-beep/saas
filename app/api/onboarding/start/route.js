// POST /api/onboarding/start — создать кабинет с credentials клиента.
// Тело: { display_name, marketplaces: ['wb'|'ozon'], wb_token?, ozon_client_id?,
//         ozon_api_key?, usn_pct, vat }
// Создаёт auth.cabinets + membership(owner). Сбор данных = Этап 3 (пока создаётся
// только кабинет status='provisioning'; initial resync подвязывается позже).
import { NextResponse } from 'next/server';
import { query } from '@/lib/db.js';
import { getSession } from '@/lib/session.js';

export async function POST(req) {
  const session = await getSession();
  if (!session?.user_id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 }); }

  const userId = session.user_id;
  const displayName = String(body.display_name || '').trim();
  const marketplaces = Array.isArray(body.marketplaces) ? body.marketplaces.filter((m) => ['wb', 'ozon'].includes(m)) : [];
  if (!marketplaces.length) return NextResponse.json({ error: 'Выберите хотя бы один маркетплейс' }, { status: 400 });
  if (!displayName) return NextResponse.json({ error: 'Укажите название кабинета' }, { status: 400 });

  // Собираем полные credentials (для шифрования) и НЕсекретную структуру (api_creds).
  const fullCreds = {};
  const apiCredsMeta = {};  // только флаги наличия, без секретов
  if (marketplaces.includes('wb')) {
    const t = String(body.wb_token || '').trim();
    if (!t) return NextResponse.json({ error: 'Укажите WB Token' }, { status: 400 });
    fullCreds.wb = { token: t };
    apiCredsMeta.wb = { has_token: true };
  }
  if (marketplaces.includes('ozon')) {
    const cid = String(body.ozon_client_id || '').trim();
    const key = String(body.ozon_api_key || '').trim();
    if (!cid || !key) return NextResponse.json({ error: 'Укажите Ozon Client-Id и Api-Key' }, { status: 400 });
    fullCreds.ozon = { client_id: cid, api_key: key };
    apiCredsMeta.ozon = { has_client_id: true, has_api_key: true };
    if (body.ozon_perf_client_id && body.ozon_perf_client_secret) {
      fullCreds.ozon.perf_client_id = String(body.ozon_perf_client_id).trim();
      fullCreds.ozon.perf_client_secret = String(body.ozon_perf_client_secret).trim();
      apiCredsMeta.ozon.has_perf = true;
    }
  }

  const usnPct = Number(body.usn_pct);
  if (Number.isNaN(usnPct) || usnPct < 0 || usnPct > 100) {
    return NextResponse.json({ error: 'Некорректная ставка УСН' }, { status: 400 });
  }
  const taxMode = { usn_pct: usnPct, vat: !!body.vat };

  // 🔒 Шифрование credentials: полные секреты → pgp_sym_encrypt (pgcrypto).
  // Ключ из env SAAS_CRED_MASTER_KEY, НЕ хранится в БД. api_creds (JSONB) хранит
  // только НЕсекретные флаги; api_creds_enc — шифртекст.
  const encKey = process.env.SAAS_CRED_MASTER_KEY;
  if (!encKey) {
    return NextResponse.json({ error: 'Сервер не настроен для хранения ключей (SAAS_CRED_MASTER_KEY)' }, { status: 500 });
  }
  const fullCredsJson = JSON.stringify(fullCreds);

  const { getPool } = await import('@/lib/db.js');
  const pool = getPool();
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const { rows } = await cl.query(
      `INSERT INTO auth.cabinets (owner_user_id, display_name, marketplaces, api_creds, api_creds_enc, tax_mode, status)
       VALUES ($1, $2, $3, $4, pgp_sym_encrypt($5, $6), $7, 'provisioning')
       RETURNING cabinet_id, display_name, marketplaces, status`,
      [userId, displayName, marketplaces, JSON.stringify(apiCredsMeta), fullCredsJson, encKey, JSON.stringify(taxMode)]
    );
    const cabinet = rows[0];
    await cl.query(
      'INSERT INTO auth.memberships (user_id, cabinet_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, cabinet_id) DO NOTHING',
      [userId, cabinet.cabinet_id, 'owner']
    );
    // TODO Этап 3: создать job type='onboarding' для initial resync.
    await cl.query(
      `INSERT INTO jobs.collect_jobs (cabinet_id, job_type, status)
       VALUES ($1, 'onboarding', 'queued')`,
      [cabinet.cabinet_id]
    );
    await cl.query('COMMIT');

    // Обновляем active_cabinet_id в сессии (через res, чтобы cookie улетел).
    session.active_cabinet_id = cabinet.cabinet_id;
    await session.save();

    return NextResponse.json({ ok: true, cabinet });
  } catch (e) {
    try { await cl.query('ROLLBACK'); } catch {}
    return NextResponse.json({ error: 'Ошибка создания кабинета: ' + e.message }, { status: 500 });
  } finally {
    cl.release();
  }
}
