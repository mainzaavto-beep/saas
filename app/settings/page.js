"use client";
import { C, soft } from "@/lib/palette.js";
// /settings — профиль пользователя: хаб с вкладками.
// Вкладки: Основное (личные данные + пароль), Настройки (проект), Команда.
import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MP_CONFIG, MAX_SHOPS_PER_CABINET } from "@/lib/mpConfig.js";
import TeamPage from "@/app/cabinets/[id]/team/TeamPage.jsx";


const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

function ProfileHub() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState(searchParams.get("tab") || "main");

  // Список проектов пользователя + выбранный проект.
  const [projects, setProjects] = useState([]);
  const [cabinetId, setCabinetId] = useState(null);

  useEffect(() => {
    fetch("/api/cabinets").then(r => r.json()).then(d => {
      const items = d.items || [];
      setProjects(items);
      // Если есть projects — взять из URL, иначе первый.
      const urlId = searchParams.get("cabinet");
      const found = urlId ? items.find(p => String(p.cabinet_id) === urlId) : null;
      setCabinetId(found ? found.cabinet_id : (items[0]?.cabinet_id || null));
    });
  }, []);

  // Обновить URL при смене проекта (без перезагрузки).
  const selectProject = (id) => {
    setCabinetId(id);
    const params = new URLSearchParams(searchParams);
    params.set("cabinet", id);
    router.replace(`/settings?${params.toString()}`);
  };

  const project = projects.find(p => p.cabinet_id === cabinetId);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.ink, fontFamily: FONT }}>
      {/* Шапка */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "16px 32px", borderBottom: `1px solid ${C.line}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>📊</span>
          <span style={{ fontSize: 17, fontWeight: 800 }}>SySell</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {project && (
            <button
              onClick={() => router.push(`/cabinets/${cabinetId}`)}
              style={{
                padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: C.accent, color: "var(--accentInk)", border: "none", cursor: "pointer",
                fontFamily: "inherit",
              }}
            >← К проекту</button>
          )}
          <a href="/" style={{ color: C.muted, fontSize: 14, textDecoration: "none" }}>Все проекты</a>
          <form action="/api/auth/logout" method="post" style={{ display: "inline" }}>
            <button type="submit" style={{
              padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
              border: `1px solid ${C.line}`, background: "transparent", color: C.muted,
              cursor: "pointer", fontFamily: "inherit",
            }}>Выйти</button>
          </form>
        </div>
      </div>

      <div style={{ maxWidth: 800, margin: "0 auto", padding: "28px 32px" }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 20px" }}>👤 Профиль</h1>

        {/* Селектор проекта */}
        {projects.length > 0 && (
          <div style={{
            background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12,
            padding: "12px 16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12,
          }}>
            <span style={{ fontSize: 13, color: C.muted }}>Проект:</span>
            <select
              value={cabinetId || ""}
              onChange={e => selectProject(Number(e.target.value))}
              style={{
                padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`,
                background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit",
                flex: 1,
              }}
            >
              {projects.map(p => (
                <option key={p.cabinet_id} value={p.cabinet_id}>
                  {p.display_name || `Проект #${p.cabinet_id}`} ({(p.marketplaces || []).join(", ").toUpperCase()})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Вкладки */}
        <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: `1px solid ${C.line}` }}>
          {[
            { key: "main", label: "Основное" },
            { key: "settings", label: "Настройки" },
            { key: "team", label: "Команда" },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: "10px 20px", fontSize: 14, fontWeight: 600, fontFamily: "inherit",
                background: "transparent", color: tab === t.key ? C.ink : C.muted,
                border: "none", borderBottom: tab === t.key ? `2px solid ${C.accent}` : "2px solid transparent",
                cursor: "pointer", marginBottom: -1,
              }}
            >{t.label}</button>
          ))}
        </div>

        {/* Контент вкладок */}
        {tab === "main" && <MainTab />}
        {tab === "settings" && cabinetId && <SettingsTab cabinetId={cabinetId} />}
        {tab === "settings" && !cabinetId && <NoProject />}
        {tab === "team" && cabinetId && <TeamPage cabinetId={cabinetId} embedded />}
        {tab === "team" && !cabinetId && <NoProject />}
      </div>
    </div>
  );
}

// useSearchParams требует Suspense-границы для статической генерации (Next 14).
export default function SettingsPage() {
  return (
    <Suspense fallback={<div style={{ background: C.bg, minHeight: "100vh" }} />}>
      <ProfileHub />
    </Suspense>
  );
}

// --- Вкладка: Основное (личные данные + смена пароля) ---
function MainTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [oldPass, setOldPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [passMsg, setPassMsg] = useState(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState(null);

  useEffect(() => {
    fetch("/api/profile").then(r => r.json()).then(d => d.error ? setError(d.error) : setData(d));
  }, []);

  if (error) return <div style={{ color: C.neg, padding: 20 }}>{error}</div>;
  if (!data) return <div style={{ color: C.muted, padding: 20 }}>Загрузка…</div>;

  const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit", width: "100%" };

  const save = async () => {
    setSaving(true); setMsg(null);
    const r = await fetch("/api/profile", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ first_name: data.first_name, last_name: data.last_name, patronymic: data.patronymic, phone: data.phone }),
    });
    const d = await r.json();
    setMsg(r.ok ? "✅ Сохранено" : `❌ ${d.error}`);
    setSaving(false);
  };

  const changePass = async () => {
    setPassMsg(null);
    if (newPass !== confirmPass) { setPassMsg("❌ Пароли не совпадают"); return; }
    if (newPass.length < 8) { setPassMsg("❌ Минимум 8 символов"); return; }
    const r = await fetch("/api/profile", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_password: oldPass, new_password: newPass }),
    });
    const d = await r.json();
    if (r.ok) { setPassMsg("✅ Пароль изменён"); setOldPass(""); setNewPass(""); setConfirmPass(""); }
    else setPassMsg(`❌ ${d.error}`);
  };

  const resendVerify = async () => {
    setVerifyBusy(true); setVerifyMsg(null);
    try {
      const r = await fetch("/api/auth/verify/resend", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      setVerifyMsg(r.ok
        ? { ok: true, text: "Письмо отправлено — проверьте почту" }
        : { ok: false, text: d.error || "Не удалось отправить письмо" });
    } catch {
      setVerifyMsg({ ok: false, text: "Сетевая ошибка" });
    } finally {
      setVerifyBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {data && !data.email_verified_at && (
        <div style={{ background: soft("warn", 12), border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, display: "grid", gap: 10 }}>
          <div style={{ fontSize: 14 }}>
            Почта <b>{data.email}</b> не подтверждена. Без подтверждения нельзя подключать API-ключи маркетплейсов и приглашать сотрудников.
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="button" onClick={resendVerify} disabled={verifyBusy} style={{ padding: "8px 16px", borderRadius: 8, background: C.accent, color: "var(--accentInk)", border: "none", cursor: verifyBusy ? "default" : "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>
              {verifyBusy ? "Отправляем…" : "Выслать письмо ещё раз"}
            </button>
            {verifyMsg && <span style={{ fontSize: 13, color: verifyMsg.ok ? C.pos : C.neg }}>{verifyMsg.text}</span>}
          </div>
        </div>
      )}

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 16px" }}>Личные данные</h2>
        <div style={{ display: "grid", gap: 12 }}>
          <label style={{ fontSize: 12, color: C.muted }}>Фамилия
            <input value={data.last_name || ""} onChange={e => setData({ ...data, last_name: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Имя
            <input value={data.first_name || ""} onChange={e => setData({ ...data, first_name: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Отчество
            <input value={data.patronymic || ""} onChange={e => setData({ ...data, patronymic: e.target.value })} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Телефон
            <input value={data.phone || ""} onChange={e => setData({ ...data, phone: e.target.value })} placeholder="+7 (___) ___-__-__" style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Email (нельзя изменить)
            <input value={data.email || ""} disabled style={{ ...inputStyle, opacity: 0.5 }} />
          </label>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button onClick={save} disabled={saving} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "var(--accentInk)", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>{saving ? "Сохранение…" : "Сохранить"}</button>
          {msg && <span style={{ fontSize: 14, color: msg.startsWith("✅") ? C.pos : C.neg }}>{msg}</span>}
        </div>
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 16px" }}>Смена пароля</h2>
        <div style={{ display: "grid", gap: 12 }}>
          <label style={{ fontSize: 12, color: C.muted }}>Текущий пароль
            <input type="password" value={oldPass} onChange={e => setOldPass(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Новый пароль
            <input type="password" value={newPass} onChange={e => setNewPass(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: C.muted }}>Повторите новый пароль
            <input type="password" value={confirmPass} onChange={e => setConfirmPass(e.target.value)} style={inputStyle} />
          </label>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button onClick={changePass} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "var(--accentInk)", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>Сменить пароль</button>
          {passMsg && <span style={{ fontSize: 14, color: passMsg.startsWith("✅") ? C.pos : C.neg }}>{passMsg}</span>}
        </div>
      </div>
    </div>
  );
}

// --- Вкладка: Настройки проекта ---
function SettingsTab({ cabinetId }) {
  const [data, setData] = useState(null);
  const [shops, setShops] = useState([]);
  const [myRole, setMyRole] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    fetch(`/api/cabinets/${cabinetId}/me`).then(r => r.json()).then(d => setMyRole(d.role || null));
    fetch(`/api/cabinets/${cabinetId}/settings`).then(r => r.json()).then(d => d.error ? setError(d.error) : setData(d));
    fetch(`/api/cabinets/${cabinetId}/shops`).then(r => r.json()).then(d => setShops(d.items || []));
  }, [cabinetId]);

  if (error) return <div style={{ color: C.neg, padding: 20 }}>{error}</div>;
  if (!data) return <div style={{ color: C.muted, padding: 20 }}>Загрузка…</div>;

  // Менять настройки проекта / магазины / API-ключи может только владелец.
  const canManage = myRole === "owner";
  const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit" };

  const save = async () => {
    setMsg(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/settings`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: data.display_name, mpstats_token: data.mpstats_token }),
    });
    setMsg(r.ok ? "✅ Сохранено" : "❌ Ошибка");
  };

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {!canManage && (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, color: C.muted, fontSize: 14 }}>
          ⚠️ Настройки проекта (название, магазины, API-ключи) может менять только владелец. Ниже — только просмотр.
        </div>
      )}

      {/* Общие */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Общие</h2>
        <label style={{ fontSize: 12, color: C.muted }}>Название проекта
          <input value={data.display_name || ""} onChange={e => setData({ ...data, display_name: e.target.value })} disabled={!canManage} style={{ ...inputStyle, width: "100%", marginTop: 4, opacity: canManage ? 1 : 0.6 }} />
        </label>
        {canManage && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
            <button onClick={save} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "var(--accentInk)", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>Сохранить</button>
            {msg && <span style={{ fontSize: 14, color: msg.startsWith("✅") ? C.pos : C.neg }}>{msg}</span>}
          </div>
        )}
      </div>

      {/* Магазины */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 4px" }}>Магазины ({shops.length}/{MAX_SHOPS_PER_CABINET})</h2>
        <p style={{ color: C.muted, fontSize: 12, margin: "0 0 12px" }}>Налоговый режим настраивается на каждый магазин (юрлицо) отдельно. До {MAX_SHOPS_PER_CABINET} магазинов на проект.</p>
        {shops.length === 0 ? (
          <p style={{ color: C.muted, fontSize: 14 }}>Магазинов пока нет.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {shops.map(s => <ShopRow key={s.shop_id} shop={s} cabinetId={cabinetId} canManage={canManage} onSaved={() => {
              fetch(`/api/cabinets/${cabinetId}/shops`).then(r => r.json()).then(d => setShops(d.items || []));
            }} />)}
          </div>
        )}
        {/* Добавление магазина — только для владельца. */}
        {canManage && (
          <AddShopForm
            cabinetId={cabinetId}
            disabled={shops.length >= MAX_SHOPS_PER_CABINET}
            onAdded={() => {
              fetch(`/api/cabinets/${cabinetId}/shops`).then(r => r.json()).then(d => setShops(d.items || []));
            }}
          />
        )}
      </div>

      {/* Внешние сервисы */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Внешние сервисы</h2>
        <label style={{ fontSize: 12, color: C.muted }}>MPStats API-ключ
          <input type="password" value={data.mpstats_token || ""} onChange={e => setData({ ...data, mpstats_token: e.target.value })} disabled={!canManage} placeholder={canManage ? "Для сбора позиций по поисковым запросам" : ""} style={{ ...inputStyle, width: "100%", marginTop: 4, opacity: canManage ? 1 : 0.6 }} />
        </label>
        {canManage && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
            <button onClick={save} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "var(--accentInk)", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>Сохранить</button>
          </div>
        )}
      </div>
    </div>
  );
}

function NoProject() {
  return (
    <div style={{ background: C.surface, border: `1px dashed ${C.line}`, borderRadius: 12, padding: 40, textAlign: "center", color: C.muted }}>
      <p>Нет активного проекта.</p>
      <a href="/onboarding" style={{ display: "inline-block", marginTop: 12, padding: "10px 24px", borderRadius: 8, background: C.accent, color: "var(--accentInk)", textDecoration: "none", fontWeight: 600 }}>Создать проект →</a>
    </div>
  );
}

// --- ShopRow (компонент магазина с налогами + ключами) ---
function ShopRow({ shop, cabinetId, canManage, onSaved }) {
  const [expanded, setExpanded] = useState(false);
  const [creds, setCreds] = useState({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [tax, setTax] = useState(shop.tax_mode || { type: "usn_income", rate: 6, vat: 0 });

  // Поля API-кредов — из единого конфига lib/mpConfig.js.
  const fields = (MP_CONFIG[shop.mp_code]?.fields) || [];
  const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit" };

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
    for (const f of fields) { if (creds[f.key]) filled[f.key] = creds[f.key]; }
    if (Object.keys(filled).length === 0) { setMsg("❌ Заполните хотя бы одно поле"); setSaving(false); return; }
    const r = await fetch(`/api/cabinets/${cabinetId}/shops`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shop_id: shop.shop_id, api_creds: { [shop.mp_code]: filled } }),
    });
    const d = await r.json();
    if (r.ok) { setMsg("✅ Ключи сохранены"); setCreds({}); onSaved(); }
    else setMsg(`❌ ${d.error || "Ошибка"}`);
    setSaving(false);
  };

  const saveTax = async () => {
    setSaving(true); setMsg(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/shops`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shop_id: shop.shop_id, tax_mode: tax }),
    });
    const d = await r.json();
    if (r.ok) { setMsg("✅ Налоги сохранены"); onSaved(); }
    else setMsg(`❌ ${d.error || "Ошибка"}`);
    setSaving(false);
  };

  return (
    <div style={{ background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
      <div onClick={() => setExpanded(!expanded)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", cursor: "pointer" }}>
        <div>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{shop.shop_name || `Магазин #${shop.shop_id}`}</span>
          {/* cabinet.css (классы .mp-badge/.mp-ozon) здесь не подключён — эта страница вне /cabinets/[id]/, поэтому бейдж инлайн */}
          <span style={{ marginLeft: 8, padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: shop.mp_code === "wb" ? soft("accent", 12) : soft("pink", 12), color: shop.mp_code === "wb" ? C.accent : C.pink }}>{shop.mp_code.toUpperCase()}</span>
          {shop.legal_name && <span style={{ marginLeft: 8, fontSize: 12, color: C.faint }}>{shop.legal_name}</span>}
          {shop.has_creds ? <span style={{ marginLeft: 8, fontSize: 11, color: C.pos }}>🔑 Ключи есть</span> : <span style={{ marginLeft: 8, fontSize: 11, color: C.neg }}>⚠ Нет ключей</span>}
          <span style={{ marginLeft: 8, fontSize: 11, color: C.muted }}>{tax.type === "usn_income_expenses" ? "УСН Д−Р" : "УСН Доходы"} {tax.rate}%{tax.vat ? ` + НДС ${tax.vat}%` : ""}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {canManage && (
            <button onClick={(e) => { e.stopPropagation(); remove(); }} title="Удалить магазин" style={{ padding: "2px 10px", borderRadius: 6, border: `1px solid ${C.neg}`, background: "transparent", color: C.neg, cursor: "pointer", fontSize: 12 }}>✕</button>
          )}
          <span style={{ fontSize: 12, color: C.muted }}>{expanded ? "▴ свернуть" : "▾ настройки"}</span>
        </div>
      </div>
      {expanded && (
        <div style={{ padding: "0 14px 14px", borderTop: `1px solid ${C.line}` }}>
          <div style={{ marginTop: 14 }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>Налоговый режим</h3>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ fontSize: 12, color: C.muted }}>Система
                <select value={tax.type} onChange={e => { const t = e.target.value; setTax({ ...tax, type: t, rate: t === "usn_income_expenses" ? 15 : 6 }); }} style={{ ...inputStyle, width: "auto", marginTop: 4 }}>
                  <option value="usn_income">УСН «Доходы»</option>
                  <option value="usn_income_expenses">УСН «Доходы−Расходы»</option>
                </select>
              </label>
              <label style={{ fontSize: 12, color: C.muted }}>Ставка %
                <input type="number" min="0" max="100" value={tax.rate} onChange={e => setTax({ ...tax, rate: Number(e.target.value) })} style={{ ...inputStyle, width: 80, marginTop: 4 }} />
              </label>
              <label style={{ fontSize: 12, color: C.muted }}>НДС
                <select value={tax.vat} onChange={e => setTax({ ...tax, vat: Number(e.target.value) })} style={{ ...inputStyle, width: "auto", marginTop: 4 }}>
                  <option value={0}>Без НДС</option>
                  <option value={5}>5%</option>
                  <option value={7}>7%</option>
                </select>
              </label>
              <button onClick={saveTax} disabled={saving} style={{ padding: "8px 16px", borderRadius: 8, background: C.accent, color: "var(--accentInk)", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 13 }}>Сохранить</button>
            </div>
          </div>
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.line}` }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, margin: "0 0 8px" }}>API-ключи</h3>
            <div style={{ display: "grid", gap: 10 }}>
              {fields.map(f => (
                <label key={f.key} style={{ fontSize: 12, color: C.muted }}>{f.label}
                  <input type={f.type} value={creds[f.key] || ""} onChange={e => setCreds({ ...creds, [f.key]: e.target.value })} placeholder={shop.has_creds ? "•••••••• (введите новый для замены)" : "Введите ключ"} style={{ ...inputStyle, width: "100%", marginTop: 4 }} />
                </label>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
              <button onClick={saveCreds} disabled={saving} style={{ padding: "8px 20px", borderRadius: 8, background: C.accent, color: "var(--accentInk)", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 13 }}>{saving ? "Сохранение…" : "Сохранить ключи"}</button>
            </div>
          </div>
          {msg && <div style={{ fontSize: 13, color: msg.startsWith("✅") ? C.pos : C.neg, marginTop: 10 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

// --- AddShopForm: добавление нового магазина в существующий проект ---
// Inline в SettingsTab. По образцу AddShopForm из SettingsPage.jsx. disabled=true
// когда достигнут лимит MAX_SHOPS_PER_CABINET.
function AddShopForm({ cabinetId, disabled, onAdded }) {
  const [open, setOpen] = useState(false);
  const [mpCode, setMpCode] = useState("wb");
  const [shopName, setShopName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [creds, setCreds] = useState({});
  const [tax, setTax] = useState({ type: "usn_income", rate: 6, vat: 0 });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit" };
  const cfg = MP_CONFIG[mpCode] || { fields: [] };

  const reset = () => {
    setShopName(""); setLegalName(""); setCreds({});
    setTax({ type: "usn_income", rate: 6, vat: 0 }); setErr("");
  };

  const submit = async () => {
    setErr("");
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

  if (!open) {
    return (
      <div style={{ marginTop: 16 }}>
        <button onClick={() => setOpen(true)} disabled={disabled} style={{
          padding: "8px 18px", borderRadius: 8,
          background: disabled ? C.surfaceAlt : C.accent, color: disabled ? C.faint : "var(--accentInk)",
          border: `1px solid ${C.line}`, cursor: disabled ? "not-allowed" : "pointer",
          fontWeight: 600, fontFamily: "inherit", fontSize: 13, opacity: disabled ? 0.6 : 1,
        }}>+ Добавить магазин</button>
        {disabled && <span style={{ marginLeft: 10, fontSize: 12, color: C.faint }}>Достигнут лимит {MAX_SHOPS_PER_CABINET} магазинов</span>}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16, background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Новый магазин</span>
        <button onClick={() => { setOpen(false); reset(); }} style={{ padding: "2px 10px", borderRadius: 6, border: `1px solid ${C.line}`, background: "transparent", color: C.muted, cursor: "pointer", fontSize: 12 }}>✕ отмена</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {Object.entries(MP_CONFIG).map(([code, c]) => (
          <button key={code} type="button" onClick={() => { setMpCode(code); setCreds({}); }}
            style={{
              padding: "6px 14px", borderRadius: 6,
              border: `1px solid ${mpCode === code ? C.accent : C.line}`,
              background: mpCode === code ? soft("accent", 15) : "transparent",
              color: mpCode === code ? C.accent : C.ink, cursor: "pointer",
              fontSize: 13, fontFamily: "inherit", fontWeight: 600,
            }}>{c.label}</button>
        ))}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <input value={shopName} onChange={e => setShopName(e.target.value)} placeholder="Название магазина (напр. ИП Матвеев WB)" style={inputStyle} />
        <input value={legalName} onChange={e => setLegalName(e.target.value)} placeholder="Юрлицо (ИП/ООО)" style={inputStyle} />
        {cfg.fields.map(f => (
          <label key={f.key} style={{ fontSize: 12, color: C.muted }}>{f.label}{f.required ? " *" : ""}
            <input type={f.type} value={creds[f.key] || ""} onChange={e => setCreds({ ...creds, [f.key]: e.target.value })} style={{ ...inputStyle, marginTop: 4 }} />
          </label>
        ))}
      </div>

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
          padding: "8px 20px", borderRadius: 8, background: C.accent, color: "var(--accentInk)",
          border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 13,
        }}>{saving ? "Сохранение…" : "Добавить магазин"}</button>
        <span style={{ fontSize: 12, color: C.faint, alignSelf: "center" }}>Начнётся backfill за 75 дней</span>
      </div>
    </div>
  );
}
