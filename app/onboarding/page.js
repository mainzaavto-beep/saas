'use client';
import { C } from "@/lib/palette.js";
// /onboarding — создание проекта с несколькими магазинами.
// Поддержка: до 4 магазинов всего (любая комбинация WB/Ozon), разные юрлица, налоги per shop.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MP_CONFIG, MAX_SHOPS_PER_CABINET } from '@/lib/mpConfig.js';


const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit", width: "100%" };

// MP_CONFIG импортируется из lib/mpConfig.js (единый источник правды).

// Дефолтный налоговый режим для нового магазина.
const DEFAULT_TAX = () => ({ type: "usn_income", rate: 6, vat: 0 });

export default function OnboardingPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [shops, setShops] = useState([]); // [{mp_code, shop_name, legal_name, tax, creds:{}}]
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const addShop = (mpCode) => {
    // Лимит общий на проект — любая комбинация WB/Ozon, не более 4 всего.
    if (shops.length >= MAX_SHOPS_PER_CABINET) return;
    setShops([...shops, { mp_code: mpCode, shop_name: '', legal_name: '', tax: DEFAULT_TAX(), creds: {} }]);
  };
  const removeShop = (idx) => setShops(shops.filter((_, i) => i !== idx));
  const updateShop = (idx, field, val) => {
    setShops(shops.map((s, i) => i === idx ? { ...s, [field]: val } : s));
  };
  const updateCred = (idx, key, val) => {
    setShops(shops.map((s, i) => i === idx ? { ...s, creds: { ...s.creds, [key]: val } } : s));
  };
  const updateTax = (idx, field, val) => {
    setShops(shops.map((s, i) => {
      if (i !== idx) return s;
      const newTax = { ...s.tax, [field]: val };
      // При смене типа — сбросить ставку на дефолт.
      if (field === 'type') newTax.rate = val === 'usn_income_expenses' ? 15 : 6;
      return { ...s, tax: newTax };
    }));
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
      // Создаём проект. marketplaces[] = unique МП из выбранных магазинов —
      // воркер по нему выбирает сборщиков, а онбординг-эндпоинт создаёт job
      // на backfill за 75 дней.
      const marketplaces = [...new Set(shops.map((s) => s.mp_code))];
      const projectR = await fetch('/api/onboarding/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName, marketplaces }),
      });
      const projectData = await projectR.json();
      if (!projectR.ok) { setErr(projectData.error || 'Ошибка'); return; }
      const cabinetId = projectData.cabinet.cabinet_id;

      // Добавляем магазины с налоговым режимом
      for (const s of shops) {
        await fetch(`/api/cabinets/${cabinetId}/shops`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mp_code: s.mp_code,
            shop_name: s.shop_name,
            legal_name: s.legal_name,
            tax_mode: s.tax,
            api_creds: { [s.mp_code]: s.creds },
          }),
        });
      }

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

        {/* Название */}
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: C.muted }}>Название проекта
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Напр. ИП Иванов" required autoFocus style={{ ...inputStyle, marginTop: 4 }} />
          </label>
        </div>

        {/* Магазины */}
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Магазины ({shops.length}/{MAX_SHOPS_PER_CABINET})</h2>
            <div style={{ display: "flex", gap: 8 }}>
              {Object.entries(MP_CONFIG).map(([code, cfg]) => {
                const atLimit = shops.length >= MAX_SHOPS_PER_CABINET;
                return (
                  <button key={code} type="button" onClick={() => addShop(code)} disabled={atLimit} style={{
                    padding: "6px 14px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surfaceAlt,
                    color: atLimit ? C.faint : C.ink, cursor: atLimit ? "not-allowed" : "pointer",
                    opacity: atLimit ? 0.5 : 1, fontSize: 13, fontFamily: "inherit", fontWeight: 600,
                  }}>+ {cfg.label}</button>
                );
              })}
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

                  {/* Налоговый режим */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", padding: "10px 0", borderTop: `1px dashed ${C.line}` }}>
                    <label style={{ fontSize: 11, color: C.muted }}>Налог. система
                      <select value={s.tax.type} onChange={e => updateTax(idx, 'type', e.target.value)} style={{ ...inputStyle, width: "auto", marginTop: 4, fontSize: 13 }}>
                        <option value="usn_income">УСН «Доходы»</option>
                        <option value="usn_income_expenses">УСН «Доходы−Расходы»</option>
                      </select>
                    </label>
                    <label style={{ fontSize: 11, color: C.muted }}>Ставка %
                      <input type="number" min="0" max="100" value={s.tax.rate} onChange={e => updateTax(idx, 'rate', Number(e.target.value))} style={{ ...inputStyle, width: 70, marginTop: 4, fontSize: 13 }} />
                    </label>
                    <label style={{ fontSize: 11, color: C.muted }}>НДС
                      <select value={s.tax.vat} onChange={e => updateTax(idx, 'vat', Number(e.target.value))} style={{ ...inputStyle, width: "auto", marginTop: 4, fontSize: 13 }}>
                        <option value={0}>Без НДС</option>
                        <option value={5}>5%</option>
                        <option value={7}>7%</option>
                      </select>
                    </label>
                  </div>

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
