import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";
import { NextResponse } from "next/server";
import { normalizeTaxMode } from "@/lib/tax.js";
import { wbProfitCabinet } from "@/lib/wbMetrics.js";
import { ozProfitCabinet } from "@/lib/ozonMetrics.js";
import { defaultPeriod } from "@/lib/period.js";

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
//  ФИКС 2026-08-26 (нашёл владелец): раньше собирали суммы НАПРЯМУЮ из
//  tenant.wb_cabinet_costs / tenant.ozon_cabinet_costs — сырые суммы в
//  НАТИВНОМ знаке каждой площадки (WB: расход>0, возмещение<0; Ozon:
//  расход<0, доход>0 — см. докстроки lib/wbMetrics.js:685-704,
//  lib/ozonMetrics.js:548-565). Складывать их «как есть» в одну таблицу
//  и одно «Итого» — ошибка того же класса, что чинили в каноне
//  (ozonMetrics.js:555-565, «сложить сырое, не нормализовав»): знак статьи
//  расходился с P&L, а «Итого» на Сводке арифметически НЕ совпадало с
//  cabinetCostsTotal на P&L (доказано: июль-2026 каб.1, −58 354,67 ₽ на
//  Сводке vs −38 474,07 ₽ в каноне/P&L — разница 19 880,60 ₽ = 2×WB-нетто).
//  Теперь источник — КАНОН: wbProfitCabinet/ozProfitCabinet(...).cabinetCosts
//  (тот же вызов, что использует /api/cabinets/[id]/pnl/route.js) — знак уже
//  нормализован (amount<0 — расход, amount>0 — доход/возмещение), лейблы
//  (включая Ozon accrual_<id> → русское имя) тоже приходят из канона.
//
//  Источник: tenant.wb_cabinet_costs (PK cost_type,period_from,period_to),
//  tenant.ozon_cabinet_costs (PK cost_type,date) — читает канон. RLS
//  изолирует по cabinet.
// =====================================================================

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function collectWB(taxMode, from, to) {
  let cabinetCosts = [];
  let cabinetCostsInfo = [];
  try {
    const db = new DatabaseSync("wb", { readOnly: true });
    const c = await wbProfitCabinet(db, taxMode, { from, to });
    cabinetCosts = c.cabinetCosts;
    cabinetCostsInfo = c.cabinetCostsInfo || [];
  } catch (e) {
    console.error("[cabinet-costs] WB wbProfitCabinet:", e?.message || e);
    cabinetCosts = [];
    cabinetCostsInfo = [];
  }
  const sum = round2(cabinetCosts.reduce((acc, x) => acc + x.amount, 0));
  return {
    sum,
    byType: cabinetCosts.map((x) => ({
      cost_type: x.costType,
      label: x.label,
      amount: x.amount, // уже канон-знак (расход<0, доход/возмещение>0)
      platform: "wb",
    })),
    // Справочные статьи канона (оплата рекламы удержанием WB) — НЕ входят
    // в sum/«Итого» и в прибыль, см. docs/metrics-contract.md §19.
    info: cabinetCostsInfo.map((x) => ({
      cost_type: x.costType,
      label: x.label,
      note: x.note,
      amount: x.amount,
      platform: "wb",
    })),
  };
}

async function collectOzon(taxMode, from, to) {
  let cabinetCosts = [];
  try {
    const db = new DatabaseSync("ozon", { readOnly: true });
    const c = await ozProfitCabinet(db, taxMode, { from, to });
    cabinetCosts = c.cabinetCosts;
  } catch (e) {
    console.error("[cabinet-costs] Ozon ozProfitCabinet:", e?.message || e);
    cabinetCosts = [];
  }
  const sum = round2(cabinetCosts.reduce((acc, x) => acc + x.amount, 0));
  return {
    sum,
    info: [],
    byType: cabinetCosts.map((x) => ({
      cost_type: x.costType,
      label: x.label,
      amount: x.amount, // уже канон-знак (расход<0, доход/возмещение>0)
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
      } else {
        // Fallback: нет данных — последние 30 дней ПО ВЧЕРА (сегодня недособрано).
        const def = defaultPeriod(30);
        if (!to) to = def.to;
        if (!from) from = def.from;
      }
    }
    // Ozon-канон (ozProfitCabinet) сам сравнивает date по [from; to] без
    // суффикса времени (см. lib/ozonMetrics.js:570-578) — toEnd/T23:59:59
    // больше не нужен, канон — источник истины по границам периода.

    // Налоговый режим на каждый МП — тот же паттерн, что в pnl/route.js.
    // cabinetCosts[].amount не зависит от taxMode (нормализация знака —
    // до расчёта налога), но wbProfitCabinet/ozProfitCabinet считают его
    // как часть общего профита канона (base = wbProfitProduct/ozProfitProduct).
    const wbTax = normalizeTaxMode(cabinet.shopTax?.wb);
    const ozonTax = normalizeTaxMode(cabinet.shopTax?.ozon);

    let wb = { sum: 0, byType: [], info: [] };
    let oz = { sum: 0, byType: [], info: [] };
    if (platform !== "ozon") wb = await collectWB(wbTax, from, to);
    if (platform !== "wb")  oz = await collectOzon(ozonTax, from, to);

    // Сливаем byType в единый список items, сортировка по |amount| (убывание).
    // Не отбрасываем отрицательные статьи (расходы после нормализации) —
    // показываем как есть, знак уже канон-знак.
    const items = [...wb.byType, ...oz.byType]
      .filter((x) => Math.abs(x.amount) > 0)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    // «Итого» — ПОДПИСАННАЯ сумма нормализованных amount (тот же смысл,
    // что cabinetCostsTotal в pnl/route.js) — должна арифметически совпадать
    // с P&L за тот же период.
    const totalAll = round2(wb.sum + oz.sum);
    // Доля — от ОБЩЕГО МОДУЛЯ (Σ|amount| по всем статьям), НЕ от totalAll:
    // totalAll — подписанная сумма, взаимопогашение расход/возмещение (напр.
    // WB promotion −84 395 ₽ и payout_other +68 774 ₽) может увести его к
    // нулю или сменить знак — тогда доля каждой статьи считалась бы неверно
    // или вообще не считалась. Модуль это гасит (тот же смысл, что был в
    // комментарии до фикса: «чтобы сторно не съедал долю других типов»).
    const totalAbs = round2(items.reduce((acc, x) => acc + Math.abs(x.amount), 0));
    for (const it of items) {
      it.share = totalAbs ? Math.round(Math.abs(it.amount) / totalAbs * 1000) / 10 : null;
    }

    // info — справочные статьи (WB: оплата рекламы удержанием, «уже учтена в
    // рекламе»): вне items, вне долей и вне «Итого» (docs/metrics-contract.md §19).
    const info = [...wb.info, ...oz.info].filter((x) => Math.abs(x.amount) > 0);

    return NextResponse.json({
      period: { from, to },
      totals: { wb: wb.sum, ozon: oz.sum, all: totalAll },
      items,
      info,
      methodology: "Кабинетные расходы (№27): хранение/удержание/подписка/нераспределённая реклама и пр. — то, что API МП НЕ привязывает к товару. Не входят в маржу SKU, показываются отдельно.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: String(e && e.message || e), totals: { wb: 0, ozon: 0, all: 0 }, items: [] },
      { status: 500 }
    );
  }
});
