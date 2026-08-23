"use client";
import { C, soft } from "@/lib/palette.js";
import { ALERT } from "@/lib/callout.js";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  ComposedChart, Bar,
} from "recharts";
// Палитра SAAS (тёмно-синяя)

// =====================================================================
//  /products/detail — ЕДИНАЯ детальная сводка по ОДНОМУ товару (WB или Ozon).
//
//  Единая точка истины: клик из «Сводки по товарам» (/products) И клик из
//  «РНП» (/products/rnp) ведут СЮДА. Источник: /api/products/detail.
//
//  Параметры (через query): platform=wb|ozon, nm=<id>, from, to.
//  На странице — свой селектор периода (можно сменить на месте).
//
//  WB-режим: полный функционал — декомпозиция Заказы/Клики/Корзины (реклама/
//  органика/+план для заказов), двухуровневое дерево Реклама ₽ (→ 3 модели →
//  показы/клики/корзины/заказы), конверсии по дням с декомпозицией по источнику
//  (organic/единая/ручная/CPC), линии графика Склады/Остатки/Продажи.
//
//  ⚠️ АСИММЕТРИЯ данных (gotcha #155): у Ozon нет СПП/rating/3 моделей рекламы
//  и продаж по складам/округам (только город доставки). Ozon-режим — упрощённая
//  матрица + города доставки + выручка/прибыль из order_costs. Недоступные блоки
//  — с честными пометками ограничений. Не выравниваем Ozon под WB искусственно.
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const money = (v) => {
  const x = r2(v);
  return x == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(x) + " ₽";
};
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : r2(v) + "%");
const pctFromRate = (rate) => (rate == null ? null : Math.round(rate * 1000) / 10);
// План по дням: обычно дробная норма (50/30 ≈ 1,67), показываем с 2 знаками;
// целые значения без лишних нулей (2, а не 2,00).
const planNum = (v) => (v == null || !Number.isFinite(v) ? "—" : (Number.isInteger(v) ? String(v) : r2(v).toLocaleString("ru-RU")));

export default function DetailPage({ cabinetId }) {
  return (
    <Suspense fallback={<Centered>Загрузка…</Centered>}>
      <DetailInner cabinetId={cabinetId} />
    </Suspense>
  );
}

function DetailInner({ cabinetId }) {
  const sp = useSearchParams();
  const platform = sp.get("platform") || "wb";
  const nm = sp.get("nm") || "";

  // Период: инициализируем из URL, дальше — локальный стейт (можно менять на месте).
  const [dateFrom, setDateFrom] = useState(sp.get("from") || "");
  const [dateTo, setDateTo] = useState(sp.get("to") || "");
  const [preset, setPreset] = useState("custom");
  const [presetReady, setPresetReady] = useState(!!(sp.get("from") && sp.get("to")));

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // Если период не пришёл из URL — ставим дефолт «этот месяц».
  useEffect(() => {
    if (!presetReady) {
      const [f, t] = presetToDates("thisMonth");
      setDateFrom(f); setDateTo(t); setPreset("thisMonth"); setPresetReady(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (platform) p.set("platform", platform);
    if (nm) p.set("nm", nm);
    if (dateFrom) p.set("from", dateFrom);
    if (dateTo) p.set("to", dateTo);
    return p.toString();
  }, [platform, nm, dateFrom, dateTo]);

  useEffect(() => {
    if (!nm || !dateFrom || !dateTo) return;
    setData(null); setError(null);
    fetch(`/api/cabinets/${cabinetId}/detail` + (qs ? "?" + qs : ""))
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)));
  }, [qs, nm, dateFrom, dateTo]);

  const onPresetChange = (p) => {
    setPreset(p);
    if (p === "custom") return;
    const [f, t] = presetToDates(p);
    setDateFrom(f); setDateTo(t);
  };
  const onManualDate = (which, val) => {
    setPreset("custom");
    if (which === "from") setDateFrom(val); else setDateTo(val);
  };

  if (!nm) return <Centered>Не указан товар (параметр nm).</Centered>;
  if (error) return <Centered>⚠️ {error}</Centered>;
  if (!data) return <Centered>Загрузка детальной сводки…</Centered>;

  const period = data.period || {};
  // Кнопка «назад» — туда, откуда вероятнее всего пришли. Если в URL есть ref=rnp,
  // возвращаем в РНП с тем же периодом; иначе — в «Сводку по товарам».
  const ref = sp.get("ref");
  const periodQs = dateFrom || dateTo
    ? "?" + new URLSearchParams(Object.fromEntries([dateFrom && ["from", dateFrom], dateTo && ["to", dateTo]].filter(Boolean))).toString()
    : "";
  const backHref = ref === "rnp"
    ? `/cabinets/${cabinetId}/rnp` + periodQs
    : `/cabinets/${cabinetId}/summary` + periodQs;
  const backLabel = ref === "rnp" ? "← В РНП" : "← К сводке по товарам";

  return (
    <main style={{ width: "100%", margin: 0, padding: "20px 18px", fontFamily: FONT, color: C.ink }}>
      <Link href={backHref} style={{ ...btnStyle, display: "inline-block", marginBottom: 14, textDecoration: "none" }}>
        {backLabel}
      </Link>

      {/* Шапка товара */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <Thumb url={data.product?.im_url} big />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{data.product?.name || String(nm)}</div>
          <div style={{ fontSize: 12, color: C.faint, marginTop: 2 }}>
            {data.product?.sa ? <>арт. продавца: {data.product.sa}</> : null}
            {data.product?.barcode ? <> · баркод: {data.product.barcode}</> : null}
            {data.product?.brand ? <> · {data.product.brand}</> : null}
            {data.product?.cat ? <> · {data.product.cat}</> : null}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
            {platform === "wb" ? "nm_id" : "product_id"}: {nm} · {data.product?.shop || ""}
            <span style={{
              marginLeft: 6, padding: "1px 6px", borderRadius: 5, fontSize: 10, fontWeight: 700,
              background: platform === "wb" ? `${soft("accent", 13)}` : `${soft("pink", 13)}`,
              color: platform === "wb" ? C.accent : C.pink,
            }}>{platform === "wb" ? "WB" : "Ozon"}</span>
          </div>
        </div>

        {/* Селектор периода */}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label="Быстрый период">
            <select value={preset} onChange={(e) => onPresetChange(e.target.value)} style={selectStyle}>
              <option value="thisMonth">Этот месяц</option>
              <option value="lastMonth">Прошлый месяц</option>
              <option value="week">Неделя (7 дн)</option>
              <option value="yesterday">Вчера</option>
              <option value="custom">Свободный…</option>
            </select>
          </Field>
          <Field label="Период">
            <input type="date" value={dateFrom} onChange={(e) => onManualDate("from", e.target.value)} style={inputStyle} />
            <span style={{ color: C.faint, fontSize: 12 }}>—</span>
            <input type="date" value={dateTo} onChange={(e) => onManualDate("to", e.target.value)} style={inputStyle} />
          </Field>
        </div>
      </div>

      <p style={{ margin: "0 0 14px", color: C.muted, fontSize: 12 }}>
        период {period.from || "—"} → {period.to || "—"} ({period.days || "?"} дн.)
      </p>

      {platform === "ozon" && (
        <div style={{ ...ALERT.warn, padding: "8px 12px", borderRadius: 8, marginBottom: 14, fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
          <span>ℹ️</span>
          <span>У Ozon нет СПП, рейтинга и разбивки рекламы по моделям; продажи по складам/округам недоступны (только город доставки); остатки — снимок (история короткая). Достоверная выручка/прибыль — из финотчёта по отправлениям.</span>
        </div>
      )}

      <Detail data={data} platform={platform} />
    </main>
  );
}

// =====================================================================
//  Описание строк матрицы/конверсий — WB (полный набор) и Ozon (упрощённый).
// =====================================================================

// WB — строки матрицы. orders/clicks/cart — раскрывающиеся группы (реклама/органика,
// у orders +план); реклама собрана в двухуровневое дерево ({adGroup:true});
// прибыль собрана в раскрывающуюся группу ({profitGroup:true}) — Прибыль ₽
// родитель → выручка/себест/комиссия/логистика/эквайринг по дням.
const WB_MATRIX_ROWS = [
  { key: "orders",      label: "Заказы",           sheet: "R7", kind: "int", group: "orders" },
  { key: "orders_sum",  label: "Сумма заказов, ₽", sheet: "R7₽", kind: "money" },
  { key: "sales",       label: "Продажи",          kind: "int" },
  { profitGroup: true }, // раскрывающаяся «Прибыль ₽» → выручка/себест/комиссия/логистика/эквайринг
  { key: "clicks",      label: "Клики",            sheet: "R5", kind: "int", group: "clicks" },
  { key: "cart",        label: "Корзины",          sheet: "R6", kind: "int", group: "cart" },
  { key: "price",       label: "Цена до СПП",      sheet: "R8", kind: "price" },
  { key: "spp",         label: "СПП %",            sheet: "R10", kind: "spp" },
  { key: "price_with_spp", label: "Цена с СПП",   sheet: "R9", kind: "price" },
  { adGroup: true }, // общая кликабельная строка «Реклама ₽» → AD_MODELS
  { ratingGroup: true }, // раскрывающийся «Рейтинг и оценки» → nm/imt × рейтинг+кол-во
];
// Декомпозиция прибыли (строки 2-го уровня, раскрываются из «Прибыль ₽»).
const PROFIT_SUB = [
  { key: "revenue",    label: "Выручка, ₽",       kind: "money" },
  { key: "cost",       label: "Себестоимость, ₽", kind: "money" },
  { key: "commission", label: "Комиссия, ₽",      kind: "money" },
  { key: "logistics",  label: "Логистика, ₽",     kind: "money" },
  { key: "acquiring",  label: "Эквайринг, ₽",     kind: "money" },
];
// Модели рекламы (строки 2-го уровня дерева).
const AD_MODELS = [
  { key: "ad_edinaya_spend",  label: "Реклама единая ₽", sheet: "R11-15", kind: "money", group: "edinaya" },
  { key: "ad_ruchnaya_spend", label: "Реклама ручная ₽", sheet: "R16-20", kind: "money", group: "ruchnaya" },
  { key: "ad_cliki_spend",    label: "Реклама клики ₽",  sheet: "R21-25", kind: "money", group: "cliki" },
];
// Ozon — матрица. Без СПП (механики нет), без моделей рекламы (одна ставка).
// orders_sum = СПРОС (SUM(total) из orders по order_dt — синхронно с «Заказы»);
// sold/revenue/profit = ФАКТ (из order_costs по sale_dt, is_return=0).
// Корзины в API Ozon ДОСТУПНЫ (hits_tocart, сбор с 2026-08-02, см. ozon_metrics.py).
const OZ_MATRIX_ROWS = [
  { key: "orders",          label: "Заказы",            kind: "int", group: "oz_orders" },  // created (СПРОС); клик → реклама/органика
  { key: "sold",       label: "Продано",        kind: "int" },        // delivered (ФАКТ, is_return=0)
  { key: "orders_sum", label: "Сумма заказов, ₽", kind: "money" },
  { key: "clicks",     label: "Клики",          kind: "int" },
  // Корзины ДОСТУПНЫ в API Ozon (грабля 2026-08-02: метрика называется
  // hits_tocart, БЕЗ подчёркивания — из-за опечатки hits_to_cart считали
  // её несуществующей). Данные копятся с 2026-08-02; старые дни — «·».
  { key: "cart",       label: "Корзины",        kind: "int" },
  { key: "price",      label: "Цена",           kind: "price" },
  { key: "boost",      label: "Соинвест",       kind: "pct_raw" },    // снапшот бустинга Ozon (%)
  { key: "ad_spend",   label: "Реклама ₽",      kind: "money" },
  { key: "ad_views",   label: "Показы рекл.",   kind: "int" },
  { key: "profit",     label: "Прибыль ₽",      kind: "money" },
  { ratingGroup: true }, // раскрывающийся «Рейтинг и отзывы» (только nm, без склейки)
];

// Детализация строки модели рекламы.
const AD_SUB = [
  { suffix: "views",  label: "показы" },
  { suffix: "clicks", label: "клики" },
  { suffix: "atbs",   label: "корзины" },
  { suffix: "orders", label: "заказы" },
];
// Декомпозиция метрик: {group} → [дочерние]. Поля дня: <base>_<suffix>.
const SPLIT_SUB = {
  orders: [
    { suffix: "plan",    label: "Заказы план" },
    { suffix: "ad",      label: "Заказы реклама" },
    { suffix: "organic", label: "Заказы органика" },
  ],
  // Ozon: реклама/органика (без плана — его нет на день). Поля: orders_ad, orders_organic.
  oz_orders: [
    { suffix: "ad",      label: "Заказы реклама" },
    { suffix: "organic", label: "Заказы органика" },
  ],
  clicks: [
    { suffix: "ad",      label: "Клики реклама" },
    { suffix: "organic", label: "Клики органика" },
  ],
  cart: [
    { suffix: "ad",      label: "Корзины реклама" },
    { suffix: "organic", label: "Корзины органика" },
  ],
};

// Источники для декомпозиции конверсий: органика + 3 модели рекламы (CPC=клики).
const SRC = [
  { key: "organic",  label: "Органика", prefix: "" },
  { key: "edinaya",  label: "Единая",   prefix: "ad_edinaya_" },
  { key: "ruchnaya", label: "Ручная",   prefix: "ad_ruchnaya_" },
  { key: "cliki",    label: "CPC",      prefix: "ad_cliki_" },
];
const SRC_LABEL = { organic: "Органика", edinaya: "Единая", ruchnaya: "Ручная", cliki: "CPC" };

const adSpendDayWB = (d) => (d.ad_edinaya_spend || 0) + (d.ad_ruchnaya_spend || 0) + (d.ad_cliki_spend || 0);
const adViewsDayWB = (d) => (d.ad_edinaya_views || 0) + (d.ad_ruchnaya_views || 0) + (d.ad_cliki_views || 0);
const adClicksDayWB = (d) => (d.ad_edinaya_clicks || 0) + (d.ad_ruchnaya_clicks || 0) + (d.ad_cliki_clicks || 0);

// WB — конверсии по дням с декомпозицией по источнику (variants).
const WB_CONV_ROWS = [
  {
    key: "ctr_ad", label: "CTR рекламный", sheet: "R32-35", kind: "conv",
    fn: (d) => (adViewsDayWB(d) > 0 ? adClicksDayWB(d) / adViewsDayWB(d) : null),
    total: (t) => {
      const v = (t.ad_edinaya_views || 0) + (t.ad_ruchnaya_views || 0) + (t.ad_cliki_views || 0);
      const c = (t.ad_edinaya_clicks || 0) + (t.ad_ruchnaya_clicks || 0) + (t.ad_cliki_clicks || 0);
      return v > 0 ? c / v : null;
    },
    variants: [
      { src: "edinaya",  fn: (d) => ((d.ad_edinaya_views || 0) > 0 ? (d.ad_edinaya_clicks || 0) / d.ad_edinaya_views : null), total: (t) => ((t.ad_edinaya_views || 0) > 0 ? (t.ad_edinaya_clicks || 0) / t.ad_edinaya_views : null) },
      { src: "ruchnaya", fn: (d) => ((d.ad_ruchnaya_views || 0) > 0 ? (d.ad_ruchnaya_clicks || 0) / d.ad_ruchnaya_views : null), total: (t) => ((t.ad_ruchnaya_views || 0) > 0 ? (t.ad_ruchnaya_clicks || 0) / t.ad_ruchnaya_views : null) },
      { src: "cliki",    fn: (d) => ((d.ad_cliki_views || 0) > 0 ? (d.ad_cliki_clicks || 0) / d.ad_cliki_views : null), total: (t) => ((t.ad_cliki_views || 0) > 0 ? (t.ad_cliki_clicks || 0) / t.ad_cliki_views : null) },
    ],
  },
  {
    key: "clk2cart", label: "Клики → Корзины", sheet: "R36", kind: "conv",
    fn: (d) => (d.clicks > 0 ? d.cart / d.clicks : null),
    total: (t) => (t.clicks > 0 ? t.cart / t.clicks : null),
    variants: SRC.map((s) => ({
      src: s.key,
      fn: (d) => { const cl = s.prefix ? d[s.prefix + "clicks"] : d.clicks; const ca = s.prefix ? d[s.prefix + "atbs"] : d.cart; return cl > 0 ? ca / cl : null; },
      total: (t) => { const cl = s.prefix ? t[s.prefix + "clicks"] : t.clicks; const ca = s.prefix ? t[s.prefix + "atbs"] : t.cart; return cl > 0 ? ca / cl : null; },
    })),
  },
  {
    key: "cart2ord", label: "Корзины → Заказы", sheet: "R37", kind: "conv",
    fn: (d) => (d.cart > 0 ? d.orders / d.cart : null),
    total: (t) => (t.cart > 0 ? t.orders / t.cart : null),
    variants: SRC.map((s) => ({
      src: s.key,
      fn: (d) => { const ca = s.prefix ? d[s.prefix + "atbs"] : d.cart; const or = s.prefix ? d[s.prefix + "orders"] : d.orders; return ca > 0 ? or / ca : null; },
      total: (t) => { const ca = s.prefix ? t[s.prefix + "atbs"] : t.cart; const or = s.prefix ? t[s.prefix + "orders"] : t.orders; return ca > 0 ? or / ca : null; },
    })),
  },
  {
    key: "clk2ord", label: "Клики → Заказы", sheet: "R38", kind: "conv",
    fn: (d) => (d.clicks > 0 ? d.orders / d.clicks : null),
    total: (t) => (t.clicks > 0 ? t.orders / t.clicks : null),
    variants: SRC.map((s) => ({
      src: s.key,
      fn: (d) => { const cl = s.prefix ? d[s.prefix + "clicks"] : d.clicks; const or = s.prefix ? d[s.prefix + "orders"] : d.orders; return cl > 0 ? or / cl : null; },
      total: (t) => { const cl = s.prefix ? t[s.prefix + "clicks"] : t.clicks; const or = s.prefix ? t[s.prefix + "orders"] : t.orders; return cl > 0 ? or / cl : null; },
    })),
  },
  {
    // ДРРз = доля рекламных расходов = расход / Σ заказов ₽. В ПРОЦЕНТАХ (kind=conv).
    // Σ заказов ₽ = orders_sum (полный срез), с fallback на orders×price.
    key: "drr", label: "ДРРз", sheet: "R31", kind: "conv",
    fn: (d) => {
      const sales = d.orders_sum != null ? d.orders_sum : (d.price != null && d.orders != null ? d.orders * d.price : null);
      return sales > 0 ? adSpendDayWB(d) / sales : null;
    },
    total: (t) => {
      const sales = t.orders_sum != null ? t.orders_sum : (t.price != null ? t.orders * t.price : null);
      return sales > 0 ? ((t.ad_edinaya_spend || 0) + (t.ad_ruchnaya_spend || 0) + (t.ad_cliki_spend || 0)) / sales : null;
    },
    // ДРР по модели = spend_модели / (orders_модели × price). orders_sum не разложить
    // по моделям → используем orders_модели × price (price — снимок, местами null).
    variants: ["edinaya", "ruchnaya", "cliki"].map((m) => ({
      src: m,
      fn: (d) => { const sales = d.price != null && d["ad_" + m + "_orders"] != null ? d["ad_" + m + "_orders"] * d.price : null; return sales > 0 ? (d["ad_" + m + "_spend"] || 0) / sales : null; },
      total: (t) => { const sales = t.price != null && t["ad_" + m + "_orders"] != null ? t["ad_" + m + "_orders"] * t.price : null; return sales > 0 ? (t["ad_" + m + "_spend"] || 0) / sales : null; },
    })),
  },
  {
    key: "cpa", label: "Стоимость заказа, ₽", sheet: "R39", kind: "conv_money",
    fn: (d) => (d.orders > 0 ? adSpendDayWB(d) / d.orders : null),
    total: (t) => (t.orders > 0 ? ((t.ad_edinaya_spend || 0) + (t.ad_ruchnaya_spend || 0) + (t.ad_cliki_spend || 0)) / t.orders : null),
    variants: ["edinaya", "ruchnaya", "cliki"].map((m) => ({
      src: m,
      fn: (d) => ((d["ad_" + m + "_orders"] || 0) > 0 ? (d["ad_" + m + "_spend"] || 0) / d["ad_" + m + "_orders"] : null),
      total: (t) => ((t["ad_" + m + "_orders"] || 0) > 0 ? (t["ad_" + m + "_spend"] || 0) / t["ad_" + m + "_orders"] : null),
    })),
  },
];

// Ozon — конверсии без декомпозиции (нет разбивки рекламы по моделям).
const OZ_CONV_ROWS = [
  { key: "ctr_ad", label: "CTR рекламный", kind: "conv", fn: (d) => (d.ad_views > 0 ? (d.ad_clicks || 0) / d.ad_views : null), total: (t) => ((t.ad_views || 0) > 0 ? (t.ad_clicks || 0) / t.ad_views : null) },
  { key: "clk2cart", label: "Клики → Корзины (недоступно)", kind: "conv", fn: (d) => (d.clicks > 0 ? d.cart / d.clicks : null), total: (t) => (t.clicks > 0 ? t.cart / t.clicks : null) },
  { key: "cart2ord", label: "Корзины → Заказы (недоступно)", kind: "conv", fn: (d) => (d.cart > 0 ? d.orders / d.cart : null), total: (t) => (t.cart > 0 ? t.orders / t.cart : null) },
  { key: "clk2ord", label: "Клики → Заказы", kind: "conv", fn: (d) => (d.clicks > 0 ? d.orders / d.clicks : null), total: (t) => (t.clicks > 0 ? t.orders / t.clicks : null) },
  { key: "drr", label: "ДРР", kind: "conv", total: (t) => ((t.revenue || 0) > 0 ? (t.ad_spend || 0) / t.revenue : null), fn: (d) => ((d.revenue || 0) > 0 ? (d.ad_spend || 0) / d.revenue : null) },
  { key: "cpa", label: "Стоимость заказа, ₽", kind: "conv_money", fn: (d) => (d.orders > 0 && d.ad_spend != null ? d.ad_spend / d.orders : null), total: (t) => (t.orders > 0 ? (t.ad_spend || 0) / t.orders : null) },
];

// =====================================================================
//  Detail — разворот: МиниКПИ + график + конверсии + матрица + локации.
// =====================================================================

// Производные тона для декоративных серий графиков (было — точечные hex).
// Блендим базовые токены через color-mix, чтобы серии внутри ОДНОГО графика
// оставались взаимно различимы и при этом реагировали на смену темы, как и
// остальная палитра (soft() уже делает это для alpha-подложек).
const TINT_ACCENT = soft("accent", 65);  // пастельный accent            (было #C4B5FD)
const TINT_POS = soft("pos", 65);        // пастельный pos               (было #86EFAC)
const MIX_CYAN = "color-mix(in srgb, var(--accent) 50%, var(--accent2) 50%)";   // accent×accent2 (было #7DD3FC)
const MIX_PLUM = "color-mix(in srgb, var(--pink) 55%, var(--accent) 45%)";      // pink×accent    (было #A78BFA)
const MIX_ORANGE = "color-mix(in srgb, var(--warn) 60%, var(--neg) 40%)";       // warn×neg       (было #FB923C)
const MIX_DARKRED = "color-mix(in srgb, var(--neg) 70%, black 30%)";            // тёмный neg     (было #EF4444)
const MIX_GOLD = "color-mix(in srgb, var(--warn) 70%, white 30%)";              // светлый warn   (было #EAB308)

const CHART_LINES_WB = [
  { key: "orders",   label: "Заказы",   axis: "L", color: C.accent },
  { key: "sales",    label: "Продажи",  axis: "L", color: C.pos },
  { key: "stock",    label: "Остатки",  axis: "L", color: C.warn },
  { key: "wh_count", label: "Склады",   axis: "L", color: TINT_ACCENT },
  { key: "clicks",   label: "Клики",    axis: "L", color: MIX_CYAN },
  { key: "cart",     label: "Корзины",  axis: "L", color: TINT_POS },
  { key: "ad",       label: "Реклама ₽", axis: "R", color: C.accent2 },
  { key: "price",    label: "Цена",     axis: "L", color: MIX_PLUM },
  { key: "rating_nm",  label: "Рейтинг карточки", axis: "L", color: C.pink },
  { key: "rating_imt", label: "Рейтинг склейки",  axis: "L", color: C.neg },
];
const CHART_LINES_OZ = [
  { key: "orders", label: "Заказы",    axis: "L", color: C.accent },
  { key: "clicks", label: "Клики",     axis: "L", color: MIX_CYAN },
  { key: "cart",   label: "Корзины",   axis: "L", color: TINT_POS },
  { key: "ad",     label: "Реклама ₽", axis: "R", color: C.accent2 },
  { key: "price",  label: "Цена",      axis: "L", color: C.warn },
  { key: "profit", label: "Прибыль ₽", axis: "R", color: C.pos },
];

function Detail({ data, platform }) {
  const isWb = platform === "wb";
  const t = data.totals || {};
  const days = data.days || [];

  const [show, setShow] = useState(
    isWb
      ? { orders: true, ad: true, sales: false, stock: false, wh_count: false, clicks: false, cart: false, price: false, rating_nm: false, rating_imt: false }
      : { orders: true, ad: true, clicks: false, cart: false, price: false, profit: true }
  );
  const [expandAd, setExpandAd] = useState({ edinaya: false, ruchnaya: false, cliki: false });
  const [expandAdGroup, setExpandAdGroup] = useState(false);
  const [expandProfit, setExpandProfit] = useState(false);
  const [expandSplit, setExpandSplit] = useState({ orders: false, oz_orders: false, clicks: false, cart: false });
  const [expandConv, setExpandConv] = useState({});
  // Раскрытие «Рейтинг и оценки»: nm (карточка) / imt (склейка) × рейтинг+кол-во.
  const [expandRating, setExpandRating] = useState(false);
  // Переключатель серий графика «Статистика рекламы» (все 12 метрик).
  const [showAd, setShowAd] = useState({ views: true, clicks: false, ctr: false, atbs: false, orders: true, cr: false, spend: true, drr: false, cpc: false, cpa: false, cpm: false, orders_sum: false });

  const CHART_LINES = isWb ? CHART_LINES_WB : CHART_LINES_OZ;

  const chartData = days.map((d) => ({
    date: d.date.slice(5),
    orders: d.orders,
    sales: d.sales,
    stock: d.stock,
    wh_count: d.wh_count,
    clicks: d.clicks,
    cart: d.cart,
    price: d.price,
    rating_nm: d.rating_nm,
    rating_imt: d.rating_imt,
    profit: d.profit,
    ad: isWb
      ? r2((d.ad_edinaya_spend || 0) + (d.ad_ruchnaya_spend || 0) + (d.ad_cliki_spend || 0))
      : r2(d.ad_spend || 0),
  }));
  const activeLines = CHART_LINES.filter((l) => show[l.key]);
  const hasL = activeLines.some((l) => l.axis === "L");
  const hasR = activeLines.some((l) => l.axis === "R");

  // Данные графика «Статистика рекламы»: дневные значения метрик (количества — Σ моделей,
  // относительные/₽ — считаются). combo: столбцы для количеств + линии для %/₽.
  const adChartData = isWb ? days.map((d) => {
    const views = (d.ad_edinaya_views || 0) + (d.ad_ruchnaya_views || 0) + (d.ad_cliki_views || 0);
    const clicks = (d.ad_edinaya_clicks || 0) + (d.ad_ruchnaya_clicks || 0) + (d.ad_cliki_clicks || 0);
    const atbs = (d.ad_edinaya_atbs || 0) + (d.ad_ruchnaya_atbs || 0) + (d.ad_cliki_atbs || 0);
    const orders = (d.ad_edinaya_orders || 0) + (d.ad_ruchnaya_orders || 0) + (d.ad_cliki_orders || 0);
    const spend = (d.ad_edinaya_spend || 0) + (d.ad_ruchnaya_spend || 0) + (d.ad_cliki_spend || 0);
    return {
      date: d.date.slice(5),
      views, clicks, atbs, orders, spend,
      ctr: views > 0 ? clicks / views : null,          // доля (линия, %)
      cr: atbs > 0 ? orders / atbs : null,             // доля (линия, %)
      drr: d.orders_sum > 0 ? spend / d.orders_sum : null, // доля (линия, %)
      // ₽-метрики (линии): стоимость клика/заказа/1000 показов + сумма заказов.
      cpc: clicks > 0 ? spend / clicks : null,         // CPC
      cpa: orders > 0 ? spend / orders : null,         // CPA
      cpm: views > 0 ? (spend / views) * 1000 : null,  // CPM
      orders_sum: d.orders_sum ?? null,                // Сумма заказов ₽
    };
  }) : days.map((d) => ({
    date: d.date.slice(5),
    views: d.ad_views || 0, clicks: d.ad_clicks || 0, atbs: 0, orders: d.ad_orders || 0, spend: d.ad_spend || 0,
    ctr: (d.ad_views || 0) > 0 ? (d.ad_clicks || 0) / d.ad_views : null,
    cr: null, drr: null,
    cpc: (d.ad_clicks || 0) > 0 ? (d.ad_spend || 0) / d.ad_clicks : null,
    cpa: (d.ad_orders || 0) > 0 ? (d.ad_spend || 0) / d.ad_orders : null,
    cpm: (d.ad_views || 0) > 0 ? ((d.ad_spend || 0) / d.ad_views) * 1000 : null,
    orders_sum: null,
  }));
  // Конфигурация серий графика рекламы — все 12 метрик (как в KPI-плашках).
  // type: bar (столбцы, количества) | line (линии, % и ₽). Oсь: L (кол-ва/%) | R (₽).
  const AD_SERIES = isWb ? [
    { key: "views",  label: "Показы",    type: "bar",  color: C.warn },
    { key: "clicks", label: "Клики",     type: "bar",  color: MIX_CYAN },
    { key: "atbs",   label: "В корзину", type: "bar",  color: TINT_POS },
    { key: "orders", label: "Заказов",   type: "bar",  color: C.accent },
    { key: "ctr",    label: "CTR %",     type: "line", color: MIX_PLUM },
    { key: "cr",     label: "CR %",      type: "line", color: C.pink },
    { key: "drr",    label: "ДРР %",     type: "line", color: C.accent2 },
    { key: "spend",      label: "Расходы ₽",  type: "line", color: C.neg, axis: "R" },
    { key: "cpc",        label: "CPC ₽",      type: "line", color: MIX_ORANGE, axis: "R" },
    { key: "cpa",        label: "CPA ₽",      type: "line", color: MIX_DARKRED, axis: "R" },
    { key: "cpm",        label: "CPM ₽",      type: "line", color: MIX_GOLD, axis: "R" },
    { key: "orders_sum", label: "Сумма ₽",    type: "line", color: C.pos, axis: "R" },
  ] : [
    { key: "views",  label: "Показы",    type: "bar",  color: C.warn },
    { key: "clicks", label: "Клики",     type: "bar",  color: MIX_CYAN },
    { key: "orders", label: "Заказов",   type: "bar",  color: C.accent },
    { key: "ctr",    label: "CTR %",     type: "line", color: MIX_PLUM },
    { key: "spend",      label: "Расходы ₽",  type: "line", color: C.neg, axis: "R" },
    { key: "cpc",        label: "CPC ₽",      type: "line", color: MIX_ORANGE, axis: "R" },
    { key: "cpa",        label: "CPA ₽",      type: "line", color: MIX_DARKRED, axis: "R" },
    { key: "cpm",        label: "CPM ₽",      type: "line", color: MIX_GOLD, axis: "R" },
  ];

  // Σ/последнее по строке метрики (для колонки ИТОГО матрицы).
  const rowTotal = (row) => {
    if (row.kind === "price" || row.kind === "rating" || row.kind === "pct_raw") return t[row.key];
    if (row.kind === "spp") return t.spp;
    if (row.key === "orders_sum") return t.orders_sum ?? null;
    if (row.key === "rating_glue") return null;
    let s = 0, has = false;
    for (const d of days) { if (d[row.key] != null) { s += d[row.key]; has = true; } }
    return has ? s : null;
  };

  // Блок конверсий (ConvCards в шапке).
  const adSpend = isWb
    ? (t.ad_edinaya_spend || 0) + (t.ad_ruchnaya_spend || 0) + (t.ad_cliki_spend || 0)
    : (t.ad_spend || 0);
  const adViews = isWb
    ? (t.ad_edinaya_views || 0) + (t.ad_ruchnaya_views || 0) + (t.ad_cliki_views || 0)
    : (t.ad_views || 0);
  const adClicks = isWb
    ? (t.ad_edinaya_clicks || 0) + (t.ad_ruchnaya_clicks || 0) + (t.ad_cliki_clicks || 0)
    : (t.ad_clicks || 0);
  // Рекламные корзины (atbs = added to basket) — для блока «Статистика рекламы».
  const adAtbs = isWb
    ? (t.ad_edinaya_atbs || 0) + (t.ad_ruchnaya_atbs || 0) + (t.ad_cliki_atbs || 0)
    : 0;
  // Рекламные заказы (по моделям) — для CR и CPA рекламы.
  const adOrders = isWb
    ? (t.ad_edinaya_orders || 0) + (t.ad_ruchnaya_orders || 0) + (t.ad_cliki_orders || 0)
    : 0;
  const salesSum = isWb
    ? (t.orders_sum != null ? t.orders_sum : (t.price != null ? t.orders * t.price : null))
    : (t.revenue != null ? t.revenue : null);
  const conv = {
    ctr_ad: adViews > 0 ? adClicks / adViews : null,
    clk2cart: t.clicks > 0 ? t.cart / t.clicks : null,
    cart2ord: t.cart > 0 ? t.orders / t.cart : null,
    clk2ord: t.clicks > 0 ? t.orders / t.clicks : null,
    drr: salesSum > 0 ? adSpend / salesSum : null,
    cpa: t.orders > 0 ? adSpend / t.orders : null,
  };

  // ПРОГНОЗ прибыли (по трактовке владельца: объём заказов по текущему темпу ×
  // оценочная прибыль с заказа). Считаем из totals + периода.
  //   - avgOrdersDay = orders / periodDays (темп заказов)
  //   - profitPerOrder = profit / orders (ориентировочная прибыль с заказа)
  //   - periodDays = data.period.days (длина выбранного окна)
  // Прогноз на месяц: avgOrdersDay × днейВМесяце × profitPerOrder. Показываем
  // только если есть и заказы, и прибыль — иначе null/«—».
  const periodDays = data.period?.days || days.length || 1;
  const forecast = (() => {
    const orders = t.orders || 0;
    const profit = t.profit;
    if (orders <= 0 || profit == null || periodDays <= 0) return null;
    const avgOrdersDay = orders / periodDays;
    const profitPerOrder = profit / orders;
    // Месяц, к которому относится конец периода — для расчёта длины месяца.
    const to = data.period?.to;
    if (!to) return null;
    const [yy, mm] = to.split("-").map(Number);
    const daysInMonth = new Date(yy, mm, 0).getDate();
    const forecastMonth = avgOrdersDay * daysInMonth * profitPerOrder;
    // Прогноз заказов на месяц (для подписи).
    const forecastOrdersMonth = avgOrdersDay * daysInMonth;
    return {
      month: Math.round(forecastMonth * 100) / 100,
      ordersMonth: Math.round(forecastOrdersMonth * 10) / 10,
      avgOrdersDay: Math.round(avgOrdersDay * 100) / 100,
      profitPerOrder: Math.round(profitPerOrder * 100) / 100,
      daysInMonth,
    };
  })();

  const toggle = (key) => setShow((s) => ({ ...s, [key]: !s[key] }));
  const stocks = data.stocks || { items: [], total: 0 };
  const sales = data.sales || { total: 0, byWarehouse: [], byCluster: [], byCity: [] };
  const MATRIX_ROWS = isWb ? WB_MATRIX_ROWS : OZ_MATRIX_ROWS;
  const CONV_ROWS = isWb ? WB_CONV_ROWS : OZ_CONV_ROWS;

  return (
    <div>
      {/* МиниКПИ */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <MiniKpi label="Заказы" value={num(t.orders)} />
        {isWb && <MiniKpi label="Сумма заказов ₽" value={money(t.orders_sum)} />}
        <MiniKpi label="Клики" value={num(t.clicks)} />
        <MiniKpi label="Корзины" value={num(t.cart)} />
        <MiniKpi label="Конв." value={pct(pctFromRate(t.clicks > 0 ? t.orders / t.clicks : null))} />
        <MiniKpi label="Реклама ₽" value={money(adSpend)} />
        {isWb ? (
          <>
            <MiniKpi label="Продажи" value={num(t.sales)} />
            <MiniKpi label="Выручка ₽" value={money(t.revenue)} />
            <MiniKpi label="Прибыль ₽" value={money(t.profit)} color={(t.profit || 0) >= 0 ? C.pos : C.neg} />
            <MiniKpi label="СПП %" value={t.spp != null ? pct(t.spp) : "—"} />
            <MiniKpi label="Рейтинг ★" value={data.product?.rating_nm != null ? r2(data.product.rating_nm) : "—"} />
            <MiniKpi label="Оценок (артикул)" value={data.product?.rating_nm_count != null ? num(data.product.rating_nm_count) : "—"} />
            <MiniKpi label="Оценок (склейка)" value={data.product?.rating_imt_count != null ? num(data.product.rating_imt_count) : "—"} />
          </>
        ) : (
          <>
            <MiniKpi label="Выручка ₽" value={money(t.revenue)} />
            <MiniKpi label="Прибыль ₽" value={money(t.profit)} color={(t.profit || 0) >= 0 ? C.pos : C.neg} />
            {data.product?.boost != null && (
              <MiniKpi label="Соинвест %" value={`${data.product.boost}%`} color={(data.product.boost || 0) > 0 ? C.pos : null} />
            )}
          </>
        )}
      </div>

      {/* ПРОГНОЗ прибыли (по темпу заказов × прибыль/заказ) */}
      {forecast && (
        <div
          title={`Прогноз по допущению: текущий темп заказов (${forecast.avgOrdersDay}/день) сохранится весь месяц (${forecast.daysInMonth} дн). Прибыль с заказа ≈ ${money(forecast.profitPerOrder)}.`}
          style={{
            display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
            padding: "8px 14px", marginBottom: 14, borderRadius: 10,
            background: C.surface, border: `1px solid ${soft("accent", 33)}`,
          }}
        >
          <span style={{ fontSize: 16 }}>🔮</span>
          <span style={{ fontSize: 12, color: C.faint, textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.3 }}>
            Прогноз прибыли (месяц)
          </span>
          <span style={{ fontSize: 18, fontWeight: 800, color: forecast.month >= 0 ? C.pos : C.neg, fontVariantNumeric: "tabular-nums" }}>
            {money(forecast.month)}
          </span>
          <span style={{ fontSize: 12, color: C.muted }}>
            {forecast.ordersMonth} заказов · темп {forecast.avgOrdersDay}/день · {money(forecast.profitPerOrder)}/заказ
          </span>
        </div>
      )}

      {/* Селектор показателей графика */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 14px", marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", fontWeight: 600, marginBottom: 6 }}>
          Показатели графика
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {CHART_LINES.map((l) => (
            <button key={l.key} onClick={() => toggle(l.key)} style={{
              padding: "5px 12px", borderRadius: 7, cursor: "pointer", fontSize: 12, fontFamily: "inherit",
              fontWeight: 600, border: `1px solid ${show[l.key] ? l.color : C.line}`,
              background: show[l.key] ? `color-mix(in srgb, ${l.color} 10%, transparent)` : "transparent",
              color: show[l.key] ? l.color : C.muted,
            }}>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: l.color, marginRight: 6, opacity: show[l.key] ? 1 : 0.3 }} />
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {/* График динамики */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: C.muted }}>Динамика по дням</div>
        {activeLines.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.muted, fontSize: 13 }}>Включите хотя бы один показатель выше</div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
              <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" stroke={C.faint} fontSize={10} tickMargin={6} />
              {hasL && <YAxis yAxisId="L" stroke={C.accent} fontSize={11} />}
              {hasR && <YAxis yAxisId="R" orientation="right" stroke={C.accent2} fontSize={11} />}
              <Tooltip content={<ChartTip />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {activeLines.map((l) => (
                <Line key={l.key} yAxisId={l.axis} type="monotone" dataKey={l.key} name={l.label}
                  stroke={l.color} strokeWidth={2} dot={false}
                  connectNulls={l.key === "price" || l.key === "rating_nm" || l.key === "rating_imt" || l.key === "stock" || l.key === "wh_count"} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
        <div style={{ marginTop: 6, fontSize: 11, color: C.faint }}>
          Левая ось — количества/индексы, правая — деньги. Цена/Рейтинг/Остатки/Склады — снимки.
        </div>
      </div>

      {/* Блок «Статистика рекламы» — KPI-плашки суммарно за период (как в кабинете WB).
          12 метрик: показы/клики/CTR/CPC/в корзину/заказов/CR/CPA/сумма/расходы/CPM/ДРР. */}
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: C.muted }}>Статистика рекламы</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginBottom: 18 }}>
        <ConvCard label="Показы" hint="Показы рекламы Σ" value={num(adViews)} />
        <ConvCard label="Клики" hint="Клики рекламы Σ" value={num(adClicks)} />
        <ConvCard label="CTR" hint="Клики / Показы" value={pct(pctFromRate(adViews > 0 ? adClicks / adViews : null))} />
        <ConvCard label="CPC, ₽" hint="Стоимость клика = Расход / Клики" value={money(adClicks > 0 ? adSpend / adClicks : null)} color={C.neg} />
        <ConvCard label="В корзину" hint="Корзины из рекламы (atbs) Σ" value={num(adAtbs)} />
        <ConvCard label="Заказов" hint="Заказы из рекламы Σ" value={num(adOrders)} />
        <ConvCard label="CR" hint="Конверсия рекламы = Заказы / Корзины" value={pct(pctFromRate(adAtbs > 0 ? adOrders / adAtbs : null))} />
        <ConvCard label="CPA, ₽" hint="Стоимость заказа = Расход / Заказы рекламы" value={money(adOrders > 0 ? adSpend / adOrders : null)} color={C.neg} />
        <ConvCard label="Сумма ₽" hint="Σ заказов за период" value={money(salesSum)} />
        <ConvCard label="Расходы ₽" hint="Σ рекламных расходов" value={money(adSpend)} color={C.neg} />
        <ConvCard label="CPM, ₽" hint="Стоимость 1000 показов = Расход / Показы × 1000" value={money(adViews > 0 ? (adSpend / adViews) * 1000 : null)} color={C.neg} />
        <ConvCard label="ДРР" hint="Расход / Σ заказов ₽" value={pct(pctFromRate(salesSum > 0 ? adSpend / salesSum : null))} color={salesSum > 0 && adSpend / salesSum > 0.3 ? C.neg : null} />
      </div>

      {/* Блок конверсий (ConvCards) */}
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: C.muted }}>Конверсии и стоимость</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10, marginBottom: 18 }}>
        <ConvCard label="Σ заказов, ₽" hint="Σ price_with_disc заказов за период" value={money(salesSum)} />
        <ConvCard label="Расход на рекламу, ₽" hint={isWb ? "Σ всех моделей" : "Агрегат"} value={money(adSpend)} color={C.neg} />
        <ConvCard label="ДРР" hint="Расход / Σ заказов ₽" value={pct(pctFromRate(conv.drr))} color={conv.drr != null && conv.drr > 0.3 ? C.neg : null} />
        <ConvCard label="CTR рекламный" hint="Клики рекл / Показы рекл" value={pct(pctFromRate(conv.ctr_ad))} />
        <ConvCard label="Клики → Корзины" hint="Корзины / Клики" value={pct(pctFromRate(conv.clk2cart))} />
        <ConvCard label="Корзины → Заказы" hint="Заказы / Корзины" value={pct(pctFromRate(conv.cart2ord))} />
        <ConvCard label="Клики → Заказы" hint="Заказы / Клики" value={pct(pctFromRate(conv.clk2ord))} />
        <ConvCard label="Стоимость заказа, ₽" hint="Расход / Заказы" value={money(conv.cpa)} color={C.neg} />
      </div>

      {/* Дневная матрица */}
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: C.muted }}>Дневная матрица — метрики по дням</div>
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface, marginBottom: 18 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
              <th style={{ ...thMatStyle, textAlign: "left", position: "sticky", left: 0, background: C.surfaceAlt, minWidth: 160, zIndex: 2 }}>Метрика</th>
              {days.map((d) => (
                <th key={d.date} style={{ ...thMatStyle, minWidth: 56 }}>
                  <div>{d.date.slice(8)}</div>
                  <div style={{ fontSize: 9, color: C.faint, textTransform: "none" }}>{d.weekday}</div>
                </th>
              ))}
              <th style={{ ...thMatStyle, position: "sticky", right: 0, background: C.surfaceAlt, minWidth: 80, zIndex: 2 }}>Σ / посл.</th>
            </tr>
          </thead>
          <tbody>
            {MATRIX_ROWS.map((row) =>
              row.adGroup
                ? renderAdGroup(days, rowTotal, expandAdGroup, setExpandAdGroup, expandAd, setExpandAd, expandSplit, setExpandSplit)
                : row.profitGroup
                  ? renderProfitGroup(days, rowTotal, expandProfit, setExpandProfit)
                  : row.ratingGroup
                    ? renderRatingGroup(days, data.product, expandRating, setExpandRating)
                    : renderMatrixRow(row, days, rowTotal, expandAd, setExpandAd, expandSplit, setExpandSplit)
            )}
            {/* Разделитель + конверсии по дням */}
            <tr>
              <td colSpan={days.length + 2} style={{ padding: "6px 12px", background: C.surfaceAlt, color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>
                Конверсии по дням — как ломается воронка
              </td>
            </tr>
            {CONV_ROWS.map((row) => renderConvRow(row, days, t, expandConv, setExpandConv))}
          </tbody>
        </table>
      </div>
      {isWb && (
        <div style={{ marginTop: -10, marginBottom: 18, fontSize: 11, color: C.faint }}>
          💡 Клик по «Прибыль ₽» раскрывает декомпозицию (выручка/себестоимость/комиссия/логистика/эквайринг). Клик по «Реклама ₽» раскрывает 3 модели (единая/ручная/клики), клик по модели — показы/клики/корзины/заказы. Клик по «Заказы»/«Клики»/«Корзины» и по конверсиям — декомпозицию по источнику (органика/единая/ручная/CPC).
        </div>
      )}

      {/* Combo-график «Статистика рекламы»: столбцы (количества) + линии (%/₽) по дням.
          Все 12 метрик (как в KPI-плашках). Переключатель метрик — чипы над графиком. */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 14px", marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
          <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", fontWeight: 600 }}>Статистика рекламы — динамика по дням</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {AD_SERIES.map((s) => (
            <button key={s.key} onClick={() => setShowAd((v) => ({ ...v, [s.key]: !v[s.key] }))} style={{
              padding: "4px 10px", borderRadius: 7, cursor: "pointer", fontSize: 11, fontFamily: "inherit",
              fontWeight: 600, border: `1px solid ${showAd[s.key] ? s.color : C.line}`,
              background: showAd[s.key] ? `color-mix(in srgb, ${s.color} 10%, transparent)` : "transparent",
              color: showAd[s.key] ? s.color : C.muted,
            }}>
              <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: s.type === "bar" ? 1 : 4, background: s.color, marginRight: 5, opacity: showAd[s.key] ? 1 : 0.3 }} />
              {s.label}
            </button>
          ))}
        </div>
        {Object.entries(showAd).every(([, v]) => !v) ? (
          <div style={{ padding: 20, textAlign: "center", color: C.muted, fontSize: 13 }}>Включите хотя бы один показатель выше</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={adChartData} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
              <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" stroke={C.faint} fontSize={10} tickMargin={6} />
              <YAxis yAxisId="L" stroke={C.accent} fontSize={11} />
              <YAxis yAxisId="R" orientation="right" stroke={C.accent2} fontSize={11} />
              <Tooltip content={<AdChartTip />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {AD_SERIES.filter((s) => showAd[s.key] && s.type === "bar").map((s) => (
                <Bar key={s.key} yAxisId="L" dataKey={s.key} name={s.label} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={18} />
              ))}
              {AD_SERIES.filter((s) => showAd[s.key] && s.type === "line").map((s) => (
                <Line key={s.key} yAxisId={s.axis === "R" ? "R" : "L"} type="monotone" dataKey={s.key} name={s.label}
                  stroke={s.color} strokeWidth={2} dot={false} connectNulls />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        )}
        <div style={{ marginTop: 6, fontSize: 11, color: C.faint }}>
          Столбцы — количества (Показы/Клики/Корзины/Заказы), линии — % (CTR/CR/ДРР) и ₽ (Расходы/CPC/CPA/CPM/Сумма). Левая ось — кол-ва/%, правая — ₽.
        </div>
      </div>

      {/* Блок «Позиции по ключам» (только WB — данные MPStats). Топ-15 ключей × дни,
          позиция с подсветкой (зелёный ≤10, жёлтый 11-30, красный >30), бейдж рекл/орг. */}
      {isWb && (
        <KeyPositionsBlock days={days} keywords={data.keywords || []} />
      )}

      {/* Остатки и локации */}
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: C.muted }}>Остатки и продажи по локациям</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12, marginBottom: 18 }}>
        <LocCard title="Остатки на складах" hint={stocks.snapshotDate ? `Снимок ${stocks.snapshotDate}` : "Последний снимок периода"} accent={C.accent}>
          {stocks.items.filter((w) => (w.quantity || 0) > 0).slice(0, 6).map((w, i) => (
            <LocRow key={"st" + i} name={w.warehouse} right={num(w.quantity)} muted={pct(pctFromRate(stocks.total > 0 ? (w.quantity || 0) / stocks.total : null))} />
          ))}
          {stocks.items.filter((w) => (w.quantity || 0) > 0).length === 0 && <EmptyHint text="Нет остатков" />}
          {stocks.total > 0 && <LocFoot label="ИТОГО (вкл. остальные)" value={num(stocks.total)} accent={C.accent} />}
        </LocCard>

        {isWb ? (
          <>
            <LocCard title="Продажи по складам" hint={`Всего ${num(sales.total)} шт за период`} accent={C.pos}>
              <LocHead />
              {sales.byWarehouse.slice(0, 6).map((w, i) => (
                <LocRowThree key={"sw" + i} name={w.name} count={w.count} share={w.share} localPct={w.localPct} />
              ))}
              {sales.byWarehouse.length === 0 && <EmptyHint text="Нет данных о продажах за период" />}
              {sales.byWarehouse.length > 0 && <LocFootThree label="ИТОГО" total={sales.total} localPct={sales.localPct} accent={C.pos} />}
            </LocCard>
            <LocCard title="Продажи по кластерам" hint="Федеральные округа" accent={C.accent2}>
              <LocHead />
              {sales.byCluster.slice(0, 6).map((w, i) => (
                <LocRowThree key={"sc" + i} name={w.name} count={w.count} share={w.share} localPct={w.localPct} />
              ))}
              {sales.byCluster.length === 0 && <EmptyHint text="Нет данных о продажах за период" />}
              {sales.byCluster.length > 0 && <LocFootThree label="ИТОГО" total={sales.total} localPct={sales.localPct} accent={C.accent2} />}
            </LocCard>
          </>
        ) : (
          <LocCard title="Города доставки" hint={`Только города из заказов · всего ${num(sales.total)} заказов`} accent={C.pos}>
            <LocHeadTwo />
            {sales.byCity.slice(0, 8).map((w, i) => (
              <LocRowTwo key={"cy" + i} name={w.name} count={w.count} share={w.share} />
            ))}
            {sales.byCity.length === 0 && <EmptyHint text="Нет данных о заказах за период" />}
          </LocCard>
        )}
      </div>
      {!isWb && (
        <div style={{ fontSize: 11, color: C.faint, marginBottom: 18 }}>
          ℹ️ У Ozon нет данных о складе отправления и федеральном округе заказа — доступен только город доставки.
        </div>
      )}
    </div>
  );
}

// =====================================================================
//  Рендер дерева рекламы + строк матрицы + строк конверсий.
// =====================================================================

// Рендер дерева «Рейтинг и оценки»: кликабельная строка (дневной честный рейтинг карточки
// из feedback_history) → при раскрытии 2 подстроки ПО ДНЯМ: «Карточка» (рейтинг+кол-во) и
// «Склейка» (рейтинг+кол-во). Рейтинг — кумулятив на дату (средняя по всем отзывам на момент
// дня), не периодный. Источник: feedback_history (собирает wb_cards.py). НЕ daily_metrics.rating
// (это feedbackRating — сглаженный WB рейтинг, который врёт; оставлен только для fallback).
function renderRatingGroup(days, product, expandRating, setExpandRating) {
  const p = product || {};
  const imtMembers = p.imt_nm_count;
  const hasGlue = imtMembers != null; // WB: есть склейка → показываем 2 уровня. Ozon: null → только nm.
  // последнее не-null значение рейтинга за период (для колонки Σ).
  const lastNm = lastVal(days, "rating_nm");
  const lastImt = lastVal(days, "rating_imt");
  const rows = [
    <tr key="_rating_group" onClick={() => setExpandRating((v) => !v)}
      style={{ borderBottom: `1px solid ${soft("line", 20)}`, cursor: "pointer", background: `${soft("accent", 3)}` }}>
      <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surface, zIndex: 1, fontWeight: 700, color: C.ink }}>
        {expandRating ? "▾ " : "▸ "}{hasGlue ? "Рейтинг и оценки" : "Рейтинг и отзывы"}
      </td>
      {days.map((d) => (
        <td key={d.date} style={{ ...tdMat, textAlign: "right" }}>
          {d.rating_nm != null ? r2(d.rating_nm) : <span style={{ color: C.faint }}>·</span>}
        </td>
      ))}
      <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surface, zIndex: 1, fontWeight: 700 }}>
        {lastNm != null ? r2(lastNm) : "—"}
      </td>
    </tr>,
  ];

  if (expandRating) {
    // Подстрока «Карточка (артикул)»: рейтинг + кол-во оценок по этому nm_id, по дням.
    rows.push(
      <tr key="_rating_nm" style={{ borderBottom: `1px solid ${soft("line", 13)}`, background: C.surfaceAlt }}>
        <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surfaceAlt, color: C.muted, paddingLeft: 28, fontSize: 11 }}>
          └ Карточка (артикул)
        </td>
        {days.map((d) => (
          <td key={d.date} style={{ ...tdMat, textAlign: "right", fontSize: 11, color: C.muted }}>
            {d.rating_nm != null ? `${r2(d.rating_nm)} · ${num(d.rating_nm_count)}` : "·"}
          </td>
        ))}
        <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surfaceAlt, fontSize: 11, color: C.muted }}>
          {lastNm != null ? `${r2(lastNm)} · ${num(lastVal(days, "rating_nm_count"))}` : "—"}
        </td>
      </tr>
    );
    // Подстрока «Склейка (все артикулы)»: рейтинг + кол-во оценок по imt_id, по дням.
    // Только WB (у Ozon нет склеек карточек — imt_nm_count=null).
    if (hasGlue) {
      const glueNote = imtMembers ? ` (из ${imtMembers} артикулов)` : "";
      rows.push(
        <tr key="_rating_imt" style={{ borderBottom: `1px solid ${soft("line", 13)}`, background: C.surfaceAlt }}>
          <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surfaceAlt, color: C.muted, paddingLeft: 28, fontSize: 11 }}>
            └ Склейка{glueNote}
          </td>
          {days.map((d) => (
            <td key={d.date} style={{ ...tdMat, textAlign: "right", fontSize: 11, color: C.muted }}>
              {d.rating_imt != null ? `${r2(d.rating_imt)} · ${num(d.rating_imt_count)}` : "·"}
            </td>
          ))}
          <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surfaceAlt, fontSize: 11, color: C.muted }}>
            {lastImt != null ? `${r2(lastImt)} · ${num(lastVal(days, "rating_imt_count"))}` : "—"}
          </td>
        </tr>
      );
    }
  }
  return rows;
}

// Последнее не-null значение поля по дням (для колонки Σ рейтингов-снимков).
function lastVal(days, key) {
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i][key] != null) return days[i][key];
  }
  return null;
}

// Рендер дерева «Прибыль ₽»: кликабельная строка (Σ прибыли периода по дням) →
// при раскрытии 5 подстрок: Выручка / Себестоимость / Комиссия / Логистика /
// Эквайринг (по дням, Σ = сумма дня). Сворачивает декомпозицию операционной
// прибыли в одну строку матрицы — всегда видна главная цифра, детали по клику.
// Колонка Σ родителя = Σ day.profit; null-дни не считаются (точка в ячейке).
function renderProfitGroup(days, rowTotal, expandProfit, setExpandProfit) {
  const parentRow = { key: "profit", label: "Прибыль ₽", kind: "money" };
  const periodTotal = rowTotal(parentRow);
  const rows = [
    <tr key="_profit_group" onClick={() => setExpandProfit((v) => !v)}
      style={{ borderBottom: `1px solid ${soft("line", 20)}`, cursor: "pointer", background: `${soft("pos", 4)}` }}>
      <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surface, zIndex: 1, fontWeight: 700, color: C.ink }}>
        {expandProfit ? "▾ " : "▸ "}Прибыль ₽
      </td>
      {days.map((d) => {
        const v = d.profit;
        const color = v == null ? C.faint : v >= 0 ? C.pos : C.neg;
        return (
          <td key={d.date} style={{ ...tdMat, textAlign: "right", fontWeight: 600, color }}>
            {v != null ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) : <span style={{ color: C.faint }}>·</span>}
          </td>
        );
      })}
      <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surface, zIndex: 1, fontWeight: 800, color: (periodTotal || 0) >= 0 ? C.pos : C.neg }}>
        {periodTotal != null ? money(periodTotal) : "—"}
      </td>
    </tr>,
  ];
  if (expandProfit) {
    for (const sub of PROFIT_SUB) {
      const subSum = rowTotal(sub);
      rows.push(
        <tr key={"_profit_" + sub.key} style={{ borderBottom: `1px solid ${soft("line", 13)}`, background: C.surfaceAlt }}>
          <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surfaceAlt, color: C.muted, paddingLeft: 28, fontSize: 11 }}>└ {sub.label}</td>
          {days.map((d) => (
            <td key={d.date} style={{ ...tdMat, textAlign: "right", fontSize: 11, color: C.muted }}>
              {d[sub.key] != null ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(d[sub.key]) : "·"}
            </td>
          ))}
          <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surfaceAlt, fontSize: 11, color: C.muted, fontWeight: 700 }}>
            {subSum != null ? money(subSum) : "—"}
          </td>
        </tr>
      );
    }
  }
  return rows;
}

// Пара полей «от/до» для фильтра диапазона в шапке таблицы ключей.
function RangePair({ lo, hi, onLo, onHi }) {
  const s = { width: 38, padding: "3px 4px", fontSize: 11, textAlign: "center",
    border: `1px solid ${C.line}`, borderRadius: 5, background: C.surface, color: C.ink, fontFamily: "inherit" };
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "center", justifyContent: "center" }}>
      <input value={lo} onChange={(e) => onLo(e.target.value)} placeholder="от" inputMode="numeric" style={s} />
      <input value={hi} onChange={(e) => onHi(e.target.value)} placeholder="до" inputMode="numeric" style={s} />
    </div>
  );
}

// Блок «Позиции по ключам»: топ-15 ключей × дни, позиция с цветовой подсветкой.
// Данные MPStats (item_keywords). Цвет ячейки: зелёный ≤10, жёлтый 11-30, красный >30.
function KeyPositionsBlock({ days, keywords }) {
  // Сортировка (4 режима) и фильтр по диапазону 3 числовых колонок.
  const [sortBy, setSortBy] = useState("position"); // position | avg | traffic | traffic_asc
  // Поля «от/до» — пустая строка = не фильтровать. Только цифры.
  const [f, setF] = useState({ posMin: "", posMax: "", avgMin: "", avgMax: "", trMin: "", trMax: "" });
  const setFv = (k, v) => setF((s) => ({ ...s, [k]: v === "" ? "" : String(v).replace(/[^\d]/g, "") }));

  const num = (v) => (v === "" ? null : Number(v));
  // Применяем фильтр диапазона к каждому ключевому слову.
  const filtered = keywords.filter((k) => {
    const inRange = (val, lo, hi) => {
      if (val == null) return lo == null && hi == null; // null-значение проходит только без фильтра
      if (lo != null && val < lo) return false;
      if (hi != null && val > hi) return false;
      return true;
    };
    return inRange(k.last_position, num(f.posMin), num(f.posMax))
      && inRange(k.avg_position, num(f.avgMin), num(f.avgMax))
      && inRange(k.traffic_avg ?? null, num(f.trMin), num(f.trMax));
  });
  // Сортировка отфильтрованного списка.
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "traffic") return (b.traffic_avg ?? 0) - (a.traffic_avg ?? 0);
    if (sortBy === "traffic_asc") return (a.traffic_avg ?? 0) - (b.traffic_avg ?? 0);
    if (sortBy === "avg") return (a.avg_position ?? 9999) - (b.avg_position ?? 9999);
    return (a.last_position ?? 9999) - (b.last_position ?? 9999); // position
  });
  const hasFilter = Object.values(f).some((v) => v !== "");
  const resetFilter = () => setF({ posMin: "", posMax: "", avgMin: "", avgMax: "", trMin: "", trMax: "" });

  const top10 = keywords.filter((k) => k.last_position != null && k.last_position <= 10).length;
  const avgAll = keywords.length
    ? Math.round(keywords.reduce((s, k) => s + (k.avg_position || 0), 0) / keywords.length * 10) / 10
    : null;
  // Суммарная частотность всех ключей (потенциал трафика).
  const totalTraffic = keywords.reduce((s, k) => s + (k.traffic_avg || 0), 0);
  const fmtTraffic = (v) => {
    if (v == null) return "—";
    if (v >= 1000) return (v / 1000).toFixed(1) + "K";
    return num(v);
  };
  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: C.muted }}>Позиции по ключам</div>
      {(keywords.length === 0) ? (
        <div style={{ padding: "18px 14px", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface, marginBottom: 18, color: C.muted, fontSize: 13, textAlign: "center" }}>
          🔑 Требуется подписка MPStats или подключение прокси для сбора позиций по поисковым запросам.<br/>
          <span style={{ fontSize: 12, color: C.faint }}>Сборщик готов (wb_keywords.py), ждёт API-ключ MPStats или residential-прокси.</span>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
            <MiniKpi label="Ключей всего" value={num(keywords.length)} />
            <MiniKpi label="В ТОП-10" value={num(top10)} color={top10 > 0 ? C.pos : null} />
            <MiniKpi label="Средняя позиция" value={avgAll != null ? num(avgAll) : "—"} color={avgAll != null && avgAll <= 15 ? C.pos : avgAll != null && avgAll > 30 ? C.neg : null} />
            <MiniKpi label="Потенциал трафика/день" value={fmtTraffic(totalTraffic)} hint="Σ частотности всех ключей" />
            <MiniKpi label="Показано" value={hasFilter ? `${sorted.length} / ${keywords.length}` : num(keywords.length)} color={hasFilter ? C.accent : null} />
          </div>
          {/* Сортировка + сброс фильтра */}
          <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", fontWeight: 600 }}>Сортировка:</span>
            {[
              { k: "position", label: "По посл. позиции ↑" },
              { k: "avg", label: "По ср. позиции ↑" },
              { k: "traffic", label: "По частоте ↓" },
              { k: "traffic_asc", label: "По частоте ↑" },
            ].map((opt) => (
              <button key={opt.k} onClick={() => setSortBy(opt.k)} style={{
                padding: "4px 10px", borderRadius: 7, cursor: "pointer", fontSize: 11, fontFamily: "inherit", fontWeight: 600,
                border: `1px solid ${sortBy === opt.k ? C.accent : C.line}`,
                background: sortBy === opt.k ? `${soft("accent", 10)}` : "transparent",
                color: sortBy === opt.k ? C.accent : C.muted,
              }}>{opt.label}</button>
            ))}
            {hasFilter && (
              <button onClick={resetFilter} style={{
                padding: "4px 10px", borderRadius: 7, cursor: "pointer", fontSize: 11, fontFamily: "inherit", fontWeight: 600,
                border: `1px solid ${C.neg}`, background: `${soft("neg", 10)}`, color: C.neg,
              }}>✕ Сбросить фильтр</button>
            )}
          </div>
          <div style={{ overflow: "auto", maxHeight: 460, border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface, marginBottom: 18 }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
              <thead>
                {/* Строка заголовков */}
                <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}`, position: "sticky", top: 0, zIndex: 3 }}>
                  <th style={{ ...thMatStyle, textAlign: "left", position: "sticky", left: 0, background: C.surfaceAlt, minWidth: 240, zIndex: 4 }}>Ключ</th>
                  <th style={{ ...thMatStyle, minWidth: 50 }}>Посл.</th>
                  <th style={{ ...thMatStyle, minWidth: 50 }}>Ср.</th>
                  <th style={{ ...thMatStyle, minWidth: 64, color: C.accent2 }}>Частота/день</th>
                  {days.map((d) => (
                    <th key={d.date} style={{ ...thMatStyle, minWidth: 40 }}>
                      <div>{d.date.slice(8)}</div>
                    </th>
                  ))}
                </tr>
                {/* Строка фильтров «от/до» под заголовками */}
                <tr style={{ background: C.surfaceAlt, borderBottom: `1px solid ${C.line}`, position: "sticky", top: 26, zIndex: 3 }}>
                  <th style={{ position: "sticky", left: 0, background: C.surfaceAlt, zIndex: 4, padding: "4px 8px" }}>
                    <span style={{ fontSize: 10, color: C.faint }}>Фильтр диапазона ↓</span>
                  </th>
                  <th style={{ padding: "3px 4px" }}><RangePair lo={f.posMin} hi={f.posMax} onLo={(v) => setFv("posMin", v)} onHi={(v) => setFv("posMax", v)} /></th>
                  <th style={{ padding: "3px 4px" }}><RangePair lo={f.avgMin} hi={f.avgMax} onLo={(v) => setFv("avgMin", v)} onHi={(v) => setFv("avgMax", v)} /></th>
                  <th style={{ padding: "3px 4px" }}><RangePair lo={f.trMin} hi={f.trMax} onLo={(v) => setFv("trMin", v)} onHi={(v) => setFv("trMax", v)} /></th>
                  {days.map((d) => <th key={d.date} />)}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 && (
                  <tr><td colSpan={4 + days.length} style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 12 }}>Нет ключей под фильтром — измените диапазон или сбросьте</td></tr>
                )}
                {sorted.map((kw) => {
                  const last = kw.last_position;
                  const color = last == null ? C.faint : last <= 10 ? C.pos : last <= 30 ? C.warn : C.neg;
                  return (
                    <tr key={kw.keyword} style={{ borderBottom: `1px solid ${soft("line", 13)}` }}>
                      <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surface, zIndex: 1, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }} title={kw.keyword}>
                        {kw.keyword}
                        {kw.is_ad_last ? (
                          <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 3, background: `${soft("neg", 13)}`, color: C.neg, fontWeight: 700 }}>рекл</span>
                        ) : null}
                      </td>
                      <td style={{ ...tdMat, textAlign: "center", fontWeight: 800, color }}>{last ?? "—"}</td>
                      <td style={{ ...tdMat, textAlign: "center", color: C.muted }}>{kw.avg_position ?? "—"}</td>
                      <td style={{ ...tdMat, textAlign: "center", color: C.accent2, fontWeight: 600 }}>{fmtTraffic(kw.traffic_avg)}</td>
                      {kw.positions.map((p, i) => (
                        <td key={i} style={{
                          ...tdMat, textAlign: "center",
                          background: p == null ? "transparent" : `color-mix(in srgb, ${color} 13%, transparent)`,
                          color: p == null ? C.faint : color,
                          fontWeight: p != null ? 700 : 400,
                        }}>
                          {p != null ? p : "·"}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: -10, marginBottom: 18, fontSize: 11, color: C.faint }}>
            🟢 ТОП-10 · 🟡 11-30 · 🔴 {">"}30 · Цвет ячейки = позиция в выдаче WB по ключу (1 = лидер). Частота/день = сколько людей ищут этот ключ в день. Источник: MPStats (собирается раз в день).
          </div>
        </>
      )}
    </>
  );
}

function EmptyBlock({ text }) {
  return (
    <div style={{ padding: "18px 14px", border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface, marginBottom: 18, color: C.muted, fontSize: 12, textAlign: "center" }}>
      {text}
    </div>
  );
}

// Рендер дерева «Реклама»: общая кликабельная строка (Σ spend) → 3 модели → детали.
function renderAdGroup(days, rowTotal, expandAdGroup, setExpandAdGroup, expandAd, setExpandAd, expandSplit, setExpandSplit) {
  const adTotalSpend = (d) => (d.ad_edinaya_spend || 0) + (d.ad_ruchnaya_spend || 0) + (d.ad_cliki_spend || 0);
  const periodTotal = days.reduce((s, d) => s + adTotalSpend(d), 0);
  const rows = [
    <tr key="_ad_group" onClick={() => setExpandAdGroup((v) => !v)}
      style={{ borderBottom: `1px solid ${soft("line", 20)}`, cursor: "pointer", background: `${soft("accent", 3)}` }}>
      <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surface, zIndex: 1, fontWeight: 700, color: C.ink }}>
        {expandAdGroup ? "▾ " : "▸ "}Реклама ₽
      </td>
      {days.map((d) => (
        <td key={d.date} style={{ ...tdMat, textAlign: "right", fontWeight: 600 }}>
          {new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(adTotalSpend(d))}
        </td>
      ))}
      <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surface, zIndex: 1, fontWeight: 800 }}>
        {new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(periodTotal)}
      </td>
    </tr>,
  ];
  if (expandAdGroup) {
    for (const model of AD_MODELS) {
      rows.push(...renderMatrixRow(model, days, rowTotal, expandAd, setExpandAd, expandSplit, setExpandSplit));
    }
  }
  return rows;
}

// Рендер одной строки матрицы (с опц. разворотом: группы orders/clicks/cart или модели рекламы).
function renderMatrixRow(row, days, rowTotal, expandAd, setExpandAd, expandSplit, setExpandSplit) {
  const splitGroup = SPLIT_SUB[row.group] ? row.group : null;
  const isAd = !!row.group && !splitGroup;
  const muted = !!row.muted;
  const expanded = splitGroup ? expandSplit[splitGroup] : (isAd && expandAd[row.group]);
  const onToggle = splitGroup
    ? () => setExpandSplit((s) => ({ ...s, [splitGroup]: !s[splitGroup] }))
    : isAd ? () => setExpandAd((s) => ({ ...s, [row.group]: !s[row.group] })) : undefined;
  const total = rowTotal(row);

  // Недоступная метрика (row.na) — вся строка приглушённая, ячейки = «—», подпись-примечание.
  // Применяется к корзинам Ozon (hits_to_cart отбрасывается API — ограничение подписки).
  if (row.na) {
    return [
      <tr key={row.key} style={{ borderBottom: `1px solid ${soft("line", 20)}`, opacity: 0.5 }}>
        <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surface, zIndex: 1, fontWeight: 500, color: C.faint }}>
          {row.label}
          <span style={{ fontSize: 9, color: C.faint, marginLeft: 6 }} title={row.na}>(недоступно в API)</span>
        </td>
        {days.map((d) => (
          <td key={d.date} style={{ ...tdMat, textAlign: "right", color: C.faint }}>—</td>
        ))}
        <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surface, zIndex: 1, fontWeight: 700, color: C.faint }}>—</td>
      </tr>,
    ];
  }

  const rows = [
    <tr key={row.key} onClick={onToggle}
      style={{ borderBottom: `1px solid ${soft("line", 20)}`, cursor: onToggle ? "pointer" : "default", background: (splitGroup || isAd) ? `${soft("accent", 3)}` : "transparent", opacity: muted ? 0.55 : 1 }}>
      <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surface, zIndex: 1, fontWeight: (splitGroup || isAd) ? 600 : 500, color: muted ? C.faint : C.ink }}>
        {onToggle ? (expanded ? "▾ " : "▸ ") : ""}{row.label}
        {muted && <span style={{ fontSize: 9, color: C.faint, marginLeft: 6 }}>(нет данных — связи склеек нет в БД)</span>}
      </td>
      {days.map((d) => (
        <td key={d.date} style={{ ...tdMat, textAlign: "right", color: muted ? C.faint : undefined }}>{fmtCell(d[row.key], row.kind)}</td>
      ))}
      <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surface, zIndex: 1, fontWeight: 700, color: muted ? C.faint : undefined }}>
        {fmtSum(total, row.kind)}
      </td>
    </tr>,
  ];

  if (splitGroup && expanded) {
    for (const sub of SPLIT_SUB[splitGroup]) {
      const subKey = `${splitGroup}_${sub.suffix}`;
      // План ЗАКАЗОВ разбит по дням (route.js: продажи шт ÷ % выкупа, затем ÷ дней в
      // месяце, ОКРУГЛЕНИЕ ВВЕРХ). Ячейки = дневная норма (целая, ceil). Σ = ЦЕЛЬ НА
      // ВЕСЬ МЕСЯЦ (orders_plan_month — константа из totals), НЕ сумма дневных норм по
      // выбранному диапазону: цель на месяц не зависит от того, сколько дней открыто.
      const isPlan = sub.suffix === "plan";
      const planMonth = days.length > 0 ? days[0].orders_plan_month : null;
      const subSum = days.reduce((s, d) => s + (d[subKey] != null ? d[subKey] : 0), 0);
      rows.push(
        <tr key={row.key + "_" + sub.suffix} style={{ borderBottom: `1px solid ${soft("line", 13)}`, background: C.surfaceAlt }}>
          <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surfaceAlt, color: C.muted, paddingLeft: 28, fontSize: 11 }}>└ {sub.label}</td>
          {days.map((d) => (
            <td key={d.date} style={{ ...tdMat, textAlign: "right", fontSize: 11, color: C.muted }}>
              {isPlan ? planNum(d[subKey]) : (d[subKey] != null ? num(d[subKey]) : "—")}
            </td>
          ))}
          <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surfaceAlt, fontSize: 11, color: C.muted, fontWeight: 700 }}>{isPlan ? planNum(planMonth) : (subSum != null ? num(subSum) : "—")}</td>
        </tr>
      );
    }
  }

  if (isAd && expanded) {
    const prefix = `ad_${row.group}_`;
    for (const sub of AD_SUB) {
      const subKey = prefix + sub.suffix;
      const subSum = days.reduce((s, d) => s + (d[subKey] != null ? d[subKey] : 0), 0);
      rows.push(
        <tr key={row.key + "_" + sub.suffix} style={{ borderBottom: `1px solid ${soft("line", 13)}`, background: C.surfaceAlt }}>
          <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surfaceAlt, color: C.muted, paddingLeft: 28, fontSize: 11 }}>└ {sub.label}</td>
          {days.map((d) => (
            <td key={d.date} style={{ ...tdMat, textAlign: "right", fontSize: 11, color: C.muted }}>{d[subKey] != null ? num(d[subKey]) : "—"}</td>
          ))}
          <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surfaceAlt, fontSize: 11, color: C.muted }}>{num(subSum)}</td>
        </tr>
      );
    }
  }
  return rows;
}

// Рендер строки конверсии (с опц. декомпозицией по источнику через variants).
function renderConvRow(row, days, t, expandConv, setExpandConv) {
  const total = row.total(t);
  const threshold = total != null ? total * 0.5 : null;
  const hasVariants = Array.isArray(row.variants) && row.variants.length > 0;
  const expanded = !!expandConv[row.key];
  const onToggle = hasVariants ? () => setExpandConv((s) => ({ ...s, [row.key]: !s[row.key] })) : undefined;
  const rows = [
    <tr key={"conv_" + row.key} onClick={onToggle}
      style={{ borderBottom: `1px solid ${soft("line", 20)}`, background: "transparent", cursor: onToggle ? "pointer" : "default" }}>
      <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surface, zIndex: 1, color: C.accent2, fontWeight: 600 }}>
        {onToggle ? (expanded ? "▾ " : "▸ ") : ""}{row.label}
      </td>
      {days.map((d) => {
        const v = row.fn(d);
        const bad = row.kind === "conv_money" ? (threshold != null && v != null && v > threshold * 1.5) : (threshold != null && v != null && v < threshold);
        return (
          <td key={d.date} style={{ ...tdMat, textAlign: "right", color: bad ? C.neg : v != null ? C.ink : C.faint, fontWeight: bad ? 700 : 500 }}>
            {row.kind === "conv_money" ? money(v) : (v != null ? pct(pctFromRate(v)) : <span style={{ color: C.faint }}>·</span>)}
          </td>
        );
      })}
      <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surface, zIndex: 1, fontWeight: 800, color: C.accent }}>
        {row.kind === "conv_money" ? money(total) : (total != null ? pct(pctFromRate(total)) : "—")}
      </td>
    </tr>,
  ];
  if (hasVariants && expanded) {
    for (const vr of row.variants) {
      const vTotal = vr.total(t);
      rows.push(
        <tr key={"conv_" + row.key + "_" + vr.src} style={{ borderBottom: `1px solid ${soft("line", 13)}`, background: C.surfaceAlt }}>
          <td style={{ ...tdMatL, position: "sticky", left: 0, background: C.surfaceAlt, color: C.muted, paddingLeft: 28, fontSize: 11 }}>└ {SRC_LABEL[vr.src] || vr.src}</td>
          {days.map((d) => {
            const v = vr.fn(d);
            return (
              <td key={d.date} style={{ ...tdMat, textAlign: "right", fontSize: 11, color: v != null ? C.muted : C.faint }}>
                {row.kind === "conv_money" ? money(v) : (v != null ? pct(pctFromRate(v)) : "—")}
              </td>
            );
          })}
          <td style={{ ...tdMat, textAlign: "right", position: "sticky", right: 0, background: C.surfaceAlt, fontSize: 11, color: C.muted }}>
            {row.kind === "conv_money" ? money(vTotal) : (vTotal != null ? pct(pctFromRate(vTotal)) : "—")}
          </td>
        </tr>
      );
    }
  }
  return rows;
}

function fmtCell(v, kind) {
  if (v == null) return <span style={{ color: C.faint }}>·</span>;
  if (kind === "int") return num(v);
  if (kind === "price") return Math.round(v);
  if (kind === "money") return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v);
  if (kind === "spp") return pct(v);  // spp уже в % (38, не 0.38)
  if (kind === "pct_raw") return pct(v);  // значение уже в % (boost Ozon = 15..75)
  if (kind === "rating") return r2(v);
  return v;
}
function fmtSum(v, kind) {
  if (v == null) return <span style={{ color: C.faint }}>—</span>;
  if (kind === "money") return money(v);
  return fmtCell(v, kind);
}

// =====================================================================
//  Хелперы UI (переиспользованы из РНП/сводки).
// =====================================================================
const thMatStyle = { padding: "6px 4px", fontSize: 10, color: C.muted, textTransform: "uppercase", fontWeight: 600, whiteSpace: "nowrap", textAlign: "center" };
const tdMat = { padding: "5px 6px", fontSize: 12, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const tdMatL = { padding: "5px 8px", fontSize: 12, whiteSpace: "nowrap", textAlign: "left" };

function LocCard({ title, hint, accent, children }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, background: C.surface, overflow: "hidden", minWidth: 0 }}>
      <div style={{ padding: "8px 12px", borderBottom: `1px solid ${C.line}`, background: C.surfaceAlt }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: accent || C.ink }}>{title}</div>
        <div style={{ fontSize: 10, color: C.faint, marginTop: 1 }}>{hint}</div>
      </div>
      <div>{children}</div>
    </div>
  );
}
function LocRow({ name, right, muted }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: `1px solid ${soft("line", 13)}` }}>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={name}>{name}</div>
      <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", fontSize: 12.5 }}>{right}</div>
      {muted && <div style={{ minWidth: 44, textAlign: "right", color: C.faint, fontSize: 10.5 }}>{muted}</div>}
    </div>
  );
}
function LocRowThree({ name, count, share, localPct }) {
  const locColor = localPct == null ? C.faint : localPct >= 50 ? C.pos : localPct < 20 ? C.faint : C.ink;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 50px 56px 56px", gap: 6, alignItems: "center", padding: "6px 12px", borderBottom: `1px solid ${soft("line", 13)}` }}>
      <div style={{ minWidth: 0, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={name}>{name}</div>
      <div style={{ textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums", fontSize: 12.5 }}>{num(count)}</div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 11.5, color: C.muted }}>{share != null ? pct(share) : "—"}</div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 11.5, color: locColor }}>{localPct != null ? pct(localPct) : "—"}</div>
    </div>
  );
}
function LocHead() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 50px 56px 56px", gap: 6, alignItems: "center", padding: "5px 12px", background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 9.5, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700 }}>Склад / кластер</div>
      <div style={{ textAlign: "right", fontSize: 9.5, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700 }}>Шт</div>
      <div style={{ textAlign: "right", fontSize: 9.5, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700 }}>% общ</div>
      <div style={{ textAlign: "right", fontSize: 9.5, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700 }}>% лок</div>
    </div>
  );
}
function LocFootThree({ label, total, localPct, accent }) {
  const locColor = localPct == null ? C.faint : localPct >= 50 ? C.pos : localPct < 20 ? C.faint : C.ink;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 50px 56px 56px", gap: 6, alignItems: "center", padding: "8px 12px", background: C.surfaceAlt, fontWeight: 800, borderTop: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: accent || C.ink }}>{num(total)}</div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.muted }}>100%</div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: locColor }}>{localPct != null ? pct(localPct) : "—"}</div>
    </div>
  );
}
function LocFoot({ label, value, accent }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: C.surfaceAlt, fontWeight: 800, borderTop: `1px solid ${C.line}` }}>
      <div style={{ flex: 1, fontSize: 11.5 }}>{label}</div>
      <div style={{ fontVariantNumeric: "tabular-nums", color: accent || C.ink }}>{value}</div>
    </div>
  );
}
function LocRowTwo({ name, count, share }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 50px 56px", gap: 6, alignItems: "center", padding: "6px 12px", borderBottom: `1px solid ${soft("line", 13)}` }}>
      <div style={{ minWidth: 0, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={name}>{name}</div>
      <div style={{ textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums", fontSize: 12.5 }}>{num(count)}</div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 11.5, color: C.muted }}>{share != null ? pct(share) : "—"}</div>
    </div>
  );
}
function LocHeadTwo() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 50px 56px", gap: 6, alignItems: "center", padding: "5px 12px", background: C.surfaceAlt, borderBottom: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 9.5, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700 }}>Город</div>
      <div style={{ textAlign: "right", fontSize: 9.5, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700 }}>Зак.</div>
      <div style={{ textAlign: "right", fontSize: 9.5, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700 }}>%</div>
    </div>
  );
}
function EmptyHint({ text }) {
  return <div style={{ padding: 16, textAlign: "center", color: C.muted, fontSize: 12 }}>{text}</div>;
}

function ConvCard({ label, value, hint, color }) {
  return (
    <div title={hint} style={{ padding: "10px 12px", borderRadius: 10, background: C.surface, border: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.3, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: color || C.ink, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
function MiniKpi({ label, value, color }) {
  return (
    <div style={{ padding: "6px 12px", borderRadius: 8, background: C.surfaceAlt, border: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 9, color: C.faint, textTransform: "uppercase", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: color || C.ink }}>{value}</div>
    </div>
  );
}
function Thumb({ url, big }) {
  const [err, setErr] = useState(false);
  const size = big ? 56 : 40;
  if (!url || err) {
    return (
      <div style={{ width: size, height: size, borderRadius: 8, flexShrink: 0, background: C.surfaceAlt, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", color: C.faint, fontSize: big ? 22 : 16 }}>🖼</div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={size} height={size} onError={() => setErr(true)}
      style={{ width: size, height: size, objectFit: "cover", borderRadius: 8, flexShrink: 0, border: `1px solid ${C.line}` }} />
  );
}
function ChartTip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const fmt = (key, v) => {
    if (v == null) return "—";
    if (key === "ad" || key === "profit") return money(v);
    if (key === "rating_nm" || key === "rating_imt") return r2(v);
    return num(v);
  };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 10px", fontSize: 12 }}>
      <div style={{ color: C.faint, marginBottom: 2 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color }}>{p.name}: <b>{fmt(p.dataKey, p.value)}</b></div>
      ))}
    </div>
  );
}
// Tooltip для combo-графика «Статистика рекламы»: количества — числом, %/₽ — своим форматом.
function AdChartTip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const fmt = (key, v) => {
    if (v == null) return "—";
    if (key === "ctr" || key === "cr" || key === "drr") return pct(pctFromRate(v));
    if (key === "spend" || key === "cpc" || key === "cpa" || key === "cpm" || key === "orders_sum") return money(v);
    return num(v);
  };
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 10px", fontSize: 12 }}>
      <div style={{ color: C.faint, marginBottom: 2 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color }}>{p.name}: <b>{fmt(p.dataKey, p.value)}</b></div>
      ))}
    </div>
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
const inputStyle = { padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 13, fontFamily: "inherit" };
const selectStyle = { ...inputStyle, padding: "7px 26px 7px 10px", appearance: "none", cursor: "pointer" };
const btnStyle = { padding: "7px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600, border: `1px solid ${C.line}`, background: "transparent", color: C.muted, fontFamily: "inherit" };

function presetToDates(p) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (p === "yesterday") { const y = new Date(today); y.setDate(y.getDate() - 1); return [iso(y), iso(y)]; }
  if (p === "week") { const w = new Date(today); w.setDate(w.getDate() - 6); return [iso(w), iso(today)]; }
  if (p === "thisMonth") { return [ymd(today.getFullYear(), today.getMonth() + 1, 1), iso(today)]; }
  if (p === "lastMonth") {
    const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const last = new Date(today.getFullYear(), today.getMonth(), 0);
    return [ymd(first.getFullYear(), first.getMonth() + 1, 1), ymd(last.getFullYear(), last.getMonth() + 1, last.getDate())];
  }
  return ["", ""];
}
function Centered({ children }) {
  return <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>{children}</div>;
}
