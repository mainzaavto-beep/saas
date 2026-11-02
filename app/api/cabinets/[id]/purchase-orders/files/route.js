// /api/cabinets/[id]/purchase-orders/files — документы заказа закупки (накладные карго и фабрик), 02.11.2026.
// ТОЛЬКО владелец (requireRole 'owner' на каждом методе, гард lib/__tests__/purchaseOrderFiles.test.mjs):
// менеджер получает 403 и на список, и на скачивание по прямой ссылке. Правила файла — lib/purchaseOrderFiles.js,
// таблица — tenant.purchase_order_files (миграция 076). Общий роут purchase-orders файлов не касается.
//   GET ?order_id=N           → { files: [...] } (без байтов)
//   GET ?file_id=N[&inline=1] → сам файл
//   POST multipart: order_id, kind (cargo|factory|other), file, note? → { ok, id }
//   DELETE ?file_id=N         → мягкое удаление
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery } from "@/lib/db.js";
import { validateFileMeta, contentDisposition, fileType } from "@/lib/purchaseOrderFiles.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bad = (error, status = 400) => NextResponse.json({ error }, { status });
const posId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const FILE_COLS = `id, order_id, kind, file_name, mime, size_bytes, note, uploaded_by, created_at::text AS created_at`;

async function orderExists(orderId) {
  return (await tenantQuery(`SELECT 1 FROM tenant.purchase_orders WHERE id = $1 AND deleted_at IS NULL`, [orderId])).length > 0;
}

export const GET = withCabinet(async (req) => {
  const url = new URL(req.url);
  const fileId = url.searchParams.get("file_id");
  if (fileId != null) {
    const id = posId(fileId);
    if (!id) return bad("file_id required");
    const f = (await tenantQuery(
      `SELECT f.file_name, f.mime, f.data FROM tenant.purchase_order_files f
         JOIN tenant.purchase_orders o ON o.cabinet_id = f.cabinet_id AND o.id = f.order_id AND o.deleted_at IS NULL
        WHERE f.id = $1 AND f.deleted_at IS NULL`, [id]))[0];
    if (!f) return bad("файл не найден", 404);
    const inline = url.searchParams.get("inline") === "1" && fileType(f.file_name)?.inline === true;
    return new NextResponse(f.data, {
      headers: {
        "Content-Type": f.mime,
        "Content-Length": String(f.data.length),
        "Content-Disposition": contentDisposition(f.file_name, inline),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }
  const orderId = posId(url.searchParams.get("order_id"));
  if (!orderId) return bad("order_id required");
  if (!(await orderExists(orderId))) return bad("заказ не найден", 404);
  const files = await tenantQuery(
    `SELECT ${FILE_COLS} FROM tenant.purchase_order_files WHERE order_id = $1 AND deleted_at IS NULL ORDER BY id`, [orderId]);
  return NextResponse.json({ files });
}, { requireRole: "owner" });

export const POST = withCabinet(async (req, { session }) => {
  let form;
  try { form = await req.formData(); } catch (e) { console.error("po-files formData", e); return bad("ожидается multipart/form-data"); }
  const orderId = posId(form.get("order_id"));
  if (!orderId) return bad("order_id required");
  const file = form.get("file");
  if (!file || typeof file === "string") return bad("нет файла");
  const v = validateFileMeta({ name: file.name, size: file.size, kind: String(form.get("kind") || "") });
  if (!v.ok) return bad(v.error);
  if (!(await orderExists(orderId))) return bad("заказ не найден", 404);
  const data = Buffer.from(await file.arrayBuffer());
  const note = String(form.get("note") || "").trim().slice(0, 500) || null;
  const r = await tenantQuery(
    `INSERT INTO tenant.purchase_order_files (cabinet_id, order_id, kind, file_name, mime, size_bytes, data, note, uploaded_by)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [orderId, v.value.kind, v.value.file_name, v.value.mime, data.length, data, note, session?.user_id ?? null]);
  return NextResponse.json({ ok: true, id: Number(r[0].id) });
}, { requireRole: "owner" });

export const DELETE = withCabinet(async (req) => {
  const id = posId(new URL(req.url).searchParams.get("file_id"));
  if (!id) return bad("file_id required");
  const r = await tenantQuery(
    `UPDATE tenant.purchase_order_files SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id]);
  if (!r.length) return bad("файл не найден", 404);
  return NextResponse.json({ ok: true });
}, { requireRole: "owner" });
