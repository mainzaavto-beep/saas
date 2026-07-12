// /api/cabinets/[id]/items — список товаров с себестоимостью (WB+Ozon).
// Чтение: cogs (закупочная цена), articles/products (имя/фото).
// Запись: POST {nm, cost, platform} → upsert cogs.
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const mpFilter = url.searchParams.get("mp") || "all";
  const q = url.searchParams.get("q") || "";
  const mps = cabinet.marketplaces || ["wb", "ozon"];
  const items = [];

  if (mpFilter !== "ozon" && mps.includes("wb")) {
    const db = new DatabaseSync("wb", { readOnly: true });
    const rows = await db.prepare(
      `SELECT a.nm_id, a.name, a.brand, a.im_url, a.subject AS category,
              COALESCE(c.cost, 0) AS cost
       FROM articles a
       LEFT JOIN cogs c ON c.nm_id = a.nm_id
       ORDER BY a.name`
    ).all();
    for (const r of rows) {
      if (q && !(r.name || "").toLowerCase().includes(q.toLowerCase()) && !String(r.nm_id).includes(q)) continue;
      items.push({ ...r, platform: "wb", nm: r.nm_id });
    }
  }

  if (mpFilter !== "wb" && mps.includes("ozon")) {
    const db = new DatabaseSync("ozon", { readOnly: true });
    const rows = await db.prepare(
      `SELECT p.product_id AS nm_id, p.name, COALESCE(p.brand, '') AS brand,
              COALESCE(p.im_url, '') AS im_url, '' AS category,
              COALESCE(c.cost, 0) AS cost
       FROM products p
       LEFT JOIN cogs c ON c.product_id = p.product_id
       ORDER BY p.name`
    ).all();
    for (const r of rows) {
      if (q && !(r.name || "").toLowerCase().includes(q.toLowerCase()) && !String(r.nm_id).includes(q)) continue;
      items.push({ ...r, platform: "ozon", nm: r.nm_id });
    }
  }

  return NextResponse.json({ items, count: items.length });
});

// POST — обновить себестоимость товара
export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
  const { nm, cost, platform } = body;
  if (!nm || cost == null) return NextResponse.json({ error: "nm + cost required" }, { status: 400 });

  const mp = platform === "ozon" ? "ozon" : "wb";
  const db = new DatabaseSync(mp, { readOnly: false });

  // Upsert cogs (nm_id → cost)
  await db.prepare(
    `INSERT INTO cogs (nm_id, cost) VALUES (?, ?)
     ON CONFLICT (nm_id) DO UPDATE SET cost = EXCLUDED.cost`
  ).run(nm, Number(cost));

  return NextResponse.json({ ok: true, nm, cost, platform: mp });
});
