// lib/buyoutData.js — данные для процента выкупа WB (lib/buyout.js). Вызывается изнутри
// withCabinet (tenantQuery, RLS по cabinet_id). Один запрос: заказы периода по дате заказа
// + признаки судьбы по srid. wb_sales без индекса по srid — поэтому признаки продаж
// агрегируются один раз по srid когорты (CTE), а не EXISTS на каждую строку.
let _db = null;
async function getDb() { if (!_db) _db = await import("./db.js"); return _db; }

export async function loadWbBuyoutRows(from, to) {
  const { tenantQuery } = await getDb();
  const rows = await tenantQuery(
    `WITH o AS (
       SELECT srid, nm_id, supplier_article, COALESCE(NULLIF(tech_size, ''), '0') AS size,
              substr(order_dt, 1, 10) AS order_date, is_cancel, COALESCE(cancel_dt, last_change_dt) AS cancel_at
       FROM tenant.wb_orders
       WHERE substr(order_dt, 1, 10) BETWEEN $1 AND $2
     ),
     s AS (
       SELECT srid, bool_or(sale_id LIKE 'S%') AS has_sale, bool_or(sale_id LIKE 'R%') AS has_return
       FROM tenant.wb_sales WHERE srid IN (SELECT srid FROM o) GROUP BY srid
     ),
     f AS (
       SELECT DISTINCT srid FROM tenant.wb_finance_report
       WHERE srid IN (SELECT srid FROM o) AND bonus_type_name LIKE 'К клиенту при отмене%'
     ),
     sb AS (
       SELECT srid FROM tenant.wb_order_costs WHERE srid IN (SELECT srid FROM o) AND self_buyout = 1
     )
     SELECT o.srid, o.nm_id, o.supplier_article, o.size, o.order_date, o.is_cancel, o.cancel_at,
            a.name, COALESCE(s.has_sale, false) AS has_sale, COALESCE(s.has_return, false) AS has_return,
            (f.srid IS NOT NULL) AS refused_logistics, (sb.srid IS NOT NULL) AS self_buyout
     FROM o
     LEFT JOIN s ON s.srid = o.srid
     LEFT JOIN f ON f.srid = o.srid
     LEFT JOIN sb ON sb.srid = o.srid
     LEFT JOIN tenant.wb_articles a ON a.nm_id = o.nm_id`,
    [from, to]
  );
  return rows.map((r) => ({
    srid: r.srid,
    nmId: Number(r.nm_id),
    article: r.supplier_article || null,
    name: r.name || null,
    size: r.size,
    orderDate: r.order_date,
    isCancel: Number(r.is_cancel) === 1,
    cancelAt: r.cancel_at || null,
    hasSale: r.has_sale === true,
    hasReturn: r.has_return === true,
    refusedLogistics: r.refused_logistics === true,
    selfBuyout: r.self_buyout === true,
  }));
}
