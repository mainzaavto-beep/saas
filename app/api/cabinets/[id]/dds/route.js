// /api/cabinets/[id]/dds — CRUD движений денежных средств.
// GET ?date_from=&date_to=&type=&category=  список + totals + по категориям.
// POST {id?, date, type, amount, ...}  upsert.
// DELETE ?id=N  мягкое удаление (status='archived').
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TYPE = ["income", "expense"];

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const dateFrom = url.searchParams.get("date_from") || "";
  const dateTo = url.searchParams.get("date_to") || "";
  const type = url.searchParams.get("type") || "";
  const category = url.searchParams.get("category") || "";

  const conds = ["status != 'archived'"];
  const params = [];
  if (dateFrom) { conds.push("date >= $" + (params.length + 1)); params.push(dateFrom); }
  if (dateTo) { conds.push("date <= $" + (params.length + 1)); params.push(dateTo); }
  if (type && ALLOWED_TYPE.includes(type)) { conds.push("type = $" + (params.length + 1)); params.push(type); }
  if (category) { conds.push("category = $" + (params.length + 1)); params.push(category); }
  const where = conds.join(" AND ");

  const items = await tenantQuery(
    `SELECT id, date, type, amount, category, counterparty, description, status,
            platform, nm_id, income_type, account_from, account_to, source, reference
     FROM tenant.dds_movements WHERE ${where} ORDER BY date DESC, id DESC LIMIT 500`,
    params
  );
  const incomeRows = await tenantQuery(
    `SELECT COALESCE(SUM(amount),0) AS t FROM tenant.dds_movements WHERE type='income' AND ${where}`, params
  );
  const expenseRows = await tenantQuery(
    `SELECT COALESCE(SUM(amount),0) AS t FROM tenant.dds_movements WHERE type='expense' AND ${where}`, params
  );
  const byCat = await tenantQuery(
    `SELECT category, type, COALESCE(SUM(amount),0) AS total
     FROM tenant.dds_movements WHERE ${where}
     GROUP BY category, type ORDER BY type, total DESC`, params
  );
  const facets = await tenantQuery(
    `SELECT COALESCE(category,'') AS category, COUNT(*) AS n
     FROM tenant.dds_movements WHERE status != 'archived' GROUP BY category ORDER BY n DESC`
  );

  return NextResponse.json({
    items, totals: {
      income: Math.round((incomeRows[0]?.t || 0) * 100) / 100,
      expense: Math.round((expenseRows[0]?.t || 0) * 100) / 100,
      net: Math.round(((incomeRows[0]?.t || 0) - (expenseRows[0]?.t || 0)) * 100) / 100,
    },
    byCategory: byCat,
    facets: { categories: facets },
  });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  const { id, date, type, amount, category, counterparty, description, status,
          platform, nm_id, income_type, account_from, account_to, source } = b;
  if (!date || !type || amount == null) return NextResponse.json({ error: "date + type + amount required" }, { status: 400 });
  if (!ALLOWED_TYPE.includes(type)) return NextResponse.json({ error: "type must be income|expense" }, { status: 400 });

  const vals = [
    date, type, Number(amount), category || null, counterparty || null,
    description || null, status || "paid", platform || null,
    nm_id ? Number(nm_id) : null, income_type || null,
    account_from || null, account_to || null, source || "manual",
  ];

  if (id) {
    // Update
    await tenantQuery(
      `UPDATE tenant.dds_movements SET
        date=$1, type=$2, amount=$3, category=$4, counterparty=$5,
        description=$6, status=$7, platform=$8, nm_id=$9, income_type=$10,
        account_from=$11, account_to=$12, source=$13, updated_at=now()
       WHERE id=$14`,
      [...vals, Number(id)]
    );
    return NextResponse.json({ ok: true, id: Number(id) });
  }
  // Insert
  const rows = await tenantQuery(
    `INSERT INTO tenant.dds_movements (cabinet_id, date, type, amount, category, counterparty,
       description, status, platform, nm_id, income_type, account_from, account_to, source)
     VALUES (current_setting('app.cabinet_id')::bigint,
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    vals
  );
  return NextResponse.json({ ok: true, id: rows[0]?.id });
}, { requireRole: 'owner' });

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await tenantQuery(
    `UPDATE tenant.dds_movements SET status='archived', updated_at=now() WHERE id=$1`,
    [Number(id)]
  );
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });
