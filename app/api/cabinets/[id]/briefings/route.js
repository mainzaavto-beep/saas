import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

// =====================================================================
//  /api/briefings — утренний брифинг (ежедневный анализ от агентов).
//  Источник: таблица briefings в agent_memory.db, наполняется
//  scripts/morning_brief.py (задача Планировщика «Morning Briefing 8:00»).
//
//  GET            — последний брифинг (за вчера или последний доступный).
//  GET ?date=...  — брифинг за конкретную дату (YYYY-MM-DD).
//  GET ?limit=N   — последние N брифингов (для истории/календаря).
// =====================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MEMORY_DB = process.env.MEMORY_DB_PATH || "/opt/agentsDB/agent_memory.db";

function db() {
  const d = new DatabaseSync(MEMORY_DB, { readOnly: true });
  // Если таблицы ещё нет — вернём пустой ответ (брифинг ещё не прогонялся).
  return d;
}

function tableExists(d) {
  try {
    const r = d.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='briefings'"
    ).get();
    return !!r;
  } catch {
    return false;
  }
}

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const dateQ = url.searchParams.get("date");
  const limitQ = Number(url.searchParams.get("limit") || 0);

  try {
    const d = db();
    if (!tableExists(d)) {
      return Response.json({ available: false, briefing: null });
    }

    if (limitQ > 0) {
      // Список последних N (без тяжёлого agents_json — для календаря/истории).
      // mode может отсутствовать в старых строках (до правки 2026-07-02) — COALESCE.
      const rows = d
        .prepare(
          "SELECT id, report_date, generated_at, status, COALESCE(mode,'daily') AS mode, " +
            "substr(narrative,1,160) AS preview " +
            "FROM briefings ORDER BY report_date DESC LIMIT ?"
        )
        .all(limitQ);
      return Response.json({ available: true, briefings: rows });
    }

    let row;
    if (dateQ) {
      row = d
        .prepare(
          "SELECT id, report_date, generated_at, narrative, agents_json, status, COALESCE(mode,'daily') AS mode " +
            "FROM briefings WHERE report_date=?"
        )
        .get(dateQ);
    } else {
      // Последний по дате.
      row = d
        .prepare(
          "SELECT id, report_date, generated_at, narrative, agents_json, status, COALESCE(mode,'daily') AS mode " +
            "FROM briefings ORDER BY report_date DESC LIMIT 1"
        )
        .get();
    }

    if (!row) {
      return Response.json({ available: true, briefing: null });
    }

    // Распарсим agents_json (массив отчётов по агентам) для удобства фронта.
    let agents = [];
    try {
      agents = row.agents_json ? JSON.parse(row.agents_json) : [];
    } catch {
      agents = [];
    }

    return Response.json({
      available: true,
      briefing: {
        id: row.id,
        report_date: row.report_date,
        generated_at: row.generated_at,
        status: row.status,
        mode: row.mode || "daily",
        narrative: row.narrative,
        agents,
      },
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
});