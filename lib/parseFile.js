import { readFileSync } from "fs";
import { createRequire } from "node:module";
import Papa from "papaparse";
import ExcelJS from "exceljs";

// pdf-parse — старый CJS-пакет без default export в ESM-интеропе.
// Грузим через createRequire, чтобы работал и в CommonJS, и в ESM (Next bundler).
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

// =====================================================================
//  Парсеры форматов → единая структура { tables:[{name, columns, rows}] }.
//  Вызывается из POST /api/agent/upload после сохранения файла на диск.
//  Результат заливается в uploads.db через lib/uploads.js importTable().
//
//  Единый контракт:
//    name    — имя таблицы БЕЗ префикса (префикс f_<id> добавляет вызывающий)
//    columns — [{name, type}], type ∈ {text|integer|real}
//    rows    — массив массивов значений по порядку колонок
// =====================================================================

const MAX_ROWS = 50000; // лимит строк на таблицу (большие файлы режем)

/**
 * Главная точка: разбирает файл по типу.
 *   kind     — 'csv' | 'xlsx' | 'pdf' | 'text'
 *   filePath — путь к бинарнику на диске
 *   baseName — базовое имя таблиц (без f_ ; напр. id файла)
 * Возвращает { tables:[{name, columns, rows}], errors:[...] }.
 */
export async function parseFile(kind, filePath, baseName) {
  const errors = [];
  let tables = [];
  try {
    if (kind === "csv" || kind === "text") {
      tables = await parseCsv(filePath, baseName);
    } else if (kind === "xlsx") {
      tables = await parseXlsx(filePath, baseName);
    } else if (kind === "pdf") {
      tables = await parsePdf(filePath, baseName);
    } else {
      errors.push(`неподдерживаемый тип: ${kind}`);
    }
  } catch (e) {
    errors.push(String(e?.message || e));
  }
  return { tables, errors };
}

// ---------------------------------------------------------------------
//  CSV / TXT
// ---------------------------------------------------------------------

async function parseCsv(filePath, baseName) {
  // WB-выгрузки часто в cp1251 с разделителем ';' или ','. Papa умеет
  // авто-детект и BOM. Читаем как текст, чтобы дать papaparse целиком.
  let text;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    // если utf-8 не читается — пробуем latin1 как фолбэк (cp1251 ≈)
    const buf = readFileSync(filePath);
    text = buf.toString("latin1");
  }
  return new Promise((resolve) => {
    Papa.parse(text, {
      skipEmptyLines: "greedy",
      dynamicTyping: false, // типизацию делаем сами — надёжнее для SQL
      complete: (res) => {
        const rows = (res.data || []).filter(
          (r) => Array.isArray(r) && r.some((c) => String(c).trim() !== "")
        );
        if (!rows.length) return resolve([]);
        const header = rows[0].map((h, i) => String(h ?? `col_${i + 1}`));
        const cols = header.map((h) => ({ name: h, type: "text" }));
        const body = rows.slice(1, MAX_ROWS + 1);
        // Унификация: все строки как массивы значений.
        const normRows = body.map((r) =>
          header.map((_, i) => (r[i] === undefined ? null : r[i]))
        );
        resolve([{ name: baseName, columns: cols, rows: normRows }]);
      },
      error: (err) => resolve([]),
    });
  });
}

// ---------------------------------------------------------------------
//  XLSX / XLS  (exceljs)
// ---------------------------------------------------------------------

async function parseXlsx(filePath, baseName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const tables = [];
  let sheetIdx = 0;
  for (const ws of wb.worksheets) {
    // Пропускаем полностью пустые листы.
    if (!ws.rowCount || ws.actualRowCount === 0) {
      sheetIdx++;
      continue;
    }
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        vals[colNumber - 1] = cellToVal(cell);
      });
      rows.push(vals);
    });
    if (!rows.length) {
      sheetIdx++;
      continue;
    }
    const maxCols = Math.max(...rows.map((r) => r.length));
    // Заголовок = первая непустая строка.
    const header = [];
    for (let i = 0; i < maxCols; i++) {
      header[i] = String(rows[0][i] ?? `col_${i + 1}`);
    }
    const cols = header.map((h) => ({ name: h, type: "text" }));
    const body = rows.slice(1, MAX_ROWS + 1).map((r) =>
      header.map((_, i) => (r[i] === undefined ? null : r[i]))
    );
    tables.push({
      name: `${baseName}_${sheetIdx}`,
      columns: cols,
      rows: body,
      sheetName: ws.name,
    });
    sheetIdx++;
  }
  return tables;
}

async function cellToVal(cell) {
  if (cell.value === null || cell.value === undefined) return null;
  // Формула — берём результат
  if (cell.value && typeof cell.value === "object") {
    if ("result" in cell.value) return cell.value.result;
    if ("text" in cell.value) return cell.value.text;
    if ("richText" in cell.value) {
      return cell.value.richText.map((t) => t.text).join("");
    }
    if (cell.value instanceof Date) return cell.value.toISOString();
    return String(cell.value);
  }
  if (cell.value instanceof Date) return cell.value.toISOString();
  return cell.value;
}

// ---------------------------------------------------------------------
//  PDF  (pdf-parse, только текстовые — не OCR)
// ---------------------------------------------------------------------

async function parsePdf(filePath, baseName) {
  const buf = readFileSync(filePath);
  const data = await pdfParse(buf, { max: 0 });
  const text = String(data.text || "");
  if (!text.trim()) {
    // Скорее всего скан — агенту подскажем через ошибку (пользователь
    // может переслать как картинку через vision).
    throw new Error(
      "PDF без текстового слоя (вероятно скан). Отправьте как картинку."
    );
  }
  // Разбиваем по строкам → таблица (line_no, text).
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cols = [
    { name: "line_no", type: "integer" },
    { name: "text", type: "text" },
  ];
  const rows = lines.slice(0, MAX_ROWS).map((l, i) => [i + 1, l]);
  return [{ name: baseName, columns: cols, rows }];
}
