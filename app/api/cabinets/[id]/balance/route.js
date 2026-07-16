// /api/cabinets/[id]/balance — бухгалтерский баланс (актив/пассив) + каталог счетов.
//
// GET (без date) → «живой» баланс на сегодня: ручные поля (касса/кредиты) из
//   последнего РЕАЛЬНОГО снапшота (as_of_date <= сегодня) + авто-остатки (МП,
//   склад/ФФ, в пути), посчитанные на сегодня. Заглушки «даты будущего» (напр.
//   2099-12-31) игнорируются фильтром as_of_date <= current_date.
// GET ?date=YYYY-MM-DD → срез на дату: ближайший снапшот <= date + авто на date.
// GET ?history=1 → история снапшотов.
//
// POST {as_of_date, fields, accounts, note} → upsert снапшота на дату.
// POST {subject, account_name}            → add_account (каталог счетов).
// POST {id, account_name}                  → rename_account (каталог).
//
// DELETE ?id=N → soft-delete счёта из каталога (archived=1).
//
// Контракт фронта: плоские поля stockBreakdown/mpBalanceBreakdown/
// ffStockBreakdown/inTransitBreakdown + catalog + available_dates + accounts.
// (Фронт /fin-balance читает именно плоские поля, а не вложенный auto.)
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { stockBreakdown } from "@/lib/mpStockValue.js";
import { ffStockBreakdown } from "@/lib/ffStockValue.js";
import { purchasesInTransit } from "@/lib/purchasesInTransit.js";
import { mpBalanceBreakdown } from "@/lib/mpBalance.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
// num(): защищает суммы от NaN-каскада, если хелпер вернул нечисло (напр.
// mpBalance при отсутствии токенов отдаёт {} без .total → NaN съел бы весь актив).
const num = (v) => (Number(v) || 0);

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const dateQ = url.searchParams.get("date");
  const history = url.searchParams.get("history") === "1";

  if (history) {
    const dateFrom = url.searchParams.get("date_from") || "";
    const dateTo = url.searchParams.get("date_to") || "";
    const conds = [];
    const params = [];
    if (dateFrom) { conds.push("as_of_date >= $" + (params.length + 1)); params.push(dateFrom); }
    if (dateTo) { conds.push("as_of_date <= $" + (params.length + 1)); params.push(dateTo); }
    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
    const rows = await tenantQuery(
      `SELECT * FROM tenant.balance_snapshot ${where} ORDER BY as_of_date DESC LIMIT 50`, params
    );
    return NextResponse.json({ items: rows });
  }

  // Дата «среза»: явный ?date=, иначе сегодня (живой режим).
  // ⚠ Фильтр as_of_date <= liveDate отсекает заглушки «даты будущего» (напр.
  //   2099-12-31), которые иначе перекрывают реальные снапшоты в ORDER BY DESC.
  const liveDate = dateQ || new Date().toISOString().slice(0, 10);
  const snapRows = await tenantQuery(
    `SELECT * FROM tenant.balance_snapshot
     WHERE as_of_date <= $1
     ORDER BY as_of_date DESC LIMIT 1`,
    [liveDate]
  );
  const snap = snapRows[0] || null;

  // Авто-остатки считаем на дату среза (сегодня в живом режиме), а не на дату
  // снапшота — иначе при старом снапшоте остатки были бы устаревшими.
  const [stk, ff, transit, mpBal] = await Promise.all([
    stockBreakdown(liveDate),
    ffStockBreakdown(liveDate),
    purchasesInTransit(),
    mpBalanceBreakdown({ cabinetId: cabinet.cabinet_id }).catch(() => ({ wb: 0, ozon: 0, total: 0 })),
  ]);

  // Каталог счетов (постоянный список названий, cross-snapshot).
  const catalog = await tenantQuery(
    `SELECT id, subject, account_name, sort_order
     FROM tenant.balance_account_catalog
     WHERE archived = 0
     ORDER BY sort_order, account_name`
  );

  // available_dates — даты существующих снапшотов (дропдаун выбора даты в UI).
  // Фильтр <= сегодня отбрасывает заглушки «даты будущего» (напр. 2099-12-31).
  // ⚠ as_of_date имеет тип TEXT (миграция 009) — current_date кастуем в text.
  const dateRows = await tenantQuery(
    `SELECT as_of_date FROM tenant.balance_snapshot
     WHERE as_of_date <= current_date::text
     ORDER BY as_of_date DESC`
  );
  const available_dates = dateRows.map((r) => r.as_of_date);

  if (!snap) {
    // Снапшота ещё нет — показываем авто-остатки без ручных полей.
    const assets0 = round2(num(mpBal.total) + num(stk.total) + num(ff.total) + num(transit.total));
    return NextResponse.json({
      snapshot: null,
      accounts: [],
      catalog,
      available_dates,
      stockBreakdown: stk,
      mpBalanceBreakdown: mpBal,
      ffStockBreakdown: ff,
      inTransitBreakdown: transit,
      receivables: [],
      as_of: liveDate,
      totals: { assets: assets0, liabilities: 0, equity: assets0 },
      message: "Нет сохранённых снапшотов — показаны только авто-остатки. Введите кассу/кредиты (кнопка «Срез на дату»).",
    });
  }

  // Счета на дату снапшота (id нужен фронту для rename/remove).
  const accounts = await tenantQuery(
    `SELECT id, subject, account_name, amount FROM tenant.balance_accounts
     WHERE as_of_date = $1 ORDER BY subject, account_name`,
    [snap.as_of_date]
  );

  // Склейка: ручные поля из снапшота (касса/кредиты/прочее) + авто на дату среза.
  // Если авто-расчёт пуст (нет снимков на дату) — берём значение из снапшота.
  const stkVal = num(stk.total) || num(snap.stock_value);
  const transitVal = num(transit.total) || num(snap.stock_in_transit);
  const ffVal = num(ff.total) || num(snap.ff_stock);

  const assets = round2(
    num(snap.cash_on_hand) + num(mpBal.total) + stkVal +
    transitVal + num(snap.receivables) + num(snap.other_assets) + ffVal
  );
  const liabilities = round2(
    num(snap.payables) + num(snap.loans) + num(snap.other_liabilities)
  );
  const equity = round2(assets - liabilities);

  return NextResponse.json({
    snapshot: snap,
    accounts,
    catalog,
    available_dates,
    stockBreakdown: stk,
    mpBalanceBreakdown: mpBal,
    ffStockBreakdown: ff,
    inTransitBreakdown: transit,
    receivables: [], // по решению владельца: дебиторка-массив не ведётся, только скаляр snap.receivables (входит в актив)
    as_of: liveDate,
    totals: { assets, liabilities, equity },
  });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();

  // --- Каталог счетов: add / rename (без as_of_date — грабля D10: action-блоки
  //     без id/as_of_date ДО основной проверки). ---
  if (body.subject && body.account_name && !body.as_of_date) {
    // add_account: INSERT в каталог (ON CONFLICT игнор — идемпотентно).
    await tenantQuery(
      `INSERT INTO tenant.balance_account_catalog (cabinet_id, subject, account_name, sort_order)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3)
       ON CONFLICT (cabinet_id, subject, account_name) DO NOTHING`,
      [body.subject, body.account_name, Number(body.sort_order) || 0]
    );
    return NextResponse.json({ ok: true, op: "add_account" });
  }
  if (body.id && body.account_name && !body.as_of_date) {
    // rename_account: UPDATE названия в каталоге.
    await tenantQuery(
      `UPDATE tenant.balance_account_catalog SET account_name = $1 WHERE id = $2`,
      [body.account_name, body.id]
    );
    return NextResponse.json({ ok: true, op: "rename_account" });
  }

  // --- Снапшот на дату ---
  const { as_of_date, fields = {}, accounts = [], note } = body;
  if (!as_of_date) return NextResponse.json({ error: "as_of_date required" }, { status: 400 });

  const f = fields;
  const existing = await tenantQuery(
    `SELECT id FROM tenant.balance_snapshot WHERE as_of_date = $1`, [as_of_date]
  );
  const colNames = ["cash_on_hand","mp_balance","stock_value","stock_in_transit","receivables",
    "other_assets","payables","loans","owner_equity","retained_earnings","other_liabilities","ff_stock"];
  const colVals = colNames.map((c) => Number(f[c]) || 0);

  if (existing.length > 0) {
    const sets = colNames.map((c, i) => `${c} = $${i + 1}`).join(", ");
    await tenantQuery(
      `UPDATE tenant.balance_snapshot SET ${sets}, note = $${colNames.length + 1} WHERE id = $${colNames.length + 2}`,
      [...colVals, note || null, existing[0].id]
    );
  } else {
    const placeholders = colNames.map((_, i) => `$${i + 2}`).join(", ");
    await tenantQuery(
      `INSERT INTO tenant.balance_snapshot (cabinet_id, as_of_date, ${colNames.join(",")}, note)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, ${placeholders}, $${colNames.length + 2})`,
      [as_of_date, ...colVals, note || null]
    );
  }

  // Счета на дату: пересоздать (DELETE + INSERT), как раньше.
  await tenantQuery(`DELETE FROM tenant.balance_accounts WHERE as_of_date = $1`, [as_of_date]);
  for (const a of accounts) {
    if (!a.subject || !a.account_name) continue;
    await tenantQuery(
      `INSERT INTO tenant.balance_accounts (cabinet_id, as_of_date, subject, account_name, amount)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4)`,
      [as_of_date, a.subject, a.account_name, Number(a.amount) || 0]
    );
    // Авто-синхронизация: если счёта ещё нет в каталоге — добавим (чтобы он
    // не «потерялся» из дропдауна после сохранения).
    await tenantQuery(
      `INSERT INTO tenant.balance_account_catalog (cabinet_id, subject, account_name, sort_order)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, 0)
       ON CONFLICT (cabinet_id, subject, account_name) DO NOTHING`,
      [a.subject, a.account_name]
    );
  }

  // Ответ — тот же набор полей, что у GET, чтобы фронт обновил состояние без
  // перезагрузки (он парсит d.catalog/d.accounts/d.*Breakdown через if (d.*)).
  return NextResponse.json({ ok: true, as_of_date, accounts, catalog: [] });
}, { requireRole: 'owner' });

// DELETE ?id=N → soft-delete счёта из каталога (archived=1).
export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await tenantQuery(
    `UPDATE tenant.balance_account_catalog SET archived = 1 WHERE id = $1`,
    [id]
  );
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });
