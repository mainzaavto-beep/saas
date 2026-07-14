"use client";
// /settings — профиль пользователя: хаб с вкладками.
// Вкладки: Основное (личные данные + пароль), Настройки (проект), Команда.
import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const C = {
  bg: "#0b1220", surface: "#131c2e", surfaceAlt: "#1a2540", ink: "#e8edf7",
  muted: "#8a99b8", faint: "#6b7a8f", line: "#243049", accent: "#4f8cff",
  pos: "#4ade80", neg: "#ff6b6b",
};
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
                background: C.accent, color: "#fff", border: "none", cursor: "pointer",
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
                flex: 1, colorScheme: "dark",
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
        {tab === "team" && cabinetId && <TeamTab cabinetId={cabinetId} />}
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

  useEffect(() => {
    fetch("/api/profile").then(r => r.json()).then(d => d.error ? setError(d.error) : setData(d));
  }, []);

  if (error) return <div style={{ color: C.neg, padding: 20 }}>{error}</div>;
  if (!data) return <div style={{ color: C.muted, padding: 20 }}>Загрузка…</div>;

  const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit", width: "100%", colorScheme: "dark" };

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

  return (
    <div style={{ display: "grid", gap: 20 }}>
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
          <button onClick={save} disabled={saving} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>{saving ? "Сохранение…" : "Сохранить"}</button>
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
          <button onClick={changePass} style={{ padding: "10px 24px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>Сменить пароль</button>
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
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    fetch(`/api/cabinets/${cabinetId}/settings`).then(r => r.json()).then(d => d.error ? setError(d.error) : setData(d));
    fetch(`/api/cabinets/${cabinetId}/shops`).then(r => r.json()).then(d => setShops(d.items || []));
  }, [cabinetId]);

  if (error) return <div style={{ color: C.neg, padding: 20 }}>{error}</div>;
  if (!data) return <div style={{ color: C.muted, padding: 20 }}>Загрузка…</div>;

  const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit", colorScheme: "dark" };

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
      {/* Общие */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
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
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 4px" }}>Магазины (интеграции)</h2>
        <p style={{ color: C.muted, fontSize: 12, margin: "0 0 12px" }}>Налоговый режим настраивается на каждый магазин (юрлицо) отдельно.</p>
        {shops.length === 0 ? (
          <p style={{ color: C.muted, fontSize: 14 }}>Магазинов нет.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {shops.map(s => <ShopRow key={s.shop_id} shop={s} cabinetId={cabinetId} onSaved={() => {
              fetch(`/api/cabinets/${cabinetId}/shops`).then(r => r.json()).then(d => setShops(d.items || []));
            }} />)}
          </div>
        )}
      </div>

      {/* Внешние сервисы */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Внешние сервисы</h2>
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

// --- Вкладка: Команда ---
function TeamTab({ cabinetId }) {
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [inviteRole, setInviteRole] = useState("viewer");

  const load = () => {
    fetch(`/api/cabinets/${cabinetId}/members`).then(r => r.json()).then(d => setMembers(d.items || []));
    fetch(`/api/cabinets/${cabinetId}/invites`).then(r => r.json()).then(d => setInvites(d.items || []));
  };

  useEffect(() => { load(); }, [cabinetId]);

  const createInvite = async () => {
    setMsg(null);
    const r = await fetch(`/api/cabinets/${cabinetId}/invites`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: inviteRole }),
    });
    const d = await r.json();
    if (r.ok && d.url) {
      navigator.clipboard.writeText(d.url).catch(() => {});
      setMsg(`✅ Ссылка скопирована: ${d.url}`);
      load();
    } else {
      setMsg(`❌ ${d.error || "Ошибка"}`);
    }
  };

  const changeRole = async (userId, role) => {
    await fetch(`/api/cabinets/${cabinetId}/members`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, role }),
    });
    load();
  };

  const removeMember = async (userId) => {
    if (!confirm("Удалить сотрудника из проекта?")) return;
    await fetch(`/api/cabinets/${cabinetId}/members?user_id=${userId}`, { method: "DELETE" });
    load();
  };

  const roleLabel = (r) => r === "owner" ? "Владелец" : r === "manager" ? "Менеджер" : "Наблюдатель";

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {error && <div style={{ color: C.neg, padding: 12 }}>{error}</div>}

      {/* Сотрудники */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Сотрудники ({members.length})</h2>
        <div style={{ display: "grid", gap: 8 }}>
          {members.map(m => (
            <div key={m.user_id} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "10px 14px", background: C.surfaceAlt, borderRadius: 8,
            }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{m.name || m.email}</span>
                {m.name && <span style={{ marginLeft: 8, fontSize: 12, color: C.faint }}>{m.email}</span>}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {m.role === "owner" ? (
                  <span style={{ fontSize: 12, color: C.muted, padding: "4px 10px", background: C.surface, borderRadius: 6 }}>{roleLabel(m.role)}</span>
                ) : (
                  <>
                    <select value={m.role} onChange={e => changeRole(m.user_id, e.target.value)} style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 12, fontFamily: "inherit", colorScheme: "dark" }}>
                      <option value="manager">Менеджер</option>
                      <option value="viewer">Наблюдатель</option>
                    </select>
                    <button onClick={() => removeMember(m.user_id)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.neg}`, background: "transparent", color: C.neg, cursor: "pointer", fontSize: 12 }}>✕</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Приглашения */}
      <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px" }}>Пригласить сотрудника</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={inviteRole} onChange={e => setInviteRole(e.target.value)} style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit", colorScheme: "dark" }}>
            <option value="manager">Менеджер</option>
            <option value="viewer">Наблюдатель</option>
          </select>
          <button onClick={createInvite} style={{ padding: "8px 20px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 14 }}>Создать ссылку</button>
          {msg && <span style={{ fontSize: 13, color: msg.startsWith("✅") ? C.pos : C.neg, wordBreak: "break-all" }}>{msg}</span>}
        </div>
        {invites.length > 0 && (
          <div style={{ marginTop: 16, display: "grid", gap: 8 }}>
            {invites.map(inv => (
              <div key={inv.token} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: C.surfaceAlt, borderRadius: 8 }}>
                <span style={{ fontSize: 12, color: C.muted }}>{inv.role} — истекает {new Date(inv.expires_at).toLocaleDateString("ru-RU")}</span>
                <button onClick={async () => {
                  await fetch(`/api/cabinets/${cabinetId}/invites?token=${inv.token}`, { method: "DELETE" });
                  load();
                }} style={{ padding: "2px 10px", borderRadius: 6, border: `1px solid ${C.neg}`, background: "transparent", color: C.neg, cursor: "pointer", fontSize: 12 }}>Отозвать</button>
              </div>
            ))}
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
      <a href="/onboarding" style={{ display: "inline-block", marginTop: 12, padding: "10px 24px", borderRadius: 8, background: C.accent, color: "#fff", textDecoration: "none", fontWeight: 600 }}>Создать проект →</a>
    </div>
  );
}

// --- ShopRow (компонент магазина с налогами + ключами) ---
function ShopRow({ shop, cabinetId, onSaved }) {
  const [expanded, setExpanded] = useState(false);
  const [creds, setCreds] = useState({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [tax, setTax] = useState(shop.tax_mode || { type: "usn_income", rate: 6, vat: 0 });

  const FIELDS = {
    wb: [{ key: "token", label: "WB Token (доступ «Статистика»)", type: "password" }],
    ozon: [
      { key: "client_id", label: "Client-Id", type: "text" },
      { key: "api_key", label: "Api-Key", type: "password" },
      { key: "perf_client_id", label: "Performance Client-Id (опц.)", type: "text" },
      { key: "perf_client_secret", label: "Performance Client-Secret (опц.)", type: "password" },
    ],
  };
  const fields = FIELDS[shop.mp_code] || [];
  const inputStyle = { padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, fontSize: 14, fontFamily: "inherit", colorScheme: "dark" };

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
          <span style={{ marginLeft: 8, padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: shop.mp_code === "wb" ? "rgba(79,140,255,0.15)" : "rgba(249,115,22,0.15)", color: shop.mp_code === "wb" ? C.accent : "#f97316" }}>{shop.mp_code.toUpperCase()}</span>
          {shop.legal_name && <span style={{ marginLeft: 8, fontSize: 12, color: C.faint }}>{shop.legal_name}</span>}
          {shop.has_creds ? <span style={{ marginLeft: 8, fontSize: 11, color: C.pos }}>🔑 Ключи есть</span> : <span style={{ marginLeft: 8, fontSize: 11, color: C.neg }}>⚠ Нет ключей</span>}
          <span style={{ marginLeft: 8, fontSize: 11, color: C.muted }}>{tax.type === "usn_income_expenses" ? "УСН Д−Р" : "УСН Доходы"} {tax.rate}%{tax.vat ? ` + НДС ${tax.vat}%` : ""}</span>
        </div>
        <span style={{ fontSize: 12, color: C.muted }}>{expanded ? "▴ свернуть" : "▾ настройки"}</span>
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
              <button onClick={saveTax} disabled={saving} style={{ padding: "8px 16px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 13 }}>Сохранить</button>
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
              <button onClick={saveCreds} disabled={saving} style={{ padding: "8px 20px", borderRadius: 8, background: C.accent, color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, fontFamily: "inherit", fontSize: 13 }}>{saving ? "Сохранение…" : "Сохранить ключи"}</button>
            </div>
          </div>
          {msg && <div style={{ fontSize: 13, color: msg.startsWith("✅") ? C.pos : C.neg, marginTop: 10 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}
