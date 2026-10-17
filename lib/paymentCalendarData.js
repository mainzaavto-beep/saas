// lib/paymentCalendarData.js — данные платёжного календаря (15.10.2026). Все функции — внутри
// withTenant (одна транзакция роута); запросы последовательно. Спека
// docs/superpowers/specs/2026-10-15-payment-calendar-design.md §2.
import { tenantQuery, query, DatabaseSync } from "./db.js";
import { purchasePayments, expandRecurring, wbPayoutWindows, ozPayoutWindows, readPayoutSettings, addDays } from "./paymentCalendar.js";
import { wbCashPayoutByWeek } from "./wbMetrics.js";
import { ozPayoutByDay } from "./ozonMetrics.js";
import { validateDdsMovement, editRules, articleKeyOf, defaultAccountFor } from "./dds.js";
import { loadRefs, httpError } from "./ddsData.js";

const COLS = `id, date, type, amount::float8 AS amount, amount_planned::float8 AS amount_planned, category,
  article_key, account_id::int AS account_id, account_to_id::int AS account_to_id,
  counterparty, description, status, source_kind, source_ref, date_locked, paid_at, platform`;

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
      // Без ON CONFLICT: source_ref уже проверен выше (byRef из SELECT той же транзакции),
      // а партия обновляется/создаётся раньше синка в той же транзакции route — повторная
      // вставка этого же ref в параллельной транзакции невозможна (строка партии сериализует
      // доступ per-purchase).
      await tenantQuery(
        `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, article_key, counterparty,
           description, status, source, source_kind, source_ref)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, 'expense', $2, $2, $3, $4, $5, 'planned', 'purchase', 'purchase', $6)`,
        [w.date, w.amount, w.article, p.supplier_name || null, w.description, w.ref]);
      upserted++;
    } else if (cur.status === "planned") {
      // description не трогаем: комментарий, поправленный в календаре, переживает сохранение партии
      // (описание ставится только при вставке).
      await tenantQuery(
        `UPDATE tenant.dds_movements SET amount = $1, amount_planned = $1, counterparty = $2, article_key = $5,
            date = CASE WHEN date_locked THEN date ELSE $3 END, updated_at = now() WHERE id = $4`,
        [w.amount, p.supplier_name || null, w.date, cur.id, w.article]);
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
      // Вставляем, только если строки с этим ref нет ВООБЩЕ (любой source_kind, любой статус):
      // частичный уникальный индекс (… WHERE status <> 'archived') не ловит ни удалённую
      // пользователем дату (archived), ни строку, правленную «только эту» (source_kind='manual',
      // тот же ref) — без NOT EXISTS удалённое возвращалось, а правленное дублировалось.
      // ON CONFLICT — вторая страховка от гонки параллельных GET.
      const r = await tenantQuery(
        `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, article_key, counterparty,
           description, status, source, source_kind, source_ref)
         SELECT current_setting('app.cabinet_id')::bigint, $1::text, $2::text, $3::numeric, $3::numeric, $4::text, $5::text, $6::text,
                'planned', 'recurring', 'recurring', $7::text
          WHERE NOT EXISTS (SELECT 1 FROM tenant.dds_movements WHERE source_ref = $7::text)
         ON CONFLICT DO NOTHING RETURNING id`,
        [d, t.type, Number(t.amount), t.article_key || articleKeyOf(t.category, t.type), t.counterparty, t.description, `recurring:${t.id}:${d}`]);
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

// Новая строка. Перевод — всегда факт; поступление/списание — факт при b.paid. Счёт факта без явного
// выбора — из настроек ДДС (default_account_id). Статья: article_key, иначе по старой метке category.
export async function createMovement(b) {
  const refs = await loadRefs();
  const isTransfer = b.type === "transfer";
  const paid = isTransfer || !!b.paid;
  const row = {
    type: b.type, date: b.date, amount: b.amount,
    article_key: isTransfer ? null : (b.article_key || articleKeyOf(b.category, b.type)),
    account_id: b.account_id != null && b.account_id !== "" ? Number(b.account_id) : (paid && !isTransfer ? defaultAccountFor(refs.settings) : null),
    account_to_id: isTransfer && b.account_to_id != null ? Number(b.account_to_id) : null,
  };
  const err = validateDdsMovement(row, refs); if (err) throw httpError(err);
  const r = await tenantQuery(
    `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, article_key, account_id, account_to_id,
       counterparty, description, status, source, source_kind, paid_at)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $3, $4, $5, $6, $7, $8, $9, 'manual', 'manual',
             CASE WHEN $9 = 'paid' THEN now() END) RETURNING id`,
    [row.date, row.type, num(row.amount), row.article_key, row.account_id, row.account_to_id,
     isTransfer ? null : (b.counterparty || null), b.description || null, paid ? "paid" : "planned"]);
  return r[0].id;
}

// Правка строки по матрице editRules (спека §3): у purchase/mp_payout — только дата (→ date_locked),
// счёт и комментарий; запрещённые поля молча не применяются (календарь шлёт форму целиком).
// Повторяющаяся строка при правке суммы/статьи/контрагента отвязывается от шаблона → manual
// (source_ref сохраняется, чтобы ensureRecurring не вставил её заново).
export async function updateMovement(id, b) {
  const cur = (await tenantQuery(`SELECT * FROM tenant.dds_movements WHERE id = $1 AND status <> 'archived' FOR UPDATE`, [id]))[0];
  if (!cur) throw httpError(`платёж id=${id} не найден`, 404);
  if (b.date !== undefined && b.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) throw httpError("дата YYYY-MM-DD");
  const rules = editRules(cur);
  const refs = await loadRefs();
  const has = (k) => b[k] !== undefined;
  const next = {
    type: cur.type,
    date: has("date") && b.date ? b.date : cur.date,
    amount: rules.amount && has("amount") ? b.amount : 1, // сумму без права правки не валидируем (выплата бывает ≤ 0)
    article_key: rules.article && has("article_key") ? (b.article_key || null) : cur.article_key,
    account_id: has("account_id") ? (b.account_id === "" || b.account_id === null ? null : Number(b.account_id)) : (cur.account_id != null ? Number(cur.account_id) : null),
    account_to_id: cur.type === "transfer" && has("account_to_id") ? Number(b.account_to_id) : (cur.account_to_id != null ? Number(cur.account_to_id) : null),
  };
  const err = validateDdsMovement(next, refs, { allowArchived: [cur.account_id, cur.account_to_id] });
  if (err) throw httpError(err);
  // Контроллер (27.5): detach учитывает и правку ДАТЫ, не только amount/article/counterparty —
  // иначе шаблонная строка, сдвинутая по дате без отвязки, была бы DELETE-ана и пересоздана по
  // старому правилу следующим saveRecurring (DELETE … NOT date_locked) — регресс «изменить только этот».
  const detach = cur.source_kind === "recurring" && (has("date") || has("amount") || has("article_key") || has("counterparty"));
  await tenantQuery(
    `UPDATE tenant.dds_movements SET
        date = $1, date_locked = date_locked OR ($1 <> date AND source_kind IN ('purchase','mp_payout')),
        amount = CASE WHEN $2::boolean THEN $3::numeric ELSE amount END,
        amount_planned = CASE WHEN $2::boolean AND status = 'planned' THEN $3::numeric ELSE amount_planned END,
        article_key = $4, account_id = $5, account_to_id = $6,
        counterparty = CASE WHEN $7::boolean THEN $8 ELSE counterparty END,
        description = COALESCE($9, description),
        source_kind = CASE WHEN $10::boolean THEN 'manual' ELSE source_kind END,
        updated_at = now()
      WHERE id = $11`,
    [next.date, rules.amount && has("amount"), rules.amount && has("amount") ? num(b.amount) : 0,
     next.article_key, next.account_id, next.account_to_id,
     rules.counterparty && has("counterparty"), b.counterparty || null,
     has("description") ? (b.description ?? "") : null, detach, id]);
}

export async function markPaid(id, amount, accountId) {
  const refs = await loadRefs();
  const acc = accountId != null && accountId !== "" ? Number(accountId) : null;
  if (acc != null) { const e = validateDdsMovement({ type: "expense", date: "2000-01-01", amount: 1, account_id: acc }, refs); if (e) throw httpError(e); }
  const r = await tenantQuery(
    `UPDATE tenant.dds_movements SET status = 'paid', paid_at = now(), amount = COALESCE($1, amount),
        account_id = COALESCE($2, account_id, $3), updated_at = now()
      WHERE id = $4 AND status = 'planned' RETURNING id`,
    [amount != null ? num(amount) : null, acc, defaultAccountFor(refs.settings), id]);
  if (!r.length) throw httpError(`платёж id=${id} не найден или уже оплачен`);
}

export async function unmarkPaid(id) {
  const cur = (await tenantQuery(`SELECT source_kind FROM tenant.dds_movements WHERE id = $1 AND status = 'paid' FOR UPDATE`, [id]))[0];
  if (!cur) throw httpError(`платёж id=${id} не оплачен`);
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
  const cur = (await tenantQuery(`SELECT source_kind, type FROM tenant.dds_movements WHERE id = $1 AND status <> 'archived'`, [id]))[0];
  if (!cur) throw httpError(`платёж id=${id} не найден`, 404);
  const rules = editRules(cur);
  if (!rules.del) throw httpError(cur.source_kind === "purchase" ? "платёж из закупки удаляется вместе с партией" : "выплата снимается отметкой «получено» в «Плане поступлений»");
  await tenantQuery(`UPDATE tenant.dds_movements SET status = 'archived', updated_at = now() WHERE id = $1`, [id]);
}

export async function receivePayout({ ref, platform, date, amount, amount_planned, account_id }) {
  if (!/^(wb|ozon):/.test(String(ref || ""))) throw httpError("ref выплаты");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw httpError("дата YYYY-MM-DD");
  // Любая конечная сумма: окно Ozon бывает отрицательным (удержания больше начислений).
  if (amount === null || amount === "" || !Number.isFinite(Number(amount))) throw httpError("сумма");
  const refs = await loadRefs();
  const acc = account_id != null && account_id !== "" ? Number(account_id) : defaultAccountFor(refs.settings, { platform });
  if (acc != null) { const e = validateDdsMovement({ type: "income", date, amount: 1, account_id: acc }, refs); if (e) throw httpError(e); }
  const r = await tenantQuery(
    `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, amount_planned, article_key, account_id, counterparty,
       description, status, source, source_kind, source_ref, paid_at, platform)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, 'income', $2, $3, $4, $5, $6, $7, 'paid', 'mp_payout', 'mp_payout', $8, now(), $9)
     ON CONFLICT DO NOTHING RETURNING id`,
    [date, num(amount), amount_planned != null ? num(amount_planned) : null, platform === "wb" ? "mp_wb" : "mp_ozon", acc,
     platform === "wb" ? "Wildberries" : "Ozon", `Выплата ${platform === "wb" ? "WB" : "Ozon"}`, ref, platform]);
  if (!r.length) throw httpError("выплата уже отмечена");
  return r[0].id;
}

// Массовое назначение счёта фактическим строкам без перевода (спека §3, плашка «без счёта»).
export async function assignAccount(ids, accountId) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!list.length) throw httpError("не выбраны операции");
  const refs = await loadRefs();
  const e = validateDdsMovement({ type: "expense", date: "2000-01-01", amount: 1, account_id: Number(accountId) }, refs);
  if (e) throw httpError(e);
  const r = await tenantQuery(
    `UPDATE tenant.dds_movements SET account_id = $1, updated_at = now()
      WHERE id = ANY($2::bigint[]) AND status = 'paid' AND type <> 'transfer' RETURNING id`, [Number(accountId), list]);
  return r.length;
}

// today — «сегодня» по МСК из роута (mskToday), не current_date БД: граница «будущих» строк
// должна совпадать с той, по которой ensureRecurring раскладывает шаблон.
export async function saveRecurring(b, today) {
  const rule = b.rule;
  if (!["monthly", "weekly", "every_n_days"].includes(rule)) throw httpError("rule");
  if (!["income", "expense"].includes(b.type) || !(Number(b.amount) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date_from || "")))
    throw httpError("type/amount/date_from");
  const intIn = (v, lo, hi) => Number.isInteger(Number(v)) && v !== null && v !== "" && Number(v) >= lo && Number(v) <= hi;
  if (rule === "monthly" && !intIn(b.rule_day, 1, 31)) throw httpError("rule_day: 1..31");
  if (rule === "weekly" && !intIn(b.rule_day, 1, 7)) throw httpError("rule_day: 1..7 (Пн..Вс)");
  if (rule === "every_n_days" && !intIn(b.every_n, 1, 365)) throw httpError("every_n: 1..365");
  if (b.date_to && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date_to))) throw httpError("date_to YYYY-MM-DD");
  const refs = await loadRefs();
  const article_key = b.article_key || articleKeyOf(b.category, b.type);
  const aerr = validateDdsMovement({ type: b.type, date: b.date_from, amount: b.amount, article_key }, refs);
  if (aerr) throw httpError(aerr);
  const vals = [b.type, num(b.amount), article_key, b.counterparty || null, b.description || null, rule,
    b.rule_day != null ? Number(b.rule_day) : null, b.every_n != null ? Number(b.every_n) : null, b.date_from, b.date_to || null];
  let id = b.id ? Number(b.id) : null;
  if (id) {
    const upd = await tenantQuery(
      `UPDATE tenant.dds_recurring SET type=$1, amount=$2, article_key=$3, counterparty=$4, description=$5, rule=$6,
          rule_day=$7, every_n=$8, date_from=$9, date_to=$10, updated_at=now() WHERE id=$11 AND is_active RETURNING id`, [...vals, id]);
    if (!upd.length) throw httpError(`шаблон повтора id=${id} не найден`, 404);
    // Будущие неоплаченные, не сдвинутые и не правленные руками строки шаблона — физически
    // удаляем (не архивируем): ensureRecurring не вставляет ref, по которому есть ЛЮБАЯ строка,
    // и архивная навсегда заблокировала бы дату — строки пересоздаются по новому правилу.
    // Правленные «только эту» (source_kind='manual', тот же ref), оплаченные и удалённые
    // пользователем (archived) остаются и продолжают блокировать свою дату.
    await tenantQuery(
      `DELETE FROM tenant.dds_movements
        WHERE source_kind='recurring' AND source_ref LIKE $1 AND status='planned' AND NOT date_locked AND date >= $2`,
      [`recurring:${id}:%`, today]);
  } else {
    id = (await tenantQuery(
      `INSERT INTO tenant.dds_recurring (cabinet_id, type, amount, article_key, counterparty, description, rule, rule_day, every_n, date_from, date_to)
       VALUES (current_setting('app.cabinet_id')::bigint, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, vals))[0].id;
  }
  return id;
}

export async function deleteRecurring(id, today) {
  await tenantQuery(`UPDATE tenant.dds_recurring SET is_active = false, updated_at = now() WHERE id = $1`, [id]);
  await tenantQuery(
    `UPDATE tenant.dds_movements SET status='archived', updated_at=now()
      WHERE source_kind='recurring' AND source_ref LIKE $1 AND status='planned' AND date >= $2`,
    [`recurring:${id}:%`, today]);
}
