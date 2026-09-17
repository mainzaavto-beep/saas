// =====================================================================
//  lib/unit.js — Юнит-экономика (источник правды экосистемы).
//
//  ЭТАЛОННАЯ модель расчёта прибыли на единицу товара для WB и Ozon.
//  Налоги — в ОТДЕЛЬНЫХ колонках (решение #2 в decisions.db):
//    • НДС 5%  = выручка_со_скидкой × 5/105  (выделяется из цены)
//    • УСН 6%  = (выручка − НДС) × 0.06        (база = выручка без НДС)
//
//  Источник правды — ЭТОТ файл (решение #3), НЕ Google Sheet.
//  Данные приходят 3 слоями: авто из БД сборщиков / ручной ввод / расчёт тут.
//
//  Формулы воспроизводят исходную Google-таблицу (проверено на 13 товарах),
//  но исправляют ключевую ошибку: раньше налог был одним блобом 11% от цены.
// =====================================================================

// --- Налоговые/финансовые ставки (УСН «доходы» 6% + НДС 5% + эквайринг 3%) ---
export const TAX = Object.freeze({
  VAT_RATE: 5 / 105, // НДС «внутри» цены: выручка × 5/105
  USN_RATE: 0.06, // УСН «доходы» 6% от базы (выручка без НДС)
  ACQUIRING_RATE: 0.03, // Эквайринг 3% от цены покупки покупателем (с СПП)
});

// --- Дефолты модели логистики WB ---
// Решение #4: форма P = (base + add·(L−1))/J × coef.
// Решение #15: coef = ФИКС 1.6 (=160%) для всех товаров, пока нет таблицы коэф
// по складам WB. Архитектурно calcWB принимает warehouseCoef по товару — когда
// wb-rnp-agent соберёт коэф складов через API, API route будет считать
// средневзвешенный = Σ(остаток × коэф)/Σ(остаток) и передавать сюда.
export const WB_LOGISTICS = Object.freeze({
  baseFirstLiter: 50, // 1-й литр, ₽ (B26 в исходной таблице)
  addPerExtraLiter: 20, // со 2-го литра, ₽ (B27)
  warehouseCoef: 1.6, // коэф склада (хранение+приёмка+магистраль), фикс 1.6
});

// --- Метаописание колонок для рендера таблицы на странице ---
// kind: 'input' — поле ввода, 'calc' — расчётное, 'tax' — налог, 'kpi' — итог прибыли/маржи
export const COLUMNS_WB = [
  { key: "name", label: "Товар", kind: "input", align: "left" },
  { key: "priceSeller", label: "Цена на WB", kind: "input", unit: "₽" },
  { key: "discount", label: "Скидка", kind: "input", unit: "%", fmt: "pct" },
  { key: "priceSell", label: "Цена со скидкой", kind: "calc", unit: "₽", tip: "E·(1−F)" },
  { key: "spp", label: "СПП", kind: "input", unit: "%", fmt: "pct" },
  { key: "priceWithSpp", label: "Цена с СПП", kind: "calc", unit: "₽", tip: "G·(1−H), для справки" },
  { key: "priceBuy", label: "Цена продажи", kind: "calc", unit: "₽", tip: "Цена, которую платит покупатель (с СПП) — база налогов/эквайринга (решение хозяина 2026-08-02). Источник: реальная цена сайта card.wb.ru (price_site); если не собрана — цена кабинета×(1−СПП)." },
  { key: "vat", label: "НДС 5%", kind: "tax", unit: "₽", tip: "G × 5/105" },
  { key: "revNet", label: "Выручка без НДС", kind: "calc", unit: "₽", tip: "G − НДС (база УСН)" },
  { key: "commissionRate", label: "Комиссия WB", kind: "input", unit: "%", fmt: "pct" },
  { key: "commission", label: "Комиссия ₽", kind: "calc", unit: "₽", tip: "выручка_без_НДС × K" },
  { key: "buyout", label: "% выкупа", kind: "input", unit: "%", fmt: "pct" },
  { key: "litrazh", label: "Литраж", kind: "input", unit: "л" },
  { key: "logistics", label: "Логистика", kind: "calc", unit: "₽", tip: "(50+20·(L−1))/J × 1.6 (коэф склада, фикс)" },
  { key: "adsRate", label: "ДРР", kind: "input", unit: "%", fmt: "pct", tip: "ставка рекламы; дефолт 10% (если не задано), редактируется inline" },
  { key: "ads", label: "Реклама ₽", kind: "calc", unit: "₽", tip: "цена_кабинета × ДРР" },
  { key: "acquiring", label: "Эквайринг 3%", kind: "calc", unit: "₽", tip: "цена_покупки (с СПП) × 3%" },
  { key: "usn", label: "УСН 6%", kind: "tax", unit: "₽", tip: "выручка_без_НДС × 6%" },
  { key: "cost", label: "Себестоимость", kind: "input", unit: "₽", tip: "себес+лог до WB" },
  { key: "profit", label: "ПРИБЫЛЬ", kind: "kpi", unit: "₽", tip: "выручка_без_НДС − комиссия − логистика − реклама − эквайринг − УСН − себест." },
  { key: "margin", label: "Маржа", kind: "kpi", unit: "%", fmt: "pct", tip: "ПРИБЫЛЬ / цена со скидкой (priceCabinet), НЕ выручка_без_НДС" },
  { key: "renta", label: "Рентаб-сть", kind: "kpi", unit: "%", fmt: "pct", tip: "ПРИБЫЛЬ / себестоимость" },
  { key: "purchase", label: "Закупочная", kind: "input", unit: "₽", tip: "для расчёта брака" },
  { key: "defectRate", label: "% брака", kind: "input", unit: "%", fmt: "pct" },
  { key: "profitWithDefect", label: "Прибыль с браком", kind: "calc", unit: "₽", tip: "ПРИБЫЛЬ − закупочная × %брака" },
];

export const COLUMNS_OZON = [
  { key: "name", label: "Товар", kind: "input", align: "left" },
  { key: "priceOzon", label: "Цена продавца", kind: "input", unit: "₽", tip: "Цена продавца со скидкой (products.price = marketing_seller_price, каталог Ozon, обновляется ежедневно). Аналог «цены со скидкой» WB — база всего расчёта" },
  { key: "priceFact", label: "Факт 30 дн", kind: "calc", unit: "₽", tip: "Справочно: средняя цена проданной штуки по начислениям за 30 дней по вчера (cost_value_retail / qty)" },
  { key: "discount", label: "Скидка", kind: "input", unit: "%", fmt: "pct", tip: "скидка прикидки поверх цены продавца; по умолчанию 0" },
  { key: "priceSell", label: "Цена со скидкой", kind: "calc", unit: "₽", tip: "цена продавца × (1 − скидка) — база НДС, УСН, комиссии, эквайринга, рекламы и маржи" },
  { key: "boost", label: "Соинвест", kind: "calc", unit: "%", fmt: "pct", tip: "Скидка за счёт Ozon для всех покупателей (без Ozon Карты) = 1 − цена для всех / цена продавца. Источник: снимок кабинета продавца (tenant.ozon_prices, source=cabinet), последний день. Из прибыли НЕ вычитается. Нет снимка — «—»" },
  { key: "priceBuyer", label: "Цена покупателя", kind: "calc", unit: "₽", tip: "цена со скидкой × (1 − соинвест) — что видит покупатель без Ozon Карты; продавец получает цену со скидкой" },
  { key: "vat", label: "НДС 5%", kind: "tax", unit: "₽", tip: "цена со скидкой × 5/105" },
  { key: "revNet", label: "Выручка без НДС", kind: "calc", unit: "₽", tip: "цена со скидкой − НДС (база УСН)" },
  { key: "commissionRate", label: "Комиссия", kind: "input", unit: "%", fmt: "pct", tip: "Факт: Σкомиссии / Σцены проданного за 30 дней по начислениям; нет продаж — каталожная ставка категории (⚙ оценка)" },
  { key: "commission", label: "Комиссия ₽", kind: "calc", unit: "₽", tip: "цена со скидкой × комиссия (база с НДС — так считает Ozon)" },
  { key: "acquiringRate", label: "Эквайринг", kind: "input", unit: "%", fmt: "pct", tip: "Факт: Σэквайринга / Σцены проданного за 30 дней; нет продаж — среднее по кабинету, иначе 1,5 %" },
  { key: "acquiring", label: "Эквайринг ₽", kind: "calc", unit: "₽", tip: "цена со скидкой × эквайринг" },
  { key: "buyout", label: "% выкупа", kind: "input", unit: "%", fmt: "pct", tip: "продано / (продано + невыкупы) за 30 дней по начислениям; отмены до отгрузки ничего не стоят и не входят" },
  { key: "logisticsFbo", label: "Логистика прямая", kind: "input", unit: "₽", tip: "F — прямая логистика на проданную штуку: Σлогистики проданных / продано за 30 дней; нет продаж — каталожный тариф (⚙ оценка)" },
  { key: "returnLogistics", label: "Невыкуп ₽", kind: "calc", unit: "₽", tip: "R — логистика одной невыкупленной штуки (строки возврата в начислениях: цена 0, только логистика): Σ / невыкупы за 30 дней; нет невыкупов у товара — среднее по кабинету" },
  { key: "logistics", label: "Логистика на продажу", kind: "calc", unit: "₽", tip: "F + R × (1 − выкуп) / выкуп — логистика на одну проданную штуку с учётом невыкупов; при фактах равна Σлогистики окна / продано" },
  { key: "adsRate", label: "ДРР", kind: "input", unit: "%", fmt: "pct", tip: "ставка рекламы; дефолт 10% (если не задано), редактируется inline" },
  { key: "ads", label: "Реклама ₽", kind: "calc", unit: "₽", tip: "цена со скидкой × ДРР" },
  { key: "usn", label: "УСН 6%", kind: "tax", unit: "₽", tip: "выручка без НДС × ставка" },
  { key: "cost", label: "Себестоимость", kind: "input", unit: "₽" },
  { key: "profit", label: "ПРИБЫЛЬ", kind: "kpi", unit: "₽", tip: "цена со скидкой − НДС − УСН − комиссия − эквайринг − логистика на продажу − реклама − себест." },
  { key: "margin", label: "Маржа", kind: "kpi", unit: "%", fmt: "pct", tip: "ПРИБЫЛЬ / цена со скидкой (как у WB)" },
  { key: "renta", label: "Рентаб-сть", kind: "kpi", unit: "%", fmt: "pct", tip: "ПРИБЫЛЬ / себестоимость" },
  { key: "defectRate", label: "% брака", kind: "input", unit: "%", fmt: "pct" },
  { key: "profitWithDefect", label: "Прибыль с браком", kind: "calc", unit: "₽", tip: "ПРИБЫЛЬ − закупочная × %брака" },
  { key: "marginWithDefect", label: "Маржа с браком", kind: "calc", unit: "%", fmt: "pct", tip: "Прибыль с браком / цена со скидкой" },
];

// =====================================================================
//  calcWB — расчёт юнит-экономики WB (эталонная модель).
//
//  Вход (input): набор полей от авто-слоя (БД) + ручной слой.
//  Все ставки в долях (0.345 = 34.5%), кроме цен/рублей.
//  Возвращает объект со всеми промежуточными колонками.
//
//  НЕ async (баг найден владельцем 2026-08-26): тело функции синхронное
//  (нет await внутри), но раньше объявление было `async function` — API
//  route.js корректно делал await и не замечал разницы, а UnitPage.jsx
//  (ProductRow useMemo + applyOverride) вызывает calcWB/calcOzon БЕЗ await
//  прямо при рендере (useMemo не может быть async). Это возвращало Promise
//  вместо объекта — whatif.profit/margin/adsRate/... все undefined, money()/
//  pct()/num() рендерили «—» на ВСЮ строку прикидки при любом первом
//  изменении любого input-поля (не только ДРР — просто оно было первым,
//  что тронул владелец). Держите синхронной, пока внутри нет await.
// =====================================================================
export function calcWB(input) {
  const i = { ...input };
  // --- Входы (с дефолтами) ---
  const priceWb = num(i.priceWb); // E: цена на WB
  const discount = frac(i.discount); // F: скидка
  const spp = frac(i.spp); // H: СПП
  const commissionRate = frac(i.commissionRate); // K: комиссия WB
  const buyout = frac(i.buyout); // J: % выкупа
  const litrazh = num(i.litrazh) || 0; // L: литраж
  // ДРР = КОНСТАНТА 10% от выручки (решение #14). Входное поле adsRate, если задано
  // явно, перекрывает; иначе дефолт 0.10. НЕ вычислять из daily_ad.
  const adsRate = i.adsRate != null ? frac(i.adsRate) : 0.1;
  const cost = num(i.cost); // D: себестоимость
  // purchase (закупочная для расчёта брака) — если не задана явно, берём = cost.
  // В исходной таблице это были разные колонки (C vs D), но на практике закупочная ≈ себестоимость.
  const purchase = i.purchase != null ? num(i.purchase) : cost;
  const defectRate = frac(i.defectRate); // X: % брака
  // Дефолты логистики: num() возвращает 0 для отсутствующего поля, поэтому
  // nullish-коалесинг (??) НЕ сработает на 0 — используем явную проверку поля.
  const warehouseCoef = i.warehouseCoef != null ? num(i.warehouseCoef) : WB_LOGISTICS.warehouseCoef;
  const baseL = i.baseFirstLiter != null ? num(i.baseFirstLiter) : WB_LOGISTICS.baseFirstLiter;
  const addL = i.addPerExtraLiter != null ? num(i.addPerExtraLiter) : WB_LOGISTICS.addPerExtraLiter;
  // Налоговые ставки — могут быть переопределены per-shop (tax_mode из auth.shops).
  // Дефолт: УСН 6%, НДС 5/105 (выделение из суммы с налогом).
  const usnRate = i.usnRate != null ? frac(i.usnRate) : TAX.USN_RATE;
  const vatRate = i.vatRate != null ? frac(i.vatRate) : TAX.VAT_RATE;

  // --- Расчёты ---
  // БАЗА НАЛОГООБЛОЖЕНИЯ = цена покупки покупателем (с СПП!), НЕ цена в кабинете.
  // Решение владельца 2026-06-19: «НДС считается от цены продажи покупателю, а
  // цена продажи = цена с СПП». УСН — от той же базы (выручка к получению).
  //
  // БАГ ЦЕНЫ (#22): пока нет цены-до-скидки, priceWb из БД = уже финальная цена
  // кабинета. priceSeller задан → priceCabinet = priceSeller*(1-discount); иначе
  // priceCabinet = priceWb. СПП применяется к priceCabinet.
  const priceCabinet = i.priceSeller != null ? num(i.priceSeller) * (1 - discount) : priceWb;
  // priceBuy — цена, которую РЕАЛЬНО платит покупатель (решение хозяина
  // 2026-08-02: база налогов = цена продажи покупателю, с СПП).
  // Приоритет: i.priceBuy = price_site из wb_prices (реальная цена сайта,
  // card.wb.ru, миграция 029). Fallback — расчёт через СПП: priceCabinet×(1−spp).
  // ⚠️ price_buyer (discountedPrice) сюда подавать НЕЛЬЗЯ — он БЕЗ СПП
  // (опровергнуто на nm 1181386677: API 8911 ₽, сайт 6344 ₽).
  const priceBuy = i.priceBuy != null && num(i.priceBuy) > 0
    ? num(i.priceBuy)
    : priceCabinet * (1 - spp); // цена покупки покупателем — база налогов/эквайринга
  // ФИНАЛЬНАЯ модель #50 (отладка 760000368, 2026-06-20):
  //  • НАЛОГИ (НДС/УСН) и ЭКВАЙРИНГ — от priceBuy (цена, что реально заплатил покупатель).
  //  • КОМИССИЯ WB и РЕКЛАМА — от priceCabinet (цена кабинета, без СПП).
  //  • ЛОГИСТИКА — тариф от литража/выкупа.
  //  • ВЫРУЧКА ДЛЯ ПРИБЫЛИ = priceCabinet (СПП компенсирует WB, продавец получает цену кабинета).
  const vat = priceBuy * vatRate; // НДС от цены покупки (отдельная колонка)
  const revNet = priceBuy - vat; // выручка без НДС от цены покупки = база УСН

  // Комиссия и ДРР — от priceCabinet (цена до СПП со скидкой продавца)
  const commission = priceCabinet * commissionRate;

  // Логистика: (50 + 20·(L−1)) / J × coef   — как в исходной таблице
  const logRaw = baseL + addL * Math.max(litrazh - 1, 0);
  const buyoutSafe = buyout > 0 ? buyout : 1; // защита от деления на 0
  const logistics = buyoutSafe > 0 ? (logRaw / buyoutSafe) * warehouseCoef : 0;

  const ads = priceCabinet * adsRate;
  // Эквайринг 3% — от priceBuy (цена транзакции, что заплатил покупатель).
  const acquiring = priceBuy * TAX.ACQUIRING_RATE;
  const usn = revNet * usnRate; // УСН (отдельная колонка) — от базы налогов (priceBuy)

  // ПРИБЫЛЬ = priceCabinet (вся цена кабинета продавца, СПП за счёт WB) − все расходы.
  // В расходы входят: налоги/эквайринг (от priceBuy) + комиссия/реклама (от priceCabinet)
  // + логистика + себестоимость.
  const profit = priceCabinet - vat - usn - acquiring - commission - ads - logistics - cost;
  const margin = priceCabinet > 0 ? profit / priceCabinet : 0;
  const renta = cost > 0 ? profit / cost : 0;

  const defectLoss = purchase * defectRate;
  const profitWithDefect = profit - defectLoss;

  return {
    ...i,
    adsRate: round4(adsRate), // ЭФФЕКТИВНАЯ ставка ДРР (доля): либо ручной override,
    // либо дефолт 0.10. Раньше не возвращалась → колонка %ДРР показывала 0%, хотя
    // сумма рекламы считалась как 10% от priceCabinet. Теперь UI видит реальную ставку.
    priceCabinet: round2(priceCabinet), // цена в кабинете продавца (priceSell)
    priceBuy: round2(priceBuy), // цена покупки покупателем (с СПП) — база налогов
    // Совместимость со старыми колонками COLUMNS_WB:
    priceSell: round2(priceCabinet), // «Цена со скидкой» в UI = цена кабинета
    priceWithSpp: round2(priceBuy), // «Цена с СПП» в UI = цена покупки
    vat: round2(vat),
    revNet: round2(revNet),
    commission: round2(commission),
    logistics: round2(logistics),
    ads: round2(ads),
    acquiring: round2(acquiring),
    usn: round2(usn),
    profit: round2(profit),
    margin: round4(margin),
    renta: round4(renta),
    profitWithDefect: round2(profitWithDefect),
  };
}

// =====================================================================
//  calcWB_Legacy — старая формула из Google-таблицы (для сверки).
//  T = G − D − P − G·K − G·S − R, где S = ставка_налога (один блоб).
//  НЕ используем в проде — только чтобы сверить цифры с оригиналом.
// =====================================================================
export async function calcWB_Legacy(input) {
  const i = { ...input };
  const priceWb = num(i.priceWb);
  const discount = frac(i.discount);
  const commissionRate = frac(i.commissionRate);
  const buyout = frac(i.buyout);
  const litrazh = num(i.litrazh) || 0;
  const adsRate = frac(i.adsRate);
  const cost = num(i.cost);
  const purchase = num(i.purchase);
  const defectRate = frac(i.defectRate);
  const taxRate = frac(i.legacyTaxRate ?? 0.11); // S в исходной таблице
  const warehouseCoef = i.warehouseCoef != null ? num(i.warehouseCoef) : WB_LOGISTICS.warehouseCoef;
  const baseL = i.baseFirstLiter != null ? num(i.baseFirstLiter) : WB_LOGISTICS.baseFirstLiter;
  const addL = i.addPerExtraLiter != null ? num(i.addPerExtraLiter) : WB_LOGISTICS.addPerExtraLiter;

  const G = priceWb * (1 - discount);
  const logRaw = baseL + addL * Math.max(litrazh - 1, 0);
  const P = buyout > 0 ? (logRaw / buyout) * warehouseCoef : 0;
  const R = G * adsRate;
  const T = G - cost - P - G * commissionRate - G * taxRate - R;
  const U = G > 0 ? T / G : 0; // маржа
  const V = cost > 0 ? T / cost : 0; // рентабельность
  const Y = T - purchase * defectRate; // с учётом брака
  const Z = G > 0 ? Y / G : 0;
  return {
    ...i,
    G: round2(G),
    P: round2(P),
    R: round2(R),
    T: round2(T),
    U: round4(U),
    V: round4(V),
    Y: round2(Y),
    Z: round4(Z),
  };
}

// =====================================================================
//  calcOzon — расчёт юнит-экономики Ozon (FBO), модель уровня WB
//  (спека docs/superpowers/specs/2026-09-17-ozon-unit-model-design.md §2,
//  решения владельца 17.09.2026).
//
//   • priceOzon — цена продавца со скидкой (products.price = marketing_seller_price),
//     аналог priceCabinet WB. База НДС/УСН/комиссии/эквайринга/рекламы/маржи.
//   • boost — соинвест Ozon (без Ozon Карты) из снимков кабинета; за счёт
//     площадки, из прибыли НЕ вычитается; null = снимка нет → priceBuyer null.
//   • commissionRate/acquiringRate — факт из начислений (роут), база — цена с НДС.
//   • Логистика на проданную штуку: F + R × (1 − b) / b, где F — прямая на
//     проданную штуку, R — логистика одного невыкупа (строка is_return=1:
//     цена 0, только логистика, парной продажи нет), b — % выкупа. F на b НЕ
//     делится (в отличие от WB): логистика неудачных попыток целиком в R.
//     При фактических F/R/b тождественно Σлогистики окна / продано. b = 1 → F.
//   • ДРР = константа 10% (решение #14), adsRate перекрывает.
//   • Синхронная (урок 26.08) — UnitPage зовёт её в useMemo без await.
// =====================================================================
export function calcOzon(input) {
  const i = { ...input };
  const priceOzon = num(i.priceOzon);
  const discount = frac(i.discount);
  const boost = i.boost == null ? null : frac(i.boost);
  const commissionRate = frac(i.commissionRate);
  const acquiringRate = frac(i.acquiringRate);
  const buyout = frac(i.buyout); // b; 0/пусто → как 1 (без деления на ноль)
  const logisticsFbo = num(i.logisticsFbo); // F, ₽ на проданную штуку
  const returnLogistics = num(i.returnLogistics); // R, ₽ на один невыкуп
  const adsRate = i.adsRate != null ? frac(i.adsRate) : 0.1;
  const cost = num(i.cost);
  const purchase = i.purchase != null ? num(i.purchase) : cost;
  const defectRate = frac(i.defectRate);
  const usnRateOz = i.usnRate != null ? frac(i.usnRate) : TAX.USN_RATE;
  const vatRateOz = i.vatRate != null ? frac(i.vatRate) : TAX.VAT_RATE;

  const priceSell = priceOzon * (1 - discount);
  const priceBuyer = boost == null ? null : priceSell * (1 - boost);
  const vat = priceSell * vatRateOz;
  const revNet = priceSell - vat;
  const usn = revNet * usnRateOz;
  const commission = priceSell * commissionRate;
  const acquiring = priceSell * acquiringRate;
  const bSafe = buyout > 0 ? buyout : 1;
  const logistics = logisticsFbo + returnLogistics * (1 - bSafe) / bSafe;
  const ads = priceSell * adsRate;

  const profit = priceSell - vat - usn - commission - acquiring - logistics - ads - cost;
  const margin = priceSell > 0 ? profit / priceSell : 0;
  const renta = cost > 0 ? profit / cost : 0;
  const defectLoss = purchase * defectRate;
  const profitWithDefect = profit - defectLoss;
  const marginWithDefect = priceSell > 0 ? profitWithDefect / priceSell : 0;

  return {
    ...i,
    adsRate: round4(adsRate),
    boost: boost == null ? null : round4(boost),
    buyout: Math.round((bSafe + Number.EPSILON) * 1000000) / 1000000, // 6 decimals для идемпотентности
    acquiringRate: round4(acquiringRate),
    priceSell: round2(priceSell),
    priceBuyer: priceBuyer == null ? null : round2(priceBuyer),
    priceFact: i.priceFact == null ? null : round2(num(i.priceFact)),
    vat: round2(vat),
    revNet: round2(revNet),
    commission: round2(commission),
    acquiring: round2(acquiring),
    logisticsFbo: round2(logisticsFbo),
    returnLogistics: round2(returnLogistics),
    logistics: round2(logistics),
    ads: round2(ads),
    usn: round2(usn),
    profit: round2(profit),
    margin: round4(margin),
    renta: round4(renta),
    profitWithDefect: round2(profitWithDefect),
    marginWithDefect: round4(marginWithDefect),
  };
}

// --- утилиты ---
function num(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
// Принимает как долю (0.345) так и проценты (34.5). Если >1 — считаем процентами.
function frac(v) {
  const n = num(v);
  return Math.abs(n) > 1 ? n / 100 : n;
}
function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
function round4(v) {
  return Math.round((v + Number.EPSILON) * 10000) / 10000;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
