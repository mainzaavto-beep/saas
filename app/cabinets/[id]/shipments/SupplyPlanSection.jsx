"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useState, useCallback, useMemo } from "react";

// SupplyPlanSection — «Рекомендации» на странице /shipments (спека «Склады 2.0» §4.1).
//
// Источник: GET /api/cabinets/[id]/supply-plan?platform=all|wb|ozon →
//   { settings:{targetDays,minDays}, groups[], uncovered[], generatedAt }.
// groups[]: { locationId, locationName, platform, warehouseKey, warehouseName, lines[] }
//   lines[]: { itemId, itemName, need, qty, velocity, coverageDays, available, positions[] }
// uncovered[]: { itemId, warehouseKey, qty } — без имён (ищем по groups).
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

export function SupplyPlanSection({ cabinetId, canManage, onDocCreated }) {
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

  // Имя товара по itemId — ищем среди строк всех групп (uncovered имён не несёт).
  const itemNameById = useMemo(() => {
    const m = {};
    for (const g of groups) for (const ln of g.lines) m[ln.itemId] = ln.itemName;
    return m;
  }, [groups]);
  // Имя склада по (platform, warehouseKey) — для строки «не покрыто».
  const whNameByKey = useMemo(() => {
    const m = {};
    for (const g of groups) m[`${g.platform}:${g.warehouseKey}`] = g.warehouseName;
    return m;
  }, [groups]);

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

      {data && groups.length === 0 && (
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
              onCreated={() => { reload(); onDocCreated?.(); }}
            />
          ))}
        </div>
      )}

      {uncovered.length > 0 && (
        <div style={{ ...calloutStyle, background: soft("warn", 12), border: `1px solid ${soft("warn", 35)}`, color: C.warn, marginTop: 12 }}>
          <strong>Не покрыто на ФФ ({uncovered.length}):</strong>
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
            {uncovered.map((u, i) => {
              const platform = String(u.itemId).startsWith("ozon:") ? "ozon" : "wb";
              const whName = whNameByKey[`${platform}:${u.warehouseKey}`] || u.warehouseKey;
              return (
                <div key={i} style={{ fontSize: 12 }}>
                  {itemNameById[u.itemId] || u.itemId} · склад «{whName}» · не хватает {num(u.qty)} шт
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanGroupCard({ group, cabinetId, canManage, onCreated }) {
  const [busy, setBusy] = useState(false);
  const totalQty = group.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);

  async function createDraft() {
    const lines = group.lines
      .flatMap((ln) => ln.positions || [])
      .filter((p) => Number(p.qty) > 0)
      .map((p) => ({ ff_inventory_id: p.ffInventoryId, qty: p.qty }));
    if (lines.length === 0) { alert("В группе нет позиций ФФ для отгрузки"); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/supply-plan`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_doc",
          locationId: group.locationId,
          platform: group.platform,
          warehouseKey: group.warehouseKey,
          warehouseName: group.warehouseName,
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
const calloutStyle = { padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, background: C.surfaceAlt, border: `1px solid ${C.line}`, color: C.muted };
