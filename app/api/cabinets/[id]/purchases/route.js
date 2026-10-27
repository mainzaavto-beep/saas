// /api/cabinets/[id]/purchases — закупки (CRUD) + Excel-формулы + lifecycle.
// Перенесено из эталона data-presenter/app/api/purchases/route.js с адаптацией
// под PostgreSQL tenant.* (RLS по cabinet_id) через tenantQuery/DatabaseSync.
import { NextResponse } from "next/server";
import { tenantQuery, DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { computeExcel, balanceDueRub, numOr, round2 } from "@/lib/purchaseCalc.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sqlSafe(v, maxLen = 200) {
  if (!v) return "";
  return String(v).slice(0, maxLen).replace(/'/g, "''");
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
  const archivedQ = url.searchParams.get("archived") || "";

  // Условия фильтров как [sql-фрагмент, [params...], tag].
  // tag нужен, чтобы facet-запросы могли исключить фильтр по СВОЕМУ полю
  // (чтобы count в выпадающем списке был осмысленным), корректно пересобрав
  // нумерацию $N и массив params под оставшиеся условия.
  // Раньше тут был баг (инцидент 2026-07-15): facet-запросы собирали WHERE из
  // строк с уже-пронумерованными $1..$N, но выполнялись БЕЗ params → при
  // комбинации 2+ фильтров падало «there is no parameter $1» и весь GET отдавал 0.
  // archived: по умолчанию (без ?archived=1) показываем только активные закупки
  // (завершённые→склад скрыты). ?archived=1 — показать архивные.
  const base = ["deleted_at IS NULL", archivedQ === "1" ? "archived = true" : "archived = false"];
  const filters = [];
  if (fromQ && /^\d{4}-\d{2}$/.test(fromQ)) filters.push(["COALESCE(delivery_dt, order_dt, date) >= ?", [fromQ], "date"]);
  if (toQ && /^\d{4}-\d{2}$/.test(toQ)) filters.push(["COALESCE(delivery_dt, order_dt, date) <= ?", [toQ], "date"]);
  if (supplierQ) filters.push(["supplier_name = ?", [supplierQ], "supplier"]);
  if (vendorQ === "__null__") filters.push(["(supplier IS NULL OR supplier = '')", [], "vendor"]);
  else if (vendorQ) filters.push(["supplier = ?", [vendorQ], "vendor"]);
  if (statusQ === "__null__") filters.push(["status IS NULL", [], "status"]);
  else if (statusQ) filters.push(["status = ?", [statusQ], "status"]);
  if (categoryQ === "__null__") filters.push(["category IS NULL", [], "category"]);
  else if (categoryQ) filters.push(["category = ?", [categoryQ], "category"]);
  if (qQ) filters.push(["(supplier_name ILIKE ? OR CAST(nm_id AS TEXT) ILIKE ? OR order_no ILIKE ?)", [`%${qQ}%`, `%${qQ}%`, `%${qQ}%`], "q"]);

  // Сборка WHERE с пронумерованными $N из активных условий + matching params.
  // Каждое условие может содержать несколько '?' (напр. qQ → 3 ILIKE). params
  // и нумерация $N собираются параллельно, в порядке условий.
  function buildWhere(excludeTag) {
    const use = filters.filter((f) => f[2] !== excludeTag);
    const conds = [...base, ...use.map((f) => f[0])];
    const params = [];
    const sqlParts = conds.map((cond) =>
      cond.replace(/\?/g, () => `$${params.push(undefined)}`)  // счётчик через длину
    );
    // params сейчас = массив undefined нужной длины; реальные значения в порядке условий.
    const realVals = [];
    for (const f of use) realVals.push(...f[1]);
    // realVals.length должен совпадать с кол-вом '?' (и undefined в params).
    return { sql: sqlParts.join(" AND "), params: realVals };
  }

  const mainWhere = buildWhere(null);
  const items = await tenantQuery(
    `SELECT ${SELECT_COLS} FROM tenant.purchases WHERE ${mainWhere.sql}
     ORDER BY COALESCE(delivery_dt, order_dt, date) DESC NULLS LAST, supplier_name`,
    mainWhere.params
  );

  // Фасеты: исключаем фильтр по своему полю → count по всем остальным активным фильтрам.
  const wSup = buildWhere("supplier");
  const wVendor = buildWhere("vendor");
  const wStat = buildWhere("status");
  const wCat = buildWhere("category");
  const suppliers = await tenantQuery(
    `SELECT supplier_name, COUNT(*) AS n FROM tenant.purchases WHERE ${wSup.sql} GROUP BY supplier_name ORDER BY n DESC`,
    wSup.params
  );
  const vendors = await tenantQuery(
    `SELECT COALESCE(supplier, '') AS v, COUNT(*) AS n FROM tenant.purchases WHERE ${wVendor.sql} GROUP BY 1 ORDER BY n DESC`,
    wVendor.params
  );
  const statuses = await tenantQuery(
    `SELECT COALESCE(status, '') AS s, COUNT(*) AS n FROM tenant.purchases WHERE ${wStat.sql} GROUP BY 1 ORDER BY n DESC`,
    wStat.params
  );
  const categories = await tenantQuery(
    `SELECT COALESCE(category, '') AS c, COUNT(*) AS n FROM tenant.purchases WHERE ${wCat.sql} GROUP BY 1 ORDER BY n DESC`,
    wCat.params
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
    } catch (e) { console.error("[purchases] nm meta:", e); }
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
    const balanceDue = it.pay_status === "paid" ? 0 : balanceDueRub(f);
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

// С 27.10.2026 закупки ведутся заказами (/api/cabinets/[id]/purchase-orders, спека
// docs/superpowers/specs/2026-10-27-purchase-orders-design.md). Старые партии — архив, только чтение.
const ARCHIVE_ERROR = "Старые партии — архив, только чтение. Закупки ведутся заказами на странице «Закупки».";
export const POST = withCabinet(async () => NextResponse.json({ error: ARCHIVE_ERROR }, { status: 410 }), { requireRole: "manager" });
export const DELETE = withCabinet(async () => NextResponse.json({ error: ARCHIVE_ERROR }, { status: 410 }), { requireRole: "manager" });
