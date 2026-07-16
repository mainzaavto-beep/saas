// /api/cabinets/[id]/inventory — остатки склада/ФФ (маршрут: закупка → завершить → склад).
//
// GET → { items, totals, locations, shipments }
//   items: наименование, qty, себест. (unit_cost = «себест. до МП»), сумма (qty×unit_cost),
//          категория, привязанный артикул МП (platform/nm_id/product_id/sku_name/im_url).
//          Если артикул привязан — имя/фото подтягиваются из wb_articles/ozon_products
//          (богаче, чем сохранённое при привязке).
//   shipments: последние 50 отгрузок (журнал списаний на МП) — дата/товар/qty/МП/примечание.
// POST { action } → add | locations | shipment | link_sku | unlink_sku | update_qty | update_field
//
// Привязка артикула (link_sku) — только для отображения имени/фото на складе.
// ⚠ unit_cost НЕ утекает в cost_overrides (решение 2026-07-16): складская
// себестоимость — внутренняя цифра партии (для баланса склада), независима от
// страницы «Себестоимость» (/items). Общая себестоимость для P&L/юнитки
// заводится отдельно на /items.
import { NextResponse } from "next/server";
import { tenantQuery, DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

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

  // Журнал отгрузок (для секции «История отгрузок» снизу страницы). JOIN с
  // ff_inventory для имени товара; строки с удалённым товаром тоже покажем
  // (LEFT JOIN) — чтобы не потерять историю, но item_name может быть «(удалён)».
  const shipments = await tenantQuery(
    `SELECT s.id, s.ff_inventory_id, s.qty, s.platform, s.ship_dt, s.note,
            s.created_at,
            COALESCE(f.internal_name, f.sku_name, '(скрыто)') AS item_name
     FROM tenant.ff_shipments s
     LEFT JOIN tenant.ff_inventory f ON f.id = s.ff_inventory_id AND f.cabinet_id = s.cabinet_id
     ORDER BY s.ship_dt DESC, s.id DESC
     LIMIT 50`
  );

  return NextResponse.json({ items, totals, locations, shipments });
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

  // Отгрузка со склада/ФФ на маркетплейс (списание): add / delete.
  // Без id позиции не требуется для add (нужен ff_inventory_id), поэтому блок
  // ДО общей проверки id. Атомарность: INSERT отгрузки + UPDATE остатка в одной
  // tenant-транзакции (withTenant). Нельзя списать больше, чем есть в остатке.
  if (b.action === "shipment") {
    const op = b.op;
    if (op === "add") {
      const ffId = Number(b.ff_inventory_id);
      const qty = Number(b.qty);
      const platform = b.platform === "wb" ? "wb" : b.platform === "ozon" ? "ozon" : null;
      const shipDt = (b.ship_dt || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      if (!ffId) return NextResponse.json({ error: "ff_inventory_id required" }, { status: 400 });
      if (!platform) return NextResponse.json({ error: "platform wb|ozon required" }, { status: 400 });
      if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
        return NextResponse.json({ error: "qty must be integer >= 1" }, { status: 400 });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(shipDt)) {
        return NextResponse.json({ error: "ship_dt must be YYYY-MM-DD" }, { status: 400 });
      }
      // Проверка остатка атомарно с обновлением: WHERE qty >= $qty гарантирует,
      // что нельзя списать больше имеющегося (0 строк затронуто → ошибка).
      const upd = await tenantQuery(
        `UPDATE tenant.ff_inventory
         SET qty = qty - $1, updated_at = now()
         WHERE id = $2 AND qty >= $1
         RETURNING qty`,
        [qty, ffId]
      );
      if (!upd.length) {
        return NextResponse.json({ error: "недостаточно остатка (или строка не найдена)" }, { status: 400 });
      }
      await tenantQuery(
        `INSERT INTO tenant.ff_shipments (cabinet_id, ff_inventory_id, qty, platform, ship_dt, note)
         VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5)
         RETURNING id`,
        [ffId, qty, platform, shipDt, (b.note || "").trim() || null]
      );
      return NextResponse.json({ ok: true, op: "add", new_qty: upd[0].qty });
    }
    if (op === "delete") {
      const sid = Number(b.id);
      if (!sid) return NextResponse.json({ error: "id (отгрузки) required" }, { status: 400 });
      // Прочитать отгрузку → вернуть qty в остаток → удалить отгрузку.
      const rows = await tenantQuery(
        `SELECT ff_inventory_id, qty FROM tenant.ff_shipments WHERE id = $1`,
        [sid]
      );
      if (!rows.length) return NextResponse.json({ error: "отгрузка не найдена" }, { status: 404 });
      const { ff_inventory_id, qty } = rows[0];
      await tenantQuery(
        `UPDATE tenant.ff_inventory SET qty = qty + $1, updated_at = now() WHERE id = $2`,
        [qty, ff_inventory_id]
      );
      await tenantQuery(`DELETE FROM tenant.ff_shipments WHERE id = $1`, [sid]);
      return NextResponse.json({ ok: true, op: "delete", restored_qty: qty });
    }
    return NextResponse.json({ error: `unknown shipment op: ${op}` }, { status: 400 });
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

    // ⚠ cost_override НЕ пишем (решение 2026-07-16): складская unit_cost — это
    // внутренняя цифра партии (для баланса склада), она НЕ должна утекать в общую
    // себестоимость. Себестоимость для P&L/юнитки/Сводки заводится ОТДЕЛЬНО на
    // странице «Себестоимость» (/items). Склад и items — независимы.
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
    // ⚠ cost_override НЕ пишем (решение 2026-07-16): правка unit_cost на складе
    // меняет только складскую цифру (для баланса), не общую себестоимость.
    // См. комментарий в link_sku выше.
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: `unknown action: ${b.action}` }, { status: 400 });
}, { requireRole: 'manager' });
