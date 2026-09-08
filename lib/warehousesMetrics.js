// lib/warehousesMetrics.js — витрина «Склады 2.0», этап 4 (спека §5). Чистые функции, без БД.
//
// Канон покрытия: скорость = velocityPerDay(заказы за VELOCITY_WINDOW_DAYS), остаток «доступно».
// Строка матрицы = физическая позиция, сгруппированная по паре (nm_id, product_id) — первый
// WB- и первый Ozon-артикул позиции. Ячейка ФФ сравнивает свой остаток с последним снимком
// FBS-остатков МП по привязанному складу продавца (§3.5): delta = own − present.
import { velocityPerDay, coverageDays, VELOCITY_WINDOW_DAYS } from "./stockCoverage.js";

const PLATFORMS = ["wb", "ozon"];
export const EMPTY_SKUS = { wb: null, ozon: null };
export const WAITING_ACCEPT_DAYS = 7;
export const LOW_COVERAGE_TOP = 5;

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const fmtDays = (d) => (d == null ? "—" : String(Math.round(d)));

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

export function buildPlaceCards({ settings, positions = [], locations = [], sellerWarehouses = [], fbsStock = [], fbsVelocity = [], fboTargets = [], gaps = [], docs = [] }) {
  const minDays = Number(settings?.minDays) || 14;
  const matrix = buildMatrix({ settings, positions, locations, fbsStock, fbsVelocity, fboTargets, gaps });
  const whName = new Map(sellerWarehouses.map((w) => [`${w.platform}:${w.warehouse_id}`, w.name]));
  const boundKeys = new Set();
  const places = [];

  for (const col of matrix.columns.filter((c) => c.kind === "ff")) {
    const loc = locations.find((l) => Number(l.id) === col.locationId);
    const bindings = { wb: null, ozon: null };
    for (const p of PLATFORMS) {
      const wh = loc?.[`${p}_warehouse_id`];
      if (wh == null) continue;
      bindings[p] = { warehouse_id: Number(wh), name: whName.get(`${p}:${wh}`) || String(wh) };
      boundKeys.add(`${p}:${wh}`);
    }
    const posHere = positions.filter((x) => Number(x.location_id) === col.locationId && (Number(x.qty) || 0) > 0);
    let velocity = 0;
    const problems = { discrepancies: [], gaps: [], low: [] };
    for (const row of matrix.rows) {
      const c = row.cells[col.key];
      if (!c || c.own === 0) continue;
      velocity += c.velocity;
      for (const p of PLATFORMS) if (c.mp[p] && c.mp[p].delta !== 0) problems.discrepancies.push({ itemKey: row.itemKey, name: row.name, platform: p, own: c.own, present: c.mp[p].present, delta: c.mp[p].delta });
      if (c.flags.low) problems.low.push({ itemKey: row.itemKey, name: row.name, own: c.own, velocity: c.velocity, coverage: c.coverage });
    }
    velocity = round2(velocity);
    const units = posHere.reduce((s, x) => s + (Number(x.qty) || 0), 0);
    for (const g of gaps) {
      const b = bindings[g.platform];
      if (b && g.warehouse_id != null && Number(g.warehouse_id) === b.warehouse_id) problems.gaps.push({ id: g.id, platform: g.platform, sku_key: g.sku_key, qty: g.qty, reason: g.reason, src_ref: g.src_ref, first_seen_at: g.first_seen_at });
    }
    problems.low.sort((a, b) => b.velocity - a.velocity);
    places.push({
      id: col.locationId, name: loc?.name || col.title, city: loc?.city || null, address: loc?.address || null,
      is_active: loc?.is_active !== false, loc_type: loc?.loc_type || null, unbound: false, bindings,
      positions: posHere.length, units, value: round2(posHere.reduce((s, x) => s + (Number(x.qty) || 0) * (Number(x.unit_cost) || 0), 0)),
      velocity, coverage: coverageDays(units, 0, velocity), problems,
    });
  }
  for (const w of sellerWarehouses) {
    if (boundKeys.has(`${w.platform}:${w.warehouse_id}`) || w.is_active === false) continue;
    places.push({ id: null, name: w.name, city: null, address: null, is_active: true, loc_type: null, unbound: true,
      platform: w.platform, warehouse_id: Number(w.warehouse_id),
      bindings: { wb: null, ozon: null }, positions: 0, units: 0, value: 0, velocity: 0, coverage: null,
      problems: { discrepancies: [], gaps: [], low: [] } });
  }

  const fboWarehouses = [];
  const fboTargetsByKey = new Map();
  for (const t of fboTargets) {
    const k = `${t.platform}:${t.warehouseKey}`;
    if (!fboTargetsByKey.has(k)) fboTargetsByKey.set(k, []);
    fboTargetsByKey.get(k).push(t);
  }
  for (const col of matrix.columns.filter((c) => c.kind === "fbo")) {
    let items = 0, units = 0, inTransit = 0, ordersPerDay = 0;
    const low = [];
    const targets = fboTargetsByKey.get(col.key.substring(4)) || [];
    for (const t of targets) {
      units += Number(t.stock) || 0;
      inTransit += Number(t.inTransit) || 0;
      ordersPerDay += velocityPerDay(Number(t.ordersQty), t.days || VELOCITY_WINDOW_DAYS);
      for (const row of matrix.rows) {
        const c = row.cells[col.key];
        if (!c || row.skus[t.platform] == null || Number(row.skus[t.platform]) !== Number(t.skuKey)) continue;
        if (c.low) low.push({ itemKey: row.itemKey, name: row.name, stock: c.stock, velocity: c.velocity, coverage: c.coverage });
      }
    }
    items = targets.length;
    const velocity = round2(ordersPerDay);
    low.sort((a, b) => b.velocity - a.velocity);
    const openDocs = docs
      .filter((d) => d.platform === col.platform && d.status === "shipped" && d.dest_warehouse_id != null && Number(d.dest_warehouse_id) === Number(col.warehouseKey))
      .map((d) => ({ id: d.id, status: d.status, ship_dt: d.ship_dt, shipped_at: d.shipped_at }));
    fboWarehouses.push({ key: col.key, platform: col.platform, warehouseKey: col.warehouseKey, name: col.title, items, units, inTransit, velocity, coverage: coverageDays(units, inTransit, velocity), low, openDocs });
  }
  return { places, fboWarehouses };
}

export function buildSignals({ matrix, gaps = [], docs = [], settings, now = new Date() }) {
  const minDays = Number(settings?.minDays) || 14;
  const out = [];
  const disc = matrix.rows.filter((r) => {
    for (const cell of Object.values(r.cells)) {
      if (cell.flags?.delta && cell.own > 0) return true;
    }
    return false;
  });
  if (disc.length) out.push({ kind: "discrepancy", level: "warn", count: disc.length, text: `${disc.length} товаров с расхождением учёта и МП`, items: disc.map((r) => ({ itemKey: r.itemKey, name: r.name })) });
  if (gaps.length) out.push({ kind: "gaps", level: "crit", count: gaps.length, text: `${gaps.length} заданий FBS не разнесено`, items: gaps.slice(0, 10).map((g) => ({ id: g.id, platform: g.platform, reason: g.reason, qty: g.qty })) });
  const cutoff = now.getTime() - WAITING_ACCEPT_DAYS * 86400000;
  const waiting = docs.filter((d) => d.status === "shipped" && d.shipped_at && new Date(d.shipped_at).getTime() < cutoff);
  if (waiting.length) out.push({ kind: "waiting_accept", level: "warn", count: waiting.length, text: `${waiting.length} поставок ждут приёмки > ${WAITING_ACCEPT_DAYS} дней`, items: waiting.map((d) => ({ id: d.id, platform: d.platform, dest_warehouse: d.dest_warehouse, shipped_at: d.shipped_at })) });
  const low = [];
  for (const r of matrix.rows) for (const col of matrix.columns) {
    const c = r.cells[col.key];
    if (!c) continue;
    const cov = c.coverage, isLow = col.kind === "ff" ? c.flags.low : c.low;
    if (!isLow) continue;
    if (col.kind === "ff" && c.own === 0) continue;
    low.push({ itemKey: r.itemKey, name: r.name, where: col.title, colKey: col.key, qty: col.kind === "ff" ? c.own : c.stock, velocity: c.velocity, coverage: cov, text: `${r.name} кончится на ${col.title} через ${fmtDays(cov)} дн` });
  }
  low.sort((a, b) => b.velocity - a.velocity);
  const top = low.slice(0, LOW_COVERAGE_TOP);
  if (top.length) out.push({ kind: "low_coverage", level: top.some((x) => x.coverage < minDays / 2) ? "crit" : "warn", count: low.length, text: `${low.length} позиций с покрытием < ${minDays} дн`, items: top });
  return out;
}

export function planInventoryAdjust(current = [], lines = []) {
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, error: "нет строк" };
  const cur = new Map(current.map((c) => [Number(c.id), Number(c.qty) || 0]));
  const seen = new Set();
  const moves = [];
  for (const l of lines) {
    const id = Number(l.ff_inventory_id);
    const fact = Number(l.qty_fact);
    if (!cur.has(id)) return { ok: false, error: `позиция ${l.ff_inventory_id} не найдена на этом месте` };
    if (seen.has(id)) return { ok: false, error: `позиция ${id} указана дважды` };
    seen.add(id);
    if (!Number.isInteger(fact) || fact < 0) return { ok: false, error: `факт по позиции ${id} должен быть целым ≥ 0` };
    const delta = fact - cur.get(id);
    if (delta !== 0) moves.push({ id, delta });
  }
  moves.sort((a, b) => a.id - b.id);
  return { ok: true, moves };
}
