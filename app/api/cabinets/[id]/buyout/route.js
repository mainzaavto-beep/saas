// /api/cabinets/[id]/buyout — «Процент выкупа» (WB+Ozon, когортно по дате заказа, 12.10.2026).
// GET ?from&to (YYYY-MM-DD, по дате заказа; дефолт 30 дней по вчера) &platform=wb|ozon|all
//     (дефолт all) &q (поиск по товару) → { platform, from, to, asOf, kpi, items[] с sizes[] }.
// GET ?series=1&platform=wb|ozon[&nm=<id>] → 13 недель заказа (12 полных + текущая), при nm —
//     по размерам товара указанной площадки; platform=all + nm → 400 (площадка товара неоднозначна).
// &cat=<категория> (повторяемый; 20.10.2026) — фильтр по категории товара в обоих режимах: режет
//     строки ДО расчёта, поэтому KPI и график — по выбранным категориям. Ответ периода несёт
//     categories[[имя, товаров]] — по всем товарам периода/площадки, без учёта фильтра.
// Расчёт — lib/buyout.js, данные — lib/buyoutData.js.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { aggregateBuyout, weeklyBuyout, weekStart, todayMsk, filterByCategory, categoryFacets } from "@/lib/buyout.js";
import { loadBuyoutRows } from "@/lib/buyoutData.js";
import { defaultPeriod } from "@/lib/period.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PLATFORMS = new Set(["wb", "ozon", "all"]);

export const GET = withCabinet(async (req) => {
  try {
    const qp = new URL(req.url).searchParams;
    const platformRaw = qp.get("platform");
    const platform = PLATFORMS.has(platformRaw) ? platformRaw : "all";
    const cats = qp.getAll("cat").map((s) => s.trim()).filter(Boolean);
    const asOf = todayMsk(); // МСК, не UTC сервера — заказы датированы МСК (фикс 2026-10-12)
    if (qp.get("series") === "1") {
      const nmRaw = parseInt(qp.get("nm"), 10);
      const nmId = Number.isFinite(nmRaw) ? nmRaw : null;
      if (nmId != null && platform === "all") {
        return NextResponse.json({ error: "укажите площадку товара" }, { status: 400 });
      }
      const from = new Date(Date.parse(`${weekStart(asOf)}T00:00:00Z`) - 12 * 7 * 864e5).toISOString().slice(0, 10);
      const rows = filterByCategory(await loadBuyoutRows(platform, from, asOf), cats);
      return NextResponse.json({ asOf, nmId, ...weeklyBuyout(rows, asOf, { nmId, platform: platform === "all" ? null : platform }) });
    }
    const def = defaultPeriod(30);
    const from = ISO.test(qp.get("from") || "") ? qp.get("from") : def.from;
    const to = ISO.test(qp.get("to") || "") ? qp.get("to") : def.to;
    if (from > to) return NextResponse.json({ error: "from > to" }, { status: 400 });
    const all = await loadBuyoutRows(platform, from, to);
    const categories = categoryFacets(all);
    const { kpi, items } = aggregateBuyout(filterByCategory(all, cats), asOf);
    const q = (qp.get("q") || "").trim().toLowerCase();
    const shown = q
      ? items.filter((i) => `${i.name || ""} ${i.article || ""} ${i.nmId}`.toLowerCase().includes(q))
      : items;
    return NextResponse.json({ platform, from, to, asOf, cats, categories, kpi, items: shown });
  } catch (e) {
    console.error("buyout:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});
