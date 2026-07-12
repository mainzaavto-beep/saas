"use client";

// /cabinets/[id] — Главная (Overview). Полный перенос эталона
// data-presenter/app/page.jsx с адаптацией под мультитенантный контур.
//
// Бэкенд не трогаем: /api/cabinets/[id]/overview уже отдаёт kpi/alerts/period.
// BriefingCard пока не подключаем (бэкенд briefings на SQLite, отдельная задача).
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

// Палитра SAAS (тёмно-синяя). Согласована с globals.css и SummaryPage.
const C = {
  bg: "#0b1220",
  surface: "#131c2e",
  surfaceAlt: "#1a2540",
  ink: "#e8edf7",
  muted: "#8a99b8",
  faint: "#6b7a8f",
  line: "#243049",
  accent: "#4f8cff",
  accent2: "#2bd4a0",
  pos: "#4ade80",
  neg: "#ff6b6b",
  warn: "#fbbf24",
};

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
  // Дефолтный период задаёт СЕРВЕР (последние 30 дней от MAX(order_dt) — так же,
  // как Сводка по товарам). Пока пользователь не выбрал период сам
  // (userPicked=false), UI шлёт запрос БЕЗ from/to и отображает серверный period
  // в шапке. Это устраняет расхождение цифр между Главной и Сводкой.
  const [gran, setGran] = useState("month");
  const [anchor, setAnchor] = useState(ymd(new Date()));
  const [userPicked, setUserPicked] = useState(false);
  const [serverPeriod, setServerPeriod] = useState(null); // {from,to} из ответа
  const [mp, setMp] = useState("all");

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const period = useMemo(() => computePeriod(gran, anchor), [gran, anchor]);

  useEffect(() => {
    setData(null);
    setError(null);
    const q = new URLSearchParams({ mp });
    if (userPicked) {
      q.set("from", period.from);
      q.set("to", period.to);
    }
    fetch(`/api/cabinets/${cabinetId}/overview?${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setData(d);
        if (!userPicked && d.period) {
          // Серверный дефолт (30 дней от MAX(order_dt)). Подгоним якорь под
          // конец диапазона, чтобы кнопки ‹/› шли оттуда, не от «сегодня».
          setAnchor(d.period.to);
          setServerPeriod(d.period);
        }
      })
      .catch((e) => setError(String(e)));
  }, [cabinetId, period.from, period.to, mp, userPicked]);

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
                color: gran === g.id ? "#0b1220" : C.muted,
              }}
            >
              {g.label}
            </button>
          ))}
        </div>

        {/* Навигация периода */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <NavBtn onClick={goPrev} title="Предыдущий">‹</NavBtn>
          <span style={{ minWidth: 180, textAlign: "center", fontSize: 14, fontWeight: 600, color: C.ink }}>
            {userPicked ? period.label : (serverPeriod ? `${serverPeriod.from} — ${serverPeriod.to}` : "…")}
          </span>
          <NavBtn onClick={goNext} title="Следующий">›</NavBtn>
          <NavBtn onClick={goYesterday} title="Вчера">Вчера</NavBtn>
        </div>

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
                color: mp === m.id ? "#0b1220" : C.muted,
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
          {/* KPI-карточки */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginBottom: 22 }}>
            <Kpi label="Выручка (продажи)" value={money(data.kpi.revenue)} accent />
            <Kpi label="Чистая прибыль" value={money(data.kpi.grossProfit)} pos={data.kpi.grossProfit >= 0} />
            <Kpi label="Маржа" value={pct(data.kpi.margin)} pos={data.kpi.margin >= 0} />
            <Kpi label="К перечислению" value={money(data.kpi.netPay)} />
            <Kpi label="Заказы" value={num(data.kpi.orders)} />
            <Kpi label="Отмена заказов" value={pct(data.kpi.cancelRate)} pos={data.kpi.cancelRate < 20} />
          </div>

          {/* Расходы МП */}
          <Card>
            <h2 style={h2}>Расходы маркетплейса</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
              <MiniStat label="Логистика" value={money(data.kpi.expensesBreakdown.logistics)} />
              <MiniStat label="Комиссии" value={money(data.kpi.expensesBreakdown.commission)} />
              <MiniStat label="Хранение" value={money(data.kpi.expensesBreakdown.storage)} />
              <MiniStat label="Штрафы" value={money(data.kpi.expensesBreakdown.penalties)} />
              <MiniStat label="Себестоимость" value={money(data.kpi.cogsSold)} />
              <MiniStat label="Реклама" value={money(data.kpi.adSpend)} />
              <MiniStat label="УСН 6%" value={money(data.kpi.tax)} />
              <MiniStat label="Итого расходы" value={money(data.kpi.expenses + data.kpi.cogsSold + (data.kpi.adSpend||0) + (data.kpi.tax||0))} accent />
            </div>
          </Card>

          {/* Проблемные места */}
          <h2 style={{ ...h2, marginTop: 26 }}>⚠ Проблемные места</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <Card>
              <CardTitle icon="🔴" title="Товары в минусе" hint="прибыль < 0 за период" />
              {!data.alerts.lossMakers || data.alerts.lossMakers.length === 0 ? (
                <Empty>Нет убыточных товаров за период 🎉</Empty>
              ) : (
                <Table head={["Товар", "Прибыль"]}>
                  {data.alerts.lossMakers.map((t) => (
                    <tr key={t.nm_id}>
                      <Td>{t.name || t.nm_id}</Td>
                      <Td right style={{ color: C.neg }}>{money(t.profit)}</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card>
              <CardTitle icon="🟡" title="Заканчиваются на складе" hint="дней до OOS" />
              {!data.alerts.lowStock || data.alerts.lowStock.length === 0 ? (
                <Empty>Нет критичных остатков за период</Empty>
              ) : (
                <Table head={["Товар", "Остаток", "дней"]}>
                  {data.alerts.lowStock.map((t) => (
                    <tr key={t.nm_id}>
                      <Td>{t.name || t.nm_id}</Td>
                      <Td right>{num(t.qty)} шт</Td>
                      <Td right style={{ color: t.days_to_oos < 14 ? C.neg : C.muted }}>
                        {t.days_to_oos != null ? num(t.days_to_oos) : "—"}
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
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
function Kpi({ label, value, accent, pos }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: "16px 18px" }}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: accent ? C.accent : pos === true ? C.pos : pos === false ? C.neg : C.ink }}>{value}</div>
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

const h2 = { margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: C.ink };
const th = (i) => ({ textAlign: i === 0 ? "left" : "right", padding: "0 8px 8px", fontSize: 11, color: C.muted, textTransform: "uppercase" });
const linkStyle = { color: C.accent, textDecoration: "none", fontSize: 13, fontWeight: 600, marginLeft: "auto" };

function Centered({ children }) {
  return <div style={{ minHeight: "50vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, padding: 20, textAlign: "center" }}>{children}</div>;
}
