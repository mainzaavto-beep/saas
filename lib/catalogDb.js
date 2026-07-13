// lib/catalogDb.js — справочник товаров компании (PG через tenantQuery).
// Перенос data-presenter/lib/catalogDb.js под PostgreSQL.
import { tenantQuery } from "./db.js";

export async function listProducts() {
  return tenantQuery(`SELECT id, internal_name, note, created_at FROM tenant.products_catalog ORDER BY internal_name`);
}

export async function getProduct(id) {
  const rows = await tenantQuery(`SELECT * FROM tenant.products_catalog WHERE id = $1`, [Number(id)]);
  return rows[0] || null;
}

export async function createProduct(internal_name, note) {
  const rows = await tenantQuery(
    `INSERT INTO tenant.products_catalog (cabinet_id, internal_name, note)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2) RETURNING *`,
    [String(internal_name), note || null]
  );
  return rows[0];
}

export async function updateProduct(id, { internal_name, note }) {
  const sets = [];
  const vals = [];
  if (internal_name != null) { sets.push(`internal_name = $${sets.length + 1}`); vals.push(internal_name); }
  if (note !== undefined) { sets.push(`note = $${sets.length + 1}`); vals.push(note); }
  if (!sets.length) return getProduct(id);
  vals.push(Number(id));
  const rows = await tenantQuery(`UPDATE tenant.products_catalog SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
  return rows[0];
}

export async function deleteProduct(id) {
  await tenantQuery(`DELETE FROM tenant.products_catalog WHERE id = $1`, [Number(id)]);
  return true;
}

export async function listAllSkus() {
  return tenantQuery(`SELECT id, catalog_id, platform, nm_id, product_id, yandex_article, display_name, im_url, created_at FROM tenant.products_catalog_skus ORDER BY catalog_id, platform`);
}

export async function listSkusOf(catalogId) {
  return tenantQuery(
    `SELECT id, catalog_id, platform, nm_id, product_id, yandex_article, display_name, im_url, created_at
     FROM tenant.products_catalog_skus WHERE catalog_id = $1 ORDER BY platform`,
    [Number(catalogId)]
  );
}

export async function addSku({ catalog_id, platform, nm_id, product_id, yandex_article, display_name, im_url }) {
  const rows = await tenantQuery(
    `INSERT INTO tenant.products_catalog_skus (cabinet_id, catalog_id, platform, nm_id, product_id, yandex_article, display_name, im_url)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (cabinet_id, platform, nm_id, product_id) DO UPDATE SET display_name = EXCLUDED.display_name, im_url = EXCLUDED.im_url
     RETURNING *`,
    [Number(catalog_id), platform, nm_id || null, product_id || null, yandex_article || null, display_name || null, im_url || null]
  );
  return rows[0];
}

export async function removeSku(id) {
  await tenantQuery(`DELETE FROM tenant.products_catalog_skus WHERE id = $1`, [Number(id)]);
  return true;
}
