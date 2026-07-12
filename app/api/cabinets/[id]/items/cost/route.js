// POST /api/cabinets/[id]/items/cost — создать override себестоимости.
// Тело: { platform, nm_id|product_id, cost, effective_from, note }
// (Алиас к POST /items — выделен для семантики и совместимости с эталоном.)
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { upsertCostOverride } from "@/lib/finItems.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
  const { platform, nm_id, product_id, cost, effective_from, note } = body;
  if (!platform || cost == null || !effective_from) {
    return NextResponse.json({ error: "platform + cost + effective_from required" }, { status: 400 });
  }
  const ov = await upsertCostOverride({ platform, nm_id, product_id, cost, effective_from, note });
  return NextResponse.json({ ok: true, override: ov });
});
