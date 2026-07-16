// /api/cabinets/[id]/inventory — остатки склада/ФФ (маршрут: закупка → завершить → склад).
//
// GET → { items, totals }
//   items: наименование, qty, себест. (unit_cost = «себест. до МП»), сумма (qty×unit_cost),
//          категория, привязанный артикул МП (platform/nm_id/product_id/sku_name/im_url).
//          Если артикул привязан — имя/фото подтягиваются из wb_articles/ozon_products
//          (богаче, чем сохранённое при привязке).
// POST { action } → link_sku | unlink_sku | update_qty
//
// Привязка артикула (link_sku) → создаёт/обновляет cost_override с unit_cost
// (effective_from = completed_at или сегодня) → себестоимость потечёт в
// P&L/юнитку/mp-stock автоматически (единый источник cost_overrides, AGENTS.md).
import { NextResponse } from "next/server";
import { tenantQuery, DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { upsertCostOverride } from "@/lib/finItems.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export const GET = withCabinet(async (req, { cabinet }) => {
  const rows = await tenantQuery(
    `SELECT f.id, f.purchase_id, f.internal_name, f.qty, f.unit_cost, f.category,
            f.platform, f.nm_id, f.product_id, f.sku_name, f.im_url, f.location_id,
            f.completed_at, f.created_at,
            l.name AS location_name, l.loc_type AS loc_type
     FROM tenant.ff_inventory f
     LEFT JOIN tenant.stock_ff_locations l
       ON l.id = f.location_id AND l.cabinet_id = f.cabinet_id
     WHERE f.archived_at IS NULL
     ORDER BY f.created_at DESC`
  );

  // Список мест хранения (справочник) — для фильтра и выбора в строках.
  const locations = await tenantQuery(
    `SELECT id, name, address, loc_type FROM tenant.stock_ff_locations ORDER BY loc_type, name`
  );

  // Обогащение имени/фото из каталога МП (если артикул привязан) — богаче, чем
  // сохранённое sku_name. Один bulk-запрос на МП.
  const nmMeta = {}, pidMeta = {};
  const wbIds = [...new Set(rows.filter((r) => r.platform === "wb" && r.nm_id).map((r) => r.nm_id))];
  const ozIds = [...new Set(rows.filter((r) => r.platform === "ozon" && r.product_id).map((r) => r.product_id))];
  if (wbIds.length) {
    try {
      const db = new DatabaseSync("wb", { readOnly: true });
      const ph = wbIds.map(() => "?").join(",");
      for (const m of await db.prepare(`SELECT nm_id, name, im_url FROM articles WHERE nm_id IN (${ph})`).all(...wbIds)) {
        nmMeta[m.nm_id] = { name: m.name, im_url: m.im_url };
      }
    } catch {}
  }
  if (ozIds.length) {
    try {
      const db = new DatabaseSync("ozon", { readOnly: true });
      const ph = ozIds.map(() => "?").join(",");
      for (const m of await db.prepare(`SELECT product_id, name, im_url FROM products WHERE product_id IN (${ph})`).all(...ozIds)) {
        pidMeta[m.product_id] = { name: m.name, im_url: m.im_url };
      }
    } catch {}
  }

  let qtyTotal = 0, sumCost = 0, linked = 0;
  const items = rows.map((r) => {
    const meta = r.platform === "wb" ? nmMeta[r.nm_id] : (r.platform === "ozon" ? pidMeta[r.product_id] : null);
    const name = meta?.name || r.sku_name || r.internal_name || "—";
    const im = meta?.im_url || r.im_url || null;
    const qty = Number(r.qty) || 0;
    const cost = Number(r.unit_cost) || 0;
    qtyTotal += qty;
    sumCost += qty * cost;
    if (r.platform) linked++;
    return {
      ...r,
      qty,
      unit_cost: cost,
      sum: round2(qty * cost),
      sku_name: name,
      im_url: im,
    };
  });

  const totals = { items: items.length, qty: qtyTotal, sum: round2(sumCost), linked };
  return NextResponse.json({ items, totals, locations });
});

export const POST = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();

  // Ручное добавление позиции на склад (без связи с закупкой).
  // Поля: internal_name*, qty, unit_cost, category, im_url (загруженное фото).
  if (b.action === "add") {
    const internal_name = (b.internal_name || "").trim();
    if (!internal_name) return NextResponse.json({ error: "internal_name required" }, { status: 400 });
    const qty = Number(b.qty);
    const unit_cost = b.unit_cost === "" || b.unit_cost == null ? null : Number(b.unit_cost);
    if (!Number.isFinite(qty) || qty < 0) return NextResponse.json({ error: "qty must be >= 0" }, { status: 400 });
    if (unit_cost != null && (!Number.isFinite(unit_cost) || unit_cost < 0)) {
      return NextResponse.json({ error: "unit_cost must be >= 0" }, { status: 400 });
    }
    const rows = await tenantQuery(
      `INSERT INTO tenant.ff_inventory
         (cabinet_id, internal_name, qty, unit_cost, category, im_url, location_id)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6) RETURNING id`,
      [internal_name, Math.round(qty), unit_cost, (b.category || "").trim() || null, b.im_url || null,
       b.location_id ? Number(b.location_id) : null]
    );
    return NextResponse.json({ ok: true, id: rows[0]?.id });
  }

  // CRUD мест хранения (stock_ff_locations): add / rename / delete.
  // Без id (add) — поэтому этот блок ДО проверки id ниже.
  if (b.action === "locations") {
    const op = b.op;
    if (op === "add") {
      const name = (b.name || "").trim();
      if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
      const loc_type = b.loc_type === "ff" ? "ff" : "stock";
      const rows = await tenantQuery(
        `INSERT INTO tenant.stock_ff_locations (cabinet_id, name, address, loc_type)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3) RETURNING id`,
        [name, (b.address || "").trim() || null, loc_type]
      );
      return NextResponse.json({ ok: true, id: rows[0]?.id });
    }
    if (op === "rename") {
      const lid = Number(b.id);
      if (!lid) return NextResponse.json({ error: "id required" }, { status: 400 });
      const name = (b.name || "").trim();
      if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
      const sets = ["name = $1"];
      const vals = [name, lid];
      if (b.loc_type !== undefined) {
        sets.splice(0, 0, `loc_type = $${vals.length + 1}`);
        vals.push(b.loc_type === "ff" ? "ff" : "stock");
      }
      await tenantQuery(`UPDATE tenant.stock_ff_locations SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
      return NextResponse.json({ ok: true });
    }
    if (op === "delete") {
      const lid = Number(b.id);
      if (!lid) return NextResponse.json({ error: "id required" }, { status: 400 });
      // Отвязать позиции от удаляемого места, затем удалить место.
      await tenantQuery(`UPDATE tenant.ff_inventory SET location_id = NULL WHERE location_id = $1`, [lid]);
      await tenantQuery(`DELETE FROM tenant.stock_ff_locations WHERE id = $1`, [lid]);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: `unknown locations op: ${op}` }, { status: 400 });
  }

  const id = Number(b.id);
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  if (b.action === "link_sku") {
    const { platform, nm_id, product_id } = b;
    if (!platform || (platform !== "wb" && platform !== "ozon")) {
      return NextResponse.json({ error: "platform wb|ozon required" }, { status: 400 });
    }
    if (platform === "wb" && !nm_id) return NextResponse.json({ error: "nm_id required for wb" }, { status: 400 });
    if (platform === "ozon" && !product_id) return NextResponse.json({ error: "product_id required for ozon" }, { status: 400 });

    // Подтянуть имя/фото карточки из каталога МП (для отображения на складе).
    let skuName = null, imUrl = null;
    try {
      if (platform === "wb") {
        const db = new DatabaseSync("wb", { readOnly: true });
        const m = await db.prepare(`SELECT name, im_url FROM articles WHERE nm_id = ?`).get(Number(nm_id));
        if (m) { skuName = m.name; imUrl = m.im_url; }
      } else {
        const db = new DatabaseSync("ozon", { readOnly: true });
        const m = await db.prepare(`SELECT name, im_url FROM products WHERE product_id = ?`).get(Number(product_id));
        if (m) { skuName = m.name; imUrl = m.im_url; }
      }
    } catch {}

    // Записать привязку в строку остатка.
    const rows = await tenantQuery(
      `UPDATE tenant.ff_inventory
       SET platform = $1,
           nm_id = $2,
           product_id = $3,
           sku_name = $4,
           im_url = $5,
           updated_at = now()
       WHERE id = $6
       RETURNING unit_cost, completed_at`,
      [platform, platform === "wb" ? Number(nm_id) : null, platform === "ozon" ? Number(product_id) : null, skuName, imUrl, id]
    );
    if (!rows.length) return NextResponse.json({ error: `строка id=${id} не найдена` }, { status: 404 });

    // Создать/обновить cost_override → себестоимость потечёт в P&L/юнитку/mp-stock.
    const cost = rows[0].unit_cost;
    const effectiveFrom = rows[0].completed_at || new Date().toISOString().slice(0, 10);
    if (cost != null && cost > 0) {
      await upsertCostOverride({
        platform,
        nm_id: platform === "wb" ? Number(nm_id) : null,
        product_id: platform === "ozon" ? Number(product_id) : null,
        cost,
        effective_from: effectiveFrom,
        note: `со склада/ФФ (партия→${id})`,
      });
    }
    return NextResponse.json({ ok: true, sku_name: skuName, im_url: imUrl });
  }

  if (b.action === "unlink_sku") {
    await tenantQuery(
      `UPDATE tenant.ff_inventory
       SET platform = NULL, nm_id = NULL, product_id = NULL, sku_name = NULL, im_url = NULL, updated_at = now()
       WHERE id = $1`,
      [id]
    );
    // cost_override НЕ удаляем — он может быть нужен для истории расчётов.
    return NextResponse.json({ ok: true });
  }

  if (b.action === "update_qty") {
    const qty = Number(b.qty);
    if (!Number.isFinite(qty) || qty < 0) return NextResponse.json({ error: "qty must be >= 0" }, { status: 400 });
    await tenantQuery(`UPDATE tenant.ff_inventory SET qty = $1, updated_at = now() WHERE id = $2`, [Math.round(qty), id]);
    return NextResponse.json({ ok: true });
  }

  // Inline-правка поля строки: internal_name | category | unit_cost | im_url.
  // im_url правится только если артикул МП НЕ привязан (иначе фото тянется с МП —
  // не даём перетереть). unit_cost → при привязанном артикуле обновляем cost_override.
  if (b.action === "update_field") {
    const field = b.field;
    const allowed = { internal_name: 1, category: 1, unit_cost: 1, im_url: 1, location_id: 1 };
    if (!allowed[field]) return NextResponse.json({ error: "field not allowed" }, { status: 400 });
    const cur = (await tenantQuery(
      `SELECT platform, nm_id, product_id, unit_cost, completed_at FROM tenant.ff_inventory WHERE id = $1`, [id]
    ))[0];
    if (!cur) return NextResponse.json({ error: `строка id=${id} не найдена` }, { status: 404 });

    let val = b.value;
    if (field === "unit_cost") {
      val = val === "" || val == null ? null : Number(val);
      if (val != null && (!Number.isFinite(val) || val < 0)) return NextResponse.json({ error: "unit_cost must be >= 0" }, { status: 400 });
    } else if (field === "im_url") {
      // фото грузится только если нет привязки к МП (там фото тянется по API)
      if (cur.platform) return NextResponse.json({ error: "фото управляется маркетплейсом (артикул привязан)" }, { status: 400 });
      val = val || null;
    } else if (field === "location_id") {
      // ссылка на место хранения: число или null
      val = val === "" || val == null ? null : Number(val);
      if (val != null && !Number.isFinite(val)) return NextResponse.json({ error: "location_id must be number" }, { status: 400 });
    } else {
      val = (val || "").trim() || null;
    }
    await tenantQuery(
      `UPDATE tenant.ff_inventory SET ${field} = $1, updated_at = now() WHERE id = $2`,
      [val, id]
    );
    // unit_cost + привязанный артикул → обновляем cost_override.
    if (field === "unit_cost" && cur.platform && val != null && val > 0) {
      await upsertCostOverride({
        platform: cur.platform,
        nm_id: cur.platform === "wb" ? Number(cur.nm_id) : null,
        product_id: cur.platform === "ozon" ? Number(cur.product_id) : null,
        cost: val,
        effective_from: cur.completed_at || new Date().toISOString().slice(0, 10),
        note: `со склада/ФФ (правка себест.)`,
      });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: `unknown action: ${b.action}` }, { status: 400 });
}, { requireRole: 'manager' });
