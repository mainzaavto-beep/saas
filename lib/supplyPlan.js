// lib/supplyPlan.js — чистый планировщик поставок (спека «Склады 2.0» §4.1).
// Никакой БД: lib/supplyPlanData.js (этап 3, задача 4) собирает targets/sources из БД
// и вызывает buildSupplyPlan({ settings, targets, sources }).

// velocityPerDay / coverageDays — КАНОН покрытия, общий с рекомендациями перевозки
// (app/api/cabinets/[id]/stocks/route.js). Живут в lib/stockCoverage.js; здесь —
// ре-экспорт, чтобы существующие импорты из lib/supplyPlan.js продолжали работать.
export { velocityPerDay, coverageDays, VELOCITY_WINDOW_DAYS } from "./stockCoverage.js";
import { velocityPerDay, coverageDays } from "./stockCoverage.js";

const normPack = (packQty) => {
  const p = Number(packQty);
  return Number.isFinite(p) && p > 1 ? p : 1;
};

// needQty: 0, если покрытие ≥ target; иначе ceil((target×vel − stock − inTransit)/pack)×pack.
// Результат никогда не отрицательный.
export function needQty({ targetDays, velocity, stock, inTransit, packQty }) {
  const vel = Number(velocity) || 0;
  const target = Number(targetDays) || 0;
  const s = Number(stock) || 0;
  const t = Number(inTransit) || 0;
  const pack = normPack(packQty);
  const raw = target * vel - s - t;
  if (raw <= 0) return 0;
  return Math.ceil(raw / pack) * pack;
}

// purchaseNeedQty: «К закупке, шт» на «Склады и индексы» → «Индексы OOS» (с 2026-10-01).
// Та же формула needQty, горизонт = срок поставки + запас:
//   ceil(velocity × (leadDays + targetDays) − available − inWayFrom), не меньше 0.
// Вычитаем ДОСТУПНО + «в пути ОТ клиента» (возвраты вернутся на склад). «В пути К клиенту»
// НЕ вычитаем — это уже проданный товар, едущий покупателю, запасом он не является.
// velocity null/не число (скорость размера неизвестна) → null («—», не 0).
export function purchaseNeedQty({ velocity, available, inWayFrom, leadDays, targetDays }) {
  if (velocity == null || !Number.isFinite(Number(velocity))) return null;
  // Спрос за горизонт округляем до 1e-6: скорость приходит с 2 знаками, а в
  // плавающей точке даёт 7.000000000000001 при 0.07×100 — ceil поднял бы закупку на штуку.
  const horizon = (Number(leadDays) || 0) + (Number(targetDays) || 0);
  const demand = Math.round(Number(velocity) * horizon * 1e6) / 1e6;
  return needQty({
    targetDays: 1,
    velocity: demand,
    stock: Math.max(0, Number(available) || 0),
    inTransit: Number(inWayFrom) || 0,
  });
}

// purchaseNeedForRow / purchaseNeedForItem — «К закупке» по строке витрины /stocks
// ({velocity, quantity = доступно, in_way_from, sizes?}). Размер или товар без размеров —
// по своей скорости. Товар WB с размерами — Σ по размерам (каждый размер округляется
// вверх сам: закупают размеры, а не «товар в среднем»); если хоть у одного размера скорость
// неизвестна (null) — считаем по товару целиком.
export function purchaseNeedForRow(row, { leadDays, targetDays }) {
  return purchaseNeedQty({
    velocity: row?.velocity, available: row?.quantity, inWayFrom: row?.in_way_from,
    leadDays, targetDays,
  });
}
export function purchaseNeedForItem(item, params) {
  const sizes = Array.isArray(item?.sizes) ? item.sizes : [];
  if (sizes.length > 0) {
    const parts = sizes.map((x) => purchaseNeedForRow(x, params));
    if (parts.every((v) => v != null)) return parts.reduce((a, v) => a + v, 0);
  }
  return purchaseNeedForRow(item, params);
}

// pickSources: источники товара для needed шт, ближний регион (regionKeys ∋ destKey) первым,
// внутри группы — по available убыв. Не мутирует sources. Возвращает {parts, uncovered}.
export function pickSources(sources, needed, destKey) {
  let remaining = Number(needed) || 0;
  const list = Array.isArray(sources) ? sources : [];
  const ranked = list
    .map((src, idx) => ({ src, idx }))
    .sort((a, b) => {
      const ra = rankOf(a.src, destKey);
      const rb = rankOf(b.src, destKey);
      if (ra !== rb) return ra - rb;
      const av = Number(a.src.available) || 0;
      const bv = Number(b.src.available) || 0;
      if (av !== bv) return bv - av;
      return a.idx - b.idx;
    });
  const parts = [];
  for (const { src } of ranked) {
    if (remaining <= 0) break;
    const avail = Number(src.available) || 0;
    if (avail <= 0) continue;
    const qty = Math.min(avail, remaining);
    if (qty <= 0) continue;
    parts.push({ locationId: src.locationId, qty });
    remaining -= qty;
  }
  return { parts, uncovered: Math.max(0, remaining) };
}

function rankOf(src, destKey) {
  const keys = src.regionKeys;
  if (!keys) return 1;
  if (keys instanceof Set) return keys.has(destKey) ? 0 : 1;
  if (Array.isArray(keys)) return keys.includes(destKey) ? 0 : 1;
  return 1;
}

// buildSupplyPlan: для каждого target считает velocity/coverage/need, подбирает источники
// (available расходуется по ходу плана — общий для всех targets), группирует строки по
// (locationId, platform, warehouseKey).
//
// Порядок обработки targets (важно при общем источнике на несколько складов): по возрастанию
// coverageDays (null — в конец, как "неизвестное/худшее" покрытие), при равенстве — по убыванию
// need. Склад с меньшим запасом дней обслуживается раньше и получает приоритет на дефицитный
// источник; при равенстве coverageDays и need порядок стабилен (исходный порядок массива).
export function buildSupplyPlan({ settings, targets, sources }) {
  const targetDays = Number(settings?.targetDays) || 0;
  const minDays = Number(settings?.minDays) || 0;
  const srcMap = sources && typeof sources === "object" ? sources : {};

  // своя мутируемая копия доступности источников — расходуется по ходу плана
  const pool = {};
  for (const itemId of Object.keys(srcMap)) {
    pool[itemId] = (srcMap[itemId] || []).map((s) => ({ ...s }));
  }

  const list = Array.isArray(targets) ? targets : [];
  const prepared = list
    .map((t, idx) => {
      const velocity = velocityPerDay(t.ordersQty, t.days);
      const coverage = coverageDays(t.stock, t.inTransit, velocity);
      return { t, idx, velocity, coverage };
    })
    .filter(({ t, velocity }) => {
      const stock = Number(t.stock) || 0;
      const orders = Number(t.ordersQty) || 0;
      if (stock === 0 && orders === 0) return false; // не рассматриваем
      if (velocity === 0) return false; // нет скорости — нет рекомендации
      return true;
    })
    .sort((a, b) => {
      const ca = a.coverage === null ? Infinity : a.coverage;
      const cb = b.coverage === null ? Infinity : b.coverage;
      if (ca !== cb) return ca - cb;
      const na = needQty({ targetDays, velocity: a.velocity, stock: a.t.stock, inTransit: a.t.inTransit, packQty: a.t.packQty });
      const nb = needQty({ targetDays, velocity: b.velocity, stock: b.t.stock, inTransit: b.t.inTransit, packQty: b.t.packQty });
      if (na !== nb) return nb - na;
      return a.idx - b.idx;
    });

  const groupsByKey = new Map();
  const uncoveredList = [];

  for (const { t, velocity, coverage } of prepared) {
    if (coverage !== null && coverage >= minDays) continue; // покрытие достаточное — пропуск

    const need = needQty({ targetDays, velocity, stock: t.stock, inTransit: t.inTransit, packQty: t.packQty });
    if (need <= 0) continue;

    const itemSources = pool[t.itemId] || [];
    const { parts, uncovered } = pickSources(itemSources, need, t.regionKey);

    // расходуем пул: находим источники по locationId и уменьшаем available
    for (const part of parts) {
      const src = itemSources.find((s) => s.locationId === part.locationId);
      if (src) src.available = (Number(src.available) || 0) - part.qty;
    }

    const qty = parts.reduce((sum, p) => sum + p.qty, 0);

    for (const part of parts) {
      const key = `${part.locationId}::${t.platform}::${t.warehouseKey}`;
      let group = groupsByKey.get(key);
      if (!group) {
        group = {
          locationId: part.locationId,
          platform: t.platform,
          warehouseKey: t.warehouseKey,
          warehouseName: t.warehouseName,
          lines: [],
        };
        groupsByKey.set(key, group);
      }
      group.lines.push({
        itemId: t.itemId,
        itemName: t.itemName,
        skuKey: t.skuKey,
        need,
        qty: part.qty,
        velocity,
        coverageDays: coverage,
      });
    }

    if (uncovered > 0) {
      uncoveredList.push({ itemId: t.itemId, warehouseKey: t.warehouseKey, qty: uncovered });
    }
  }

  return { groups: Array.from(groupsByKey.values()), uncovered: uncoveredList };
}
