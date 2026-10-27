// lib/catalogSearch.js — поиск артикула WB/Ozon для строк закупок и приёмки (вынесено из
// app/api/cabinets/[id]/deliveries/route.js 27.10.2026). Внутри withTenant.
import { tenantQuery } from "./db.js";

export async function searchCatalog(q) {
  const needle = `%${String(q || "").trim()}%`;
  const out = [];
  const wb = await tenantQuery(
    `SELECT nm_id, name, im_url FROM tenant.wb_articles
     WHERE name ILIKE $1 OR nm_id::text LIKE $1 ORDER BY name LIMIT 20`, [needle]);
  for (const r of wb) out.push({ platform: "wb", nm_id: Number(r.nm_id), label: r.name || `WB ${r.nm_id}`, im_url: r.im_url || null, article: null });
  const oz = await tenantQuery(
    `SELECT product_id, offer_id, name, im_url FROM tenant.ozon_products
     WHERE name ILIKE $1 OR offer_id ILIKE $1 OR product_id::text LIKE $1 ORDER BY name LIMIT 20`, [needle]);
  for (const r of oz) out.push({ platform: "ozon", product_id: Number(r.product_id), label: r.name || `Ozon ${r.product_id}`, im_url: r.im_url || null, article: r.offer_id || null });
  return out.slice(0, 20);
}

async function catalogRow(line) {
  if (line.platform === "wb") return (await tenantQuery(`SELECT name, im_url FROM tenant.wb_articles WHERE nm_id = $1`, [Number(line.nm_id)]))[0];
  if (line.platform === "ozon") return (await tenantQuery(`SELECT name, im_url FROM tenant.ozon_products WHERE product_id = $1`, [Number(line.product_id)]))[0];
  return null;
}
export async function catalogLabel(line) { return (await catalogRow(line))?.name || null; }
export async function catalogPhoto(line) { return (await catalogRow(line))?.im_url || null; }
