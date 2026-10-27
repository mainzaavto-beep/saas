// lib/purchaseNeedXlsx.js — выгрузка страницы «Потребность» в Excel (07.10.2026).
// Берёт готовый результат loadPurchaseNeed (те же цифры, что на экране) и строит .xlsx.
// Фильтры экрана «поиск» и «только к закупке» повторяет filterPurchaseNeedRows — как на клиенте.
import ExcelJS from "exceljs";

const PF_LABEL = { all: "WB + Ozon", wb: "Wildberries", ozon: "Ozon" };

export function filterPurchaseNeedRows(rows, { q = "", onlyBuy = false } = {}) {
  let list = rows || [];
  const s = String(q).trim().toLowerCase();
  if (s) list = list.filter((r) => (r.name || "").toLowerCase().includes(s)
    || [...r.skus.wb, ...r.skus.ozon].some((k) => String(k).includes(s))
    || (r.offers?.ozon || []).some((o) => o.toLowerCase().includes(s)));
  if (onlyBuy) list = list.filter((r) => r.needQty > 0);
  return list;
}

export async function buildPurchaseNeedXlsx(data, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Потребность", { views: [{ state: "frozen", ySplit: 4 }] });
  const cols = [
    { h: "Товар", w: 48 },
    { h: "Артикулы WB", w: 16 },
    { h: "Артикулы Ozon", w: 16 },
    { h: "Артикул продавца Ozon", w: 26 },
    { h: "На МП, шт", w: 11, fmt: "#,##0" },
    { h: "Свой склад, шт", w: 13, fmt: "#,##0" },
    { h: "В пути, шт", w: 11, fmt: "#,##0" },
    { h: "Заказано у поставщика, шт", w: 14, fmt: "#,##0" },
    { h: `Заказов за ${data.windowDays} дн`, w: 13, fmt: "#,##0" },
    { h: "Продаж/день", w: 12, fmt: "#,##0.0" },
    { h: "Хватит на, дн", w: 12, fmt: "#,##0" },
    { h: "Закупить, шт", w: 12, fmt: "#,##0" },
    { h: "Себестоимость, ₽/шт", w: 16, fmt: "#,##0.00" },
    { h: "Сумма, ₽", w: 14, fmt: "#,##0" },
    { h: "Закупить с учётом заказанного, шт", w: 16, fmt: "#,##0" },
    { h: "Сумма с учётом заказанного, ₽", w: 16, fmt: "#,##0" },
  ];
  ws.columns = cols.map((c) => ({ width: c.w }));

  ws.getCell("A1").value = "Потребность в закупке";
  ws.getCell("A1").font = { bold: true, size: 14 };
  const sd = data.stockDates || {};
  ws.getCell("A2").value = `Площадка: ${PF_LABEL[data.platform] || data.platform} · продажи за ${data.windowDays} дн (по вчера) · хватить на ${data.horizonDays} дн · срез WB ${sd.wb || "—"}, Ozon ${sd.ozon || "—"}`;
  ws.getCell("A2").font = { color: { argb: "FF666666" } };

  const head = ws.getRow(4);
  cols.forEach((c, i) => { head.getCell(i + 1).value = c.h; });
  head.font = { bold: true };
  head.alignment = { vertical: "middle", wrapText: true };
  head.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEDED" } }; });

  for (const r of rows) {
    const row = ws.addRow([
      r.name,
      r.skus.wb.join(", "),
      r.skus.ozon.join(", "),
      (r.offers?.ozon || []).join(", "),
      r.mpQty,
      r.ownQty,
      r.transitQty,
      r.orderedQty,
      r.ordersQty,
      r.velocity,
      r.coverageDays == null ? null : Math.floor(r.coverageDays),
      r.needQty,
      r.unitCost,
      r.needQty > 0 ? r.needCost : null,
      r.needQtyOrdered,
      r.needQtyOrdered > 0 ? r.needCostOrdered : null,
    ]);
    cols.forEach((c, i) => { if (c.fmt) row.getCell(i + 1).numFmt = c.fmt; });
    if (r.needQty > 0) row.getCell(12).font = { bold: true };
    if (r.needQtyOrdered > 0) row.getCell(15).font = { bold: true };
  }

  const toBuy = rows.filter((r) => r.needQty > 0);
  const total = ws.addRow([
    `Итого: ${rows.length} товаров, к закупке ${toBuy.length}`, null, null, null,
    rows.reduce((a, r) => a + r.mpQty, 0),
    rows.reduce((a, r) => a + r.ownQty, 0),
    rows.reduce((a, r) => a + r.transitQty, 0),
    rows.reduce((a, r) => a + r.orderedQty, 0),
    rows.reduce((a, r) => a + r.ordersQty, 0),
    null, null,
    toBuy.reduce((a, r) => a + r.needQty, 0),
    null,
    toBuy.reduce((a, r) => a + (r.needCost || 0), 0),
    rows.reduce((a, r) => a + r.needQtyOrdered, 0),
    rows.reduce((a, r) => a + (r.needQtyOrdered > 0 ? r.needCostOrdered || 0 : 0), 0),
  ]);
  total.font = { bold: true };
  cols.forEach((c, i) => { if (c.fmt) total.getCell(i + 1).numFmt = c.fmt; });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
