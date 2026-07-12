// =====================================================================
//  lib/postToDds.js — хелпер «записать в ДДС» из смежных страниц (2026-06-27).
//
//  ДДС = фиксация движений, формируется из правок баланса/закупок/OPEX.
//  Эта функция — точка входа для кнопок «↧ В ДДС» на трёх страницах.
//  Создаёт ОДНУ строку в dds_movements с пометкой source + reference
//  (для дедупликации: если movement с тем же reference уже есть — обновляет).
//
//  Контракт: postToDds({ date, type, amount, category, source, reference,
//    description?, counterparty?, status? }) → { ok, id, created }.
// =====================================================================

export async function postToDds({
  date,
  type,            // "income" | "expense"
  amount,
  category,
  source,          // "auto_balance" | "auto_purchase" | "auto_opex"
  reference,       // напр. "balance:2026-06-25", "purchase:52", "opex:3"
  description = null,
  counterparty = null,
  status = "planned",  // "planned" (черновик) по умолчанию
}) {
  // Сначала проверим, есть ли уже movement с этим reference → тогда update.
  const checkRes = await fetch(`/api/dds?date_from=2000-01-01&date_to=2099-12-31&source=${source}`);
  const checkData = await checkRes.json();
  const existing = (checkData.items || []).find((it) => it.reference === reference);
  const body = {
    date, type, amount: Math.abs(Number(amount)), category, counterparty, description,
    status, source, reference,
  };
  if (existing) body.id = existing.id;
  const r = await fetch("/api/dds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
