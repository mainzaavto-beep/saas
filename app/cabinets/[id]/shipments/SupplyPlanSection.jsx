"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useState, useCallback } from "react";

// SupplyPlanSection — «Рекомендации» на странице /shipments (спека «Склады 2.0» §4.1).
//
// Источник: GET /api/cabinets/[id]/supply-plan?platform=all|wb|ozon →
//   { settings:{targetDays,minDays}, groups[], uncovered[], generatedAt }.
// groups[]: { locationId, locationName, platform, warehouseKey, warehouseName, lines[] }
//   lines[]: { itemId, itemName, need, qty, velocity, coverageDays, available, positions[] }
// uncovered[]: { itemId, warehouseKey, qty, itemName, warehouseName, platform } —
//   имена приходят из адаптера (enrichUncovered): строка «не покрыто» бывает и там,
//   где групп нет вовсе, поэтому искать имя по groups нельзя.
//
// wbWarehouses — справочник складов WB (GET /shipments → warehouses.wb), приходит
// пропсом от ShipmentsPage: у WB цель одна на кабинет («WB (все склады)»), а склад
// назначения владелец выбирает прямо в карточке — выбранный id уходит в POST как
// warehouseKey и становится dest_warehouse_id черновика.
//
// Черновик из группы: POST /supply-plan { action:'create_doc', locationId, platform,
//   warehouseKey, warehouseName, lines:[{ff_inventory_id,qty}] } — lines собираем из
//   positions всех строк группы (у каждой строки плана уже есть разбор qty на позиции ФФ).
// После создания — reload себя и просим родителя перезагрузить документы/остатки (onDocCreated).
const num = (v) => v == null || !Number.isFinite(Number(v)) ? "—" : new Intl.NumberFormat("ru-RU").format(v);
const vel = (v) => v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(2).replace(/\.?0+$/, "") || "0";

const PLATFORM_TABS = [
  { v: "all", label: "Все" },
  { v: "wb", label: "WB" },
  { v: "ozon", label: "Ozon" },
];

export function SupplyPlanSection({ cabinetId, canManage, onDocCreated, wbWarehouses = [] }) {
  const [platform, setPlatform] = useState("all");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/cabinets/${cabinetId}/supply-plan?platform=${platform}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cabinetId, platform]);

  useEffect(() => { reload(); }, [reload]);

  const groups = data?.groups || [];
  const uncovered = data?.uncovered || [];
  const settings = data?.settings || null;

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Рекомендации поставок</h2>
          {settings && (
            <p style={{ margin: "2px 0 0", fontSize: 12, color: C.muted }}>
              Цель — {settings.targetDays} дн. запаса, довозим при покрытии ниже {settings.minDays} дн.
              {" "}Пороги — в «⚙️ Настройки».
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {PLATFORM_TABS.map((t) => (
            <button key={t.v} onClick={() => setPlatform(t.v)}
              style={{ ...tabBtn, ...(platform === t.v ? tabBtnActive : null) }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ ...calloutStyle, background: soft("neg", 12), border: `1px solid ${soft("neg", 35)}`, color: C.neg, marginBottom: 10 }}>
          ⚠️ Ошибка рекомендаций: {error}
        </div>
      )}

      {loading && !data && (
        <div style={{ fontSize: 13, color: C.muted, padding: "8px 2px" }}>Загрузка рекомендаций…</div>
      )}

      {data && groups.length === 0 && uncovered.length === 0 && (
        <div style={{ ...calloutStyle }}>
          Все остатки покрывают целевой запас — довозить пока нечего.
        </div>
      )}

      {groups.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {groups.map((g) => (
            <PlanGroupCard
              key={`${g.locationId}-${g.platform}-${g.warehouseKey}`}
              group={g}
              cabinetId={cabinetId}
              canManage={canManage}
              wbWarehouses={wbWarehouses}
              onCreated={() => { reload(); onDocCreated?.(); }}
            />
          ))}
        </div>
      )}

      {uncovered.length > 0 && (
        <div style={{ ...calloutStyle, background: soft("warn", 12), border: `1px solid ${soft("warn", 35)}`, color: C.warn, marginTop: 12 }}>
          <strong>
            {groups.length === 0
              ? `Нечем закрыть с ФФ (${uncovered.length}):`
              : `Не покрыто на ФФ (${uncovered.length}):`}
          </strong>
          {groups.length === 0 && (
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Дефицит на площадке есть, но источников на ФФ план не нашёл: привяжите позиции ФФ
              к местам в «📍 Места» — без этого план не видит, откуда везти.
            </div>
          )}
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
            {uncovered.map((u, i) => (
              <div key={i} style={{ fontSize: 12 }}>
                {u.itemName || u.itemId} · склад «{u.warehouseName || u.warehouseKey}» · не хватает {num(u.qty)} шт
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanGroupCard({ group, cabinetId, canManage, onCreated, wbWarehouses = [] }) {
  const [busy, setBusy] = useState(false);
  // Склад назначения WB: план его не знает (одна цель на кабинет — WB не отдаёт
  // разбивку остатков по складам), поэтому выбираем руками. "" = не выбран.
  const [wbWh, setWbWh] = useState("");
  const isWb = group.platform === "wb";
  const totalQty = group.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);

  async function createDraft() {
    const lines = group.lines
      .flatMap((ln) => ln.positions || [])
      .filter((p) => Number(p.qty) > 0)
      .map((p) => ({ ff_inventory_id: p.ffInventoryId, qty: p.qty }));
    if (lines.length === 0) { alert("В группе нет позиций ФФ для отгрузки"); return; }
    // Выбранный склад WB подменяет ключ/имя цели: роут кладёт числовой warehouseKey
    // в dest_warehouse_id, а warehouseName — в dest_warehouse.
    const picked = isWb && wbWh
      ? (wbWarehouses.find((w) => String(w.id) === String(wbWh)) || null)
      : null;
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/supply-plan`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_doc",
          locationId: group.locationId,
          platform: group.platform,
          warehouseKey: picked ? picked.id : group.warehouseKey,
          warehouseName: picked ? picked.name : group.warehouseName,
          lines,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "create_doc failed");
      onCreated();
    } catch (e) { alert("Не создать черновик: " + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <MpBadge platform={group.platform} />
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          {group.locationName} → {group.warehouseName}
        </span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "right", color: C.muted }}>
            <th style={{ ...thGroup, textAlign: "left" }}>Товар</th>
            <th style={thGroup}>Нужно</th>
            <th style={thGroup}>Везём</th>
            <th style={thGroup}>Есть на ФФ</th>
            <th style={thGroup}>Продаж/дн</th>
            <th style={thGroup}>Покрытие</th>
          </tr>
        </thead>
        <tbody>
          {group.lines.map((ln) => (
            <tr key={ln.itemId} style={{ borderTop: `1px solid ${soft("line", 20)}` }}>
              <td style={{ padding: "4px 6px", textAlign: "left" }}>{ln.itemName || ln.itemId}</td>
              <td style={tdGroup}>{num(ln.need)}</td>
              <td style={{ ...tdGroup, fontWeight: 700, color: C.accent }}>{num(ln.qty)}</td>
              <td style={tdGroup}>{num(ln.available)}</td>
              <td style={tdGroup}>{vel(ln.velocity)}</td>
              <td style={{ ...tdGroup, color: ln.coverageDays == null ? C.faint : C.neg }}>
                {ln.coverageDays == null ? "—" : num(Math.round(ln.coverageDays))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {isWb && canManage && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: C.muted }}>Склад назначения:</span>
          <select value={wbWh} onChange={(e) => setWbWh(e.target.value)} style={whSelect}
            title="WB не отдаёт остатки в разрезе складов — склад поставки выбирается вручную">
            <option value="">— не выбран (WB, все склады) —</option>
            {wbWarehouses.map((w) => (
              <option key={w.id} value={String(w.id)}>{w.name}{w.region ? ` · ${w.region}` : ""}</option>
            ))}
          </select>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
        <span style={{ fontSize: 12, color: C.muted }}>Σ везём: <strong style={{ color: C.ink }}>{num(totalQty)} шт</strong></span>
        {canManage && (
          <button onClick={createDraft} disabled={busy} style={primaryBtnSm}>
            {busy ? "⏳" : "+ Создать черновик"}
          </button>
        )}
      </div>
    </div>
  );
}

function MpBadge({ platform }) {
  const isWb = platform === "wb";
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 6,
      background: isWb ? soft("accent", 15) : soft("pink", 15),
      color: isWb ? C.accent : C.pink,
    }}>{isWb ? "WB" : "OZON"}</span>
  );
}

// ---------------- Стили ----------------
const cardStyle = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, flex: "1 1 340px", minWidth: 300, maxWidth: 460 };
const tabBtn = { padding: "5px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer", background: C.surface, color: C.muted, border: `1px solid ${C.line}` };
const tabBtnActive = { background: soft("accent", 15), color: C.accent, borderColor: soft("accent", 35) };
const primaryBtnSm = { padding: "6px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer", fontWeight: 600, background: C.accent, color: "var(--accentInk)", border: "none" };
const thGroup = { padding: "4px 6px", fontWeight: 600, fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3, textAlign: "right" };
const tdGroup = { padding: "4px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const whSelect = { padding: "3px 6px", borderRadius: 6, fontSize: 11, background: C.bg, color: C.ink, border: `1px solid ${C.line}`, maxWidth: 260 };
const calloutStyle = { padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, background: C.surfaceAlt, border: `1px solid ${C.line}`, color: C.muted };
