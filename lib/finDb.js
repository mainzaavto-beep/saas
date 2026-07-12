import { ensureAuditTriggers } from "./dbAudit";

// =====================================================================
//  lib/finDb.js — подключение к fin_data.db (БЕЗ readOnly — UI пишет).
//
//  Граница записи:
//    • sales_plan, plan_targets — план продаж (№29)
//    • opex — сопутствующие расходы / OPEX (№35, вкладка «Сопутств. расходы»)
//    • dds_movements — движение денежных средств (№38)
//    • balance_snapshot — баланс актив/пассив снапшот (№38)
//    • purchases — партии закупок (№40, 2026-06-24): дашборд-first после №37.
//      Sheets = backup (кнопка «Сохранить в Sheets» в UI → run.py backup push).
//      fin_cogs НЕ пишем отсюда (связанная таблица fin — её пересчитывает сборщик
//      через upsert_fin_cogs; дашборд правит только purchases, а Y/unit_cost
//      пересчитывает на лету из N/S/R/M/W при POST).
//    • purchase_payments — график платежей по заказу (№41, 2026-06-24): дочерняя к
//      purchases (FK purchase_id). CRUD через отдельный роут /api/purchase-payments.
//    • self_buyouts — самовыкупы (№34, редактируемый с 2026-06-26): раньше был RO
//      с источником в Google Sheets (контракт №34), но №37 развернул направление —
//      дашборд = источник правды, Sheets = backup. С 2026-06-25 фин-агент не
//      тянет/не пушит Sheets, поэтому старый канал импорта больше не работает —
//      правки идут из UI (роут /api/self-buyouts). 7 формульных колонок
//      пересчитываются на сервере по эталону fin/db_local.py:250-257.
//  НЕ трогать: fin_cogs, bank_transactions, purchase_plan,
//  cost_overrides — другие домены / внешние источки.
//
//  🔒 ЗАЩИТА ОТ ПОТЕРИ ДАННЫХ (2026-06-25, грабля #145): при открытии соединения
//  автоматически вешаются audit-триггеры (lib/dbAudit.js) на ВСЕ редактируемые
//  таблицы. Любая перезапись (UPSERT) или HARD DELETE оставляет recoverable-копию
//  в <table>_audit. Так smoke-тест или ошибка не могут молча убить данные владельца.
//
//  Образец: app/api/plan/route.js (НЕ singleton — для RW безопаснее
//  открывать/закрывать connection на каждый запрос).
// =====================================================================

// fin_data.db перенесён в C:\AgentsDB\ (как все боевые БД) 2026-06-24 — теперь это
// зона data-presenter'а. Env FIN_DB_PATH перекрывает дефолт. Бывшее место
// (/opt/agents/financial_agent/fin_data.db) — устарело после переноса.
const FIN_DB_PATH = process.env.FIN_DB_PATH || "/opt/agentsDB/fin_data.db";

/** Открывает НОВОЕ соединение с fin_data.db на чтение/запись + вешает audit-триггеры. */
export async function getFinDb() {
  const db = new DatabaseSync(FIN_DB_PATH, { readOnly: false });
  ensureAuditTriggers(db); // 🔒 защита: каждая таблица получила _audit-триггеры
  return db;
}

export { FIN_DB_PATH };
