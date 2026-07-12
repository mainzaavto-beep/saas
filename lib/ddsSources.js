// =====================================================================
//  lib/ddsSources.js — источники авто-черновика ДДС (2026-06-27).
//
//  Чистые функции чтения (RO) 4 источников для предпросмотра черновика
//  движения денежных средств. НЕ пишут в БД — это делает /api/dds/draft POST.
//  Паттерн: lib/mpStockValue.js (локальные синглтон-фабрики RO-соединений).
//
//  Источники:
//   1. WB поступления   → wb_data.db.finance_report (rr_dt + ppvz_for_pay)
//   2. Ozon поступления → ozon_data.db.finance_report (operation_dt + payout_amount, net)
//   3. Налоги           → расчёт УСН 6% + НДС 5% от выручки WB+Ozon месяца
//                         (tax_calendar пуст → считаем сами, владелец подтвердит)
//   4. Оплаты закупок   → fin_data.db.purchases (qty*unit_cost − prepay, RO;
//                         страницу /finance/purchases НЕ ТРОГАЕМ — только чтение)
//   5. Регулярные OPEX  → fin_data.db.opex (status='active')
//
//  round2 везде: Math.round(n*100)/100.
// =====================================================================


const WB_DB = process.env.WB_DB_PATH || "/opt/agentsDB/wb_data.db";
const OZON_DB = process.env.OZON_DB_PATH || "/opt/agentsDB/ozon_data.db";

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function dateToIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
async function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return dateToIso(dt);
}

// ---------------- (1) WB поступления ----------------

/** {date: amount} дневных поступлений WB за [from,to] (ppvz_for_pay<>0). */
export async function wbPayouts(from, to) {
  const out = {};
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return out;
  let db = null;
  try {
    db = new DatabaseSync(WB_DB, { readOnly: true });
    const rows = await db
      .prepare(
        `SELECT rr_dt AS d, ROUND(SUM(ppvz_for_pay), 2) AS amt
         FROM finance_report
         WHERE ppvz_for_pay <> 0 AND rr_dt >= ? AND rr_dt <= ?
         GROUP BY rr_dt ORDER BY rr_dt`
      )
      .all(from, to);
    for (const r of rows) out[r.d] = round2(r.amt);
  } catch {
    /* БД недоступна → пусто */
  } finally {
    if (db) db.close();
  }
  return out;
}

// ---------------- (2) Ozon поступления ----------------

/** {date: amount} дневных net-поступлений Ozon за [from,to]. */
export async function ozonPayouts(from, to) {
  const out = {};
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return out;
  let db = null;
  try {
    db = new DatabaseSync(OZON_DB, { readOnly: true });
    const rows = await db
      .prepare(
        `SELECT date(operation_dt) AS d, ROUND(SUM(payout_amount), 2) AS amt
         FROM finance_report
         WHERE operation_dt IS NOT NULL
           AND date(operation_dt) >= ? AND date(operation_dt) <= ?
         GROUP BY date(operation_dt) ORDER BY date(operation_dt)`
      )
      .all(from, to);
    for (const r of rows) out[r.d] = round2(r.amt);
  } catch {
    /* БД недоступна → пусто */
  } finally {
    if (db) db.close();
  }
  return out;
}

// ---------------- (3) Налоги (УСН 6% + НДС 5%) ----------------

/** {period: revenue} выручки WB+Ozon по месяцам YYYY-MM за [from,to].
 *  WB: SUM(retail_amount WHERE >0). Ozon: SUM(sale_amount WHERE 'Доставка покупателю'). */
async function revenueByMonth(from, to) {
  const out = {};
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return out;
  // WB
  try {
    const wb = new DatabaseSync(WB_DB, { readOnly: true });
    try {
      const rows = wb
        .prepare(
          `SELECT substr(rr_dt,1,7) AS ym,
                  SUM(CASE WHEN retail_amount > 0 THEN retail_amount ELSE 0 END) AS rev
           FROM finance_report
           WHERE rr_dt IS NOT NULL AND rr_dt >= ? AND rr_dt <= ?
           GROUP BY substr(rr_dt,1,7)`
        )
        .all(from, to);
      for (const r of rows) out[r.ym] = (out[r.ym] || 0) + (Number(r.rev) || 0);
    } finally {
      wb.close();
    }
  } catch {
    /* ignore */
  }
  // Ozon
  try {
    const oz = new DatabaseSync(OZON_DB, { readOnly: true });
    try {
      const rows = oz
        .prepare(
          `SELECT substr(date(operation_dt),1,7) AS ym, SUM(sale_amount) AS rev
           FROM finance_report
           WHERE operation_dt IS NOT NULL
             AND date(operation_dt) >= ? AND date(operation_dt) <= ?
             AND operation_type_name LIKE '%Доставка покупателю%'
           GROUP BY substr(date(operation_dt),1,7)`
        )
        .all(from, to);
      for (const r of rows) out[r.ym] = (out[r.ym] || 0) + (Number(r.rev) || 0);
    } finally {
      oz.close();
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Квартал месяца (1-4) и YYYY-MM срока уплаты УСН (до 25-го след. за кварталом).
 *  Q1(1-3)→25.04, Q2(4-6)→25.07, Q3(7-9)→25.10, Q4(10-12)→25.01 след.года. */
async function usnDueDate(ym) {
  const [y, m] = ym.split("-").map(Number);
  const q = Math.ceil(m / 3);
  let dueY = y;
  let dueM;
  if (q === 1) dueM = 4;
  else if (q === 2) dueM = 7;
  else if (q === 3) dueM = 10;
  else {
    dueM = 1;
    dueY = y + 1;
  }
  return `${dueY}-${String(dueM).padStart(2, "0")}-25`;
}

/** YYYY-MM срока уплаты НДС (до 25-го след. месяца): 2026-05 → 2026-06-25. */
async function vatDueDate(ym) {
  const [y, m] = ym.split("-").map(Number);
  let dueY = y;
  let dueM = m + 1;
  if (dueM > 12) {
    dueM = 1;
    dueY = y + 1;
  }
  return `${dueY}-${String(dueM).padStart(2, "0")}-25`;
}

/** Налоги: УСН 6% и НДС 5% от выручки WB+Ozon, чьи СРОКИ УПЛАТЫ попадают в [from,to].
 *  База УСН = выручка квартала (Σ 3 мес), НДС = выручка месяца.
 *  НДС 5% = выручка × 5/105 (выделение из суммы с налогом).
 *  ⚠️ Выручка тянется за широкий диапазон (от начала года), т.к. срок уплаты
 *  может быть в будущем, а продажи — в прошлом (напр. УСН за Q2 платится 25.07,
 *  а выручка Q2 = май+июнь). Фильтр по сроку — на итоговой выборке.
 *  Возвращает массив {due_date, tax_type, kind, amount, description, period}. */
export async function taxObligations(from, to) {
  const out = [];
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return out;
  // Выручка тянем за широкий диапазон: начало года from до +2 года (с запасом).
  const wideFrom = `${from.slice(0, 4)}-01-01`;
  const wideTo = `${Number(to.slice(0, 4)) + 1}-12-31`;
  const monthRev = revenueByMonth(wideFrom, wideTo);
  const months = Object.keys(monthRev).sort();
  if (months.length === 0) return out;

  // УСН: группируем по кварталу, база = Σ выручки квартала (из доступных месяцев).
  const quarterRev = {}; // 'YYYY-Q' → сумма
  for (const ym of months) {
    const [y, m] = ym.split("-").map(Number);
    const q = Math.ceil(m / 3);
    const key = `${y}-Q${q}`;
    quarterRev[key] = (quarterRev[key] || 0) + monthRev[ym];
  }
  // Один аванс УСН на квартал (по сроку уплаты), фильтр по сроку ∈ [from,to].
  const seenUsn = new Set();
  for (const ym of months) {
    const [y, m] = ym.split("-").map(Number);
    const q = Math.ceil(m / 3);
    const key = `${y}-Q${q}`;
    if (seenUsn.has(key)) continue;
    seenUsn.add(key);
    const base = quarterRev[key] || 0;
    const amount = round2(base * 0.06);
    if (amount <= 0) continue;
    const due = usnDueDate(ym);
    if (due < from || due > to) continue;
    out.push({
      due_date: due,
      tax_type: "УСН",
      kind: `Аванс УСН Q${q}`,
      amount,
      description: `УСН 6% от выручки ${key}`,
      period: key,
    });
  }

  // НДС: ежемесячно, фильтр по сроку ∈ [from,to].
  for (const ym of months) {
    const base = monthRev[ym] || 0;
    const amount = round2((base * 5) / 105);
    if (amount <= 0) continue;
    const due = vatDueDate(ym);
    if (due < from || due > to) continue;
    out.push({
      due_date: due,
      tax_type: "НДС",
      kind: "НДС 5%",
      amount,
      description: `НДС 5% (из выручки × 5/105) за ${ym}`,
      period: ym,
    });
  }
  return out.sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
}

// ---------------- (4) Оплаты по закупкам (RO из purchases) ----------------

/** Неоплаченные остатки по закупкам: qty*unit_cost − prepay_yuan*prepay_rate,
 *  дата = order_dt, фильтр pay_status != 'paid'. Страницу /finance/purchases
 *  НЕ трогаем — только чтение RO. */
export async function purchaseObligations(db) {
  // db — открытое RO/RW соединение fin_data.db (переиспользуем).
  try {
    return db
      .prepare(
        `SELECT p.id AS purchase_id,
                COALESCE(p.order_dt, p.date) AS due_date,
                p.supplier_name,
                ROUND(COALESCE(p.qty*p.unit_cost,0)
                      - COALESCE(p.prepay_yuan * p.prepay_rate, 0), 2) AS amount,
                p.pay_status, p.lifecycle_status,
                p.qty, p.unit_cost
         FROM purchases p
         WHERE p.deleted_at IS NULL
           AND p.qty IS NOT NULL AND p.unit_cost IS NOT NULL
           AND COALESCE(lower(p.pay_status),'none') <> 'paid'
           AND COALESCE(p.qty*p.unit_cost,0)
               - COALESCE(p.prepay_yuan*p.prepay_rate,0) > 0
         ORDER BY COALESCE(p.order_dt, p.date)`
      )
      .all()
      .map((r) => ({ ...r, amount: round2(r.amount) }));
  } catch {
    return [];
  }
}

// ---------------- (5) Регулярные OPEX ----------------

/** Активные OPEX (status='active', ТОЛЬКО business) — дата = op_date или 1-е число месяца.
 *  ⚠️ Фильтр domain='business' обязателен (2026-07-02): с расширением opex под
 *  личные/семейные расходы (domain=personal/family) эти строки НЕ должны
 *  попадать в черновик ДДС — только бизнес-расходы формируют кэшфлоу компании.
 *  COALESCE — страховка от NULL на старых строках до миграции колонки domain. */
export async function opexObligations(db) {
  try {
    return db
      .prepare(
        `SELECT COALESCE(op_date, period || '-01') AS due_date,
                category, amount, note, counterparty, period
         FROM opex
         WHERE COALESCE(lower(status),'active') = 'active'
           AND COALESCE(lower(domain),'business') = 'business'
         ORDER BY COALESCE(op_date, period || '-01')`
      )
      .all()
      .map((r) => ({ ...r, amount: round2(r.amount) }));
  } catch {
    return [];
  }
}
