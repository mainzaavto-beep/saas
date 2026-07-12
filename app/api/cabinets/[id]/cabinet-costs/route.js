import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// =====================================================================
//  /api/cabinets/[id]/cabinet-costs — кабинето-уровневые расходы БЕЗ
//  привязки к SKU (заявка №27). Перенос из data-presenter с адаптацией
//  под PostgreSQL+RLS (DatabaseSync из @/lib/db.js, withCabinet).
//
//  То, что API МП НЕ привязывает к товару: хранение, удержание
//  («Баллы за отзывы»), подписка Premium Plus, реклама без SKU
//  в названии кампании, кросс-докинг, недостача поставок и пр.
//
//  ⚠️ ПО КОНТРАКТУ №27 (DATA_CONTRACT.md:805-809) эти суммы НЕЛЬЗЯ
//  размазывать по SKU пропорционально выручке — это исказит маржу.
//  Показываем ОТДЕЛЬНО: потребитель использует их для P&L кабинета.
//
//  Источник: tenant.wb_cabinet_costs (PK cost_type,period_from,period_to),
//  tenant.ozon_cabinet_costs (PK cost_type,date). RLS изолирует по cabinet.
// =====================================================================

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Объединённый маппинг cost_type → человекочитаемый лейбл (WB + Ozon).
// Правка 2026-06-25 (gotcha #148): «Удержание» в WB — ДВЕ разные услуги
// (promotion vs reviews). См. оригинал в data-presenter.
const LABELS = {
  storage:               "Хранение",
  deduction:             "Удержание (прочее)",          // legacy
  reviews:               "Баллы за отзывы (возврат аванса)",
  deduction_other:       "Удержание (прочее)",
  promotion:             "Продвижение WB (платная услуга)",
  pvz_compensation:      "Возмещение за ПВЗ",
  transport_compensation:"Возмещение перевозки",
  subscription:          "Подписка Premium Plus",
  ad_unmapped:           "Реклама без привязки к SKU",
  crossdocking:          "Кросс-докинг",
  supply:                "Приёмка / недостача",
  penalty:               "Штрафы",
  other:                 "Прочее",
};

async function collectWB(from, to) {
  // WB хранит период отчёта как диапазон (period_from, period_to).
  // Берём строки, пересекающиеся с [from; to].
  let rows = [];
  try {
    rows = await new DatabaseSync("wb", { readOnly: true }).prepare(
      `SELECT cost_type, COALESCE(SUM(amount),0) AS s
         FROM cabinet_costs
        WHERE period_from <= ? AND period_to >= ?
        GROUP BY cost_type`
    ).all(to, from);
  } catch {
    rows = [];
  }
  const sum = rows.reduce((acc, r) => acc + (Number(r.s) || 0), 0);
  return {
    sum: round2(sum),
    byType: rows.map((r) => ({
      cost_type: r.cost_type,
      label: LABELS[r.cost_type] || r.cost_type,
      amount: round2(r.s),
      platform: "wb",
    })),
  };
}

async function collectOzon(from, toEnd) {
  // Ozon: period = один день (date). Простой BETWEEN.
  let rows = [];
  try {
    rows = await new DatabaseSync("ozon", { readOnly: true }).prepare(
      `SELECT cost_type, COALESCE(SUM(amount),0) AS s
         FROM cabinet_costs
        WHERE date >= ? AND date <= ?
        GROUP BY cost_type`
    ).all(from, toEnd);
  } catch {
    rows = [];
  }
  const sum = rows.reduce((acc, r) => acc + (Number(r.s) || 0), 0);
  return {
    sum: round2(sum),
    byType: rows.map((r) => ({
      cost_type: r.cost_type,
      label: LABELS[r.cost_type] || r.cost_type,
      amount: round2(r.s),
      platform: "ozon",
    })),
  };
}

export const GET = withCabinet(async (req, { cabinet }) => {
  try {
    const url = new URL(req.url);
    const platform = url.searchParams.get("platform") || "all"; // all|wb|ozon
    const fromQ = url.searchParams.get("from") || "";           // YYYY-MM-DD
    const toQ = url.searchParams.get("to") || "";

    // Дефолтный период: те же 30 дней от MAX(order_dt) по обеим БД,
    // что и products-summary (консистентность KPI-плиток на странице).
    let from = fromQ, to = toQ;
    if (!from || !to) {
      let maxDt = "";
      try { maxDt = await new DatabaseSync("wb", { readOnly: true }).prepare("SELECT MAX(order_dt) AS m FROM orders").get()?.m || ""; } catch {}
      try { const oz = await new DatabaseSync("ozon", { readOnly: true }).prepare("SELECT MAX(order_dt) AS m FROM orders").get()?.m || ""; if (oz > maxDt) maxDt = oz; } catch {}
      if (maxDt) {
        if (!to) to = maxDt.slice(0, 10);
        if (!from) {
          const d = new Date(maxDt);
          d.setDate(d.getDate() - 29);
          from = d.toISOString().slice(0, 10);
        }
      }
    }
    const toEnd = to ? to + "T23:59:59" : "";

    let wb = { sum: 0, byType: [] };
    let oz = { sum: 0, byType: [] };
    // ⚠️ Фикс при переносе: эталон забыл await здесь (Promise<...> использовался
    // как объект). Теперь корректно await'им оба вызова.
    if (platform !== "ozon") wb = await collectWB(from, to);
    if (platform !== "wb")  oz = await collectOzon(from, toEnd);

    // Сливаем byType в единый список items, сортировка по |amount| (убывание).
    // Не отбрасываем отрицательные (сторно WB) — показываем как есть.
    const items = [...wb.byType, ...oz.byType]
      .filter((x) => Math.abs(x.amount) > 0)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    const totalAll = round2(wb.sum + oz.sum);
    for (const it of items) {
      // Доля от общего модуля (чтобы сторно не «съедал» долю других типов).
      it.share = totalAll ? Math.round(Math.abs(it.amount) / totalAll * 1000) / 10 : null;
    }

    return NextResponse.json({
      period: { from, to },
      totals: { wb: wb.sum, ozon: oz.sum, all: totalAll },
      items,
      methodology: "Кабинетные расходы (№27): хранение/удержание/подписка/нераспределённая реклама и пр. — то, что API МП НЕ привязывает к товару. Не входят в маржу SKU, показываются отдельно.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: String(e && e.message || e), totals: { wb: 0, ozon: 0, all: 0 }, items: [] },
      { status: 500 }
    );
  }
});
