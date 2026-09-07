// /api/cabinets/[id]/transfers — перемещения ФФ→ФФ (спека «Склады 2.0» §3.6).
//
// Документ = откуда, куда, дата, строки. Создание: предпроверка остатка на
// месте-источнике (FOR UPDATE) → ff_transfer_docs + по строке applyTransfer
// (transfer_out у источника + transfer_in у приёмника) → ff_transfer_lines.
// Без стадии «в пути»: перемещение мгновенное.
//
// GET → { docs: [{ id, from_location_id, from_name, to_location_id, to_name,
//                  moved_at, note, created_at, lines: [...] }] }  (любая роль)
// POST { action:"create", from_location_id, to_location_id, moved_at?, note?,
//        lines:[{ff_inventory_id, qty}] } → { ok, id }            (role: manager)
//        Место назначения проверяется на существование и is_active → иначе 400.
//
// ⚠ Нехватка остатка = 400 и НИЧЕГО не записано. Почему предпроверка, а не
// «попробовать и откатить»: withCabinet коммитит транзакцию withTenant при любом
// ВОЗВРАТЕ ответа (в т.ч. 400) и отдаёт 500 при throw. То есть вернуть 400 после
// начала записи — значит закоммитить половину документа, а бросить исключение —
// отдать 500 вместо 400. Поэтому остаток проверяется ДО первой записи, когда
// откатывать ещё нечего; FOR UPDATE держит строки до конца транзакции, так что
// между проверкой и applyTransfer остаток не уедет. throw из applyTransfer
// («insufficient: …») остаётся страховкой: ROLLBACK всего документа + 500.
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { normalizeTransferDoc } from "@/lib/stockMoves.js";
import { applyTransfer } from "@/lib/stockLedger.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async () => {
  const docs = await tenantQuery(
    `SELECT d.id, d.from_location_id, lf.name AS from_name, d.to_location_id, lt.name AS to_name,
            d.moved_at, d.note, d.created_at
     FROM tenant.ff_transfer_docs d
     LEFT JOIN tenant.stock_ff_locations lf ON lf.cabinet_id = d.cabinet_id AND lf.id = d.from_location_id
     LEFT JOIN tenant.stock_ff_locations lt ON lt.cabinet_id = d.cabinet_id AND lt.id = d.to_location_id
     ORDER BY d.moved_at DESC, d.id DESC LIMIT 200`
  );
  const lines = await tenantQuery(
    `SELECT l.doc_id, l.ff_inventory_id, l.to_ff_inventory_id, l.qty,
            COALESCE(f.internal_name, f.sku_name, '(скрыто)') AS item_name
     FROM tenant.ff_transfer_lines l
     LEFT JOIN tenant.ff_inventory f ON f.cabinet_id = l.cabinet_id AND f.id = l.ff_inventory_id
     ORDER BY l.doc_id, l.id`
  );
  const byDoc = new Map();
  for (const ln of lines) {
    if (!byDoc.has(ln.doc_id)) byDoc.set(ln.doc_id, []);
    byDoc.get(ln.doc_id).push(ln);
  }
  return NextResponse.json({ docs: docs.map((d) => ({ ...d, lines: byDoc.get(d.id) || [] })) });
});

export const POST = withCabinet(async (req, { session }) => {
  const b = await req.json();
  if (b.action !== "create") {
    return NextResponse.json({ error: `unknown action: ${b.action}` }, { status: 400 });
  }
  const n = normalizeTransferDoc(b);
  if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
  const { fromLocationId, toLocationId, movedAt, note, lines } = n.doc;
  const userId = session?.user_id ?? null;

  // Место назначения должно существовать и быть активным: иначе перемещение уводит
  // товар в никуда (и на неактивном месте позиции не показываются в /inventory).
  const dest = (await tenantQuery(
    `SELECT id FROM tenant.stock_ff_locations WHERE id = $1 AND is_active`, [toLocationId]
  ))[0];
  if (!dest) {
    return NextResponse.json({ error: "место назначения не найдено или неактивно" }, { status: 400 });
  }

  // Предпроверка ДО любой записи: все строки лежат на месте-источнике, живые,
  // и остатка хватает. FOR UPDATE блокирует их до конца транзакции. ORDER BY id —
  // детерминированный порядок блокировок (LockRows стоит над Sort, строки лочатся уже
  // отсортированными): два одновременных перемещения с пересекающимся составом иначе
  // могли бы взять блокировки в разном порядке и встать в дедлок.
  const ids = lines.map((l) => l.ffInventoryId).sort((a, b) => a - b);
  const src = await tenantQuery(
    `SELECT id, qty FROM tenant.ff_inventory
     WHERE id = ANY($1::bigint[]) AND location_id = $2 AND archived_at IS NULL
     ORDER BY id
     FOR UPDATE`,
    [ids, fromLocationId]
  );
  const qtyById = new Map(src.map((r) => [Number(r.id), Number(r.qty)]));
  const missing = ids.filter((id) => !qtyById.has(id));
  if (missing.length) {
    return NextResponse.json(
      { error: `позиции не на месте-источнике (или не найдены): ${missing.join(", ")}` },
      { status: 400 }
    );
  }
  const short = lines.filter((l) => qtyById.get(l.ffInventoryId) < l.qty);
  if (short.length) {
    return NextResponse.json(
      {
        error: "недостаточно остатка: " + short
          .map((l) => `позиция id=${l.ffInventoryId} — есть ${qtyById.get(l.ffInventoryId)}, нужно ${l.qty}`)
          .join("; "),
      },
      { status: 400 }
    );
  }

  const doc = (await tenantQuery(
    `INSERT INTO tenant.ff_transfer_docs (cabinet_id, from_location_id, to_location_id, moved_at, note, created_by)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5) RETURNING id`,
    [fromLocationId, toLocationId, movedAt, note, userId]
  ))[0];
  if (!doc?.id) throw new Error("не удалось создать документ перемещения");

  for (const [i, ln] of lines.entries()) {
    const { toFfInventoryId } = await applyTransfer({
      ffInventoryId: ln.ffInventoryId, toLocationId, qty: ln.qty,
      docId: doc.id, lineNo: i + 1, movedAt, userId,
    });
    await tenantQuery(
      `INSERT INTO tenant.ff_transfer_lines (cabinet_id, doc_id, ff_inventory_id, to_ff_inventory_id, qty)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4)`,
      [doc.id, ln.ffInventoryId, toFfInventoryId, ln.qty]
    );
  }

  return NextResponse.json({ ok: true, id: doc.id });
}, { requireRole: "manager" });
