// POST /api/cabinets/[id]/items/status — установить статус SKU (active/inactive).
// Тело: { platform, nm_id|product_id, status }
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { setStatus } from "@/lib/finItems.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
  const { platform, nm_id, product_id, status } = body;
  if (!platform || !status) {
    return NextResponse.json({ error: "platform + status required" }, { status: 400 });
  }
  const r = await setStatus({ platform, nm_id, product_id, status });
  return NextResponse.json({ ok: true, status: r });
});
