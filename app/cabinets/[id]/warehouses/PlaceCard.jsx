"use client";
// app/cabinets/[id]/warehouses/PlaceCard.jsx — карточка одного места (ФФ/склад) во вкладке
// «Места» (задача 6 плана, этап 4 «Витрина»). Контракт места — GET ?tab=places → places[]
// (см. lib/warehousesMetrics.js buildPlaceCards): unbound:true — склад продавца без места
// (id:null, только имя/площадка), обычная карточка — полный набор метрик+проблем.
//
// PlaceCard рисует ТОЛЬКО настоящее место (unbound:false). Непривязанные склады продавца
// раньше шли такими же карточками — у кабинета с десятком складов МП сетка тонула в красных
// пустышках без единой метрики. Теперь они собраны в одну сводную UnboundWarehousesCard
// (ниже), группировка — в UI: buildPlaceCards отдаёт плоский список, как и раньше.
import { C, soft } from "@/lib/palette.js";

const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const money = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽");
const fmtCoverage = (c) => (c == null ? "—" : `${Math.round(c)} дн`);
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("ru-RU") : "—");

const GAP_REASON = { no_location: "нет места для склада", no_item: "нет позиции с артикулом", insufficient: "не хватило остатка" };

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 8 };
const pill = (token) => ({ display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700, background: soft(token, 15), color: C[token] || C.ink });
const btn = { padding: "5px 10px", borderRadius: 7, fontSize: 12, cursor: "pointer", background: C.surfaceAlt, color: C.ink, border: `1px solid ${C.line}` };
const metricBox = { display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12 };
const metricLabel = { color: C.faint, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.3 };

function Metric({ label, value, danger }) {
  return (
    <div>
      <div style={metricLabel}>{label}</div>
      <div style={{ fontWeight: 600, color: danger ? C.neg : C.ink }}>{value}</div>
    </div>
  );
}

function Problems({ problems }) {
  const { discrepancies = [], gaps = [], low = [] } = problems || {};
  const empty = discrepancies.length === 0 && gaps.length === 0 && low.length === 0;
  return (
    <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 4 }}>Проблемы</div>
      {empty && <div style={{ fontSize: 12, color: C.pos }}>Проблем нет</div>}
      {discrepancies.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          {discrepancies.map((d, i) => (
            <div key={i} style={{ fontSize: 12, color: C.warn }}>
              ⚠️ {d.name} ({d.platform === "wb" ? "WB" : "Ozon"}): свой {num(d.own)}, на МП {num(d.present)}, Δ {d.delta > 0 ? `+${d.delta}` : d.delta}
            </div>
          ))}
        </div>
      )}
      {gaps.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          {gaps.map((g) => (
            <div key={g.id} style={{ fontSize: 12, color: C.neg }}>
              🔴 не разнесено: {GAP_REASON[g.reason] || g.reason} · {g.qty} шт · {g.src_ref || "—"} · {fmtDate(g.first_seen_at)}
            </div>
          ))}
        </div>
      )}
      {low.length > 0 && (
        <div>
          {low.map((l, i) => (
            <div key={i} style={{ fontSize: 12, color: C.warn }}>
              ⏳ {l.name}: покрытие {fmtCoverage(l.coverage)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Сводная карточка непривязанных складов продавца: одна на все, красная рамка, список
// «площадка · имя · тип» и ОДНА кнопка «Привязать» (раскрывает «⚙ Настройки мест»).
// kind берём из sellerWarehouses ответа (в place его нет — buildPlaceCards не меняли).
export function UnboundWarehousesCard({ items, canManage, onBind }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ ...card, borderColor: C.neg, gridColumn: "1 / -1" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ fontWeight: 700 }}>Склады продавца без места ({items.length})</div>
        <span style={pill("neg")}>не привязаны</span>
      </div>
      <div style={{ fontSize: 12, color: C.muted }}>
        Пока склад не привязан к месту, его FBS-остатки и списания не попадают в учёт.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {items.map((w) => (
          <div key={`${w.platform}:${w.warehouse_id}`} style={{ fontSize: 12, color: C.neg }}>
            {w.platform === "wb" ? "WB" : "Ozon"} · {w.name} · {w.kind || "—"}
          </div>
        ))}
      </div>
      {canManage && (
        <button onClick={onBind} style={{ ...btn, alignSelf: "flex-start" }}>Привязать</button>
      )}
    </div>
  );
}

export function PlaceCard({ place, minDays, canManage, onTransfer, onInventory }) {
  const { name, city, address, is_active, bindings, positions, units, value, velocity, coverage, problems } = place;

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 700 }}>{name}</div>
          <div style={{ fontSize: 11, color: C.faint }}>{[city, address].filter(Boolean).join(", ") || "—"}</div>
        </div>
        <span style={pill(is_active ? "pos" : "muted")}>{is_active ? "активно" : "неактивно"}</span>
      </div>

      <div style={{ fontSize: 12 }}>
        {bindings?.wb ? <span>WB: {bindings.wb.name}</span> : <span style={{ color: C.neg }}>WB: не привязан</span>}
        {" · "}
        {bindings?.ozon ? <span>Ozon: {bindings.ozon.name}</span> : <span style={{ color: C.neg }}>Ozon: не привязан</span>}
      </div>

      <div style={metricBox}>
        <Metric label="Позиций" value={num(positions)} />
        <Metric label="Единиц" value={num(units)} />
        <Metric label="Стоимость" value={money(value)} />
        <Metric label="Скорость" value={`${num(velocity)} шт/дн`} />
        <Metric label="Покрытие" value={fmtCoverage(coverage)} danger={coverage != null && minDays != null && coverage < minDays} />
      </div>

      <Problems problems={problems} />

      {canManage && (
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={onTransfer} style={btn}>Перемещение</button>
          <button onClick={onInventory} style={btn}>Инвентаризация</button>
        </div>
      )}
    </div>
  );
}
