
// =====================================================================
//  lib/decisionsDb.js — подключение к decisions.db (БЕЗ readOnly — UI пишет).
//
//  ГРАНИЦА ЗАПИСИ (критично, правило 6): data-presenter пишет ТОЛЬКО в
//  таблицу `agent_requests` (трекер заявок между агентами, DB-ификация §6.5
//  AGENTS.md от 2026-06-22). Таблица `decisions` (знания/§9/§10) —
//  НЕ ТРОГАТЬ, она пишется только через memory.py CLI агентами/координатором.
//
//  Образец: lib/finDb.js. НЕ singleton — для RW безопаснее открывать/закрывать
//  connection на каждый запрос.
// =====================================================================

const DECISIONS_DB_PATH =
  process.env.DECISIONS_DB_PATH || "/opt/agentsDB/decisions.db";

/** Открывает НОВОЕ соединение с decisions.db на чтение/запись. */
export async function getDecisionsDb() {
  return new DatabaseSync(DECISIONS_DB_PATH, { readOnly: false });
}

export { DECISIONS_DB_PATH };
