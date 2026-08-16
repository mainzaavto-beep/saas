// scripts/lib/ozon-promo-type-ids.mjs — перечень NON_ITEM-type_id продвижения
// Ozon (реклама, уже учтённая ad_spend Performance API — не order_costs).
// Источник правды: worker/collectors/ozon_profit_map.py::NONITEM_PROMO_TYPE_IDS
// (41 PayPerClick, 54 Promotion, 33 Marketing) — держать синхронно вручную,
// т.к. Node-скрипты не импортируют Python-модули напрямую.
export const NONITEM_PROMO_TYPE_IDS = [41, 54, 33];
