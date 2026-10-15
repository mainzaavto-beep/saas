// lib/paymentCalendarData.js — данные платёжного календаря (15.10.2026). Все функции — внутри
// withTenant (одна транзакция роута); запросы последовательно. Спека
// docs/superpowers/specs/2026-10-15-payment-calendar-design.md §2.
import { tenantQuery, query, DatabaseSync } from "./db.js";
import { purchasePayments, expandRecurring, wbPayoutWindows, ozPayoutWindows, readPayoutSettings, addDays } from "./paymentCalendar.js";
import { wbCashPayoutByWeek } from "./wbMetrics.js";
import { ozPayoutByDay } from "./ozonMetrics.js";

const COLS = `id, date, type, amount::float8 AS amount, amount_planned::float8 AS amount_planned, category,
  counterparty, description, status, source_kind, source_ref, date_locked, paid_at`;

export async function syncPurchasePayments(purchaseId) {
  const p = (await tenantQuery(`SELECT * FROM tenant.purchases WHERE id = $1`, [purchaseId]))[0];
  if (!p || p.deleted_at) return { upserted: 0, archived: await archivePurchasePayments(purchaseId) };
  const want = purchasePayments(p);
  const existing = await tenantQuery(
    `SELECT id, source_ref, status, date_locked FROM tenant.dds_movements
      WHERE source_kind = 'purchase' AND source_ref LIKE $1 AND status <> 'archived'`, [`purchase:${purchaseId}:%`]);
  const byRef = new Map(existing.map((r) => [r.source_ref, r]));
  let upserted = 0, archived = 0;
  for (const w of want) {
    const cur = byRef.get(w.ref);
    byRef.delete(w.ref);
    if (!cur) {
      await tenantQuery(
        `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, category, counterparty,
           description, status, source, source_kind, source_ref)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, 'expense', $2, $2, $3, $4, $5, 'planned', 'purchase', 'purchase', $6)`,
        [w.date, w.amount, w.category, p.supplier_name || null, w.description, w.ref]);
      upserted++;
    } else if (cur.status === "planned") {
      await tenantQuery(
        `UPDATE tenant.dds_movements SET amount = $1, amount_planned = $1, counterparty = $2, description = $3,
            date = CASE WHEN date_locked THEN date ELSE $4 END, updated_at = now() WHERE id = $5`,
        [w.amount, p.supplier_name || null, w.description, w.date, cur.id]);
      upserted++;
    }
  }
  for (const stale of byRef.values()) {
    if (stale.status !== "planned") continue; // оплаченное не трогаем
    await tenantQuery(`UPDATE tenant.dds_movements SET status = 'archived', updated_at = now() WHERE id = $1`, [stale.id]);
    archived++;
  }
  return { upserted, archived };
}

export async function archivePurchasePayments(purchaseId) {
  const r = await tenantQuery(
    `UPDATE tenant.dds_movements SET status = 'archived', updated_at = now()
      WHERE source_kind = 'purchase' AND source_ref LIKE $1 AND status = 'planned' RETURNING id`,
    [`purchase:${purchaseId}:%`]);
  return r.length;
}

export async function ensureRecurring(today, horizonDays = 92) {
  const to = addDays(today, horizonDays);
  const tpls = await tenantQuery(`SELECT * FROM tenant.dds_recurring WHERE is_active`);
  let n = 0;
  for (const t of tpls) {
    const tpl = { ...t, date_from: String(t.date_from).slice(0, 10), date_to: t.date_to ? String(t.date_to).slice(0, 10) : null };
    for (const d of expandRecurring(tpl, today, to)) {
      const r = await tenantQuery(
        `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, category, counterparty,
           description, status, source, source_kind, source_ref)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $3, $4, $5, $6, 'planned', 'recurring', 'recurring', $7)
         ON CONFLICT DO NOTHING RETURNING id`,
        [d, t.type, Number(t.amount), t.category, t.counterparty, t.description, `recurring:${t.id}:${d}`]);
      n += r.length;
    }
  }
  return n;
}

export async function loadMonth({ cabinetId, month, kind, today }) {
  await ensureRecurring(today);
  const from = month + "-01";
  const to = addDays(addDays(from, 40).slice(0, 7) + "-01", -1);
  // сетка показывает соседние дни → берём с запасом в неделю
  const gFrom = addDays(from, -7), gTo = addDays(to, 7);
  const type = kind === "income" ? "income" : "expense";
  const rows = await tenantQuery(
    `SELECT ${COLS} FROM tenant.dds_movements
      WHERE status <> 'archived' AND type = $1 AND date >= $2 AND date <= $3 ORDER BY date, id`, [type, gFrom, gTo]);
  if (type !== "income") return { rows, forecasts: [] };

  const settings = readPayoutSettings((await query(`SELECT settings FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]))[0]?.settings);
  const mps = (await query(`SELECT DISTINCT mp_code FROM auth.shops WHERE cabinet_id = $1 AND is_active`, [cabinetId])).map((r) => r.mp_code);
  const taken = new Set((await tenantQuery(
    `SELECT source_ref FROM tenant.dds_movements WHERE source_kind = 'mp_payout' AND status <> 'archived'`)).map((r) => r.source_ref));
  const forecasts = [];
  if (mps.includes("wb")) {
    const wins = wbPayoutWindows(gFrom, gTo, settings.wb).filter((w) => !taken.has(w.ref));
    if (wins.length) {
      const weeks = await wbCashPayoutByWeek(new DatabaseSync("wb"), { from: wins[0].winFrom, to: wins[wins.length - 1].winTo });
      for (const w of wins) {
        const wk = weeks.find((x) => x.week === w.winFrom);
        if (!wk) continue;
        forecasts.push({ ref: w.ref, platform: "wb", date: w.payDate, amount: wk.amount, winFrom: w.winFrom, winTo: w.winTo, accruing: w.winTo >= today });
      }
    }
  }
  if (mps.includes("ozon")) {
    const wins = ozPayoutWindows(gFrom, gTo, settings.ozon).filter((w) => !taken.has(w.ref));
    if (wins.length) {
      const days = await ozPayoutByDay(new DatabaseSync("ozon"), { from: wins[0].winFrom, to: wins[wins.length - 1].winTo });
      for (const w of wins) {
        const inWin = days.filter((d) => d.date >= w.winFrom && d.date <= w.winTo);
        if (!inWin.length) continue;
        const amount = Math.round(inWin.reduce((s, d) => s + d.amount, 0) * 100) / 100;
        forecasts.push({ ref: w.ref, platform: "ozon", date: w.payDate, amount, winFrom: w.winFrom, winTo: w.winTo, accruing: w.winTo >= today });
      }
    }
  }
  return { rows, forecasts };
}

const num = (v) => Math.round(Number(v) * 100) / 100;
function validMovement(b) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ""))) return "дата обязательна (YYYY-MM-DD)";
  if (!["income", "expense"].includes(b.type)) return "type: income|expense";
  if (!(Number(b.amount) > 0)) return "сумма должна быть больше 0";
  return null;
}

export async function createMovement(b) {
  const err = validMovement(b); if (err) throw Object.assign(new Error(err), { status: 400 });
  const r = await tenantQuery(
    `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, category, counterparty,
       description, status, source, source_kind, paid_at)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $3, $4, $5, $6, $7, 'manual', 'manual',
             CASE WHEN $7 = 'paid' THEN now() END) RETURNING id`,
    [b.date, b.type, num(b.amount), b.category || null, b.counterparty || null, b.description || null, b.paid ? "paid" : "planned"]);
  return r[0].id;
}

// Правка строки. Из «Закупок» сумма/статья/контрагент правятся только в партии: здесь — дата
// (→ date_locked) и комментарий. Повторяющаяся строка при правке отвязывается от шаблона
// («изменить только этот»): source_kind → manual, source_ref сохраняется, чтобы ensureRecurring
// не вставил её заново.
export async function updateMovement(id, b) {
  const cur = (await tenantQuery(`SELECT * FROM tenant.dds_movements WHERE id = $1 AND status <> 'archived' FOR UPDATE`, [id]))[0];
  if (!cur) throw Object.assign(new Error(`платёж id=${id} не найден`), { status: 404 });
  if (b.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) throw Object.assign(new Error("дата YYYY-MM-DD"), { status: 400 });
  if (cur.source_kind === "purchase" || cur.source_kind === "mp_payout") {
    await tenantQuery(
      `UPDATE tenant.dds_movements SET date = COALESCE($1, date), date_locked = date_locked OR ($1 IS NOT NULL AND $1 <> date),
          description = COALESCE($2, description), updated_at = now() WHERE id = $3`,
      [b.date ?? null, b.description ?? null, id]);
    return;
  }
  if (b.amount !== undefined && !(Number(b.amount) > 0)) throw Object.assign(new Error("сумма должна быть больше 0"), { status: 400 });
  await tenantQuery(
    `UPDATE tenant.dds_movements SET date = COALESCE($1, date), amount = COALESCE($2, amount),
        amount_planned = CASE WHEN status = 'planned' THEN COALESCE($2, amount_planned) ELSE amount_planned END,
        category = COALESCE($3, category), counterparty = COALESCE($4, counterparty), description = COALESCE($5, description),
        source_kind = CASE WHEN source_kind = 'recurring' THEN 'manual' ELSE source_kind END, updated_at = now()
      WHERE id = $6`,
    [b.date ?? null, b.amount !== undefined ? num(b.amount) : null, b.category ?? null, b.counterparty ?? null, b.description ?? null, id]);
}

export async function markPaid(id, amount) {
  const r = await tenantQuery(
    `UPDATE tenant.dds_movements SET status = 'paid', paid_at = now(),
        amount = COALESCE($1, amount), updated_at = now()
      WHERE id = $2 AND status = 'planned' RETURNING id`, [amount != null ? num(amount) : null, id]);
  if (!r.length) throw Object.assign(new Error(`платёж id=${id} не найден или уже оплачен`), { status: 400 });
}

export async function unmarkPaid(id) {
  const cur = (await tenantQuery(`SELECT source_kind FROM tenant.dds_movements WHERE id = $1 AND status = 'paid' FOR UPDATE`, [id]))[0];
  if (!cur) throw Object.assign(new Error(`платёж id=${id} не оплачен`), { status: 400 });
  if (cur.source_kind === "mp_payout") {
    // снятие «получено» у выплаты МП — строка в архив, снова виден прогноз
    await tenantQuery(`UPDATE tenant.dds_movements SET status = 'archived', updated_at = now() WHERE id = $1`, [id]);
    return;
  }
  await tenantQuery(
    `UPDATE tenant.dds_movements SET status = 'planned', paid_at = NULL, amount = COALESCE(amount_planned, amount), updated_at = now()
      WHERE id = $1`, [id]);
}

export async function archiveMovement(id) {
  const cur = (await tenantQuery(`SELECT source_kind FROM tenant.dds_movements WHERE id = $1`, [id]))[0];
  if (!cur) throw Object.assign(new Error(`платёж id=${id} не найден`), { status: 404 });
  if (cur.source_kind === "purchase") throw Object.assign(new Error("платёж из закупки удаляется вместе с партией"), { status: 400 });
  await tenantQuery(`UPDATE tenant.dds_movements SET status = 'archived', updated_at = now() WHERE id = $1`, [id]);
}

export async function receivePayout({ ref, platform, date, amount, amount_planned }) {
  if (!/^(wb|ozon):/.test(String(ref || ""))) throw Object.assign(new Error("ref выплаты"), { status: 400 });
  if (!(Number(amount) >= 0)) throw Object.assign(new Error("сумма"), { status: 400 });
  const r = await tenantQuery(
    `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, category, counterparty,
       description, status, source, source_kind, source_ref, paid_at, platform)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, 'income', $2, $3, 'Выплата МП', $4, $5, 'paid', 'mp_payout', 'mp_payout', $6, now(), $7)
     ON CONFLICT DO NOTHING RETURNING id`,
    [date, num(amount), amount_planned != null ? num(amount_planned) : null, platform === "wb" ? "Wildberries" : "Ozon",
     `Выплата ${platform === "wb" ? "WB" : "Ozon"}`, ref, platform]);
  if (!r.length) throw Object.assign(new Error("выплата уже отмечена"), { status: 400 });
  return r[0].id;
}

export async function saveRecurring(b) {
  const rule = b.rule;
  if (!["monthly", "weekly", "every_n_days"].includes(rule)) throw Object.assign(new Error("rule"), { status: 400 });
  if (!["income", "expense"].includes(b.type) || !(Number(b.amount) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date_from || "")))
    throw Object.assign(new Error("type/amount/date_from"), { status: 400 });
  const vals = [b.type, num(b.amount), b.category || null, b.counterparty || null, b.description || null, rule,
    b.rule_day != null ? Number(b.rule_day) : null, b.every_n != null ? Number(b.every_n) : null, b.date_from, b.date_to || null];
  let id = b.id ? Number(b.id) : null;
  if (id) {
    await tenantQuery(
      `UPDATE tenant.dds_recurring SET type=$1, amount=$2, category=$3, counterparty=$4, description=$5, rule=$6,
          rule_day=$7, every_n=$8, date_from=$9, date_to=$10, updated_at=now() WHERE id=$11`, [...vals, id]);
    // будущие неоплаченные, не сдвинутые руками — пересоздаются по новому правилу
    await tenantQuery(
      `UPDATE tenant.dds_movements SET status='archived', updated_at=now()
        WHERE source_kind='recurring' AND source_ref LIKE $1 AND status='planned' AND NOT date_locked AND date >= to_char(current_date,'YYYY-MM-DD')`,
      [`recurring:${id}:%`]);
  } else {
    id = (await tenantQuery(
      `INSERT INTO tenant.dds_recurring (cabinet_id, type, amount, category, counterparty, description, rule, rule_day, every_n, date_from, date_to)
       VALUES (current_setting('app.cabinet_id')::bigint, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, vals))[0].id;
  }
  return id;
}

export async function deleteRecurring(id) {
  await tenantQuery(`UPDATE tenant.dds_recurring SET is_active = false, updated_at = now() WHERE id = $1`, [id]);
  await tenantQuery(
    `UPDATE tenant.dds_movements SET status='archived', updated_at=now()
      WHERE source_kind='recurring' AND source_ref LIKE $1 AND status='planned' AND date >= to_char(current_date,'YYYY-MM-DD')`,
    [`recurring:${id}:%`]);
}
