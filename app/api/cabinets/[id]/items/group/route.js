// POST /api/cabinets/[id]/items/group — управление группами товаров.
// Тело:
//   { action: "create", name }
//   { action: "assign"|"unassign", platform, nm_id|product_id, group_id }
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { createGroup, assignGroup, unassignGroup, listGroups } from "@/lib/finItems.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
  const { action } = body;
  if (action === "create") {
    if (!body.name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const group = await createGroup(body.name);
    const groups = await listGroups();
    return NextResponse.json({ ok: true, group, groups });
  }
  if (action === "assign") {
    const { platform, nm_id, product_id, group_id } = body;
    if (!platform || !group_id) return NextResponse.json({ error: "platform + group_id required" }, { status: 400 });
    const group = await assignGroup({ platform, nm_id, product_id, group_id });
    return NextResponse.json({ ok: true, group });
  }
  if (action === "unassign") {
    const { platform, nm_id, product_id } = body;
    if (!platform) return NextResponse.json({ error: "platform required" }, { status: 400 });
    await unassignGroup(platform, nm_id, product_id);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unknown action: " + action }, { status: 400 });
}, { requireRole: 'manager' });
