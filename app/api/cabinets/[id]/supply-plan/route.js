// /api/cabinets/[id]/supply-plan — рекомендации поставок «ФФ → склад МП»
// (спека «Склады 2.0» §4.1). Данные собирает lib/supplyPlanData.js, арифметику
// считает lib/supplyPlan.js; роут только разбирает запрос и отдаёт витрину.
//
// GET ?platform=all|wb|ozon → { settings, groups, uncovered, generatedAt }
//   settings: { targetDays, minDays } — пороги кабинета (auth.cabinets.settings).
//   groups[]: { locationId, locationName, platform, warehouseKey, warehouseName, lines[] }
//     lines[]: { itemId, itemName, skuKey, need, qty, velocity, coverageDays, available,
//                positions:[{ffInventoryId, qty}] } — positions готовы к отправке в POST.
//   uncovered[]: { itemId, warehouseKey, qty, itemName, warehouseName, platform } —
//     нужно, но на ФФ нечем закрыть (имена — из targets, см. enrichUncovered).
//
// POST { action:'create_doc', locationId, platform, warehouseKey, warehouseName,
//        lines:[{ff_inventory_id, qty}], ship_dt?, note? } (role: manager)
//   → черновик документа отгрузки (lib/shipmentDocs.js createShipmentDoc, status='draft').
//   Черновик остаток НЕ списывает — списание произойдёт при «Отгрузить» (ship).
//   dest_warehouse_id = числовой warehouseKey — и у Ozon (id склада из
//   shared.ozon_clusters), и у WB, если карточка рекомендации прислала выбранный склад
//   (shared.wb_warehouses.id): цель у WB одна на кабинет, но склад назначения владелец
//   выбирает прямо в карточке. Не выбран (warehouseKey='wb') → dest_warehouse_id = null
//   и dest_warehouse = «WB (все склады)», склад можно проставить позже действием
//   `update` документа.
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { buildPlanForCabinet } from "@/lib/supplyPlanData.js";
import { createShipmentDoc } from "@/lib/shipmentDocs.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLATFORMS = new Set(["all", "wb", "ozon"]);

export const GET = withCabinet(async (req, { cabinet }) => {
  const raw = new URL(req.url).searchParams.get("platform") || "all";
  const platform = PLATFORMS.has(raw) ? raw : "all";
  const plan = await buildPlanForCabinet({ cabinetId: cabinet.cabinet_id, platform });
  return NextResponse.json({ platform, ...plan });
});

export const POST = withCabinet(async (req, { session }) => {
  const b = await req.json();
  if (b.action !== "create_doc") {
    return NextResponse.json({ error: `unknown action: ${b.action}` }, { status: 400 });
  }
  const platform = b.platform === "wb" ? "wb" : b.platform === "ozon" ? "ozon" : null;
  if (!platform) return NextResponse.json({ error: "platform wb|ozon required" }, { status: 400 });

  // Склад назначения: числовой warehouseKey — id склада в справочнике площадки
  // (Ozon: shared.ozon_clusters.warehouse_id; WB: shared.wb_warehouses.id, приходит
  // из селекта в карточке рекомендации). Нечисловой ключ (у WB это 'wb' — «склад не
  // выбран») → dest_warehouse_id пустой, имя остаётся как есть.
  const keyNum = Number(b.warehouseKey);
  const destWarehouseId = Number.isInteger(keyNum) && keyNum > 0 ? keyNum : null;

  const res = await createShipmentDoc(tenantQuery, {
    platform,
    shipDt: String(b.ship_dt || "").slice(0, 10) || new Date().toISOString().slice(0, 10),
    locationId: b.locationId ?? b.location_id ?? null,
    destWarehouseId,
    destWarehouse: b.warehouseName ?? b.dest_warehouse ?? null,
    note: b.note ?? "план поставок",
    lines: b.lines,
    status: "draft",
    userId: session?.user_id ?? null,
  });
  return res?.ok === false
    ? NextResponse.json({ error: res.error }, { status: res.status || 400 })
    : NextResponse.json(res);
}, { requireRole: "manager" });
