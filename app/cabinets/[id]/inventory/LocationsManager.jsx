"use client";
import { C, soft } from "@/lib/palette.js";
import { useState } from "react";

// =====================================================================
//  Управление местами хранения (создать/переименовать/удалить)
//  Перенесено из InventoryPage.jsx (Склады 2.0, этап 4 «Витрина», задача 4)
//  для переиспользования на будущей странице /warehouses.
// =====================================================================
export function LocationsManager({ cabinetId, locations, reload, sellerWarehouses }) {
  const [name, setName] = useState("");
  const [locType, setLocType] = useState("stock");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);

  async function addLoc() {
    const n = name.trim();
    if (!n) { alert("Введите название места"); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/inventory`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "locations", op: "add", name: n, loc_type: locType, address: address.trim() || null }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "add failed");
      setName(""); setAddress("");
      reload();
    } catch (e) { alert("Не создалось: " + e.message); }
    finally { setBusy(false); }
  }

  async function renameLoc(l) {
    const n = prompt(`Переименовать «${l.name}»`, l.name);
    if (n == null) return;
    const nn = n.trim();
    if (!nn || nn === l.name) return;
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/inventory`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "locations", op: "rename", id: l.id, name: nn }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "rename failed");
      reload();
    } catch (e) { alert("Не переименовать: " + e.message); }
  }

  async function delLoc(l) {
    if (!confirm(`Удалить место «${l.name}»?\nПривязанные товары останутся (отвяжутся от места).`)) return;
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/inventory`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "locations", op: "delete", id: l.id }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "delete failed");
      reload();
    } catch (e) { alert("Не удалить: " + e.message); }
  }

  async function updateLoc(l, patch) {
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/inventory`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "locations", op: "update", id: l.id, ...patch }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "update failed");
      reload();
    } catch (e) { alert("Не сохранилось: " + e.message); }
  }
  const whOptions = (platform, l) => sellerWarehouses
    .filter((w) => w.platform === platform && (w.is_active || w.location_id === l.id))
    .map((w) => (
      <option key={w.warehouse_id} value={w.warehouse_id}
        disabled={w.location_id != null && w.location_id !== l.id}>
        {w.name}{w.location_id != null && w.location_id !== l.id ? " (занят)" : ""}
      </option>
    ));

  return (
    <div style={addFormCard}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Места хранения</div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
        <Field label="Название *">
          <input value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addLoc(); }}
            placeholder="напр. Склад Московский / ФФ OZON" style={{ ...inputStyle, width: 220 }} />
        </Field>
        <Field label="Тип">
          <select value={locType} onChange={(e) => setLocType(e.target.value)} style={{ ...inputStyle, width: "auto" }}>
            <option value="stock">Склад</option>
            <option value="ff">ФФ</option>
          </select>
        </Field>
        <Field label="Адрес (опц.)">
          <input value={address} onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addLoc(); }}
            style={{ ...inputStyle, width: 200 }} />
        </Field>
        <button onClick={addLoc} disabled={busy} style={primaryBtn}>{busy ? "⏳" : "+ Добавить место"}</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {locations.length === 0 && (
          <div style={{ fontSize: 12, color: C.faint }}>Мест пока нет. Создайте хотя бы одно (склад или ФФ).</div>
        )}
        {locations.map((l) => (
          <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: C.surfaceAlt, borderRadius: 7 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 6,
              background: l.loc_type === "ff" ? soft("pink", 12) : soft("pos", 12),
              color: l.loc_type === "ff" ? C.pink : C.pos,
            }}>{l.loc_type === "ff" ? "ФФ" : "СКЛАД"}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{l.name}</span>
            {l.address && <span style={{ fontSize: 11, color: C.faint }}>{l.address}</span>}
            <div style={{ flex: 1 }} />
            <select value={l.wb_warehouse_id ?? ""} onChange={(e) => updateLoc(l, { wb_warehouse_id: e.target.value || null })}
              style={{ ...inputStyle, width: 170, padding: "3px 6px", fontSize: 12 }} title="Склад продавца WB">
              <option value="">WB: не привязан</option>{whOptions("wb", l)}
            </select>
            <select value={l.ozon_warehouse_id ?? ""} onChange={(e) => updateLoc(l, { ozon_warehouse_id: e.target.value || null })}
              style={{ ...inputStyle, width: 170, padding: "3px 6px", fontSize: 12 }} title="Склад продавца Ozon">
              <option value="">Ozon: не привязан</option>{whOptions("ozon", l)}
            </select>
            <input defaultValue={l.city || ""} placeholder="город"
              onBlur={(e) => { if ((e.target.value.trim() || null) !== (l.city || null)) updateLoc(l, { city: e.target.value }); }}
              style={{ ...inputStyle, width: 110, padding: "3px 6px", fontSize: 12 }} />
            <label style={{ fontSize: 11, color: C.muted, display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={l.is_active !== false} onChange={(e) => updateLoc(l, { is_active: e.target.checked })} /> активно
            </label>
            <button onClick={() => renameLoc(l)} style={{ ...miniBtn, color: C.muted }} title="Переименовать">✎</button>
            <button onClick={() => delLoc(l)} style={{ ...miniBtn, color: C.neg }} title="Удалить">🗑</button>
          </div>
        ))}
      </div>
      {sellerWarehouses.some((w) => w.is_active && w.location_id == null) && (
        <div style={{ marginTop: 10, fontSize: 12, color: C.neg }}>
          Не привязаны к месту: {sellerWarehouses.filter((w) => w.is_active && w.location_id == null)
            .map((w) => `${w.platform.toUpperCase()} · ${w.name}`).join(", ")}
        </div>
      )}
    </div>
  );
}

// ---------------- Мелкие компоненты и стили (копия из InventoryPage.jsx) ----------------
function Field({ label, children }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>{label}{children}</label>;
}
const inputStyle = { padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 120 };
const primaryBtn = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600, background: C.accent, color: "var(--accentInk)", border: "none" };
const miniBtn = { padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const addFormCard = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, marginBottom: 14 };
