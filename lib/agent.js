// Запуск агентов экосистемы (wb/ozon/fin/avito) как локальных Python-процессов.
// Веб-вкладка «Агенты» вызывает `python run.py ... --json` и показывает результат.
//
// С 2026-06-27: параметризация по ключу агента. Конфиг (dir/proposalsFile)
// берётся из lib/agents/registry.js. Обратная совместимость: runAgent(args)
// без ключа агента → wb (как было). Переопределение путей — через env
// (WB_AGENT_DIR / OZON_AGENT_DIR / FIN_AGENT_DIR / AVITO_AGENT_DIR).
//
// Старый путь Yandex.Disk устарел (синк отключён 2026-06-18, перенос в C:\Agents\).

import { spawn, execFileSync } from "node:child_process";
import { getAgent, proposalsPath } from "./agents/registry";

const PYTHON = process.env.WB_AGENT_PYTHON || "python";

// Устаревший экспорт getAgentDir() — для обратной совместимости со старым кодом,
// который ждёт путь к WB-агенту. Новый код должен использовать registry.getAgent(key).
export async function getAgentDir() {
  return getAgent("wb").dir();
}

// proposalsPath реэкспортируется из registry (поддерживает agentKey, дефолт 'wb'
// задаёт вызывающий код). Боевые вызовы в apply/route.js передают agent явно.
export { proposalsPath };

// Из вывода агента берём ПОСЛЕДНЮЮ строку, которая разбирается как JSON.
// Агент с --json печатает JSON одной строкой в конце, но в mock-режиме перед
// ним могут быть служебные строки ([MOCK] ...) — их пропускаем.
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

// Запускает `python run.py <args...>` в папке агента.
// Возвращает { code, stdout, stderr }. Принудительно UTF-8, иначе на Windows
// агент падает при печати кириллицы/эмодзи (консоль в cp1251).
//
// agentKey — ключ агента из реестра ('wb'|'ozon'|'fin'|'avito'); дефолт 'wb'.
// Для обратной совместимости со старыми вызовами runAgent(args): если первый
// аргумент — массив, считаем что агент не передан (это wb).
export async function runAgent(agentKeyOrArgs, maybeArgs) {
  let agentKey, args;
  if (Array.isArray(agentKeyOrArgs)) {
    // Старый формат: runAgent(args) → wb.
    agentKey = "wb";
    args = agentKeyOrArgs;
  } else {
    agentKey = agentKeyOrArgs || "wb";
    args = maybeArgs || [];
  }
  const agentDir = getAgent(agentKey).dir();
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ["run.py", ...args], {
      cwd: agentDir,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf-8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf-8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// =====================================================================
//  Импорт WB-выгрузки из uploads.db в боевую wb_data.db (заявка №32/№33).
//  wb-rnp-agent реализовал wb_import.py — standalone CLI, вызывается как:
//    python wb_import.py <file_id>     # file_id из uploads.db
//    python wb_import.py --dry-run <src>  # диагностика без записи
//  Скрипт: валидирует формат, льёт в finance_report (идемпотентно, rrd_id<0
//  маркер «из файла»), пересчитывает order_costs/sku_costs за период.
//  Возвращает { code, stdout, stderr }. code=0 успех, не-0 — провал/отказ.
// =====================================================================
// С 2026-06-24 wb-rnp-agent физически объединён с дашбордом в одного агента:
// сборщик WB переехал в collector_wb (рядом с app/lib). Старая папка
// /opt/agents/wb-rnp-agent архивирована. Override через env WB_RNP_AGENT_DIR оставлен.
const WB_RNP_DIR =
  process.env.WB_RNP_AGENT_DIR || "/opt/agents/data-presenter-agent/collector_wb";

export async function runWbImport(args) {
  // execFileSync (синхронный) — надёжнее spawn в Next.js route handlers.
  // spawn в контексте роута порой не доезжает stdout (баг bundler'а/dev-server).
  // execFileSync блокирует до завершения и возвращает Buffer stdout целиком.
  // Импорт WB-выгрузки — редкая операция (раз в день), блокировка допустима.
  try {
    const out = execFileSync(PYTHON, ["wb_import.py", ...args], {
      cwd: WB_RNP_DIR,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      encoding: "utf-8",
      // Импорт + пересчёт order_costs может занять до минуты на больших файлах.
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout: out, stderr: "" };
  } catch (e) {
    // execFileSync при ненулевом exit кидает ошибку с stdout/stderr/code внутри.
    return {
      code: e.status != null ? e.status : 1,
      stdout: e.stdout ? String(e.stdout) : "",
      stderr: (e.stderr ? String(e.stderr) : "") + (e.message || ""),
    };
  }
}

export { WB_RNP_DIR };
