// lib/shipmentDocs.js — документ отгрузки v2 (спека «Склады 2.0» §4.2–4.3).
//
// Жизненный цикл документа:
//   draft ──ship──► shipped ──приёмка──► accepted | partial | rejected
// Списание с ФФ происходит РОВНО один раз — при переходе в shipped (applyMove
// kind='out_fbo', src_kind='ff_shipment_doc', src_ref='<doc_id>:<line_id>'). Удалять
// можно только draft: у отгруженного документа откат — через adjust с комментарием.
//
// Факт приёмки берём из собранных данных МП:
//   • WB  — tenant.wb_incomes (FBO-приёмки statistics-api /supplier/incomes),
//           связь по income_id, mp_supply_kind='wb_income';
//   • Ozon — tenant.ozon_supply_orders (+ _items), связь по order_id,
//           mp_supply_kind='ozon_supply_order'.
// Принятое количество по строкам ни WB, ни Ozon через API не отдают (проверено 06.09),
// поэтому qty_accepted вводится руками; пока не введено, «приёмка закрыта» = accepted
// («расхождение не проверено»).
//
// Функции с БД принимают `tq` (tenantQuery) первым аргументом и возвращают
// { ok:false, status:400, error } на пользовательские ошибки — throw оставлен для
// настоящих сбоев БД. Причина: withCabinet КОММИТИТ транзакцию на любом возвращённом
// ответе и отдаёт 500 на throw, поэтому все проверки идут ДО первой записи.

// ── чистая часть (тестируется в lib/__tests__/shipmentDocs.test.mjs) ──────────

const num = (v) => (v == null || v === "" ? null : Number(v));
const sumBy = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);

// qty_accepted строки: поддерживаем и snake_case (из БД), и camelCase (из кода).
const accOf = (l) => {
  const v = l?.qty_accepted ?? l?.qtyAccepted;
  return v == null || v === "" ? null : Number(v);
};

/**
 * Флаги поставки МП для deriveStatus.
 * WB (`wb_income`): закрыта = заполнена date_close; отклонена = в тексте статуса
 *   (регистр не важен, ё→е) встречается «отклон» или «отмен» — WB отдаёт статус
 *   свободным текстом («Принято», «Отклонено», «Отменена продавцом»).
 * Ozon (`ozon_supply_order`): закрыта = state COMPLETED (в проде встречаются
 *   COMPLETED / CANCELLED / OVERDUE / DATA_FILLING / ACCEPTANCE_AT_STORAGE_WAREHOUSE);
 *   отклонена = в state есть CANCEL или REJECT. OVERDUE (просрочен таймслот) —
 *   ни закрыт, ни отклонён: документ остаётся shipped.
 * Отклонённая поставка НЕ считается закрытой.
 */
export function supplyFlags(supply) {
  if (!supply) return null;
  const kind = supply.kind;
  if (kind === "ozon_supply_order") {
    const state = String(supply.state ?? "").toUpperCase();
    const rejected = state.includes("CANCEL") || state.includes("REJECT");
    return { kind, closed: !rejected && state.includes("COMPLET"), rejected };
  }
  // wb_income (и всё неизвестное трактуем по-WBшному: закрыта = есть дата приёмки)
  const st = String(supply.status ?? "").toLowerCase().replace(/ё/g, "е");
  const rejected = st.includes("отклон") || st.includes("отмен");
  const closed = !rejected && !!supply.date_close;
  return { kind: kind || "wb_income", closed, rejected };
}

/**
 * Статус документа по строкам и факту приёмки.
 * @param {{status:string, lines:Array<{qty:number,qty_accepted?:number|null}>,
 *          supply:{kind:string,closed:boolean,rejected:boolean}|null}} arg
 * @returns {'draft'|'shipped'|'accepted'|'partial'|'rejected'}
 *
 * Правила (в порядке применения):
 *   1. draft остаётся draft (списания ещё не было — приёмки быть не может);
 *   2. поставка отклонена → rejected (важнее любых введённых количеств);
 *   3. qty_accepted введено У ВСЕХ строк → Σ принято < Σ отгружено ? partial : accepted
 *      (сверка руками работает и без связи с поставкой);
 *   4. поставка закрыта, количества не введены → accepted («расхождение не проверено»);
 *   5. иначе shipped.
 */
export function deriveStatus({ status, lines = [], supply = null } = {}) {
  const cur = status || "shipped";
  if (cur === "draft") return "draft";
  const flags = supply && (typeof supply.closed === "boolean" || typeof supply.rejected === "boolean")
    ? supply
    : supplyFlags(supply);
  if (flags?.rejected) return "rejected";
  const ls = Array.isArray(lines) ? lines : [];
  const allAccepted = ls.length > 0 && ls.every((l) => Number.isFinite(accOf(l)));
  if (allAccepted) {
    return sumBy(ls, accOf) < sumBy(ls, (l) => l.qty) ? "partial" : "accepted";
  }
  if (flags?.closed) return "accepted";
  return "shipped";
}

// Нормализация имени склада для сравнения: регистр, ё, подчёркивания/дефисы → пробел.
const whKey = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[\s_\-]+/g, " ").trim();

const dayOf = (v) => {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  const t = Date.parse(s.slice(0, 10));
  return Number.isFinite(t) ? t / 86400000 : null;
};

/**
 * Ранжирование кандидатов-поставок для документа (подсказка связи).
 * doc: { shipped_at|ship_dt, dest_warehouse_id, dest_warehouse, lines:[{qty}] }
 * candidates: [{ id, kind, date, warehouseKey, warehouseName, qty }]
 * Баллы: склад совпал (+2, по id либо по нормализованному имени), |дата − отгрузка|
 * ≤ 3 дней (+1), количество в пределах ±10 % от Σ строк (+1). Сортировка: балл ↓,
 * затем меньшая разница дат, затем исходный порядок. Кандидаты не мутируются.
 */
export function matchSupply(doc, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const docDay = dayOf(doc?.shipped_at || doc?.ship_dt);
  const docWhId = num(doc?.dest_warehouse_id);
  const docWhName = whKey(doc?.dest_warehouse);
  const docQty = sumBy(Array.isArray(doc?.lines) ? doc.lines : [], (l) => l.qty);
  return list
    .map((c, idx) => {
      let score = 0;
      const cWhId = num(c.warehouseKey);
      const whMatch = (docWhId != null && cWhId != null && docWhId === cWhId)
        || (!!docWhName && whKey(c.warehouseName) === docWhName);
      if (whMatch) score += 2;
      const cDay = dayOf(c.date);
      const dateDiff = docDay != null && cDay != null ? Math.abs(cDay - docDay) : null;
      if (dateDiff != null && dateDiff <= 3) score += 1;
      const cQty = Number(c.qty) || 0;
      if (docQty > 0 && cQty > 0 && Math.abs(cQty - docQty) <= docQty * 0.1) score += 1;
      return { ...c, score, dateDiffDays: dateDiff, idx };
    })
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const da = a.dateDiffDays == null ? Infinity : a.dateDiffDays;
      const db = b.dateDiffDays == null ? Infinity : b.dateDiffDays;
      if (da !== db) return da - db;
      return a.idx - b.idx;
    })
    .map(({ idx, ...rest }) => rest);
}

// ── часть с БД ───────────────────────────────────────────────────────────────

const err = (error) => ({ ok: false, status: 400, error });
export const SUPPLY_KINDS = ["wb_income", "ozon_supply_order"];

// applyMove тянем динамически: путь с алиасом «@/» резолвит только сборщик Next,
// а этот модуль импортируют и тесты через `node --test` (там алиаса нет). Импорт
// исполняется только при реальном списании, то есть в тестах никогда.
async function getApplyMove(injected) {
  if (injected) return injected;
  const mod = await import("@/lib/stockLedger.js");
  return mod.applyMove;
}

const dateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));

// Нормализация тела документа (чистая, без БД).
function normalizeDocInput({ platform, shipDt, lines, status, locationId, destWarehouseId }) {
  const pf = platform === "wb" ? "wb" : platform === "ozon" ? "ozon" : null;
  if (!pf) return err("platform wb|ozon required");
  const dt = String(shipDt ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) return err("ship_dt must be YYYY-MM-DD");
  const st = status == null || status === "" ? "shipped" : String(status);
  if (st !== "draft" && st !== "shipped") return err("status must be draft|shipped");
  const ls = Array.isArray(lines) ? lines : null;
  if (!ls || ls.length === 0) return err("нужна хотя бы одна строка товара");
  const norm = [];
  const seen = new Set();
  for (const [i, ln] of ls.entries()) {
    const ffId = Number(ln.ff_inventory_id ?? ln.ffInventoryId);
    const qty = Number(ln.qty);
    if (!Number.isInteger(ffId) || ffId <= 0) return err(`строка ${i + 1}: ff_inventory_id required`);
    if (!Number.isInteger(qty) || qty < 1) return err(`строка ${i + 1}: qty должно быть целым ≥ 1`);
    if (seen.has(ffId)) return err(`позиция id=${ffId} повторяется в составе`);
    seen.add(ffId);
    norm.push({ ff_inventory_id: ffId, qty });
  }
  for (const [name, v] of [["location_id", locationId], ["dest_warehouse_id", destWarehouseId]]) {
    if (v == null || v === "") continue;
    if (!Number.isInteger(Number(v)) || Number(v) <= 0) return err(`${name} must be a positive integer`);
  }
  return { ok: true, platform: pf, shipDt: dt, status: st, lines: norm };
}

// Предпроверка остатка ДО записи: строки блокируются FOR UPDATE по возрастанию id
// (одинаковый порядок блокировок у параллельных документов = нет дедлоков).
async function checkStock(tq, lines) {
  for (const n of [...lines].sort((a, b) => a.ff_inventory_id - b.ff_inventory_id)) {
    const row = (await tq(
      `SELECT qty FROM tenant.ff_inventory WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
      [n.ff_inventory_id]
    ))[0];
    if (!row || Number(row.qty) < n.qty) {
      return err(`недостаточно остатка для позиции id=${n.ff_inventory_id} (или строка не найдена)`);
    }
  }
  return { ok: true };
}

/** Создать документ (+ строки; при status='shipped' — списание с ФФ). */
export async function createShipmentDoc(tq, opts = {}) {
  const v = normalizeDocInput(opts);
  if (!v.ok) return v;
  const { platform, shipDt, status, lines } = v;
  if (status === "shipped") {
    const chk = await checkStock(tq, lines);
    if (!chk.ok) return chk;
  }
  const docNo = String(opts.docNo ?? "").trim() || null;
  const destWh = String(opts.destWarehouse ?? "").trim() || null;
  const note = String(opts.note ?? "").trim() || null;
  const locationId = opts.locationId == null || opts.locationId === "" ? null : Number(opts.locationId);
  const destWhId = opts.destWarehouseId == null || opts.destWarehouseId === "" ? null : Number(opts.destWarehouseId);

  const docIns = await tq(
    `INSERT INTO tenant.ff_shipment_docs
       (cabinet_id, doc_no, platform, ship_dt, dest_warehouse, note, location_id, dest_warehouse_id, status, shipped_at)
     VALUES (current_setting('app.cabinet_id')::bigint, $1, $2, $3, $4, $5, $6, $7, $8,
             CASE WHEN $8 = 'shipped' THEN now() ELSE NULL END)
     RETURNING id`,
    [docNo, platform, shipDt, destWh, note, locationId, destWhId, status]
  );
  const docId = docIns[0]?.id;
  if (!docId) throw new Error("не удалось создать документ отгрузки");

  const valuesSql = lines
    .map((_, i) => `(current_setting('app.cabinet_id')::bigint, $1, $${i * 2 + 2}, $${i * 2 + 3})`)
    .join(", ");
  const lineRows = await tq(
    `INSERT INTO tenant.ff_shipment_lines (cabinet_id, doc_id, ff_inventory_id, qty)
     VALUES ${valuesSql}
     RETURNING id, ff_inventory_id, qty`,
    [docId, ...lines.flatMap((n) => [n.ff_inventory_id, n.qty])]
  );

  if (status === "shipped") {
    const applyMove = await getApplyMove(opts.applyMove);
    for (const ln of lineRows) {
      await applyMove({
        ffInventoryId: ln.ff_inventory_id, kind: "out_fbo", qty: Number(ln.qty),
        srcKind: "ff_shipment_doc", srcRef: `${docId}:${ln.id}`, movedAt: shipDt, userId: opts.userId ?? null,
      });
    }
  }
  return { ok: true, id: docId, status };
}

/** draft → shipped: та же предпроверка и списание, что при создании. */
export async function shipDoc(tq, { id, userId = null, applyMove: injected = null } = {}) {
  const docId = Number(id);
  if (!Number.isInteger(docId) || docId <= 0) return err("id (doc_id) required");
  const doc = (await tq(
    `SELECT id, ship_dt, status FROM tenant.ff_shipment_docs WHERE id = $1 FOR UPDATE`, [docId]
  ))[0];
  if (!doc) return err("документ не найден");
  if (doc.status !== "draft") return err(`документ уже отгружен (статус ${doc.status})`);
  const lines = await tq(
    `SELECT id, ff_inventory_id, qty FROM tenant.ff_shipment_lines WHERE doc_id = $1 ORDER BY id`, [docId]
  );
  if (!lines.length) return err("в документе нет строк");
  const chk = await checkStock(tq, lines.map((l) => ({ ff_inventory_id: Number(l.ff_inventory_id), qty: Number(l.qty) })));
  if (!chk.ok) return chk;

  await tq(`UPDATE tenant.ff_shipment_docs SET status = 'shipped', shipped_at = now() WHERE id = $1`, [docId]);
  const applyMove = await getApplyMove(injected);
  for (const ln of lines) {
    await applyMove({
      ffInventoryId: Number(ln.ff_inventory_id), kind: "out_fbo", qty: Number(ln.qty),
      srcKind: "ff_shipment_doc", srcRef: `${docId}:${ln.id}`, movedAt: dateStr(doc.ship_dt), userId,
    });
  }
  return { ok: true, id: docId, status: "shipped" };
}

// Поставка МП по ключу связи. Возвращает объект витрины (см. README роута) или null.
export async function loadSupply(tq, { kind, id }) {
  if (!SUPPLY_KINDS.includes(kind) || id == null || id === "") return null;
  if (kind === "wb_income") {
    const rows = await tq(
      `SELECT nm_id, SUM(quantity)::int AS qty, MIN(number) AS number, MIN(date) AS date,
              MAX(date_close) AS date_close, MAX(warehouse_name) AS warehouse_name, MAX(status) AS status
       FROM tenant.wb_incomes WHERE income_id = $1::bigint GROUP BY nm_id`,
      [String(id)]
    );
    if (!rows.length) return null;
    const linesByNm = {};
    let qty = 0;
    for (const r of rows) { linesByNm[r.nm_id] = Number(r.qty) || 0; qty += Number(r.qty) || 0; }
    const f = rows[0];
    return {
      kind, id: String(id), number: f.number, date: f.date, date_close: f.date_close,
      warehouse_name: f.warehouse_name, status: f.status, qty, lines_by_nm: linesByNm,
    };
  }
  const row = (await tq(
    `SELECT o.order_id::text AS id, o.number, o.state, o.created_at, o.dest_warehouse_id, o.dest_warehouse_name,
            COALESCE((SELECT SUM(i.qty_declared) FROM tenant.ozon_supply_order_items i
                       WHERE i.cabinet_id = o.cabinet_id AND i.order_id = o.order_id), 0)::int AS qty
     FROM tenant.ozon_supply_orders o WHERE o.order_id = $1::bigint`,
    [String(id)]
  ))[0];
  if (!row) return null;
  return {
    kind, id: row.id, number: row.number, state: row.state, date: row.created_at,
    warehouse_id: row.dest_warehouse_id, warehouse_name: row.dest_warehouse_name, qty: row.qty,
  };
}

/** Кандидаты для подсказок связи: приёмки/поставки за последние `days` дней. */
export async function loadSupplyCandidates(tq, { platform, days = 60 }) {
  const d = Number(days) || 60;
  if (platform === "wb") {
    const rows = await tq(
      `SELECT i.income_id::text AS id, MIN(i.number) AS number, MIN(i.date) AS date,
              MAX(i.date_close) AS date_close, MAX(i.warehouse_name) AS warehouse_name,
              SUM(i.quantity)::int AS qty, MAX(i.status) AS status,
              MAX(w.id) AS warehouse_id
       FROM tenant.wb_incomes i
       LEFT JOIN shared.wb_warehouses w
         ON lower(w.name) = lower(i.warehouse_name)
       WHERE i.date >= CURRENT_DATE - $1::int
       GROUP BY i.income_id
       ORDER BY MIN(i.date) DESC
       LIMIT 300`,
      [d]
    );
    return rows.map((r) => ({
      id: r.id, kind: "wb_income", number: r.number, date: r.date, date_close: r.date_close,
      warehouseKey: r.warehouse_id, warehouseName: r.warehouse_name, qty: r.qty, status: r.status,
    }));
  }
  const rows = await tq(
    `SELECT o.order_id::text AS id, o.number, o.state, o.created_at::date AS date,
            o.dest_warehouse_id, o.dest_warehouse_name,
            COALESCE(SUM(i.qty_declared), 0)::int AS qty
     FROM tenant.ozon_supply_orders o
     LEFT JOIN tenant.ozon_supply_order_items i
       ON i.cabinet_id = o.cabinet_id AND i.order_id = o.order_id
     WHERE o.created_at >= now() - make_interval(days => $1::int)
     GROUP BY o.order_id, o.number, o.state, o.created_at, o.dest_warehouse_id, o.dest_warehouse_name
     ORDER BY o.created_at DESC
     LIMIT 300`,
    [d]
  );
  return rows.map((r) => ({
    id: r.id, kind: "ozon_supply_order", number: r.number, state: r.state, date: r.date,
    warehouseKey: r.dest_warehouse_id, warehouseName: r.dest_warehouse_name, qty: r.qty,
  }));
}

// Пересчёт статуса документа по строкам и связанной поставке. Возвращает новый статус.
async function recalcStatus(tq, docId, doc) {
  const lines = await tq(
    `SELECT qty, qty_accepted FROM tenant.ff_shipment_lines WHERE doc_id = $1`, [docId]
  );
  const supply = doc.mp_supply_id
    ? await loadSupply(tq, { kind: doc.mp_supply_kind, id: doc.mp_supply_id })
    : null;
  const next = deriveStatus({ status: doc.status, lines, supply: supplyFlags(supply) });
  if (next !== doc.status) {
    await tq(`UPDATE tenant.ff_shipment_docs SET status = $2 WHERE id = $1`, [docId, next]);
  }
  return next;
}

/** Связать документ с поставкой МП (или снять связь пустым mpSupplyId). */
export async function linkSupply(tq, { id, mpSupplyId, kind } = {}) {
  const docId = Number(id);
  if (!Number.isInteger(docId) || docId <= 0) return err("id (doc_id) required");
  const supplyId = mpSupplyId == null ? "" : String(mpSupplyId).trim();
  if (supplyId && !SUPPLY_KINDS.includes(kind)) return err(`kind must be ${SUPPLY_KINDS.join("|")}`);
  if (supplyId && !/^\d+$/.test(supplyId)) return err("mp_supply_id: ожидается число (income_id / order_id)");
  const doc = (await tq(
    `SELECT id, status, mp_supply_id, mp_supply_kind FROM tenant.ff_shipment_docs WHERE id = $1`, [docId]
  ))[0];
  if (!doc) return err("документ не найден");
  let supply = null;
  if (supplyId) {
    supply = await loadSupply(tq, { kind, id: supplyId });
    if (!supply) return err(`поставка ${kind} №${supplyId} не найдена в собранных данных`);
  }
  await tq(
    `UPDATE tenant.ff_shipment_docs SET mp_supply_id = $2, mp_supply_kind = $3 WHERE id = $1`,
    [docId, supplyId || null, supplyId ? kind : null]
  );
  const status = await recalcStatus(tq, docId, {
    status: doc.status, mp_supply_id: supplyId || null, mp_supply_kind: supplyId ? kind : null,
  });
  return { ok: true, id: docId, status, supply };
}

/** Приёмка: qty_accepted по строкам + пересчёт статуса. accepted:[{lineId, qtyAccepted}] */
export async function acceptDoc(tq, { id, accepted } = {}) {
  const docId = Number(id);
  if (!Number.isInteger(docId) || docId <= 0) return err("id (doc_id) required");
  const rows = Array.isArray(accepted) ? accepted : null;
  if (!rows || !rows.length) return err("нужна хотя бы одна строка приёмки");
  const doc = (await tq(
    `SELECT id, status, mp_supply_id, mp_supply_kind FROM tenant.ff_shipment_docs WHERE id = $1`, [docId]
  ))[0];
  if (!doc) return err("документ не найден");
  if (doc.status === "draft") return err("черновик нельзя принять: сначала отгрузите документ");

  const own = await tq(`SELECT id FROM tenant.ff_shipment_lines WHERE doc_id = $1`, [docId]);
  const ownIds = new Set(own.map((r) => Number(r.id)));
  const norm = [];
  for (const [i, r] of rows.entries()) {
    const lineId = Number(r.lineId ?? r.line_id);
    if (!Number.isInteger(lineId) || !ownIds.has(lineId)) {
      return err(`строка ${i + 1}: line_id=${r.lineId ?? r.line_id} не принадлежит документу №${docId}`);
    }
    const raw = r.qtyAccepted ?? r.qty_accepted;
    if (raw === null || raw === "" || raw === undefined) { norm.push({ lineId, qty: null }); continue; }
    const q = Number(raw);
    if (!Number.isInteger(q) || q < 0) return err(`строка ${i + 1}: qty_accepted должно быть целым ≥ 0 или пустым`);
    norm.push({ lineId, qty: q });
  }

  for (const n of norm) {
    await tq(`UPDATE tenant.ff_shipment_lines SET qty_accepted = $2 WHERE id = $1 AND doc_id = $3`,
      [n.lineId, n.qty, docId]);
  }
  const status = await recalcStatus(tq, docId, doc);
  return { ok: true, id: docId, status };
}
