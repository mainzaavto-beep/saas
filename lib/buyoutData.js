// lib/buyoutData.js — данные для процента выкупа WB и Ozon (lib/buyout.js). Вызывается
// изнутри withCabinet (tenantQuery, RLS по cabinet_id). WB: заказы периода по дате заказа
// + признаки судьбы по srid (wb_sales без индекса по srid — признаки продаж агрегируются
// один раз по srid когорты через CTE, а не EXISTS на каждую строку). Ozon: заказы периода
// по posting_number + признаки возврата/самовыкупа из ozon_order_costs (CTE, сборщик уже
// склеил формы номеров начислений, см. lib/buyout.js классификацию). ozon_products имеет
// PK (cabinet_id, product_id) — JOIN для имени не размножает строки.
import { ozonBasket } from "./buyout.js";

let _db = null;
async function getDb() { if (!_db) _db = await import("./db.js"); return _db; }

export async function loadWbBuyoutRows(from, to) {
  const { tenantQuery } = await getDb();
  const rows = await tenantQuery(
    `WITH o AS (
       SELECT srid, nm_id, supplier_article, COALESCE(NULLIF(tech_size, ''), '0') AS size, category, g_number,
              substr(order_dt, 1, 10) AS order_date, is_cancel, COALESCE(cancel_dt, last_change_dt) AS cancel_at
       FROM tenant.wb_orders
       WHERE substr(order_dt, 1, 10) BETWEEN $1 AND $2
         AND warehouse_type = 'Склад WB' -- только FBO: FBS (Склад продавца) в выкупе не смотрим (владелец 14.10.2026)
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
     SELECT o.srid, o.nm_id, o.supplier_article, o.size, o.category, o.g_number, o.order_date, o.is_cancel, o.cancel_at,
            a.name, a.imt_id, COALESCE(s.has_sale, false) AS has_sale, COALESCE(s.has_return, false) AS has_return,
            (f.srid IS NOT NULL) AS refused_logistics, (sb.srid IS NOT NULL) AS self_buyout
     FROM o
     LEFT JOIN s ON s.srid = o.srid
     LEFT JOIN f ON f.srid = o.srid
     LEFT JOIN sb ON sb.srid = o.srid
     LEFT JOIN tenant.wb_articles a ON a.nm_id = o.nm_id`,
    [from, to]
  );
  return rows.map((r) => ({
    platform: "wb",
    srid: r.srid,
    nmId: Number(r.nm_id),
    article: r.supplier_article || null,
    name: r.name || null,
    category: r.category || null, // wb_orders.category — та же «Категория», что фильтр Сводки
    size: r.size,
    orderDate: r.order_date,
    isCancel: Number(r.is_cancel) === 1,
    cancelAt: r.cancel_at || null,
    hasSale: r.has_sale === true,
    hasReturn: r.has_return === true,
    refusedLogistics: r.refused_logistics === true,
    selfBuyout: r.self_buyout === true,
    basket: r.g_number || r.srid, // корзина покупателя (одна покупка); пусто — заказ сам себе корзина
    modelKey: r.imt_id ? `imt:${r.imt_id}` : `nm:${r.nm_id}`, // модель = imtID (цвета склеены)
    variantKey: `${r.nm_id}|${r.size}`,
    colorKey: String(r.nm_id), // у WB nm внутри imt — цвет
    sizeKey: r.size,
    sizeLabel: r.size === "0" ? "без размера" : r.size,
    fitEstimated: !r.imt_id,
  }));
}

// Ограничения (контракт §18.3): (a) qty товарной строки не учитывается — при qty>1
// считаем строки, не штуки; (b) is_return стоит по отправлению целиком — частичный
// возврат в многотоварном отправлении пометил бы возвратом все его товары.
export async function loadOzonBuyoutRows(from, to) {
  const { tenantQuery } = await getDb();
  const rows = await tenantQuery(
    `WITH o AS (
       SELECT posting_number, product_id, offer_id, status, substr(order_dt::text, 1, 10) AS order_date,
              COALESCE(cancel_dt, last_change_dt)::text AS cancel_at, cancel_reason, region
       FROM tenant.ozon_orders
       WHERE substr(order_dt::text, 1, 10) BETWEEN $1 AND $2
         AND scheme = 'fbo' -- только FBO: FBS в выкупе не смотрим (владелец 14.10.2026)
     ),
     c AS (
       SELECT posting_number, bool_or(is_return = 1) AS is_return, bool_or(self_buyout = 1) AS self_buyout
       FROM tenant.ozon_order_costs WHERE posting_number IN (SELECT posting_number FROM o) GROUP BY posting_number
     )
     SELECT o.posting_number, o.product_id, o.offer_id, o.status, o.order_date, o.cancel_at, o.cancel_reason, o.region,
            p.name, p.category, p.model_id, p.color, p.size AS attr_size,
            COALESCE(c.is_return, false) AS is_return, COALESCE(c.self_buyout, false) AS self_buyout
     FROM o
     LEFT JOIN c ON c.posting_number = o.posting_number
     LEFT JOIN tenant.ozon_products p ON p.product_id = o.product_id`,
    [from, to]
  );
  return rows.map((r) => ({
    platform: "ozon",
    srid: r.posting_number,
    nmId: Number(r.product_id),
    article: r.offer_id || null,
    name: r.name || null,
    category: r.category || null, // ozon_products.category — как «Категория» Сводки
    size: "0",
    orderDate: r.order_date,
    status: r.status,
    cancelAt: r.cancel_at || null,
    cancelReason: r.cancel_reason || null, // миграция 066, классификация — lib/buyout.js
    isReturn: r.is_return === true,
    selfBuyout: r.self_buyout === true,
    buyer: String(r.posting_number).split("-")[0], // покупатель — наблюдение пробы 20.10.2026, см. lib/buyout.js
    orderNumber: ozonBasket(r.posting_number),
    region: r.region || null,
    basket: ozonBasket(r.posting_number), // номер заказа = корзина покупателя
    modelKey: r.model_id ? `m:${r.model_id}` : `n:${r.name || r.product_id}`,
    variantKey: String(r.product_id),
    colorKey: r.color || "",
    sizeKey: r.attr_size || "",
    sizeLabel: r.attr_size || r.offer_id || String(r.product_id),
    fitEstimated: !r.model_id,
  }));
}

export async function loadBuyoutRows(platform, from, to) {
  const out = [];
  if (platform !== "ozon") out.push(...(await loadWbBuyoutRows(from, to)));
  if (platform !== "wb") out.push(...(await loadOzonBuyoutRows(from, to)));
  return out;
}
