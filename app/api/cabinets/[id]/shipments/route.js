// /api/cabinets/[id]/shipments — отгрузки как документы (шапка + строки).
//
// С 2026-07-18 отгрузка = документ: № поставки + дата + склад назначения + платформа,
// с составом из многих товаров (ff_shipment_docs + ff_shipment_lines). Заменяет
// плоскую модель ff_shipments (1 строка = 1 товар). Старая таблица НЕ дропается
// (архив); бэкпорт уже выполнен миграцией 024.
//
// С 2026-09-07 (спека «Склады 2.0» §4.2–4.3, миграция 055) документ имеет статус
// draft → shipped → accepted|partial|rejected, связь с фактом приёмки МП
// (WB: tenant.wb_incomes по income_id; Ozon: tenant.ozon_supply_orders по order_id)
// и принятое количество по строкам (qty_accepted, вводится руками). Вся логика —
// в lib/shipmentDocs.js; роут только разбирает запрос и отдаёт витрину.
//
// GET → { docs, totals, warehouses, warehouseNames }
//   docs: последние ~200 документов с развёрнутыми строками (lines[] с qty_accepted),
//         total_qty, total_cost, status, shipped_at, location_id/location_name,
//         dest_warehouse_id, mp_supply_id/mp_supply_kind, supply (факт приёмки),
//         suggestions (топ-3 кандидата связи для документов без mp_supply_id).
//   warehouses: справочники складов МП — { wb:[{id,name,region}], ozon:[{id,name,cluster}] }.
//   warehouseNames: старый плоский список имён складов из собранных данных (datalist
//         текущей модальной формы; уйдёт вместе с формой в задаче 6).
// POST { action } (role: manager)
//   create      { doc_no?, platform, ship_dt, dest_warehouse?, dest_warehouse_id?,
//                 location_id?, note?, status?='shipped', lines:[{ff_inventory_id,qty}] }
//                 → документ + строки; при status='shipped' — движения out_fbo.
//   ship        { id } → draft → shipped (предпроверка остатка + движения out_fbo).
//   link_supply { id, mp_supply_id|null, mp_supply_kind } → связь с приёмкой + статус.
//   accept      { id, accepted:[{line_id, qty_accepted}] } → приёмка + статус.
//   delete      { id } → только draft; отгруженный документ удалять нельзя.
//
// ⚠ Остаток (ff_inventory.qty) здесь напрямую НЕ трогается — только applyMove.
import { NextResponse } from "next/server";
import { tenantQuery, DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { applyMove } from "@/lib/stockLedger.js";
import {
  createShipmentDoc, shipDoc, linkSupply, acceptDoc,
  loadSupply, loadSupplyCandidates, matchSupply,
} from "@/lib/shipmentDocs.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const SUGGEST_DAYS = 60;   // окно кандидатов связи (приёмки/поставки МП)
const SUGGEST_TOP = 3;

// Плоский список имён складов из собранных данных (datalist старой формы). Тянем
// DISTINCT по warehouse_name из orders и warehouse из daily_stock — как в /move.
async function getWarehouseNames() {
  const set = new Set();
  for (const mp of ["wb", "ozon"]) {
    try {
      const db = new DatabaseSync(mp, { readOnly: true });
      const orderCol = mp === "wb" ? "warehouse_name" : "warehouse";
      const rows = await db.prepare(
        `SELECT DISTINCT ${orderCol} AS w FROM orders WHERE ${orderCol} IS NOT NULL AND ${orderCol} <> ''`
      ).all();
      for (const r of rows) if (r.w) set.add(r.w);
      try {
        const rows2 = await db.prepare(
          `SELECT DISTINCT warehouse AS w FROM daily_stock WHERE warehouse IS NOT NULL AND warehouse <> ''`
        ).all();
        for (const r of rows2) if (r.w) set.add(r.w);
      } catch {}
    } catch {}
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ru"));
}

// Справочники складов МП: WB — shared.wb_warehouses, Ozon — shared.ozon_clusters
// (один склад может встречаться в нескольких строках кластера → DISTINCT ON).
async function getWarehouseRefs() {
  const wb = await tenantQuery(
    `SELECT id, name, region FROM shared.wb_warehouses ORDER BY name`
  );
  const ozon = await tenantQuery(
    `SELECT DISTINCT ON (warehouse_id) warehouse_id::text AS id, warehouse_name AS name,
            cluster_name AS cluster
     FROM shared.ozon_clusters
     WHERE warehouse_id IS NOT NULL
     ORDER BY warehouse_id, warehouse_name`
  );
  ozon.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ru"));
  return { wb, ozon };
}

export const GET = withCabinet(async (req, { cabinet }) => {
  // Документы с развёрнутыми строками одним запросом (json_agg + GROUP BY).
  // LIMIT на стороне сервера; total_qty/total_cost — для колонок списка и KPI.
  const docs = await tenantQuery(
    `SELECT d.id, d.doc_no, d.platform, d.ship_dt, d.dest_warehouse, d.note, d.created_at,
            d.status, d.shipped_at, d.location_id, d.dest_warehouse_id,
            d.mp_supply_id, d.mp_supply_kind, loc.name AS location_name,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', l.id,
                  'ff_inventory_id', l.ff_inventory_id,
                  'qty', l.qty,
                  'qty_accepted', l.qty_accepted,
                  'item_name', COALESCE(f.internal_name, f.sku_name, '(скрыто)'),
                  'unit_cost', f.unit_cost
                ) ORDER BY l.id
              ) FILTER (WHERE l.id IS NOT NULL),
              '[]'::json
            ) AS lines
     FROM tenant.ff_shipment_docs d
     LEFT JOIN tenant.ff_shipment_lines l
       ON l.doc_id = d.id AND l.cabinet_id = d.cabinet_id
     LEFT JOIN tenant.ff_inventory f
       ON f.id = l.ff_inventory_id AND f.cabinet_id = l.cabinet_id
     LEFT JOIN tenant.stock_ff_locations loc
       ON loc.id = d.location_id AND loc.cabinet_id = d.cabinet_id
     GROUP BY d.id, d.doc_no, d.platform, d.ship_dt, d.dest_warehouse, d.note, d.created_at,
              d.status, d.shipped_at, d.location_id, d.dest_warehouse_id,
              d.mp_supply_id, d.mp_supply_kind, loc.name
     ORDER BY d.ship_dt DESC, d.id DESC
     LIMIT 200`
  );

  // Факт приёмки по связанным документам: один запрос на уникальную поставку.
  const supplyCache = new Map();
  const supplyOf = async (kind, id) => {
    if (!id || !kind) return null;
    const key = `${kind}:${id}`;
    if (!supplyCache.has(key)) supplyCache.set(key, await loadSupply(tenantQuery, { kind, id }));
    return supplyCache.get(key);
  };

  // Кандидаты подсказок — по одному запросу на платформу, только если есть
  // документы без связи (пустая таблица приёмок = пустые подсказки, не ошибка).
  const needCand = new Set(docs.filter((d) => !d.mp_supply_id).map((d) => d.platform));
  const candidates = {};
  for (const pf of needCand) {
    candidates[pf] = await loadSupplyCandidates(tenantQuery, { platform: pf, days: SUGGEST_DAYS });
  }

  // Пост-обработка: total_qty/total_cost на документ (Σ по строкам) + витрина связи.
  let totalQty = 0, totalCost = 0;
  const enriched = [];
  for (const d of docs) {
    const lines = Array.isArray(d.lines) ? d.lines : [];
    let qty = 0, cost = 0;
    for (const ln of lines) {
      qty += Number(ln.qty) || 0;
      cost += (Number(ln.qty) || 0) * (Number(ln.unit_cost) || 0);
    }
    totalQty += qty;
    totalCost += cost;
    const supply = await supplyOf(d.mp_supply_kind, d.mp_supply_id);
    const suggestions = d.mp_supply_id
      ? []
      : matchSupply(d, candidates[d.platform] || []).slice(0, SUGGEST_TOP);
    enriched.push({
      id: d.id,
      doc_no: d.doc_no,
      platform: d.platform,
      ship_dt: d.ship_dt,
      dest_warehouse: d.dest_warehouse,
      dest_warehouse_id: d.dest_warehouse_id,
      location_id: d.location_id,
      location_name: d.location_name,
      status: d.status,
      shipped_at: d.shipped_at,
      mp_supply_id: d.mp_supply_id,
      mp_supply_kind: d.mp_supply_kind,
      supply,
      suggestions,
      note: d.note,
      created_at: d.created_at,
      lines: lines.map(({ unit_cost, ...rest }) => rest),  // unit_cost не нужен фронту
      total_qty: qty,
      total_cost: round2(cost),
    });
  }

  const totals = { docs: enriched.length, total_qty: totalQty, total_cost: round2(totalCost) };
  const warehouses = await getWarehouseRefs();
  const warehouseNames = await getWarehouseNames();

  return NextResponse.json({ docs: enriched, totals, warehouses, warehouseNames });
});

// Результат lib/shipmentDocs.js → HTTP-ответ. { ok:false } — пользовательская ошибка
// (400) ДО первой записи, поэтому коммит транзакции withCabinet безопасен.
const respond = (res) =>
  res?.ok === false
    ? NextResponse.json({ error: res.error }, { status: res.status || 400 })
    : NextResponse.json(res);

export const POST = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json();
  // Автор движения остатка (stock_moves.created_by).
  const userId = session?.user_id ?? null;

  // ── create: новая отгрузка (документ + строки + при shipped — списание) ───
  if (b.action === "create") {
    return respond(await createShipmentDoc(tenantQuery, {
      platform: b.platform,
      shipDt: b.ship_dt,
      docNo: b.doc_no,
      note: b.note,
      destWarehouse: b.dest_warehouse,
      destWarehouseId: b.dest_warehouse_id,
      locationId: b.location_id,
      status: b.status,          // 'draft' | 'shipped'; по умолчанию 'shipped' (как раньше)
      lines: b.lines,
      userId,
      applyMove,
    }));
  }

  // ── ship: черновик → отгружен ────────────────────────────────────────────
  if (b.action === "ship") {
    return respond(await shipDoc(tenantQuery, { id: b.id, userId, applyMove }));
  }

  // ── link_supply: связь документа с приёмкой/поставкой МП ─────────────────
  if (b.action === "link_supply") {
    return respond(await linkSupply(tenantQuery, {
      id: b.id, mpSupplyId: b.mp_supply_id, kind: b.mp_supply_kind,
    }));
  }

  // ── accept: принятое количество по строкам + пересчёт статуса ────────────
  if (b.action === "accept") {
    return respond(await acceptDoc(tenantQuery, { id: b.id, accepted: b.accepted }));
  }

  // ── delete: удалить ЧЕРНОВИК (у отгруженного — только корректировка) ─────
  if (b.action === "delete") {
    const id = Number(b.id);
    if (!id) return NextResponse.json({ error: "id (doc_id) required" }, { status: 400 });

    // Статус проверяем ДО любой записи: withCabinet коммитит транзакцию на любом
    // возвращённом ответе, включая 400.
    const doc = (await tenantQuery(
      `SELECT id, status FROM tenant.ff_shipment_docs WHERE id = $1 FOR UPDATE`, [id]
    ))[0];
    if (!doc) return NextResponse.json({ error: "документ не найден" }, { status: 400 });
    if (doc.status !== "draft") {
      return NextResponse.json(
        { error: "документ уже отгружен: оформите корректировку остатка" }, { status: 400 }
      );
    }

    // Черновик списания не делал — движений возвращать нечего. Но документы,
    // созданные до миграции 055, могли быть переведены в draft только руками;
    // на всякий случай возвращаем qty по строкам, у которых есть движение out_fbo.
    const lines = await tenantQuery(
      `SELECT id, ff_inventory_id, qty FROM tenant.ff_shipment_lines WHERE doc_id = $1`,
      [id]
    );
    let restored = 0, skipped = 0;
    for (const ln of lines) {
      const moved = (await tenantQuery(
        `SELECT id FROM tenant.stock_moves
         WHERE src_kind = 'ff_shipment_doc' AND src_ref = $1 AND kind = 'out_fbo'`,
        [`${id}:${ln.id}`]
      ))[0];
      if (!moved) continue;
      const alive = (await tenantQuery(
        `SELECT id FROM tenant.ff_inventory WHERE id = $1 AND archived_at IS NULL`, [ln.ff_inventory_id]
      ))[0];
      if (!alive) { skipped++; continue; }
      await applyMove({ ffInventoryId: ln.ff_inventory_id, kind: "adjust", qty: Number(ln.qty),
        srcKind: "ff_shipment_doc", srcRef: `${id}:${ln.id}:delete`,
        note: `удаление документа отгрузки №${id}`, userId });
      restored++;
    }
    await tenantQuery(`DELETE FROM tenant.ff_shipment_lines WHERE doc_id = $1`, [id]);
    await tenantQuery(`DELETE FROM tenant.ff_shipment_docs WHERE id = $1`, [id]);

    return NextResponse.json({ ok: true, restored_lines: restored, skipped });
  }

  return NextResponse.json({ error: `unknown action: ${b.action}` }, { status: 400 });
}, { requireRole: 'manager' });
