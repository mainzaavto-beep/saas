// /api/cabinets/[id]/purchase-need — страница «Потребность» (06.10.2026).
// GET ?window=7|14|30 (окно скорости продаж, полные дни по вчера; дефолт 7)
//     &horizon=1..365 (на сколько дней закупать; дефолт 30).
// Расчёт — lib/purchaseNeed.js (чистый), данные — lib/purchaseNeedData.js.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { loadPurchaseNeed } from "@/lib/purchaseNeedData.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req) => {
  try {
    const qp = new URL(req.url).searchParams;
    const w = parseInt(qp.get("window"), 10);
    const windowDays = [7, 14, 30].includes(w) ? w : 7;
    const h = parseInt(qp.get("horizon"), 10);
    const horizonDays = Number.isFinite(h) && h >= 1 && h <= 365 ? h : 30;
    const data = await loadPurchaseNeed({ windowDays, horizonDays });
    return NextResponse.json({ windowDays, horizonDays, ...data });
  } catch (e) {
    console.error("purchase-need:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});
