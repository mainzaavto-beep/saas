// /api/cabinets/[id]/purchase-need — страница «Потребность» (06.10.2026).
// GET ?window=7|14|30 (окно скорости продаж, полные дни по вчера; дефолт 7)
//     &horizon=1..365 (на сколько дней закупать; дефолт 30)
//     &platform=all|wb|ozon (фильтр площадки; дефолт all)
//     &format=xlsx (выгрузка в Excel, 07.10.2026; &q= и &onlyBuy=1 — фильтры экрана).
// Расчёт — lib/purchaseNeed.js (чистый), данные — lib/purchaseNeedData.js.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { loadPurchaseNeed } from "@/lib/purchaseNeedData.js";
import { buildPurchaseNeedXlsx, filterPurchaseNeedRows } from "@/lib/purchaseNeedXlsx.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req) => {
  try {
    const qp = new URL(req.url).searchParams;
    const w = parseInt(qp.get("window"), 10);
    const windowDays = [7, 14, 30].includes(w) ? w : 7;
    const h = parseInt(qp.get("horizon"), 10);
    const horizonDays = Number.isFinite(h) && h >= 1 && h <= 365 ? h : 30;
    const pf = qp.get("platform");
    const platform = ["wb", "ozon"].includes(pf) ? pf : "all";
    const data = await loadPurchaseNeed({ windowDays, horizonDays, platform });
    const out = { windowDays, horizonDays, platform, ...data };
    if (qp.get("format") === "xlsx") {
      const rows = filterPurchaseNeedRows(out.rows, { q: qp.get("q") || "", onlyBuy: qp.get("onlyBuy") === "1" });
      const buf = await buildPurchaseNeedXlsx(out, rows);
      const day = new Date().toISOString().slice(0, 10);
      return new NextResponse(buf, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="purchase-need-${platform}-${day}.xlsx"`,
        },
      });
    }
    return NextResponse.json(out);
  } catch (e) {
    console.error("purchase-need:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});
