// lib/buyout.js — процент выкупа WB и Ozon когортно по дате заказа (11.10.2026).
// Спека docs/superpowers/specs/2026-10-11-buyout-page-design.md, контракт метрик §18.
// Чистые функции, без БД (данные — lib/buyoutData.js). Берём заказы периода и смотрим
// судьбу КАЖДОГО заказа (srid для WB, posting_number для Ozon): одно ведро на заказ, проверки в порядке BUCKETS.
//   % выкупа = sold / (sold + refused + returned); pending и cancelledPre в знаменатель
//   не входят, самовыкупы (self) исключены из всех вёдер.
// ⚠️ Это НЕ коэффициент выкупа юнитки (lib/unit.js): там b по событиям отчёта реализации,
// чтобы логистика сводилась к Σлогистики/продано (§18.4 контракта).

// todayMsk() — «сегодня» по МСК, не по UTC сервера (фикс 2026-10-12, финальное ревью):
// заказы датируются МСК, а `new Date().toISOString().slice(0,10)` даёт UTC-дату — в окне
// 00:00–02:59 МСК (UTC ещё «вчера») asOf расходился с датой последнего заказа когорты
// на сутки. `toLocaleDateString("sv-SE", {timeZone:"Europe/Moscow"})` даёт YYYY-MM-DD.
export function todayMsk() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
}

export const CANCEL_SETTLE_DAYS = 7; // отчёт реализации отстаёт: раньше 7 дней отмену без логистики не судим
export const IMMATURE_SHARE = 0.05;  // доля «в пути» выше — период не дозрел
export const MIN_RESOLVED = 20;      // меньше доехавших — процент бледный (малая выборка)
export const NO_SIZE = "0";          // WB tech_size неразмерного товара
export const NO_CATEGORY = "Без категории"; // товар без категории — отдельный пункт фильтра
const COUNT_KEYS = ["ordered", "self", "returned", "sold", "refused", "cancelledPre", "pending"];
const DAY = 864e5;

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const emptyCounts = () => Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));

export function classifyWbOrder(r, asOf) {
  if (r.selfBuyout) return "self";
  if (r.hasReturn) return "returned";
  if (r.hasSale) return "sold";
  if (r.isCancel) {
    if (r.refusedLogistics) return "refused";
    const at = r.cancelAt ? Date.parse(String(r.cancelAt).slice(0, 10)) : NaN;
    if (Number.isFinite(at) && (Date.parse(asOf) - at) / DAY > CANCEL_SETTLE_DAYS) return "cancelledPre";
  }
  return "pending";
}

// Ozon (этап 2, 12.10.2026): ведро на отправление. isReturn из ozon_order_costs — сборщик уже
// склеил формы номеров начислений (base/suffix) и пометил обратную логистику 45/59 и сторно
// продажи. delivered без начисления продажи (скидки Ozon обнулили выплату) — всё равно выкуп.
const OZ_CANCELLED = "cancelled";
const OZ_DELIVERED = "delivered";
// Ozon почти не заполняет cancel_dt/last_change_dt (1051 из 1089 отмен каб.1, 12.10.2026 — NULL
// в обоих полях) — без даты отмены старые невыкупы без логистики застревали в pending навечно
// и держали период «не дозревшим» (immature). Лаг заказ→обратная логистика у реальных невыкупов
// (каб.1, 12.10.2026, n=769): p50 7, p90 16, p99 27, max 38 дн. Порог 30 дней от ДАТЫ ЗАКАЗА —
// запасной путь, когда cancelAt нет совсем; если cancelAt есть — судим по нему (CANCEL_SETTLE_DAYS,
// как у WB). Поздний невыкуп без логистики всё равно сам перейдёт в refused, когда придёт начисление.
export const OZ_CANCEL_SETTLE_FROM_ORDER_DAYS = 30;

// Причины отмены Ozon (cancellation.cancel_reason, tenant.ozon_orders.cancel_reason, миграция 066;
// решение владельца 12.10.2026, контракт §18.3). Сопоставление — по НАЧАЛУ текста, регистронезависимо.
// Ozon часто НЕ начисляет обратную логистику, хотя товар доехал до ПВЗ (авг–сент 2026 FBO каб.1:
// «не забрал» 47 из 76 без is_return), поэтому одной логистики для невыкупа мало.
// (1) «Доехал, но не взяли» — невыкуп (refused) с логистикой или без:
export const OZ_REFUSED_REASON_PREFIXES = [
  "покупатель не забрал",               // «Покупатель не забрал заказ»
  "покупатель отказался при вручении",  // «…: товар не подошел / не тот товар / неполная комплектация / недоволен качеством»
  "автовозврат",                        // «Автовозврат: Истек срок хранения отправления»
  "изменил решение о покупке",
  "товар не подошел",
  "товар не подошёл",
];
// (2) Не вина покупателя (Ozon или продавец) — до отгрузки (cancelledPre) ВСЕГДА, даже при is_return=1
// (товар ехал и вернулся, но в % выкупа такие отмены не входят):
export const OZ_OZONSIDE_REASON_PREFIXES = [
  "не удалось доставить",               // «Не удалось доставить заказ»
  "товар закончился",                   // «Товар закончился на складе» (FBS — инициатор продавец)
  "не удалось обработать",              // «Не удалось обработать заказ»
  "вы не отгрузили",                    // FBS: «Вы не отгрузили заказ вовремя» (продавец)
  "вы отменили заказ",                  // FBS: «Вы отменили заказ» (продавец)
];
// (3) Остальные известные причины («Покупатель отменил заказ[: нашел дешевле|не устроил срок|перенос
// сроков доставки]» — последняя с типом Ozon, но это отмена покупателя): с is_return (отгружен, отменён
// в пути) — refused; без — ждут как отмены без причины (cancelAt + 7 дн либо заказ + 30 дн, до того
// pending): начисление обратной логистики отстаёт (заказ→начисление p90 16, p99 27 дн), около половины
// таких отмен позже получает is_return — сразу в cancelledPre они раздували бы свежий % и прятали ⏳.
// (4) Причины нет (старые строки до 066 / API не отдал) — прежние правила: is_return → refused,
// иначе cancelAt + 7 дн либо дата заказа + 30 дн.
const startsWithAny = (reason, prefixes) => prefixes.some((p) => reason.startsWith(p));

export function classifyOzonPosting(r, asOf) {
  if (r.selfBuyout) return "self";
  if (r.status === OZ_DELIVERED) return r.isReturn ? "returned" : "sold";
  if (r.status === OZ_CANCELLED) {
    const reason = String(r.cancelReason || "").trim().toLowerCase();
    if (reason) {
      if (startsWithAny(reason, OZ_OZONSIDE_REASON_PREFIXES)) return "cancelledPre";
      if (startsWithAny(reason, OZ_REFUSED_REASON_PREFIXES)) return "refused";
      // группа (3) — дальше как без причины: обратная логистика → refused, иначе дозревание 7/30 дн
    }
    if (r.isReturn) return "refused";
    if (r.cancelAt) {
      const at = Date.parse(String(r.cancelAt).slice(0, 10));
      if (Number.isFinite(at) && (Date.parse(asOf) - at) / DAY > CANCEL_SETTLE_DAYS) return "cancelledPre";
    } else {
      const orderedAt = r.orderDate ? Date.parse(String(r.orderDate).slice(0, 10)) : NaN;
      if (Number.isFinite(orderedAt) && (Date.parse(asOf) - orderedAt) / DAY > OZ_CANCEL_SETTLE_FROM_ORDER_DAYS) return "cancelledPre";
    }
  }
  return "pending";
}

export function classifyRow(r, asOf) {
  return r.platform === "ozon" ? classifyOzonPosting(r, asOf) : classifyWbOrder(r, asOf);
}

export function buyoutStats(c) {
  const resolved = c.sold + c.refused + c.returned;
  const open = resolved + c.pending;
  const pendingShare = open > 0 ? c.pending / open : 0;
  return {
    ...c,
    resolved,
    buyoutPct: resolved > 0 ? round2((100 * c.sold) / resolved) : null,
    pendingShare: round2(pendingShare),
    immature: pendingShare > IMMATURE_SHARE,
    lowSample: resolved < MIN_RESOLVED,
  };
}

function add(counts, bucket) {
  counts.ordered += 1;
  counts[bucket] += 1;
}

const LETTER = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "3XL", "4XL", "5XL"];
export function sortSizes(list) {
  const rank = (s) => {
    const u = String(s).toUpperCase();
    const li = LETTER.indexOf(u);
    if (li >= 0) return [0, li, u];
    const n = parseFloat(u);
    if (Number.isFinite(n)) return [1, n, u];
    return [2, 0, u];
  };
  return [...list].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2], "ru");
  });
}

export function aggregateBuyout(rows, asOf) {
  const kpi = emptyCounts();
  const byNm = new Map();
  for (const r of rows) {
    const b = classifyRow(r, asOf);
    add(kpi, b);
    const key = `${r.platform || "wb"}:${r.nmId}`;
    let it = byNm.get(key);
    if (!it) {
      it = { platform: r.platform || "wb", nmId: r.nmId, article: r.article || null, name: r.name || null, category: r.category || null, counts: emptyCounts(), sizes: new Map() };
      byNm.set(key, it);
    }
    if (!it.name && r.name) it.name = r.name;
    if (!it.article && r.article) it.article = r.article;
    if (!it.category && r.category) it.category = r.category;
    add(it.counts, b);
    const size = r.size || NO_SIZE;
    if (!it.sizes.has(size)) it.sizes.set(size, emptyCounts());
    add(it.sizes.get(size), b);
  }
  const items = [...byNm.values()].map((it) => {
    const sizeKeys = [...it.sizes.keys()];
    const real = sizeKeys.some((s) => s !== NO_SIZE);
    return {
      platform: it.platform,
      nmId: it.nmId, article: it.article, name: it.name, category: it.category || NO_CATEGORY,
      ...buyoutStats(it.counts),
      sizes: real ? sortSizes(sizeKeys).map((s) => ({ size: s === NO_SIZE ? "без размера" : s, ...buyoutStats(it.sizes.get(s)) })) : [],
    };
  }).sort((a, b) => b.ordered - a.ordered);
  return { kpi: buyoutStats(kpi), items };
}

// Фильтр «Категория» (20.10.2026). Категория — товара, не строки заказа: у WB она лежит в
// каждом заказе и теоретически может различаться между заказами одного nm — берём первую
// непустую по товару, иначе товар расщепился бы между категориями. Пусто → NO_CATEGORY
// (иначе такие товары нельзя было бы выбрать фильтром).
export function itemCategories(rows) {
  const m = new Map();
  for (const r of rows) {
    const key = `${r.platform || "wb"}:${r.nmId}`;
    if (!m.get(key) && r.category) m.set(key, r.category);
    else if (!m.has(key)) m.set(key, null);
  }
  for (const [k, v] of m) if (!v) m.set(k, NO_CATEGORY);
  return m;
}

// → [[категория, число товаров]] по убыванию числа товаров, затем по имени; «Без категории» — последней.
export function categoryFacets(rows) {
  const cnt = new Map();
  for (const c of itemCategories(rows).values()) cnt.set(c, (cnt.get(c) || 0) + 1);
  const last = (c) => (c === NO_CATEGORY ? 1 : 0);
  return [...cnt].sort((a, b) => last(a[0]) - last(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
}

// cats — пустой список = без фильтра. Строки получают category товара (для aggregateBuyout).
export function filterByCategory(rows, cats) {
  const cat = itemCategories(rows);
  const out = rows.map((r) => ({ ...r, category: cat.get(`${r.platform || "wb"}:${r.nmId}`) }));
  if (!cats || !cats.length) return out;
  const want = new Set(cats);
  return out.filter((r) => want.has(r.category));
}

export function weekStart(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // пн = 0
  return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
}

export function weeklyBuyout(rows, asOf, { weeks = 13, nmId = null, platform = null } = {}) {
  const last = Date.parse(`${weekStart(asOf)}T00:00:00Z`);
  const keys = Array.from({ length: weeks }, (_, i) => new Date(last - (weeks - 1 - i) * 7 * DAY).toISOString().slice(0, 10));
  const acc = new Map(keys.map((k) => [k, { total: emptyCounts(), sizes: new Map() }]));
  const sizeSet = new Set();
  for (const r of rows) {
    if (nmId != null && (r.nmId !== nmId || (r.platform || "wb") !== (platform || "wb"))) continue;
    const w = acc.get(weekStart(r.orderDate));
    if (!w) continue;
    const b = classifyRow(r, asOf);
    add(w.total, b);
    const size = r.size || NO_SIZE;
    if (nmId != null && size !== NO_SIZE) {
      sizeSet.add(size);
      if (!w.sizes.has(size)) w.sizes.set(size, emptyCounts());
      add(w.sizes.get(size), b);
    }
  }
  const sizeList = sortSizes([...sizeSet]);
  return {
    sizeList,
    weeks: keys.map((k) => {
      const w = acc.get(k);
      return {
        week: k,
        ...buyoutStats(w.total),
        sizes: Object.fromEntries(sizeList.map((s) => [s, buyoutStats(w.sizes.get(s) || emptyCounts())])),
      };
    }),
  };
}
