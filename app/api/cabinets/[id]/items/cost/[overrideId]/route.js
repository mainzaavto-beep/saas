// PUT/DELETE /api/cabinets/[id]/items/cost/[overrideId] — правка/удаление
// конкретной записи истории себестоимости (по PK id).
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { updateCostOverride, deleteCostOverride, getCostOverrideById } from "@/lib/finItems.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = withCabinet(async (req, { params }) => {
  const id = Number(params.overrideId);
  if (!id) return NextResponse.json({ error: "overrideId required" }, { status: 400 });
  const body = await req.json();
  const ov = await updateCostOverride(id, body);
  return NextResponse.json({ ok: true, override: ov });
});

export const DELETE = withCabinet(async (req, { params }) => {
  const id = Number(params.overrideId);
  if (!id) return NextResponse.json({ error: "overrideId required" }, { status: 400 });
  const ok = await deleteCostOverride(id);
  return NextResponse.json({ ok });
});
