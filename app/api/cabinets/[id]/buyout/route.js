// /api/cabinets/[id]/buyout — «Процент выкупа» (WB, когортно по дате заказа, 11.10.2026).
// GET ?from&to (YYYY-MM-DD, по дате заказа; дефолт 30 дней по вчера) &q (поиск по товару)
//     → { kpi, items[] с sizes[] }.
// GET ?series=1[&nm=<nmId>] → 13 недель заказа (12 полных + текущая), при nm — по размерам.
// Расчёт — lib/buyout.js, данные — lib/buyoutData.js. Ozon — следующий этап (спека §8).
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { aggregateBuyout, weeklyBuyout, weekStart } from "@/lib/buyout.js";
import { loadWbBuyoutRows } from "@/lib/buyoutData.js";
import { defaultPeriod } from "@/lib/period.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const GET = withCabinet(async (req) => {
  try {
    const qp = new URL(req.url).searchParams;
    const asOf = new Date().toISOString().slice(0, 10);
    if (qp.get("series") === "1") {
      const nmRaw = parseInt(qp.get("nm"), 10);
      const nmId = Number.isFinite(nmRaw) ? nmRaw : null;
      const from = new Date(Date.parse(`${weekStart(asOf)}T00:00:00Z`) - 12 * 7 * 864e5).toISOString().slice(0, 10);
      const rows = await loadWbBuyoutRows(from, asOf);
      return NextResponse.json({ asOf, nmId, ...weeklyBuyout(rows, asOf, { nmId }) });
    }
    const def = defaultPeriod(30);
    const from = ISO.test(qp.get("from") || "") ? qp.get("from") : def.from;
    const to = ISO.test(qp.get("to") || "") ? qp.get("to") : def.to;
    if (from > to) return NextResponse.json({ error: "from > to" }, { status: 400 });
    const { kpi, items } = aggregateBuyout(await loadWbBuyoutRows(from, to), asOf);
    const q = (qp.get("q") || "").trim().toLowerCase();
    const shown = q
      ? items.filter((i) => `${i.name || ""} ${i.article || ""} ${i.nmId}`.toLowerCase().includes(q))
      : items;
    return NextResponse.json({ platform: "wb", from, to, asOf, kpi, items: shown, ozon: { legacy: true } });
  } catch (e) {
    console.error("buyout:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});
