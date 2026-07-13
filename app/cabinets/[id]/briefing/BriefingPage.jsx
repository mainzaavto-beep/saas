"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
const C = {
  bg: "#0b1220", surface: "#131c2e", surfaceAlt: "#1a2540", ink: "#e8edf7",
  muted: "#8a99b8", faint: "#6b7a8f", line: "#243049", accent: "#4f8cff",
  accent2: "#2bd4a0", pos: "#4ade80", neg: "#ff6b6b", pink: "#f97316",
  blue: "#4f8cff",
};

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽";
const num = (v) =>
  v == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(v);
const pct = (v) =>
  v == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(v) + "%";

// Переключатель маркетплейса (как на /reviews).
const MPS = [
  { id: "all", label: "Все" },
  { id: "wb", label: "Wildberries" },
  { id: "ozon", label: "Ozon" },
];

export default function BriefingPage() {
  const [brief, setBrief] = useState(null);
  const [mp, setMp] = useState("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/cabinets/${cabinetId}/briefings`)
      .then((r) => r.json())
      .then((d) => { setBrief(d.briefing || null); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Centered>Загрузка брифинга…</Centered>;
  if (!brief) return (
    <Centered>
      <div>Брифинг пока не собран.</div>
      <div style={{ marginTop: 8, fontSize: 13, color: C.faint }}>
        Он формируется задачей «Morning Briefing» в 08:00. Можно запустить вручную:
        <code style={{ background: C.surfaceAlt, padding: "2px 6px", borderRadius: 6, marginLeft: 8 }}>
          python scripts\morning_brief.py
        </code>
      </div>
    </Centered>
  );

  const agents = (brief.agents || []).filter((a) => a.status === "ok");
  const byKey = Object.fromEntries(agents.map((a) => [a.key, a]));
  const shown = agents.filter((a) => mp === "all" || a.key === mp);

  return (
    <main style={{ maxWidth: 1340, margin: "0 auto", padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      {/* Шапка */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>
          {brief.mode === "weekly" ? "📅 Еженедельный отчёт" : "☀️ Утренний брифинг"}
        </h1>
        <span style={{ fontSize: 13, color: C.muted }}>за {brief.report_date}</span>
        {brief.status === "partial" && (
          <span style={{ fontSize: 11, color: "#d97706", background: "rgba(245,158,11,0.10)", padding: "2px 8px", borderRadius: 6 }}>
            часть агентов не отчиталась
          </span>
        )}
        <Link href="/" style={{ marginLeft: "auto", color: C.accent, textDecoration: "none", fontSize: 13, fontWeight: 600 }}>
          ← На главную
        </Link>
      </div>

      {/* Переключатель МП */}
      <div style={{ display: "flex", gap: 4, background: C.surfaceAlt, borderRadius: 10, padding: 3, margin: "16px 0", width: "fit-content" }}>
        {MPS.map((m) => (
          <button key={m.id} onClick={() => setMp(m.id)} style={{
            border: "none", padding: "6px 14px", borderRadius: 8, cursor: "pointer",
            fontFamily: "inherit", fontSize: 13, fontWeight: 600,
            background: mp === m.id ? C.accent : "transparent",
            color: mp === m.id ? "#0A1A1C" : C.muted,
          }}>{m.label}</button>
        ))}
      </div>

      {/* Дайджест */}
      {brief.narrative && (
        <Card>
          <h2 style={h2}>Дайджест</h2>
          <div style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", color: C.ink }}>
            {brief.narrative}
          </div>
        </Card>
      )}

      {/* Секции по агентам */}
      {shown.map((a) => <AgentSections key={a.key} agent={a} />)}
    </main>
  );
}

// ── Секции одного агента ─────────────────────────────────────────────────
function AgentSections({ agent }) {
  const r = agent.report || {};
  const isFin = agent.key === "fin";
  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ ...h2, fontSize: 18, borderBottom: `1px solid ${C.line}`, paddingBottom: 8 }}>
        {agent.name}
        {r.active_count != null && (
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 500, marginLeft: 10 }}>
            активных товаров: {r.active_count}
          </span>
        )}
      </h2>

      {isFin ? <FinSections r={r} /> : <MpSections agent={agent} r={r} />}
    </div>
  );
}

// ── Секции маркетплейса (план/факт, вчера, остатки, ДРР, отзывы, ...) ────
function MpSections({ agent, r }) {
  const y = r.yesterday || {};
  const drr = r.drr || {};
  const pf = r.plan_fact || {};
  const loc = r.localization || {};
  const fines = r.fines_deductions || {};
  const supply = r.supply || {};
  return (
    <>
      {/* Вчера: продажи/прибыль */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 14 }}>
        <Kpi label="Продажи за вчера" value={money(y.revenue)} accent />
        <Kpi label="Заказов за вчера" value={y.qty != null ? `${y.qty} шт` : "—"} />
        <Kpi label="Прибыль за вчера" value={money(y.profit)} pos={y.profit >= 0} />
        <Kpi label="ДРР за 7 дней" value={pct(drr.d7)} pos={drr.d7 == null || drr.d7 < 25} />
        <Kpi label="ДРР за вчера" value={pct(drr.yesterday)} pos={drr.yesterday == null || drr.yesterday < 25} />
      </div>

      {/* Еженедельная агрегация (режим weekly) */}
      {r.week && (
        <Card>
          <h2 style={h2}>📊 За неделю</h2>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 14 }}>
            <span>Продажи: <b>{money(r.week.revenue)}</b></span>
            <span>Прибыль: <b style={{ color: (r.week.profit || 0) >= 0 ? C.pos : C.neg }}>{money(r.week.profit)}</b></span>
            <span>Маржа: <b>{pct(r.week.margin_pct)}</b></span>
            <span>Заказов: <b>{r.week.qty} шт</b></span>
          </div>
        </Card>
      )}

      {/* План/факт */}
      <Card>
        <CardTitle icon="🎯" title="План / факт" hint={pf.under?.length || pf.over?.length ? "требует внимания" : ""} />
        {pf.under?.length > 0 && (
          <Block title="🔴 Недовыполнение" color={C.neg}>
            {pf.under.map((it, i) => (
              <div key={i}>{it.sku}: отклонение {num(it.deviation_pct)}%</div>
            ))}
          </Block>
        )}
        {pf.over?.length > 0 && (
          <Block title="🟢 Перевыполнение >30%" color={C.pos}>
            {pf.over.map((it, i) => (
              <div key={i}>{it.sku}: +{num(it.deviation_pct)}%</div>
            ))}
          </Block>
        )}
        {(!pf.under?.length && !pf.over?.length) && <Empty>План выполняется, отклонений нет (или план не задан).</Empty>}
      </Card>

      {/* Остатки <10 дней */}
      <Card>
        <CardTitle icon="📦" title="Остатки менее 10 дней" hint={`${r.low_stock?.length || 0} артикулов`} />
        {(r.low_stock?.length || 0) === 0 ? (
          <Empty>Нет критичных остатков 🎉</Empty>
        ) : (
          <Table head={["Артикул", "Остаток", "Дней до OOS"]}>
            {r.low_stock.map((ls, i) => (
              <tr key={i}>
                <Td>{ls.sku}</Td>
                <Td right>{ls.qty != null ? `${ls.qty} шт` : "—"}</Td>
                <Td right style={{ color: ls.days_to_oos <= 5 ? C.neg : C.accent2 }}>
                  {num(ls.days_to_oos)}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* Отзывы <3★ */}
      {agent.key === "wb" && (
        <Card>
          <CardTitle icon="⭐" title="Отзывы ниже 3★ (за 7 дней)" hint={`${r.low_reviews?.length || 0} шт`} />
          {(r.low_reviews?.length || 0) === 0 ? (
            <Empty>Нет негативных отзывов 🎉</Empty>
          ) : (
            r.low_reviews.map((lr, i) => (
              <div key={i} style={{ background: C.surfaceAlt, borderRadius: 8, padding: "8px 11px", marginTop: 6 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 4 }}>
                  <span style={{ color: C.neg, fontWeight: 700 }}>{"★".repeat(lr.rating)}{"☆".repeat(5 - lr.rating)}</span>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{lr.sku}</span>
                  <span style={{ fontSize: 11, color: C.faint, marginLeft: "auto" }}>{lr.date}</span>
                </div>
                {lr.text && <div style={{ fontSize: 13, color: C.muted }}>{lr.text}</div>}
              </div>
            ))
          )}
        </Card>
      )}

      {/* Аномалии конверсий */}
      {r.conv_anomaly?.length > 0 && (
        <Card>
          <CardTitle icon="📉" title="Аномалии конверсий (CR упал >30%)" hint={`${r.conv_anomaly.length} артикулов`} />
          <Table head={["Артикул", "CR вчера", "CR 7дн средн.", "Падение"]}>
            {r.conv_anomaly.map((c, i) => (
              <tr key={i}>
                <Td>{c.sku}</Td>
                <Td right>{pct(c.cr_yesterday)}</Td>
                <Td right>{pct(c.cr_7d_avg)}</Td>
                <Td right style={{ color: C.neg }}>−{num(c.drop_pct)}%</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {/* Поставки */}
      <Card>
        <CardTitle icon="🚚" title="Поставки" hint={`${supply.in_transit?.length || 0} в пути · ${supply.arrived?.length || 0} прибыли`} />
        {(supply.delivery_fines?.length || 0) > 0 ? (
          <Block title="⚠️ Штрафы за недовоз" color={C.neg}>
            {supply.delivery_fines.map((f, i) => (
              <div key={i}>{f.description}: {money(f.amount)}</div>
            ))}
          </Block>
        ) : (
          (supply.in_transit?.length || 0) > 0
            ? <div style={{ fontSize: 13, color: C.muted }}>
                {supply.in_transit.length} партий в пути (статусы:{" "}
                {[...new Set(supply.in_transit.map((s) => s.status))].join(", ")}).
              </div>
            : <Empty>Нет активных поставок.</Empty>
        )}
      </Card>

      {/* Индекс локализации */}
      {loc.by_warehouse && (
        <Card>
          <CardTitle icon="🗺️" title="Индекс локализации (склады/регионы)" hint={loc.note || `топ-склад: ${pct(loc.top_share_pct)}${loc.as_of ? ` · на ${loc.as_of}` : ""}`} />
          {loc.note ? (
            <div style={{ fontSize: 13, color: C.muted }}>{loc.note}</div>
          ) : (
            <Table head={["Склад", "Остаток", "Доля"]}>
              {loc.by_warehouse.map((w, i) => (
                <tr key={i}>
                  <Td>{w.warehouse}</Td>
                  <Td right>{num(w.qty)} шт</Td>
                  <Td right>{pct(w.share_pct)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {/* Штрафы/вычеты */}
      {fines.cabinet && Object.keys(fines.cabinet).length > 0 && (
        <Card>
          <CardTitle icon="💸" title="Штрафы, вычеты, удержания" />
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 14 }}>
            {Object.entries(fines.cabinet).map(([k, v]) => (
              <span key={k}>{labelCost(k)}: <b style={{ color: v < 0 ? C.pos : C.ink }}>{money(v)}</b></span>
            ))}
            {fines.per_sku_total > 0 && (
              <span>Штрафы по SKU: <b style={{ color: C.neg }}>{money(fines.per_sku_total)}</b></span>
            )}
          </div>
        </Card>
      )}
    </>
  );
}

// ── Секции финансиста ────────────────────────────────────────────────────
function FinSections({ r }) {
  const pnl = r.pnl || {};
  const m = r.metrics || {};
  const cf = r.cashflow || {};
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 14 }}>
        <Kpi label="Выручка (мес.)" value={money(pnl.revenue)} accent />
        <Kpi label="Валовая прибыль" value={money(pnl.gross_profit)} pos={(pnl.gross_profit || 0) >= 0} />
        <Kpi label="Чистая прибыль" value={money(pnl.net_profit)} pos={(pnl.net_profit || 0) >= 0} />
        <Kpi label="Маржа" value={pct(m.margin_pct)} pos={(m.margin_pct || 0) >= 10} />
        <Kpi label="ДРР" value={pct(m.drr_pct)} pos={(m.drr_pct || 0) < 25} />
      </div>

      <Card>
        <CardTitle
          icon={cf.has_gap ? "🚨" : "✅"}
          title="Кассовый разрыв"
          hint={cf.has_gap ? `с ${cf.first_gap_date}` : "не прогнозируется"}
        />
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 14 }}>
          <span>Баланс на начало: <b>{money(cf.starting_balance)}</b></span>
          <span>Баланс на конец: <b style={{ color: (cf.end_balance || 0) < 0 ? C.neg : C.pos }}>{money(cf.end_balance)}</b></span>
        </div>
        {cf.has_gap && (
          <div style={{ marginTop: 8, fontSize: 13, color: C.neg }}>
            ⚠️ Прогнозируется кассовый разрыв начиная с {cf.first_gap_date}. Требует внимания.
          </div>
        )}
      </Card>
    </>
  );
}

// ── Вспомогательные компоненты ───────────────────────────────────────────
const h2 = { margin: "0 0 10px", fontSize: 15, fontWeight: 700, color: C.ink };
function Card({ children }) {
  return <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, marginTop: 14 }}>{children}</div>;
}
function Kpi({ label, value, accent, pos }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: "13px 15px" }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: accent ? C.accent : pos === true ? C.pos : pos === false ? C.neg : C.ink }}>{value}</div>
    </div>
  );
}
function CardTitle({ icon, title, hint }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
      {hint && <span style={{ fontSize: 12, color: C.faint, marginLeft: "auto" }}>{hint}</span>}
    </div>
  );
}
function Block({ title, color, children }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: C.ink }}>{children}</div>
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
  return <td style={{ padding: "6px 8px", borderTop: `1px solid ${C.line}`, fontSize: 13, textAlign: right ? "right" : "left", ...style }}>{children}</td>;
}
const th = (i) => ({ textAlign: i === 0 ? "left" : "right", padding: "0 8px 7px", fontSize: 11, color: C.muted, textTransform: "uppercase" });
function Empty({ children }) {
  return <div style={{ color: C.muted, fontSize: 13, padding: "6px 0" }}>{children}</div>;
}
function Centered({ children }) {
  return <div style={{ minHeight: "50vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, padding: 20, textAlign: "center" }}>{children}</div>;
}

// Человекочитаемые метки cost_type (как в LABELS /pnl).
const COST_LABELS = {
  promotion: "Продвижение", reviews: "Баллы за отзывы", storage: "Хранение",
  deduction: "Удержание", deduction_other: "Прочие удержания",
};
function labelCost(k) { return COST_LABELS[k] || k; }
