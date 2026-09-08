// lib/warehousesMetrics.js — витрина «Склады 2.0», этап 4 (спека §5). Чистые функции, без БД.
//
// Канон покрытия: скорость = velocityPerDay(заказы за VELOCITY_WINDOW_DAYS), остаток «доступно».
// Строка матрицы = физическая позиция, сгруппированная по паре (nm_id, product_id) — первый
// WB- и первый Ozon-артикул позиции. Ячейка ФФ сравнивает свой остаток с последним снимком
// FBS-остатков МП по привязанному складу продавца (§3.5): delta = own − present.
import { velocityPerDay, coverageDays, VELOCITY_WINDOW_DAYS } from "./stockCoverage.js";

const PLATFORMS = ["wb", "ozon"];
export const EMPTY_SKUS = { wb: null, ozon: null };

function skusOf(position) {
  const out = { ...EMPTY_SKUS };
  for (const s of position.skus || []) {
    if (PLATFORMS.includes(s.platform) && out[s.platform] == null && s.sku_key != null) out[s.platform] = Number(s.sku_key);
  }
  return out;
}

export function itemKeyOf(position) {
  const s = skusOf(position);
  if (s.wb == null && s.ozon == null) return `pos:${position.id}`;
  return `${s.wb ?? "-"}|${s.ozon ?? "-"}`;
}

function nameOf(position) {
  const s = (position.skus || []).find((x) => x.name);
  return { name: s?.name || position.internal_name || `#${position.id}`, imUrl: (position.skus || []).find((x) => x.im_url)?.im_url || null };
}

const keyFbs = (p, w, k) => `${p}:${w}:${k}`;

function indexBy(rows, fn, valueOf) {
  const m = new Map();
  for (const r of rows) {
    const k = fn(r);
    m.set(k, (m.get(k) || 0) + Number(valueOf(r)) || 0);
  }
  return m;
}

export function buildMatrix({ settings, positions = [], locations = [], fbsStock = [], fbsVelocity = [], fboTargets = [], gaps = [] }) {
  const minDays = Number(settings?.minDays) || 14;
  const presentIdx = indexBy(fbsStock, (r) => keyFbs(r.platform, r.warehouse_id, r.sku_key), (r) => r.present);
  const velIdx = indexBy(fbsVelocity, (r) => keyFbs(r.platform, r.warehouse_id, r.sku_key), (r) => r.orders_qty);
  const locById = new Map(locations.map((l) => [Number(l.id), l]));

  // 1. Строки: группировка позиций по itemKey.
  const rows = new Map();
  for (const p of positions) {
    const key = itemKeyOf(p);
    let row = rows.get(key);
    if (!row) {
      const { name, imUrl } = nameOf(p);
      row = { itemKey: key, name, imUrl, skus: skusOf(p), positionIds: [], cells: {}, totals: { own: 0, mp: 0, fbo: 0, gapsQty: 0, gapsCount: 0 }, problem: false, _own: new Map() };
      rows.set(key, row);
    }
    row.positionIds.push(p.id);
    if (p.location_id != null) row._own.set(Number(p.location_id), (row._own.get(Number(p.location_id)) || 0) + (Number(p.qty) || 0));
  }

  // 2. Колонки: активные места + неактивные с остатком, затем FBO-склады из targets.
  const ownByLoc = new Map();
  for (const row of rows.values()) for (const [lid, q] of row._own) ownByLoc.set(lid, (ownByLoc.get(lid) || 0) + q);
  const ffCols = locations
    .filter((l) => l.is_active !== false || (ownByLoc.get(Number(l.id)) || 0) > 0)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"))
    .map((l) => ({ key: `ff:${l.id}`, kind: "ff", title: l.name, locationId: Number(l.id), wbBound: l.wb_warehouse_id != null, ozonBound: l.ozon_warehouse_id != null }));
  const fboSeen = new Map();
  for (const t of fboTargets) {
    const key = `fbo:${t.platform}:${t.warehouseKey}`;
    if (!fboSeen.has(key)) fboSeen.set(key, { key, kind: "fbo", platform: t.platform, warehouseKey: t.warehouseKey, title: t.warehouseName || String(t.warehouseKey) });
  }
  const fboCols = [...fboSeen.values()].sort((a, b) => (a.platform === b.platform ? a.title.localeCompare(b.title, "ru") : a.platform === "wb" ? -1 : 1));
  const columns = [...ffCols, ...fboCols];

  // 3. Ячейки ФФ.
  for (const row of rows.values()) {
    for (const col of ffCols) {
      const loc = locById.get(col.locationId);
      const own = row._own.get(col.locationId) || 0;
      const mp = { wb: null, ozon: null };
      let ordersQty = 0;
      let hasData = own > 0;
      for (const p of PLATFORMS) {
        const wh = loc?.[`${p}_warehouse_id`];
        const sku = row.skus[p];
        if (wh == null || sku == null) continue;
        const k = keyFbs(p, wh, sku);
        const present = presentIdx.get(k);
        ordersQty += velIdx.get(k) || 0;
        if (present != null) { mp[p] = { present, delta: own - present }; hasData = true; }
        else if (own > 0) mp[p] = { present: 0, delta: own };
      }
      if (!hasData) continue;
      const velocity = velocityPerDay(ordersQty, VELOCITY_WINDOW_DAYS);
      const coverage = coverageDays(own, 0, velocity);
      const flags = { delta: PLATFORMS.some((p) => mp[p] && mp[p].delta !== 0), low: coverage != null && coverage < minDays };
      row.cells[col.key] = { own, mp, velocity, coverage, flags };
      row.totals.own += own;
      for (const p of PLATFORMS) if (mp[p]) row.totals.mp += mp[p].present;
      if (flags.delta || flags.low) row.problem = true;
    }
  }

  // 4. Ячейки FBO.
  for (const t of fboTargets) {
    for (const row of rows.values()) {
      if (row.skus[t.platform] == null || Number(row.skus[t.platform]) !== Number(t.skuKey)) continue;
      const velocity = velocityPerDay(t.ordersQty, t.days || VELOCITY_WINDOW_DAYS);
      const coverage = coverageDays(t.stock, t.inTransit, velocity);
      const low = coverage != null && coverage < minDays;
      row.cells[`fbo:${t.platform}:${t.warehouseKey}`] = { stock: Number(t.stock) || 0, inTransit: Number(t.inTransit) || 0, velocity, coverage, low };
      row.totals.fbo += (Number(t.stock) || 0) + (Number(t.inTransit) || 0);
      if (low) row.problem = true;
    }
  }

  // 5. Gaps по артикулу строки.
  for (const g of gaps) {
    for (const row of rows.values()) {
      if (row.skus[g.platform] == null || Number(row.skus[g.platform]) !== Number(g.sku_key)) continue;
      row.totals.gapsQty += Number(g.qty) || 0;
      row.totals.gapsCount += 1;
      row.problem = true;
    }
  }

  const out = [...rows.values()].map(({ _own, ...r }) => r)
    .sort((a, b) => (a.problem === b.problem ? a.name.localeCompare(b.name, "ru") : a.problem ? -1 : 1));
  return { columns, rows: out };
}
