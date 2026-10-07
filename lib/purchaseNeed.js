// lib/purchaseNeed.js — страница «Потребность» (06.10.2026): сколько закупить, чтобы
// хватило на горизонт (дефолт 30 дней) при скорости продаж последних N полных дней.
// Чистые функции, БД не трогает (данные собирает lib/purchaseNeedData.js).
//
// Строка = физический товар: связная компонента позиций склада/ФФ и артикулов МП
// (union-find, как строки матрицы /warehouses — lib/warehousesMetrics.js buildMatrix).
// Позиция с привязками WB и Ozon (ff_inventory_skus) сводит их в одну строку; артикул
// без привязки — отдельная строка своей площадки.
//
// Остаток товара = доступно на МП (WB quantity, Ozon fbo_present − fbo_reserved — как на
// /stocks) + свой склад/ФФ (ff_inventory.qty) + в пути (возвраты от клиента WB и отгрузки
// на МП без приёмки). Закупить = purchaseNeedQty (lib/supplyPlan.js — та же формула, что
// колонка «К закупке» на /stocks): ⌈скорость × горизонт − остаток⌉, не меньше 0.
import { velocityPerDay, coverageDays } from "./stockCoverage.js";
import { purchaseNeedQty } from "./supplyPlan.js";

const PLATFORMS = ["wb", "ozon"];
const skuNode = (platform, key) => `${platform}:${Number(key)}`;
const statusKey = (platform, key) => (platform === "wb" ? `wb|${key}|0` : `ozon|0|${key}`);

function makeDsu() {
  const parent = new Map();
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
    return root;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  return { add, find, union, nodes: () => [...parent.keys()] };
}

/**
 * @param positions  [{id, internal_name, qty, unit_cost, skus:[{platform, sku_key, name?, im_url?}]}]
 * @param mpStock    [{platform, sku_key, available, inWayFrom?, name?, im_url?, cost?}]
 * @param orders     [{platform, sku_key, qty}] — заказы за окно windowDays
 * @param inTransit  [{ff_inventory_id, qty, platform?}] — отгружено на МП, приёмки ещё нет
 * @param status     карта статусов statusMap() (lib/finItems.js); нет записи → active
 * @param platform   "all" | "wb" | "ozon" — фильтр площадки (07.10.2026): в строке остаются
 *                   только артикулы площадки (остаток МП, продажи, возвраты в пути) и отгрузки
 *                   на неё; свой склад/ФФ общий для обеих площадок — учитывается целиком.
 */
export function buildPurchaseNeed({ positions = [], mpStock = [], orders = [], inTransit = [], status = {}, windowDays, horizonDays, platform = "all" }) {
  const pfOk = (pf) => platform === "all" || pf === platform;
  const dsu = makeDsu();
  const posById = new Map();
  for (const p of positions) {
    const node = `pos:${p.id}`;
    posById.set(node, p);
    dsu.add(node);
    for (const s of p.skus || []) {
      if (!PLATFORMS.includes(s.platform) || s.sku_key == null) continue;
      dsu.add(skuNode(s.platform, s.sku_key));
      dsu.union(node, skuNode(s.platform, s.sku_key));
    }
  }
  const skuInfo = new Map(); // node → {platform, key, available, inWayFrom, orders, name, im_url, cost}
  const info = (platform, key) => {
    const node = skuNode(platform, key);
    dsu.add(node);
    if (!skuInfo.has(node)) skuInfo.set(node, { platform, key: Number(key), available: 0, inWayFrom: 0, orders: 0, name: null, im_url: null, cost: null });
    return skuInfo.get(node);
  };
  for (const s of mpStock) {
    if (!PLATFORMS.includes(s.platform) || s.sku_key == null) continue;
    const x = info(s.platform, s.sku_key);
    x.available += Math.max(0, Number(s.available) || 0);
    x.inWayFrom += Number(s.inWayFrom) || 0;
    x.name = x.name || s.name || null;
    x.im_url = x.im_url || s.im_url || null;
    if (x.cost == null && Number(s.cost) > 0) x.cost = Number(s.cost);
  }
  for (const o of orders) {
    if (!PLATFORMS.includes(o.platform) || o.sku_key == null) continue;
    info(o.platform, o.sku_key).orders += Number(o.qty) || 0;
  }
  for (const p of positions) for (const s of p.skus || []) {
    if (!PLATFORMS.includes(s.platform) || s.sku_key == null) continue;
    const x = info(s.platform, s.sku_key);
    x.name = x.name || s.name || null;
    x.im_url = x.im_url || s.im_url || null;
  }
  const transitByPos = new Map();
  for (const t of inTransit) {
    if (t.platform && !pfOk(t.platform)) continue;
    const k = `pos:${t.ff_inventory_id}`;
    transitByPos.set(k, (transitByPos.get(k) || 0) + (Number(t.qty) || 0));
  }

  const groups = new Map();
  for (const node of dsu.nodes()) {
    const root = dsu.find(node);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(node);
  }

  const rows = [];
  const unlinked = [];
  for (const nodes of groups.values()) {
    const poss = nodes.filter((n) => posById.has(n)).map((n) => posById.get(n));
    const skus = nodes.filter((n) => skuInfo.has(n)).map((n) => skuInfo.get(n));
    if (skus.length === 0) {
      for (const p of poss) unlinked.push({ id: p.id, name: p.internal_name || `#${p.id}`, qty: Number(p.qty) || 0 });
      continue;
    }
    // Товар виден, если хоть один его артикул активен; неактивные артикулы без позиции
    // склада в компоненте сами по себе строку не дают.
    const active = skus.filter((s) => status[statusKey(s.platform, s.key)] !== "inactive");
    if (active.length === 0) continue;
    // Артикулы, попавшие в товар только через связь с позицией, учитываются целиком
    // (физически тот же товар); одиночный неактивный артикул отброшен выше.
    const counted = (poss.length > 0 ? skus : active).filter((s) => pfOk(s.platform));
    if (counted.length === 0) continue;

    const mpQty = counted.reduce((a, s) => a + s.available, 0);
    const ownQty = poss.reduce((a, p) => a + (Number(p.qty) || 0), 0);
    const transitQty = counted.reduce((a, s) => a + s.inWayFrom, 0)
      + poss.reduce((a, p) => a + (transitByPos.get(`pos:${p.id}`) || 0), 0);
    const ordersQty = counted.reduce((a, s) => a + s.orders, 0);
    const velocity = velocityPerDay(ordersQty, windowDays);
    const stock = mpQty + ownQty;
    if (stock + transitQty === 0 && velocity === 0) continue;

    const needQty = purchaseNeedQty({ velocity, available: stock, inWayFrom: transitQty, leadDays: 0, targetDays: horizonDays }) ?? 0;
    // Себестоимость единицы: позиция склада с наибольшим остатком, иначе override артикула.
    const posCost = [...poss].sort((a, b) => (Number(b.qty) || 0) - (Number(a.qty) || 0))
      .map((p) => Number(p.unit_cost)).find((v) => v > 0);
    const unitCost = posCost ?? counted.map((s) => s.cost).find((v) => v > 0) ?? null;
    const byPf = (pf) => counted.filter((s) => s.platform === pf).map((s) => s.key).sort((a, b) => a - b);
    const named = counted.find((s) => s.name);
    rows.push({
      key: counted.map((s) => skuNode(s.platform, s.key)).sort()[0],
      name: named?.name || poss[0]?.internal_name || `${counted[0].platform.toUpperCase()} ${counted[0].key}`,
      imUrl: counted.find((s) => s.im_url)?.im_url || null,
      skus: { wb: byPf("wb"), ozon: byPf("ozon") },
      mpQty, ownQty, transitQty, ordersQty,
      velocity,
      coverageDays: coverageDays(stock, transitQty, velocity),
      needQty,
      unitCost,
      needCost: unitCost == null ? null : needQty * unitCost,
    });
  }

  rows.sort((a, b) => {
    const ca = a.coverageDays, cb = b.coverageDays;
    if (ca == null && cb == null) return b.mpQty + b.ownQty - (a.mpQty + a.ownQty);
    if (ca == null) return 1;
    if (cb == null) return -1;
    return ca - cb;
  });
  unlinked.sort((a, b) => b.qty - a.qty);
  const toBuy = rows.filter((r) => r.needQty > 0);
  return {
    rows,
    unlinked,
    totals: {
      items: rows.length,
      toBuyItems: toBuy.length,
      needQty: toBuy.reduce((a, r) => a + r.needQty, 0),
      needCost: toBuy.reduce((a, r) => a + (r.needCost || 0), 0),
    },
  };
}
