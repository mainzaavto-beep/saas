"use client";
import { C, soft } from "@/lib/palette.js";
import { ALERT } from "@/lib/callout.js";
import PeriodPicker from "../PeriodPicker.jsx";

import { useEffect, useMemo, useRef, useState } from "react";

// Цветовая палитра SAAS (тёмно-синяя). Согласована с globals.css.
// Внутренние компоненты (Kpi/Th/Td/ProductCell/...) обращаются к C.*,
// поэтому держим объект C здесь — не тянем старую палитру из lib/theme.


// =====================================================================
//  /cabinets/[id]/summary — Сводка по товарам (SaaS, WB+Ozon).
//  Полный перенос эталона data-presenter/app/products/page.jsx с
//  адаптацией роутинга/API под мультитенантный контур.
//
//  Источник: /api/cabinets/[id]/products-summary — агрегаты по каждому
//  товару за период (заказано/продано/отмен/возвр/самовыкупы, выручка,
//  себест., комиссия, логистика, эквайринг, лояльность, налог, прибыль,
//  маржа, ROI, ДРР, ROMI, CPA, оборачиваемость, остаток).
//
//  ⚠️ МЕТОДОЛОГИЯ: цифры считаются из PostgreSQL по нашим формулам и
//  МОГУТ расходиться с выгрузкой Mpassistant на 5–30% (разная методология).
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
// round2 — та же формула, что на сервере (route.js), для клиентского пересчёта итогов.
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const money = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(x) + " ₽";
};
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : r2(v) + "%");

// ДРР-пилл: пороги ОТНОСИТЕЛЬНО маржи товара (решение владельца 25.08):
// ok < margin/2; warn < margin; bad ≥ margin | реклама без продаж | margin≤0.
function drrPillTone(drr, margin, ads, sold) {
  if (!ads) return null;                    // рекламы нет — пилла нет
  if (!sold || margin == null || margin <= 0) return "bad";
  if (drr < margin / 2) return "ok";
  if (drr < margin) return "warn";
  return "bad";
}

// Дельта к прошлому окну: {text, dir} или null (нет prev/деление на 0).
// pp=true — в процентных пунктах (для % выкупа), иначе в % отношения.
// short=true — короткая форма без «к прошлому периоду» (второстепенные плитки).
function delta(cur, prev, { pp = false, short = false } = {}) {
  if (prev == null || cur == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  if (pp) {
    const d = round2(cur - prev);
    return { text: `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} п.п.`, dir: d >= 0 ? "up" : "down" };
  }
  if (!prev) return null;
  const d = (cur - prev) / Math.abs(prev) * 100;
  const tail = short ? "%" : "% к прошлому периоду";
  return { text: `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} ${tail}`, dir: d >= 0 ? "up" : "down" };
}

// Форматирование сравнения периодов для тултипа дельты.
// Формат: "Сравнение периодов: DD.MM–DD.MM (текущий) против DD.MM–DD.MM (прошлый)"
// Год добавляется только если окна в разных годах.
function formatPeriodComparison(period, prevPeriod) {
  if (!period || !prevPeriod || !period.from || !period.to || !prevPeriod.from || !prevPeriod.to) {
    return null;
  }

  const parseDate = (dateStr) => {
    const d = new Date(dateStr);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  };

  const formatDate = (dateStr, showYear) => {
    const d = parseDate(dateStr);
    const day = String(d.day).padStart(2, '0');
    const month = String(d.month).padStart(2, '0');
    if (showYear) {
      return `${day}.${month}.${d.year}`;
    }
    return `${day}.${month}`;
  };

  // Определяем, нужен ли год: проверяем разные ли годы в текущем окне и prev окне
  const curFromYear = parseDate(period.from).year;
  const curToYear = parseDate(period.to).year;
  const prevFromYear = parseDate(prevPeriod.from).year;
  const prevToYear = parseDate(prevPeriod.to).year;

  const yearDiffers = curFromYear !== curToYear ||
                     curFromYear !== prevFromYear ||
                     curFromYear !== prevToYear;

  const curFrom = formatDate(period.from, yearDiffers);
  const curTo = formatDate(period.to, yearDiffers);
  const prevFrom = formatDate(prevPeriod.from, yearDiffers);
  const prevTo = formatDate(prevPeriod.to, yearDiffers);

  return `Сравнение периодов: ${curFrom}–${curTo} (текущий) против ${prevFrom}–${prevTo} (прошлый)`;
}

// Спарклайн прибыли (до налога) — line+area+точка на конце, как в макете Сводки.
function Spark({ series }) {
  if (!series || series.length < 2) return null;
  const W = 120, H = 44, PAD = 3;
  const vals = series.map((p) => p.profit);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min;
  // Плоский ряд (span=0, напр. все дни без движения) — брифовская формула
  // (v-min)/span с фолбэком span||1 давала бы 0 везде → линия у НИЖНЕГО края
  // (ratio=1-0=1), а не по центру. Адаптация: при span=0 берём ratio=0.5 —
  // линия ровно по центру, как того требует self-review.
  const norm = (v) => (span === 0 ? 0.5 : (v - min) / span);
  const pts = vals.map((v, i) => [i * (W / (vals.length - 1)), PAD + (H - 2 * PAD) * (1 - norm(v))]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [ex, ey] = pts[pts.length - 1];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" style={{ flex: `0 0 ${W}px` }}>
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={soft("accent", 15)} stroke="none" />
      <path d={line} fill="none" stroke={C.accent} strokeWidth="2" />
      <circle cx={ex} cy={ey} r="2.6" fill={C.accent} />
    </svg>
  );
}

export default function SummaryPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // Кабинетные расходы (№27) — отдельный источник (не входят в маржу SKU).
  const [cab, setCab] = useState(null);

  // Период и МП — управляют самим запросом к API (важно: разные колонки
  // берутся по разным датам, это делает сервер). Период теперь выбирается
  // через PeriodPicker (день/неделя/месяц/год/интервал, стрелки ‹/›, «Вчера»)
  // — тот же удобный контрол, что и на Главной; дефолт компонента — месяц
  // (как на Главной, OverviewClient.jsx:93), «Вчера» — быстрый переход на день.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [mp, setMp] = useState("all");
  // Остальные фильтры — клиентские (по готовым агрегатам).
  const [brand, setBrand] = useState("__all__");
  const [group, setGroup] = useState("__all__");
  // Категория — мультивыбор галочками; пустой Set = без фильтра (все).
  const [catSel, setCatSel] = useState(() => new Set());
  const [shop, setShop] = useState("__all__");
  const [q, setQ] = useState("");
  // Сортировка + пагинация.
  const [sort, setSort] = useState({ key: "salesRub", dir: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (mp !== "all") p.set("platform", mp);
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    return p.toString();
  }, [mp, dateFrom, dateTo]);

  useEffect(() => {
    setData(null); setError(null);
    fetch(`/api/cabinets/${cabinetId}/products-summary` + (qs ? "?" + qs : ""))
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)));
  }, [cabinetId, qs]);

  // Кабинетные расходы (№27): те же platform/period, что у products-summary.
  useEffect(() => {
    setCab(null);
    fetch(`/api/cabinets/${cabinetId}/cabinet-costs` + (qs ? "?" + qs : ""))
      .then((r) => r.json())
      .then((d) => { if (!d.error) setCab(d); })
      .catch(() => {});
  }, [cabinetId, qs]);

  // Фасеты для дропдаунов.
  const facets = useMemo(() => {
    const f = { brand: new Map(), group: new Map(), cat: new Map(), shop: new Map() };
    for (const i of data?.items || []) {
      if (i.brand) f.brand.set(i.brand, (f.brand.get(i.brand) || 0) + 1);
      if (i.grp)   f.group.set(i.grp, (f.group.get(i.grp) || 0) + 1);
      if (i.cat)   f.cat.set(i.cat, (f.cat.get(i.cat) || 0) + 1);
      if (i.shop)  f.shop.set(i.shop, (f.shop.get(i.shop) || 0) + 1);
    }
    const toArr = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    return { brand: toArr(f.brand), group: toArr(f.group), cat: toArr(f.cat), shop: toArr(f.shop) };
  }, [data]);

  const filtered = useMemo(() => {
    if (!data?.items) return [];
    let arr = data.items;
    if (brand !== "__all__") arr = arr.filter((i) => i.brand === brand);
    if (group !== "__all__") arr = arr.filter((i) => i.grp === group);
    if (catSel.size > 0)     arr = arr.filter((i) => catSel.has(i.cat));
    if (shop !== "__all__")  arr = arr.filter((i) => i.shop === shop);
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      arr = arr.filter((i) =>
        String(i.sa || "").toLowerCase().includes(s) ||
        String(i.nm || "").includes(s) ||
        String(i.name || "").toLowerCase().includes(s) ||
        String(i.brand || "").toLowerCase().includes(s)
      );
    }
    if (sort) {
      const { key, dir } = sort;
      const mul = dir === "asc" ? 1 : -1;
      arr = [...arr].sort((a, b) => {
        const av = a[key], bv = b[key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === "string") return av.localeCompare(bv) * mul;
        return (av - bv) * mul;
      });
    }
    return arr;
  }, [data, brand, group, catSel, shop, q, sort]);

  // Товарный фильтр — сужает `filtered` относительно `data.items` (в отличие
  // от mp/период, которые уже отражены в самом data.items сервером).
  const hasProductFilter = brand !== "__all__" || group !== "__all__" ||
    catSel.size > 0 || shop !== "__all__" || !!q.trim();

  // ⚠️ ФИКС (жалоба владельца): фин-итоги (KPI-плитки + tfoot таблицы) раньше
  // брались из data.totals — агрегата СЕРВЕРА по ВСЕМ товарам, который ни один
  // клиентский фильтр не менял. Пересчитываем аддитивные поля по `filtered`
  // (те же формулы, что server aggTotals в route.js), производные — от
  // пересчитанных сумм.
  //
  // Реклама (adSpend) — с 2026-08-21 (канон обеих площадок, задача 6 плана
  // «реклама по товарам») item.profit ТЕПЕРЬ ВКЛЮЧАЕТ реальную рекламу самого
  // товара (item.adSpend, из daily_metrics/ozon_daily_sku_ad по SKU). Но
  // totals.adSpend с сервера — это ПОЛНАЯ кабинетная реклама
  // (daily_metrics/ozon_daily_efficiency за период), а Σ item.adSpend по всем
  // товарам периода СТРУКТУРНО МЕНЬШЕ: часть кампаний (напр. «Оплата за
  // заказ — все товары» у Ozon) не отдаёт пер-SKU разбивку через API, их
  // расход остаётся только в totals.adSpend («нераспределённый остаток»).
  // Поэтому:
  //  • без товарного фильтра (filtered === все товары периода) — Σ item.profit
  //    уже содержит Σ item.adSpend; довычитаем ТОЛЬКО нераспределённый остаток
  //    (fullAd − Σ item.adSpend, снизу зажат нулём — округления не должны
  //    давать отрицательный «довычет»), воспроизводя серверную композицию
  //    totals.profit 1:1 (дефолтный вид не меняется ни на копейку);
  //  • при активном товарном фильтре — довычитать нераспределённый остаток из
  //    прибыли ПОДМНОЖЕСТВА товаров было бы некорректно (остаток не привязан
  //    к конкретным SKU), поэтому «Прибыль»/tfoot показывают Σ item.profit
  //    КАК ЕСТЬ (реклама выбранных товаров уже внутри), с пометкой в title.
  //    Плитки «Реклама, ₽» и «ДРР (общий)» остаются кабинетными целиком (не
  //    фильтруются) — это следует из их подписи «общий» — с явной пометкой в
  //    title.
  const filteredTotals = useMemo(() => {
    const ft = {
      ordered: 0, sold: 0, cancelled: 0, returns: 0, selfBuyout: 0,
      orderRub: 0, salesRub: 0, costRub: 0, commission: 0, logistics: 0,
      acquiring: 0, loyalty: 0, tax: 0, profit: 0, stock: 0, returnLogistics: 0,
      adSpend: 0, services: 0,
    };
    for (const i of filtered) {
      ft.ordered += i.ordered || 0;
      ft.sold += i.sold || 0;
      ft.cancelled += i.cancelled || 0;
      ft.returns += i.returns || 0;
      ft.selfBuyout += i.selfBuyout || 0;
      ft.orderRub += i.orderRub || 0;
      ft.salesRub += i.salesRub || 0;
      ft.costRub += i.costRub || 0;
      ft.commission += i.commission || 0;
      ft.logistics += i.logistics || 0;
      ft.services += i.services || 0;
      ft.acquiring += i.acquiring || 0;
      ft.loyalty += i.loyalty || 0;
      ft.tax += i.tax || 0;
      ft.profit += i.profit || 0; // канон: item.profit ТЕПЕРЬ включает рекламу товара
      ft.stock += i.stock || 0;
      ft.returnLogistics += i.returnLogistics || 0;
      ft.adSpend += i.adSpend || 0;
    }
    const fullAd = data?.totals?.adSpend || 0;
    // item.profit теперь ВКЛЮЧАЕТ рекламу самого товара (канон 2026-08-21).
    // Без фильтра доводим до серверного totals.profit, вычитая только
    // НЕРАСПРЕДЕЛЁННУЮ часть кабинетной рекламы (корректировки + кампании
    // без товарной разбивки): fullAd − Σ item.adSpend.
    if (!hasProductFilter) ft.profit = round2(ft.profit - Math.max(0, round2(fullAd - ft.adSpend)));
    ft.buyoutPct = (ft.sold + ft.returns + ft.cancelled) > 0
      ? round2(100 * ft.sold / (ft.sold + ft.returns + ft.cancelled)) : null;
    ft.margin = ft.salesRub ? round2(100 * ft.profit / ft.salesRub) : null;
    ft.avgCheck = ft.ordered ? round2(ft.orderRub / ft.ordered) : null;
    return ft;
  }, [filtered, hasProductFilter, data]);

  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = pageSize === 0 ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => { setPage(1); }, [brand, group, catSel, shop, q, pageSize, qs]);

  // Период больше не имеет «нейтрального» состояния (PeriodPicker всегда
  // держит явный день/неделю/месяц/интервал, дефолт — месяц) — в отличие
  // от прежнего preset="default" (пусто → сервер сам решал 30 дней), поэтому
  // из «активных фильтров»/сброса период больше не участвует.
  const hasActiveFilters = mp !== "all" ||
    brand !== "__all__" || group !== "__all__" || catSel.size > 0 || shop !== "__all__" || q.trim();
  const resetFilters = () => {
    setMp("all");
    setBrand("__all__"); setGroup("__all__"); setCatSel(new Set()); setShop("__all__"); setQ("");
  };

  // Переход в детальную сводку товара (drill-down → /cabinets/[id]/detail).
  // Несём текущий период (если задан) — чтобы деталь открылась тем же окном данных.
  const openDetail = (it) => {
    const p = new URLSearchParams();
    p.set("platform", it.platform === "ozon" ? "ozon" : "wb");
    p.set("nm", it.nm);
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    window.location.href = `/cabinets/${cabinetId}/detail?` + p.toString();
  };

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка сводки по товарам…</Centered>;

  const t = data.totals || {};   // серверные итоги по ВСЕМ товарам (для кабинетных плиток — реклама/ДРР).
  const ft = filteredTotals;     // клиентский пересчёт по активным фильтрам (см. useMemo выше).
  const period = data.period || {};
  // prevTotals (задача 1) — тот же platform/период, что t/ft, но БЕЗ товарного
  // фильтра (buildTotals не принимает brand/group/cat/shop/search — см. отчёт
  // задачи 1). Согласованная пара с ft существует, только пока !hasProductFilter
  // (тогда ft численно равен t — воспроизводит серверный totals.profit 1:1,
  // см. комментарий у filteredTotals выше). При активном товарном фильтре
  // сравнивать ft (подмножество) с prevTotals (весь кабинет) было бы враньём —
  // решение задачи 2: дельты показываем ТОЛЬКО без товарного фильтра.
  const prevTotals = !hasProductFilter ? (data.prevTotals || null) : null;
  const profitSpark = data.profitSpark || [];
  // Дата снимка остатков Ozon (грабля #139): показываем последнюю доступную дату,
  // т.к. остаток = снапшот и может не совпадать с концом выбранного периода.
  const ozStockDate = (data.items || []).find((i) => i.platform === "ozon")?.stockDate || null;
  // Тултип для дельт: какие периоды сравниваются (формат: Сравнение периодов: … против …).
  const deltaTooltip = formatPeriodComparison(period, data.prevPeriod);

  return (
    <main style={{ width: "100%", margin: 0, padding: "20px 18px", fontFamily: FONT, color: C.ink }}>
      <div style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Сводка по товарам</h1>
        <p style={{ margin: "3px 0 0", color: C.muted, fontSize: 13 }}>
          {data.count} товаров · период {period.from || "—"} → {period.to || "—"} ({period.days || "?"} дн.)
          {ozStockDate && <> · <span title="У Ozon API не отдаёт историю остатков — показан последний доступный снимок">остатки Ozon на {ozStockDate}</span></>}
          {" "}· <span style={{ color: C.faint }}>кликните товар, чтобы открыть его детальную сводку</span>
        </p>
      </div>

      {/* Плашка о методологии — компактная, не навязчивая. */}
      <div style={{
        ...ALERT.info, padding: "8px 12px", borderRadius: 8, marginBottom: 14, fontSize: 12,
        display: "flex", gap: 8, alignItems: "center",
      }}>
        <span>ℹ️</span>
        <span>{data.methodology}</span>
      </div>

      {/* KPI-плитки — 5 шт. по макету (задача 2 плана «Сводка по макету»,
          2026-08-25): Прибыль (primary, спарклайн, полная дельта) / Выручка (Δ%)
          / Реклама (кабинетная, muted-подпись «ДРР N %») / Продано шт (Δ%) /
          Выкуп (Δ п.п.). Остальные метрики (Маржа/Заказано/Кабинетные расходы
          и пр.) остались в таблице/отдельной секции ниже — здесь не дублируются. */}
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
        <Kpi
          label="Прибыль за период"
          value={money(ft.profit)}
          color={(ft.profit || 0) >= 0 ? C.pos : C.neg}
          title={(hasProductFilter
            ? "По выбранным товарам, включая их рекламу; нераспределённая кабинетная реклама (корректировки, кампании без товарной разбивки) не вычитается. "
            : "Вкл. вычет всей рекламы кабинета за период (реклама товаров — в их прибыли, остаток — кабинетный). ")
            + "График — прибыль по дням до налога (rawProfit − реклама), по всему кабинету за период"
            + (hasProductFilter ? " (не сужается товарным фильтром)" : "")}
          delta={delta(ft.profit, prevTotals?.profit)}
          deltaTitle={deltaTooltip}
          primary
        >
          <Spark series={profitSpark} />
        </Kpi>
        <Kpi
          label="Выручка"
          value={money(ft.salesRub)}
          delta={delta(ft.salesRub, prevTotals?.salesRub)}
          deltaTitle={deltaTooltip}
        />
        <Kpi
          label="Реклама, ₽"
          value={money(t.adSpend)}
          sub={t.salesRub ? `ДРР ${pct(100 * (t.adSpend || 0) / t.salesRub)}` : "ДРР —"}
          title="Вся реклама кабинета за период (= плитка «ДРР (общий)»); товарная часть видна в колонке «Реклама, ₽» таблицы; реклама и выручка — по всему кабинету целиком, фильтрами не меняется"
        />
        <Kpi
          label="Продано, шт"
          value={num(ft.sold)}
          delta={delta(ft.sold, prevTotals?.sold)}
          deltaTitle={deltaTooltip}
        />
        <Kpi
          label="% выкупа"
          value={pct(ft.buyoutPct)}
          delta={delta(ft.buyoutPct, prevTotals?.buyoutPct, { pp: true })}
          deltaTitle={deltaTooltip}
        />
      </div>

      {/* Фильтры — ряд 1: МП / Период / Поиск / Сбросить */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 10, flexWrap: "wrap" }}>
        <Field label="Маркетплейс">
          <Seg>
            {[{ v: "all", l: "Все" }, { v: "wb", l: "WB" }, { v: "ozon", l: "Ozon" }].map((o) => (
              <SegBtn key={o.v} active={mp === o.v} onClick={() => setMp(o.v)}>{o.l}</SegBtn>
            ))}
          </Seg>
        </Field>
        <PeriodPicker
          value={{ from: dateFrom, to: dateTo }}
          onChange={({ from, to }) => { setDateFrom(from); setDateTo(to); }}
        />
        <input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск: артикул, имя, бренд…"
          style={{ ...inputStyle, minWidth: 240, flex: 1 }}
        />
        {hasActiveFilters && <button onClick={resetFilters} style={resetBtnStyle}>Сбросить</button>}
      </div>

      {/* Фильтры — ряд 2: бренд / группа / категория / магазин */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 14, flexWrap: "wrap" }}>
        <Field label="Бренд">
          <select value={brand} onChange={(e) => setBrand(e.target.value)} style={selectStyle}>
            <option value="__all__">Все</option>
            {facets.brand.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
          </select>
        </Field>
        <Field label="Группа товаров">
          <select value={group} onChange={(e) => setGroup(e.target.value)} style={selectStyle}>
            <option value="__all__">Все</option>
            {facets.group.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
          </select>
        </Field>
        <Field label="Категория">
          <CategoryMultiSelect options={facets.cat} selected={catSel} setSelected={setCatSel} />
        </Field>
        <Field label="Магазин">
          <select value={shop} onChange={(e) => setShop(e.target.value)} style={selectStyle}>
            <option value="__all__">Все</option>
            {facets.shop.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
          </select>
        </Field>
      </div>

      {/* Размер страницы */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, fontSize: 12, color: C.muted }}>
        <span>Показывать:</span>
        {[20, 50, 100, 0].map((n) => (
          <button key={n} onClick={() => setPageSize(n)} style={{
            padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
            border: `1px solid ${pageSize === n ? C.accent : C.line}`,
            background: pageSize === n ? C.accent : "transparent",
            color: pageSize === n ? "var(--accentInk)" : C.muted, fontWeight: 600,
          }}>{n === 0 ? "все" : n}</button>
        ))}
        <span style={{ marginLeft: "auto" }}>
          Показано {pageItems.length === 0 ? 0 : (safePage - 1) * pageSize + 1}–{(pageSize === 0 ? filtered.length : Math.min(safePage * pageSize, filtered.length))} из {filtered.length}
        </span>
      </div>

      {/* Таблица */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
              {COLS.map((col) => (
                <Th key={col.key} col={col} sort={sort} setSort={setSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {pageItems.map((it) => (
              <tr
                key={it.platform + "-" + it.nm}
                onClick={() => openDetail(it)}
                title="Кликните, чтобы открыть детальную сводку по товару"
                style={{ borderBottom: `1px solid ${soft("line", 20)}`, cursor: "pointer" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = `${soft("accent", 5)}`)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <Td left><ProductCell it={it} /></Td>
                <Td right>{num(it.ordered)}</Td>
                <Td right>{num(it.sold)}</Td>
                <Td right>{num(it.cancelled)}</Td>
                <Td right>{num(it.returns)}</Td>
                <Td right><span style={{ color: (it.returnLogistics || 0) > 0 ? C.neg : C.faint }}>{money(it.returnLogistics)}</span></Td>
                <Td right>{num(it.stock)}</Td>
                <Td right>{pct(it.buyoutPct)}</Td>
                <Td right>{num(it.avgOrdersDay)}</Td>
                <Td right>{money(it.orderRub)}</Td>
                <Td right>{money(it.avgCheck)}</Td>
                <Td right>{money(it.salesRub)}</Td>
                <Td right>{money(it.costRub)}</Td>
                <Td right>{money(it.commission)}</Td>
                <Td right>{pct(it.commissionPct)}</Td>
                <Td right>{money(it.logistics)}</Td>
                <Td right>{money(it.services)}</Td>
                <Td right>{money(it.acquiring)}</Td>
                <Td right>{money(it.adSpend)}</Td>
                <Td right>{money(it.loyalty)}</Td>
                <Td right>{money(it.tax)}</Td>
                <Td right><span style={{ color: (it.profit || 0) >= 0 ? C.pos : C.neg, fontWeight: 700 }}>{money(it.profit)}</span></Td>
                <Td right>{money(it.avgProfit)}</Td>
                <Td right><span style={{ color: (it.margin || 0) >= 0 ? C.pos : C.neg, fontWeight: 600 }}>{pct(it.margin)}</span></Td>
                <Td right>{pct(it.roi)}</Td>
                <Td right><DrrPill drr={it.drr} margin={it.margin} ads={it.adSpend} sold={it.sold} /></Td>
                <Td right>{pct(it.romi)}</Td>
                <Td right>{money(it.cpa)}</Td>
                <Td right>{it.turnoverDays != null ? num(it.turnoverDays) + " дн" : "—"}</Td>
              </tr>
            ))}
            {pageItems.length === 0 && (
              <tr><td colSpan={COLS.length} style={{ padding: 30, textAlign: "center", color: C.muted }}>Нет данных по выбранным фильтрам</td></tr>
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
                <td style={tdFootL}>Итого ({filtered.length})</td>
                <td style={tdFootR}>{num(ft.ordered)}</td>
                <td style={tdFootR}>{num(ft.sold)}</td>
                <td style={tdFootR}>{num(ft.cancelled)}</td>
                <td style={tdFootR}>{num(ft.returns)}</td>
                <td style={{ ...tdFootR, color: ft.returnLogistics > 0 ? C.neg : C.faint }}>{money(ft.returnLogistics)}</td>
                <td style={tdFootR}>{num(ft.stock)}</td>
                <td style={tdFootR}>{pct(ft.buyoutPct)}</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>{money(ft.orderRub)}</td>
                <td style={tdFootR}>{money(ft.avgCheck)}</td>
                <td style={tdFootR}>{money(ft.salesRub)}</td>
                <td style={tdFootR}>{money(ft.costRub)}</td>
                <td style={tdFootR}>{money(ft.commission)}</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>{money(ft.logistics)}</td>
                <td style={tdFootR}>{money(ft.services)}</td>
                <td style={tdFootR}>{money(ft.acquiring)}</td>
                <td style={tdFootR} title="Вся реклама кабинета за период; товарная часть видна в колонке «Реклама, ₽» таблицы">{money(t.adSpend)}</td>
                <td style={tdFootR}>{money(ft.loyalty)}</td>
                <td style={tdFootR}>{money(ft.tax)}</td>
                <td
                  style={{ ...tdFootR, fontWeight: 800, color: (ft.profit || 0) >= 0 ? C.pos : C.neg }}
                  title={hasProductFilter
                    ? "По выбранным товарам, включая их рекламу; нераспределённая кабинетная реклама (корректировки, кампании без товарной разбивки) не вычитается"
                    : "Вкл. вычет всей рекламы кабинета за период (реклама товаров — в их прибыли, остаток — кабинетный)"}
                >{money(ft.profit)}</td>
                <td style={tdFootR}>—</td>
                <td style={tdFootR}>{pct(ft.margin)}</td>
                <td style={tdFootR}>—</td><td style={tdFootR}>—</td><td style={tdFootR}>—</td><td style={tdFootR}>—</td>
                <td style={tdFootR}>—</td>
              </tr>
              {/* «Не разнесено по товарам» (задача 8 плана «geo-canon-vitrina»,
                  обещание владельцу 05.09: увидел «−16 663» в итогах при
                  плюсовых строках без объяснения — это была нераспределённая
                  реклама Ozon кабинета за день, пока per-SKU отчёт дозревал).
                  Правило: расхождение «итог ≠ Σ строк» никогда не молчит —
                  показываем остаток явно, той же формулой, что уже вычиталась
                  из «Итого» выше молча (data.unallocated с сервера). Не
                  сужается товарным фильтром — как и «Реклама, ₽» строкой выше,
                  это кабинетные суммы целиком за период. */}
              {data.unallocated && (
                <tr style={{ background: C.surfaceAlt }}>
                  <td
                    colSpan={COLS.length}
                    style={{
                      padding: "6px 10px", fontSize: 11.5,
                      color: data.unallocated.note ? C.warn : C.muted,
                      borderTop: `1px solid ${soft("line", 30)}`,
                    }}
                  >
                    {data.unallocated.note && (
                      <span title={data.unallocated.note} style={{ marginRight: 6 }}>⚠</span>
                    )}
                    Не разнесено по товарам: реклама {money(data.unallocated.ads)} · кабинетные {money(data.unallocated.cabinetCosts)}
                  </td>
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>

      {/* Пагинация */}
      {pageSize !== 0 && totalPages > 1 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "center", marginTop: 14 }}>
          <PagerBtn onClick={() => setPage(1)} disabled={safePage <= 1}>«</PagerBtn>
          <PagerBtn onClick={() => setPage(safePage - 1)} disabled={safePage <= 1}>‹</PagerBtn>
          <span style={{ padding: "0 12px", fontSize: 13, color: C.muted }}>{safePage} / {totalPages}</span>
          <PagerBtn onClick={() => setPage(safePage + 1)} disabled={safePage >= totalPages}>›</PagerBtn>
          <PagerBtn onClick={() => setPage(totalPages)} disabled={safePage >= totalPages}>»</PagerBtn>
        </div>
      )}

      {/* Кабинетные расходы (№27) — то, что API МП НЕ привязывает к товару.
          По контракту НЕЛЬЗЯ размазывать по SKU (искажает маржу): показываем
          отдельной секцией под основной таблицей. Источник: /api/cabinet-costs. */}
      {cab && cab.items && cab.items.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: C.ink }}>
            Кабинетные расходы (без привязки к товару)
          </h2>
          <p style={{ margin: "0 0 10px", color: C.muted, fontSize: 12 }}>
            Период {cab.period?.from || "—"} → {cab.period?.to || "—"} · Итого {money(cab.totals.all)}
            {" "}(<span style={{ color: C.accent }}>WB {money(cab.totals.wb)}</span>
            {" · "}<span style={{ color: C.pink }}>Ozon {money(cab.totals.ozon)}</span>)
          </p>
          <div style={{
            ...ALERT.info, padding: "8px 12px", borderRadius: 8, marginBottom: 10, fontSize: 12,
            display: "flex", gap: 8, alignItems: "center",
          }}>
            <span>⚠️</span>
            <span>{cab.methodology}</span>
          </div>
          <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
                  <th style={thStyle}>Тип расхода</th>
                  <th style={thStyle}>Платформа</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Сумма, ₽</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Доля</th>
                </tr>
              </thead>
              <tbody>
                {cab.items.map((it) => (
                  <tr key={it.platform + "-" + it.cost_type} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                    <Td left>{it.label}</Td>
                    <Td>
                      <span style={{
                        padding: "1px 6px", borderRadius: 5, fontSize: 10, fontWeight: 700,
                        background: it.platform === "wb" ? `${soft("accent", 13)}` : `${soft("pink", 13)}`,
                        color: it.platform === "wb" ? C.accent : C.pink,
                      }}>{it.platform === "wb" ? "WB" : "Ozon"}</span>
                    </Td>
                    <Td right>
                      {/* Знак/цвет как в P&L (PnlPage.jsx:255) — amount уже
                          канон-знак (расход<0, доход/возмещение>0), тот же
                          источник, что и на P&L: расход — красный, доход/
                          возмещение — зелёный, без platform-веток. */}
                      <span style={{ color: (it.amount || 0) < 0 ? C.neg : C.pos, fontWeight: 600 }}>
                        {money(it.amount)}
                      </span>
                    </Td>
                    <Td right>{it.share != null ? pct(it.share) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
                  <td style={tdFootL}>Итого</td>
                  <td style={tdFootR}>—</td>
                  {/* Цвет по знаку (как cabinetCostsTotal на P&L, PnlPage.jsx:68-72:
                      v<0 → C.neg, иначе C.ink) — раньше был жёстко C.neg вне
                      зависимости от факта. */}
                  <td style={{ ...tdFootR, fontWeight: 800, color: (cab.totals.all || 0) < 0 ? C.neg : C.ink }}>{money(cab.totals.all)}</td>
                  <td style={tdFootR}>100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}

// ДРР-пилл: tone==null → голый % (как раньше); иначе цветная подложка
// (drrPillTone — пороги ОТНОСИТЕЛЬНО маржи, решение владельца 25.08).
function DrrPill({ drr, margin, ads, sold }) {
  const tone = drrPillTone(drr, margin, ads, sold);
  if (tone == null) return pct(drr);
  const token = tone === "ok" ? "pos" : tone === "warn" ? "warn" : "neg";
  return (
    <span style={{
      display: "inline-block", fontSize: 11.5, fontWeight: 600, borderRadius: 6,
      padding: "2px 8px", color: C[token], background: soft(token, 13),
    }}>
      {sold ? pct(drr) : "—"}
    </span>
  );
}

// Композитная ячейка «Товар» (макет-эталон): имя жирным + вторая строка
// «Площадка · артикул» (faint) + категория-чип. Бренд/группа/магазин/баркод —
// в title-подсказке (не теряются, но не загромождают строку — «премиально»).
function ProductCell({ it }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 280, maxWidth: 380 }}>
      <Thumb url={it.im_url} />
      <div
        style={{ minWidth: 0, flex: 1 }}
        title={[it.brand, it.grp, it.shop, it.barcode ? `штрихкод ${it.barcode}` : null].filter(Boolean).join(" · ")}
      >
        <div style={{
          fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden",
          textOverflow: "ellipsis", maxWidth: 340,
        }} title={it.name}>
          {it.name || "—"}
        </div>
        <div style={{ fontSize: 12, color: C.faint, whiteSpace: "nowrap", marginTop: 1, display: "flex", alignItems: "center", gap: 6 }}>
          <span>{it.platform === "wb" ? "WB" : "Ozon"} · {it.sa || it.nm}</span>
          {it.cat && (
            <span style={{
              padding: "1px 6px", borderRadius: 5, fontSize: 11,
              border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.muted,
            }}>{it.cat}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Колонки (key указывает на поле item) ----------
const COLS = [
  { key: "name",        label: "Товар",          align: "left", minW: 320, sort: "name" },
  { key: "ordered",     label: "Заказано",       minW: 80, sort: "num" },
  { key: "sold",        label: "Продано",        minW: 70, sort: "num" },
  { key: "cancelled",   label: "Отмен",          minW: 60, sort: "num" },
  { key: "returns",     label: "Возвраты",       minW: 70, sort: "num" },
  { key: "returnLogistics", label: "Убыток возвр.", minW: 90, sort: "num" },
  { key: "stock",       label: "Остаток",        minW: 75, sort: "num" },
  { key: "buyoutPct",   label: "% выкупа",       minW: 75, sort: "num" },
  { key: "avgOrdersDay",label: "Зак/день",       minW: 70, sort: "num" },
  { key: "orderRub",    label: "Заказов, ₽",     minW: 100, sort: "num" },
  { key: "avgCheck",    label: "Ср. чек",        minW: 85, sort: "num" },
  { key: "salesRub",    label: "Продажи, ₽",     minW: 100, sort: "num" },
  { key: "costRub",     label: "Себест., ₽",     minW: 95, sort: "num" },
  { key: "commission",  label: "Комиссия, ₽",    minW: 95, sort: "num" },
  { key: "commissionPct",label: "Ком. %",        minW: 65, sort: "num" },
  { key: "logistics",   label: "Логистика, ₽",   minW: 95, sort: "num" },
  // services («Сборы Ozon», задача 4 плана «Сборы Ozon», 2026-08-25) — только
  // у Ozon-строк (it.services у WB-товаров не существует → money(undefined) =
  // «—», симметрично returnLogistics/profitGross и др. Ozon-only полям).
  { key: "services",    label: "Сборы Ozon, ₽",  minW: 100, sort: "num",
    hint: "отзывы, рассрочка, упаковка, размещение, утилизация и прочие позаказные сборы Ozon" },
  { key: "acquiring",   label: "Эквайринг, ₽",   minW: 95, sort: "num" },
  { key: "adSpend",     label: "Реклама, ₽",     minW: 95, sort: "num" },
  { key: "loyalty",     label: "Лояльность, ₽",  minW: 95, sort: "num" },
  { key: "tax",         label: "Налог, ₽",       minW: 85, sort: "num" },
  { key: "profit",      label: "Прибыль, ₽",     minW: 100, sort: "num" },
  { key: "avgProfit",   label: "Ср. прибыль",    minW: 90, sort: "num" },
  { key: "margin",      label: "Маржа",          minW: 70, sort: "num" },
  { key: "roi",         label: "ROI",            minW: 65, sort: "num" },
  { key: "drr",         label: "ДРР",            minW: 60, sort: "num" },
  { key: "romi",        label: "ROMI",           minW: 70, sort: "num" },
  { key: "cpa",         label: "CPA, ₽",         minW: 80, sort: "num" },
  { key: "turnoverDays",label: "Оборач., дн",    minW: 85, sort: "num" },
];

// ---------- Хелперы UI ----------
const thStyle = {
  padding: "10px 8px", fontSize: 11, color: C.muted, textTransform: "uppercase",
  fontWeight: 600, whiteSpace: "nowrap", textAlign: "center",
};
function Th({ col, sort, setSort }) {
  const sortable = !!col.sort;
  const isActive = sortable && sort?.key === col.key;
  const onClick = sortable ? () => {
    if (isActive) setSort({ key: col.key, dir: sort.dir === "asc" ? "desc" : "asc" });
    else setSort({ key: col.key, dir: "desc" });
  } : undefined;
  return (
    <th
      onClick={onClick}
      style={{
        ...thStyle,
        textAlign: col.align === "left" ? "left" : "center",
        cursor: sortable ? "pointer" : "default",
        color: isActive ? C.ink : C.muted,
        minWidth: col.minW,
        position: "sticky",
        top: 0,
        zIndex: 1,
      }}
      title={col.hint ? (sortable ? `Сортировка · ${col.hint}` : col.hint) : (sortable ? "Сортировка" : undefined)}
    >
      {col.label}{isActive ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}

function Td({ children, right, left, mono, title, style }) {
  return (
    <td style={{
      padding: "8px 8px", fontSize: 12.5, whiteSpace: "nowrap",
      textAlign: right ? "right" : left ? "left" : "center",
      fontVariantNumeric: (right || mono) ? "tabular-nums" : "normal",
      fontFamily: mono ? "ui-monospace, Consolas, monospace" : "inherit",
      ...style,
    }} title={title}>{children}</td>
  );
}
const tdFootL = { padding: "10px 8px", fontSize: 12.5, fontWeight: 800, color: C.ink, textAlign: "left", whiteSpace: "nowrap" };
const tdFootR = { padding: "10px 8px", fontSize: 12.5, color: C.ink, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

// delta — {text, dir} из хелпера delta() выше, или null (нет prev/деление на
// 0 — просто не рендерим строку, без "NaN"). deltaTitle — тультип на строку
// дельты (формат: «Сравнение периодов: … против …»). sub — второстепенная
// muted-подпись под значением (плитка «Реклама»: «ДРР N %»). children — доп.
// контент primary-плитки (спарклайн), выравнивается справа от текста.
function Kpi({ label, value, color, title, primary, delta, deltaTitle, sub, children }) {
  return (
    <div style={{
      padding: "12px 16px", borderRadius: 10, background: C.surface,
      border: `1px solid ${C.line}`, minWidth: 130,
      ...(primary ? { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } : {}),
    }} title={title}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: primary ? 30 : 18, fontWeight: 800, color: color || C.ink, fontVariantNumeric: "tabular-nums" }}>{value}</div>
        {delta && (
          <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, color: delta.dir === "up" ? C.pos : C.neg }} title={deltaTitle}>
            {delta.dir === "up" ? "▲" : "▼"} {delta.text}
          </div>
        )}
        {sub && <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>{sub}</div>}
      </div>
      {primary && children}
    </div>
  );
}

function PagerBtn({ children, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "6px 12px", borderRadius: 7, cursor: disabled ? "default" : "pointer", fontFamily: "inherit",
      border: `1px solid ${disabled ? C.line : C.accent}`, background: disabled ? "transparent" : C.accent,
      color: disabled ? C.faint : "var(--accentInk)", fontWeight: 700, fontSize: 13,
    }}>{children}</button>
  );
}

function Thumb({ url }) {
  const [err, setErr] = useState(false);
  if (!url || err) {
    return (
      <div style={{
        width: 40, height: 40, borderRadius: 7, flexShrink: 0,
        background: C.surfaceAlt, border: `1px solid ${C.line}`,
        display: "grid", placeItems: "center", color: C.faint, fontSize: 16,
      }}>🖼</div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url} alt="" width={40} height={40}
      onError={() => setErr(true)}
      style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 7, flexShrink: 0, border: `1px solid ${C.line}` }}
    />
  );
}

function Seg({ children }) {
  return <div style={{ display: "inline-flex", border: `1px solid ${C.line}`, borderRadius: 9, overflow: "hidden" }}>{children}</div>;
}
function SegBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, border: "none",
      background: active ? C.accent : C.surfaceAlt, color: active ? "var(--accentInk)" : C.ink,
      fontFamily: "inherit",
    }}>{children}</button>
  );
}
function Field({ label, children }) {
  return (
    <label style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</span>
      <div style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>{children}</div>
    </label>
  );
}
// Мультивыбор категорий галочками: кнопка "Все категории"/"N выбрано" +
// дропдаун со списком чекбоксов (счётчик товаров из facets.cat) и
// "Выбрать все"/"Сбросить". Закрытие — по клику вне контрола.
function CategoryMultiSelect({ options, selected, setSelected }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const toggleValue = (v) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v); else next.add(v);
      return next;
    });
  };

  const label = selected.size === 0 ? "Все категории" : `${selected.size} выбрано`;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ ...selectStyle, minWidth: 150, textAlign: "left" }}
      >
        {label}
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20,
          minWidth: 240, maxWidth: 320, background: C.surface, border: `1px solid ${C.line}`,
          borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", overflow: "hidden",
        }}>
          <div style={{
            display: "flex", gap: 8, padding: "6px 8px", borderBottom: `1px solid ${C.line}`,
            background: C.surfaceAlt,
          }}>
            <button
              type="button"
              onClick={() => setSelected(new Set(options.map(([v]) => v)))}
              style={miniBtnStyle}
            >Выбрать все</button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              style={miniBtnStyle}
            >Сбросить</button>
          </div>
          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            {options.length === 0 && (
              <div style={{ padding: "10px 12px", fontSize: 12, color: C.muted }}>Нет данных</div>
            )}
            {options.map(([v, n]) => (
              <label
                key={v}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                  fontSize: 12.5, color: C.ink, cursor: "pointer",
                }}
              >
                <input type="checkbox" checked={selected.has(v)} onChange={() => toggleValue(v)} />
                <span style={{
                  flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }} title={v}>{v}</span>
                <span style={{ color: C.faint, fontSize: 11 }}>{n}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
const miniBtnStyle = {
  padding: "3px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600,
  border: `1px solid ${C.line}`, background: "transparent", color: C.muted, fontFamily: "inherit",
};
const inputStyle = {
  padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line}`,
  background: C.surfaceAlt, color: C.ink, fontSize: 13, fontFamily: "inherit",
};
const selectStyle = {
  ...inputStyle,
  padding: "7px 26px 7px 10px",
  appearance: "none",
  backgroundImage: "linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)",
  backgroundPosition: "calc(100% - 14px) 50%, calc(100% - 9px) 50%",
  backgroundSize: "5px 5px, 5px 5px",
  backgroundRepeat: "no-repeat",
  cursor: "pointer",
};
const resetBtnStyle = {
  padding: "7px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
  border: `1px solid ${C.line}`, background: "transparent", color: C.muted, fontFamily: "inherit",
};

function Centered({ children }) {
  return <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>{children}</div>;
}
