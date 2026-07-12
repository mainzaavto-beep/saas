// =====================================================================
//  lib/finItems.js — справочники и переопределения ТОВАРОВ (PostgreSQL).
//
//  SAAS-версия: таблицы tenant.cost_overrides/item_groups/item_group_members/
//  item_status (созданы миграцией 006_item_management.sql) с RLS по cabinet_id.
//  Весь доступ — через tenantQuery (берёт PG-клиент из ALS within withCabinet),
//  без convertSql (эти таблицы не wb_/ozon_, маппинг не нужен).
//
//  Переопределение себестоимости: override (по effective_from<=дата) имеет
//  приоритет над базовым cogs сборщика. Базовый cogs — RO-fallback.
//
//  Экспорты совместимы с эталоном data-presenter/lib/finItems.js (для items route).
// =====================================================================

import { tenantQuery } from "./db.js";

const todayISO = () => new Date().toISOString().slice(0, 10);
// Имя колонки SKU для платформы (WB=nm_id, Ozon=product_id).
const skuCol = (platform) => (String(platform) === "ozon" ? "product_id" : "nm_id");
const skuVal = (platform, nmId, productId) =>
  (String(platform) === "ozon" ? Number(productId) : Number(nmId)) || 0;

// =====================================================================
//  cost_overrides
// =====================================================================

/** Актуальный override на дату onDate (или сегодня). null если нет. */
export async function getCostOverride(platform, nmId, productId, onDate) {
  const d = onDate || todayISO();
  const col = skuCol(platform);
  const v = skuVal(platform, nmId, productId);
  const rows = await tenantQuery(
    `SELECT id, cost, effective_from, note FROM tenant.cost_overrides
      WHERE platform = $1 AND ${col} = $2 AND effective_from <= $3
      ORDER BY effective_from DESC LIMIT 1`,
    [String(platform), v, d]
  );
  return rows[0] || null;
}

/** Вся история override'ов по SKU, от новых к старым. */
export async function listCostOverrides(platform, nmId, productId) {
  const col = skuCol(platform);
  const v = skuVal(platform, nmId, productId);
  return tenantQuery(
    `SELECT id, cost, effective_from, note, created_at FROM tenant.cost_overrides
      WHERE platform = $1 AND ${col} = $2
      ORDER BY effective_from DESC`,
    [String(platform), v]
  );
}
// Алиас (эталон использует listCostOverridesBySku).
export const listCostOverridesBySku = listCostOverrides;

/** Upsert override по (platform, nm_id, product_id, effective_from).
 *  Если запись есть — обновляет cost/note, иначе вставляет. */
export async function upsertCostOverride({ platform, nm_id, product_id, cost, effective_from, note }) {
  await tenantQuery(
    `INSERT INTO tenant.cost_overrides (cabinet_id, platform, nm_id, product_id, cost, effective_from, note)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6)
     ON CONFLICT (cabinet_id, platform, nm_id, product_id, effective_from)
     DO UPDATE SET cost = EXCLUDED.cost, note = EXCLUDED.note`,
    [String(platform), Number(nm_id) || 0, Number(product_id) || 0,
     Number(cost), String(effective_from), note ? String(note) : null]
  );
  return getCostOverride(platform, nm_id, product_id, effective_from);
}

/** Запись override по PK id. */
export async function getCostOverrideById(id) {
  const rows = await tenantQuery(
    `SELECT id, platform, nm_id, product_id, cost, effective_from, note, created_at
     FROM tenant.cost_overrides WHERE id = $1`,
    [Number(id)]
  );
  return rows[0] || null;
}

/** Правка записи истории по PK id. */
export async function updateCostOverride(id, { cost, effective_from, note }) {
  const sets = [];
  const vals = [];
  if (cost != null && Number.isFinite(Number(cost))) {
    sets.push("cost = $" + (sets.length + 1));
    vals.push(Number(cost));
  }
  if (effective_from && /^\d{4}-\d{2}-\d{2}$/.test(effective_from)) {
    sets.push("effective_from = $" + (sets.length + 1));
    vals.push(effective_from);
  }
  if (note !== undefined) {
    sets.push("note = $" + (sets.length + 1));
    vals.push(note == null || note === "" ? null : String(note));
  }
  if (sets.length === 0) return getCostOverrideById(id);
  vals.push(Number(id));
  await tenantQuery(`UPDATE tenant.cost_overrides SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  return getCostOverrideById(id);
}

/** Удалить override по PK id. true если удалено. */
export async function deleteCostOverride(id) {
  const rows = await tenantQuery(
    `DELETE FROM tenant.cost_overrides WHERE id = $1 RETURNING id`,
    [Number(id)]
  );
  return rows.length > 0;
}

/** Все override'ы платформы (для построения per-day карты в /api/pnl). */
export async function listCostOverridesAll(platform) {
  const col = skuCol(platform);
  return tenantQuery(
    `SELECT ${col} AS sku_id, cost, effective_from FROM tenant.cost_overrides
      WHERE platform = $1 ORDER BY ${col}, effective_from`,
    [String(platform)]
  );
}

/**
 * Bulk-карта {sku_id: {cost, source, effective_from, override_id}} на onDate.
 * Override имеет приоритет; если нет — fallback из cogsMap.
 */
export async function resolveCostMap(platform, skuIds, onDate, cogsMap = {}) {
  const col = skuCol(platform);
  const d = onDate || todayISO();
  const result = {};
  for (const idRaw of skuIds) {
    const id = Number(idRaw);
    if (!Number.isFinite(id) || id <= 0) continue;
    const rows = await tenantQuery(
      `SELECT id, cost, effective_from FROM tenant.cost_overrides
        WHERE platform = $1 AND ${col} = $2 AND effective_from <= $3
        ORDER BY effective_from DESC LIMIT 1`,
      [String(platform), id, d]
    );
    if (rows[0]) {
      result[id] = { cost: rows[0].cost, source: "override", effective_from: rows[0].effective_from, override_id: rows[0].id };
    } else {
      const fb = cogsMap[id];
      result[id] = { cost: fb != null ? fb : null, source: fb != null ? "cogs" : null, effective_from: null, override_id: null };
    }
  }
  return result;
}

/** Функция-резолвер cost(skuId, dateStr) из списка override'ов + cogs fallback. */
export async function buildCostResolver(overrides, cogsMap) {
  const bySku = {};
  for (const o of overrides) {
    const id = Number(o.sku_id);
    if (!bySku[id]) bySku[id] = [];
    bySku[id].push({ effective_from: o.effective_from, cost: o.cost });
  }
  for (const id of Object.keys(bySku)) {
    bySku[id].sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
  }
  return function resolve(skuId, dateStr) {
    const id = Number(skuId);
    const list = bySku[id];
    if (list && list.length) {
      let chosen = null;
      for (const o of list) {
        if (o.effective_from <= dateStr) chosen = o;
        else break;
      }
      if (chosen) return { cost: chosen.cost, source: "override" };
    }
    const fb = cogsMap[id];
    return fb != null ? { cost: fb, source: "cogs" } : { cost: null, source: null };
  };
}

// =====================================================================
//  item_groups + item_group_members
// =====================================================================

/** Все группы {id, name}. */
export async function listGroups() {
  return tenantQuery(`SELECT id, name FROM tenant.item_groups ORDER BY name`);
}

/** Создать группу по имени (idempotent — INSERT ON CONFLICT DO NOTHING).
 *  id = Date.now() для уникальности. cabinet_id берётся из current_setting
 *  (RLS WITH CHECK требует его в INSERT). */
export async function createGroup(name) {
  const clean = String(name).trim();
  await tenantQuery(
    `INSERT INTO tenant.item_groups (cabinet_id, id, name)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2)
     ON CONFLICT (cabinet_id, name) DO NOTHING`,
    [Date.now(), clean]
  );
  const rows = await tenantQuery(`SELECT id, name FROM tenant.item_groups WHERE name = $1`, [clean]);
  return rows[0];
}

/** Группа SKU (1 группа на SKU) или null. */
export async function getGroupOf(platform, nmId, productId) {
  const col = skuCol(platform);
  const v = skuVal(platform, nmId, productId);
  const rows = await tenantQuery(
    `SELECT g.id, g.name FROM tenant.item_group_members m
      JOIN tenant.item_groups g ON g.id = m.group_id AND g.cabinet_id = m.cabinet_id
     WHERE m.platform = $1 AND m.${col} = $2 LIMIT 1`,
    [String(platform), v]
  );
  return rows[0] || null;
}

/** Карта {group_id: name} для bulk-обогащения. */
export async function groupsById() {
  const list = await listGroups();
  const m = {};
  for (const g of list) m[g.id] = g.name;
  return m;
}

/** Карта (platform|nmId|productId) → group_id для bulk-обогащения. */
export async function membersMap() {
  const rows = await tenantQuery(
    `SELECT platform, nm_id, product_id, group_id FROM tenant.item_group_members`
  );
  const m = {};
  for (const r of rows) {
    m[`${r.platform}|${r.nm_id || 0}|${r.product_id || 0}`] = r.group_id;
  }
  return m;
}

/** Привязать SKU к группе (1 группа на SKU — перезаписывает). */
export async function assignGroup({ platform, nm_id, product_id, group_id }) {
  const col = skuCol(platform);
  const v = skuVal(platform, nm_id, product_id);
  await tenantQuery(
    `DELETE FROM tenant.item_group_members WHERE platform = $1 AND ${col} = $2`,
    [String(platform), v]
  );
  await tenantQuery(
    `INSERT INTO tenant.item_group_members (cabinet_id, platform, nm_id, product_id, group_id)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4)`,
    [String(platform), Number(nm_id) || 0, Number(product_id) || 0, Number(group_id)]
  );
  return getGroupOf(platform, nm_id, product_id);
}

/** Отвязать SKU от любой группы. */
export async function unassignGroup(platform, nmId, productId) {
  const col = skuCol(platform);
  const v = skuVal(platform, nmId, productId);
  await tenantQuery(
    `DELETE FROM tenant.item_group_members WHERE platform = $1 AND ${col} = $2`,
    [String(platform), v]
  );
  return true;
}

// =====================================================================
//  item_status
// =====================================================================

/** Статус SKU или {status:'active'} по умолчанию. */
export async function getStatus(platform, nmId, productId) {
  const col = skuCol(platform);
  const v = skuVal(platform, nmId, productId);
  const rows = await tenantQuery(
    `SELECT status FROM tenant.item_status WHERE platform = $1 AND ${col} = $2`,
    [String(platform), v]
  );
  return rows[0] || { status: "active" };
}

/** Карта (platform|nmId|productId) → status для bulk-обогащения. */
export async function statusMap() {
  const rows = await tenantQuery(
    `SELECT platform, nm_id, product_id, status FROM tenant.item_status`
  );
  const m = {};
  for (const r of rows) {
    m[`${r.platform}|${r.nm_id || 0}|${r.product_id || 0}`] = r.status;
  }
  return m;
}

/** Установить статус SKU (active/inactive). */
export async function setStatus({ platform, nm_id, product_id, status }) {
  const col = skuCol(platform);
  const v = skuVal(platform, nm_id, product_id);
  const st = status === "inactive" ? "inactive" : "active";
  await tenantQuery(
    `INSERT INTO tenant.item_status (cabinet_id, platform, nm_id, product_id, status)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4)
     ON CONFLICT (cabinet_id, platform, nm_id, product_id)
     DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
    [String(platform), Number(nm_id) || 0, Number(product_id) || 0, st]
  );
  return getStatus(platform, nm_id, product_id);
}
