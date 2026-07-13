// /api/cabinets/[id]/balance — бухгалтерский баланс (актив/пассив).
// GET ?date=YYYY-MM-DD → ближайший снапшот + расчётные totals.
// GET ?history=1&date_from=&date_to= → история снапшотов.
// POST {as_of_date, fields:{...}, accounts:[...], note} → upsert по дате.
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

  let snapRows;
  if (dateQ) {
    snapRows = await tenantQuery(
      `SELECT * FROM tenant.balance_snapshot WHERE as_of_date <= $1 ORDER BY as_of_date DESC LIMIT 1`, [dateQ]
    );
  } else {
    snapRows = await tenantQuery(
      `SELECT * FROM tenant.balance_snapshot ORDER BY as_of_date DESC LIMIT 1`
    );
  }
  const snap = snapRows[0] || null;
  if (!snap) return NextResponse.json({ snapshot: null, message: "Нет снапшотов баланса." });

  const accounts = await tenantQuery(
    `SELECT subject, account_name, amount FROM tenant.balance_accounts WHERE as_of_date = $1 ORDER BY subject, account_name`,
    [snap.as_of_date]
  );

  const [stk, ff, transit, mpBal] = await Promise.all([
    stockBreakdown(snap.as_of_date),
    ffStockBreakdown(snap.as_of_date),
    purchasesInTransit(),
    mpBalanceBreakdown().catch(() => ({ wb: 0, ozon: 0, total: 0 })),
  ]);

  const assets = round2(
    (snap.cash_on_hand || 0) + (mpBal.total || 0) + (stk.total || 0) +
    (snap.stock_in_transit || 0) + (snap.receivables || 0) + (snap.other_assets || 0) +
    (snap.ff_stock || 0)
  );
  const liabilities = round2(
    (snap.payables || 0) + (snap.loans || 0) + (snap.other_liabilities || 0)
  );
  const equity = round2(assets - liabilities);

  return NextResponse.json({
    snapshot: snap,
    accounts,
    auto: {
      stock_value: stk.total, stock_date_wb: stk.dateWb, stock_date_ozon: stk.dateOzon,
      ff_stock: ff.total, ff_date: ff.date,
      stock_in_transit: transit.total, transit_count: transit.count,
      mp_balance: mpBal.total, mp_balance_wb: mpBal.wb, mp_balance_ozon: mpBal.ozon,
      mp_balance_errors: mpBal.errors,
    },
    totals: { assets, liabilities, equity },
  });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
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

  await tenantQuery(`DELETE FROM tenant.balance_accounts WHERE as_of_date = $1`, [as_of_date]);
  for (const a of accounts) {
    if (!a.subject || !a.account_name) continue;
    await tenantQuery(
      `INSERT INTO tenant.balance_accounts (cabinet_id, as_of_date, subject, account_name, amount)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4)`,
      [as_of_date, a.subject, a.account_name, Number(a.amount) || 0]
    );
  }
  return NextResponse.json({ ok: true, as_of_date });
});
