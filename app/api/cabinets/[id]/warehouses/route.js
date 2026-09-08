// app/api/cabinets/[id]/warehouses/route.js — витрина «Склады 2.0» (спека §5).
// GET ?tab=matrix|places → всегда { signals, settings, generatedAt } + данные вкладки.
//   Вкладка «Поставки» ходит в существующие /supply-plan и /shipments — здесь ничего.
// POST { action:'inventory_adjust', location_id|null, note, lines:[{ff_inventory_id, qty_fact}] }
//   (role: manager) — инвентаризация места: по строке движение adjust через applyMove.
//   Все 400 — ДО первой записи (withCabinet коммитит любой ответ): строки блокируются
//   SELECT … FOR UPDATE по возрастанию id (как update_qty в /inventory), план дельт —
//   чистая planInventoryAdjust.
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { applyMove } from "@/lib/stockLedger.js";
import { loadWarehousesInput, buildMatrix, buildPlaceCards, buildSignals } from "@/lib/warehousesData.js";
import { planInventoryAdjust } from "@/lib/warehousesMetrics.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const tab = url.searchParams.get("tab") || "matrix";
  if (!["matrix", "places"].includes(tab)) return NextResponse.json({ error: "tab must be matrix|places" }, { status: 400 });
  const input = await loadWarehousesInput(cabinet.cabinet_id);
  const matrix = buildMatrix(input);
  const signals = buildSignals({ matrix, gaps: input.gaps, docs: input.docs, settings: input.settings });
  const base = { signals, settings: input.settings, generatedAt: new Date().toISOString() };
  if (tab === "matrix") return NextResponse.json({ ...base, matrix });
  const { places, fboWarehouses } = buildPlaceCards(input);
  return NextResponse.json({ ...base, places, fboWarehouses, locations: input.locations, sellerWarehouses: input.sellerWarehouses, items: input.positions });
});

export const POST = withCabinet(async (req, { cabinet, session }) => {
  const b = await req.json();
  if (b.action !== "inventory_adjust") return NextResponse.json({ error: `unknown action: ${b.action}` }, { status: 400 });
  const note = String(b.note ?? "").trim();
  if (!note) return NextResponse.json({ error: "note required (причина инвентаризации)" }, { status: 400 });
  const locationId = b.location_id == null ? null : Number(b.location_id);
  if (locationId != null && !(Number.isInteger(locationId) && locationId > 0)) return NextResponse.json({ error: "location_id must be a positive integer or null" }, { status: 400 });
  const lines = Array.isArray(b.lines) ? b.lines : [];
  const ids = [...new Set(lines.map((l) => Number(l.ff_inventory_id)).filter((x) => Number.isInteger(x) && x > 0))].sort((a, c) => a - c);
  if (!ids.length) return NextResponse.json({ error: "нет строк" }, { status: 400 });
  // Блокировка по возрастанию id — детерминированный порядок против дедлока (как в этапах 2–3).
  const cur = await tenantQuery(
    `SELECT id, qty FROM tenant.ff_inventory
     WHERE id = ANY($1::bigint[]) AND archived_at IS NULL AND ($2::bigint IS NULL OR location_id = $2)
     ORDER BY id FOR UPDATE`, [ids, locationId]);
  const plan = planInventoryAdjust(cur.map((r) => ({ id: Number(r.id), qty: Number(r.qty) })), lines);
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });
  const stamp = new Date().toISOString();
  const userId = session?.user_id ?? null;
  let applied = 0;
  for (const m of plan.moves) {
    const r = await applyMove({ ffInventoryId: m.id, kind: "adjust", qty: m.delta, srcKind: "manual", srcRef: `inv:${stamp}:${m.id}`, note: `инвентаризация: ${note}`, userId });
    if (r.applied) applied += 1;
  }
  return NextResponse.json({ ok: true, applied, unchanged: lines.length - plan.moves.length });
}, { requireRole: "manager" });
