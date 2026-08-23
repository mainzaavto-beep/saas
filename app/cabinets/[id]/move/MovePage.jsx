"use client";
import { C, soft } from "@/lib/palette.js";
import { ALERT } from "@/lib/callout.js";

import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Line, ComposedChart,
} from "recharts";

// =====================================================================
//  /items/move — «Перемещения между складами WB» (Этап 1, контракт realloc
//  2026-07-03).
//
//  ⚠️ Главное ограничение (см. route.js): WB НЕ отдаёт перемещения через
//  публичный API. Поэтому данные здесь — ВЫВОД из дневных снимков daily_stock
//  (остатки/локализация) и orders (спрос) + ручная фиксация ваших заявок в
//  fin_data.db.wb_realloc_requests. Авто-лов слотов невозможен без риска бана
//  (Этап 2). Заявку в кабинете WB владелец создаёт руками; здесь лишь
//  отмечает статус для дашборда.
//
//  3 вкладки:
//    «Состояние»    — остатки по складам + индекс локализации с трендом +
//                     алерты перекоса (>80% на одном складе).
//    «Рекомендации» — откуда/куда переместить (дефицит ← избыток), чекбоксы,
//                     кнопка «Создать заявку» (POST в wb_realloc_requests).
//    «Мои заявки»   — таблица заявок со статусами, смена статуса, отмена,
//                     автоподсказка доставки (если склад-приёмник принял ≥ qty).
// =====================================================================

const inputStyle = {
  padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line}`,
  background: C.surfaceAlt, color: C.ink, fontSize: 13, fontFamily: "inherit",
};
const selectStyle = {
  ...inputStyle, padding: "7px 26px 7px 10px", appearance: "none",
  backgroundImage:
    "linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)",
  backgroundPosition: "calc(100% - 14px) 50%, calc(100% - 9px) 50%",
  backgroundSize: "5px 5px, 5px 5px", backgroundRepeat: "no-repeat", cursor: "pointer",
};
const num = (n) => Math.round(n).toLocaleString("ru-RU");
const pct = (n) => (n == null ? "—" : `${n.toFixed(1)}%`);
const fmtFull = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
};
const fmtCover = (x) => {
  if (x == null) return "—";
  if (!isFinite(x)) return "∞";
  return String(x);
};

export default function MovePage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("state"); // state | recommend | requests
  const [q, setQ] = useState("");
  const [nm, setNm] = useState("");
  // Параметры рекомендаций (могут правиться в UI).
  const [demandWindow, setDemandWindow] = useState(14);
  const [excessDays, setExcessDays] = useState(14);
  const [deficitDays, setDeficitDays] = useState(5);
  const [targetCover, setTargetCover] = useState(14);
  const [reloadKey, setReloadKey] = useState(0);
  const [toast, setToast] = useState(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (nm) p.set("nm", nm);
    p.set("demandWindow", demandWindow);
    p.set("excessDays", excessDays);
    p.set("deficitDays", deficitDays);
    p.set("targetCover", targetCover);
    return p.toString();
  }, [q, nm, demandWindow, excessDays, deficitDays, targetCover, reloadKey]);

  useEffect(() => {
    setData(null);
    fetch(`/api/cabinets/${cabinetId}/move?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError("Ошибка: " + d.error);
        else { setError(null); setData(d); }
      })
      .catch(() => setError("Не удалось загрузить данные."));
  }, [qs]);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const reload = () => setReloadKey((k) => k + 1);

  const font = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.ink, fontFamily: font }}>
      <div style={{ maxWidth: 1340, margin: "0 auto", padding: "28px 22px 56px" }}>
        <div style={{ marginBottom: 14 }}>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800 }}>Перемещения между складами WB</h1>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>
            Состояние остатков, индекс локализации и рекомендации по перераспределению.{" "}
            {data ? `Снимок: ${fmtFull(data.date)}` : "загрузка…"}
          </div>
        </div>

        <div style={{ ...ALERT.info, borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 12, lineHeight: 1.5 }}>
          <strong>ℹ️ Как это работает.</strong> WB не отдаёт перемещения через публичный API —
          поэтому остатки и движение мы выводим из дневных снимков <code>daily_stock</code>, а
          рекомендации «откуда/куда» считаем из спроса <code>orders</code> × остатков.{" "}
          <strong>Заявку в кабинете WB вы создаёте руками</strong>; здесь лишь фиксируете её
          статус для дашборда. Авто-лов слотов невозможен без риска бана аккаунта (Этап 2).
        </div>

        {/* Вкладки */}
        <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: `1px solid ${C.line}` }}>
          <Tab active={tab === "state"} onClick={() => setTab("state")}>Состояние</Tab>
          <Tab active={tab === "recommend"} onClick={() => setTab("recommend")}>
            Рекомендации {data?.recommendations?.length ? `(${data.recommendations.length})` : ""}
          </Tab>
          <Tab active={tab === "requests"} onClick={() => setTab("requests")}>
            Мои заявки {data?.requests?.length ? `(${data.requests.filter((r) => r.status !== "delivered" && r.status !== "cancelled").length})` : ""}
          </Tab>
        </div>

        {error && <Centered>{error}</Centered>}

        {!error && tab === "state" && data && <StateTab data={data} />}

        {!error && tab === "recommend" && data && (
          <RecommendTab
            data={data}
            q={q} setQ={setQ}
            demandWindow={demandWindow} setDemandWindow={setDemandWindow}
            excessDays={excessDays} setExcessDays={setExcessDays}
            deficitDays={deficitDays} setDeficitDays={setDeficitDays}
            targetCover={targetCover} setTargetCover={setTargetCover}
            reload={reload}
            flash={flash}
          />
        )}

        {!error && tab === "requests" && data && (
          <RequestsTab requests={data.requests} flash={flash} reload={reload} />
        )}

        {toast && (
          <div style={{
            position: "fixed", bottom: 24, right: 24, zIndex: 100,
            background: C.surface, border: `1px solid ${C.accent}`, borderRadius: 10,
            padding: "12px 18px", color: C.ink, fontSize: 13, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}>
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

// ===================== Вкладка «Состояние» =====================
function StateTab({ data }) {
  const loc = data.localization || {};
  const trend = loc.trend || [];
  const delta = loc.delta_pct;
  const deltaColor = delta == null ? C.faint : delta < 0 ? C.pos : delta > 0 ? C.neg : C.muted;
  const deltaSign = delta == null ? "" : delta > 0 ? "+" : "";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 16 }}>
      {/* Локализация: KPI */}
      <Card title="🗺️ Индекс локализации" hint={`топ-склад: ${pct(loc.top_share_pct)}`}>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 14 }}>
          <Kpi label="Топ-склад сегодня" value={pct(loc.top_share_pct)} sub={loc.by_warehouse?.[0]?.warehouse || "—"} />
          <Kpi label={`${trend.length} дн назад`} value={pct(loc.prev_top_share_pct)} sub={trend[0]?.top_warehouse || "—"} />
          <Kpi
            label="Динамика"
            value={delta == null ? "—" : `${deltaSign}${delta.toFixed(1)}%`}
            valueColor={deltaColor}
            sub={delta == null ? "" : delta <= 0 ? "равномернее (↓ доля топа)" : "концентрация ↑"}
          />
          <Kpi label="Складов с остатком" value={String(loc.regions_count || 0)} />
        </div>
        <div style={{ fontSize: 12, color: C.faint, marginBottom: 6 }}>
          Чем <strong>ниже</strong> доля топ-склада — тем равномернее товар распределён по регионам
          (ниже базовая логистика и выше индекс локализации). Тренд показывает, как менялась доля
          топ-склада за {trend.length} дней.
        </div>
        {/* Таблица остатков по складам */}
        <Table head={["Склад", "Остаток", "Доля"]}>
          {(loc.by_warehouse || []).map((w, i) => (
            <tr key={w.warehouse} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
              <Td>{i === 0 ? "🏆 " : ""}{w.warehouse}</Td>
              <Td right>{num(w.qty)} шт</Td>
              <Td right>
                <strong style={{ color: i === 0 ? C.accent2 : C.muted }}>{pct(w.share_pct)}</strong>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {/* Тренд доли топ-склада во времени */}
      <Card title="📈 Тренд локализации" hint={`доля топ-склада по дням, ${trend.length} дн`}>
        {trend.length < 2 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.faint }}>
            Недостаточно снимков для тренда (нужно ≥2 дней истории).
          </div>
        ) : (
          <div style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={C.line} strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.faint }} tickFormatter={(d) => fmtFull(d).slice(0, 5)} />
                <YAxis
                  tick={{ fontSize: 11, fill: C.faint }} domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`} width={42}
                />
                <Tooltip
                  formatter={(v) => `${Number(v).toFixed(1)}%`}
                  labelFormatter={(l) => fmtFull(String(l))}
                  contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 12 }}
                />
                <Line type="monotone" dataKey="top_share_pct" stroke={C.accent} strokeWidth={2} dot={{ r: 2, fill: C.accent }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <div style={{ fontSize: 11, color: C.faint, marginTop: 8, textAlign: "center" }}>
          Цель — снижение линии (равномерное распределение по складам).
        </div>
      </Card>

      {/* Все остатки по складам (бар-чарт) */}
      <Card title="📦 Остатки по складам" hint={`всего ${data.byWarehouse?.length || 0} складов`}>
        <div style={{ height: Math.max(240, (data.byWarehouse || []).length * 30 + 40) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.byWarehouse || []} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid stroke={C.line} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="warehouse" width={160} tick={{ fontSize: 10, fill: C.ink }} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v) => `${num(v)} шт`} contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 12 }} />
              <Bar dataKey="quantity_full" fill={C.accent} radius={[0, 5, 5, 0]} barSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Перекосы */}
      <Card title="⚠️ Перекосы распределения" hint={`${data.skewAlerts?.length || 0} SKU с >80% остатка на одном складе`}>
        {(data.skewAlerts || []).length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.faint }}>
            Существенных перекосов нет — товар распределён по складам равномерно.
          </div>
        ) : (
          <Table head={["Артикул", "Склад", "Доля", "Всего"]}>
            {(data.skewAlerts || []).map((a) => (
              <tr key={a.nm_id} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                <Td>{a.nm_id}</Td>
                <Td>{a.warehouse}</Td>
                <Td right><strong style={{ color: a.share_pct > 90 ? C.neg : C.accent2 }}>{pct(a.share_pct)}</strong></Td>
                <Td right>{num(a.qty)} / {num(a.total)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

// ===================== Вкладка «Рекомендации» =====================
function RecommendTab(props) {
  const {
    data, q, setQ, demandWindow, setDemandWindow, excessDays, setExcessDays,
    deficitDays, setDeficitDays, targetCover, setTargetCover, reload, flash,
  } = props;
  const recs = data.recommendations || [];
  const [checked, setChecked] = useState({});
  // После перезагрузки/смены данных — сбрасываем отметки (ключи могли измениться).
  useEffect(() => setChecked({}), [data]);
  const keyOf = (r) => `${r.nm_id}|${r.from_warehouse}|${r.to_warehouse}`;
  const checkedList = recs.filter((r) => checked[keyOf(r)]);
  const toggleAll = () => {
    const all = checkedList.length === recs.length && recs.length > 0;
    const next = {};
    if (!all) recs.forEach((r) => { next[keyOf(r)] = true; });
    setChecked(next);
  };
  const applyChecked = async () => {
    let ok = 0;
    let lastErr = "";
    for (const r of checkedList) {
      const res = await fetch(`/api/cabinets/${cabinetId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nm_id: r.nm_id, from_warehouse: r.from_warehouse, to_warehouse: r.to_warehouse,
          qty: r.qty, note: `[auto-realloc] ${r.reason}`, source: "auto",
        }),
      });
      if (res.ok) ok++;
      else lastErr = (await res.json().catch(() => ({})))?.error || "";
    }
    setChecked({});
    if (ok > 0) {
      flash(`✓ Создано заявок: ${ok}. Подайте их в кабинете WB и откройте «Мои заявки».`);
    } else {
      flash(`⚠ Не удалось создать заявки${lastErr ? ": " + lastErr : ""}`);
    }
  };

  return (
    <div>
      {/* Параметры расчёта */}
      <Card title="⚙️ Параметры рекомендаций" hint="как считаем избыток/дефицит">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <NumField label="Окно спроса, дней" value={demandWindow} onChange={setDemandWindow} min={3} max={90} />
          <NumField label="Избыток, если остаток > дней" value={excessDays} onChange={setExcessDays} min={3} max={90} />
          <NumField label="Дефицит, если остаток < дней" value={deficitDays} onChange={setDeficitDays} min={1} max={30} />
          <NumField label="Целевое покрытие, дней" value={targetCover} onChange={setTargetCover} min={3} max={60} />
          <button onClick={reload} style={btnAccent}>Пересчитать</button>
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="поиск по артикулу/имени…"
            style={{ ...inputStyle, minWidth: 200, flex: 1 }}
          />
        </div>
        <div style={{ fontSize: 11, color: C.faint, marginTop: 10, lineHeight: 1.5 }}>
          <strong>Логика:</strong> для каждого артикула считаем средние продажи/день по складу за
          окно спроса → <code>days_cover = остаток ÷ скорость</code>. Если на складе-источнике
          cover &gt; {excessDays} дн (избыток), а на складе-приёмнике &lt; {deficitDays} дн
          (дефицит) и есть спрос → рекомендуем переместить столько, чтобы покрыть {targetCover} дн
          на приёмнике. Кол-во ограничено доступным избытком источника.
        </div>
      </Card>

      {/* KPI */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, marginTop: 14, flexWrap: "wrap" }}>
        <Kpi label="Рекомендаций" value={String(recs.length)} color={recs.length ? C.accent : C.faint} />
        <Kpi label="Отмечено" value={String(checkedList.length)} color={C.accent2} />
        <Kpi label="Σ к перемещению (отмеч.)" value={String(checkedList.reduce((s, r) => s + r.qty, 0))} />
        <Kpi label="Уникальных артикулов" value={String(new Set(recs.map((r) => r.nm_id)).size)} />
      </div>

      {recs.length === 0 ? (
        <Centered>Нет активных рекомендаций — остатки сбалансированы при текущих порогах.</Centered>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <label style={{ fontSize: 12, color: C.muted, display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={checkedList.length === recs.length && recs.length > 0} onChange={toggleAll} />
              выбрать все ({recs.length})
            </label>
            <button onClick={applyChecked} disabled={checkedList.length === 0} style={{ ...btnAccent, opacity: checkedList.length ? 1 : 0.5 }}>
              Создать заявки ({checkedList.length})
            </button>
          </div>
          <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 1000 }}>
              <thead style={{ background: C.surfaceAlt }}>
                <tr>
                  <Th></Th>
                  <Th left>Артикул</Th>
                  <Th left>Маршрут</Th>
                  <Th right>Кол-во</Th>
                  <Th right>Cover на «куда»</Th>
                  <Th right>Спрос окна</Th>
                  <Th left>Обоснование</Th>
                </tr>
              </thead>
              <tbody>
                {recs.map((r) => {
                  const k = keyOf(r);
                  const cov = r.to_days_cover;
                  const covAfter = r.to_days_cover_after;
                  const covColor = cov == null ? C.faint : cov < deficitDays / 2 ? C.neg : cov < deficitDays ? "#FFA000" : C.accent2;
                  return (
                    <tr key={k} style={{ borderBottom: `1px solid ${soft("line", 20)}`, opacity: checked[k] ? 0.7 : 1 }}>
                      <td style={{ padding: "6px 8px" }}>
                        <input type="checkbox" checked={!!checked[k]} onChange={() => setChecked((c) => ({ ...c, [k]: !c[k] }))} />
                      </td>
                      <Td>
                        <Thumb url={r.im_url} />
                        <div style={{ display: "inline-block", verticalAlign: "middle", marginLeft: 6, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <strong>{r.nm_id}</strong>
                          <div style={{ fontSize: 10, color: C.faint }}>{r.name}</div>
                        </div>
                      </Td>
                      <Td>
                        <div style={{ fontSize: 11 }}>
                          <strong style={{ color: C.accent2 }}>{r.from_warehouse}</strong>
                          <span style={{ color: C.faint, margin: "0 4px" }}>→</span>
                          <strong style={{ color: C.accent }}>{r.to_warehouse}</strong>
                        </div>
                      </Td>
                      <Td right><strong style={{ color: C.neg }}>{num(r.qty)}</strong> шт</Td>
                      <Td right>
                        <strong style={{ color: covColor }}>{fmtCover(cov)}</strong>
                        <span style={{ color: C.faint }}> → </span>
                        <strong style={{ color: C.pos }}>{fmtCover(covAfter)}</strong>
                      </Td>
                      <Td right style={{ fontSize: 11, color: C.muted }}>{r.from_orders}→{r.to_orders}</Td>
                      <Td style={{ fontSize: 10, color: C.faint, lineHeight: 1.4, maxWidth: 320 }}>{r.reason}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: C.faint, marginTop: 10 }}>
            «Cover на "куда"»: дней покрытия до/после перемещения. Спрос окна: заказов с
            источника → на приёмник за окно {demandWindow} дн.
          </div>
        </>
      )}
    </div>
  );
}

// ===================== Вкладка «Мои заявки» =====================
const STATUS_META = {
  draft: { label: "Черновик", color: C.faint, icon: "📝" },
  requested: { label: "Запрошено", color: C.accent, icon: "📤" },
  in_transit: { label: "В пути", color: C.accent2, icon: "🚚" },
  delivered: { label: "Доставлено", color: C.pos, icon: "✓" },
  cancelled: { label: "Отменено", color: C.neg, icon: "✕" },
};

function RequestsTab({ requests, flash, reload }) {
  const [adding, setAdding] = useState(false);
  const list = requests || [];
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: C.muted }}>
          Всего заявок: <strong>{list.length}</strong>
          {" · "}активных: <strong>{list.filter((r) => r.status !== "delivered" && r.status !== "cancelled").length}</strong>
        </div>
        <button onClick={() => setAdding(true)} style={btnAccent}>+ Новая заявка</button>
      </div>

      <div style={{ ...ALERT.info, borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 12, lineHeight: 1.5 }}>
        <strong>Workflow:</strong> Создайте заявку в кабинете WB («Перераспределить остатки») →
        нажмите «+ Новая заявка» и зафиксируйте её здесь. По мере прохождения меняйте статус.
        Значок 🟢 «доставлено?» — автоподсказка: на складе-приёмнике прибыло ≥ кол-ва заявки
        (по снимкам daily_stock). Кнопка применит статус «Доставлено».
      </div>

      {list.length === 0 ? (
        <Centered>Заявок пока нет. Создайте первую кнопкой «+ Новая заявка».</Centered>
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 980 }}>
            <thead style={{ background: C.surfaceAlt }}>
              <tr>
                <Th left>Создана</Th>
                <Th left>Артикул</Th>
                <Th left>Маршрут</Th>
                <Th right>Кол-во</Th>
                <Th left>Статус</Th>
                <Th left>Заявка подана</Th>
                <Th left>Заметка</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const sm = STATUS_META[r.status] || STATUS_META.draft;
                return (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
                    <Td style={{ fontSize: 11, color: C.faint }}>{fmtFull(r.created_at)} {new Date(r.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</Td>
                    <Td>
                      <Thumb url={r.im_url} />
                      <span style={{ marginLeft: 6, verticalAlign: "middle" }}>
                        <strong>{r.nm_id}</strong>
                        <div style={{ fontSize: 10, color: C.faint, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                      </span>
                    </Td>
                    <Td style={{ fontSize: 11 }}>
                      <strong style={{ color: C.accent2 }}>{r.from_warehouse}</strong>
                      <span style={{ color: C.faint, margin: "0 4px" }}>→</span>
                      <strong style={{ color: C.accent }}>{r.to_warehouse}</strong>
                    </Td>
                    <Td right><strong>{num(r.qty)}</strong> шт</Td>
                    <Td>
                      <select
                        value={r.status}
                        onChange={(e) => patchStatus(r.id, e.target.value, null, flash, reload)}
                        style={{ ...selectStyle, fontSize: 11, padding: "4px 22px 4px 8px", color: sm.color, fontWeight: 600 }}
                      >
                        {Object.entries(STATUS_META).map(([v, m]) => (
                          <option key={v} value={v}>{m.icon} {m.label}</option>
                        ))}
                      </select>
                      {r.deliver_suggested && r.status !== "delivered" && (
                        <button
                          onClick={() => patchStatus(r.id, "delivered", null, flash, reload)}
                          title="Склад-приёмник принял ≥ кол-ва заявки (по снимкам)"
                          style={{ ...miniBtn, marginLeft: 4, color: C.pos, border: `1px solid ${soft("pos", 33)}` }}
                        >🟢 доставлено?</button>
                      )}
                    </Td>
                    <Td style={{ fontSize: 11, color: C.muted }}>{r.requested_at ? fmtFull(r.requested_at) : "—"}</Td>
                    <Td style={{ fontSize: 10, color: C.faint, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.note || "—"}</Td>
                    <td style={{ padding: "4px 6px" }}>
                      <button
                        onClick={() => { if (confirm(`Отменить заявку #${r.id}?`)) deleteRequest(r.id, flash, reload); }}
                        title="Отменить заявку"
                        style={miniBtn}
                      >✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && <AddModal onClose={() => setAdding(false)} flash={flash} reload={reload} />}
    </div>
  );
}

// ===================== Модал «Новая заявка» =====================
function AddModal({ onClose, flash, reload }) {
  const [nm_id, setNmId] = useState("");
  const [fromW, setFromW] = useState("");
  const [toW, setToW] = useState("");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");

  const submit = async () => {
    const res = await fetch(`/api/cabinets/${cabinetId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nm_id: Number(nm_id), from_warehouse: fromW, to_warehouse: toW,
        qty: Number(qty), note: note || null,
      }),
    });
    const j = await res.json();
    if (res.ok && j.ok) {
      flash(`✓ Заявка #${j.id} создана (статус «Запрошено»).`);
      onClose();
      reload();
    } else {
      flash(`⚠ ${j.error || "Не удалось создать заявку"}`);
    }
  };

  const valid = nm_id && fromW && toW && Number(qty) > 0 && fromW !== toW;
  return (
    <div style={modalOverlay} onClick={onClose}>
      <div style={modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Новая заявка на перемещение</h2>
          <button onClick={onClose} style={miniBtn}>✕</button>
        </div>
        <div style={{ ...ALERT.info, borderRadius: 8, padding: "8px 12px", marginBottom: 14, fontSize: 11, lineHeight: 1.5 }}>
          Сначала подайте заявку в кабинете WB («Отчёт по остаткам» → «Перераспределить остатки»),
          затем зафиксируйте её здесь. Дашборд будет следить за доставкой по снимкам остатков.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <ModalField label="Артикул WB (nm_id)">
            <input value={nm_id} onChange={(e) => setNmId(e.target.value.replace(/\D/g, ""))} placeholder="напр. 977847925" style={{ ...inputStyle, width: "100%" }} />
          </ModalField>
          <div style={{ display: "flex", gap: 10 }}>
            <ModalField label="Со склада (источник)">
              <input value={fromW} onChange={(e) => setFromW(e.target.value)} placeholder="напр. Электросталь" style={{ ...inputStyle, width: "100%" }} />
            </ModalField>
            <ModalField label="На склад (приёмник)">
              <input value={toW} onChange={(e) => setToW(e.target.value)} placeholder="напр. Коледино" style={{ ...inputStyle, width: "100%" }} />
            </ModalField>
          </div>
          <ModalField label="Количество, шт">
            <input value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} type="number" min="1" style={{ ...inputStyle, width: 120 }} />
          </ModalField>
          <ModalField label="Заметка (необязательно)">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="напр. слот пойман 03.07 14:20" style={{ ...inputStyle, width: "100%" }} />
          </ModalField>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnGhost}>Отмена</button>
          <button onClick={submit} disabled={!valid} style={{ ...btnAccent, opacity: valid ? 1 : 0.5 }}>Создать заявку</button>
        </div>
      </div>
    </div>
  );
}

// ===================== API helpers =====================
async function patchStatus(id, status, note, flash, reload) {
  const res = await fetch(`/api/cabinets/${cabinetId}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, status, note }),
  });
  const j = await res.json();
  if (res.ok && j.ok) {
    flash(`✓ Статус заявки #${id} → ${STATUS_META[status]?.label || status}.`);
    reload();
  } else {
    flash(`⚠ ${j.error || "Не удалось сменить статус"}`);
  }
}

async function deleteRequest(id, flash, reload) {
  const res = await fetch(`/api/cabinets/${cabinetId}/move?id=${id}`, { method: "DELETE" });
  const j = await res.json();
  if (res.ok && j.ok) {
    flash(`✓ Заявка #${id} отменена.`);
    reload();
  } else {
    flash(`⚠ ${j.error || "Не удалось отменить"}`);
  }
}

// ===================== UI primitives =====================
const btnAccent = {
  padding: "8px 16px", borderRadius: 9, cursor: "pointer", fontSize: 13, fontWeight: 600,
  border: "none", background: C.accent, color: "var(--accentInk)", fontFamily: "inherit",
};
const btnGhost = {
  padding: "8px 16px", borderRadius: 9, cursor: "pointer", fontSize: 13, fontWeight: 600,
  border: `1px solid ${C.line}`, background: "transparent", color: C.muted, fontFamily: "inherit",
};
const miniBtn = {
  padding: "3px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600,
  border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.muted, fontFamily: "inherit",
};
const modalOverlay = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid",
  placeItems: "center", zIndex: 50, backdropFilter: "blur(2px)",
};
const modalBox = {
  background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16,
  padding: 24, width: "min(560px, 92vw)", maxHeight: "90vh", overflowY: "auto",
};

function Card({ title, hint, children }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 16, padding: "16px 16px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.ink }}>{title}</h3>
        {hint && <span style={{ fontSize: 11, color: C.faint }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}
function Kpi({ label, value, sub, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || C.ink, lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.muted, marginTop: 2, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>}
    </div>
  );
}
function Tab({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      border: "none", background: "transparent", cursor: "pointer", padding: "10px 16px",
      fontSize: 14, fontWeight: 600, color: active ? C.accent : C.muted,
      borderBottom: active ? `2px solid ${C.accent}` : "2px solid transparent", marginBottom: -1,
    }}>
      {children}
    </button>
  );
}
function Table({ head, children }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>{head.map((h, i) => <th key={i} style={i === 0 ? thLeft : thRight}>{h}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
const thLeft = { padding: "6px 8px", textAlign: "left", fontWeight: 600, color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 };
const thRight = { ...thLeft, textAlign: "right" };
function Td({ right, style, children }) {
  return <td style={{ padding: "6px 8px", textAlign: right ? "right" : "left", color: C.ink, ...style }}>{children}</td>;
}
function Th({ left, children }) {
  return <th style={left ? thLeft : thRight}>{children}</th>;
}
function NumField({ label, value, onChange, min, max }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</span>
      <input type="number" value={value} min={min} max={max} onChange={(e) => onChange(Number(e.target.value) || 0)} style={{ ...inputStyle, width: 90 }} />
    </label>
  );
}
function ModalField({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
      <span style={{ fontSize: 10, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}
function Thumb({ url }) {
  if (!url) {
    return (
      <span style={{ display: "inline-block", width: 28, height: 28, borderRadius: 5, background: C.surfaceAlt, border: `1px solid ${C.line}`, textAlign: "center", lineHeight: "26px", fontSize: 13, verticalAlign: "middle" }}>🖼</span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url} alt="" loading="lazy"
      style={{ width: 28, height: 28, borderRadius: 5, objectFit: "cover", border: `1px solid ${C.line}`, verticalAlign: "middle", background: C.surfaceAlt }}
    />
  );
}
function Centered({ children }) {
  return (
    <div style={{ minHeight: "30vh", display: "grid", placeItems: "center", color: C.muted, padding: 30, textAlign: "center", fontSize: 13 }}>
      {children}
    </div>
  );
}
