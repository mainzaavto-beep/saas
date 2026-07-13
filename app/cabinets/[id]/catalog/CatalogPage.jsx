"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
const C = {
  bg: "#0b1220", surface: "#131c2e", surfaceAlt: "#1a2540", ink: "#e8edf7",
  muted: "#8a99b8", faint: "#6b7a8f", line: "#243049", accent: "#4f8cff",
  accent2: "#2bd4a0", pos: "#4ade80", neg: "#ff6b6b", pink: "#f97316",
  blue: "#4f8cff",
};

// =====================================================================
//  /items/catalog — СПРАВОЧНИК ТОВАРОВ компании (заявка 2026-06-25 (5)).
//
//  Внутренний товар компании = логическая сущность («регистратор 3 камеры
//  дешевый без вайфай»), которая маппится на ОДИН ИЛИ НЕСКОЛЬКО SKU
//  маркетплейсов (WB nm_id, Ozon product_id, Яндекс article). Один товар →
//  несколько nm_id WB (склейки/цвета), несколько product_id Ozon.
//
//  Источник: GET /api/catalog (products_catalog + products_catalog_skus,
//    обогащено фото/именем из wb_data.articles / ozon_data.products).
//  Запись (fin_data.db, data-presenter-owned):
//    • create/rename/delete товара
//    • add_sku/remove_sku — привязка/отвязка SKU через автопоиск по БД МП
//
//  Зачем: единый идентификатор товара для остатков склад/ФФ и др. БЕЗ
//  знания о том, сколько у него карточек на МП.
// =====================================================================

const FONT = "system-ui, -apple-platform, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽";
const num = (v) =>
  v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v);
const dash = (v) => (v == null || v === "" ? "—" : v);

const PLATFORMS = [
  { v: "wb", label: "WB", color: "#e88080", badge: "rgba(200,40,40,0.15)" },
  { v: "ozon", label: "OZON", color: "#6cb8e8", badge: "rgba(0,120,200,0.15)" },
  { v: "yandex", label: "ЯН", color: "#ffcc33", badge: "rgba(255,204,51,0.18)" },
];
const platMeta = (p) => PLATFORMS.find((x) => x.v === p) || { label: p, color: C.muted, badge: C.surfaceAlt };

export default function CatalogPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [saving, setSaving] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNote, setNewNote] = useState("");

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/cabinets/${cabinetId}/catalog`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setExpanded(null); }, [q]);

  const filtered = useMemo(() => {
    if (!data?.items) return [];
    if (!q.trim()) return data.items;
    const s = q.trim().toLowerCase();
    return data.items.filter((it) => {
      if (it.internal_name?.toLowerCase().includes(s)) return true;
      return (it.skus || []).some(
        (sk) =>
          String(sk.name || "").toLowerCase().includes(s) ||
          String(sk.nm_id || "").includes(s) ||
          String(sk.product_id || "").includes(s) ||
          String(sk.yandex_article || "").toLowerCase().includes(s) ||
          String(sk.offer_id || "").toLowerCase().includes(s)
      );
    });
  }, [data, q]);

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (loading && !data) return <Centered>Загрузка…</Centered>;
  if (!data) return <Centered>Нет данных</Centered>;

  const { totals } = data;

  async function createProduct() {
    const name = newName.trim();
    if (!name) return;
    setSaving("new");
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", internal_name: name, note: newNote || null }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "create failed");
      setNewName("");
      setNewNote("");
      setAdding(false);
      reload();
    } catch (e) {
      alert("Не создалось: " + e.message);
    } finally {
      setSaving(null);
    }
  }

  async function renameProduct(id, internal_name, note) {
    setSaving(`p${id}`);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", id, internal_name, note }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "rename failed");
      reload();
    } catch (e) {
      alert("Не переименовать: " + e.message);
    } finally {
      setSaving(null);
    }
  }

  async function deleteProduct(id, name) {
    if (!confirm(`Удалить товар «${name}»? Привязанные SKU тоже отпадут.`)) return;
    setSaving(`p${id}`);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "delete failed");
      if (expanded === id) setExpanded(null);
      reload();
    } catch (e) {
      alert("Не удалить: " + e.message);
    } finally {
      setSaving(null);
    }
  }

  // Колбэк после add/remove SKU — перезагружаем список.
  async function skuChanged(catalogId) {
    setSaving(`s${catalogId}`);
    try {
      await reloadNow();
    } finally {
      setSaving(null);
    }
  }
  // Обёртка reload без setState гонок (используем тот же reload).
  function reloadNow() {
    return new Promise((resolve) => {
      fetch(`/api/cabinets/${cabinetId}/catalog`)
        .then((r) => r.json())
        .then((d) => (d.error ? setError(d.error) : setData(d)))
        .catch((e) => setError(String(e)))
        .finally(resolve);
    });
  }

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1500, margin: "0 auto" }}>
      <Header />

      {/* KPI */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Товаров" value={num(totals.products)} accent />
        <Kpi label="С привязкой SKU" value={num(totals.withSku)} pos={totals.withSku === totals.products} />
        <Kpi label="Всего SKU" value={num(totals.skusTotal)} />
        <Kpi label="WB" value={num(totals.wb)} />
        <Kpi label="Ozon" value={num(totals.ozon)} />
        <Kpi label="Яндекс" value={num(totals.yandex)} />
      </div>

      {/* Плашка-объяснение */}
      <div style={{ ...alertStyle, marginBottom: 14 }}>
        <strong>Что это:</strong> внутренний товар компании со своим названием. Привязывается
        к карточкам маркетплейсов (один товар → несколько nm_id WB, product_id Ozon, article
        Яндекс). Фото/имя карточки подтягиваются из справочника МП автоматически. Этот
        справочник — основа для учёта остатков на собственном складе/ФФ и др.
      </div>

      {/* Строка действий: поиск + добавить */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 14, flexWrap: "wrap" }}>
        <Field label="Поиск">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="имя, артикул WB/Ozon/Яндекс…"
            style={{ ...inputStyle, width: 260 }}
          />
        </Field>
        {!adding ? (
          <button onClick={() => setAdding(true)} style={primaryBtn}>+ Добавить товар</button>
        ) : null}
        <div style={{ flex: 1 }} />
      </div>

      {/* Форма добавления */}
      {adding && (
        <div style={{ ...cardStyle, padding: 14, marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Внутреннее название *">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createProduct();
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="напр. «регистратор 3 камеры дешевый без вайфай»"
              style={{ ...inputStyle, width: 360 }}
            />
          </Field>
          <Field label="Примечание">
            <input
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createProduct();
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="опц."
              style={{ ...inputStyle, width: 260 }}
            />
          </Field>
          <button onClick={createProduct} disabled={saving === "new"} style={primaryBtn}>
            {saving === "new" ? "⏳" : "✓ Создать"}
          </button>
          <button onClick={() => { setAdding(false); setNewName(""); setNewNote(""); }} style={resetBtnStyle}>
            Отмена
          </button>
        </div>
      )}

      {/* Список карточек товаров */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.length === 0 && (
          <div style={{ ...cardStyle, padding: 24, textAlign: "center", color: C.muted }}>
            {data.items.length === 0
              ? "Справочник пуст. Нажмите «+ Добавить товар»."
              : "Ничего не найдено по фильтру."}
          </div>
        )}
        {filtered.map((it) => (
          <ProductCard
            key={it.id}
            it={it}
            isOpen={expanded === it.id}
            onToggle={() => setExpanded(expanded === it.id ? null : it.id)}
            saving={saving}
            onRename={renameProduct}
            onDelete={deleteProduct}
            onSkuChanged={() => skuChanged(it.id)}
          />
        ))}
      </div>
    </div>
  );
}

// =====================================================================
//  Карточка товара
// =====================================================================
function ProductCard({ it, isOpen, onToggle, saving, onRename, onDelete, onSkuChanged }) {
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const [editNote, setEditNote] = useState("");

  const skus = it.skus || [];
  // Группировка SKU по платформе для плиток.
  const byPlat = useMemo(() => {
    const m = {};
    for (const s of skus) {
      if (!m[s.platform]) m[s.platform] = [];
      m[s.platform].push(s);
    }
    return m;
  }, [skus]);

  function startRename() {
    setEditName(it.internal_name);
    setEditNote(it.note || "");
    setEditingName(true);
  }
  function commitRename() {
    setEditingName(false);
    const name = editName.trim();
    if (!name) return;
    if (name === it.internal_name && (editNote || null) === (it.note || null)) return;
    onRename(it.id, name, editNote || null);
  }

  return (
    <div style={{ ...cardStyle, overflow: "hidden" }}>
      {/* Шапка карточки */}
      <div style={{ padding: "12px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
        {/* Аватар: первое фото из SKU */}
        <div style={{ flexShrink: 0 }}>
          {skus.find((s) => s.im_url)?.im_url ? (
            <img
              src={skus.find((s) => s.im_url).im_url}
              alt=""
              width={52}
              height={52}
              style={{ borderRadius: 8, objectFit: "cover", border: `1px solid ${C.line}` }}
            />
          ) : (
            <div style={{ ...thumbFallback, width: 52, height: 52, fontSize: 22 }}>📦</div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          {editingName ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setEditingName(false);
                }}
                style={{ ...inputStyle, width: "100%", padding: "5px 8px", fontSize: 15, fontWeight: 700 }}
              />
              <input
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setEditingName(false);
                }}
                placeholder="примечание"
                style={{ ...inputStyle, width: "100%", padding: "4px 8px", fontSize: 12 }}
              />
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 16 }}>{it.internal_name}</strong>
                <span style={{ fontSize: 11, color: C.faint }}>
                  {skus.length > 0 ? `${skus.length} SKU` : "нет SKU"}
                </span>
              </div>
              {it.note && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{it.note}</div>}
            </>
          )}

          {/* Плитки SKU по платформам */}
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {PLATFORMS.map((p) => {
              const list = byPlat[p.v] || [];
              if (list.length === 0) return null;
              return (
                <div key={p.v} style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {list.map((s) => (
                    <SkuChip key={s.id} sku={s} plat={p} />
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* Действия */}
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {editingName ? (
            <>
              <button onClick={commitRename} style={{ ...miniBtn, color: C.pos }} title="Сохранить">✓</button>
              <button onClick={() => setEditingName(false)} style={miniBtn} title="Отмена">✕</button>
            </>
          ) : (
            <>
              <button onClick={startRename} style={miniBtn} title="Переименовать">✎</button>
              <button
                onClick={onToggle}
                style={{ ...miniBtn, minWidth: 28 }}
                title={isOpen ? "Свернуть" : "Управление SKU"}
              >
                {isOpen ? "▾" : `SKU ▾`}
              </button>
              <button onClick={() => onDelete(it.id, it.internal_name)} style={{ ...miniBtn, color: C.neg }} title="Удалить">🗑</button>
            </>
          )}
        </div>
      </div>

      {/* Разворот: управление SKU */}
      {isOpen && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: "14px 16px", background: C.surface }}>
          {saving === `s${it.id}` && <div style={{ fontSize: 11, color: C.faint, marginBottom: 8 }}>⏳ обновление…</div>}
          <SkuManager productId={it.id} skus={skus} onChanged={onSkuChanged} />
        </div>
      )}
    </div>
  );
}

// Плитка одного SKU с бейджем МП и мини-фото.
function SkuChip({ sku, plat }) {
  const ident =
    sku.platform === "wb" ? sku.nm_id
    : sku.platform === "ozon" ? (sku.offer_id || sku.product_id)
    : sku.yandex_article;
  return (
    <span
      title={sku.name || ""}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        background: plat.badge, color: plat.color,
        border: `1px solid ${plat.color}55`, borderRadius: 7,
        padding: "3px 8px", fontSize: 11, fontWeight: 700,
      }}
    >
      {plat.label} {String(ident)}
    </span>
  );
}

// =====================================================================
//  Управление SKU товара (разворот)
// =====================================================================
function SkuManager({ productId, skus, onChanged }) {
  const [platform, setPlatform] = useState("wb");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [yaInput, setYaInput] = useState("");
  const [yaName, setYaName] = useState("");

  // Поиск SKU в БД МП (debounce через таймер).
  useEffect(() => {
    if (platform === "yandex") { setResults([]); return; }
    if (!query.trim()) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      const p = new URLSearchParams({ sku_search: platform, q: query.trim() });
      fetch("/api/cabinets/${cabinetId}/catalog?" + p.toString())
        .then((r) => r.json())
        .then((d) => setResults(d.results || []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [platform, query]);

  async function addSkuFromResult(r) {
    try {
      const res = await fetch(`/api/cabinets/${cabinetId}/catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_sku",
          catalog_id: productId,
          platform: r.platform,
          nm_id: r.nm_id,
          product_id: r.product_id,
          display_name: r.name,
          im_url: r.im_url,
        }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || "add failed");
      setQuery("");
      setResults([]);
      onChanged();
    } catch (e) {
      alert("Не привязать: " + e.message);
    }
  }

  async function addYandex() {
    const art = yaInput.trim();
    if (!art) return;
    try {
      const res = await fetch(`/api/cabinets/${cabinetId}/catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_sku",
          catalog_id: productId,
          platform: "yandex",
          yandex_article: art,
          display_name: yaName || null,
        }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || "add failed");
      setYaInput("");
      setYaName("");
      onChanged();
    } catch (e) {
      alert("Не привязать: " + e.message);
    }
  }

  async function removeSku(id) {
    if (!confirm("Отвязать этот SKU от товара?")) return;
    try {
      const res = await fetch(`/api/cabinets/${cabinetId}/catalog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove_sku", id }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || "remove failed");
      onChanged();
    } catch (e) {
      alert("Не отвязать: " + e.message);
    }
  }

  return (
    <div>
      {/* Текущие привязки */}
      <div style={{ fontSize: 12, color: C.faint, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
        Привязанные SKU
      </div>
      {skus.length === 0 ? (
        <div style={{ fontSize: 12, color: C.faint, padding: "6px 0" }}>
          Нет привязанных SKU. Привяжите карточки МП ниже.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
          {skus.map((s) => {
            const p = platMeta(s.platform);
            return (
              <div
                key={s.id}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "6px 10px", background: C.surfaceAlt, borderRadius: 7,
                }}
              >
                {s.im_url ? (
                  <img src={s.im_url} alt="" width={32} height={32} style={{ borderRadius: 5, objectFit: "cover", border: `1px solid ${C.line}` }} />
                ) : (
                  <div style={{ ...thumbFallback, width: 32, height: 32, fontSize: 13 }}>📦</div>
                )}
                <SkuChip sku={s} plat={p} />
                <span style={{ fontSize: 12, color: C.muted, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {dash(s.name)}
                </span>
                <button onClick={() => removeSku(s.id)} style={{ ...miniBtn, color: C.neg }} title="Отвязать">✕</button>
              </div>
            );
          })}
        </div>
      )}

      {/* Добавление нового SKU */}
      <div style={{ fontSize: 12, color: C.faint, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
        Привязать новый SKU
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 8 }}>
        <Field label="Маркетплейс">
          <select value={platform} onChange={(e) => { setPlatform(e.target.value); setQuery(""); setResults([]); }} style={{ ...inputStyle, width: "auto" }}>
            {PLATFORMS.map((p) => (<option key={p.v} value={p.v}>{p.label}</option>))}
          </select>
        </Field>

        {platform === "yandex" ? (
          <>
            <Field label="Артикул Яндекса">
              <input
                value={yaInput}
                onChange={(e) => setYaInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addYandex(); }}
                placeholder="напр. ВР-3К"
                style={{ ...inputStyle, width: 180 }}
              />
            </Field>
            <Field label="Имя (опц.)">
              <input
                value={yaName}
                onChange={(e) => setYaName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addYandex(); }}
                placeholder="напр. видеорегистратор"
                style={{ ...inputStyle, width: 220 }}
              />
            </Field>
            <button onClick={addYandex} disabled={!yaInput.trim()} style={primaryBtn}>Привязать</button>
          </>
        ) : (
          <Field label="Поиск по справочнику МП">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={platform === "wb" ? "имя / nm_id / бренд…" : "имя / product_id / offer_id…"}
              style={{ ...inputStyle, width: 280 }}
            />
          </Field>
        )}
      </div>

      {/* Результаты поиска */}
      {platform !== "yandex" && query.trim() && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflowY: "auto" }}>
          {searching && <div style={{ fontSize: 12, color: C.faint, padding: 4 }}>поиск…</div>}
          {!searching && results.length === 0 && (
            <div style={{ fontSize: 12, color: C.faint, padding: 4 }}>Ничего не найдено.</div>
          )}
          {results.map((r) => {
            const p = platMeta(r.platform);
            return (
              <button
                key={r.platform + "-" + (r.nm_id || r.product_id)}
                onClick={() => addSkuFromResult(r)}
                style={{
                  display: "flex", alignItems: "center", gap: 10, textAlign: "left",
                  padding: "6px 10px", background: C.bg, borderRadius: 7,
                  border: `1px solid ${C.line}`, cursor: "pointer",
                }}
                title="Привязать к товару"
              >
                {r.im_url ? (
                  <img src={r.im_url} alt="" width={32} height={32} style={{ borderRadius: 5, objectFit: "cover", border: `1px solid ${C.line}` }} />
                ) : (
                  <div style={{ ...thumbFallback, width: 32, height: 32, fontSize: 13 }}>📦</div>
                )}
                <SkuChip sku={{ platform: r.platform, nm_id: r.nm_id, product_id: r.product_id, offer_id: r.offer_id }} plat={p} />
                <span style={{ fontSize: 12, color: C.muted, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {dash(r.name)}{r.brand ? ` · ${r.brand}` : ""}
                </span>
                <span style={{ fontSize: 13, color: C.pos, fontWeight: 700 }}>+ привязать</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =====================================================================
//  Мелкие компоненты
// =====================================================================
function Header() {
  return (
    <div style={{ marginBottom: 18 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Справочник товаров</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        Внутренние товары компании с привязкой к артикулам WB / Ozon / Яндекс. Основа для учёта остатков.
      </p>
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>
      {children}
    </div>
  );
}

function Kpi({ label, value, accent, pos }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 140px", minWidth: 120 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent ? C.accent : pos === false ? C.neg : C.ink }}>{value}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>
      {label}
      {children}
    </label>
  );
}

// ---------------- Стили ----------------
const inputStyle = {
  padding: "6px 10px", borderRadius: 6, fontSize: 13,
  background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 120,
};
const primaryBtn = {
  padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600,
  background: C.accent, color: "#0A1A1C", border: "none",
};
const resetBtnStyle = {
  padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer",
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const miniBtn = {
  padding: "4px 8px", borderRadius: 6, fontSize: 13, cursor: "pointer",
  background: C.surface, color: C.muted, border: `1px solid ${C.line}`,
};
const cardStyle = {
  background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10,
};
const thumbFallback = {
  borderRadius: 6, background: C.surfaceAlt, color: C.faint,
  display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${C.line}`,
};
const alertStyle = {
  padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
  background: C.surfaceAlt, border: `1px solid ${C.line}`, color: C.muted,
};
