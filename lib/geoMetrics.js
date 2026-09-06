/**
 * lib/geoMetrics.js — канон вкладки «География» (спека 2026-08-28-geography-v2, §3).
 *
 * Правила:
 *  - штуки WB = COUNT(*) (строка заказа/продажи = 1 шт), Ozon = SUM(qty);
 *  - продажи Ozon из tenant.ozon_sales (после этапа 1 честные: реальный статус),
 *    выручка = SUM(revenue) — возвраты входят отрицательными;
 *  - схема: WB warehouse_type ('Склад WB'→fbo, 'Склад продавца'→fbs), Ozon scheme;
 *  - пустое гео-имя → 'Не указан', незамапленный ФО → 'Не определено';
 *  - скорость WB — ПРОКСИ «заказ → выкуп» по srid (даты доставки WB не отдаёт);
 *    скорость Ozon — точная order_dt → delivered_dt, только FBO (рФБС возит сам,
 *    последней мили в начислениях нет — delivered_dt пуст, поверено 05.09.2026);
 *  - shared.* пишется полным путём — convertSql его не переписывает.
 */
const EMPTY = "Не указан";
const UNMAPPED = "Не определено";

const WB_SCHEME_SQL = { fbo: "= 'Склад WB'", fbs: "= 'Склад продавца'" };

function wbSchemeCond(alias, scheme) {
  if (!scheme || scheme === "all") return "";
  return ` AND ${alias}.warehouse_type ${WB_SCHEME_SQL[scheme]}`;
}

function ozSchemeCond(alias, scheme) {
  if (!scheme || scheme === "all") return "";
  return ` AND ${alias}.scheme = '${scheme === "fbs" ? "fbs" : "fbo"}'`;
}

// ── Сводки «заказы/продажи × регион/склад» ──────────────────────────
// По образцу geography/route.js:72-129, но с фиксами канона («одна цифра»
// со Сводкой — сторож задачи 4 сверяет РОВНО):
//  - заказы: is_cancel = 0 (= wbOrdersCount; старая вкладка считала с
//    отменами — осознанное изменение);
//  - продажи WB: is_realization = 1 (только выкупы, S-строки; возвраты
//    в гео-потоках не вычитаются).
export async function wbGeoSummary(db, { from, to, scheme, nmId, brand, group, q } = {}) {
  const oConds = ["o.is_cancel = 0"];
  const oParams = [];
  if (from) { oConds.push("substr(o.order_dt,1,10) >= ?"); oParams.push(from); }
  if (to) { oConds.push("substr(o.order_dt,1,10) <= ?"); oParams.push(to); }
  if (nmId) { oConds.push("o.nm_id = ?"); oParams.push(Number(nmId)); }
  if (brand) { oConds.push("o.brand = ?"); oParams.push(brand); }
  if (group) { oConds.push("o.subject = ?"); oParams.push(group); }
  if (q) {
    oConds.push("(LOWER(o.supplier_article) LIKE ? OR LOWER(CAST(o.nm_id AS TEXT)) LIKE ? OR LOWER(COALESCE(a.name,'')) LIKE ? OR LOWER(o.brand) LIKE ?)");
    oParams.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const oWhere = oConds.join(" AND ") + wbSchemeCond("o", scheme);
  const articleJoin = "LEFT JOIN articles a ON a.nm_id = o.nm_id";

  const ordersRegion = await db.prepare(
    `SELECT COALESCE(NULLIF(o.okrug_name,''), '${EMPTY}') AS name, COUNT(*) AS qty, COALESCE(SUM(o.price_with_disc),0) AS rub
     FROM orders o ${articleJoin} WHERE ${oWhere} GROUP BY o.okrug_name`
  ).all(...oParams);
  const ordersWh = await db.prepare(
    `SELECT COALESCE(NULLIF(o.warehouse_name,''), '${EMPTY}') AS name, COUNT(*) AS qty, COALESCE(SUM(o.price_with_disc),0) AS rub
     FROM orders o ${articleJoin} WHERE ${oWhere} GROUP BY o.warehouse_name`
  ).all(...oParams);

  const sConds = ["s.is_realization = 1"];
  const sParams = [];
  if (from) { sConds.push("substr(s.sale_dt,1,10) >= ?"); sParams.push(from); }
  if (to) { sConds.push("substr(s.sale_dt,1,10) <= ?"); sParams.push(to); }
  if (nmId) { sConds.push("s.nm_id = ?"); sParams.push(Number(nmId)); }
  if (brand) { sConds.push("s.brand = ?"); sParams.push(brand); }
  if (group) { sConds.push("s.subject = ?"); sParams.push(group); }
  if (q) {
    sConds.push("(LOWER(s.supplier_article) LIKE ? OR LOWER(CAST(s.nm_id AS TEXT)) LIKE ? OR LOWER(COALESCE(a.name,'')) LIKE ? OR LOWER(s.brand) LIKE ?)");
    sParams.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sWhere = sConds.join(" AND ") + wbSchemeCond("s", scheme);

  const salesRegion = await db.prepare(
    `SELECT COALESCE(NULLIF(s.okrug_name,''), '${EMPTY}') AS name, COUNT(*) AS qty, COALESCE(SUM(s.finished_price),0) AS rub
     FROM sales s LEFT JOIN articles a ON a.nm_id = s.nm_id WHERE ${sWhere} GROUP BY s.okrug_name`
  ).all(...sParams);
  const salesWh = await db.prepare(
    `SELECT COALESCE(NULLIF(s.warehouse_name,''), '${EMPTY}') AS name, COUNT(*) AS qty, COALESCE(SUM(s.finished_price),0) AS rub
     FROM sales s LEFT JOIN articles a ON a.nm_id = s.nm_id WHERE ${sWhere} GROUP BY s.warehouse_name`
  ).all(...sParams);

  return {
    byRegion: zipGeo(ordersRegion, salesRegion),
    byWarehouse: zipGeo(ordersWh, salesWh),
  };
}

// Ozon: заказы из orders (is_cancel=0), продажи из sales (is_return=0, честные
// после этапа 1). У продаж нет гео-колонок — гео берётся JOIN-ом к заказу по
// (posting_number, product_id): гео постинга едино для заказа и продажи.
export async function ozGeoSummary(db, { from, to, scheme, nmId, brand, group, q } = {}) {
  const oConds = ["o.is_cancel = 0"];
  const oParams = [];
  if (from) { oConds.push("substr(o.order_dt,1,10) >= ?"); oParams.push(from); }
  if (to) { oConds.push("substr(o.order_dt,1,10) <= ?"); oParams.push(to); }
  if (nmId) { oConds.push("o.product_id = ?"); oParams.push(Number(nmId)); }
  if (brand) { oConds.push("p.brand = ?"); oParams.push(brand); }
  if (group) { oConds.push("p.category = ?"); oParams.push(group); }
  if (q) {
    oConds.push("(LOWER(o.offer_id) LIKE ? OR LOWER(CAST(o.product_id AS TEXT)) LIKE ? OR LOWER(COALESCE(p.name,'')) LIKE ?)");
    oParams.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const oWhere = oConds.join(" AND ") + ozSchemeCond("o", scheme);
  const productJoin = "LEFT JOIN products p ON p.product_id = o.product_id";

  const ordersRegion = await db.prepare(
    `SELECT COALESCE(NULLIF(o.region,''), '${EMPTY}') AS name, SUM(o.qty) AS qty, SUM(o.total) AS rub
     FROM orders o ${productJoin} WHERE ${oWhere} GROUP BY o.region`
  ).all(...oParams);
  const ordersWh = await db.prepare(
    `SELECT COALESCE(NULLIF(o.warehouse,''), '${EMPTY}') AS name, SUM(o.qty) AS qty, SUM(o.total) AS rub
     FROM orders o ${productJoin} WHERE ${oWhere} GROUP BY o.warehouse`
  ).all(...oParams);

  const sConds = ["s.is_return = 0"];
  const sParams = [];
  if (from) { sConds.push("substr(s.sale_dt,1,10) >= ?"); sParams.push(from); }
  if (to) { sConds.push("substr(s.sale_dt,1,10) <= ?"); sParams.push(to); }
  if (nmId) { sConds.push("s.product_id = ?"); sParams.push(Number(nmId)); }
  if (brand) { sConds.push("p.brand = ?"); sParams.push(brand); }
  if (group) { sConds.push("p.category = ?"); sParams.push(group); }
  if (q) {
    sConds.push("(LOWER(s.offer_id) LIKE ? OR LOWER(CAST(s.product_id AS TEXT)) LIKE ? OR LOWER(COALESCE(p.name,'')) LIKE ?)");
    sParams.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sWhere = sConds.join(" AND ") + ozSchemeCond("s", scheme);
  const saleJoin = `JOIN orders o ON o.posting_number = s.posting_number AND o.product_id = s.product_id
     LEFT JOIN products p ON p.product_id = s.product_id`;

  const salesRegion = await db.prepare(
    `SELECT COALESCE(NULLIF(o.region,''), '${EMPTY}') AS name, SUM(s.qty) AS qty, SUM(s.revenue) AS rub
     FROM sales s ${saleJoin} WHERE ${sWhere} GROUP BY o.region`
  ).all(...sParams);
  const salesWh = await db.prepare(
    `SELECT COALESCE(NULLIF(o.warehouse,''), '${EMPTY}') AS name, SUM(s.qty) AS qty, SUM(s.revenue) AS rub
     FROM sales s ${saleJoin} WHERE ${sWhere} GROUP BY o.warehouse`
  ).all(...sParams);

  return {
    byRegion: zipGeo(ordersRegion, salesRegion),
    byWarehouse: zipGeo(ordersWh, salesWh),
  };
}

function zipGeo(orders, sales) {
  const m = new Map();
  for (const r of orders) m.set(r.name, { name: r.name, ordersRub: r.rub, ordersQty: r.qty, salesRub: 0, salesQty: 0 });
  for (const r of sales) {
    const row = m.get(r.name) || { name: r.name, ordersRub: 0, ordersQty: 0, salesRub: 0, salesQty: 0 };
    row.salesRub = r.rub; row.salesQty = r.qty;
    m.set(r.name, row);
  }
  return [...m.values()];
}

/** Фаззи-мэтчинг имени склада WB на справочник shared.wb_warehouses.
 * Перенесён из stocks/route.js:496-520 (точный JOIN терял ~18% выручки:
 * «Самара (Новосемейкино)» vs «Новосемейкино»). ${col} — колонка имени склада. */
export function warehouseFuzzyLateral(col) {
  return `LEFT JOIN LATERAL (
    SELECT region FROM shared.wb_warehouses
    WHERE name = ${col}
       OR ${col} ILIKE '%' || name || '%'
       OR name ILIKE '%' || ${col} || '%'
    ORDER BY (name = ${col}) DESC, updated_at DESC
    LIMIT 1
  ) wh_l ON true`;
}

export async function wbSalesLocalityByWarehouse(db, { sinceDays }) {
  /* Точный перенос шага 2 buildWarehouseEfficiency (stocks/route.js:496-520):
     та же семантика окна last_change_dt >= current_date - N, тот же двойной
     джойн rtc_ok/rtc_reg (СНГ-хвост), тот же LATERAL. Меняться может только
     синхронно со вкладкой «Склады». */
  return db.prepare(`
    SELECT s.warehouse_name AS warehouse,
           wh_l.region AS cluster,
           COUNT(*) AS "sales_qty",
           COALESCE(SUM(s.for_pay), 0) AS "sales_rub",
           COUNT(*) FILTER (
             WHERE COALESCE(rtc_ok.cluster, rtc_reg.cluster) = wh_l.region
           ) AS "local_qty"
    FROM sales s
    LEFT JOIN shared.region_to_cluster rtc_ok ON rtc_ok.region = s.okrug_name
    LEFT JOIN shared.region_to_cluster rtc_reg
      ON rtc_reg.region = s.region_name AND (s.okrug_name IS NULL OR s.okrug_name = '')
    ${warehouseFuzzyLateral("s.warehouse_name")}
    WHERE s.last_change_dt::date >= current_date - ?::int
      AND s.warehouse_name IS NOT NULL AND s.warehouse_name <> ''
    GROUP BY s.warehouse_name, wh_l.region
  `).all(sinceDays);
}

export async function wbOrdersLocalityMatrix(db, { from, to, scheme } = {}) {
  const rows = await db.prepare(`
    SELECT COALESCE(wh_l.region, '${UNMAPPED}') AS "whCluster",
           COALESCE(rtc_ok.cluster, rtc_reg.cluster, '${UNMAPPED}') AS "buyerCluster",
           COUNT(*) AS qty
    FROM orders o
    LEFT JOIN shared.region_to_cluster rtc_ok ON rtc_ok.region = o.okrug_name
    LEFT JOIN shared.region_to_cluster rtc_reg
      ON rtc_reg.region = o.region_name AND (o.okrug_name IS NULL OR o.okrug_name = '')
    ${warehouseFuzzyLateral("o.warehouse_name")}
    WHERE substr(o.order_dt,1,10) >= ? AND substr(o.order_dt,1,10) <= ?
      AND o.is_cancel = 0 AND o.warehouse_name <> ''${wbSchemeCond("o", scheme)}
    GROUP BY 1, 2
  `).all(from, to);
  return withLocalityTotals(rows, "whCluster", "buyerCluster");
}

export async function ozOrdersLocalityMatrix(db, { from, to, scheme } = {}) {
  const rows = await db.prepare(`
    SELECT COALESCE(cf.fo, '${UNMAPPED}') AS "whFo",
           COALESCE(g.fo, '${UNMAPPED}') AS "buyerFo",
           SUM(o.qty) AS qty
    FROM orders o
    LEFT JOIN shared.ozon_clusters oc ON oc.warehouse_id = o.warehouse_id
    LEFT JOIN shared.ozon_cluster_fo cf ON cf.cluster_name = oc.cluster_name
    LEFT JOIN shared.ru_geo_fo g ON g.name = o.region
    WHERE substr(o.order_dt,1,10) >= ? AND substr(o.order_dt,1,10) <= ?
      AND o.is_cancel = 0${ozSchemeCond("o", scheme)}
    GROUP BY 1, 2
  `).all(from, to);
  return withLocalityTotals(rows, "whFo", "buyerFo");
}

/** localPct: доля qty с совпадением сторон среди пар, где ОБЕ стороны определены;
 *  mappedPct: доля qty определённых пар среди всех. «Не определено» не прячем —
 *  оно уходит в матрицу отдельной строкой/колонкой. */
function withLocalityTotals(rows, whKey, buyerKey) {
  let total = 0, mapped = 0, local = 0;
  for (const r of rows) {
    const q = Number(r.qty) || 0;
    total += q;
    if (r[whKey] !== UNMAPPED && r[buyerKey] !== UNMAPPED) {
      mapped += q;
      if (r[whKey] === r[buyerKey]) local += q;
    }
  }
  const round1 = (x) => Math.round(x * 10) / 10;
  return { rows,
    localPct: mapped > 0 ? round1((local * 100) / mapped) : null,
    mappedPct: total > 0 ? round1((mapped * 100) / total) : null };
}

export async function wbSpeedByOkrug(db, { from, to } = {}) {
  /* ПРОКСИ: заказ → выкуп (включает лежание на ПВЗ до выкупа). Окно по дате
     ВЫКУПА; выбросы >60 дней и отрицательные пары отсечены. Разрез по схеме
     склада заказа — «FBO vs FBS рядом» (спека §4.4). */
  return db.prepare(`
    SELECT COALESCE(NULLIF(s.okrug_name,''), '${EMPTY}') AS okrug,
           CASE WHEN o.warehouse_type = 'Склад продавца' THEN 'fbs' ELSE 'fbo' END AS scheme,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY (substr(s.sale_dt,1,10)::date - substr(o.order_dt,1,10)::date)
           ) AS "medianDays",
           COUNT(*) AS n
    FROM sales s
    JOIN orders o ON o.srid = s.srid
    WHERE s.is_realization = 1
      AND substr(s.sale_dt,1,10) >= ? AND substr(s.sale_dt,1,10) <= ?
      AND (substr(s.sale_dt,1,10)::date - substr(o.order_dt,1,10)::date) BETWEEN 0 AND 60
    GROUP BY 1, 2
  `).all(from, to);
}

export async function ozSpeedByFo(db, { from, to } = {}) {
  /* Точная скорость до выдачи: order_dt → delivered_dt (последняя миля из
     начислений, этап 1). Только FBO: у рФБС delivered_dt пуст (0/402 на 05.09). */
  return db.prepare(`
    SELECT COALESCE(g.fo, '${UNMAPPED}') AS fo,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY (o.delivered_dt::date - substr(o.order_dt,1,10)::date)
           ) AS "medianDays",
           COUNT(*) AS n
    FROM orders o
    LEFT JOIN shared.ru_geo_fo g ON g.name = o.region
    WHERE o.delivered_dt IS NOT NULL
      AND o.delivered_dt >= ? AND o.delivered_dt <= ?
      AND (o.delivered_dt::date - substr(o.order_dt,1,10)::date) BETWEEN 0 AND 60
    GROUP BY 1
  `).all(from, to);
}

export async function wbSpeedOverall(db, { from, to } = {}) {
  /* KPI-медиана по всей выборке (не среднее медиан по округам). */
  const r = await db.prepare(`
    SELECT percentile_cont(0.5) WITHIN GROUP (
             ORDER BY (substr(s.sale_dt,1,10)::date - substr(o.order_dt,1,10)::date)
           ) AS "medianDays", COUNT(*) AS n
    FROM sales s JOIN orders o ON o.srid = s.srid
    WHERE s.is_realization = 1
      AND substr(s.sale_dt,1,10) >= ? AND substr(s.sale_dt,1,10) <= ?
      AND (substr(s.sale_dt,1,10)::date - substr(o.order_dt,1,10)::date) BETWEEN 0 AND 60
  `).get(from, to);
  return { medianDays: r?.medianDays ?? null, n: r?.n ?? 0 };
}

export async function ozSpeedOverall(db, { from, to } = {}) {
  const r = await db.prepare(`
    SELECT percentile_cont(0.5) WITHIN GROUP (
             ORDER BY (o.delivered_dt::date - substr(o.order_dt,1,10)::date)
           ) AS "medianDays", COUNT(*) AS n
    FROM orders o
    WHERE o.delivered_dt IS NOT NULL
      AND o.delivered_dt >= ? AND o.delivered_dt <= ?
      AND (o.delivered_dt::date - substr(o.order_dt,1,10)::date) BETWEEN 0 AND 60
  `).get(from, to);
  return { medianDays: r?.medianDays ?? null, n: r?.n ?? 0 };
}

export async function wbFbsShare(db, { from, to } = {}) {
  const r = await db.prepare(`
    SELECT COUNT(*) FILTER (WHERE warehouse_type = 'Склад продавца') AS "fbsQty",
           COUNT(*) AS "totalQty"
    FROM orders
    WHERE substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ? AND is_cancel = 0
  `).get(from, to);
  return { fbsQty: r?.fbsQty ?? 0, totalQty: r?.totalQty ?? 0 };
}

export async function ozFbsShare(db, { from, to } = {}) {
  const r = await db.prepare(`
    SELECT COALESCE(SUM(qty) FILTER (WHERE scheme = 'fbs'), 0) AS "fbsQty",
           COALESCE(SUM(qty), 0) AS "totalQty"
    FROM orders
    WHERE substr(order_dt,1,10) >= ? AND substr(order_dt,1,10) <= ? AND is_cancel = 0
  `).get(from, to);
  return { fbsQty: r?.fbsQty ?? 0, totalQty: r?.totalQty ?? 0 };
}

export async function wbSupplyLagHours(db, { from, to } = {}) {
  /* Лаг «закрыл поставку → принята на СЦ» по wb_supplies (закрытые в окне).
     tenant.wb_supplies — полным путём: таблица новая (миграция 047), её нет
     в carte convertSql (lib/db.js COMMON_WB) — бэр "wb_supplies" не получил бы
     tenant.-префикс, как shared.* пишем схему явно. */
  const r = await db.prepare(`
    SELECT percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (scan_dt - closed_at)) / 3600.0
           ) AS "medianHours",
           COUNT(*) AS n
    FROM tenant.wb_supplies
    WHERE scan_dt IS NOT NULL AND closed_at IS NOT NULL
      AND closed_at::date >= ?::date AND closed_at::date <= ?::date
  `).get(from, to);
  return { medianHours: r?.medianHours ?? null, n: r?.n ?? 0 };
}

/** Порог «висящей» поставки: закрыта, скана нет, прошло 3-14 дней.
 * Старше 14 дней — «без отметки» (WB проставляет скан не для всех типов
 * приёмки, исторический хвост 42/120 на 05.09.2026 — это НЕ тревога). */
const SUPPLY_STUCK_MIN_DAYS = 3;
const SUPPLY_STUCK_MAX_DAYS = 14;

export async function wbSuppliesOps(db, { from, to } = {}) {
  const rows = await db.prepare(`
    SELECT supply_id AS "supplyId", name,
           created_at::text AS "createdAt", closed_at::text AS "closedAt",
           scan_dt::text AS "scanDt", done,
           ROUND((EXTRACT(EPOCH FROM (closed_at - created_at)) / 3600.0)::numeric, 1) AS "buildHours",
           ROUND((EXTRACT(EPOCH FROM (scan_dt - closed_at)) / 3600.0)::numeric, 1) AS "scHours",
           CASE
             WHEN scan_dt IS NOT NULL THEN 'scanned'
             WHEN done AND closed_at < now() - interval '${SUPPLY_STUCK_MAX_DAYS} days' THEN 'no_scan_old'
             WHEN done AND closed_at < now() - interval '${SUPPLY_STUCK_MIN_DAYS} days' THEN 'stuck'
             ELSE 'awaiting'
           END AS status
    FROM tenant.wb_supplies
    WHERE closed_at IS NOT NULL
      AND closed_at::date >= ?::date AND closed_at::date <= ?::date
    ORDER BY closed_at DESC
  `).all(from, to);
  const scanned = rows.filter((r) => r.scHours != null).map((r) => Number(r.scHours)).sort((a, b) => a - b);
  const q = (p) => scanned.length ? scanned[Math.min(scanned.length - 1, Math.floor(p * (scanned.length - 1) + 0.5))] : null;
  const builds = rows.filter((r) => r.buildHours != null).map((r) => Number(r.buildHours)).sort((a, b) => a - b);
  const qb = (p) => builds.length ? builds[Math.min(builds.length - 1, Math.floor(p * (builds.length - 1) + 0.5))] : null;

  // Время до покупателя: закрытие поставки → выкуп (wb_sales по srid==rid).
  // Включает лежание на ПВЗ до выкупа — «до выкупа», как WB-прокси в §16.4.
  // tenant.wb_fbs_tasks/tenant.wb_supplies — явными путями (нет в COMMON_WB,
  // convertSql их не трогает); sales → tenant.wb_sales через шим, как везде в файле.
  const buyoutRows = await db.prepare(`
    SELECT t.supply_id AS "supplyId",
           (substr(s.sale_dt,1,10)::date - w.closed_at::date) AS days
    FROM tenant.wb_fbs_tasks t
    JOIN tenant.wb_supplies w ON w.supply_id = t.supply_id
    JOIN sales s ON s.srid = t.rid AND s.is_realization = 1
    WHERE t.supply_id IS NOT NULL
      AND w.closed_at IS NOT NULL
      AND w.closed_at::date >= ?::date AND w.closed_at::date <= ?::date
      AND (substr(s.sale_dt,1,10)::date - w.closed_at::date) BETWEEN 0 AND 60
  `).all(from, to);
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(0.5 * (s.length - 1) + 0.5))] : null;
  };
  const bySupply = new Map();
  for (const r of buyoutRows) {
    const arr = bySupply.get(r.supplyId);
    if (arr) arr.push(Number(r.days));
    else bySupply.set(r.supplyId, [Number(r.days)]);
  }
  for (const row of rows) {
    const arr = bySupply.get(row.supplyId) || [];
    row.buyoutMedianDays = median(arr);
    row.buyoutN = arr.length;
  }
  const buyoutMedianDaysOverall = median(buyoutRows.map((r) => Number(r.days)));

  // Время до ПВЗ и статусы заданий (миграция 051, часовой wb_fbs_status).
  // pvz_at ставится переходом waiting|sorted → ready_for_pickup между двумя
  // опросами (WB не отдаёт время смены статуса) — точность = шаг таймера
  // (1 ч), поэтому дни с одним знаком. Задания, лежавшие на ПВЗ до первого
  // опроса, pvz_at не имеют (честный NULL) — pvzN у старых поставок 0.
  // Окно [0;30] дн — те же соображения, что [0;60] у buyoutDays выше.
  // Статусы задания → 4 ведра для разбивки «ещё едут»: transit (waiting,
  // sorted), pvz (ready_for_pickup), sold, canceled (canceled*, declined*,
  // defect); NULL-статус (нет order_id / ещё не опрошен) — unknown.
  const taskRows = await db.prepare(`
    SELECT t.supply_id AS "supplyId", t.wb_status AS "wbStatus",
           CASE WHEN t.pvz_at IS NOT NULL
                THEN ROUND((EXTRACT(EPOCH FROM (t.pvz_at - w.closed_at)) / 86400.0)::numeric, 1)
           END AS "pvzDays"
    FROM tenant.wb_fbs_tasks t
    JOIN tenant.wb_supplies w ON w.supply_id = t.supply_id
    WHERE t.supply_id IS NOT NULL
      AND w.closed_at IS NOT NULL
      AND w.closed_at::date >= ?::date AND w.closed_at::date <= ?::date
  `).all(from, to);
  const bucketOf = (st) => {
    if (st === "waiting" || st === "sorted") return "transit";
    if (st === "ready_for_pickup") return "pvz";
    if (st === "sold") return "sold";
    if (st) return "canceled";
    return "unknown";
  };
  const pvzAll = [];
  const pvzBySupply = new Map();
  const tasksBySupply = new Map();
  for (const r of taskRows) {
    const b = tasksBySupply.get(r.supplyId) || { transit: 0, pvz: 0, sold: 0, canceled: 0, unknown: 0 };
    b[bucketOf(r.wbStatus)] += 1;
    tasksBySupply.set(r.supplyId, b);
    if (r.pvzDays != null) {
      const d = Number(r.pvzDays);
      if (d >= 0 && d <= 30) {
        pvzAll.push(d);
        const arr = pvzBySupply.get(r.supplyId);
        if (arr) arr.push(d);
        else pvzBySupply.set(r.supplyId, [d]);
      }
    }
  }
  for (const row of rows) {
    const arr = pvzBySupply.get(row.supplyId) || [];
    row.pvzMedianDays = median(arr);
    row.pvzN = arr.length;
    row.tasks = tasksBySupply.get(row.supplyId) || { transit: 0, pvz: 0, sold: 0, canceled: 0, unknown: 0 };
  }
  const pvzMedianDaysOverall = median(pvzAll);

  return {
    rows,
    medianBuildHours: qb(0.5), medianScHours: q(0.5), p90ScHours: q(0.9),
    stuckCount: rows.filter((r) => r.status === "stuck").length,
    noScanOldCount: rows.filter((r) => r.status === "no_scan_old").length,
    total: rows.length,
    buyoutMedianDaysOverall,
    pvzMedianDaysOverall,
    pvzN: pvzAll.length,
  };
}
