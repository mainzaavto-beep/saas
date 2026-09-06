// Нулевые формы канона прибыли — ЕДИНСТВЕННОЕ место их определения.
// Набор полей ZERO_PROFIT обязан зеркалить форму значения
// ozProfitProductBatch/wbProfitProductBatch (иначе у потребителей
// batch.get(id) || ZERO_PROFIT поля станут undefined). Отдельного сторожа
// на дрейф этой формы нет — держится ревью при следующем изменении полей
// канона; проверка №6 check-profit-canon.mjs сюда НЕ относится — она
// сверяет покомпонентно только id, реально ПРИСУТСТВУЮЩИЕ в Map (промах
// batch.get() эту проверку не исполняет вовсе).
// services — поле Ozon-специфично (задача 3 плана «Сборы Ozon», 2026-08-25:
// расщеплено из logistics бэкфиллом задач 1-2). У WB такого слагаемого нет —
// wbRawProfitAggregate/wbProfitProduct его никогда не пишут, а num() в
// check-profit-canon.mjs трактует undefined как 0 — держать здесь services:0
// безвредно для WB-форм и обязательно для Ozon-форм (иначе batch.get(id) ||
// ZERO_RAW_AGG отдавал бы agg.services===undefined, а expenses/profitGross
// в ozProfitProductBatch делали бы NaN на отсутствующих id).
// realized/payout/spp — задача 2 плана «выручка WB по цене со скидкой
// продавца» (2026-09-06): revenue стал ВАЛОВЫМ, а «реализовано»/«к
// перечислению»/СПП поехали отдельными полями (у Ozon spp=0,
// realized=revenue). commissionReport/acquiringReport/loyaltyReport —
// СПРАВОЧНЫЕ отчётные суммы WB, у Ozon их нет вовсе; в нулевой форме держим
// их нулями, чтобы batch.get(id) || ZERO_* не отдавал undefined витринам.
export const ZERO_PROFIT = {
  revenue: 0, realized: 0, payout: 0, spp: 0,
  cogs: 0, commission: 0, services: 0, logistics: 0, acquiring: 0, loyalty: 0,
  commissionReport: 0, acquiringReport: 0, loyaltyReport: 0,
  rawProfit: 0, returnLogistics: 0, ads: 0, tax: 0, profit: 0, profitGross: 0,
};

// Нулевая agg-форма (ozRawProfitAggregate/wbRawProfitAggregate и их
// by-day варианты) — день/товар без продаж и возвратов.
export const ZERO_RAW_AGG = {
  revenue: 0, realized: 0, payout: 0, spp: 0,
  cogs: 0, commission: 0, services: 0, logistics: 0, acquiring: 0, loyalty: 0,
  commissionReport: 0, acquiringReport: 0, loyaltyReport: 0,
  rawProfit: 0, returnLogistics: 0,
};

// Оговорка «расчётно» у всего, что на витринах называется «К перечислению».
// У WB payout — ФАКТ финотчёта (Σ cost_value_pay из wb_order_costs), у Ozon
// такого поля в позаказных данных нет вовсе, и канон считает его САМ по
// ozNetForm (lib/ozonMetrics.js): revenue − commission − services −
// acquiring − loyalty, БЕЗ логистики. Пользователь по одному названию
// колонки этого не различит, поэтому один и тот же текст висит подсказкой
// на всех четырёх экранах (P&L, Главная, Сводка по товарам, Детсводка) —
// расхождение формулировок между экранами тоже баг. Формулу не меняем,
// меняем только честность подписи.
export const HINT_PAYOUT_OZON =
  "расчётно для Ozon: выручка − вознаграждение − сборы − эквайринг − лояльность (без логистики)";
