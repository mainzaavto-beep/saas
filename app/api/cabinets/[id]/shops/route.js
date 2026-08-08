// /api/cabinets/[id]/shops — управление магазинами проекта.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery } from "@/lib/db.js";
import { normalizeTaxMode } from "@/lib/tax.js";
import { KNOWN_MP, MAX_SHOPS_PER_CABINET, BACKFILL_DAYS } from "@/lib/mpConfig.js";
import { validateShopCreds } from "@/lib/mpValidate.js";
import { hit, LIMITS } from "@/lib/rate-limit.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Все мутации идут через tenantQuery — он пишет в ТОТ ЖЕ клиент транзакции withTenant
// (ALS-контекст), значит INSERT shop + resync marketplaces + onboarding-job
// выполняются атомарно (BEGIN…COMMIT в lib/db.js withTenant). auth.* и jobs.*
// без RLS — GUC app.cabinet_id на них не влияет.
// (query() из lib/db.js, напротив, берёт СВОЙ клиент pool — это были бы отдельные
// auto-commit транзакции, без атомарности.)

// Пересчёт auth.cabinets.marketplaces по актуальным активным shops кабинета.
// marketplaces[] — это то, по чему воркер выбирает сборщики (_collectors_for_marketplaces).
// Если не держать поле актуальным, добавление Ozon-магазина в WB-кабинет НЕ запустит
// сбор Ozon. Вызывается после INSERT/DELETE магазина.
async function resyncMarketplaces(cabinetId) {
  await tenantQuery(
    `UPDATE auth.cabinets c
     SET marketplaces = COALESCE(
       (SELECT array_agg(DISTINCT mp_code ORDER BY mp_code)
        FROM auth.shops WHERE cabinet_id = c.cabinet_id AND is_active),
       ARRAY[]::text[]
     )
     WHERE c.cabinet_id = $1`,
    [cabinetId]
  );
}

// Создать onboarding-job (backfill за BACKFILL_DAYS), который подхватит таймер
// saas-backfill (orchestrator --drain-queue). date_to = вчера — за сегодня данные
// доберёт ежедневный таймер. Дубликат логики дат из api/onboarding/start.
function makeBackfillDateRange() {
  const from = new Date(Date.now() - BACKFILL_DAYS * 86400000);
  const to = new Date(Date.now() - 86400000); // вчера
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return [fmt(from), fmt(to)];
}

export const GET = withCabinet(async (req, { cabinet }) => {
  const rows = await tenantQuery(
    `SELECT shop_id, mp_code, shop_name, legal_name, tax_mode,
            CASE WHEN api_creds_enc IS NOT NULL THEN true ELSE false END AS has_creds,
            is_active, created_at
     FROM auth.shops WHERE cabinet_id = $1 ORDER BY shop_id`,
    [cabinet.cabinet_id]
  );
  // Нормализовать tax_mode для фронта.
  const items = rows.map((r) => ({ ...r, tax_mode: normalizeTaxMode(r.tax_mode) }));
  return NextResponse.json({ items });
});

export const POST = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json();
  if (!b.mp_code) return NextResponse.json({ error: "mp_code required" }, { status: 400 });
  if (!KNOWN_MP.includes(b.mp_code)) {
    return NextResponse.json({ error: `Неизвестный маркетплейс: ${b.mp_code}` }, { status: 400 });
  }

  // Лимит магазинов на проект — общий по всем МП (любая комбинация WB/Ozon).
  const cnt = await tenantQuery(
    `SELECT count(*)::int AS n FROM auth.shops WHERE cabinet_id = $1 AND is_active`,
    [cabinet.cabinet_id]
  );
  if ((cnt[0]?.n || 0) >= MAX_SHOPS_PER_CABINET) {
    return NextResponse.json(
      { error: `Максимум ${MAX_SHOPS_PER_CABINET} магазина на проект` },
      { status: 400 }
    );
  }

  // Проверяем ключи до сохранения: молча принятый нерабочий ключ оборачивается
  // пустыми отчётами через несколько часов, и виноватым выглядит сервис.
  // Форма проверки — сохранение магазина, поэтому лимит на пользователя: иначе
  // это бесплатный перебор чужих ключей нашими руками.
  const rl = hit(`shop-save:user:${session.user_id}`, LIMITS.shopSaveUser);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Слишком много попыток. Подождите минуту.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter || 60) } }
    );
  }
  let credsWarning = null;
  const credsForCheck = b.api_creds?.[b.mp_code];
  if (credsForCheck && Object.keys(credsForCheck).length > 0) {
    const v = await validateShopCreds({ mpCode: b.mp_code, creds: credsForCheck });
    if (!v.ok) {
      const problems = v.checks.filter((c) => !c.ok && c.fatal);
      return NextResponse.json(
        { error: problems.map((c) => c.message).join(' '), code: 'mp_creds_invalid', checks: v.checks },
        { status: 422 }
      );
    }
    if (v.unreachable) {
      credsWarning = 'Проверить ключи сейчас не удалось — маркетплейс не отвечает. Мы сохранили их и попробуем собрать данные; если ключи неверны, вы увидите это в течение часа.';
    } else {
      const soft = v.checks.filter((c) => !c.ok && !c.fatal);
      if (soft.length) credsWarning = soft.map((c) => c.message).join(' ');
    }
  }

  // Шифрование API-кредов если есть.
  let apiCredsEnc = null;
  if (b.api_creds && Object.keys(b.api_creds).length > 0) {
    const masterKey = process.env.SAAS_CRED_MASTER_KEY;
    if (masterKey) {
      // ::text — серверный cast bytea→text даёт hex-форму ('\xc30d...'), совместимый
      // с text-колонкой. Без cast node-pg шлёт сырой bytea-буфер → PG валидирует его
      // как UTF-8 и падает «invalid byte sequence ... 0xc3 0x0d». См. _init_owner.py
      // (там шифрование SQL-side, потому и работает). Формат = формату cabinet #1.
      const encRows = await tenantQuery(`SELECT pgp_sym_encrypt($1, $2)::text AS enc`, [JSON.stringify(b.api_creds), masterKey]);
      apiCredsEnc = encRows[0]?.enc;
    }
  }
  // Метаданные (не секретные).
  const apiMeta = {};
  if (b.api_creds) {
    for (const [mp, creds] of Object.entries(b.api_creds)) {
      apiMeta[mp] = {};
      for (const k of Object.keys(creds)) apiMeta[mp][`has_${k}`] = true;
    }
  }

  const rows = await tenantQuery(
    `INSERT INTO auth.shops (cabinet_id, mp_code, shop_name, legal_name, api_creds, api_creds_enc, tax_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING shop_id`,
    [cabinet.cabinet_id, b.mp_code, b.shop_name || null, b.legal_name || null,
     JSON.stringify(apiMeta), apiCredsEnc, JSON.stringify(normalizeTaxMode(b.tax_mode))]
  );

  // Держать cabinet.marketplaces актуальным — иначе воркер не запустит сбор
  // для нового МП (выбирает сборщики по marketplaces[]).
  await resyncMarketplaces(cabinet.cabinet_id);

  // Backfill за BACKFILL_DAYS — подхватит таймер saas-backfill (drain-queue).
  // Прогон всего кабинета; сборщики идемпотентны (ON CONFLICT), существующие
  // данные не портятся.
  const [dateFrom, dateTo] = makeBackfillDateRange();
  await tenantQuery(
    `INSERT INTO jobs.collect_jobs (cabinet_id, job_type, date_from, date_to, status)
     VALUES ($1, 'onboarding', $2, $3, 'queued')`,
    [cabinet.cabinet_id, dateFrom, dateTo]
  );

  return NextResponse.json({ ok: true, shop_id: rows[0]?.shop_id, warning: credsWarning });
}, { requireRole: 'owner', requireVerifiedEmail: true });

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const shopId = url.searchParams.get("shop_id");
  if (!shopId) return NextResponse.json({ error: "shop_id required" }, { status: 400 });
  await tenantQuery(`DELETE FROM auth.shops WHERE shop_id = $1 AND cabinet_id = $2`, [Number(shopId), cabinet.cabinet_id]);
  // Удержать cabinet.marketplaces в консистентности с оставшимися shops.
  await resyncMarketplaces(cabinet.cabinet_id);
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });

// PUT — обновить API-ключи и/или налоговый режим магазина.
// Тело: { shop_id, api_creds?, tax_mode? }
export const PUT = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json();
  if (!b.shop_id) return NextResponse.json({ error: "shop_id required" }, { status: 400 });

  const sets = [];
  const vals = [];
  let i = 0;
  let putWarning = null;

  // API-креды (шифрование через pgcrypto).
  if (b.api_creds) {
    const encKey = process.env.SAAS_CRED_MASTER_KEY;
    if (!encKey) return NextResponse.json({ error: "SAAS_CRED_MASTER_KEY not set" }, { status: 500 });

    const shopRows = await tenantQuery(
      `SELECT mp_code FROM auth.shops WHERE shop_id = $1 AND cabinet_id = $2`,
      [Number(b.shop_id), cabinet.cabinet_id]
    );
    if (!shopRows.length) return NextResponse.json({ error: 'Магазин не найден' }, { status: 404 });
    const mpCode = shopRows[0].mp_code;
    const rl = hit(`shop-save:user:${session.user_id}`, LIMITS.shopSaveUser);
    if (rl.limited) {
      return NextResponse.json(
        { error: 'Слишком много попыток. Подождите минуту.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfter || 60) } }
      );
    }
    const credsForCheck = b.api_creds?.[mpCode];
    if (credsForCheck && Object.keys(credsForCheck).length > 0) {
      const v = await validateShopCreds({ mpCode, creds: credsForCheck });
      if (!v.ok) {
        const problems = v.checks.filter((c) => !c.ok && c.fatal);
        return NextResponse.json(
          { error: problems.map((c) => c.message).join(' '), code: 'mp_creds_invalid', checks: v.checks },
          { status: 422 }
        );
      }
      if (v.unreachable) {
        putWarning = 'Проверить ключи сейчас не удалось — маркетплейс не отвечает. Мы сохранили их и попробуем собрать данные.';
      }
    }

    const encRows = await tenantQuery(`SELECT pgp_sym_encrypt($1, $2)::text AS enc`, [JSON.stringify(b.api_creds), encKey]);
    const apiCredsEnc = encRows[0]?.enc;
    const apiMeta = {};
    for (const [mp, creds] of Object.entries(b.api_creds)) {
      apiMeta[mp] = {};
      for (const k of Object.keys(creds)) apiMeta[mp][`has_${k}`] = true;
    }
    sets.push(`api_creds = $${++i}`); vals.push(JSON.stringify(apiMeta));
    sets.push(`api_creds_enc = $${++i}`); vals.push(apiCredsEnc);
    // Новые ключи — повод дать магазину ещё один шанс немедленно, не дожидаясь
    // суточной контрольной попытки воркера. Но пауза снимается только если
    // реально передали непустые ключи: иначе пустой объект «чинил» бы магазин,
    // не задав ничего рабочего (форма шлёт { [mp_code]: { client_id, api_key, ... } },
    // прямой вызов API мог бы прислать {} или пустые строки).
    const credsFilled = b.api_creds && typeof b.api_creds === 'object'
      && Object.values(b.api_creds).some((v) => typeof v === 'object' && v
        ? Object.values(v).some((x) => String(x || '').trim())
        : String(v || '').trim());
    if (credsFilled) {
      sets.push(`auth_state = 'ok'`);
      sets.push(`auth_fail_count = 0`);
      sets.push(`auth_last_error = NULL`);
      sets.push(`auth_notified_at = NULL`);
    }
  }

  // Налоговый режим.
  if (b.tax_mode !== undefined) {
    sets.push(`tax_mode = $${++i}`);
    vals.push(JSON.stringify(normalizeTaxMode(b.tax_mode)));
  }

  if (!sets.length) return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  vals.push(Number(b.shop_id), cabinet.cabinet_id);
  await tenantQuery(
    `UPDATE auth.shops SET ${sets.join(", ")} WHERE shop_id = $${vals.length - 1} AND cabinet_id = $${vals.length}`,
    vals
  );
  return NextResponse.json({ ok: true, warning: putWarning });
}, { requireRole: 'owner', requireVerifiedEmail: true });
