// lib/supplyPlanData.js — адаптер данных для плана поставок (спека «Склады 2.0» §4.1).
//
// Чистая арифметика плана живёт в lib/supplyPlan.js (buildSupplyPlan); здесь —
// только сбор входа из БД и обогащение результата именами/позициями ФФ.
//
// Ключевые решения:
//   • Ozon — цель на КАЖДЫЙ склад FBO (остаток по складу отдаёт ozon_daily_stock,
//     заказы — ozon_orders по warehouse_id). regionKey = кластер (shared.ozon_clusters).
//   • WB — ОДНА цель на товар на кабинет (warehouseKey='wb'). Причина: с 25.08.2026
//     WB перестал отдавать разрез по складам — остатки приходят одной строкой
//     «Склад WB», заказы почти целиком «Склад WB РФ». Разрез появится — сюда же
//     добавится ветка per-склад, контракт targets менять не придётся.
//   • itemId = 'wb:<nm_id>' / 'ozon:<product_id>' — чтобы товары разных площадок
//     никогда не столкнулись в общем пуле источников.
//   • Источник = место хранения (stock_ff_locations) с суммой qty позиций ФФ,
//     привязанных к этому артикулу. Позиции без места — НЕ источник (неизвестно,
//     откуда везти). Аггрегация по месту (а не построчно) нужна и планировщику:
//     buildSupplyPlan списывает доступность по locationId.
//   • Одна позиция ФФ, привязанная и к WB, и к Ozon, попадает в источники ОБОИХ
//     товаров — при platform='all' один и тот же остаток может быть предложен
//     дважды. Это осознанно: план — рекомендация, фактическое списание идёт через
//     документ отгрузки, где остаток проверяется (lib/shipmentDocs.js checkStock).
import { query, tenantQuery } from "@/lib/db.js";
import { buildSupplyPlan } from "@/lib/supplyPlan.js";

// Окно скорости продаж: 28 дней (4 полные недели — не перекашивает недельная сезонность).
export const WINDOW_DAYS = 28;

export const DEFAULT_TARGET_DAYS = 30;
export const DEFAULT_MIN_DAYS = 14;

// Города мест хранения → регионы/кластеры, которые считаем «ближними».
// Первые значения — федеральные округа WB (shared.wb_warehouses.region),
// дальше — кластеры Ozon для городов, чьё имя в названии кластера не встречается
// (Подольск/Электросталь → «Москва, МО и Дальние регионы», Ростов-на-Дону → «Ростов»).
// Кластеры, где имя города есть в названии, добавляются автоматически (см. regionKeysFor).
export const CITY_TO_REGIONS = {
  "москва": ["Центральный", "Москва, МО и Дальние регионы"],
  "подольск": ["Центральный", "Москва, МО и Дальние регионы"],
  "электросталь": ["Центральный", "Москва, МО и Дальние регионы"],
  "казань": ["Приволжский"],
  "самара": ["Приволжский"],
  "уфа": ["Приволжский"],
  "саратов": ["Приволжский"],
  "санкт-петербург": ["Северо-Западный"],
  "екатеринбург": ["Уральский"],
  "челябинск": ["Уральский"],
  "новосибирск": ["Дальневосточный и Сибирский"],
  "красноярск": ["Дальневосточный и Сибирский"],
  "краснодар": ["Южный и Северо-Кавказский"],
  "ростов-на-дону": ["Южный и Северо-Кавказский", "Ростов"],
  "невинномысск": ["Южный и Северо-Кавказский"],
};

const norm = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е").trim();
const int = (v) => Number(v) || 0;

/** Регионы/кластеры для города места: таблица соответствий + вхождение имени города в кластер Ozon. */
export function regionKeysFor(city, clusterNames = []) {
  const c = norm(city);
  if (!c) return [];
  const keys = new Set(CITY_TO_REGIONS[c] || []);
  for (const name of clusterNames) {
    if (norm(name).includes(c)) keys.add(name);
  }
  return [...keys];
}

/** Пороги планирования кабинета: auth.cabinets.settings (дефолты 30/14, зажим 1..365). */
export async function readSupplySettings(cabinetId) {
  const rows = await query(`SELECT settings FROM auth.cabinets WHERE cabinet_id = $1`, [cabinetId]);
  const s = rows[0]?.settings || {};
  return {
    targetDays: clampDays(s.supply_target_days, DEFAULT_TARGET_DAYS),
    minDays: clampDays(s.supply_min_days, DEFAULT_MIN_DAYS),
  };
}

export function clampDays(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(365, Math.max(1, Math.round(n)));
}

// Первая привязанная позиция ФФ на артикул: имя товара для витрины и pack_qty
// (кратность упаковки берём именно с неё — спека §4.1).
const LINKED_OZON = `
  SELECT DISTINCT ON (s.product_id)
         s.product_id,
         f.pack_qty,
         COALESCE(NULLIF(f.internal_name, ''), NULLIF(s.sku_name, ''), s.product_id::text) AS item_name
    FROM tenant.ff_inventory_skus s
    JOIN tenant.ff_inventory f
      ON f.id = s.ff_inventory_id AND f.cabinet_id = s.cabinet_id AND f.archived_at IS NULL
   WHERE s.platform = 'ozon' AND s.product_id IS NOT NULL
   ORDER BY s.product_id, s.created_at, s.id`;

const LINKED_WB = `
  SELECT DISTINCT ON (s.nm_id)
         s.nm_id,
         f.pack_qty,
         COALESCE(NULLIF(f.internal_name, ''), NULLIF(s.sku_name, ''), s.nm_id::text) AS item_name
    FROM tenant.ff_inventory_skus s
    JOIN tenant.ff_inventory f
      ON f.id = s.ff_inventory_id AND f.cabinet_id = s.cabinet_id AND f.archived_at IS NULL
   WHERE s.platform = 'wb' AND s.nm_id IS NOT NULL
   ORDER BY s.nm_id, s.created_at, s.id`;

/**
 * Цели плана по площадке (внутри withCabinet — RLS режет по кабинету).
 * @returns targets[] для buildSupplyPlan:
 *   { platform, warehouseKey, warehouseName, regionKey, itemId, itemName, skuKey,
 *     stock, inTransit, ordersQty, days, packQty }
 */
export async function collectTargets({ platform }) {
  if (platform === "ozon") return collectOzonTargets();
  if (platform === "wb") return collectWbTargets();
  return [...(await collectWbTargets()), ...(await collectOzonTargets())];
}

async function collectOzonTargets() {
  // Остаток — последняя дата ozon_daily_stock (fbo_present; «в пути» Ozon не отдаёт).
  // Заказы — ozon_orders за окно (только FBO, без отмен), разрез по warehouse_id.
  // Склад остатка приходит именем (ГРИВНО_РФЦ), склад заказа — id + имя, поэтому
  // общий ключ склада: id из справочника кластеров, а если склада там нет
  // (МИНСК_МПСЦ и т.п.) — нормализованное имя. FULL JOIN: склад, где товар
  // раскупили в ноль, остаётся целью (остаток 0, скорость есть).
  const rows = await tenantQuery(
    `WITH latest AS (SELECT max(date) AS d FROM tenant.ozon_daily_stock),
     linked AS (${LINKED_OZON}),
     stock AS (
       SELECT st.product_id,
              COALESCE(c.warehouse_id::text, lower(st.warehouse)) AS wh_key,
              max(c.warehouse_id) AS wh_id,
              max(st.warehouse)   AS wh_name,
              max(c.cluster_name) AS cluster_name,
              SUM(COALESCE(st.fbo_present, 0))::int AS stock
         FROM tenant.ozon_daily_stock st
         JOIN latest ON st.date = latest.d
         LEFT JOIN shared.ozon_clusters c ON lower(c.warehouse_name) = lower(st.warehouse)
        GROUP BY st.product_id, COALESCE(c.warehouse_id::text, lower(st.warehouse))
     ),
     ord AS (
       SELECT o.product_id,
              COALESCE(o.warehouse_id::text, lower(o.warehouse)) AS wh_key,
              max(o.warehouse_id) AS wh_id,
              max(o.warehouse)    AS wh_name,
              max(c.cluster_name) AS cluster_name,
              SUM(COALESCE(o.qty, 0))::int AS orders_qty
         FROM tenant.ozon_orders o
         LEFT JOIN shared.ozon_clusters c ON c.warehouse_id = o.warehouse_id
        WHERE o.scheme = 'fbo' AND COALESCE(o.is_cancel, 0) = 0
          AND o.order_dt >= to_char(CURRENT_DATE - $1::int, 'YYYY-MM-DD')
          AND COALESCE(o.warehouse_id::text, o.warehouse) IS NOT NULL
        GROUP BY o.product_id, COALESCE(o.warehouse_id::text, lower(o.warehouse))
     )
     SELECT COALESCE(s.product_id, o.product_id)::text AS product_id,
            COALESCE(s.wh_key, o.wh_key)               AS wh_key,
            COALESCE(s.wh_id, o.wh_id)::text           AS warehouse_id,
            COALESCE(s.wh_name, o.wh_name)             AS warehouse_name,
            COALESCE(s.cluster_name, o.cluster_name)   AS cluster_name,
            COALESCE(s.stock, 0)                       AS stock,
            COALESCE(o.orders_qty, 0)                  AS orders_qty,
            l.pack_qty, l.item_name
       FROM stock s
       FULL OUTER JOIN ord o ON o.product_id = s.product_id AND o.wh_key = s.wh_key
       JOIN linked l ON l.product_id = COALESCE(s.product_id, o.product_id)
      ORDER BY 1, 2`,
    [WINDOW_DAYS]
  );
  return rows.map((r) => ({
    platform: "ozon",
    warehouseKey: r.warehouse_id || r.wh_key,
    warehouseName: r.warehouse_name,
    regionKey: r.cluster_name || null,
    itemId: `ozon:${r.product_id}`,
    itemName: r.item_name,
    skuKey: r.product_id,
    stock: int(r.stock),
    inTransit: 0,
    ordersQty: int(r.orders_qty),
    days: WINDOW_DAYS,
    packQty: r.pack_qty == null ? 1 : int(r.pack_qty) || 1,
  }));
}

async function collectWbTargets() {
  // WB: одна цель на товар (разреза по складам с 25.08.2026 нет — см. шапку файла).
  // Остаток и «в пути к складу» — сумма по последней дате wb_daily_stock,
  // заказы — sum(orders) из wb_daily_metrics за окно.
  const rows = await tenantQuery(
    `WITH latest AS (SELECT max(date) AS d FROM tenant.wb_daily_stock),
     linked AS (${LINKED_WB}),
     stock AS (
       SELECT st.nm_id,
              SUM(COALESCE(st.quantity, 0))::int  AS stock,
              SUM(COALESCE(st.in_way_to, 0))::int AS in_transit
         FROM tenant.wb_daily_stock st
         JOIN latest ON st.date = latest.d
        GROUP BY st.nm_id
     ),
     ord AS (
       SELECT m.nm_id, SUM(COALESCE(m.orders, 0))::int AS orders_qty
         FROM tenant.wb_daily_metrics m
        WHERE m.date >= CURRENT_DATE - $1::int
        GROUP BY m.nm_id
     )
     SELECT l.nm_id::text AS nm_id, l.pack_qty, l.item_name,
            COALESCE(s.stock, 0)      AS stock,
            COALESCE(s.in_transit, 0) AS in_transit,
            COALESCE(o.orders_qty, 0) AS orders_qty
       FROM linked l
       LEFT JOIN stock s ON s.nm_id = l.nm_id
       LEFT JOIN ord   o ON o.nm_id = l.nm_id
      ORDER BY l.nm_id`,
    [WINDOW_DAYS]
  );
  return rows.map((r) => ({
    platform: "wb",
    warehouseKey: "wb",
    warehouseName: "WB (все склады)",
    regionKey: null,
    itemId: `wb:${r.nm_id}`,
    itemName: r.item_name,
    skuKey: r.nm_id,
    stock: int(r.stock),
    inTransit: int(r.in_transit),
    ordersQty: int(r.orders_qty),
    days: WINDOW_DAYS,
    packQty: r.pack_qty == null ? 1 : int(r.pack_qty) || 1,
  }));
}

/**
 * Источники: остатки ФФ по местам хранения в разрезе привязанных артикулов.
 * @returns { sources: { itemId: [{locationId, city, regionKeys, available, positions}] },
 *            locations: { [locationId]: name } }
 * positions — конкретные строки ff_inventory (для состава документа отгрузки).
 */
export async function collectSources() {
  const clusters = await query(`SELECT DISTINCT cluster_name FROM shared.ozon_clusters`);
  const clusterNames = clusters.map((c) => c.cluster_name).filter(Boolean);

  const rows = await tenantQuery(
    `SELECT f.id AS ff_id, f.qty, f.location_id, l.name AS location_name, l.city,
            s.platform, s.nm_id::text AS nm_id, s.product_id::text AS product_id
       FROM tenant.ff_inventory f
       JOIN tenant.ff_inventory_skus s
         ON s.ff_inventory_id = f.id AND s.cabinet_id = f.cabinet_id
       JOIN tenant.stock_ff_locations l
         ON l.id = f.location_id AND l.cabinet_id = f.cabinet_id AND l.is_active
      WHERE f.archived_at IS NULL AND f.qty > 0
      ORDER BY f.id`
  );

  const sources = {};
  const locations = {};
  const regionCache = {};
  for (const r of rows) {
    const itemId = r.platform === "wb"
      ? (r.nm_id ? `wb:${r.nm_id}` : null)
      : (r.product_id ? `ozon:${r.product_id}` : null);
    if (!itemId) continue;
    const locationId = Number(r.location_id);
    locations[locationId] = r.location_name || `Место ${locationId}`;
    const cityKey = norm(r.city);
    if (!(cityKey in regionCache)) regionCache[cityKey] = regionKeysFor(r.city, clusterNames);

    const list = (sources[itemId] ||= []);
    let src = list.find((x) => x.locationId === locationId);
    if (!src) {
      src = { locationId, city: r.city || null, regionKeys: regionCache[cityKey], available: 0, positions: [] };
      list.push(src);
    }
    src.available += int(r.qty);
    src.positions.push({ ffInventoryId: Number(r.ff_id), qty: int(r.qty) });
  }
  return { sources, locations };
}

/**
 * Полный план поставок кабинета.
 * @returns { settings, groups, uncovered, generatedAt }
 *   groups[]: { locationId, locationName, platform, warehouseKey, warehouseName, lines[] }
 *   lines[]:  { itemId, itemName, skuKey, need, qty, velocity, coverageDays, available,
 *               positions:[{ffInventoryId, qty}] }
 */
export async function buildPlanForCabinet({ cabinetId, platform = "all" }) {
  const settings = await readSupplySettings(cabinetId);
  const targets = await collectTargets({ platform });
  const { sources, locations } = await collectSources();
  const { groups, uncovered } = buildSupplyPlan({ settings, targets, sources });

  // Доступность на месте (для витрины) и разбор рекомендованного qty на конкретные
  // строки ff_inventory (состав будущего документа отгрузки).
  const availByKey = {};
  const posPool = {};
  for (const [itemId, list] of Object.entries(sources)) {
    for (const s of list) {
      const key = `${itemId}::${s.locationId}`;
      availByKey[key] = s.available;
      posPool[key] = s.positions.map((p) => ({ ...p }));
    }
  }

  const enriched = groups.map((g) => ({
    ...g,
    locationName: locations[g.locationId] || `Место ${g.locationId}`,
    lines: g.lines.map((ln) => {
      const key = `${ln.itemId}::${g.locationId}`;
      const pool = posPool[key] || [];
      let rest = int(ln.qty);
      const positions = [];
      for (const p of pool) {
        if (rest <= 0) break;
        if (p.qty <= 0) continue;
        const take = Math.min(p.qty, rest);
        positions.push({ ffInventoryId: p.ffInventoryId, qty: take });
        p.qty -= take;
        rest -= take;
      }
      return { ...ln, available: availByKey[key] ?? 0, positions };
    }),
  }));

  return { settings, groups: enriched, uncovered, generatedAt: new Date().toISOString() };
}
