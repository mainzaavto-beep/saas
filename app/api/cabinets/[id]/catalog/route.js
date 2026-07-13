// /api/cabinets/[id]/catalog — справочник товаров компании.
// GET → список товаров + SKU (с обогащением из articles/products).
// POST {internal_name, note} → создать товар.
// POST {id, internal_name, note} → обновить.
// DELETE ?id=N → удалить.
import { NextResponse } from "next/server";
import { tenantQuery, DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { listProducts, createProduct, updateProduct, deleteProduct, listAllSkus, listSkusOf, addSku, removeSku } from "@/lib/catalogDb.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const search = url.searchParams.get("search") || "";

  let products = await listProducts();
  // Поиск по имени
  if (search) {
    const s = search.toLowerCase();
    products = products.filter((p) => (p.internal_name || "").toLowerCase().includes(s));
  }

  // Обогащение SKU из articles/products
  const skus = await listAllSkus();
  // Метаданные WB
  const nmMeta = {};
  const wbNmIds = [...new Set(skus.filter((s) => s.platform === "wb" && s.nm_id).map((s) => s.nm_id))];
  if (wbNmIds.length) {
    try {
      const db = new DatabaseSync("wb", { readOnly: true });
      const ph = wbNmIds.map(() => "?").join(",");
      for (const m of await db.prepare(`SELECT nm_id, name, im_url FROM articles WHERE nm_id IN (${ph})`).all(...wbNmIds)) {
        nmMeta[m.nm_id] = { name: m.name, im_url: m.im_url };
      }
    } catch {}
  }
  // Метаданные Ozon
  const ozMeta = {};
  const ozPids = [...new Set(skus.filter((s) => s.platform === "ozon" && s.product_id).map((s) => s.product_id))];
  if (ozPids.length) {
    try {
      const db = new DatabaseSync("ozon", { readOnly: true });
      const ph = ozPids.map(() => "?").join(",");
      for (const m of await db.prepare(`SELECT product_id, name, im_url FROM products WHERE product_id IN (${ph})`).all(...ozPids)) {
        ozMeta[m.product_id] = { name: m.name, im_url: m.im_url };
      }
    } catch {}
  }

  // Группировка SKU по catalog_id
  const skusByCat = {};
  for (const s of skus) {
    if (!skusByCat[s.catalog_id]) skusByCat[s.catalog_id] = [];
    const meta = s.platform === "wb" ? nmMeta[s.nm_id] : ozMeta[s.product_id];
    skusByCat[s.catalog_id].push({ ...s, mp_name: meta?.name || null, mp_im_url: meta?.im_url || null });
  }

  return NextResponse.json({
    products: products.map((p) => ({ ...p, skus: skusByCat[p.id] || [] })),
    count: products.length,
  });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();

  // CRUD SKU
  if (b.action === "add_sku") {
    const sku = await addSku(b);
    return NextResponse.json({ ok: true, sku });
  }
  if (b.action === "remove_sku") {
    await removeSku(b.id);
    return NextResponse.json({ ok: true });
  }

  // CRUD product
  if (b.id) {
    const p = await updateProduct(b.id, { internal_name: b.internal_name, note: b.note });
    return NextResponse.json({ ok: true, product: p });
  }
  const p = await createProduct(b.internal_name, b.note);
  return NextResponse.json({ ok: true, product: p });
});

export const DELETE = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteProduct(id);
  return NextResponse.json({ ok: true });
});
