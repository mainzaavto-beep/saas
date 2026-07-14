'use client';
// /onboarding — создание проекта с несколькими магазинами.
// Поддержка: WB (до 4), Ozon (до 4), разные юрлица, налоги.
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const C = {
  bg: "#0b1220", surface: "#131c2e", surfaceAlt: "#1a2540", ink: "#e8edf7",
  muted: "#8a99b8", faint: "#6b7a8f", line: "#243049", accent: "#4f8cff",
  pos: "#4ade80", neg: "#ff6b6b",
};
const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit", width: "100%", colorScheme: "dark" };

const MP_CONFIG = {
  wb: { label: "Wildberries", fields: [{ key: "token", label: "WB Token (доступ «Статистика»)", type: "password", required: true }] },
  ozon: { label: "Ozon", fields: [
    { key: "client_id", label: "Client-Id", type: "text", required: true },
    { key: "api_key", label: "Api-Key", type: "password", required: true },
    { key: "perf_client_id", label: "Performance Client-Id (реклама)", type: "text", required: false },
    { key: "perf_client_secret", label: "Performance Client-Secret", type: "password", required: false },
  ]},
};

export default function OnboardingPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [usnPct, setUsnPct] = useState('6');
  const [vat, setVat] = useState(false);
  const [shops, setShops] = useState([]); // [{mp_code, shop_name, legal_name, creds:{}}]
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const addShop = (mpCode) => {
    const count = shops.filter(s => s.mp_code === mpCode).length;
    if (count >= 4) return;
    setShops([...shops, { mp_code: mpCode, shop_name: '', legal_name: '', creds: {} }]);
  };
  const removeShop = (idx) => setShops(shops.filter((_, i) => i !== idx));
  const updateShop = (idx, field, val) => {
    setShops(shops.map((s, i) => i === idx ? { ...s, [field]: val } : s));
  };
  const updateCred = (idx, key, val) => {
    setShops(shops.map((s, i) => i === idx ? { ...s, creds: { ...s.creds, [key]: val } } : s));
  };

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!displayName.trim()) { setErr('Укажите название проекта'); return; }
    if (shops.length === 0) { setErr('Добавьте хотя бы один магазин'); return; }
    // Проверка обязательных полей
    for (let i = 0; i < shops.length; i++) {
      const s = shops[i];
      const cfg = MP_CONFIG[s.mp_code];
      for (const f of cfg.fields) {
        if (f.required && !s.creds[f.key]) { setErr(`Магазин #${i+1}: заполните «${f.label}»`); return; }
      }
    }
    setBusy(true);
    try {
      // Создаём проект
      const projectR = await fetch('/api/onboarding/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName, usn_pct: Number(usnPct), vat }),
      });
      const projectData = await projectR.json();
      if (!projectR.ok) { setErr(projectData.error || 'Ошибка'); return; }
      const cabinetId = projectData.cabinet.cabinet_id;

      // Добавляем магазины
      const marketplaces = [...new Set(shops.map(s => s.mp_code))];
      for (const s of shops) {
        await fetch(`/api/cabinets/${cabinetId}/shops`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mp_code: s.mp_code,
            shop_name: s.shop_name,
            legal_name: s.legal_name,
            api_creds: { [s.mp_code]: s.creds },
          }),
        });
      }

      // Обновить marketplaces в кабинете
      await fetch(`/api/cabinets/${cabinetId}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName }),
      });

      router.push(`/cabinets/${cabinetId}`);
      router.refresh();
    } catch { setErr('Сетевая ошибка'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "system-ui, sans-serif", display: "flex", justifyContent: "center", padding: "28px 20px" }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 640 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 4px" }}>Создание проекта</h1>
        <p style={{ color: C.muted, fontSize: 14, margin: "0 0 24px" }}>Подключите магазины — мы начнём собирать аналитику автоматически</p>
        {err && <div style={{ background: "rgba(255,107,107,.12)", color: C.neg, padding: "10px 14px", borderRadius: 8, fontSize: 14, marginBottom: 16 }}>{err}</div>}

        {/* Название + налоги */}
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: C.muted }}>Название проекта
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Напр. ИП Иванов" required autoFocus style={{ ...inputStyle, marginTop: 4 }} />
          </label>
          <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
            <label style={{ fontSize: 12, color: C.muted }}>УСН %
              <input type="number" min="0" max="100" value={usnPct} onChange={e => setUsnPct(e.target.value)} style={{ ...inputStyle, width: 80, marginTop: 4 }} />
            </label>
            <label style={{ fontSize: 14, color: C.ink, display: "flex", alignItems: "center", gap: 6, paddingTop: 20 }}>
              <input type="checkbox" checked={vat} onChange={e => setVat(e.target.checked)} /> С НДС
            </label>
          </div>
        </div>

        {/* Магазины */}
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Магазины ({shops.length})</h2>
            <div style={{ display: "flex", gap: 8 }}>
              {Object.entries(MP_CONFIG).map(([code, cfg]) => (
                <button key={code} type="button" onClick={() => addShop(code)} style={{
                  padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surfaceAlt,
                  color: C.ink, cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600,
                }}>+ {cfg.label}</button>
              ))}
            </div>
          </div>

          {shops.length === 0 && <p style={{ color: C.muted, fontSize: 14 }}>Добавьте магазин (WB или Ozon)</p>}

          {shops.map((s, idx) => {
            const cfg = MP_CONFIG[s.mp_code];
            return (
              <div key={idx} style={{ background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16, marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{cfg.label}</span>
                  <button type="button" onClick={() => removeShop(idx)} style={{ padding: "2px 10px", borderRadius: 6, border: `1px solid ${C.neg}`, background: "transparent", color: C.neg, cursor: "pointer", fontSize: 12 }}>✕</button>
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  <input value={s.shop_name} onChange={e => updateShop(idx, 'shop_name', e.target.value)} placeholder="Название магазина (напр. ИП Матвеев WB)" style={inputStyle} />
                  <input value={s.legal_name} onChange={e => updateShop(idx, 'legal_name', e.target.value)} placeholder="Юрлицо (ИП/ООО)" style={inputStyle} />
                  {cfg.fields.map(f => (
                    <input key={f.key} type={f.type} value={s.creds[f.key] || ''} onChange={e => updateCred(idx, f.key, e.target.value)} placeholder={f.label + (f.required ? " *" : "")} style={inputStyle} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <button type="submit" disabled={busy} style={{
          width: "100%", padding: "14px", borderRadius: 10, background: C.accent, color: "#fff",
          border: "none", cursor: busy ? "default" : "pointer", fontWeight: 700, fontSize: 16, fontFamily: "inherit",
        }}>{busy ? "Создаём проект…" : "Создать проект →"}</button>
        <p style={{ textAlign: "center", color: C.faint, fontSize: 12, marginTop: 12 }}>🔑 Ключи хранятся зашифрованными. Сбор данных начнётся автоматически.</p>
      </form>
    </div>
  );
}
