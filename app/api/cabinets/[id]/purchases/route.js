// /api/cabinets/[id]/purchases — закупки (CRUD) + Excel-формулы + lifecycle.
// Перенесено из эталона data-presenter/app/api/purchases/route.js с адаптацией
// под PostgreSQL tenant.* (RLS по cabinet_id) через tenantQuery/DatabaseSync.
import { NextResponse } from "next/server";
import { tenantQuery, DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const numOr = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function sqlSafe(v, maxLen = 200) {
  if (!v) return "";
  return String(v).slice(0, maxLen).replace(/'/g, "''");
}

// =====================================================================
//  Excel-формулы «Себес товара» (считаются НА СЕРВЕРЕ из вводных полей).
//  Эталон: data-presenter/app/api/purchases/route.js:computeExcel
//    N = L × M           (Сумма аванса ₽ = предоплата¥ × курс аванса)
//    Q = O × P           (Сумма ¥ = кол-во × цена за ед ¥)
//    R = Q − L           (Остаток оплаты ¥)
//    S = M × R           (Остаток оплаты ₽ = курс АВАНСА × остаток¥)
//    V = P × U           (Цена за ед ₽)
//    W = R × U + N       (Сумма ₽ оплаченная)
//    Z = W + X + Y       (ИТОГО; X и Y — ₽ за ПАРТИЮ целиком)
//    AA = Z / O          (Себестоимость за ед → unit_cost)
//  L=prepay_yuan, M=prepay_rate, O=qty, P=unit_cost_yuan, U=exchange_rate,
//  X=logistics_rub_per_unit (на ед), Y=logistics_rub (на партию).
// =====================================================================
function computeExcel(input) {
  const L = numOr(input.prepay_yuan) || 0;
  const M = numOr(input.prepay_rate) || 0;
  const O = numOr(input.qty);
  const P = numOr(input.unit_cost_yuan) || 0;
  const U = numOr(input.exchange_rate) || 0;
  const X = numOr(input.logistics_rub_per_unit) || 0;
  const Y = numOr(input.logistics_rub) || 0;
  const hasQty = O != null && O > 0;
  const N = L * M;
  const Q = hasQty ? O * P : null;
  const R = hasQty ? (Q - L) : -L;
  const S = M * R;
  const V = hasQty ? P * U : null;
  const W = R * U + N;
  const Z = W + X + Y;
  const unitCost = hasQty ? Z / O : null;
  return {
    N: round2(N), Q: hasQty ? round2(Q) : null, R: round2(R), S: round2(S),
    V: hasQty ? round2(V) : null, W: round2(W), Z: round2(Z),
    unitCost: unitCost != null ? round2(unitCost) : null,
  };
}

// Эффективный lifecycle_status (NULL → arrived если есть delivery_dt, иначе planned).
function lifecycleEffective(row) {
  if (row.lifecycle_status) return row.lifecycle_status;
  return row.delivery_dt ? "arrived" : "planned";
}

const SELECT_COLS = `id, nm_id, supplier_name, qty, unit_cost, date,
  unit_cost_yuan, exchange_rate, logistics_yuan, logistics_rub,
  order_dt, delivery_dt, status, source, supplier,
  order_no, unit_cost_est, total_amount,
  plan_order_dt, plan_ship_dt, plan_arrival_dt, lifecycle_status,
  photo_url, source_country, ship_dt,
  prepay_yuan, prepay_rate, logistics_rub_per_unit, pay_status, category`;

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const fromQ = url.searchParams.get("from") || "";
  const toQ = url.searchParams.get("to") || "";
  const supplierQ = url.searchParams.get("supplier") || "";
  const vendorQ = url.searchParams.get("vendor") || "";
  const statusQ = url.searchParams.get("status") || "";
  const categoryQ = url.searchParams.get("category") || "";
  const qQ = url.searchParams.get("q") || "";

  const conds = ["deleted_at IS NULL"];
  const params = [];
  let pi = 0;
  if (fromQ && /^\d{4}-\d{2}$/.test(fromQ)) { conds.push(`COALESCE(delivery_dt, order_dt, date) >= $${++pi}`); params.push(fromQ); }
  if (toQ && /^\d{4}-\d{2}$/.test(toQ)) { conds.push(`COALESCE(delivery_dt, order_dt, date) <= $${++pi}`); params.push(toQ); }
  if (supplierQ) { conds.push(`supplier_name = $${++pi}`); params.push(supplierQ); }
  if (vendorQ === "__null__") conds.push("(supplier IS NULL OR supplier = '')");
  else if (vendorQ) { conds.push(`supplier = $${++pi}`); params.push(vendorQ); }
  if (statusQ === "__null__") conds.push("status IS NULL");
  else if (statusQ) { conds.push(`status = $${++pi}`); params.push(statusQ); }
  if (categoryQ === "__null__") conds.push("category IS NULL");
  else if (categoryQ) { conds.push(`category = $${++pi}`); params.push(categoryQ); }
  if (qQ) { conds.push(`(supplier_name ILIKE $${++pi} OR CAST(nm_id AS TEXT) ILIKE $${++pi} OR order_no ILIKE $${++pi})`); params.push(`%${qQ}%`, `%${qQ}%`, `%${qQ}%`); }
  const where = conds.join(" AND ");

  const items = await tenantQuery(
    `SELECT ${SELECT_COLS} FROM tenant.purchases WHERE ${where}
     ORDER BY COALESCE(delivery_dt, order_dt, date) DESC NULLS LAST, supplier_name`,
    params
  );

  // Фасеты (без фильтра по своему полю — count осмысленный).
  const whereNoSup = conds.filter((c) => !c.includes("supplier_name")).join(" AND ");
  const whereNoStat = conds.filter((c) => !c.includes("status")).join(" AND ");
  const whereNoCat = conds.filter((c) => !c.includes("category")).join(" AND ");
  const whereNoVendor = conds.filter((c) => !c.includes("supplier =") && !c.includes("supplier IS NULL")).join(" AND ");
  const suppliers = await tenantQuery(
    `SELECT supplier_name, COUNT(*) AS n FROM tenant.purchases WHERE ${whereNoSup} GROUP BY supplier_name ORDER BY n DESC`
  );
  const vendors = await tenantQuery(
    `SELECT COALESCE(supplier, '') AS v, COUNT(*) AS n FROM tenant.purchases WHERE ${whereNoVendor} GROUP BY 1 ORDER BY n DESC`
  );
  const statuses = await tenantQuery(
    `SELECT COALESCE(status, '') AS s, COUNT(*) AS n FROM tenant.purchases WHERE ${whereNoStat} GROUP BY 1 ORDER BY n DESC`
  );
  const categories = await tenantQuery(
    `SELECT COALESCE(category, '') AS c, COUNT(*) AS n FROM tenant.purchases WHERE ${whereNoCat} GROUP BY 1 ORDER BY n DESC`
  );

  // Метаданные nm_id (фото/имя) из tenant.wb_articles.
  const nmMeta = {};
  const nmIds = [...new Set(items.map((i) => i.nm_id).filter(Boolean))];
  if (nmIds.length) {
    try {
      const db = new DatabaseSync("wb", { readOnly: true });
      const placeholders = nmIds.map((_, i) => `?`).join(",");
      const metaRows = await db.prepare(`SELECT nm_id, name, im_url FROM articles WHERE nm_id IN (${placeholders})`).all(...nmIds);
      for (const m of metaRows) nmMeta[m.nm_id] = { name: m.name, im_url: m.im_url };
    } catch {}
  }

  // Итоги: costTotal = Σ(Z), avgCost = взвешенная по qty себестоимость.
  let parties = 0, qtyTotal = 0, costTotal = 0, logRubTotal = 0, hasNm = 0;
  let costByUnit = 0;
  for (const it of items) {
    const f = computeExcel(it);
    parties++;
    qtyTotal += numOr(it.qty) || 0;
    costTotal += f.Z || 0;
    logRubTotal += numOr(it.logistics_rub) || 0;
    costByUnit += (numOr(it.qty) || 0) * (f.unitCost || 0);
    if (it.nm_id != null) hasNm++;
  }
  const totals = {
    parties,
    qty: qtyTotal,
    costTotal: round2(costTotal),
    avgCost: qtyTotal > 0 ? round2(costByUnit / qtyTotal) : 0,
    logisticsRubTotal: round2(logRubTotal),
    hasNm,
  };

  // Обогатить items: формульные поля Excel + метаданные + lifecycle + balance_due.
  const enriched = items.map((it) => {
    const meta = it.nm_id != null ? (nmMeta[it.nm_id] || {}) : {};
    const f = computeExcel(it);
    const balanceDue = it.pay_status === "paid" ? 0 : (f.S ?? 0);
    return {
      ...it,
      // Перезаписываем unit_cost формульным значением (на случай рассинхрона).
      unit_cost: f.unitCost,
      calc_N: f.N, calc_Q: f.Q, calc_R: f.R, calc_S: f.S,
      calc_V: f.V, calc_W: f.W, calc_Z: f.Z,
      calc_balance_due: round2(balanceDue),
      im_url: it.photo_url || meta.im_url || null,
      wb_name: meta.name || null,
      lifecycle_effective: lifecycleEffective(it),
    };
  });

  return NextResponse.json({ items: enriched, totals, facets: { suppliers, vendors, statuses, categories } });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  if (b.id) {
    // UPDATE — PATCH-семантика (merge поверх текущей строки).
    const cur = (await tenantQuery(`SELECT * FROM tenant.purchases WHERE id = $1 AND deleted_at IS NULL`, [Number(b.id)]))[0];
    if (!cur) return NextResponse.json({ error: `партия id=${b.id} не найдена` }, { status: 404 });

    const M = (field) => (b[field] !== undefined ? b[field] : cur[field]);
    // Пересчёт AA из merged-значений по формулам Excel.
    const calcM = computeExcel({
      prepay_yuan: M("prepay_yuan"), prepay_rate: M("prepay_rate"), qty: M("qty"),
      unit_cost_yuan: M("unit_cost_yuan"), exchange_rate: M("exchange_rate"),
      logistics_rub_per_unit: M("logistics_rub_per_unit"), logistics_rub: M("logistics_rub"),
    });
    const unitCost = calcM.unitCost;

    const sets = [];
    const vals = [];
    for (const k of ["nm_id","supplier_name","date","supplier","order_dt","delivery_dt",
      "status","order_no","unit_cost_est","total_amount","plan_order_dt","plan_ship_dt",
      "plan_arrival_dt","lifecycle_status","photo_url","source_country","ship_dt",
      "prepay_yuan","prepay_rate","logistics_rub_per_unit","pay_status","note","category"]) {
      if (b[k] !== undefined) { sets.push(`${k} = $${sets.length + 1}`); vals.push(b[k] === "" ? null : b[k]); }
    }
    // qty + unit_cost (формульный) всегда пересчитываем.
    if (b.qty !== undefined) { sets.push(`qty = $${sets.length + 1}`); vals.push(b.qty); }
    sets.push(`unit_cost = $${sets.length + 1}`); vals.push(unitCost);

    if (sets.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    vals.push(Number(b.id));
    await tenantQuery(`UPDATE tenant.purchases SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    return NextResponse.json({ ok: true, id: Number(b.id), unit_cost: unitCost });
  }

  // INSERT
  const calc = computeExcel(b);
  const cols = ["cabinet_id"];
  const ph = ["current_setting('app.cabinet_id')::bigint"];
  const vals = [];
  for (const k of ["nm_id","supplier_name","qty","date","supplier","order_dt","delivery_dt",
    "status","order_no","unit_cost_est","total_amount","plan_order_dt","plan_ship_dt",
    "plan_arrival_dt","lifecycle_status","photo_url","source_country","ship_dt",
    "prepay_yuan","prepay_rate","logistics_rub_per_unit","pay_status","note","category"]) {
    if (b[k] !== undefined) {
      cols.push(k);
      vals.push(b[k] === "" ? null : b[k]);
      ph.push(`$${ph.length}`);
    }
  }
  // unit_cost — формульный.
  cols.push("unit_cost"); ph.push(`$${ph.length}`); vals.push(calc.unitCost);

  const rows = await tenantQuery(
    `INSERT INTO tenant.purchases (${cols.join(",")}) VALUES (${ph.join(",")}) RETURNING id`,
    vals
  );
  return NextResponse.json({ ok: true, id: rows[0]?.id, unit_cost: calc.unitCost });
}, { requireRole: 'owner' });

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await tenantQuery(`UPDATE tenant.purchases SET deleted_at = now() WHERE id = $1`, [Number(id)]);
  return NextResponse.json({ ok: true });
}, { requireRole: 'owner' });
