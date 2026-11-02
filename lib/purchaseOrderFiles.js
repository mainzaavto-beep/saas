// lib/purchaseOrderFiles.js — документы заказа закупки: накладные карго и фабрик (02.11.2026).
// Видит ТОЛЬКО владелец кабинета (решение владельца: менеджеры не должны видеть контакты поставщиков) —
// роут app/api/cabinets/[id]/purchase-orders/files (requireRole 'owner'), таблица tenant.purchase_order_files
// (миграция 076). Здесь чистые правила: тип по расширению (присланному mime не верим), размер, имя файла,
// Content-Disposition; stripOwnerOnly — поля заказа, которые не-владельцу не отдаются.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_KINDS = { cargo: "Карго", factory: "Фабрика", other: "Прочее" };

// inline — можно открыть в браузере (PDF/картинки); остальное — только скачивание. HTML/SVG нет вовсе.
const TYPES = {
  pdf: ["application/pdf", true],
  jpg: ["image/jpeg", true], jpeg: ["image/jpeg", true], png: ["image/png", true], webp: ["image/webp", true],
  heic: ["image/heic", false], heif: ["image/heif", false],
  xls: ["application/vnd.ms-excel", false],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", false],
  doc: ["application/msword", false],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", false],
};
export const ACCEPT = Object.keys(TYPES).map((e) => `.${e}`).join(",");

export function cleanFileName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() || "";
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
}

export function fileType(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  const t = m && TYPES[m[1].toLowerCase()];
  return t ? { mime: t[0], inline: t[1] } : null;
}

export function validateFileMeta({ name, size, kind }) {
  if (!FILE_KINDS[kind]) return { ok: false, error: "тип документа: карго, фабрика или прочее" };
  const file_name = cleanFileName(name);
  if (!file_name) return { ok: false, error: "нет имени файла" };
  const t = fileType(file_name);
  if (!t) return { ok: false, error: `такой тип файла нельзя: можно ${ACCEPT.replaceAll(",", ", ")}` };
  const n = Number(size);
  if (!(n > 0)) return { ok: false, error: "файл пустой" };
  if (n > MAX_FILE_BYTES) return { ok: false, error: "файл больше 10 МБ" };
  return { ok: true, value: { file_name, mime: t.mime, kind, inline: t.inline } };
}

// RFC 6266: ascii-запасное имя + filename* в UTF-8 (кириллица).
export function contentDisposition(name, inline) {
  const ascii = cleanFileName(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(cleanFileName(name))}`;
}

// Поля заказа только для владельца. Возвращает копию; исходный объект не трогает.
export function stripOwnerOnly(order, role) {
  if (role === "owner" || !order) return order;
  const { supplier_contact, ...rest } = order;
  void supplier_contact;
  return rest;
}
