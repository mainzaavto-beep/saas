// /api/cabinets/[id]/payment-plan — платёжный календарь.
// Использует lib/calendarCalc.js (buildCalendar) — автономный JS-расчёт.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { buildCalendar } from "@/lib/calendarCalc.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const url = new URL(req.url);
    let horizon = Number(url.searchParams.get("horizon_weeks")) || 8;
    if (!Number.isFinite(horizon) || horizon < 1) horizon = 8;
    horizon = Math.min(Math.round(horizon), 26);
    const result = await buildCalendar(horizon);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});
