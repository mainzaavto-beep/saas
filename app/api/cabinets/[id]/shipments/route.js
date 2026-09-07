// /api/cabinets/[id]/shipments — отгрузки как документы (шапка + строки).
//
// С 2026-07-18 отгрузка = документ: № поставки + дата + склад назначения + платформа,
// с составом из многих товаров (ff_shipment_docs + ff_shipment_lines). Заменяет
// плоскую модель ff_shipments (1 строка = 1 товар). Старая таблица НЕ дропается
// (архив); бэкпорт уже выполнен миграцией 024.
//
// GET → { docs, totals, warehouses }
//   docs: последние ~200 документов с развёрнутыми строками (lines[]), total_qty,
//         total_cost (Σ qty × unit_cost позиции склада).
//   warehouses: DISTINCT-список имён складов из собранных данных WB/Ozon — для
//         <datalist> поля «склад назначения» (как в /move).
// POST { action:"create" | "delete" } (role: manager)
//   create: { doc_no?, platform, ship_dt, dest_warehouse?, note?, lines:[{ff_inventory_id,qty}] }
//           → атомарно: INSERT doc + INSERT lines + движения out_fbo через журнал
//           (lib/stockLedger.js). Нехватка остатка ловится ПРЕДпроверкой (FOR UPDATE)
//           до первой записи → 400 без частично записанного документа.
//   delete: { id } (doc_id) → движения adjust (возврат qty) + удалить строки + документ.
//
// ⚠ Остаток (ff_inventory.qty) здесь напрямую НЕ трогается — только applyMove.
import { NextResponse } from "next/server";
import { tenantQuery, DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { applyMove } from "@/lib/stockLedger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Список складов назначения из собранных данных (datalist). Тянем DISTINCT по
// warehouse_name из orders и warehouse из daily_stock — это всё, что доступно
// (WB/Ozon не отдают справочник складов отдельным endpoint). Как в /move.
async function getWarehouses() {
  const set = new Set();
  for (const mp of ["wb", "ozon"]) {
    try {
      const db = new DatabaseSync(mp, { readOnly: true });
      // orders.warehouse_name (wb) / orders.warehouse (ozon); сток тоже добавим.
      const orderCol = mp === "wb" ? "warehouse_name" : "warehouse";
      const rows = await db.prepare(
        `SELECT DISTINCT ${orderCol} AS w FROM orders WHERE ${orderCol} IS NOT NULL AND ${orderCol} <> ''`
      ).all();
      for (const r of rows) if (r.w) set.add(r.w);
      // daily_stock.warehouse (общее имя колонки в обеих схемах).
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

export const GET = withCabinet(async (req, { cabinet }) => {
  // Документы с развёрнутыми строками одним запросом (json_agg + GROUP BY).
  // LIMIT на стороне сервера; total_qty/total_cost — для колонок списка и KPI.
  const docs = await tenantQuery(
    `SELECT d.id, d.doc_no, d.platform, d.ship_dt, d.dest_warehouse, d.note, d.created_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', l.id,
                  'ff_inventory_id', l.ff_inventory_id,
                  'qty', l.qty,
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
     GROUP BY d.id, d.doc_no, d.platform, d.ship_dt, d.dest_warehouse, d.note, d.created_at
     ORDER BY d.ship_dt DESC, d.id DESC
     LIMIT 200`
  );

  // Пост-обработка: считаем total_qty/total_cost на документ (Σ по строкам).
  let totalQty = 0, totalCost = 0;
  const enriched = docs.map((d) => {
    const lines = Array.isArray(d.lines) ? d.lines : [];
    let qty = 0, cost = 0;
    for (const ln of lines) {
      qty += Number(ln.qty) || 0;
      cost += (Number(ln.qty) || 0) * (Number(ln.unit_cost) || 0);
    }
    totalQty += qty;
    totalCost += cost;
    return {
      id: d.id,
      doc_no: d.doc_no,
      platform: d.platform,
      ship_dt: d.ship_dt,
      dest_warehouse: d.dest_warehouse,
      note: d.note,
      created_at: d.created_at,
      lines: lines.map(({ unit_cost, ...rest }) => rest),  // unit_cost не нужен фронту
      total_qty: qty,
      total_cost: round2(cost),
    };
  });

  const totals = { docs: enriched.length, total_qty: totalQty, total_cost: round2(totalCost) };
  const warehouses = await getWarehouses();

  return NextResponse.json({ docs: enriched, totals, warehouses });
});

export const POST = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json();
  // Автор движения остатка (stock_moves.created_by).
  const userId = session?.user_id ?? null;

  // ── create: новая отгрузка (документ + строки + списание остатков) ───────
  if (b.action === "create") {
    const platform = b.platform === "wb" ? "wb" : b.platform === "ozon" ? "ozon" : null;
    if (!platform) return NextResponse.json({ error: "platform wb|ozon required" }, { status: 400 });
    const shipDt = (b.ship_dt || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shipDt)) {
      return NextResponse.json({ error: "ship_dt must be YYYY-MM-DD" }, { status: 400 });
    }
    const lines = Array.isArray(b.lines) ? b.lines : null;
    if (!lines || lines.length === 0) {
      return NextResponse.json({ error: "нужна хотя бы одна строка товара" }, { status: 400 });
    }

    // Нормализация строк + базовая валидация.
    const norm = [];
    for (const [i, ln] of lines.entries()) {
      const ffId = Number(ln.ff_inventory_id);
      const qty = Number(ln.qty);
      if (!Number.isFinite(ffId) || ffId <= 0) {
        return NextResponse.json({ error: `строка ${i + 1}: ff_inventory_id required` }, { status: 400 });
      }
      if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
        return NextResponse.json({ error: `строка ${i + 1}: qty должно быть целым ≥ 1` }, { status: 400 });
      }
      norm.push({ ff_inventory_id: ffId, qty });
    }

    // Не должно быть дублей позиций в одном документе (иначе неоднозначное списание).
    const ids = new Set();
    for (const n of norm) {
      if (ids.has(n.ff_inventory_id)) {
        return NextResponse.json({ error: `позиция id=${n.ff_inventory_id} повторяется в составе` }, { status: 400 });
      }
      ids.add(n.ff_inventory_id);
    }

    // Предпроверка остатка ДО любой записи. Почему не «попробовать и откатить»:
    // withCabinet ловит throw и отдаёт 500, а возврат 400-ответа из обработчика
    // означает КОММИТ транзакции withTenant — то есть частично записанный документ
    // остался бы в базе. Поэтому нехватку остатка ловим здесь, когда писать ещё
    // нечего, и отдаём честный 400. FOR UPDATE держит строки до конца транзакции,
    // так что между проверкой и движением остаток не уедет.
    for (const n of norm) {
      const row = (await tenantQuery(
        `SELECT qty FROM tenant.ff_inventory WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
        [n.ff_inventory_id]
      ))[0];
      if (!row || Number(row.qty) < n.qty) {
        return NextResponse.json(
          { error: `недостаточно остатка для позиции id=${n.ff_inventory_id} (или строка не найдена)` },
          { status: 400 }
        );
      }
    }

    const docNo = (b.doc_no || "").trim() || null;
    const destWh = (b.dest_warehouse || "").trim() || null;
    const note = (b.note || "").trim() || null;
    const docIns = await tenantQuery(
      `INSERT INTO tenant.ff_shipment_docs
         (cabinet_id, doc_no, platform, ship_dt, dest_warehouse, note)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5)
       RETURNING id`,
      [docNo, platform, shipDt, destWh, note]
    );
    const docId = docIns[0]?.id;
    if (!docId) throw new Error("не удалось создать документ отгрузки");

    // Строки: один INSERT со многими VALUES. Эффективнее цикла, и атомарно.
    const valuesSql = norm.map((_, i) =>
      `($1, $2, $${(i * 2) + 3}, $${(i * 2) + 4})`
    ).join(", ");
    const params = [
      Number(cabinet.cabinet_id), docId,
      ...norm.flatMap((n) => [n.ff_inventory_id, n.qty]),
    ];
    const lineRows = await tenantQuery(
      `INSERT INTO tenant.ff_shipment_lines (cabinet_id, doc_id, ff_inventory_id, qty)
       VALUES ${valuesSql}
       RETURNING id, ff_inventory_id, qty`,
      params
    );

    // Списание — движениями журнала (src_ref = «<doc_id>:<line_id>», уникален).
    // Остатка хватает (предпроверка выше держит строки FOR UPDATE); если applyMove
    // всё же бросит insufficient — throw откатит документ целиком (500).
    for (const ln of lineRows) {
      await applyMove({ ffInventoryId: ln.ff_inventory_id, kind: "out_fbo", qty: Number(ln.qty),
        srcKind: "ff_shipment_doc", srcRef: `${docId}:${ln.id}`, movedAt: shipDt, userId });
    }

    return NextResponse.json({ ok: true, id: docId });
  }

  // ── delete: удалить документ (вернуть qty в остатки) ────────────────────
  if (b.action === "delete") {
    const id = Number(b.id);
    if (!id) return NextResponse.json({ error: "id (doc_id) required" }, { status: 400 });

    // Прочитать строки документа → вернуть qty в ff_inventory → удалить строки + документ.
    // Атомарно в текущей транзакции withTenant.
    const lines = await tenantQuery(
      `SELECT id, ff_inventory_id, qty FROM tenant.ff_shipment_lines WHERE doc_id = $1`,
      [id]
    );
    // Возврат qty — движением adjust со ссылкой на удаляемую строку документа.
    // Позиция могла быть удалена/архивирована после отгрузки: applyMove бросил бы
    // «not found» → 500, и документ стало бы невозможно удалить. Поэтому строки без
    // живой позиции пропускаем (возвращать некуда) и считаем в skipped.
    let restored = 0, skipped = 0;
    for (const ln of lines) {
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
