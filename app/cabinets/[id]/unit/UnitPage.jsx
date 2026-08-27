"use client";
import { C, soft } from "@/lib/palette.js";

// /cabinets/[id]/unit — Юнит-экономика (WB+Ozon) с what-if прикидкой.
// Полный перенос эталона data-presenter/app/finance/UnitTable.jsx с адаптацией:
// локальная палитра SAAS, проп cabinetId + переключатель МП (обе платформы
// на одной странице, как хочет SAAS), fetch на /api/cabinets/[id]/unit*.
//
// Каждый товар = ДВЕ строки: ФАКТ (read-only из БД) + ПРИКИДКА (редактируемые
// входы, прибыль пересчитывается через calcWB/calcOzon; «↧ в факт» → POST).
import { Fragment, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { COLUMNS_WB, COLUMNS_OZON, calcWB, calcOzon } from "@/lib/unit";

// Палитра SAAS (тёмно-синяя).


const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽";
const num = (v) =>
  v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v);
const pct = (v) =>
  v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(v) + "%";

const COMPACT = {
  // priceBuy («Цена на сайте») добавлен в дефолтный набор (фикс 2026-07-28):
  // финальная цена покупателя из WB API (discountedPrice), от которой считаются
  // налоги/комиссии. Заменяет эмуляцию «СПП» (WB не отдаёт её отдельным полем).
  wb: ["name", "priceSeller", "discount", "priceSell", "spp", "priceWithSpp", "priceBuy", "adsRate", "ads", "buyout", "defectRate", "profitWithDefect"],
  // defectRate/profitWithDefect/marginWithDefect добавлены в дефолтный набор
  // (2026-08-27, режимы юнитки) — зеркало WB-COMPACT (там defectRate/
  // profitWithDefect уже в списке); галочка «с браком» их фильтрует, но им
  // нужно СНАЧАЛА быть в базовом списке, иначе фильтрации нечего показывать.
  ozon: ["name", "priceSell", "boost", "priceBuyer", "vat", "revNet", "commission", "logisticsFbo", "ads", "usn", "cost", "profit", "margin", "defectRate", "profitWithDefect", "marginWithDefect"],
};

const WHATIF_INPUTS = {
  wb: [
    { key: "priceSeller", label: "Цена на WB", unit: "₽", max: 1000000 },
    { key: "discount", label: "Скидка", unit: "%", max: 100, asFraction: true },
    { key: "spp", label: "СПП", unit: "%", max: 100, asFraction: true },
    { key: "commissionRate", label: "Комиссия", unit: "%", max: 100, asFraction: true },
    { key: "buyout", label: "% выкупа", unit: "%", max: 100, asFraction: true },
    { key: "adsRate", label: "ДРР", unit: "%", max: 100, asFraction: true },
    { key: "cost", label: "Себест.", unit: "₽", max: 1000000 },
    { key: "defectRate", label: "% брака", unit: "%", max: 100, asFraction: true },
  ],
  ozon: [
    { key: "priceOzon", label: "Цена на Ozon", unit: "₽", max: 1000000 },
    { key: "discount", label: "Скидка", unit: "%", max: 100, asFraction: true },
    { key: "commissionRate", label: "Комиссия", unit: "%", max: 100, asFraction: true },
    { key: "logisticsFbo", label: "Логистика FBO", unit: "₽", max: 100000 },
    { key: "adsRate", label: "ДРР", unit: "%", max: 100, asFraction: true },
    { key: "cost", label: "Себест.", unit: "₽", max: 1000000 },
    { key: "defectRate", label: "% брака", unit: "%", max: 100, asFraction: true },
  ],
};

// Галочки «с % выкупа» / «с браком» (2026-08-27, режимы юнитки): управляют
// И видимостью колонок (COMPACT/full фильтруются одинаково), И calc-входами
// прикидки (OFF → нейтральный вход buyout=1 / defectRate=0 — см. ProductRow).
// Состояние — localStorage, глобально на страницу (без cabinetId/platform в
// ключе — решение брифа задачи 2, «ключ не нужен»).
const HIDDEN_WHEN_BUYOUT_OFF = new Set(["buyout"]);
const HIDDEN_WHEN_DEFECT_OFF = new Set(["defectRate", "profitWithDefect", "marginWithDefect"]);
const LS_BUYOUT_KEY = "unit.buyoutOn";
const LS_DEFECT_KEY = "unit.defectOn";

export default function UnitPage({ cabinetId }) {
  const [platform, setPlatform] = useState("wb");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [onlyLoss, setOnlyLoss] = useState(false);
  const [hideDraft, setHideDraft] = useState(true);
  const [full, setFull] = useState(false);
  // Режимы «с % выкупа» / «с браком» — дефолт ON (=текущий вид: WB уже
  // показывает buyout/defectRate по умолчанию в COMPACT — регресс-инвариант
  // сохраняется, т.к. ON = реальные входы calc, без нейтрализации).
  const [buyoutOn, setBuyoutOn] = useState(true);
  const [defectOn, setDefectOn] = useState(true);
  // Ставка УСН, % — сентинель кабинета (itemId=0), отдельно на площадку.
  // null = не задано явно пользователем → берём usnDefault из ответа /unit/all.
  const [usnRateOverride, setUsnRateOverride] = useState({ wb: null, ozon: null });
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [applying, setApplying] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [saveState, setSaveState] = useState({ status: "idle", time: null });
  const saveTimers = useRef({});
  const retryTimers = useRef({});
  const saveSeq = useRef({}); // sku -> поколение последней ЗАПУЩЕННОЙ отправки
  const saveAbort = useRef({}); // sku -> AbortController запроса в полёте

  // Cleanup на смену cabinetId / размонтирование: не полагаемся на то, что
  // setTimeout сам «не выстрелит» — гасим таймеры и абортим запросы в полёте
  // явно, чтобы не словить setState после ухода со страницы и не слать
  // прикидку под уже неактуальным cabinetId.
  useEffect(() => {
    return () => {
      Object.values(saveTimers.current).forEach(clearTimeout);
      Object.values(retryTimers.current).forEach(clearTimeout);
      Object.values(saveAbort.current).forEach((c) => c?.abort());
    };
  }, [cabinetId]);

  // localStorage — состояние галочек «с % выкупа»/«с браком» (view-настройка
  // страницы, не данные кабинета). Чтение после mount (SSR не имеет доступа
  // к localStorage); запись при каждом изменении.
  useEffect(() => {
    try {
      const b = localStorage.getItem(LS_BUYOUT_KEY);
      const d = localStorage.getItem(LS_DEFECT_KEY);
      if (b != null) setBuyoutOn(b === "1");
      if (d != null) setDefectOn(d === "1");
    } catch {}
  }, []);
  useEffect(() => { try { localStorage.setItem(LS_BUYOUT_KEY, buyoutOn ? "1" : "0"); } catch {} }, [buyoutOn]);
  useEffect(() => { try { localStorage.setItem(LS_DEFECT_KEY, defectOn ? "1" : "0"); } catch {} }, [defectOn]);

  useEffect(() => {
    fetch(`/api/cabinets/${cabinetId}/unit/all`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setData(d);
        // Сид: прикидки, сохранённые ранее (tenant.unit_whatif), накладываются
        // на строки при загрузке — ключ overrides = sku (как и весь остальной
        // код страницы), поэтому wb/ozon сливаются в один словарь. itemId=0 —
        // сентинель ставки УСН (кабинетный, не товар) — сеется ОТДЕЛЬНО в
        // usnRateOverride, а не в overrides (иначе «завис» бы ключом "0" в
        // словаре прикидок, не относящемся ни к одному товару).
        if (d.whatif) {
          const seed = { ...(d.whatif.wb || {}), ...(d.whatif.ozon || {}) };
          delete seed["0"];
          if (Object.keys(seed).length > 0) setOverrides((prev) => ({ ...seed, ...prev }));
          setUsnRateOverride({
            wb: d.whatif.wb?.["0"]?.usnRate != null ? d.whatif.wb["0"].usnRate * 100 : null,
            ozon: d.whatif.ozon?.["0"]?.usnRate != null ? d.whatif.ozon["0"].usnRate * 100 : null,
          });
        }
      })
      .catch((e) => setError(String(e)));
  }, [cabinetId]);

  // Автосейв прикидки в tenant.unit_whatif (POST /unit/whatif, дебаунс 1000мс
  // на товар). Ретрай 1 раз через 3с при ошибке сети; значения в overrides
  // при этом не трогаются — теряется только факт сохранения, не ввод.
  //
  // Секвенирование (пост-ревью): bare fetch без гейта позволял стейл-POST
  // (медленный первый запрос, >1000мс в полёте) разрешиться ПОСЛЕ более
  // нового второго и молча перетереть tenant.unit_whatif устаревшими inputs
  // (оба ответа 200, индикатор мог показать «✓ Сохранено» на самом деле
  // откатив запись назад). Фикс — счётчик поколений per-sku (saveSeq):
  // каждый doSave() бампает поколение при СТАРТЕ отправки; предыдущий
  // запрос того же sku абортируется через AbortController (не долетает
  // до сервера как отдельный конкурентный запрос), а если абort не успел
  // (ответ уже пришёл) — isCurrent() гасит применение результата стейл-вызова
  // (индикатор/ретрай не трогаются устаревшим поколением). Свежий вызов
  // всегда либо единственный в полёте, либо последний, чей результат учтён.
  const doSave = useCallback(async (sku, inputs) => {
    // Новая отправка для sku перекрывает и таймер ретрая, и запрос в полёте —
    // предыдущее поколение больше не должно ни дописаться в БД, ни повлиять
    // на индикатор.
    clearTimeout(retryTimers.current[sku]);
    saveAbort.current[sku]?.abort();
    const ctrl = new AbortController();
    saveAbort.current[sku] = ctrl;
    saveSeq.current[sku] = (saveSeq.current[sku] || 0) + 1;
    const seq = saveSeq.current[sku];
    const isCurrent = () => saveSeq.current[sku] === seq;

    const body = JSON.stringify({ platform, itemId: Number(sku), inputs: inputs && Object.keys(inputs).length > 0 ? inputs : null });
    setSaveState({ status: "saving", time: null });
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/unit/whatif`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ctrl.signal });
      if (!r.ok) throw new Error(String(r.status));
      if (isCurrent()) setSaveState({ status: "saved", time: new Date() });
    } catch (e) {
      if (e?.name === "AbortError") return; // абортирован более свежей отправкой — не ошибка
      if (!isCurrent()) return; // стейл-ответ (уже есть более новое поколение) — игнорируем
      setSaveState({ status: "retrying", time: null });
      retryTimers.current[sku] = setTimeout(async () => {
        if (!isCurrent()) return; // за 3с успела прийти более новая правка — ретрай не нужен
        saveAbort.current[sku]?.abort();
        const ctrl2 = new AbortController();
        saveAbort.current[sku] = ctrl2;
        try {
          const r2 = await fetch(`/api/cabinets/${cabinetId}/unit/whatif`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ctrl2.signal });
          if (!r2.ok) throw new Error(String(r2.status));
          if (isCurrent()) setSaveState({ status: "saved", time: new Date() });
        } catch (e2) {
          if (e2?.name === "AbortError") return;
          if (isCurrent()) setSaveState({ status: "error", time: null });
        }
      }, 3000);
    }
  }, [cabinetId, platform]);

  const scheduleSave = useCallback((sku, inputs) => {
    clearTimeout(saveTimers.current[sku]);
    saveTimers.current[sku] = setTimeout(() => doSave(sku, inputs), 1000);
  }, [doSave]);

  const setOverride = useCallback((sku, field, rawValue, asFraction) => {
    const v = Number.isFinite(rawValue) ? (asFraction ? rawValue / 100 : rawValue) : 0;
    setOverrides((prev) => {
      const nextForSku = { ...(prev[sku] || {}), [field]: v };
      scheduleSave(sku, nextForSku);
      return { ...prev, [sku]: nextForSku };
    });
  }, [scheduleSave]);

  const applyOverride = useCallback(async (sku) => {
    const ov = overrides[sku];
    if (!ov) return;
    const fields = WHATIF_INPUTS[platform];
    await Promise.all(
      fields
        .filter((f) => ov[f.key] != null)
        .map((f) =>
          fetch(`/api/cabinets/${cabinetId}/unit/inputs`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ platform, sku: String(sku), key: f.key, value: ov[f.key] }),
          }).catch((e) => console.error("applyOverride:", e))
        )
    );
    setApplying(sku);
    setData((prev) => {
      if (!prev) return prev;
      const items = prev.items.map((it) => {
        if (String(it.sku) !== String(sku) || it.platform !== platform) return it;
        return platform === "wb" ? calcWB({ ...it, ...ov }) : calcOzon({ ...it, ...ov });
      });
      return { ...prev, items };
    });
    // Гасим отложенный автосейв прикидки (дебаунс мог бы ДОЗАПИСАТЬ inputs в
    // tenant.unit_whatif уже ПОСЛЕ применения к фактам) и удаляем сохранённую
    // строку — иначе после F5 сид «прикидка из БД» воскрешает применённые
    // значения поверх новых фактов (бейдж «Δ +0₽», кнопки «↧ в факт»/«⟲ к
    // факту» снова появляются). Тот же паттерн, что и resetOverride: doSave()
    // сам гасит/абортит любой ещё более ранний запрос в полёте для sku.
    clearTimeout(saveTimers.current[sku]);
    clearTimeout(retryTimers.current[sku]);
    setOverrides((prev) => { const next = { ...prev }; delete next[sku]; return next; });
    doSave(sku, null);
    setTimeout(() => setApplying((s) => (s === sku ? null : s)), 800);
  }, [overrides, platform, cabinetId, doSave]);

  // «⟲ к факту» — сброс входов прикидки к фактическим И немедленное удаление
  // сохранённой строки из tenant.unit_whatif (POST inputs:null, минуя дебаунс —
  // явное действие пользователя). Отменяет отложенный автосейв для sku, чтобы
  // он не «воскресил» удалённую запись.
  const resetOverride = useCallback((sku) => {
    clearTimeout(saveTimers.current[sku]);
    clearTimeout(retryTimers.current[sku]);
    setOverrides((prev) => { const next = { ...prev }; delete next[sku]; return next; });
    doSave(sku, null);
  }, [doSave]);

  // Ставка УСН — сентинель itemId=0 в tenant.unit_whatif (та же doSave/
  // scheduleSave-механика, что и per-sku прикидка: секвенирование, ретрай,
  // дебаунс 1000мс). Платформа — берётся из текущего состояния `platform`
  // (doSave уже её захватывает), поэтому сентинель пишется в кабинетную
  // строку активной вкладки. n — процент (0..25), как ввёл пользователь.
  const setUsnRate = useCallback((n) => {
    setUsnRateOverride((prev) => ({ ...prev, [platform]: n }));
    scheduleSave(0, { usnRate: n / 100 });
  }, [platform, scheduleSave]);

  // «⟲» у поля ставки УСН — сброс к дефолту кабинета (usnDefault) и немедленный
  // POST inputs:null (удаляет сентинель), минуя дебаунс — тот же паттерн, что
  // resetOverride.
  const resetUsnRate = useCallback(() => {
    clearTimeout(saveTimers.current[0]);
    clearTimeout(retryTimers.current[0]);
    setUsnRateOverride((prev) => ({ ...prev, [platform]: null }));
    doSave(0, null);
  }, [platform, doSave]);

  const platformItems = useMemo(
    () => (data?.items || []).filter((i) => i.platform === platform),
    [data, platform]
  );
  const categories = useMemo(
    () => [...new Set(platformItems.map((i) => i.category).filter(Boolean))].sort(),
    [platformItems]
  );

  const filtered = useMemo(() => {
    let arr = platformItems;
    if (cat !== "all") {
      if (cat === "__nocat__") arr = arr.filter((i) => !i.category);
      else arr = arr.filter((i) => i.category === cat);
    }
    if (hideDraft) arr = arr.filter((i) => !i.draft);
    if (onlyLoss) arr = arr.filter((i) => !i.draft && i.profit < 0);
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      arr = arr.filter((i) => String(i.name || "").toLowerCase().includes(s) || String(i.sku || "").includes(s));
    }
    return [...arr].sort((a, b) => (b.profit || 0) - (a.profit || 0));
  }, [platformItems, q, cat, onlyLoss, hideDraft]);

  const totalRows = filtered.length;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalRows / pageSize)) : 1;
  const safePage = Math.min(page, totalPages);
  const paged = useMemo(() => {
    if (pageSize <= 0) return filtered;
    const start = (safePage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, pageSize, safePage]);
  useEffect(() => { if (page !== 1) setPage(1); }, [platform, cat, q, onlyLoss, hideDraft, pageSize]);
  useEffect(() => { if (safePage < page) setPage(safePage); }, [safePage, page]);

  const cols = useMemo(() => {
    const base = platform === "ozon" ? COLUMNS_OZON : COLUMNS_WB;
    const byKey = Object.fromEntries(base.map((c) => [c.key, c]));
    let list = full ? base : COMPACT[platform].map((k) => byKey[k]).filter(Boolean);
    if (!buyoutOn) list = list.filter((c) => !HIDDEN_WHEN_BUYOUT_OFF.has(c.key));
    if (!defectOn) list = list.filter((c) => !HIDDEN_WHEN_DEFECT_OFF.has(c.key));
    return list;
  }, [platform, full, buyoutOn, defectOn]);

  // Ставка УСН активной вкладки — дефолт usnDefault (сервер, per platform) или
  // явный override пользователя (сентинель). Фракция всегда идёт в calc всех
  // строк прикидки (ProductRow), проценты — в поле ввода.
  const usnDefaultPct = data ? (data.totals?.[platform]?.usnDefault ?? 0) * 100 : 0;
  const usnRatePct = usnRateOverride[platform] != null ? usnRateOverride[platform] : usnDefaultPct;
  const usnRateFrac = usnRatePct / 100;

  const t = useMemo(() => {
    const valid = filtered.filter((i) => !i.draft && Number.isFinite(i.profit));
    return {
      count: valid.length,
      draftCount: platformItems.length - valid.length,
      profit: Math.round(valid.reduce((a, i) => a + i.profit, 0)),
      vat: Math.round(valid.reduce((a, i) => a + (i.vat || 0), 0)),
      usn: Math.round(valid.reduce((a, i) => a + (i.usn || 0), 0)),
      profitCount: valid.filter((i) => i.profit > 0).length,
      lossCount: valid.filter((i) => i.profit < 0).length,
      avgMargin: valid.length > 0
        ? Math.round((valid.reduce((a, i) => a + (Number.isFinite(i.margin) ? i.margin : 0), 0) / valid.length) * 1000) / 10
        : 0,
    };
  }, [filtered, platformItems]);

  if (error) return <Centered>Ошибка: {error}</Centered>;
  if (!data) return <Centered>Загрузка данных…</Centered>;

  const whatifFields = WHATIF_INPUTS[platform];

  return (
    <main style={{ width: "100%", margin: 0, padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: C.accent, fontWeight: 700 }}>
            {platform === "wb" ? "WB · юнит-экономика" : "Ozon · юнит-экономика · FBO"}
          </div>
          <h1 style={{ margin: "4px 0 0", fontSize: 24, fontWeight: 800 }}>Юнит-экономика</h1>
          <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
            {t.count} товаров{t.draftCount > 0 ? ` · ${t.draftCount} черновиков` : ""} · 2 строки на товар: ФАКТ (чтение) + ПРИКИДКА (меняйте входы — прибыль пересчитается)
          </p>
        </div>
        {/* Переключатель МП */}
        <div style={{ display: "flex", gap: 4, background: C.surfaceAlt, borderRadius: 10, padding: 3 }}>
          {[{ v: "wb", l: "Wildberries" }, { v: "ozon", l: "Ozon" }].map((o) => (
            <button key={o.v} onClick={() => setPlatform(o.v)} style={{
              border: "none", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
              fontSize: 13, fontWeight: 600,
              background: platform === o.v ? C.accent : "transparent",
              color: platform === o.v ? "var(--accentInk)" : C.muted,
            }}>{o.l}</button>
          ))}
        </div>
      </div>

      {/* KPI */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, marginBottom: 22 }}>
        <Kpi label="Средняя маржа" value={pct(t.avgMargin)} accent />
        <Kpi label="Прибыльных SKU" value={num(t.profitCount)} pos={t.profitCount > 0} />
        <Kpi label="Убыточных SKU" value={num(t.lossCount)} pos={t.lossCount === 0} />
        <Kpi label="Сумма прибыли" value={money(t.profit)} accent />
      </div>

      {/* Фильтры */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        {categories.length > 0 && (
          <select value={cat} onChange={(e) => setCat(e.target.value)}
            style={{ padding: "9px 13px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 13, minWidth: 200 }}>
            <option value="all">Все категории</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            {platform === "ozon" && platformItems.some((i) => !i.category) && <option value="__nocat__">(без категории)</option>}
          </select>
        )}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск: имя, артикул…"
          style={{ flex: 1, minWidth: 200, padding: "9px 13px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14 }} />
        <label style={labelStyle}><input type="checkbox" checked={onlyLoss} onChange={(e) => setOnlyLoss(e.target.checked)} /> только убыточные</label>
        <label style={labelStyle}><input type="checkbox" checked={hideDraft} onChange={(e) => setHideDraft(e.target.checked)} /> скрыть черновики</label>
        <label style={labelStyle}><input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> все колонки</label>
        <label style={labelStyle}><input type="checkbox" checked={buyoutOn} onChange={(e) => setBuyoutOn(e.target.checked)} /> с % выкупа</label>
        <label style={labelStyle}><input type="checkbox" checked={defectOn} onChange={(e) => setDefectOn(e.target.checked)} /> с браком</label>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: C.muted }}>
          Ставка УСН:
          <OverrideInput sku="usn" field="Ставка УСН" asFraction={false} unit="%" max={25}
            value={usnRatePct} isChanged={usnRateOverride[platform] != null}
            onChange={(_sku, _field, n) => setUsnRate(n)} />
          {usnRateOverride[platform] != null && (
            <button onClick={resetUsnRate} title="Сбросить к дефолтной ставке кабинета"
              style={{ padding: "3px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer", border: `1px solid ${C.line}`, borderRadius: 6, background: C.surfaceAlt, color: C.muted }}>⟲</button>
          )}
        </span>
      </div>

      {/* Легенда + индикатор автосейва */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: C.muted }}>
          Серая строка — факт из БД. Синяя — прикидка: меняйте поля с рамкой, прибыль пересчитается. Сохраняется автоматически.
        </div>
        <SaveIndicator saveState={saveState} />
      </div>

      {/* Таблица — 2 строки на товар */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "auto", maxHeight: "78vh", position: "relative" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: full ? 1600 : 1100 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, position: "sticky", top: 0, zIndex: 2, boxShadow: `0 1px 0 ${C.line}` }}>
              {cols.map((c) => (
                <th key={c.key} style={{ ...th(c), background: C.surfaceAlt, position: "sticky", top: 0, zIndex: 2 }} title={c.tip}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map((it) => (
              <ProductRow key={it.sku} it={it} cols={cols} platform={platform} whatifFields={whatifFields}
                override={overrides[it.sku]} applying={applying === it.sku}
                buyoutOn={buyoutOn} defectOn={defectOn} usnRateFrac={usnRateFrac}
                onOverride={setOverride} onApply={applyOverride} onReset={resetOverride} />
            ))}
            {paged.length === 0 && (
              <tr><td colSpan={cols.length} style={{ padding: 20, textAlign: "center", color: C.muted }}>Ничего не найдено</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Пагинация */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
        <div style={{ color: C.faint, fontSize: 12 }}>
          Показано {filtered.length === 0 ? 0 : ((safePage - 1) * (pageSize > 0 ? pageSize : 0) + 1)}–
          {pageSize > 0 ? Math.min(safePage * pageSize, filtered.length) : filtered.length} из {filtered.length}.
          Сортировка — по прибыли.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.muted }}>
            строк:
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}
              style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 12 }}>
              <option value={20}>20</option><option value={50}>50</option><option value={100}>100</option><option value={0}>все</option>
            </select>
          </label>
          <PagerBtn disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>‹</PagerBtn>
          <span style={{ color: C.muted, fontSize: 12 }}>{safePage} / {totalPages}</span>
          <PagerBtn disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>›</PagerBtn>
        </div>
      </div>
    </main>
  );
}

// =====================================================================
//  ProductRow — двойная строка (ФАКТ + ПРИКИДКА)
// =====================================================================
function ProductRow({ it, cols, platform, whatifFields, override, applying, buyoutOn, defectOn, usnRateFrac, onOverride, onApply, onReset }) {
  const ov = override || null;
  // Прикидка теперь считается ВСЕГДА (не только при наличии сохранённого
  // per-sku override), т.к. режимы «с % выкупа»/«с браком» и глобальная
  // ставка УСН — page-level входы, влияющие на КАЖДУЮ строку. В дефолтном
  // состоянии (buyoutOn/defectOn=true, usnRateFrac=usnDefault, ov=null) это
  // идемпотентно повторяет расчёт it (те же входы → те же числа, регресс не
  // ломается — ФАКТ-строка вообще не пересчитывается, она server-truth).
  const whatif = useMemo(() => {
    const input = { ...it, ...ov, usnRate: usnRateFrac };
    if (!buyoutOn) input.buyout = 1; // «с % выкупа» OFF — нейтральный вход, сохранённые прикидки не трогаем
    if (!defectOn) input.defectRate = 0; // «с браком» OFF — нейтральный вход
    return platform === "wb" ? calcWB(input) : calcOzon(input);
  }, [it, ov, platform, buyoutOn, defectOn, usnRateFrac]);

  const hasOverride = !!ov && Object.keys(ov).length > 0; // per-sku override — управляет только кнопками «↧ в факт»/«⟲ к факту»
  // «changed» — шире hasOverride: строка могла измениться и из-за глобальных
  // режимов/ставки без единого per-sku override (badge/подсветка должны это видеть).
  const changed = hasOverride || !resultEqual(whatif.profit, it.profit) || !resultEqual(whatif.margin, it.margin);
  const dProfit = changed ? whatif.profit - it.profit : 0;
  const dMargin = changed ? (whatif.margin - it.margin) * 100 : 0;
  const pos = dProfit >= 0;

  const fieldMeta = (key) => whatifFields.find((f) => f.key === key);
  const isWhatifInput = (key) => whatifFields.some((f) => f.key === key);

  return (
    <Fragment>
      {/* Строка 1: ФАКТ */}
      <tr style={{ borderTop: `1px solid ${C.line}`, opacity: it.draft ? 0.5 : 1 }}>
        {cols.map((c, idx) => {
          if (idx === 0) {
            return (
              <td key={c.key} style={{ ...td(c, it) }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 220 }}>
                  <Thumb url={it.im_url} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: C.muted, textTransform: "uppercase" }}>факт</span>
                      {it.estimated && (
                        <span title={platform === "wb"
                            ? "Активный товар без продаж: выкуп 90% и комиссия — оценка по категории."
                            : "Логистика — каталожный тариф Ozon: нет проданных штук за последние 30 дней (факт из начислений недоступен)."}
                          style={{ fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: "rgba(255,180,0,0.14)", color: "#c98a00", whiteSpace: "nowrap", border: "1px solid rgba(255,180,0,0.3)" }}>⚙ оценка</span>
                      )}
                      {applying && <span style={{ fontSize: 10, color: C.pos }}>⏳</span>}
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.2, whiteSpace: "normal", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{it.name || "—"}</div>
                    {it.article && <div style={{ fontSize: 10.5, color: C.faint }}>{it.article}</div>}
                  </div>
                </div>
              </td>
            );
          }
          return <td key={c.key} style={td(c, it)}>{renderCell(c, it)}</td>;
        })}
      </tr>

      {/* Строка 2: ПРИКИДКА — акцентная полоса слева + подсветка отличают её от ФАКТА */}
      <tr style={{ background: soft("accent", 7), boxShadow: `inset 3px 0 0 ${C.accent}` }}>
        {cols.map((c, idx) => {
          if (idx === 0) {
            return (
              <td key={c.key} style={{ ...td(c, it), verticalAlign: "middle", whiteSpace: "nowrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: C.accent, textTransform: "uppercase" }}>прикидка</span>
                  {changed ? (
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 7px", borderRadius: 6, background: pos ? soft("pos", 14) : soft("neg", 14), color: pos ? C.pos : C.neg, whiteSpace: "nowrap" }}>
                      Δ {pos ? "+" : ""}{Math.round(dProfit)}₽ · {pos ? "+" : ""}{dMargin.toFixed(1)}%
                    </span>
                  ) : null}
                  {hasOverride && (
                    <>
                      <button onClick={() => onApply(it.sku)} title="Применить прикидку к боевым значениям (запишется в БД)"
                        style={{ padding: "3px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer", border: `1px solid ${C.accent}`, borderRadius: 6, background: C.surface, color: C.accent }}>↧ в факт</button>
                      <button onClick={() => onReset(it.sku)} title="Сбросить прикидку к фактическим значениям и удалить сохранённую запись"
                        style={{ padding: "3px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer", border: `1px solid ${C.line}`, borderRadius: 6, background: C.surfaceAlt, color: C.muted }}>⟲ к факту</button>
                    </>
                  )}
                </div>
              </td>
            );
          }
          if (isWhatifInput(c.key)) {
            const meta = fieldMeta(c.key);
            const stored = ov && ov[c.key] != null ? ov[c.key] : it[c.key];
            const changedInput = ov && ov[c.key] != null && !resultEqual(ov[c.key], it[c.key]);
            return (
              <td key={c.key} style={td(c, whatif)}>
                <OverrideInput sku={it.sku} field={c.key} asFraction={meta ? meta.asFraction : c.unit === "%"} unit={c.unit}
                  max={meta ? meta.max : (c.unit === "₽" ? 1000000 : 100)} value={stored} isChanged={changedInput} onChange={onOverride} />
              </td>
            );
          }
          const isChanged = !resultEqual(it[c.key], whatif[c.key]);
          return (
            <td key={c.key} style={{
              ...td(c, whatif),
              color: c.key === "profit" ? (whatif[c.key] >= 0 ? C.pos : C.neg) : isChanged ? C.accent : C.muted,
              fontWeight: isChanged || c.kind === "kpi" ? 700 : 400,
            }}>
              {renderCell(c, whatif)}
              {isChanged && c.key !== "profit" && c.key !== "margin" && c.key !== "renta" && (
                <div style={{ fontSize: 10, color: whatif[c.key] > it[c.key] ? C.pos : C.neg, marginTop: 2 }}>
                  {whatif[c.key] > it[c.key] ? "+" : ""}{fmtDelta(whatif[c.key] - it[c.key], c)}
                </div>
              )}
            </td>
          );
        })}
      </tr>
    </Fragment>
  );
}

function renderCell(c, it) {
  const v = it[c.key];
  if (c.fmt === "pct") return pct(v == null ? v : v * 100);
  if (c.unit === "₽") return money(v);
  if (c.unit === "%") return pct(v == null ? v : v * 100);
  if (c.unit === "л") return num(v);
  return v == null ? "—" : String(v);
}

function Thumb({ url }) {
  const [err, setErr] = useState(false);
  if (!url || err) {
    return <div style={{ width: 36, height: 36, borderRadius: 6, flexShrink: 0, background: C.surfaceAlt, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", color: C.faint, fontSize: 15 }}>🖼</div>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={36} height={36} onError={() => setErr(true)}
      style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6, flexShrink: 0, border: `1px solid ${C.line}` }} />
  );
}

function OverrideInput({ sku, field, asFraction, unit, max, value, isChanged, onChange }) {
  const display = value != null ? (asFraction ? Math.round(value * 100) : Math.round(value)) : 0;
  const [text, setText] = useState(String(display));
  const [focused, setFocused] = useState(false);
  useEffect(() => { setText(String(display)); }, [display]);
  const commit = () => {
    const n = parseFloat(text);
    if (!Number.isFinite(n) || n < 0 || n > max) { setText(String(display)); return; }
    if (n !== display) onChange(sku, field, n, asFraction);
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, justifyContent: "flex-end", width: "100%" }}>
      {isChanged && <span title="Отличается от факта" style={{ width: 5, height: 5, borderRadius: "50%", background: C.accent, flexShrink: 0 }} />}
      <input type="number" min={0} max={max} step={1} value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } }}
        title={`Прикидка: ${field}, ${unit}`}
        style={{
          width: unit === "₽" ? 70 : 50, padding: "3px 5px", fontSize: 13, textAlign: "right",
          border: `1px solid ${focused ? C.accent : C.line}`, borderRadius: 5, background: C.bg,
          color: isChanged ? C.accent : C.ink, fontWeight: isChanged ? 700 : 400, fontVariantNumeric: "tabular-nums",
        }} />
      <span style={{ fontSize: 11, color: C.faint }}>{unit}</span>
    </span>
  );
}

// Индикатор автосейва у легенды: Сохранение… → ✓ Сохранено HH:MM; при ошибке
// сети — «Не сохранилось — повторю» на время ретрая (3с), затем стойкий индикатор
// ошибки (значения прикидки в стейте не теряются — только факт записи в БД).
function SaveIndicator({ saveState }) {
  if (saveState.status === "idle") return null;
  const label =
    saveState.status === "saving" ? "Сохранение…" :
    saveState.status === "retrying" ? "Не сохранилось — повторю…" :
    saveState.status === "error" ? "✕ Не сохранилось" :
    `✓ Сохранено ${fmtTime(saveState.time)}`;
  const color = saveState.status === "error" ? C.neg : saveState.status === "saved" ? C.pos : C.muted;
  return (
    <span style={{ fontSize: 12, fontWeight: 600, color }}
      title={saveState.status === "error" ? "Изменения остались в браузере — измените поле ещё раз, чтобы повторить сохранение" : undefined}>
      {label}
    </span>
  );
}
function fmtTime(d) {
  return d ? d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";
}

function Kpi({ label, value, accent, pos }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: accent ? C.accent : pos === true ? C.pos : pos === false ? C.neg : C.ink }}>{value}</div>
    </div>
  );
}

function PagerBtn({ children, disabled, onClick }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ minWidth: 30, height: 30, padding: "0 8px", cursor: disabled ? "default" : "pointer", border: `1px solid ${disabled ? C.line : C.accent}`, borderRadius: 7, background: disabled ? C.surfaceAlt : C.surface, color: disabled ? C.faint : C.accent, fontSize: 14, fontWeight: 700, lineHeight: 1 }}>
      {children}
    </button>
  );
}

const th = (c) => ({
  textAlign: c.align === "left" ? "left" : "right",
  padding: "13px 14px", fontSize: 11, color: C.muted, textTransform: "uppercase",
  fontWeight: 600, whiteSpace: "nowrap", cursor: c.tip ? "help" : "default",
});

const td = (c, it) => {
  const isProfit = c.kind === "kpi" && c.key === "profit";
  const isTax = c.kind === "tax";
  const color = isProfit ? (it.profit >= 0 ? C.pos : C.neg) : isTax ? C.accent2 : c.kind === "kpi" ? C.ink : null;
  return {
    padding: "11px 14px", fontSize: 13,
    textAlign: c.align === "left" ? "left" : "right",
    whiteSpace: "nowrap", color: color || C.ink, fontVariantNumeric: "tabular-nums",
  };
};

const labelStyle = { display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: C.muted, cursor: "pointer" };

function resultEqual(a, b) {
  if (a == null && b == null) return true;
  return Math.round((a || 0) * 100) === Math.round((b || 0) * 100);
}
function fmtDelta(d, c) {
  if (c.fmt === "pct" || c.unit === "%") return (d * 100).toFixed(1) + "п.п.";
  if (c.unit === "₽") return Math.round(d) + " ₽";
  return String(d);
}

function Centered({ children }) {
  return <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, padding: 20, textAlign: "center" }}>{children}</div>;
}
