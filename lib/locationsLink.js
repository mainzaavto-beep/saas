// lib/locationsLink.js — валидация правки места хранения (привязка складов МП,
// город, активность). Чистая функция: тело запроса → SET-фрагменты для UPDATE
// tenant.stock_ff_locations. Спека «Склады 2.0» §1.1.
const ID_FIELDS = ["wb_warehouse_id", "ozon_warehouse_id"];

export function normalizeLocationUpdate(body) {
  const sets = [];
  const vals = [];
  const push = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  for (const f of ID_FIELDS) {
    if (!(f in body)) continue;
    const raw = body[f];
    if (raw === null || raw === "") { push(f, null); continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `${f} must be a number or null` };
    push(f, n);
  }
  if ("city" in body) {
    const c = String(body.city ?? "").trim();
    push("city", c || null);
  }
  if ("is_active" in body) push("is_active", Boolean(body.is_active));
  if (!sets.length) return { ok: false, error: "nothing to update" };
  return { ok: true, sets, vals };
}
