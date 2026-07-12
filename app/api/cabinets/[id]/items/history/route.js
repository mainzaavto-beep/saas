// GET /api/cabinets/[id]/items/history — история cost_overrides по SKU.
// Query: ?platform=&nm_id=  или  ?platform=&product_id=
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { listCostOverrides } from "@/lib/finItems.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") || "";
  const nmId = url.searchParams.get("nm_id");
  const productId = url.searchParams.get("product_id");
  if (!platform) return NextResponse.json({ error: "platform required" }, { status: 400 });
  const rows = await listCostOverrides(platform, nmId, productId);
  return NextResponse.json({ items: rows });
});
