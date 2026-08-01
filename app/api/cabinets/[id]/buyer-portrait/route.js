import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// =====================================================================
//  /api/cabinets/[id]/buyer-portrait — «Портрет покупателя» (подписка «Джем» WB).
//
//  Коллега был прав: WB публикует «Джем»-only методы в открытой API-документации,
//  дающие поисковые запросы, позиции и воронку конверсий. Пол/возраст через API
//  так и НЕ отдаётся (виджет в ЛК без endpoint'а) — но 80% портрета здесь.
//
//  Источники (сборщик worker/collectors/wb_jem.py):
//    tenant.wb_search_queries  — поисковые запросы по товарам (keyword-level)
//    tenant.wb_funnel_daily    — воронка конверсий по товару×дню (агрегированно)
//
//  Один GET возвращает всё для 2 вкладок страницы (как /stocks):
//    { queries[], funnel[], kpis{...}, lastDate, hasData }
//
//  Query: ?days=30 — окно (по умолчанию 30).
// =====================================================================

const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const qp = req ? new URL(req.url).searchParams : null;
    const days = Math.min(Math.max(parseInt(qp?.get("days"), 10) || 30, 1), 90);

    const db = new DatabaseSync("wb", { readOnly: true });

    // ----------------------------------------------------------------
    //  Вкладка 1: Поисковые запросы (wb_search_queries).
    //  Группируем по keyword (схлопываем nm_id, чтобы видеть «как ищут
    //  в целом по каталогу»). Для каждого keyword — сумма кликов/заказов,
    //  средневзвешенная позиция, максимальная частота, топ-nm_id.
    // ----------------------------------------------------------------
    const today = new Date();
    const from = new Date(today.getTime() - days * 86400000)
      .toISOString().slice(0, 10);

    const queries = await db.prepare(`
      SELECT
        keyword,
        COUNT(DISTINCT nm_id)                                AS nm_count,
        MAX(freq)                                            AS freq,
        MAX(week_freq)                                       AS week_freq,
        ROUND(AVG(avg_position)::numeric, 1)                 AS avg_position,
        MIN(median_position)                                 AS best_position,
        SUM(open_card)                                       AS open_card,
        SUM(add_to_cart)                                     AS add_to_cart,
        SUM(orders)                                          AS orders,
        ROUND(AVG(open_to_cart)::numeric, 1)                 AS open_to_cart_pct,
        ROUND(AVG(cart_to_order)::numeric, 1)                AS cart_to_order_pct,
        ROUND(AVG(visibility)::numeric, 1)                   AS visibility,
        MAX(open_card_pct)                                   AS open_card_pct,
        MAX(orders_pct)                                      AS orders_pct
      FROM wb_search_queries
      WHERE date >= ?
      GROUP BY keyword
      ORDER BY orders DESC NULLS LAST, freq DESC NULLS LAST
      LIMIT 200
    `).all(from);

    // ----------------------------------------------------------------
    //  Вкладка 2: Воронка по товарам (wb_funnel_daily, агрегированно за период).
    //  JOIN к wb_articles для имени товара.
    // ----------------------------------------------------------------
    const funnel = await db.prepare(`
      SELECT
        f.nm_id,
        COALESCE(a.name, '—')                                AS name,
        COALESCE(a.brand, '')                                AS brand,
        COALESCE(a.subject, '')                              AS subject,
        ROUND(AVG(f.avg_position)::numeric, 1)               AS avg_position,
        ROUND(AVG(f.visibility)::numeric, 1)                 AS visibility,
        SUM(f.open_card)                                     AS open_card,
        SUM(f.add_to_cart)                                   AS add_to_cart,
        SUM(f.orders)                                        AS orders,
        ROUND(AVG(f.open_to_cart)::numeric, 1)               AS open_to_cart_pct,
        ROUND(AVG(f.cart_to_order)::numeric, 1)              AS cart_to_order_pct,
        COUNT(*)                                             AS days_cnt
      FROM wb_funnel_daily f
      LEFT JOIN articles a ON a.nm_id = f.nm_id
      WHERE f.date >= ?
      GROUP BY f.nm_id, a.name, a.brand, a.subject
      ORDER BY orders DESC NULLS LAST, open_card DESC NULLS LAST
      LIMIT 200
    `).all(from);

    // ----------------------------------------------------------------
    //  KPI для шапки (агрегаты по всему окну).
    // ----------------------------------------------------------------
    const kpiRow = (await db.prepare(`
      SELECT
        COUNT(DISTINCT keyword)                              AS uniq_keywords,
        ROUND(AVG(avg_position)::numeric, 1)                 AS avg_position,
        SUM(open_card)                                       AS total_open_card,
        SUM(add_to_cart)                                     AS total_add_to_cart,
        SUM(orders)                                          AS total_orders
      FROM wb_search_queries
      WHERE date >= ?
    `).all(from))[0] || {};

    const crOpenCardToOrder = (kpiRow.total_open_card > 0)
      ? round2((kpiRow.total_orders / kpiRow.total_open_card) * 100) : null;
    const crCartToOrder = (kpiRow.total_add_to_cart > 0)
      ? round2((kpiRow.total_orders / kpiRow.total_add_to_cart) * 100) : null;

    const kpis = {
      uniq_keywords: kpiRow.uniq_keywords || 0,
      avg_position: kpiRow.avg_position,
      total_open_card: kpiRow.total_open_card || 0,
      total_orders: kpiRow.total_orders || 0,
      cr_open_to_order: crOpenCardToOrder,
      cr_cart_to_order: crCartToOrder,
    };

    // Последняя дата сбора (для шапки «данные на дату»).
    const lastDateRow = (await db.prepare(`
      SELECT MAX(date) AS d FROM (
        SELECT MAX(date) AS date FROM wb_search_queries
        UNION ALL SELECT MAX(date) AS date FROM wb_funnel_daily
      ) x
    `).all())[0];
    const lastDate = lastDateRow?.d || null;

    const hasData = (queries.length > 0) || (funnel.length > 0);

    return NextResponse.json({
      days,
      lastDate,
      hasData,
      kpis,
      queries,
      funnel,
    });
  } catch (e) {
    console.error("[buyer-portrait] error:", e);
    return NextResponse.json(
      { error: String(e?.message || e), stack: e?.stack },
      { status: 500 }
    );
  }
});
