import { execFileSync } from "node:child_process";

// =====================================================================
//  lib/finProc.js — запуск sibling-проекта financial_agent как процесса.
//
//  Зеркало lib/agent.js (runWbImport), но для финансового директора.
//  Почему отдельный модуль (а не расширение lib/agent.js): agent.js —
//  WB-специфика (dir-константы WB_AGENT_*, комменты про wb_agent/wb-rnp).
//  Конвенция репо: один helper на агент-dir. fin_agent — отдельный проект
//  со своими заботами (финансы, не WB), свой модуль чище.
//
//  Используется для:
//    • /api/calendar (№39) — run.py calendar --json (эталон платёжного календаря,
//      формулы НЕ на JS — грабля #61: повторяем Python-эталон).
//    • /api/purchases (№40) — run.py backup push --only purchases (Sheets backup).
//
//  execFileSync (синхронный) выбран сознательно — как в runWbImport: spawn в
//  контексте Next.js route handler'а порой не доезжает stdout (баг bundler'а).
//  Эти вызовы редкие (календарь/backup — не чаще раза в минуту/день), блокировка
//  до завершения допустима и надёжнее.
// =====================================================================

const FIN_AGENT_DIR = process.env.FIN_AGENT_DIR || "/opt/agents/financial_agent";
const PYTHON = process.env.FIN_AGENT_PYTHON || "python";

export async function getFinAgentDir() {
  return FIN_AGENT_DIR;
}

/**
 * Запускает `python run.py <args...>` в папке financial_agent.
 * Возвращает { code, stdout, stderr }. code=0 успех, не-0 — провал.
 * Принудительно UTF-8 (PYTHONUTF8 + PYTHONIOENCODING + encoding) — иначе на
 * Windows кириллица/эмодзи из fin-агента ломаются в cp1251.
 */
export async function runFin(args) {
  try {
    const out = execFileSync(PYTHON, ["run.py", ...args], {
      cwd: FIN_AGENT_DIR,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      encoding: "utf-8",
      // backup push (Google Sheets API) может тянуться ~минуту; calendar — секунды.
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout: out, stderr: "" };
  } catch (e) {
    // execFileSync при ненулевом exit кидает ошибку с stdout/stderr/status внутри.
    return {
      code: e.status != null ? e.status : 1,
      stdout: e.stdout ? String(e.stdout) : "",
      stderr: (e.stderr ? String(e.stderr) : "") + (e.message || ""),
    };
  }
}

/**
 * Платёжный календарь (№39) — эталон fin/payment_calendar.py:build_calendar.
 * Возвращает {start_date, starting_balance, weeks:[{week, fact_income,
 * fact_expense, plan_income, plan_expense, net, cumulative, at_risk}]}.
 * horizonWeeks — горизонт в неделях (4/8/12). null/0 → дефолт fin (8).
 * Бросает Error при провале exec или если JSON не распарсился.
 */
export async function runFinCalendar(horizonWeeks = null) {
  const args = ["calendar", "--json"];
  if (horizonWeeks && Number.isFinite(Number(horizonWeeks)) && Number(horizonWeeks) > 0) {
    args.push("--horizon-weeks", String(Math.round(Number(horizonWeeks))));
  }
  const { code, stdout, stderr } = runFin(args);
  if (code !== 0) {
    throw new Error(`fin calendar exit ${code}: ${(stderr || "").trim() || (stdout || "").trim()}`);
  }
  const parsed = parseLastJson(stdout);
  if (!parsed || !Array.isArray(parsed.weeks)) {
    throw new Error(`fin calendar: некорректный JSON. stdout=${(stdout || "").slice(-400)}`);
  }
  return parsed;
}

/**
 * Рекомендация закупки от оборачиваемости (заявка 2026-06-27, fin/turnover.py).
 * Считает от ФАКТИЧЕСКИХ продаж за окно: days_of_cover = stock/avg_daily,
 * recommend если < lead_time. Гибридная модель — эталон в Python, дашборд
 * только вызывает (как calendar).
 *
 * Возвращает { count, window, lead_time, replenish, totals:{...}, items:[...] }.
 * items — TurnoverNeed: { nm_id, product_id, sku_label, platform, sold_window,
 *   avg_daily, stock_now, days_of_cover, window_days, lead_time, replenish_cycle,
 *   recommend, qty_needed, budget_rub, has_cogs, unit_cost }.
 * Бросает Error при провале exec или некорректном JSON.
 */
export async function runFinTurnover({ window = 7, leadTime = 45, replenish = 30, platform = null } = {}) {
  const args = ["turnover", "--json",
    "--window", String(Math.max(1, Math.round(Number(window) || 7))),
    "--lead-time", String(Math.max(1, Math.round(Number(leadTime) || 45))),
    "--replenish", String(Math.max(1, Math.round(Number(replenish) || 30))),
  ];
  if (platform && ["WB", "OZON"].includes(String(platform).toUpperCase())) {
    args.push("--platform", String(platform).toUpperCase());
  }
  const { code, stdout, stderr } = runFin(args);
  if (code !== 0) {
    throw new Error(`fin turnover exit ${code}: ${(stderr || "").trim() || (stdout || "").trim().slice(-400)}`);
  }
  // run.py turnover --json печатает ОДИН JSON-документ (indent=2), без баннеров.
  // parseLastJson тут не подходит (он ищет последнюю однострочную JSON-строку,
  // а indent-вывод многострочный). Парсим весь stdout.
  let parsed = null;
  try {
    parsed = JSON.parse((stdout || "").trim());
  } catch {
    // Fallback: вдруг есть префикс-баннер — попробуем найти первый '{'.
    const idx = (stdout || "").indexOf("{");
    if (idx >= 0) {
      try { parsed = JSON.parse((stdout || "").slice(idx)); } catch { parsed = null; }
    }
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error(`fin turnover: некорректный JSON. stdout=${(stdout || "").slice(-400)}`);
  }
  return parsed;
}

/**
 * План платежей — агрегат всех источников по неделям (заявка 2026-06-27).
 * Расширение calendar: план-расход разбит по категориям (purchase/opex/tax/ads),
 * план-доход + авто-поступления из ДДС. Эталон = fin/payment_plan.py.
 *
 * Возвращает { start_date, starting_balance, weeks:[{
 *   week, fact_income, fact_expense, plan_income, plan_expense,
 *   plan_exp_breakdown:{purchase,opex,tax,ads}, net, cumulative, at_risk }] }.
 * Бросает Error при провале exec или некорректном JSON.
 */
export async function runFinPaymentPlan(horizonWeeks = 8) {
  const args = ["payment-plan", "--json"];
  if (horizonWeeks && Number.isFinite(Number(horizonWeeks)) && Number(horizonWeeks) > 0) {
    args.push("--horizon-weeks", String(Math.round(Number(horizonWeeks))));
  }
  const { code, stdout, stderr } = runFin(args);
  if (code !== 0) {
    throw new Error(`fin payment-plan exit ${code}: ${(stderr || "").trim() || (stdout || "").trim().slice(-400)}`);
  }
  // run.py payment-plan --json печатает один JSON-документ (indent=2).
  let parsed = null;
  try {
    parsed = JSON.parse((stdout || "").trim());
  } catch {
    const idx = (stdout || "").indexOf("{");
    if (idx >= 0) { try { parsed = JSON.parse((stdout || "").slice(idx)); } catch { parsed = null; } }
  }
  if (!parsed || !Array.isArray(parsed.weeks)) {
    throw new Error(`fin payment-plan: некорректный JSON. stdout=${(stdout || "").slice(-400)}`);
  }
  return parsed;
}

/**
 * Backup таблиц fin_data.db → Google Sheets (контракт №37, дашборд-first).
 * only = 'purchases' | 'self_buyouts' | 'sales_plan' | 'dds' | 'balance'
 * (или null = все 5). Возвращает { code, stdout } — текст лога fin-агента.
 * Не бросает: даже при провале возвращает {code, stdout, stderr, ok:false}.
 */
export async function runFinBackup(only = null) {
  const args = ["backup", "push"];
  if (only) args.push("--only", only);
  const res = runFin(args);
  return { ...res, ok: res.code === 0 };
}

// Берёт последнюю строку stdout, парсящуюся как JSON (пропуская диагностические
// строки [MOCK]/баннеры fin-агента). Зеркало parseLastJson из lib/agent.js.
export async function parseLastJson(stdout) {
  const lines = (stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("{") || lines[i].startsWith("[")) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        /* не та строка — идём дальше */
      }
    }
  }
  return null;
}
