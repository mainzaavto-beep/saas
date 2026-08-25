// Нулевые формы канона прибыли — ЕДИНСТВЕННОЕ место их определения.
// Набор полей ZERO_PROFIT обязан зеркалить форму значения
// ozProfitProductBatch/wbProfitProductBatch (иначе у потребителей
// batch.get(id) || ZERO_PROFIT поля станут undefined). Отдельного сторожа
// на дрейф этой формы нет — держится ревью при следующем изменении полей
// канона; проверка №6 check-profit-canon.mjs сюда НЕ относится — она
// сверяет покомпонентно только id, реально ПРИСУТСТВУЮЩИЕ в Map (промах
// batch.get() эту проверку не исполняет вовсе).
export const ZERO_PROFIT = {
  revenue: 0, cogs: 0, commission: 0, logistics: 0, acquiring: 0, loyalty: 0,
  rawProfit: 0, returnLogistics: 0, ads: 0, tax: 0, profit: 0, profitGross: 0,
};

// Нулевая agg-форма (ozRawProfitAggregate/wbRawProfitAggregate и их
// by-day варианты) — день/товар без продаж и возвратов.
export const ZERO_RAW_AGG = {
  revenue: 0, cogs: 0, commission: 0, logistics: 0, acquiring: 0, loyalty: 0,
  rawProfit: 0, returnLogistics: 0,
};
