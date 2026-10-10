// /api/cabinets/[id]/plan/approve — утвердить строку плана (заявка №29).
//
// Кнопка ✓ в строке таблицы месяца. Ставит approved=1 (строка «утверждена»).
// Фронт (PlanPage.jsx:approve) не читает тело ответа — только статус HTTP.
import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await tenantQuery(
    `UPDATE tenant.sales_plan SET approved = 1, updated_at = now() WHERE id = $1`,
    [id]
  );
  return NextResponse.json({ ok: true });
}, { requireRole: 'manager' });
