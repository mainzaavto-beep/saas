// lib/mpConfig.js — единый источник правды по маркетплейсам и магазинам.
//
// Раньше конфиг полей API-кредов WB/Ozon дублировался в трёх местах
// (onboarding/page.js, settings/SettingsPage.jsx, settings/page.js) с
// расхождениями в лейблах и required-флагах. Теперь — один модуль, который
// подключают и клиент, и сервер.
//
// Лимит магазинов — ПРИКЛАДНОЙ (проверяется в POST /shops), а не на уровне БД:
// auth.shops не имеет UNIQUE/CHECK по числу строк. См. AGENTS.md.

// Сколько магазинов можно добавить в один проект (кабинет). Лимит общий на все
// МП — любая комбинация WB/Ozon, напр. 2 WB + 2 Ozon или 4 WB.
export const MAX_SHOPS_PER_CABINET = 4;

// Сколько дней истории тянуть при добавлении нового магазина (backfill).
// Onboarding-job с этим диапазоном подхватывается таймером saas-backfill.
export const BACKFILL_DAYS = 75;

// Известные коды маркетплейсов. Сборщики есть только для wb и ozon.
export const KNOWN_MP = ["wb", "ozon", "ya", "avito"];

// Поля API-кредов по МП. Структура { mp: { label, fields: [{key,label,type,required}] } }.
// `required` — валидируется на клиенте и сервере при создании магазина.
// Лейблы — канон (раньше расходились: «(реклама)» / «(опц.)» / «(реклама, опц.)»).
export const MP_CONFIG = {
  wb: {
    label: "Wildberries",
    fields: [
      { key: "token", label: "WB Token (доступ «Статистика» и «Цены и скидки»)", type: "password", required: true },
    ],
  },
  ozon: {
    label: "Ozon",
    fields: [
      { key: "client_id", label: "Client-Id", type: "text", required: true },
      { key: "api_key", label: "Api-Key", type: "password", required: true },
      { key: "perf_client_id", label: "Performance Client-Id (реклама, опц.)", type: "text", required: false },
      { key: "perf_client_secret", label: "Performance Client-Secret (опц.)", type: "password", required: false },
    ],
  },
};
