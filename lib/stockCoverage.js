// lib/stockCoverage.js — КАНОН покрытия остатка (одна цифра везде).
//
// Скорость продаж и покрытие считаются ровно одной парой функций для всех
// потребителей: планировщик поставок (lib/supplyPlan.js → lib/supplyPlanData.js)
// и рекомендации перевозки между складами WB
// (app/api/cabinets/[id]/stocks/route.js, buildReallocRecommendations).
//
// Канон (с 2026-09-08, финальное ревью этапа 3 «Поставки»):
//   • скорость = заказы за окно / ДЛИНУ ОКНА (календарные дни), а не за дни,
//     в которые были продажи. Деление на дни-с-продажами завышало скорость у
//     товаров с редкими продажами (1 шт раз в 3 недели давало «1 шт/дн») и
//     давало на разных страницах разные цифры для одного товара;
//   • покрытие = (остаток + в пути) / скорость; скорость 0 → null («неизвестно»,
//     никогда не Infinity);
//   • остаток для покрытия — ДОСТУПНЫЙ (WB quantity, Ozon fbo_present − reserved),
//     а не «полный» (quantity_full / fbo_present): зарезервированное покупателем
//     продать второй раз нельзя.
//
// Модуль чистый (без БД и без «@/»-алиаса, который резолвит только сборщик Next) —
// импортируется и из `node --test`.

// Окно скорости продаж — 4 полные недели: не перекашивает недельная сезонность
// (спека «Склады 2.0» §3.5). Не параметр функции и не настройка кабинета.
export const VELOCITY_WINDOW_DAYS = 28;

// velocityPerDay: заказы за окно / дни. days ≤ 0 → 0 (не Infinity/NaN).
export function velocityPerDay(ordersQty, days) {
  const d = Number(days);
  const q = Number(ordersQty) || 0;
  if (!(d > 0)) return 0;
  return q / d;
}

// coverageDays: сколько дней хватит остатка+в пути при данной скорости. velocity=0 → null
// (никогда не Infinity — недостижимое покрытие смыслово равно "неизвестно").
export function coverageDays(stock, inTransit, velocity) {
  const v = Number(velocity) || 0;
  if (v <= 0) return null;
  const s = (Number(stock) || 0) + (Number(inTransit) || 0);
  return s / v;
}
