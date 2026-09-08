"use client";
import { C, soft } from "@/lib/palette.js";
import { HINT_PAYOUT_OZON } from "@/lib/profitForms.js";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";

// /cabinets/[id] — Главная (Overview). Полный перенос эталона
// data-presenter/app/page.jsx с адаптацией под мультитенантный контур.
//
// Бэкенд не трогаем: /api/cabinets/[id]/overview уже отдаёт kpi/alerts/period.
// BriefingCard пока не подключаем (бэкенд briefings на SQLite, отдельная задача).
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { defaultPeriod } from "@/lib/period.js";

// Палитра SAAS (тёмно-синяя). Согласована с globals.css и SummaryPage.


const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽";
const num = (v) =>
  v == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(v);
const pct = (v) =>
  v == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(v) + "%";

// Гранулярности периода.
const GRANS = [
  { id: "day", label: "День" },
  { id: "week", label: "Неделя" },
  { id: "month", label: "Месяц" },
  { id: "year", label: "Год" },
  { id: "custom", label: "Интервал" },
];

// Маркетплейсы.
const MPS = [
  { id: "all", label: "Все" },
  { id: "wb", label: "Wildberries" },
  { id: "ozon", label: "Ozon" },
];

// Сдвиг «якоря» периода (назад/вперёд) на 1 шаг гранулярности.
function shiftPeriod(gran, anchor, dir) {
  const [Y, M, D] = anchor.split("-").map(Number);
  const d = new Date(Y, M - 1, D);
  if (gran === "day") d.setDate(d.getDate() + dir);
  else if (gran === "week") d.setDate(d.getDate() + dir * 7);
  else if (gran === "month") d.setMonth(d.getMonth() + dir);
  else if (gran === "year") d.setFullYear(d.getFullYear() + dir);
  return ymd(d);
}
const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;

// Превратить (гранулярность, якорь) в {from,to,label}.
function computePeriod(gran, anchor) {
  const [Y, M, D] = anchor.split("-").map(Number);
  const d = new Date(Y, M - 1, D);
  let from, to, label;
  const fmtRu = (x) =>
    x.toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
  const fmtMon = (x) => x.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });

  if (gran === "day") {
    from = to = ymd(d);
    label = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
  } else if (gran === "week") {
    const wd = (d.getDay() + 6) % 7;
    const start = new Date(d);
    start.setDate(d.getDate() - wd);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    from = ymd(start);
    to = ymd(end);
    label = `${fmtRu(start)} – ${fmtRu(end)}`;
  } else if (gran === "month") {
    from = ymd(new Date(d.getFullYear(), d.getMonth(), 1));
    to = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    label = fmtMon(d);
  } else {
    from = ymd(new Date(d.getFullYear(), 0, 1));
    to = ymd(new Date(d.getFullYear(), 11, 31));
    label = String(d.getFullYear());
  }
  return { from, to, label };
}

export default function OverviewClient({ cabinetId }) {
  // Дефолтный период задаёт СЕРВЕР (defaultPeriod(30), lib/period.js — последние
  // 30 дней ПО ВЧЕРА). Пока пользователь не выбрал период сам (userPicked=false),
  // UI шлёт запрос БЕЗ from/to и отображает серверный period в шапке. Это
  // устраняет расхождение цифр между Главной и Сводкой.
  const [gran, setGran] = useState("month");
  const [anchor, setAnchor] = useState(ymd(new Date()));
  const [userPicked, setUserPicked] = useState(false);
  const [serverPeriod, setServerPeriod] = useState(null); // {from,to} из ответа
  const [mp, setMp] = useState("all");
  // Произвольный интервал (гранулярность "custom"). Дефолт — defaultPeriod(30)
  // из lib/period.js (последние 30 дней ПО ВЧЕРА), НЕ локальная копия расчёта
  // (ymd — getFullYear/getMonth/getDate, часовой пояс браузера) — при
  // gran==="custom" клиент ВСЕГДА шлёт даты явно (см. ниже), serverPeriod для
  // custom не подставляется, и около полуночи UTC локальное «вчера» может
  // разойтись с серверным на день (пост-ревью задачи 2). Поэтому: 1) как
  // только приходит serverPeriod (после первого ответа сервера — он тоже
  // считается через defaultPeriod) — подставляем ЕГО, один раз, если поля ещё
  // не тронуты пользователем (customSeededRef, ref — не state, чтобы сидирование
  // не гоняло основной fetch-эффект по кругу); 2) до этого — тот же
  // defaultPeriod(30), что и на сервере.
  const [customFrom, setCustomFrom] = useState(() => defaultPeriod(30).from);
  const [customTo, setCustomTo] = useState(() => defaultPeriod(30).to);
  const customSeededRef = useRef(false);

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const period = useMemo(() => {
    if (gran === "custom") {
      const d30 = defaultPeriod(30);
      const f = customFrom || d30.from;
      const t = customTo || d30.to;
      return { from: f, to: t, label: `${f} — ${t}` };
    }
    return computePeriod(gran, anchor);
  }, [gran, anchor, customFrom, customTo]);

  useEffect(() => {
    setData(null);
    setError(null);
    const q = new URLSearchParams({ mp });
    // Для custom — всегда шлём выбранный интервал; для пресетов — только если
    // пользователь сам выбирал период (иначе сервер отдаёт дефолт defaultPeriod(30)).
    if (gran === "custom" || userPicked) {
      q.set("from", period.from);
      q.set("to", period.to);
    }
    fetch(`/api/cabinets/${cabinetId}/overview?${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setData(d);
        if (gran !== "custom" && !userPicked && d.period) {
          // Серверный дефолт (defaultPeriod(30) — 30 дней по вчера). Подгоним
          // якорь под конец диапазона, чтобы кнопки ‹/› шли оттуда, не от
          // «сегодня».
          setAnchor(d.period.to);
          setServerPeriod(d.period);
        }
        // Сидируем поля «Интервала» серверным периодом (один раз, пока
        // пользователь их не трогал) — не копия расчёта, а чтение ответа.
        // Ref, не state: сидирование не должно перезапускать этот эффект.
        if (d.period && !customSeededRef.current) {
          setCustomFrom(d.period.from);
          setCustomTo(d.period.to);
          customSeededRef.current = true;
        }
      })
      .catch((e) => setError(String(e)));
  }, [cabinetId, period.from, period.to, mp, userPicked, gran]);

  const goPrev = () => { setUserPicked(true); setAnchor((a) => shiftPeriod(gran, a, -1)); };
  const goNext = () => { setUserPicked(true); setAnchor((a) => shiftPeriod(gran, a, +1)); };
  // Кнопка «Вчера»: данные выгружаются за прошлый день. Обязательно переключаем
  // гранулярность на «День» — иначе при gran="month" смена якоря ничего не даст.
  const goYesterday = () => {
    setUserPicked(true);
    setGran("day");
    setAnchor(ymd(new Date(Date.now() - 86400000)));
  };

  const base = `/cabinets/${cabinetId}`;

  return (
    <main style={{ width: "100%", margin: 0, padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Сводка бизнеса</h1>
      </div>

      {/* === Панель фильтров === */}
      <div style={{
        background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14,
        padding: "12px 14px", marginBottom: 20, display: "flex", gap: 16,
        alignItems: "center", flexWrap: "wrap",
      }}>
        {/* Гранулярность */}
        <div style={{ display: "flex", gap: 4, background: C.surfaceAlt, borderRadius: 10, padding: 3 }}>
          {GRANS.map((g) => (
            <button
              key={g.id}
              onClick={() => setGran(g.id)}
              style={{
                border: "none", padding: "6px 14px", borderRadius: 8, cursor: "pointer",
                fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                background: gran === g.id ? C.accent : "transparent",
                color: gran === g.id ? "var(--accentInk)" : C.muted,
              }}
            >
              {g.label}
            </button>
          ))}
        </div>

        {/* Навигация периода (для пресетов — кнопки, для custom — date-инпуты) */}
        {gran === "custom" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="date" value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              style={{ ...dateInputStyle, color: C.ink }}
            />
            <span style={{ color: C.faint, fontSize: 13 }}>—</span>
            <input
              type="date" value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              style={{ ...dateInputStyle, color: C.ink }}
            />
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <NavBtn onClick={goPrev} title="Предыдущий">‹</NavBtn>
            <span style={{ minWidth: 180, textAlign: "center", fontSize: 14, fontWeight: 600, color: C.ink }}>
              {userPicked ? period.label : (serverPeriod ? `${serverPeriod.from} — ${serverPeriod.to}` : "…")}
            </span>
            <NavBtn onClick={goNext} title="Следующий">›</NavBtn>
            <NavBtn onClick={goYesterday} title="Вчера">Вчера</NavBtn>
          </div>
        )}

        {/* Маркетплейс */}
        <div style={{ display: "flex", gap: 4, background: C.surfaceAlt, borderRadius: 10, padding: 3, marginLeft: "auto" }}>
          {MPS.map((m) => (
            <button
              key={m.id}
              onClick={() => setMp(m.id)}
              style={{
                border: "none", padding: "6px 14px", borderRadius: 8,
                fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer",
                background: mp === m.id ? C.accent : "transparent",
                color: mp === m.id ? "var(--accentInk)" : C.muted,
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {error && <Centered>Ошибка: {error}</Centered>}
      {!error && !data && <Centered>Загрузка данных…</Centered>}

      {!error && data && (
        <>
          {/* Верх: 2 колонки — слева KPI, справа график */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr)", gap: 20, marginBottom: 22, alignItems: "start" }}>
            {/* Левая колонка — KPI-плашки */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
              <Kpi label="Чистая прибыль" value={money(data.kpi.profit)} pos={data.kpi.profit >= 0} primary />
              <Kpi label="Заказы, ₽" value={money(data.kpi.orderRub)} />
              <Kpi label="Выручка (продажи)" value={money(data.kpi.revenue)} accent />
              <Kpi label="Маржа" value={pct(data.kpi.margin)} pos={data.kpi.margin >= 0} />
              {/* netPay — Σ по площадкам: у WB факт финотчёта, у Ozon расчёт
                  (ozNetForm). Оговорка — только когда Ozon в выборке (тем же
                  условием mp !== "wb", что и подпись графика ниже). */}
              <Kpi label="К перечислению" value={money(data.kpi.netPay)}
                hint={mp !== "wb" ? HINT_PAYOUT_OZON : undefined} />
              <Kpi label="Отмена заказов" value={pct(data.kpi.cancelRate)} pos={data.kpi.cancelRate < 20} />
            </div>
            {/* Правая колонка — график */}
            <OverviewChart data={data.timeseries} mp={mp} />
          </div>

          {/* Расходы МП */}
          <Card>
            <h2 style={h2}>Расходы маркетплейса</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
              <MiniStat label="Логистика" value={money(data.kpi.expensesBreakdown.logistics)} />
              <MiniStat label="Сборы Ozon" value={money(data.kpi.expensesBreakdown.services)} />
              <MiniStat label="Комиссии" value={money(data.kpi.expensesBreakdown.commission)} />
              <MiniStat label="Хранение" value={money(data.kpi.expensesBreakdown.storage)} />
              <MiniStat label="Штрафы" value={money(data.kpi.expensesBreakdown.penalties)} />
              <MiniStat label="Себестоимость" value={money(data.kpi.cogsSold)} />
              <MiniStat label="Реклама" value={money(data.kpi.adSpend)} />
              <MiniStat label={data.taxLabel || "Налог"} value={money(data.kpi.tax)} />
              <MiniStat label="Итого расходы" value={money(data.kpi.expenses + data.kpi.cogsSold + (data.kpi.adSpend||0) + (data.kpi.tax||0))} accent />
            </div>
          </Card>

          {/* Проблемные места */}
          <h2 style={{ ...h2, marginTop: 26 }}>⚠ Проблемные места</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
            <Card>
              <CardTitle icon="🔴" title="Товары в минусе" hint="прибыль < 0 за период" />
              {!data.alerts.lossMakers || data.alerts.lossMakers.length === 0 ? (
                <Empty>Нет убыточных товаров за период 🎉</Empty>
              ) : (
                <Table head={["Товар", "Прибыль"]}>
                  {data.alerts.lossMakers.map((t) => (
                    <tr key={t.nm_id}>
                      <Td>
                        {t.name || t.nm_id}
                        {t.costMissing ? (
                          <span
                            title="Себестоимость не заведена — прибыль по этому товару занижена в расчёте"
                            style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 3, background: soft("warn", 13), color: C.warn, fontWeight: 700 }}
                          >
                            без себеса
                          </span>
                        ) : null}
                      </Td>
                      <Td right style={{ color: C.neg }}>{money(t.profit)}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card>
              {/* Канон покрытия (Склады 2.0, этап 4, 2026-09-08) — те же данные,
                  что вкладка /warehouses, сигнал low_coverage: обе площадки, остаток
                  «доступно» (FBO+FF минус учтённое в пути), окно продаж 28 дн, порог
                  минимального запаса 28 дн. Раньше — WB-only, среднее по дням с
                  продажами за выбранный период; НЕ «починка обратно», смена канона. */}
              <CardTitle icon="🟡" title="Заканчиваются на складе" hint="покрытие < минимального запаса, канон 28 дн" />
              {!data.alerts.lowStock || data.alerts.lowStock.length === 0 ? (
                <Empty>Нет критичных остатков</Empty>
              ) : (
                <Table head={["Товар", "Где", "Остаток", "дней"]}>
                  {data.alerts.lowStock.map((t) => (
                    <tr key={`${t.name}|${t.where}`}>
                      <Td>{t.name}</Td>
                      <Td>{t.where}</Td>
                      <Td right>{num(t.qty)} шт</Td>
                      <Td right style={{ color: t.days_to_oos < 14 ? C.neg : C.muted }}>
                        {t.days_to_oos != null ? num(t.days_to_oos) : "—"}
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card>
              <CardTitle icon="🏬" title="Склады" hint="сигналы учёта и поставок" />
              <WarehouseSignals base={base} signals={data.alerts.warehouses} />
            </Card>
          </div>

          {data.alerts.noCogsCount > 0 && (
            <Card>
              <div style={{ display: "flex", alignItems: "center", gap: 12, color: C.accent2 }}>
                <span style={{ fontSize: 18 }}>ℹ️</span>
                <span style={{ fontSize: 14 }}>
                  У <b>{data.alerts.noCogsCount}</b> товаров с продажами за период не заведена себестоимость —
                  прибыль по ним считается некорректно.
                </span>
                <Link href={`${base}/items`} style={linkStyle}>Завести →</Link>
              </div>
            </Card>
          )}

          {/* Быстрые ссылки */}
          <h2 style={{ ...h2, marginTop: 26 }}>Быстрый доступ</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            <QuickLink href={`${base}/summary`} label="Сводка по товарам" />
            <QuickLink href={`${base}/pnl`} label="Сводка по прибыли" />
            <QuickLink href={`${base}/items`} label="Товары и себестоимость" />
          </div>
        </>
      )}
    </main>
  );
}

// --- компоненты ---
function NavBtn({ children, onClick, title }) {
  return (
    <button onClick={onClick} title={title} style={{
      border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink,
      borderRadius: 8, padding: "5px 12px", cursor: "pointer",
      fontFamily: "inherit", fontSize: 14, fontWeight: 700, lineHeight: 1,
    }}>{children}</button>
  );
}
function Kpi({ label, value, accent, pos, primary, hint }) {
  return (
    <div title={hint} style={{
      background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "16px 18px",
      ...(primary ? { gridColumn: "1 / -1" } : {}),
    }}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: primary ? 30 : 24, fontWeight: 800, color: accent ? C.accent : pos === true ? C.pos : pos === false ? C.neg : C.ink }}>{value}</div>
    </div>
  );
}
function Card({ children }) {
  return <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginTop: 14 }}>{children}</div>;
}
function MiniStat({ label, value, accent }) {
  return (
    <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "11px 13px" }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: accent ? C.accent : C.ink }}>{value}</div>
    </div>
  );
}
function CardTitle({ icon, title, hint }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
      <span style={{ fontSize: 12, color: C.faint, marginLeft: "auto" }}>{hint}</span>
    </div>
  );
}
function Table({ head, children }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr>{head.map((h, i) => <th key={i} style={th(i)}>{h}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  );
}
function Td({ children, right, style }) {
  return <td style={{ padding: "7px 8px", borderTop: `1px solid ${C.line}`, fontSize: 13, textAlign: right ? "right" : "left", ...style }}>{children}</td>;
}
function Empty({ children }) {
  return <div style={{ color: C.muted, fontSize: 13, padding: "8px 0" }}>{children}</div>;
}
function QuickLink({ href, label }) {
  return (
    <Link href={href} style={{ display: "block", textDecoration: "none", background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px 16px", color: C.ink, fontWeight: 600, fontSize: 14 }}>
      {label} <span style={{ color: C.accent, float: "right" }}>→</span>
    </Link>
  );
}

// Карточка «Склады» (Склады 2.0, этап 4, 2026-09-08) — та же полоса сигналов, что
// вкладка /warehouses (SignalsStrip), но здесь не переиспользована: та строит ссылки
// относительными query-параметрами (?tab=…) — на странице /cabinets/[id] это увело бы
// клик на текущий путь вместо /warehouses. Здесь — те же kind→таргеты, абсолютные ссылки.
const WAREHOUSE_SIGNAL_TARGET = {
  discrepancy: "warehouses?tab=matrix&problems=1",
  low_coverage: "warehouses?tab=matrix&problems=1",
  gaps: "warehouses?tab=places",
  waiting_accept: "warehouses?tab=supplies",
};
function WarehouseSignals({ base, signals }) {
  if (!signals || signals.length === 0) {
    return <Empty>Проблем на складах нет</Empty>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {signals.map((s) => (
        <Link
          key={s.kind}
          href={`${base}/${WAREHOUSE_SIGNAL_TARGET[s.kind] || "warehouses"}`}
          style={{
            display: "flex", alignItems: "center", gap: 8, textDecoration: "none",
            padding: "6px 10px", borderRadius: 8,
            background: soft(s.level === "crit" ? "neg" : "warn", 12),
            color: C.ink, fontSize: 13,
          }}
        >
          <span>{s.level === "crit" ? "🔴" : "🟠"}</span>
          <span style={{ flex: 1 }}>{s.text}</span>
          <span style={{ color: C.accent }}>→</span>
        </Link>
      ))}
    </div>
  );
}

const h2 = { margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: C.ink };
const th = (i) => ({ textAlign: i === 0 ? "left" : "right", padding: "0 8px 8px", fontSize: 11, color: C.muted, textTransform: "uppercase" });
const linkStyle = { color: C.accent, textDecoration: "none", fontSize: 13, fontWeight: 600, marginLeft: "auto" };
const dateInputStyle = {
  padding: "6px 10px", borderRadius: 8, border: `1px solid ${C.line}`,
  background: C.surfaceAlt, fontSize: 13, fontFamily: "inherit",
};

// --- График динамики по дням с переключаемыми метриками ---
// Конфиг метрик: key = поле в timeseries, axis L=₽ (левая ось), R=шт (правая ось).
const CHART_METRICS = [
  { key: "revenue",   label: "Выручка",        color: C.accent,  axis: "L", unit: "rub", token: "accent" },
  { key: "profit",    label: "Прибыль",        color: C.pos,     axis: "L", unit: "rub", token: "pos" },
  { key: "orders",    label: "Заказы, шт",     color: C.accent2, axis: "R", unit: "pcs", token: "accent2" },
  { key: "orderRub",  label: "Заказы, ₽",      color: C.pink,    axis: "L", unit: "rub", token: "pink" },
  { key: "commission",label: "Комиссия",       color: C.neg,     axis: "L", unit: "rub", token: "neg" },
  { key: "netPay",    label: "К перечислению", color: C.warn,    axis: "L", unit: "rub", token: "warn",
    hint: HINT_PAYOUT_OZON },
];
// Метрики, активные по умолчанию.
const DEFAULT_ACTIVE = { revenue: true, profit: true, orders: true };

function OverviewChart({ data, mp }) {
  // D7: хук — в самом верху, до ранних return.
  const [active, setActive] = useState(DEFAULT_ACTIVE);
  const toggle = (key) => {
    // Не даём выключить все — оставляем хотя бы одну активную.
    const next = { ...active, [key]: !active[key] };
    const cnt = Object.values(next).filter(Boolean).length;
    if (cnt === 0) return;
    setActive(next);
  };

  const chartData = useMemo(() => {
    if (!data || !data.length) return [];
    return data.map((d) => ({ ...d, label: (d.date || "").slice(5) }));
  }, [data]);

  const activeMetrics = CHART_METRICS.filter((m) => active[m.key]);
  const hasRub = activeMetrics.some((m) => m.axis === "L");
  const hasPcs = activeMetrics.some((m) => m.axis === "R");

  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14,
      padding: "14px 16px 10px", minHeight: 320,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: C.ink }}>Динамика по дням</h2>
        <span style={{ fontSize: 11, color: C.faint }}>
          {mp === "wb" ? "WB" : mp === "ozon" ? "Ozon" : "WB + Ozon"}
        </span>
      </div>

      {/* Чекбоксы-пилюли метрик */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {CHART_METRICS.map((m) => {
          const on = !!active[m.key];
          // Подсказка метрики (m.hint) прицепляется к тому же title, что
          // «Скрыть/Показать» — у «К перечислению» это оговорка «расчётно
          // для Ozon» (на WB-only выборке не показываем: там payout — факт).
          const tip = [on ? "Скрыть" : "Показать", m.hint && mp !== "wb" ? m.hint : null]
            .filter(Boolean).join(" · ");
          return (
            <button key={m.key} onClick={() => toggle(m.key)} title={tip}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px",
                borderRadius: 16, fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                border: `1px solid ${on ? m.color : C.line}`,
                background: on ? soft(m.token, 12) : "transparent",
                color: on ? m.color : C.faint,
              }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: on ? m.color : C.faint, flexShrink: 0 }} />
              {m.label}
            </button>
          );
        })}
      </div>

      {chartData.length === 0 ? (
        <div style={{ height: 260, display: "grid", placeItems: "center", color: C.faint, fontSize: 13 }}>
          Нет данных за период
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" stroke={C.faint} fontSize={10} tickMargin={6} minTickGap={16} />
            {hasRub && (
              <YAxis yAxisId="L" stroke={C.accent} fontSize={11} width={52}
                tickFormatter={(v) => fmtCompact(v)} />
            )}
            {hasPcs && (
              <YAxis yAxisId="R" orientation="right" stroke={C.accent2} fontSize={11} width={36}
                tickFormatter={(v) => fmtCompact(v)} />
            )}
            <Tooltip content={<ChartTip />} />
            {activeMetrics.map((m) => (
              <Line key={m.key} yAxisId={m.axis} type="monotone" dataKey={m.key} name={m.label}
                stroke={m.color} strokeWidth={m.key === "revenue" ? 2.2 : 1.9} dot={false}
                connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
      <div style={{ fontSize: 11, color: C.faint, marginTop: 6, lineHeight: 1.45 }}>
        Прибыль — маржинальная (выручка минус комиссия/логистика/эквайринг/лояльность, без себестоимости и налога).
        {" "}Отметьте показатели выше, чтобы добавить их на график.
        {mp !== "wb" && " Для Ozon линия прибыли недоступна — показаны заказы и выручка."}
      </div>
    </div>
  );
}

// Тултип: показывает активные метрики с правильным форматом (₽ или шт).
function ChartTip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.line}`, borderRadius: 8,
      padding: "8px 10px", fontSize: 12, color: C.ink, boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {payload.map((p) => {
        const m = CHART_METRICS.find((x) => x.key === p.dataKey);
        if (!m) return null;
        const value = m.unit === "rub" ? money(p.value) : num(p.value) + " шт";
        return <Row key={p.dataKey} color={p.color} label={m.label} value={value} />;
      })}
    </div>
  );
}
function Row({ color, label, value }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
      <span style={{ color: C.muted }}>{label}</span>
      <span style={{ marginLeft: "auto", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
// Компактный формат оси: 1.2M / 950K / 320.
function fmtCompact(v) {
  if (v == null) return "";
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return Math.round(v / 1e3) + "K";
  return String(Math.round(v));
}

function Centered({ children }) {
  return <div style={{ minHeight: "50vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, padding: 20, textAlign: "center" }}>{children}</div>;
}
