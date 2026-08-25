// lib/ozonServiceTypes.js — словарь типов позаказных сборов Ozon («Сборов Ozon»)
// + JS-классификатор строк начислений для расшифровки статьи.
//
// Контекст (2026-08-25, план «расшифровка Сборов Ozon»,
// docs/superpowers/specs/2026-08-25-services-breakdown-design.md): статья
// «Сборы Ozon» (order_costs.services, задача 3 плана «Сборы Ozon» 2026-08-25)
// суммирует позаказные ITEM-строки начислений, которые не относятся к
// commission/acquiring/loyalty/logistics. Этот файл отвечает «за что» —
// подписи типов и классификатор, ЗЕРКАЛЬНЫЕ classify_row из
// worker/collectors/ozon_profit_map.py (двустороннее зеркало — встречный
// коммент там же). Наборы типов ПЕРЕНЕСЕНЫ дословно, не выдуманы.

// Подписи известных типов сервисных сборов — PER_ORDER_SERVICE_TYPE_IDS
// из ozon_profit_map.py (комментарии там же расшифровывают каждый код).
export const SERVICE_TYPE_LABELS = {
  116: "Сбор первых отзывов",
  74: "Звёздные товары",
  22: "Рассрочка",
  71: "Вывоз со склада",
  15: "Утилизация",
  78: "Временное размещение возврата",
  79: "Временное размещение партнёрами",
  39: "Упаковка партнёрами",
  38: "Упаковочные материалы",
};

// Подпись типа сбора; неизвестный код (копилка «прочие сборы», см.
// classify_row: незнакомый позаказный тип тоже уходит в services) —
// «Прочие сборы (тип N)».
export function serviceLabel(typeId) {
  return SERVICE_TYPE_LABELS[typeId] || `Прочие сборы (тип ${typeId})`;
}

// Зеркала наборов ozon_profit_map.py (ACQUIRING_TYPE_IDS/LOYALTY_TYPE_IDS/
// PER_ORDER_LOGISTICS_TYPE_IDS) — позаказные типы, которые «Сборами Ozon»
// НЕ являются. Значения переносятся дословно, не выдумываются.
export const NON_SERVICE_PER_ORDER_SETS = {
  // Эквайринг — ITEM, единственный код (§5: "Оплата эквайринга").
  ACQUIRING_TYPE_IDS: new Set([1]), // Acquiring
  // Лояльность — пусто (см. коммент в ozon_profit_map.py: co-investment
  // лояльности живёт внутри commission-блока POSTING, не отдельным type_id).
  LOYALTY_TYPE_IDS: new Set(),
  // Позаказные типы (has_unit=true), кроме комиссии/эквайринга/сервисов —
  // строго перевозка/обработка отправлений и возвратов (11 POSTING-типов).
  PER_ORDER_LOGISTICS_TYPE_IDS: new Set([
    32, // Logistic — логистика
    29, // LastMileCourier — доставка до места выдачи
    98, // DeliveryToHandoverPlaceByOzon — доставка до места выдачи силами Ozon
    45, // PickUpPointReturnAcceptance — обработка возвратов/отмен/невыкупов
    59, // ReturnFlowLogistic — обратная логистика
    16, // Drop-Off — обработка отправления Drop-off
    17, // Drop-Off Agent — обработка отправления Drop-off партнёрами
    30, // LastMilePickUpPoint — выдача товара
    9, // ClientReturn — обработка возвратов
    40, // PartialReturn — обработка частичного невыкупа
    6, // Cancellation — обработка отменённых и невостребованных товаров
  ]),
};

// Позаказная accrual-строка относится к «Сборам Ozon», если это не
// commission-блок (POSTING, type_id IS NULL), не эквайринг, не лояльность
// и не перевозка — та же логика, что classify_row в ozon_profit_map.py
// (двустороннее зеркало, см. встречный коммент там). Дрейф наборов ловит
// приёмочный инвариант Σ(раскладки) = oc.services.
export function isServiceRow(category, typeId) {
  const { ACQUIRING_TYPE_IDS, LOYALTY_TYPE_IDS, PER_ORDER_LOGISTICS_TYPE_IDS } = NON_SERVICE_PER_ORDER_SETS;
  if (category === "POSTING" && typeId == null) return false; // commission
  if (ACQUIRING_TYPE_IDS.has(typeId)) return false;
  if (LOYALTY_TYPE_IDS.has(typeId)) return false;
  if (PER_ORDER_LOGISTICS_TYPE_IDS.has(typeId)) return false;
  // Известный сервисный тип ИЛИ незнакомый позаказный тип (копилка «прочие
  // сборы» — то же поведение, что fallback classify_row: services, known=False).
  return true;
}
