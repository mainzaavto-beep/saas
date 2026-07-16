"use client";
import { C } from "@/lib/palette.js";
// /cabinets/[id]/settings — настройки проекта (название, магазины с налогами, API).
import { useEffect, useState } from "react";
import { MP_CONFIG, MAX_SHOPS_PER_CABINET } from "@/lib/mpConfig.js";


const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit" };

export default function SettingsPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [shops, setShops] = useState([]);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    fetch(`/api/cabinets/${cabinetId}/settings`).then(r => r.json()).then(d => d.error ? setError(d.error) : setData(d));
    fetch(`/api/cabinets/${cabinetId}/shops`).then(r => r.json()).then(d => setShops(d.items || []));
  }, [cabinetId]);

  if (error) return <div style={{ padding: 40, color: C.neg, fontFamily: FONT }}>{error}</div>;
  if (!data) return <div style={{ padding: 40, color: C.muted, fontFamily: FONT }}>Загрузка…</div>;

  const save = async () => {
    setMsg(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: data.display_name, mpstats_token: data.mpstats_token }),
    });
    setMsg(r.ok ? "✅ Сохранено" : "❌ Ошибка");
  };

  return (
    <div style={{ width: "100%", maxWidth: 700, margin: 0, padding: "24px 22px", fontFamily: FONT, color: C.ink }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 20px" }}>⚙️ Настройки проекта</h1>

      {/* Общие */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Общие</h2>
        <label style={{ fontSize: 12, color: C.muted }}>Название проекта
          <input value={data.display_name || ""} onChange={e => setData({ ...data, display_name: e.target.value })} style={{ ...inputStyle, width: "100%", marginTop: 4 }} />
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button onClick={save} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>Сохранить</button>
          {msg && <span style={{ fontSize: 14, color: msg.startsWith("✅") ? C.pos : C.neg }}>{msg}</span>}
        </div>
      </div>

      {/* Магазины */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Магазины ({shops.length}/{MAX_SHOPS_PER_CABINET})</h2>
        </div>
        <p style={{ color: C.muted, fontSize: 12, margin: "0 0 12px" }}>Налоговый режим настраивается на каждый магазин (юрлицо) отдельно. До {MAX_SHOPS_PER_CABINET} магазинов на проект.</p>
        {shops.length === 0 ? (
          <p style={{ color: C.muted, fontSize: 14 }}>Магазинов пока нет.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {shops.map((s) => (
              <ShopRow key={s.shop_id} shop={s} cabinetId={cabinetId} onSaved={() => {
                fetch(`/api/cabinets/${cabinetId}/shops`).then(r => r.json()).then(d => setShops(d.items || []));
              }} />
            ))}
          </div>
        )}

        {/* Добавление магазина (inline, пока не достигнут лимит). */}
        <AddShopForm
          cabinetId={cabinetId}
          disabled={shops.length >= MAX_SHOPS_PER_CABINET}
          onAdded={() => {
            fetch(`/api/cabinets/${cabinetId}/shops`).then(r => r.json()).then(d => setShops(d.items || []));
          }}
        />
      </div>

      {/* Внешние сервисы */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Внешние сервисы</h2>
        <p style={{ color: C.muted, fontSize: 13, margin: "0 0 12px" }}>API-ключи для расширенной аналитики. Хранятся зашифрованными.</p>
        <label style={{ fontSize: 12, color: C.muted }}>MPStats API-ключ
          <input type="password" value={data.mpstats_token || ""} onChange={e => setData({ ...data, mpstats_token: e.target.value })} placeholder="Для сбора позиций по поисковым запросам" style={{ ...inputStyle, width: "100%", marginTop: 4 }} />
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button onClick={save} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

// Компонент магазина с раскрытием формы ключей + налогов.
function ShopRow({ shop, cabinetId, onSaved }) {
  const [expanded, setExpanded] = useState(false);
  const [creds, setCreds] = useState({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  // Налоговый режим (локальная копия).
  const [tax, setTax] = useState(
    shop.tax_mode || { type: "usn_income", rate: 6, vat: 0 }
  );

  // Поля API-кредов — из единого конфига lib/mpConfig.js.
  const fields = (MP_CONFIG[shop.mp_code]?.fields) || [];

  const remove = async () => {
    const name = shop.shop_name || `Магазин #${shop.shop_id}`;
    if (!confirm(`Удалить «${name}»?\nСобранные данные остаются, но новый сбор остановится.`)) return;
    const r = await fetch(`/api/cabinets/${cabinetId}/shops?shop_id=${shop.shop_id}`, { method: "DELETE" });
    if (r.ok) onSaved();
    else alert("Не удалось удалить магазин");
  };

  const saveCreds = async () => {
    setSaving(true); setMsg(null);
    const filled = {};
    for (const f of fields) {
      if (creds[f.key]) filled[f.key] = creds[f.key];
    }
    if (Object.keys(filled).length === 0) { setMsg("❌ Заполните хотя бы одно поле"); setSaving(false); return; }

    const r = await fetch(`/api/cabinets/${cabinetId}/shops`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shop_id: shop.shop_id, api_creds: { [shop.mp_code]: filled } }),
    });
    const d = await r.json();
    if (r.ok) {
      setMsg("✅ Ключи сохранены");
      setCreds({});
      onSaved();
    } else {
      setMsg(`❌ ${d.error || "Ошибка"}`);
    }
    setSaving(false);
  };

  const saveTax = async () => {
    setSaving(true); setMsg(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/shops`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shop_id: shop.shop_id, tax_mode: tax }),
    });
    const d = await r.json();
    if (r.ok) {
      setMsg("✅ Налоги сохранены");
      onSaved();
    } else {
      setMsg(`❌ ${d.error || "Ошибка"}`);
    }
    setSaving(false);
  };

  const vatLabel = tax.vat === 0 ? "Без НДС" : `НДС ${tax.vat}%`;

  return (
    <div style={{ background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
      {/* Шапка магазина (клик → раскрыть) */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", cursor: "pointer" }}
      >
        <div>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{shop.shop_name || `Магазин #${shop.shop_id}`}</span>
          <span style={{ marginLeft: 8, padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700,
            background: shop.mp_code === "wb" ? "rgba(79,140,255,0.15)" : "rgba(249,115,22,0.15)",
            color: shop.mp_code === "wb" ? C.accent : "#f97316" }}>{shop.mp_code.toUpperCase()}</span>
          {shop.legal_name && <span style={{ marginLeft: 8, fontSize: 12, color: C.faint }}>{shop.legal_name}</span>}
          {shop.has_creds
            ? <span style={{ marginLeft: 8, fontSize: 11, color: C.pos }}>🔑 Ключи есть</span>
            : <span style={{ marginLeft: 8, fontSize: 11, color: C.neg }}>⚠ Нет ключей</span>}
          <span style={{ marginLeft: 8, fontSize: 11, color: C.muted }}>
            {tax.type === "usn_income_expenses" ? "УСН Д−Р" : "УСН Доходы"} {tax.rate}%{tax.vat ? ` + ${vatLabel}` : ""}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Удаление магазина (с подтверждением). */}
          <button
            onClick={(e) => { e.stopPropagation(); remove(); }}
            title="Удалить магазин"
            style={{ padding: "2px 10px", borderRadius: 6, border: `1px solid ${C.neg}`, background: "transparent", color: C.neg, cursor: "pointer", fontSize: 12 }}
          >✕</button>
          <span style={{ fontSize: 12, color: C.muted }}>{expanded ? "▴ свернуть" : "▾ настройки"}</span>
        </div>
      </div>

      {/* Форма (раскрывается) */}
      {expanded && (
        <div style={{ padding: "0 14px 14px", borderTop: `1px solid ${C.line}` }}>
          {/* Налоговый режим */}
          <div style={{ marginTop: 14 }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px", color: C.ink }}>Налоговый режим</h3>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ fontSize: 12, color: C.muted }}>Система
                <select
                  value={tax.type}
                  onChange={e => {
                    const newType = e.target.value;
                    setTax({ ...tax, type: newType, rate: newType === "usn_income_expenses" ? 15 : 6 });
                  }}
                  style={{ ...inputStyle, width: "auto", marginTop: 4 }}
                >
                  <option value="usn_income">УСН «Доходы»</option>
                  <option value="usn_income_expenses">УСН «Доходы−Расходы»</option>
                </select>
              </label>
              <label style={{ fontSize: 12, color: C.muted }}>Ставка УСН, %
                <input
                  type="number" min="0" max="100"
                  value={tax.rate}
                  onChange={e => setTax({ ...tax, rate: Number(e.target.value) })}
                  style={{ ...inputStyle, width: 80, marginTop: 4 }}
                />
              </label>
              <label style={{ fontSize: 12, color: C.muted }}>НДС
                <select
                  value={tax.vat}
                  onChange={e => setTax({ ...tax, vat: Number(e.target.value) })}
                  style={{ ...inputStyle, width: "auto", marginTop: 4 }}
                >
                  <option value={0}>Без НДС</option>
                  <option value={5}>НДС 5%</option>
                  <option value={7}>НДС 7%</option>
                </select>
              </label>
              <button onClick={saveTax} disabled={saving} style={{
                padding: "8px 16px", borderRadius: 8, background: C.accent, color: "#fff",
                border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 13,
              }}>Сохранить налоги</button>
            </div>
            {tax.type === "usn_income_expenses" && (
              <p style={{ fontSize: 11, color: C.faint, margin: "8px 0 0" }}>
                Минимальный налог: 1% от доходов (применяется автоматически, если расчётный меньше).
              </p>
            )}
          </div>

          {/* API-ключи */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px", color: C.ink }}>API-ключи</h3>
            <p style={{ fontSize: 12, color: C.faint, margin: "0 0 8px" }}>
              Шифруются и хранятся безопасно. Сбор данных начнётся автоматически.
            </p>
            <div style={{ display: "grid", gap: 10 }}>
              {fields.map((f) => (
                <label key={f.key} style={{ fontSize: 12, color: C.muted }}>{f.label}
                  <input
                    type={f.type}
                    value={creds[f.key] || ""}
                    onChange={e => setCreds({ ...creds, [f.key]: e.target.value })}
                    placeholder={shop.has_creds ? "•••••••• (введите новый для замены)" : "Введите ключ"}
                    style={{ ...inputStyle, width: "100%", marginTop: 4 }}
                  />
                </label>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
              <button onClick={saveCreds} disabled={saving} style={{
                padding: "8px 20px", borderRadius: 8, background: C.accent, color: "#fff",
                border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 13,
              }}>{saving ? "Сохранение…" : "Сохранить ключи"}</button>
            </div>
          </div>

          {msg && <div style={{ fontSize: 13, color: msg.startsWith("✅") ? C.pos : C.neg, marginTop: 10 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

// Форма добавления нового магазина в существующий проект. По образцу онбординга,
// но inline в settings. disabled=true когда достигнут лимит 4.
function AddShopForm({ cabinetId, disabled, onAdded }) {
  const [open, setOpen] = useState(false);
  const [mpCode, setMpCode] = useState("wb");
  const [shopName, setShopName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [creds, setCreds] = useState({});
  const [tax, setTax] = useState({ type: "usn_income", rate: 6, vat: 0 });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const cfg = MP_CONFIG[mpCode] || { fields: [] };

  const reset = () => {
    setShopName(""); setLegalName(""); setCreds({});
    setTax({ type: "usn_income", rate: 6, vat: 0 }); setErr("");
  };

  const submit = async () => {
    setErr("");
    // Валидация обязательных полей API-кредов.
    for (const f of cfg.fields) {
      if (f.required && !creds[f.key]) { setErr(`Заполните «${f.label}»`); return; }
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/shops`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mp_code: mpCode,
          shop_name: shopName,
          legal_name: legalName,
          tax_mode: tax,
          api_creds: { [mpCode]: creds },
        }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || "Ошибка"); return; }
      reset(); setOpen(false);
      onAdded();
    } catch {
      setErr("Сетевая ошибка");
    } finally {
      setSaving(false);
    }
  };

  // Когда форма закрыта: показываем кнопку «+ Магазин» (если лимит не достигнут).
  if (!open) {
    return (
      <div style={{ marginTop: 16 }}>
        <button
          onClick={() => setOpen(true)} disabled={disabled}
          style={{
            padding: "8px 18px", borderRadius: 8,
            background: disabled ? C.surfaceAlt : C.accent, color: disabled ? C.faint : "#fff",
            border: `1px solid ${C.line}`, cursor: disabled ? "not-allowed" : "pointer",
            fontWeight: 600, fontFamily: "inherit", fontSize: 13, opacity: disabled ? 0.6 : 1,
          }}
        >+ Добавить магазин</button>
        {disabled && <span style={{ marginLeft: 10, fontSize: 12, color: C.faint }}>Достигнут лимит {MAX_SHOPS_PER_CABINET} магазина</span>}
      </div>
    );
  }

  // Открытая форма: выбор МП + поля + налоги.
  return (
    <div style={{ marginTop: 16, background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Новый магазин</span>
        <button onClick={() => { setOpen(false); reset(); }} style={{ padding: "2px 10px", borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.muted, cursor: "pointer", fontSize: 12 }}>✕ отмена</button>
      </div>

      {/* Выбор МП */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {Object.entries(MP_CONFIG).map(([code, c]) => (
          <button key={code} type="button" onClick={() => { setMpCode(code); setCreds({}); }}
            style={{
              padding: "6px 14px", borderRadius: 6,
              border: `1px solid ${mpCode === code ? C.accent : C.line}`,
              background: mpCode === code ? "rgba(79,140,255,0.15)" : "transparent",
              color: mpCode === code ? C.accent : C.ink, cursor: "pointer",
              fontSize: 13, fontFamily: "inherit", fontWeight: 600,
            }}>{c.label}</button>
        ))}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <input value={shopName} onChange={e => setShopName(e.target.value)} placeholder="Название магазина (напр. ИП Матвеев WB)" style={inputStyle} />
        <input value={legalName} onChange={e => setLegalName(e.target.value)} placeholder="Юрлицо (ИП/ООО)" style={inputStyle} />

        {/* API-ключи */}
        {cfg.fields.map((f) => (
          <label key={f.key} style={{ fontSize: 12, color: C.muted }}>{f.label}{f.required ? " *" : ""}
            <input
              type={f.type}
              value={creds[f.key] || ""}
              onChange={e => setCreds({ ...creds, [f.key]: e.target.value })}
              style={{ ...inputStyle, marginTop: 4 }}
            />
          </label>
        ))}
      </div>

      {/* Налоговый режим */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", padding: "12px 0 0", marginTop: 4, borderTop: `1px dashed ${C.line}` }}>
        <label style={{ fontSize: 11, color: C.muted }}>Налог. система
          <select value={tax.type} onChange={e => setTax({ ...tax, type: e.target.value, rate: e.target.value === "usn_income_expenses" ? 15 : 6 })} style={{ ...inputStyle, width: "auto", marginTop: 4, fontSize: 13 }}>
            <option value="usn_income">УСН «Доходы»</option>
            <option value="usn_income_expenses">УСН «Доходы−Расходы»</option>
          </select>
        </label>
        <label style={{ fontSize: 11, color: C.muted }}>Ставка %
          <input type="number" min="0" max="100" value={tax.rate} onChange={e => setTax({ ...tax, rate: Number(e.target.value) })} style={{ ...inputStyle, width: 70, marginTop: 4, fontSize: 13 }} />
        </label>
        <label style={{ fontSize: 11, color: C.muted }}>НДС
          <select value={tax.vat} onChange={e => setTax({ ...tax, vat: Number(e.target.value) })} style={{ ...inputStyle, width: "auto", marginTop: 4, fontSize: 13 }}>
            <option value={0}>Без НДС</option>
            <option value={5}>5%</option>
            <option value={7}>7%</option>
          </select>
        </label>
      </div>

      {err && <div style={{ color: C.neg, fontSize: 13, marginTop: 10 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={submit} disabled={saving} style={{
          padding: "8px 20px", borderRadius: 8, background: C.accent, color: "#fff",
          border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 13,
        }}>{saving ? "Сохранение…" : "Добавить магазин"}</button>
        <span style={{ fontSize: 12, color: C.faint, alignSelf: "center" }}>Начнётся backfill за 75 дней</span>
      </div>
    </div>
  );
}
