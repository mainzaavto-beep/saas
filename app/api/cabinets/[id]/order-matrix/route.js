// /api/cabinets/[id]/order-matrix — «Матрица заказов» (14.10.2026).
// GET ?days=7|14|30|60 (полные дни по вчера, дефолт 14) &platform=all|wb|ozon &showHidden=1
//   → { dates, today, rows[], totals, hiddenCount, days, platform }.
// POST (manager) { action: "hide"|"unhide", platform, sku } | { action: "hide_empty", days, platform }
//   — свой список скрытых этой страницы (tenant.order_matrix_hidden, миграция 067).
// Заказы — все, включая отменённые: wbOrdersAllByDay / ozOrdersAllByDay (единый слой);
// сборка строк — lib/orderMatrix.js.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { DatabaseSync, tenantQuery } from "@/lib/db.js";
import { wbOrdersAllByDay } from "@/lib/wbMetrics.js";
import { ozOrdersAllByDay } from "@/lib/ozonMetrics.js";
import { statusMap } from "@/lib/finItems.js";
import { MATRIX_DAYS, buildOrderMatrix, emptyRowKeys, periodDates, skuKey } from "@/lib/orderMatrix.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLATFORMS = ["all", "wb", "ozon"];
// Даты заказов в БД — местное время МСК; PG живёт в UTC, поэтому «сегодня» считаем здесь.
const mskToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });

function parseOpts(src) {
  const d = parseInt(src.days, 10);
  return {
    days: MATRIX_DAYS.includes(d) ? d : 14,
    platform: PLATFORMS.includes(src.platform) ? src.platform : "all",
  };
}

async function loadMatrix({ days, platform, showHidden }) {
  const today = mskToday();
  const dates = periodDates(today, days);
  const from = dates[0];
  const counts = [];
  const meta = [];
  // Строго последовательно: один PG-клиент на транзакцию withTenant.
  if (platform !== "ozon") {
    const db = new DatabaseSync("wb", { readOnly: true });
    for (const r of await wbOrdersAllByDay(db, { from, to: today }))
      counts.push({ platform: "wb", sku: r.nm_id, date: r.date, total: r.total, cancelled: r.cancelled });
    for (const r of await tenantQuery(
      `SELECT a.nm_id, a.name, a.im_url, sa.supplier_article
       FROM tenant.wb_articles a
       LEFT JOIN (SELECT DISTINCT ON (nm_id) nm_id, supplier_article FROM tenant.wb_orders
                  WHERE supplier_article IS NOT NULL
                  ORDER BY nm_id, order_dt DESC) sa ON sa.nm_id = a.nm_id`))
      meta.push({ platform: "wb", sku: Number(r.nm_id), name: r.name, imUrl: r.im_url, article: r.supplier_article });
  }
  if (platform !== "wb") {
    const db = new DatabaseSync("ozon", { readOnly: true });
    for (const r of await ozOrdersAllByDay(db, { from, to: today }))
      counts.push({ platform: "ozon", sku: r.product_id, date: r.date, total: r.total, cancelled: r.cancelled });
    for (const r of await tenantQuery(`SELECT product_id, name, offer_id, im_url FROM tenant.ozon_products`))
      meta.push({ platform: "ozon", sku: Number(r.product_id), name: r.name || r.offer_id, imUrl: r.im_url, article: r.offer_id });
  }
  const hidden = new Set((await tenantQuery(`SELECT platform, sku_key FROM tenant.order_matrix_hidden`))
    .map((r) => skuKey(r.platform, Number(r.sku_key))));
  const status = await statusMap();
  return buildOrderMatrix({ dates, today, counts, meta, status, hidden, platform, showHidden });
}

export const GET = withCabinet(async (req) => {
  try {
    const qp = new URL(req.url).searchParams;
    const opts = parseOpts({ days: qp.get("days"), platform: qp.get("platform") });
    const m = await loadMatrix({ ...opts, showHidden: qp.get("showHidden") === "1" });
    return NextResponse.json({ ...opts, ...m });
  } catch (e) {
    console.error("order-matrix GET:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});

async function setHidden(platform, sku, hide) {
  if (hide) {
    await tenantQuery(
      `INSERT INTO tenant.order_matrix_hidden (cabinet_id, platform, sku_key)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2) ON CONFLICT DO NOTHING`, [platform, sku]);
  } else {
    await tenantQuery(`DELETE FROM tenant.order_matrix_hidden WHERE platform = $1 AND sku_key = $2`, [platform, sku]);
  }
}

export const POST = withCabinet(async (req) => {
  try {
    const b = await req.json().catch(() => ({}));
    if (b.action === "hide" || b.action === "unhide") {
      const sku = Number(b.sku);
      if (!["wb", "ozon"].includes(b.platform) || !Number.isSafeInteger(sku) || sku <= 0)
        return NextResponse.json({ error: "platform (wb|ozon) и sku обязательны" }, { status: 400 });
      await setHidden(b.platform, sku, b.action === "hide");
      return NextResponse.json({ ok: true });
    }
    if (b.action === "hide_empty") {
      const m = await loadMatrix({ ...parseOpts(b), showHidden: false });
      const keys = emptyRowKeys(m);
      for (const k of keys) await setHidden(k.platform, k.sku, true);
      return NextResponse.json({ ok: true, hidden: keys.length });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    console.error("order-matrix POST:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}, { requireRole: "manager" });
