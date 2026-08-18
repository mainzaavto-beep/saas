import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// =====================================================================
//  /api/orders — журнал заказов «как в Mpassistant» (24 колонки).
//
//  Источник (после №23/№24): order_costs в каждой БД уже содержит ВСЕ
//  компоненты + profit по каждому заказу. Мы JOIN'им её с orders (склад/
//  регион/статус) и articles/products (фото/бренд/имя), унифицируем WB+Ozon
//  в единый формат и отдаём одной лентой.
//
//  Поля ответа (соответствие колонкам export_order.csv):
//    number        = srid(WB) | posting_number(Ozon)      — «Номер заказа»
//    sa            = supplier_article(WB) | offer_id(Ozon) — «Артикул продавца»
//    nm            = nm_id(WB) | product_id(Ozon)         — «Артикул МП»
//    size          = tech_size(WB) | size(Ozon)
//    status        = нормализованный статус
//    order_dt, sale_dt, cancel_dt, return_dt
//    qty           = «Количество, шт.»
//    cost          = «Себестоимость, руб.» (order_costs.cost)
//    order_total   = «Стоимость заказа, руб.» (cost_value_retail — цена со
//                    всеми скидками, что заплатил покупатель)
//    sale_total    = «Сумма продажи, руб.» (cost_value_pay — что получит
//                    продавец; 0 для недоставленных)
//    commission, acquiring, logistics, loyalty, profit
//    self_buyout   = «Самовыкуп»
//    posting_id    = «Номер поставки» (g_number WB | posting_number Ozon)
//    platform      = 'wb' | 'ozon'                          — «Маркетплейс»
//    shop          = имя магазина (константа по МП)
//    warehouse     = «Склад отправки»
//    destination   = «Куда (доставка)»
//    name, brand, im_url — из articles/products (для композитной колонки «Товар»)
// =====================================================================




export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "500", 10), 2000);
    const platform = url.searchParams.get("platform") || "all"; // all|wb|ozon
    const status = url.searchParams.get("status") || "all";     // all|delivered|cancelled|delivering|return
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const from = url.searchParams.get("from") || "";            // YYYY-MM-DD
    const to = url.searchParams.get("to") || "";

    let items = [];
    if (platform !== "ozon") items = items.concat(await collectWB(limit, cabinet.shop_names?.wb));
    if (platform !== "wb")   items = items.concat(await collectOzon(limit, cabinet.shop_names?.ozon));

    // Фильтрация (после объединения — единые имена полей)
    if (status !== "all") items = items.filter((i) => i.statusGroup === status);
    if (q) {
      items = items.filter((i) =>
        String(i.sa || "").toLowerCase().includes(q) ||
        String(i.nm || "").includes(q) ||
        String(i.name || "").toLowerCase().includes(q) ||
        String(i.number || "").toLowerCase().includes(q) ||
        String(i.brand || "").toLowerCase().includes(q)
      );
    }
    if (from) items = items.filter((i) => (i.order_dt || "") >= from);
    if (to)   items = items.filter((i) => (i.order_dt || "") <= to + "T23:59:59");

    // Сортировка: новые сверху (по дате заказа)
    items.sort((a, b) => (b.order_dt || "").localeCompare(a.order_dt || ""));
    items = items.slice(0, limit);

    // Тоталы по выборке (для строки «Итого»)
    const totals = agg(items);

    return NextResponse.json({
      count: items.length,
      totals,
      items,
      shops: { wb: cabinet.shop_names?.wb, ozon: cabinet.shop_names?.ozon },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});

function agg(items) {
  const t = { qty: 0, cost: 0, orderTotal: 0, saleTotal: 0, commission: 0, acquiring: 0, logistics: 0, loyalty: 0, profit: 0 };
  for (const i of items) {
    t.qty += i.qty || 0;
    t.cost += i.cost || 0;
    t.orderTotal += i.order_total || 0;
    t.saleTotal += i.sale_total || 0;
    t.commission += i.commission || 0;
    t.acquiring += i.acquiring || 0;
    t.logistics += i.logistics || 0;
    t.loyalty += i.loyalty || 0;
    t.profit += i.profit || 0;
  }
  return t;
}

// ---------- WB ----------
// WB: order_costs — основа (там все компоненты). JOIN orders для склада/статуса/региона,
// articles для фото/бренда/имени.

async function collectWB(limit, shopName) {
  const db = new DatabaseSync("wb", { readOnly: true });
  const rows = await db.prepare(
    `SELECT oc.srid          AS number,
            oc.nm_id        AS nm,
            oc.sa_name      AS sa,
            o.tech_size     AS size,
            o.warehouse_name AS warehouse,
            o.region_name   AS destination,
            o.brand         AS brand,
            o.subject       AS subject,
            a.name          AS name,
            a.im_url        AS im_url,
            oc.order_dt, oc.sale_dt, o.cancel_dt, oc.return_dt,
            oc.is_return, oc.self_buyout,
            oc.qty,
            COALESCE(co.cost, oc.cost) AS cost,
            oc.cost_value_retail AS order_total,
            oc.cost_value_pay AS sale_total,
            oc.commission, oc.acquiring, oc.logistics, oc.loyalty,
            oc.profit + COALESCE(oc.cost, 0) - COALESCE(co.cost, oc.cost, 0) AS profit,
            o.g_number      AS posting_id,
            oc.updated_at
     FROM order_costs oc
     LEFT JOIN orders o   ON o.srid = oc.srid
     LEFT JOIN articles a ON a.nm_id = oc.nm_id
     LEFT JOIN LATERAL (
       SELECT cost FROM tenant.cost_overrides
       WHERE nm_id = oc.nm_id AND platform = 'wb'
         AND effective_from <= COALESCE(substr(oc.sale_dt,1,10)::date, substr(oc.order_dt,1,10)::date, current_date)
       ORDER BY effective_from DESC LIMIT 1
     ) co ON true
     ORDER BY oc.order_dt DESC NULLS LAST
     LIMIT ?`
  ).all(limit);

  // PENDING-заказы: есть в orders, но ЕЩЁ НЕ дошли до order_costs (заказаны, но не
  // выкуплены/обработаны). order_costs наполняется из финансового report-detail, который
  // появляется только по факту продажи/логистики → свежие «в пути» заказы здесь отсутствуют.
  // Добираем их из orders. Финансовые поля = 0 (нет продажи), себестоимость — из cogs,
  // стоимость заказа = price_with_disc (цена со скидкой, что заплатил покупатель).
  const pending = await db.prepare(
    `SELECT o.srid          AS number,
            o.nm_id        AS nm,
            o.supplier_article AS sa,
            o.tech_size     AS size,
            o.warehouse_name AS warehouse,
            o.region_name   AS destination,
            o.brand         AS brand,
            o.subject       AS subject,
            a.name          AS name,
            a.im_url        AS im_url,
            o.order_dt,
            NULL            AS sale_dt,
            o.cancel_dt,
            NULL            AS return_dt,
            0               AS is_return,
            0               AS self_buyout,
            1               AS qty,
            COALESCE(co.cost, 0) AS cost,
            o.price_with_disc AS order_total,
            0               AS sale_total,
            0               AS commission, 0 AS acquiring, 0 AS logistics, 0 AS loyalty,
            -COALESCE(co.cost, 0) AS profit,
            o.g_number      AS posting_id,
            o.updated_at,
            o.is_cancel
     FROM orders o
     LEFT JOIN articles a ON a.nm_id = o.nm_id
     LEFT JOIN LATERAL (
       SELECT cost FROM tenant.cost_overrides
       WHERE nm_id = o.nm_id AND platform = 'wb'
         AND effective_from <= COALESCE(substr(o.order_dt,1,10)::date, current_date)
       ORDER BY effective_from DESC LIMIT 1
     ) co ON true
     WHERE NOT EXISTS (SELECT 1 FROM order_costs oc WHERE oc.srid = o.srid)
     ORDER BY o.order_dt DESC`
  ).all();

  const mapped = rows.map((r) => ({
    ...r,
    platform: "wb",
    shop: shopName,
    statusGroup: wbStatusGroup(r),
    statusLabel: wbStatusLabel(r),
  }));
  // pending-строки идут тем же форматом, но статус = delivering/cancelled по is_cancel.
  for (const r of pending) {
    const cancelled = (r.is_cancel === 1) ||
      (r.cancel_dt && r.cancel_dt !== "0001-01-01T00:00:00");
    mapped.push({
      ...r,
      platform: "wb",
      shop: shopName,
      statusGroup: cancelled ? "cancelled" : "delivering",
      statusLabel: cancelled ? "Отменён" : "Доставляется",
    });
  }
  return mapped;
}

// WB: статусов нет — выводим из is_cancel/is_return + наличия дат.
function wbStatusGroup(r) {
  if (r.is_return === 1) return "return";
  if (r.cancel_dt && r.cancel_dt !== "0001-01-01T00:00:00" && !r.sale_dt) return "cancelled";
  if (r.sale_dt) return "delivered";
  return "delivering";
}
function wbStatusLabel(r) {
  if (r.is_return === 1) return "Возврат";
  if (r.cancel_dt && r.cancel_dt !== "0001-01-01T00:00:00" && !r.sale_dt) return "Отменён";
  if (r.sale_dt) return "Доставлен";
  return "Доставляется";
}

// ---------- Ozon ----------
// Ozon: order_costs тоже основа. JOIN orders (статус/склад/регион) + products (фото/бренд/имя).
async function collectOzon(limit, shopName) {
  const db = new DatabaseSync("ozon", {readOnly:true});
  const rows = await db.prepare(
    `SELECT oc.posting_number AS number,
            oc.product_id     AS nm,
            p.offer_id        AS sa,
            oc.size           AS size,
            o.warehouse       AS warehouse,
            o.region          AS destination,
            p.name            AS name,
            p.brand           AS brand,
            p.category        AS subject,
            p.im_url          AS im_url,
            oc.order_dt, oc.sale_dt, oc.return_dt, o.cancel_dt, o.status AS order_status,
            oc.is_return, oc.self_buyout,
            oc.qty,
            COALESCE(co.cost, oc.cost) AS cost,
            oc.cost_value_retail AS order_total,
            oc.commission, oc.acquiring, oc.logistics, oc.loyalty,
            oc.profit + COALESCE(oc.cost, 0) - COALESCE(co.cost, oc.cost, 0) AS profit,
            oc.posting_number AS posting_id,
            oc.updated_at
     FROM order_costs oc
     LEFT JOIN orders o   ON o.posting_number = oc.posting_number
     LEFT JOIN products p ON p.product_id = oc.product_id
     LEFT JOIN LATERAL (
       SELECT cost FROM tenant.cost_overrides
       WHERE product_id = oc.product_id AND platform = 'ozon'
         AND effective_from <= COALESCE(substr(oc.sale_dt,1,10)::date, substr(oc.order_dt,1,10)::date, current_date)
       ORDER BY effective_from DESC LIMIT 1
     ) co ON true
     ORDER BY oc.order_dt DESC NULLS LAST
     LIMIT ?`
  ).all(limit);

  // PENDING-заказы Ozon: orders есть, order_costs ещё нет (свежие/в пути/отменённые-рано).
  // order_costs наполняется из finance/transaction-list с лагом → недавние delivering
  // здесь отсутствуют. Добираем из orders; sale_total/финансы = 0, стоимость = total.
  const pending = await db.prepare(
    `SELECT o.posting_number AS number,
            o.product_id     AS nm,
            p.offer_id       AS sa,
            o.size           AS size,
            o.warehouse      AS warehouse,
            o.region         AS destination,
            p.name           AS name,
            p.brand          AS brand,
            p.category       AS subject,
            p.im_url         AS im_url,
            o.order_dt,
            NULL             AS sale_dt,
            NULL             AS return_dt,
            o.cancel_dt,
            0                AS is_return,
            0                AS self_buyout,
            o.qty,
            COALESCE(co.cost, 0) AS cost,
            o.total          AS order_total,
            0                AS commission, 0 AS acquiring, 0 AS logistics, 0 AS loyalty,
            -- profit = 0, НЕ -cost*qty (решение владельца, задача 6 плана
            -- «ремонт данных прибыли Ozon», round 3): pending-заказы (в пути/
            -- свежедоставленные/незрелые отменённые, без строки order_costs —
            -- включая юниты без commission-блока, ещё не финализированные
            -- Ozon'ом и потому НЕ записанные сборщиком вовсе, см.
            -- worker/collectors/ozon_order_costs.py) не должны показывать
            -- фантомный убыток (был: -cost*qty — списывали себестоимость, но
            -- Ozon ещё не подтвердил ни продажу, ни возврат). Раньше это было
            -- невидимо в /orders вовсе (order_costs не пишет незрелые строки),
            -- теперь видно строкой статуса с нулевыми финансами.
            0                AS profit,
            o.posting_number AS posting_id,
            o.updated_at,
            o.status,
            o.is_cancel
     FROM orders o
     LEFT JOIN products p ON p.product_id = o.product_id
     LEFT JOIN LATERAL (
       SELECT cost FROM tenant.cost_overrides
       WHERE product_id = o.product_id AND platform = 'ozon'
         AND effective_from <= COALESCE(substr(o.order_dt,1,10)::date, current_date)
       ORDER BY effective_from DESC LIMIT 1
     ) co ON true
     WHERE NOT EXISTS (SELECT 1 FROM order_costs oc
                       WHERE oc.posting_number = o.posting_number AND oc.product_id = o.product_id)
     ORDER BY o.order_dt DESC`
  ).all();

  const mapped = rows.map((r) => ({
    ...r,
    platform: "ozon",
    shop: shopName,
    statusGroup: ozonStatusGroup(r),
    statusLabel: ozonStatusLabel(r),
  }));
  for (const r of pending) {
    const { status } = r;
    let group = "delivering", label = "Доставляется";
    if (r.is_cancel === 1 || status === "cancelled") { group = "cancelled"; label = "Отменён"; }
    // F3 (фикс-волна финального ревью 2026-08-18): заказ УЖЕ доставлен
    // (Ozon.status='delivered'), но order_costs его ещё не подхватил (юнит
    // без commission-блока — сборщик его не пишет вовсе, см.
    // worker/collectors/ozon_order_costs.py::IN_TRANSIT_ORDER_STATUSES) —
    // раньше показывался "Доставляется" (default), хотя физически уже нет.
    else if (status === "delivered") { group = "delivered"; label = "Доставлен"; }
    else if (status === "awaiting_packaging") { group = "delivering"; label = "Ожидает упаковки"; }
    else if (status === "awaiting_deliver") { group = "delivering"; label = "Ожидает отгрузки"; }
    mapped.push({ ...r, platform: "ozon", shop: shopName, statusGroup: group, statusLabel: label });
  }
  return mapped;
}

// F3 (фикс-волна финального ревью 2026-08-18): те же три "в пути" статуса
// заказа, что worker/collectors/ozon_order_costs.py::IN_TRANSIT_ORDER_
// STATUSES — держим синхронно (комментарий-маркер вместо общего модуля,
// т.к. Python-сборщик и Node-роут не делят код).
const IN_TRANSIT_ORDER_STATUSES = new Set(["delivering", "awaiting_packaging", "awaiting_deliver"]);

function ozonStatusGroup(r) {
  if (r.is_return === 1) return "return";
  // Строка с sale_dt, но заказ ПО СТАТУСУ ozon_orders всё ещё в пути (после
  // F3 в сборщике — редкий остаток: рассинхрон заказа/начислений, не
  // штатный случай) НЕ должна показывать "доставлен".
  if (r.sale_dt && !IN_TRANSIT_ORDER_STATUSES.has(r.order_status)) return "delivered";
  // Ozon: есть явный статус в orders.status, но в order_costs его нет —
  // используем эвристику по датам
  if (r.cancel_dt) return "cancelled";
  return "delivering";
}
function ozonStatusLabel(r) {
  if (r.is_return === 1) return "Возврат";
  if (r.sale_dt && !IN_TRANSIT_ORDER_STATUSES.has(r.order_status)) return "Доставлен";
  if (r.cancel_dt) return "Отменён";
  return "Доставляется";
}
