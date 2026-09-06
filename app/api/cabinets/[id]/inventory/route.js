// /api/cabinets/[id]/inventory — остатки склада/ФФ (маршрут: закупка → завершить → склад).
//
// GET → { items, totals, locations, shipments }
//   items: наименование, qty, себест. (unit_cost = «себест. до МП»), сумма (qty×unit_cost),
//          категория, привязанные артикулы МП. С 2026-07-18 у одной позиции может быть
//          НЕСКОЛЬКО артикулов (разные МП, разные nm_id/product_id) — они в массиве
//          skus: [{ id (sku_link_id), platform, nm_id, product_id, sku_name, im_url, created_at }, ...].
//          Порядок — по created_at ASC: первичный (primary, для имени/фото строки) = первый.
//          Плоские поля platform/nm_id/product_id/sku_name/im_url (от primary) оставлены
//          для обратной совместимости с любым кодом, читающим it.platform.
//          Имя/фото тянется из wb.articles/ozon.products (богаче кэша) одним bulk-запросом.
//   shipments: последние 50 отгрузок (журнал списаний на МП) — дата/товар/qty/МП/примечание.
// POST { action } → add | locations | shipment | link_sku | unlink_sku | update_qty | update_field
//
// Привязка артикулов (link_sku) — только для отображения имени/фото на складе.
// ⚠ unit_cost НЕ утекает в cost_overrides (решение 2026-07-16): складская
// себестоимость — внутренняя цифра партии (для баланса склада), независима от
// страницы «Себестоимость» (/items). Общая себестоимость для P&L/юнитки
// заводится отдельно на /items. Мультисвязка (2026-07-18) этот контракт не меняет.
import { NextResponse } from "next/server";
import { tenantQuery, DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { normalizeLocationUpdate } from "@/lib/locationsLink.js";

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
    `SELECT id, name, address, loc_type, wb_warehouse_id, ozon_warehouse_id, city, is_active
     FROM tenant.stock_ff_locations ORDER BY loc_type, name`
  );
  // Склады продавца на МП (mp_seller_warehouses, тик references) + к какому месту привязан.
  const sellerWarehouses = await tenantQuery(
    `SELECT w.platform, w.warehouse_id, w.name, w.kind, w.is_active,
            l.id AS location_id
     FROM tenant.mp_seller_warehouses w
     LEFT JOIN tenant.stock_ff_locations l
       ON l.cabinet_id = w.cabinet_id
      AND ((w.platform = 'wb' AND l.wb_warehouse_id = w.warehouse_id)
        OR (w.platform = 'ozon' AND l.ozon_warehouse_id = w.warehouse_id))
     ORDER BY w.platform, w.name`
  );

  // Привязки артикулов МП (с 2026-07-18 — мультисвязка): одна позиция ↔ много SKU.
  // Тянем все разом и группируем по ff_inventory_id. Порядок по created_at ASC,
  // primary (для имени/фото строки) = первый.
  const invIds = rows.map((r) => r.id);
  const skusByInv = {};
  if (invIds.length) {
    const skuRows = await tenantQuery(
      `SELECT id, ff_inventory_id, platform, nm_id, product_id, sku_name, im_url, created_at
       FROM tenant.ff_inventory_skus
       WHERE ff_inventory_id = ANY($1::bigint[])
       ORDER BY ff_inventory_id, created_at ASC, id ASC`,
      [invIds]
    );
    for (const s of skuRows) {
      const key = s.ff_inventory_id;
      (skusByInv[key] ||= []).push({
        id: s.id,
        platform: s.platform,
        nm_id: s.nm_id,
        product_id: s.product_id,
        sku_name: s.sku_name,
        im_url: s.im_url,
        created_at: s.created_at,
      });
    }
  }

  // Обогащение имени/фото из каталога МП (по всем привязанным артикулам сразу) —
  // богаче, чем кэш sku_name/im_url в ff_inventory_skus. Один bulk-запрос на МП.
  const nmMeta = {}, pidMeta = {};
  const wbIds = [...new Set(
    Object.values(skusByInv).flat().filter((s) => s.platform === "wb" && s.nm_id).map((s) => s.nm_id)
  )];
  const ozIds = [...new Set(
    Object.values(skusByInv).flat().filter((s) => s.platform === "ozon" && s.product_id).map((s) => s.product_id)
  )];
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
    // Массив привязок (с обогащёнными именем/фото из каталога МП).
    const rawSkus = skusByInv[r.id] || [];
    const skus = rawSkus.map((s) => {
      const meta = s.platform === "wb" ? nmMeta[s.nm_id] : (s.platform === "ozon" ? pidMeta[s.product_id] : null);
      return {
        ...s,
        sku_name: meta?.name || s.sku_name || null,
        im_url: meta?.im_url || s.im_url || null,
      };
    });
    const primary = skus[0] || null;
    // Плоские поля (от primary) — обратная совместимость для it.platform/it.nm_id/...
    // Если новой привязки нет, но есть legacy-колонки в строке (edge-case бэкпорта) — fallback.
    const flatPlatform = primary?.platform || (r.platform ? r.platform : null);
    const flatNmId = primary?.nm_id ?? (r.platform === "wb" ? r.nm_id : null);
    const flatPid = primary?.product_id ?? (r.platform === "ozon" ? r.product_id : null);
    const flatName = primary?.sku_name || r.sku_name || r.internal_name || "—";
    const flatIm = primary?.im_url || r.im_url || null;
    const qty = Number(r.qty) || 0;
    const cost = Number(r.unit_cost) || 0;
    qtyTotal += qty;
    sumCost += qty * cost;
    if (skus.length > 0) linked++;
    return {
      ...r,
      qty,
      unit_cost: cost,
      sum: round2(qty * cost),
      platform: flatPlatform,
      nm_id: flatNmId,
      product_id: flatPid,
      sku_name: flatName,
      im_url: flatIm,
      skus,
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

  return NextResponse.json({ items, totals, locations, sellerWarehouses, shipments });
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
    if (op === "update") {
      const lid = Number(b.id);
      if (!lid) return NextResponse.json({ error: "id required" }, { status: 400 });
      const n = normalizeLocationUpdate(b);
      if (!n.ok) return NextResponse.json({ error: n.error }, { status: 400 });
      try {
        await tenantQuery(
          `UPDATE tenant.stock_ff_locations SET ${n.sets.join(", ")} WHERE id = $${n.vals.length + 1}`,
          [...n.vals, lid]
        );
      } catch (e) {
        // После неудачного UPDATE withTenant-транзакция уже aborted — handler обязан
        // вернуть ответ немедленно (return ниже), без дальнейших запросов в этой транзакции.
        if (String(e?.code) === "23505") {
          return NextResponse.json({ error: "склад уже привязан к другому месту" }, { status: 409 });
        }
        throw e;
      }
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

    // Проверка существования позиции склада (RLS режет по cabinet_id).
    const inv = (await tenantQuery(
      `SELECT id FROM tenant.ff_inventory WHERE id = $1 AND archived_at IS NULL`, [id]
    ))[0];
    if (!inv) return NextResponse.json({ error: `строка id=${id} не найдена` }, { status: 404 });

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

    // Записать привязку в таблицу-связку (с 2026-07-18 — мультисвязка).
    // Идемпотентно: повторная привязка того же (platform, nm_id|product_id) к той же
    // позиции не дублирует (ON CONFLICT DO NOTHING без указания целевых колонок —
    // срабатывает по подходящему partial unique index: uq_ff_inventory_skus_wb /
    // uq_ff_inventory_skus_ozon). Уникальность — частичные индексы по платформе
    // (WB по nm_id, Ozon по product_id), т.к. NULL-колонка в обычном UNIQUE не ловит
    // дубликаты (NULL != NULL в PG).
    const nmVal = platform === "wb" ? Number(nm_id) : null;
    const pidVal = platform === "ozon" ? Number(product_id) : null;
    const ins = await tenantQuery(
      `INSERT INTO tenant.ff_inventory_skus
         (cabinet_id, ff_inventory_id, platform, nm_id, product_id, sku_name, im_url)
       VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [id, platform, nmVal, pidVal, skuName, imUrl]
    );
    // ON CONFLICT вернёт 0 строк, если привязка уже была — это не ошибка (идемпотентность).
    const skuLinkId = ins[0]?.id || null;

    // ⚠ cost_override НЕ пишем (решение 2026-07-16): складская unit_cost — это
    // внутренняя цифра партии (для баланса склада), она НЕ должна утекать в общую
    // себестоимость. Себестоимость для P&L/юнитки/Сводки заводится ОТДЕЛЬНО на
    // странице «Себестоимость» (/items). Склад и items — независимы.
    // Мультисвязка (2026-07-18) этот контракт сохраняет: привязка = только имя/фото.
    return NextResponse.json({ ok: true, sku_link_id: skuLinkId, sku_name: skuName, im_url: imUrl });
  }

  if (b.action === "unlink_sku") {
    // С 2026-07-18 отвязка работает с конкретной связью (sku_link_id) в ff_inventory_skus.
    // Back-compat: если пришёл только id (ff_inventory_id) без sku_link_id — удаляем
    // ВСЕ привязки позиции (поведение старого unlink_sku). Это нужно старым клиентам
    // и предотвращает краш, если где-то остался старый вызов.
    if (b.sku_link_id) {
      await tenantQuery(
        `DELETE FROM tenant.ff_inventory_skus WHERE id = $1`, [Number(b.sku_link_id)]
      );
    } else {
      await tenantQuery(
        `DELETE FROM tenant.ff_inventory_skus WHERE ff_inventory_id = $1`, [id]
      );
      console.warn(`[inventory] unlink_sku вызван без sku_link_id для ff_inventory_id=${id} — удалены все привязки (back-compat)`);
    }
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
  // im_url правится только если у позиции НЕТ привязок к МП (если есть — фото
  // тянется с МП для primary; не даём перетереть). cost_override НЕ пишем (2026-07-16).
  if (b.action === "update_field") {
    const field = b.field;
    const allowed = { internal_name: 1, category: 1, unit_cost: 1, im_url: 1, location_id: 1 };
    if (!allowed[field]) return NextResponse.json({ error: "field not allowed" }, { status: 400 });
    const cur = (await tenantQuery(
      `SELECT id, unit_cost FROM tenant.ff_inventory WHERE id = $1`, [id]
    ))[0];
    if (!cur) return NextResponse.json({ error: `строка id=${id} не найдена` }, { status: 404 });

    let val = b.value;
    if (field === "unit_cost") {
      val = val === "" || val == null ? null : Number(val);
      if (val != null && (!Number.isFinite(val) || val < 0)) return NextResponse.json({ error: "unit_cost must be >= 0" }, { status: 400 });
    } else if (field === "im_url") {
      // фото грузится только если нет привязок к МП (там фото тянется по API).
      // С 2026-07-18 проверяем наличие привязок в ff_inventory_skus (мультисвязка).
      const hasLink = (await tenantQuery(
        `SELECT 1 FROM tenant.ff_inventory_skus WHERE ff_inventory_id = $1 LIMIT 1`, [id]
      )).length > 0;
      if (hasLink) return NextResponse.json({ error: "фото управляется маркетплейсом (артикул привязан)" }, { status: 400 });
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
