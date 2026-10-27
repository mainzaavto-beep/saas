// /api/cabinets/[id]/purchase-orders — закупки «заказ → позиции → отправки» (27.10.2026, спека
// docs/superpowers/specs/2026-10-27-purchase-orders-design.md). Расчёт — lib/purchaseOrders.js,
// БД — lib/purchaseOrdersData.js, ДДС — только syncOrderPayments (lib/paymentCalendarData.js).
// Любая запись: заказ берётся FOR UPDATE первым, затем правка, затем syncOrderPayments + refreshOrderStatus.
// В ff_inventory / stock_moves / cost_overrides НЕ пишем.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery } from "@/lib/db.js";
import { validateOrderInput, validateLineInput, validatePaymentInput, validateShipmentInput,
  checkShipQty, defaultShipmentLines } from "@/lib/purchaseOrders.js";
import { loadOrder, loadOrderView, listOrders, refreshOrderStatus } from "@/lib/purchaseOrdersData.js";
import { syncOrderPayments, archiveOrderPayments } from "@/lib/paymentCalendarData.js";
import { searchCatalog, catalogLabel, catalogPhoto } from "@/lib/catalogSearch.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bad = (error, status = 400) => NextResponse.json({ error }, { status });
const ok = (extra = {}) => NextResponse.json({ ok: true, ...extra });
const posId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  if (url.searchParams.get("catalog") === "1") {
    return NextResponse.json({ catalog: await searchCatalog(url.searchParams.get("q")) });
  }
  const id = url.searchParams.get("id");
  if (id) {
    const v = await loadOrderView(id);
    if (!v) return bad("заказ не найден", 404);
    return NextResponse.json({ ...v, role: cabinet.role });
  }
  const items = await listOrders({
    status: url.searchParams.get("status") || "",
    supplier: url.searchParams.get("supplier") || "",
    category: url.searchParams.get("category") || "",
    closed: url.searchParams.get("closed") === "1",
  });
  const all = await listOrders({ closed: true });
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  return NextResponse.json({ items, suppliers: uniq(all.map((x) => x.supplier)), categories: uniq(all.map((x) => x.category)), role: cabinet.role });
});

// Позиция: подставить имя/фото карточки, если выбран артикул и текст пуст.
async function fillFromCatalog(raw) {
  const r = { ...raw };
  if (r.platform && !String(r.label || "").trim()) r.label = (await catalogLabel(r)) || "";
  if (r.platform && !r.photo_url) r.photo_url = await catalogPhoto(r);
  return r;
}

async function afterChange(orderId) {
  await syncOrderPayments(orderId);
  await refreshOrderStatus(orderId);
}

export const POST = withCabinet(async (req, { session }) => {
  const b = await req.json();
  const action = b?.action;

  // Действие без order_id — до проверки order_id (грабля D10).
  if (action === "create") {
    const v = validateOrderInput(b);
    if (!v.ok) return bad(v.error);
    const o = v.value;
    const r = await tenantQuery(
      `INSERT INTO tenant.purchase_orders (cabinet_id, order_no, supplier, supplier_contact, source_country, category,
         note, order_dt, rate_cny, status, created_by)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [o.order_no, o.supplier, o.supplier_contact, o.source_country, o.category, o.note, o.order_dt, o.rate_cny, o.status, session?.user_id ?? null]);
    return ok({ id: Number(r[0].id) });
  }

  const orderId = posId(b?.order_id);
  if (!orderId) return bad("order_id required");
  const bundle = await loadOrder(orderId, { lock: true });
  if (!bundle) return bad("заказ не найден", 404);
  const { order, lines, shipments, shipmentLines } = bundle;

  if (action === "update") {
    const v = validateOrderInput({ ...order, ...b });
    if (!v.ok) return bad(v.error);
    const o = v.value;
    // Статус «Закрыт» выставляет только refreshOrderStatus (и ставит archived_at) — руками нельзя.
    if (o.status === "closed" && order.status !== "closed") {
      return bad("статус «Закрыт» ставится автоматически, когда всё принято");
    }
    await tenantQuery(
      `UPDATE tenant.purchase_orders SET order_no = $2, supplier = $3, supplier_contact = $4, source_country = $5,
         category = $6, note = $7, order_dt = $8, rate_cny = $9, status = $10, updated_at = now() WHERE id = $1`,
      [orderId, o.order_no, o.supplier, o.supplier_contact, o.source_country, o.category, o.note, o.order_dt, o.rate_cny, o.status]);
    await afterChange(orderId);
    return ok();
  }

  if (action === "delete") {
    if (shipments.some((s) => s.status === "accepted")) return bad("у заказа есть принятые отправки — удалить нельзя");
    await tenantQuery(`UPDATE tenant.purchase_orders SET deleted_at = now(), updated_at = now() WHERE id = $1`, [orderId]);
    await tenantQuery(`UPDATE tenant.purchase_order_payments SET deleted_at = now() WHERE order_id = $1 AND deleted_at IS NULL`, [orderId]);
    await tenantQuery(`UPDATE tenant.purchase_shipments SET deleted_at = now() WHERE order_id = $1 AND deleted_at IS NULL`, [orderId]);
    await tenantQuery(`UPDATE tenant.purchase_order_lines SET deleted_at = now() WHERE order_id = $1 AND deleted_at IS NULL`, [orderId]);
    await archiveOrderPayments(orderId);
    return ok();
  }

  // ---- позиции ----
  const findLine = (id) => lines.find((l) => Number(l.id) === Number(id));
  const shippedOf = (lineId) => shipmentLines.filter((x) => Number(x.line_id) === Number(lineId))
    .reduce((s, x) => s + Number(x.qty_shipped), 0);

  if (action === "line_add" || action === "line_copy") {
    let raw = b;
    if (action === "line_copy") {
      const src = findLine(b.id);
      if (!src) return bad("позиция не найдена", 404);
      raw = { ...src, variant: b.variant ?? null, qty: b.qty ?? src.qty, photo_url: null };
    }
    const v = validateLineInput(await fillFromCatalog(raw));
    if (!v.ok) return bad(v.error);
    const l = v.value;
    const r = await tenantQuery(
      `INSERT INTO tenant.purchase_order_lines (cabinet_id, order_id, platform, nm_id, product_id, label, variant, qty,
         price_cny, weight_kg, photo_url, note)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [orderId, l.platform, l.nm_id, l.product_id, l.label, l.variant, l.qty, l.price_cny, l.weight_kg, l.photo_url, l.note]);
    await afterChange(orderId);
    return ok({ id: Number(r[0].id) });
  }

  if (action === "line_update") {
    const cur = findLine(b.id);
    if (!cur) return bad("позиция не найдена", 404);
    // Фото хранится в l.photo_url (LINE_COLS отдаёт его рядом с вычисленным "photo"). Частичная
    // правка не должна стирать сохранённое фото — сбрасываем его в null, только если артикул
    // реально сменился (тогда подставится фото карточки через fillFromCatalog); b.photo_url,
    // если пришёл явно, имеет приоритет (ручная замена фото).
    const normId = (v) => (v == null || v === "" ? null : String(Number(v)));
    const articleChanged = (b.platform !== undefined && (b.platform || null) !== (cur.platform || null))
      || (b.nm_id !== undefined && normId(b.nm_id) !== normId(cur.nm_id))
      || (b.product_id !== undefined && normId(b.product_id) !== normId(cur.product_id));
    const merged = { ...cur, photo_url: articleChanged ? null : cur.photo_url, ...b };
    if (b.platform !== undefined && b.label === undefined) merged.label = ""; // сменили артикул — имя из каталога
    const v = validateLineInput(await fillFromCatalog(merged));
    if (!v.ok) return bad(v.error);
    const l = v.value;
    if (l.qty < shippedOf(cur.id)) return bad(`уже отправлено ${shippedOf(cur.id)} шт — меньше нельзя`);
    await tenantQuery(
      `UPDATE tenant.purchase_order_lines SET platform = $2, nm_id = $3, product_id = $4, label = $5, variant = $6,
         qty = $7, price_cny = $8, weight_kg = $9, photo_url = $10, note = $11, updated_at = now() WHERE id = $1`,
      [cur.id, l.platform, l.nm_id, l.product_id, l.label, l.variant, l.qty, l.price_cny, l.weight_kg, l.photo_url, l.note]);
    await afterChange(orderId);
    return ok();
  }

  if (action === "line_delete") {
    const cur = findLine(b.id);
    if (!cur) return bad("позиция не найдена", 404);
    if (shippedOf(cur.id) > 0) return bad("позиция уже в отправке — сначала уберите её из отправок");
    await tenantQuery(`UPDATE tenant.purchase_order_lines SET deleted_at = now(), updated_at = now() WHERE id = $1`, [cur.id]);
    await afterChange(orderId);
    return ok();
  }

  // ---- оплаты ----
  if (action === "pay_add" || action === "pay_update") {
    const cur = action === "pay_update" ? bundle.payments.find((p) => Number(p.id) === Number(b.id)) : null;
    if (action === "pay_update" && !cur) return bad("оплата не найдена", 404);
    const v = validatePaymentInput({ ...(cur || {}), ...b });
    if (!v.ok) return bad(v.error);
    const p = v.value;
    let id = cur?.id;
    if (cur) {
      await tenantQuery(
        `UPDATE tenant.purchase_order_payments SET kind = $2, currency = $3, amount = $4, rate = $5, plan_date = $6,
           note = $7, updated_at = now() WHERE id = $1`, [cur.id, p.kind, p.currency, p.amount, p.rate, p.plan_date, p.note]);
    } else {
      const r = await tenantQuery(
        `INSERT INTO tenant.purchase_order_payments (cabinet_id, order_id, kind, currency, amount, rate, plan_date, note)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [orderId, p.kind, p.currency, p.amount, p.rate, p.plan_date, p.note]);
      id = r[0].id;
    }
    await afterChange(orderId);
    return ok({ id: Number(id) });
  }

  if (action === "pay_delete") {
    const cur = bundle.payments.find((p) => Number(p.id) === Number(b.id));
    if (!cur) return bad("оплата не найдена", 404);
    await tenantQuery(`UPDATE tenant.purchase_order_payments SET deleted_at = now(), updated_at = now() WHERE id = $1`, [cur.id]);
    await afterChange(orderId); // плановая строка ДДС → архив, оплаченная — остаётся (правило syncRefs)
    return ok();
  }

  // ---- отправки ----
  const findShip = (id) => shipments.find((s) => Number(s.id) === Number(id));

  if (action === "ship_add") {
    const v = validateShipmentInput(b);
    if (!v.ok) return bad(v.error);
    const s = v.value;
    const newLines = s.lines ?? defaultShipmentLines(lines, shipmentLines);
    if (!newLines.length) return bad("всё уже отправлено — нечего добавить в отправку");
    const err = checkShipQty(lines, shipmentLines, newLines, null);
    if (err) return bad(err);
    const r = await tenantQuery(
      `INSERT INTO tenant.purchase_shipments (cabinet_id, order_id, shipment_no, carrier, ship_dt, eta, arrived_dt,
         cargo_rub, ff_rub, note)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [orderId, s.shipment_no, s.carrier, s.ship_dt, s.eta, s.arrived_dt, s.cargo_rub, s.ff_rub, s.note]);
    const sid = Number(r[0].id);
    for (const x of newLines) {
      await tenantQuery(
        `INSERT INTO tenant.purchase_shipment_lines (cabinet_id, shipment_id, line_id, qty_shipped)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3)`, [sid, x.line_id, x.qty_shipped]);
    }
    await afterChange(orderId);
    return ok({ id: sid });
  }

  if (action === "ship_update") {
    const cur = findShip(b.id);
    if (!cur) return bad("отправка не найдена", 404);
    const v = validateShipmentInput({ ...cur, ...b });
    if (!v.ok) return bad(v.error);
    const s = v.value;
    if (s.lines !== undefined) {
      if (cur.status === "accepted") return bad("отправка принята — состав менять нельзя (деньги — можно)");
      if (!s.lines.length) return bad("в отправке должна быть хотя бы одна позиция");
      const err = checkShipQty(lines, shipmentLines, s.lines, cur.id);
      if (err) return bad(err);
      await tenantQuery(`DELETE FROM tenant.purchase_shipment_lines WHERE shipment_id = $1`, [cur.id]);
      for (const x of s.lines) {
        await tenantQuery(
          `INSERT INTO tenant.purchase_shipment_lines (cabinet_id, shipment_id, line_id, qty_shipped)
           VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3)`, [cur.id, x.line_id, x.qty_shipped]);
      }
    }
    await tenantQuery(
      `UPDATE tenant.purchase_shipments SET shipment_no = $2, carrier = $3, ship_dt = $4, eta = $5, arrived_dt = $6,
         cargo_rub = $7, ff_rub = $8, note = $9, updated_at = now() WHERE id = $1`,
      [cur.id, s.shipment_no, s.carrier, s.ship_dt, s.eta, s.arrived_dt, s.cargo_rub, s.ff_rub, s.note]);
    await afterChange(orderId);
    return ok();
  }

  if (action === "ship_delete") {
    const cur = findShip(b.id);
    if (!cur) return bad("отправка не найдена", 404);
    if (cur.status === "accepted") return bad("отправка уже принята — удалить нельзя");
    await tenantQuery(`DELETE FROM tenant.purchase_shipment_lines WHERE shipment_id = $1`, [cur.id]);
    await tenantQuery(`UPDATE tenant.purchase_shipments SET deleted_at = now(), updated_at = now() WHERE id = $1`, [cur.id]);
    await afterChange(orderId);
    return ok();
  }

  if (action === "ship_arrived" || action === "ship_unarrived") {
    const cur = findShip(b.id);
    if (!cur) return bad("отправка не найдена", 404);
    if (action === "ship_arrived") {
      if (cur.status !== "transit") return bad("отправка уже прибыла");
      const d = String(b.arrived_dt || cur.arrived_dt || new Date().toISOString().slice(0, 10)).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return bad("дата прибытия — ГГГГ-ММ-ДД");
      await tenantQuery(`UPDATE tenant.purchase_shipments SET status = 'arrived', arrived_dt = $2, updated_at = now() WHERE id = $1`, [cur.id, d]);
    } else {
      if (cur.status !== "arrived") return bad("вернуть «в пути» можно только прибывшую, ещё не принятую отправку");
      // Сбрасываем arrived_dt — иначе цепочка дат ДДС (arrived_dt → eta → ship_dt) хранит
      // устаревшую дату прибытия у отправки, которая снова «в пути».
      await tenantQuery(`UPDATE tenant.purchase_shipments SET status = 'transit', arrived_dt = NULL, updated_at = now() WHERE id = $1`, [cur.id]);
    }
    await afterChange(orderId);
    return ok();
  }

  return bad("неизвестное действие");
}, { requireRole: "manager" });
