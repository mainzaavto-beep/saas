// lib/__tests__/buyout.test.mjs — процент выкупа WB когортно по дате заказа
// (спека docs/superpowers/specs/2026-10-11-buyout-page-design.md).
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyWbOrder, classifyOzonPosting, classifyRow, buyoutStats, aggregateBuyout, weeklyBuyout, weekStart, sortSizes,
  CANCEL_SETTLE_DAYS, OZ_CANCEL_SETTLE_FROM_ORDER_DAYS, MIN_RESOLVED, todayMsk,
  OZ_REFUSED_REASON_PREFIXES, OZ_OZONSIDE_REASON_PREFIXES,
} from "../buyout.js";

const ASOF = "2026-10-12";
const base = { srid: "x", nmId: 1, article: "A1", name: "Бюстгальтер", size: "M", orderDate: "2026-09-01",
  isCancel: false, cancelAt: null, hasSale: false, hasReturn: false, refusedLogistics: false, selfBuyout: false };
const row = (o) => ({ ...base, ...o });

test("порядок вёдер: самовыкуп важнее всего, возврат важнее продажи", () => {
  assert.equal(classifyWbOrder(row({ selfBuyout: true, hasSale: true }), ASOF), "self");
  assert.equal(classifyWbOrder(row({ hasSale: true, hasReturn: true }), ASOF), "returned");
  assert.equal(classifyWbOrder(row({ hasSale: true }), ASOF), "sold");
  assert.equal(classifyWbOrder(row({ isCancel: true, refusedLogistics: true }), ASOF), "refused");
});

test("отмена без логистики: старше 7 дней — до отгрузки, моложе или ровно 7 — в пути", () => {
  assert.equal(CANCEL_SETTLE_DAYS, 7);
  assert.equal(classifyWbOrder(row({ isCancel: true, cancelAt: "2026-10-04T00:00:00" }), ASOF), "cancelledPre");
  assert.equal(classifyWbOrder(row({ isCancel: true, cancelAt: "2026-10-05T00:00:00" }), ASOF), "pending");
  assert.equal(classifyWbOrder(row({ isCancel: true, cancelAt: null }), ASOF), "pending");
});

test("заказ без развязки — в пути", () => {
  assert.equal(classifyWbOrder(row({}), ASOF), "pending");
});

test("todayMsk: формат YYYY-MM-DD", () => {
  assert.match(todayMsk(), /^\d{4}-\d{2}-\d{2}$/);
});

test("buyoutStats: знаменатель без в-пути и отмен до отгрузки; null при нуле", () => {
  const s = buyoutStats({ ordered: 10, self: 1, returned: 1, sold: 3, refused: 4, cancelledPre: 1, pending: 0 });
  assert.equal(s.resolved, 8);
  assert.equal(s.buyoutPct, 37.5);
  assert.equal(s.immature, false);
  assert.equal(s.lowSample, true);
  const z = buyoutStats({ ordered: 2, self: 0, returned: 0, sold: 0, refused: 0, cancelledPre: 0, pending: 2 });
  assert.equal(z.buyoutPct, null);
  assert.equal(z.pendingShare, 1);
  assert.equal(z.immature, true);
});

test("lowSample снимается с MIN_RESOLVED доехавших; immature при доле в пути > 5 %", () => {
  const s = buyoutStats({ ordered: 22, self: 0, returned: 0, sold: MIN_RESOLVED, refused: 0, cancelledPre: 0, pending: 2 });
  assert.equal(s.lowSample, false);
  assert.equal(s.immature, true); // 2/22 ≈ 9 %
});

test("aggregateBuyout: размеры суммируются в товар, товары — в KPI", () => {
  const rows = [
    row({ srid: "1", size: "S", hasSale: true }),
    row({ srid: "2", size: "S", isCancel: true, refusedLogistics: true }),
    row({ srid: "3", size: "M", hasSale: true }),
    row({ srid: "4", size: "M", hasSale: true, hasReturn: true }),
    row({ srid: "5", nmId: 2, size: "0", hasSale: true }),
  ];
  const { kpi, items } = aggregateBuyout(rows, ASOF);
  assert.equal(kpi.ordered, 5);
  assert.equal(kpi.sold, 3);
  assert.equal(kpi.resolved, 5);
  assert.equal(kpi.buyoutPct, 60);
  const bra = items.find((i) => i.nmId === 1);
  assert.equal(bra.ordered, 4);
  assert.deepEqual(bra.sizes.map((s) => s.size), ["S", "M"]);
  assert.equal(bra.sizes[0].buyoutPct, 50);
  assert.equal(bra.sizes[1].returned, 1);
  for (const k of ["ordered", "sold", "refused", "returned", "pending", "cancelledPre", "self"]) {
    assert.equal(bra.sizes.reduce((a, s) => a + s[k], 0), bra[k], k);
  }
  assert.deepEqual(items.find((i) => i.nmId === 2).sizes, []);
});

test("sortSizes: буквенные по росту, числовые по числе, прочие в конце", () => {
  assert.deepEqual(sortSizes(["XL", "S", "M", "XS", "L"]), ["XS", "S", "M", "L", "XL"]);
  assert.deepEqual(sortSizes(["75B", "70A", "80C"]), ["70A", "75B", "80C"]);
  assert.deepEqual(sortSizes(["M", "ONE", "S"]), ["S", "M", "ONE"]);
});

test("weekStart — понедельник", () => {
  assert.equal(weekStart("2026-10-12"), "2026-10-12"); // понедельник
  assert.equal(weekStart("2026-10-11"), "2026-10-05"); // воскресенье
  assert.equal(weekStart("2026-10-08"), "2026-10-05");
});

test("weeklyBuyout: 13 недель подряд с пустыми, размеры по неделям, фильтр товара", () => {
  const rows = [
    row({ srid: "1", orderDate: "2026-10-06", size: "S", hasSale: true }),
    row({ srid: "2", orderDate: "2026-10-07", size: "M", isCancel: true, refusedLogistics: true }),
    row({ srid: "3", orderDate: "2026-09-29", nmId: 2, size: "0", hasSale: true }),
  ];
  const all = weeklyBuyout(rows, ASOF);
  assert.equal(all.weeks.length, 13);
  assert.equal(all.weeks[12].week, "2026-10-12");
  assert.equal(all.weeks[11].week, "2026-10-05");
  assert.equal(all.weeks[11].resolved, 2);
  assert.equal(all.weeks[10].sold, 1);
  assert.equal(all.weeks[0].ordered, 0);
  const one = weeklyBuyout(rows, ASOF, { nmId: 1 });
  assert.equal(one.weeks[10].ordered, 0);
  assert.deepEqual(one.sizeList, ["S", "M"]);
  assert.equal(one.weeks[11].sizes.S.buyoutPct, 100);
  assert.equal(one.weeks[11].sizes.M.buyoutPct, 0);
});

const oz = (o) => ({ platform: "ozon", srid: "p", nmId: 500, article: "CAM-1", name: "Камера", size: "0",
  orderDate: "2026-09-01", status: "delivered", cancelAt: null, isReturn: false, selfBuyout: false, ...o });

test("Ozon: доставлено — выкуп, доставлено+возврат — возврат, самовыкуп важнее", () => {
  assert.equal(classifyOzonPosting(oz({}), ASOF), "sold");
  assert.equal(classifyOzonPosting(oz({ isReturn: true }), ASOF), "returned");
  assert.equal(classifyOzonPosting(oz({ selfBuyout: true }), ASOF), "self");
});

test("Ozon: отмена с обратной логистикой — невыкуп; без неё — до отгрузки через 7 дней (по cancelAt)", () => {
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", isReturn: true }), ASOF), "refused");
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", cancelAt: "2026-10-04T10:00:00" }), ASOF), "cancelledPre");
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", cancelAt: "2026-10-05T10:00:00" }), ASOF), "pending");
  // cancelAt=null, orderDate "2026-10-01" (11 дн до ASOF) — моложе OZ_CANCEL_SETTLE_FROM_ORDER_DAYS
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", cancelAt: null, orderDate: "2026-10-01" }), ASOF), "pending");
});

test("Ozon: отмена без даты (cancel_dt/last_change_dt оба NULL) — судим по дате заказа через 30 дней", () => {
  assert.equal(OZ_CANCEL_SETTLE_FROM_ORDER_DAYS, 30);
  // orderDate "2026-09-11" — 31 день до ASOF → до отгрузки
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", cancelAt: null, orderDate: "2026-09-11" }), ASOF), "cancelledPre");
  // orderDate "2026-09-13" — 29 дней до ASOF → ещё в пути
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", cancelAt: null, orderDate: "2026-09-13" }), ASOF), "pending");
});

test("Ozon: причина «доехал, но не взяли» — невыкуп и без обратной логистики", () => {
  const c = (reason, o = {}) => classifyOzonPosting(oz({ status: "cancelled", cancelReason: reason, orderDate: "2026-10-10", ...o }), ASOF);
  assert.equal(c("Покупатель не забрал заказ"), "refused");
  assert.equal(c("Покупатель отказался при вручении: товар не подошел"), "refused");
  assert.equal(c("покупатель ОТКАЗАЛСЯ при вручении: не тот товар"), "refused"); // регистр не важен
  assert.equal(c("Автовозврат: Истек срок хранения отправления"), "refused");
  assert.equal(c("Изменил решение о покупке"), "refused");
  assert.equal(c("Товар не подошёл"), "refused");
});

test("Ozon: «Покупатель отменил заказ» — невыкуп с обратной логистикой, без неё дозревает как отмена без причины", () => {
  // начисление обратной логистики отстаёт (p90 16, p99 27 дн) — свежую отмену в пути нельзя сразу выкидывать из знаменателя
  const c = (o) => classifyOzonPosting(oz({ status: "cancelled", cancelReason: "Покупатель отменил заказ: нашел дешевле", cancelAt: null, ...o }), ASOF);
  assert.equal(c({ orderDate: "2026-10-02", isReturn: true }), "refused");
  assert.equal(c({ orderDate: "2026-10-02" }), "pending");       // 10 дн от заказа, даты отмены нет
  assert.equal(c({ orderDate: "2026-09-11" }), "cancelledPre");  // 31 день от заказа
  assert.equal(c({ orderDate: "2026-09-01", cancelAt: "2026-10-05T10:00:00" }), "pending");      // 7 дн от отмены — ещё ждём
  assert.equal(c({ orderDate: "2026-10-01", cancelAt: "2026-10-04T10:00:00" }), "cancelledPre"); // 8 дн от отмены
  assert.equal(c({ cancelReason: "Покупатель отменил заказ: перенос сроков доставки", orderDate: "2026-10-02" }), "pending");
});

test("Ozon: причины Ozon-стороны/продавца — до отгрузки всегда, даже с обратной логистикой", () => {
  const c = (reason, o = {}) => classifyOzonPosting(oz({ status: "cancelled", cancelReason: reason, orderDate: "2026-10-10", ...o }), ASOF);
  assert.equal(c("Не удалось доставить заказ", { isReturn: true }), "cancelledPre");
  assert.equal(c("Товар закончился на складе", { isReturn: true }), "cancelledPre");
  assert.equal(c("Не удалось обработать заказ"), "cancelledPre");
  assert.equal(c("Вы не отгрузили заказ вовремя", { isReturn: true }), "cancelledPre");
  assert.equal(c("Вы отменили заказ", { isReturn: true }), "cancelledPre");
  // доставлен — причина отмены не играет (её и не бывает), правила delivered прежние
  assert.equal(classifyOzonPosting(oz({ status: "delivered", cancelReason: "Не удалось доставить заказ" }), ASOF), "sold");
});

test("Ozon: пустая причина — прежние правила 7/30 дней", () => {
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", cancelReason: "", cancelAt: null, orderDate: "2026-09-13" }), ASOF), "pending");
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", cancelReason: null, cancelAt: null, orderDate: "2026-09-11" }), ASOF), "cancelledPre");
  assert.equal(classifyOzonPosting(oz({ status: "cancelled", cancelReason: "  ", isReturn: true }), ASOF), "refused");
});

test("Ozon: группы причин — константы", () => {
  assert.ok(OZ_REFUSED_REASON_PREFIXES.includes("покупатель не забрал"));
  assert.ok(OZ_REFUSED_REASON_PREFIXES.some((p) => "изменил решение о покупке/товар не подошёл".startsWith(p)));
  assert.ok(OZ_OZONSIDE_REASON_PREFIXES.includes("не удалось доставить"));
});

test("Ozon: в доставке/ожидании — в пути", () => {
  for (const s of ["delivering", "awaiting_deliver", "awaiting_packaging"]) {
    assert.equal(classifyOzonPosting(oz({ status: s }), ASOF), "pending", s);
  }
});

test("classifyRow: диспетчер по платформе", () => {
  assert.equal(classifyRow(oz({ status: "cancelled", isReturn: true }), ASOF), "refused");
  assert.equal(classifyRow(row({ hasSale: true }), ASOF), "sold");
});

test("aggregateBuyout: WB nm 500 и Ozon product 500 — разные товары", () => {
  const rows = [row({ srid: "w1", nmId: 500, hasSale: true }), oz({ srid: "o1", nmId: 500, status: "cancelled", isReturn: true })];
  const { kpi, items } = aggregateBuyout(rows, ASOF);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.platform).sort(), ["ozon", "wb"]);
  assert.equal(items.find((i) => i.platform === "ozon").refused, 1);
  assert.equal(kpi.sold, 1);
  assert.equal(kpi.refused, 1);
  assert.deepEqual(items.find((i) => i.platform === "ozon").sizes, []);
});

test("weeklyBuyout: фильтр товара учитывает платформу", () => {
  const rows = [row({ srid: "w1", nmId: 500, orderDate: "2026-10-06", hasSale: true }),
    oz({ srid: "o1", nmId: 500, orderDate: "2026-10-06", status: "cancelled", isReturn: true })];
  const w = weeklyBuyout(rows, ASOF, { nmId: 500, platform: "ozon" });
  assert.equal(w.weeks[11].refused, 1);
  assert.equal(w.weeks[11].sold, 0);
  const wb = weeklyBuyout(rows, ASOF, { nmId: 500 });
  assert.equal(wb.weeks[11].sold, 1);
  assert.equal(wb.weeks[11].refused, 0);
});

// --- фильтр «Категория» (20.10.2026) ---
import { itemCategories, categoryFacets, filterByCategory, NO_CATEGORY } from "../buyout.js";

test("категория товара — первая непустая; пустая → «Без категории»", () => {
  const rows = [
    row({ srid: "a", nmId: 1, category: null }), row({ srid: "b", nmId: 1, category: "Белье" }),
    row({ srid: "c", nmId: 2, category: null }),
    { ...row({ srid: "d", nmId: 1, category: "Карты памяти" }), platform: "ozon" },
  ];
  const m = itemCategories(rows);
  assert.equal(m.get("wb:1"), "Белье");
  assert.equal(m.get("wb:2"), NO_CATEGORY);
  assert.equal(m.get("ozon:1"), "Карты памяти"); // тот же nmId на другой площадке — свой товар
  assert.deepEqual(categoryFacets(rows), [["Белье", 1], ["Карты памяти", 1], ["Без категории", 1]]);
});

test("filterByCategory: товар не расщепляется, KPI считается по выбранным", () => {
  const rows = [
    row({ srid: "a", nmId: 1, category: "Белье", hasSale: true }),
    row({ srid: "b", nmId: 1, category: null, refusedLogistics: true, isCancel: true, cancelAt: "2026-09-02" }),
    row({ srid: "c", nmId: 2, category: "Роутеры", hasSale: true }),
  ];
  assert.equal(filterByCategory(rows, []).length, 3);
  const f = filterByCategory(rows, ["Белье"]);
  assert.deepEqual(f.map((r) => r.srid), ["a", "b"]);
  const { kpi, items } = aggregateBuyout(f, ASOF);
  assert.equal(kpi.ordered, 2);
  assert.equal(items.length, 1);
  assert.equal(items[0].category, "Белье");
  assert.equal(filterByCategory(rows, [NO_CATEGORY]).length, 0);
});

// --- примерка (20.10.2026) ---
import { tagFitting, filterByFitting, fittingSummary, ozonBasket, FIT_VALUES } from "../buyout.js";

// Примерка (20.10.2026): строка Ozon-формы — удобнее для разметки, судьба через status.
const ozFit = (o) => ({ platform: "ozon", srid: "p", nmId: 1, name: "Комплект", status: "delivered", isReturn: false,
  selfBuyout: false, orderDate: "2026-09-01", cancelAt: null, cancelReason: null,
  basket: "B1", modelKey: "m:1", variantKey: "1", colorKey: "коричн", sizeKey: "M", sizeLabel: "M", fitEstimated: false, ...o });

test("ozonBasket: номер заказа — две первые части отправления", () => {
  assert.equal(ozonBasket("0107344381-0022-1"), "0107344381-0022");
  assert.equal(ozonBasket("0107344381-0022"), "0107344381-0022");
});

test("tagFitting: размеры / цвета / смешанная / одиночный", () => {
  const rows = tagFitting([
    ozFit({ basket: "S", variantKey: "1", sizeKey: "S", sizeLabel: "S" }), ozFit({ basket: "S", variantKey: "2", sizeKey: "M", sizeLabel: "M" }),
    ozFit({ basket: "C", variantKey: "1", colorKey: "коричн" }), ozFit({ basket: "C", variantKey: "3", colorKey: "баклаж" }),
    ozFit({ basket: "X", variantKey: "1", colorKey: "коричн", sizeKey: "S" }), ozFit({ basket: "X", variantKey: "4", colorKey: "баклаж", sizeKey: "M" }),
    ozFit({ basket: "O", variantKey: "1" }),
  ]);
  assert.deepEqual(rows.map((r) => r.fit), ["fit_size", "fit_size", "fit_color", "fit_color", "fit_mixed", "fit_mixed", "single"]);
});

test("tagFitting: две штуки одного варианта — одиночный; разные модели в корзине — каждая одиночная", () => {
  const rows = tagFitting([
    ozFit({ basket: "Q", srid: "a" }), ozFit({ basket: "Q", srid: "b" }),
    ozFit({ basket: "R", modelKey: "m:1" }), ozFit({ basket: "R", modelKey: "m:2", variantKey: "9" }),
  ]);
  assert.deepEqual(rows.map((r) => r.fit), ["single", "single", "single", "single"]);
});

test("tagFitting: варианты одного цвета, оба без ключа размера (различимы только по id) — расцветка", () => {
  const rows = tagFitting([ozFit({ basket: "N", variantKey: "1", sizeKey: "", sizeLabel: "иероглиф" }),
    ozFit({ basket: "N", variantKey: "2", sizeKey: "", sizeLabel: "квадрат" })]);
  assert.deepEqual(rows.map((r) => r.fit), ["fit_color", "fit_color"]);
});

test("tagFitting: один цвет, размеры (габариты накидок) различаются — примерка по размеру", () => {
  const rows = tagFitting([ozFit({ basket: "N2", variantKey: "1", sizeKey: "90*160", sizeLabel: "90*160" }),
    ozFit({ basket: "N2", variantKey: "2", sizeKey: "90*210", sizeLabel: "90*210" })]);
  assert.deepEqual(rows.map((r) => r.fit), ["fit_size", "fit_size"]);
});

test("tagFitting: самовыкуп не делает корзину примеркой", () => {
  const rows = tagFitting([ozFit({ basket: "Z", variantKey: "1" }), ozFit({ basket: "Z", variantKey: "2", sizeKey: "L", selfBuyout: true })]);
  assert.equal(rows[0].fit, "single");
});

test("filterByFitting: single + fitting = all по всем вёдрам; size/color/mixed = fitting", () => {
  const rows = [
    ozFit({ basket: "S", variantKey: "1", sizeKey: "S" }), ozFit({ basket: "S", variantKey: "2", sizeKey: "M", status: "cancelled", isReturn: true }),
    ozFit({ basket: "C", variantKey: "1" }), ozFit({ basket: "C", variantKey: "3", colorKey: "баклаж" }),
    ozFit({ basket: "X", variantKey: "1", sizeKey: "S" }), ozFit({ basket: "X", variantKey: "4", colorKey: "баклаж", sizeKey: "M" }),
    ozFit({ basket: "O", variantKey: "1", status: "delivered", isReturn: true }),
  ];
  const k = (kind) => aggregateBuyout(filterByFitting(rows, kind), ASOF).kpi;
  for (const key of ["ordered", "sold", "refused", "returned", "pending", "cancelledPre", "self"]) {
    assert.equal(k("single")[key] + k("fitting")[key], k("all")[key], key);
    assert.equal(k("size")[key] + k("color")[key] + k("mixed")[key], k("fitting")[key], key);
  }
  assert.equal(filterByFitting(rows, "bogus").length, rows.length);
  assert.deepEqual(FIT_VALUES, ["all", "single", "fitting", "size", "color", "mixed", "reorder"]);
});

test("fittingSummary: выкуп по корзине, pending не судим, что оставили из размеров", () => {
  const rows = tagFitting([
    // S+M → оставили M (больший)
    ozFit({ basket: "A", variantKey: "1", sizeKey: "S", sizeLabel: "S", status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    ozFit({ basket: "A", variantKey: "2", sizeKey: "M", sizeLabel: "M" }),
    // S+M → ничего
    ozFit({ basket: "B", variantKey: "1", sizeKey: "S", sizeLabel: "S", status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    ozFit({ basket: "B", variantKey: "2", sizeKey: "M", sizeLabel: "M", status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    // S+M ещё в пути — не судим
    ozFit({ basket: "C", variantKey: "1", sizeKey: "S", status: "delivering" }), ozFit({ basket: "C", variantKey: "2", sizeKey: "M" }),
    // цвета — выкуплен один
    ozFit({ basket: "D", variantKey: "1" }), ozFit({ basket: "D", variantKey: "3", colorKey: "баклаж", status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    // одиночный
    ozFit({ basket: "E", variantKey: "1" }),
  ]);
  const s = fittingSummary(rows, ASOF);
  assert.equal(s.baskets, 5);
  assert.equal(s.fittingBaskets, 4);
  assert.equal(s.basketShare, 80);
  assert.equal(s.rows, 9);
  assert.equal(s.fittingRows, 8);
  assert.equal(s.resolvedBaskets, 3);                // C в пути
  assert.equal(s.basketBuyoutPct, 66.67);            // A и D выкуплены, B нет
  assert.equal(s.avgVariants, 2);
  assert.equal(s.avgKept, 0.67);
  assert.equal(s.bySize.length, 1);
  const m = s.bySize[0];
  assert.equal(m.baskets, 2);
  assert.equal(m.keptLargest, 1);
  assert.equal(m.keptNone, 1);
  assert.deepEqual(m.combos, [{ combo: "S+M → M", n: 1 }, { combo: "S+M → ничего", n: 1 }]);
  assert.equal(s.estimated, false);
  assert.equal(fittingSummary(tagFitting([ozFit({ fitEstimated: true })]), ASOF).estimated, true);
});

test("fittingSummary: fit_size с пустым sizeKey у одного варианта — не в bySize (сравнивать не с чем)", () => {
  const rows = tagFitting([
    ozFit({ basket: "G", variantKey: "1", sizeKey: "", sizeLabel: "", modelKey: "m:ns" }),
    ozFit({ basket: "G", variantKey: "2", sizeKey: "M", sizeLabel: "M", modelKey: "m:ns" }),
  ]);
  assert.deepEqual(rows.map((r) => r.fit), ["fit_size", "fit_size"]);
  const s = fittingSummary(rows, ASOF);
  assert.equal(s.fittingBaskets, 1);
  assert.equal(s.resolvedBaskets, 1);
  assert.equal(s.bySize.length, 0);
});

test("fittingSummary: bySize — S+M+L кому остался M = keptMiddle; S+M оставили оба = keptSeveral", () => {
  const rows = tagFitting([
    // S+M+L → остался M
    ozFit({ basket: "H1", variantKey: "1", sizeKey: "S", sizeLabel: "S", modelKey: "m:sml", status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    ozFit({ basket: "H1", variantKey: "2", sizeKey: "M", sizeLabel: "M", modelKey: "m:sml" }),
    ozFit({ basket: "H1", variantKey: "3", sizeKey: "L", sizeLabel: "L", modelKey: "m:sml", status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    // S+M → оставили оба
    ozFit({ basket: "H2", variantKey: "1", sizeKey: "S", sizeLabel: "S", modelKey: "m:sml" }),
    ozFit({ basket: "H2", variantKey: "2", sizeKey: "M", sizeLabel: "M", modelKey: "m:sml" }),
  ]);
  const s = fittingSummary(rows, ASOF);
  assert.equal(s.bySize.length, 1);
  const m = s.bySize[0];
  assert.equal(m.baskets, 2);
  assert.equal(m.keptMiddle, 1);
  assert.equal(m.keptSeveral, 1);
  const combos = Object.fromEntries(m.combos.map((c) => [c.combo, c.n]));
  assert.equal(combos["S+M+L → M"], 1);
  assert.equal(combos["S+M → S+M"], 1);
});

// Перезаказы и корзина по покупателю Ozon (20.10.2026, спека 2026-10-20-buyout-reorders-design.md).
import { assignOzonBaskets, tagReorders, reorderSummary, shiftDate, REORDER_WINDOW_DAYS, ANOMALY_REGIONS_PER_DAY } from "../buyout.js";

const ozRe = (o) => ({ platform: "ozon", srid: "p", nmId: 1, name: "Комплект", article: "коричн-цвет-M", status: "delivered",
  isReturn: false, selfBuyout: false, orderDate: "2026-09-01", cancelAt: null, cancelReason: null,
  buyer: "U1", orderNumber: "U1-0001", region: "Москва", basket: "U1-0001",
  modelKey: "m:1", variantKey: "1", colorKey: "коричн", sizeKey: "M", sizeLabel: "M", fitEstimated: false, ...o });
const BUYER_CANCEL = "Покупатель отменил заказ";
const prep = (rows) => tagReorders(tagFitting(assignOzonBaskets(rows)), ASOF);

test("shiftDate и константы", () => {
  assert.equal(shiftDate("2026-09-28", 7), "2026-10-05");
  assert.equal(shiftDate("2026-09-01", -7), "2026-08-25");
  assert.equal(REORDER_WINDOW_DAYS, 7);
  assert.equal(ANOMALY_REGIONS_PER_DAY, 3);
});

test("assignOzonBaskets: корзина = покупатель + день; аномальный покупатель — по номеру заказа; WB не трогаем", () => {
  const rows = assignOzonBaskets([
    ozRe({ srid: "a", orderNumber: "U1-0001" }), ozRe({ srid: "b", orderNumber: "U1-0002" }),
    ozRe({ srid: "c", orderNumber: "U1-0003", orderDate: "2026-09-02" }),
    ozRe({ srid: "x1", buyer: "BAD", orderNumber: "BAD-1", region: "A" }), ozRe({ srid: "x2", buyer: "BAD", orderNumber: "BAD-2", region: "B" }),
    ozRe({ srid: "x3", buyer: "BAD", orderNumber: "BAD-3", region: "C" }),
    { platform: "wb", srid: "w", basket: "G1" },
  ]);
  assert.equal(rows[0].basket, "U1|2026-09-01");
  assert.equal(rows[1].basket, "U1|2026-09-01");
  assert.equal(rows[2].basket, "U1|2026-09-02");
  assert.equal(rows[0].buyerAnomalous, false);
  assert.equal(rows[3].basket, "BAD-1");
  assert.equal(rows[3].buyerAnomalous, true);
  assert.deepEqual(rows[6], { platform: "wb", srid: "w", basket: "G1" });
});

test("assignOzonBaskets: два заказа одного дня с разными вариантами — одна корзина-примерка", () => {
  const rows = tagFitting(assignOzonBaskets([ozRe({ srid: "a", orderNumber: "U1-1", sizeKey: "S", sizeLabel: "S", variantKey: "1" }),
    ozRe({ srid: "b", orderNumber: "U1-2", variantKey: "2" })]));
  assert.deepEqual(rows.map((r) => r.fit), ["fit_size", "fit_size"]);
});

test("tagReorders: отмена покупателем → на следующий день другой размер — перезаказ, обе строки fit_reorder", () => {
  const rows = prep([
    ozRe({ srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, sizeKey: "L", sizeLabel: "L", variantKey: "L" }),
    ozRe({ srid: "b", orderNumber: "U1-2", orderDate: "2026-09-02", sizeKey: "XL", sizeLabel: "XL", variantKey: "XL" }),
  ]);
  assert.equal(rows[0].reorderTo, "b");
  assert.equal(rows[1].reorderFrom, "a");
  assert.deepEqual(rows.map((r) => r.fit), ["fit_reorder", "fit_reorder"]);
});

test("tagReorders: не перезаказ — через 8 дней, отмена со стороны Ozon, выкупленный A, тот же вариант, аномальный покупатель", () => {
  const A = { srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, variantKey: "L", sizeKey: "L", sizeLabel: "L" };
  const B = { srid: "b", orderNumber: "U1-2", orderDate: "2026-09-02", variantKey: "XL", sizeKey: "XL", sizeLabel: "XL" };
  const none = (rows) => prep(rows).every((r) => !r.reorderTo && !r.reorderFrom && r.fit === "single");
  assert.ok(none([ozRe(A), ozRe({ ...B, orderDate: "2026-09-09" })]));
  assert.ok(none([ozRe({ ...A, cancelReason: "Не удалось доставить заказ" }), ozRe(B)]));
  assert.ok(none([ozRe({ ...A, status: "delivered", cancelReason: null }), ozRe(B)]));
  assert.ok(none([ozRe(A), ozRe({ ...B, variantKey: "L" })]));
  assert.ok(none([ozRe({ ...A, buyer: "BAD", region: "A" }), ozRe({ ...B, buyer: "BAD", region: "A" }),
    ozRe({ srid: "z1", buyer: "BAD", orderNumber: "BAD-9", region: "B" }), ozRe({ srid: "z2", buyer: "BAD", orderNumber: "BAD-8", region: "C" })]
    .map((r) => ({ ...r, orderDate: r.srid === "b" ? "2026-09-02" : "2026-09-01" }))));
  // 7 дней — ещё перезаказ (граница включительно)
  assert.equal(prep([ozRe(A), ozRe({ ...B, orderDate: "2026-09-08" })])[0].reorderTo, "b");
});

test("tagReorders: невыкуп (refused) и цепочка A→B→C; корзина главнее", () => {
  const rows = prep([
    ozRe({ srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: "Покупатель не забрал заказ", variantKey: "S", sizeKey: "S", sizeLabel: "S" }),
    ozRe({ srid: "b", orderNumber: "U1-2", orderDate: "2026-09-03", status: "cancelled", cancelReason: BUYER_CANCEL, variantKey: "M", sizeKey: "M", sizeLabel: "M" }),
    ozRe({ srid: "b2", orderNumber: "U1-2", orderDate: "2026-09-03", variantKey: "XS", sizeKey: "XS", sizeLabel: "XS" }),
    ozRe({ srid: "c", orderNumber: "U1-3", orderDate: "2026-09-05", variantKey: "L", sizeKey: "L", sizeLabel: "L" }),
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.srid, r]));
  assert.equal(by.a.reorderTo, "b");
  assert.equal(by.b.reorderFrom, "a");
  assert.equal(by.b.reorderTo, "c");
  assert.equal(by.a.fit, "fit_reorder");
  assert.equal(by.b.fit, "fit_size");   // корзина 09-03 (M + XS) главнее
  assert.equal(by.c.fit, "fit_reorder");
});

test("filterByFitting: размеры + цвета + смешанные + перезаказы = примерки; одиночные + примерки = все", () => {
  const rows = prep([
    ozRe({ srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, variantKey: "L", sizeKey: "L", sizeLabel: "L" }),
    ozRe({ srid: "b", orderNumber: "U1-2", orderDate: "2026-09-02", variantKey: "XL", sizeKey: "XL", sizeLabel: "XL" }),
    ozRe({ srid: "s1", buyer: "U2", orderNumber: "U2-1", variantKey: "1" }), ozRe({ srid: "s2", buyer: "U2", orderNumber: "U2-1", variantKey: "2", colorKey: "баклаж" }),
    ozRe({ srid: "o", buyer: "U3", orderNumber: "U3-1" }),
  ]);
  const k = (kind) => aggregateBuyout(filterByFitting(rows, kind), ASOF).kpi;
  for (const key of ["ordered", "sold", "refused", "returned", "pending", "cancelledPre", "self"]) {
    assert.equal(k("single")[key] + k("fitting")[key], k("all")[key], key);
    assert.equal(k("size")[key] + k("color")[key] + k("mixed")[key] + k("reorder")[key], k("fitting")[key], key);
  }
  assert.equal(k("reorder").ordered, 2);
  assert.deepEqual(FIT_VALUES, ["all", "single", "fitting", "size", "color", "mixed", "reorder"]);
});

test("fittingSummary не считает перезаказы примерочными корзинами", () => {
  const rows = prep([
    ozRe({ srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, variantKey: "L", sizeKey: "L", sizeLabel: "L" }),
    ozRe({ srid: "b", orderNumber: "U1-2", orderDate: "2026-09-02", variantKey: "XL", sizeKey: "XL", sizeLabel: "XL" }),
  ]);
  const s = fittingSummary(rows, ASOF);
  assert.equal(s.fittingBaskets, 0);
  assert.equal(s.fittingRows, 0);
});

test("reorderSummary: доля, направление, выкуп второго, B за периодом", () => {
  const all = prep([
    ozRe({ srid: "a", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, article: "коричн-цвет-L", variantKey: "L", sizeKey: "L", sizeLabel: "L" }),
    ozRe({ srid: "b", orderNumber: "U1-2", orderDate: "2026-09-02", article: "коричн-цвет-XL", variantKey: "XL", sizeKey: "XL", sizeLabel: "XL" }),
    ozRe({ srid: "c", buyer: "U2", orderNumber: "U2-1", status: "cancelled", cancelReason: BUYER_CANCEL, article: "коричн-цвет-M", variantKey: "M" }),
    ozRe({ srid: "d", buyer: "U2", orderNumber: "U2-2", orderDate: "2026-09-04", article: "баклаж-цвет-M", variantKey: "BM", colorKey: "баклаж",
      status: "cancelled", cancelReason: "Покупатель не забрал заказ" }),
    ozRe({ srid: "e", buyer: "U3", orderNumber: "U3-1", status: "cancelled", cancelReason: BUYER_CANCEL }),
  ]);
  const period = all.filter((r) => r.srid !== "b"); // B за границей периода — судьба всё равно видна
  const s = reorderSummary(period, all, ASOF);
  assert.equal(s.dropped, 4);       // a, c, d, e
  assert.equal(s.pairs, 2);         // a→b, c→d
  assert.equal(s.reorderShare, 50);
  assert.equal(s.bResolved, 2);
  assert.equal(s.bBuyoutPct, 50);   // b выкуплен, d — невыкуп
  const m = s.byModel[0];
  assert.equal(m.pairs, 2);
  assert.equal(m.sizeUp, 1);
  assert.equal(m.color, 1);
  assert.deepEqual(m.combos, [{ combo: "коричн-цвет-L → коричн-цвет-XL", n: 1 }, { combo: "коричн-цвет-M → баклаж-цвет-M", n: 1 }]);
});

test("reorderSummary: несколько A одного дня → один B; исход B считается один раз", () => {
  const all = prep([
    ozRe({ srid: "a1", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, variantKey: "S", sizeKey: "S", sizeLabel: "S" }),
    ozRe({ srid: "a2", orderNumber: "U1-1", status: "cancelled", cancelReason: BUYER_CANCEL, variantKey: "M", sizeKey: "M", sizeLabel: "M" }),
    ozRe({ srid: "b", orderNumber: "U1-2", orderDate: "2026-09-03", variantKey: "L", sizeKey: "L", sizeLabel: "L" }),
  ]);
  const s = reorderSummary(all, all, ASOF);
  assert.equal(s.dropped, 2);       // a1, a2
  assert.equal(s.pairs, 2);         // a1→b, a2→b
  assert.equal(s.bResolved, 1);     // b учтён один раз
  assert.equal(s.bBuyoutPct, 100);  // b выкуплен
  const m = s.byModel[0];
  assert.equal(m.pairs, 2);
  assert.equal(m.bResolved, 1);     // глобально: b один раз
});
