"use client";
import { C, soft } from "@/lib/palette.js";

// /cabinets/[id]/inventory — Остатки склад/ФФ (маршрут: закупка → завершить → склад).
//
// Накопитель приходов: партии, завершённые на закупках (кнопка «Завершить → склад»),
// попадают сюда со своей себестоимостью AA = «себест. до МП» (внутренняя цифра партии
// для баланса склада). Кол-во можно править.
// Привязка артикулов МП — только для имени/фото со склада. С 2026-07-18 у одной
// позиции может быть НЕСКОЛЬКО артикулов (WB + Ozon, разные nm_id/product_id):
// товар физически один, но продаётся под разными карточками/на разных МП. Primary
// (для имени/фото строки) = первый добавленный (по created_at).
// ⚠ С 2026-07-16 склад НЕ пишет в cost_overrides: складская себестоимость независима
// от страницы «Себестоимость» (/items) и не влияет на P&L/юнитку.
//
// Источник: GET /api/cabinets/[id]/inventory → { items(…skus[]), totals }.
// Запись: POST link_sku / unlink_sku / update_qty.
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { ShipmentFormModal } from "../shipments/ShipmentFormModal.jsx";
import Link from "next/link";


const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽";
const num = (v) => v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v);
const dash = (v) => (v == null || v === "" ? "—" : v);
// Склонение по числу (1 карточка / 2 карточки / 5 карточек). Для подсказки в LinkModal.
const pluralRu = (n, one, few, many) => {
  const n10 = Math.abs(n) % 10, n100 = Math.abs(n) % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
};

export default function InventoryPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showLocs, setShowLocs] = useState(false);
  const [showShip, setShowShip] = useState(false); // модалка «+ Отгрузка»
  const [shipPreset, setShipPreset] = useState(null); // presetItem при вызове из строки
  const [category, setCategory] = useState(""); // фильтр по категории
  const [locationId, setLocationId] = useState(""); // фильтр по конкретному месту

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/cabinets/${cabinetId}/inventory`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cabinetId]);

  useEffect(() => { reload(); }, [reload]);

  // Открыть форму отгрузки с предзаполненной первой строкой (вызов кнопкой 📦 из Row).
  const openShipWithPreset = useCallback((item) => {
    setShipPreset(item);
    setShowShip(true);
  }, []);

  // Хуки useMemo — ДО ранних return (Rules of Hooks: хуки всегда безусловны
  // и в одном порядке на каждом рендере). Поэтому items берём с fallback на [].
  const items = data?.items || [];
  const locations = data?.locations || [];
  const locationsById = useMemo(() => {
    const m = {};
    for (const l of locations) m[l.id] = l;
    return m;
  }, [locations]);
  const categories = useMemo(
    () => [...new Set(items.map((i) => i.category).filter(Boolean))].sort(),
    [items]
  );
  const filtered = useMemo(
    () => items.filter((i) =>
      (!category || i.category === category) &&
      (!locationId || i.location_id === Number(locationId))
    ),
    [items, category, locationId]
  );
  // Totals по отфильтрованному списку (KPI/итог пересчитываются по фильтру).
  const totals = useMemo(() => {
    let qty = 0, sum = 0, linked = 0;
    for (const it of filtered) {
      qty += Number(it.qty) || 0;
      sum += (Number(it.qty) || 0) * (Number(it.unit_cost) || 0);
      // «привязана к МП» = есть хоть одна привязка в skus[] (с 2026-07-18 мультисвязка).
      if ((it.skus?.length || 0) > 0) linked++;
    }
    return { items: filtered.length, qty, sum: Math.round(sum * 100) / 100, linked };
  }, [filtered]);

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (loading && !data) return <Centered>Загрузка…</Centered>;
  if (!data) return <Centered>Нет данных</Centered>;

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1500, margin: "0 auto" }}>
      <Header />

      {/* KPI */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Позиций" value={num(totals.items)} accent />
        <Kpi label="Σ шт" value={num(totals.qty)} />
        <Kpi label="Σ сумма (себест.)" value={money(totals.sum)} color={C.neg} />
        <Kpi label="Привязано к МП" value={`${totals.linked} / ${totals.items}`} pos={totals.linked === totals.items} />
      </div>

      <div style={{ ...alertStyle, marginBottom: 14 }}>
        <strong>Склад/ФФ</strong> — приходы от завершённых закупок + ручные позиции. Себестоимость = «себест. до МП» (внутренняя цифра партии для баланса склада).
        К позиции можно привязать <strong>несколько артикулов</strong> разных маркетплейсов (1 товар = много SKU): имя и фото строки — от первого (primary). Складская себестоимость <strong>не зависит</strong> от страницы «Себестоимость» и не влияет на P&L (она заводится отдельно).
        Если артикула нет — загрузите фото вручную.
      </div>

      {/* Фильтры (категория + тип) + кнопка добавления */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>
          Место
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={inputStyle}>
            <option value="">Все ({items.length})</option>
            {["stock", "ff"].map((t) => {
              const locs = locations.filter((l) => l.loc_type === t);
              if (!locs.length) return null;
              return (
                <optgroup key={t} label={t === "stock" ? "Склады" : "Фулфилмент"}>
                  {locs.map((l) => (
                    <option key={l.id} value={l.id}>{l.name} ({items.filter((i) => i.location_id === l.id).length})</option>
                  ))}
                </optgroup>
              );
            })}
            {items.some((i) => !i.location_id) && (
              <option value="__none">— без места —</option>
            )}
          </select>
        </label>
        {categories.length > 0 && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>
            Категория
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
              <option value="">Все ({items.length})</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c} ({items.filter((i) => i.category === c).length})</option>
              ))}
            </select>
          </label>
        )}
        <button onClick={() => setShowLocs((v) => !v)}
          style={{ ...resetBtnStyle, background: showLocs ? C.surface : undefined }}>
          {showLocs ? "✕ Места" : "📍 Места"}
        </button>
        <button onClick={() => setShowAdd((v) => !v)}
          style={{ ...primaryBtn, background: showAdd ? C.surface : C.accent, color: showAdd ? C.ink : "var(--accentInk)" }}>
          {showAdd ? "✕ Закрыть" : "+ Добавить товар"}
        </button>
        <button onClick={() => { setShipPreset(null); setShowShip(true); }}
          style={{ ...primaryBtn, background: C.pink, color: "#0A1A1C" }}
          title="Создать отгрузку на маркетплейс (списание со склада/ФФ)">
          📦 Отгрузка на МП
        </button>
        <Link href={`./shipments`} style={{ ...resetBtnStyle, textDecoration: "none", display: "inline-block" }}
          title="Все отгрузки">
          📋 Все отгрузки
        </Link>
      </div>

      {showLocs && <LocationsManager cabinetId={cabinetId} locations={locations} reload={reload} />}

      {showAdd && <AddForm cabinetId={cabinetId} locations={locations} onDone={() => { setShowAdd(false); reload(); }} />}

      {showShip && (
        <ShipmentFormModal
          cabinetId={cabinetId}
          inventoryItems={items.filter((i) => i.qty > 0)}
          warehouses={null}
          presetItem={shipPreset}
          onClose={() => { setShowShip(false); setShipPreset(null); }}
          onDone={() => { setShowShip(false); setShipPreset(null); reload(); }}
        />
      )}

      {/* Таблица */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, textAlign: "left", borderBottom: `1px solid ${C.line}` }}>
              <th style={thLeft}>Товар</th>
              <th style={thLeft}>Место</th>
              <th style={thR}>Кол-во</th>
              <th style={thR}>Себест. до МП ₽</th>
              <th style={thR}>Сумма ₽</th>
              <th style={thLeft}>Категория</th>
              <th style={thLeft}>Артикул МП</th>
              <th style={{ ...thLeft, textAlign: "center" }}>Отгрузка</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((it) => (
              <Row key={it.id} it={it} cabinetId={cabinetId} locations={locations} reload={reload} onShipFromRow={openShipWithPreset} />
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 24, textAlign: "center", color: C.muted }}>
                {items.length === 0
                  ? "Склад пуст. Завершите партию на странице «Закупки» или добавьте товар вручную."
                  : "Ничего не найдено по выбранным фильтрам."}
              </td></tr>
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr style={{ background: C.surfaceAlt, borderTop: `2px solid ${C.line}` }}>
                <td style={tdFootLeft}>Итого ({totals.items} поз.)</td>
                <td style={tdFootLeft}></td>
                <td style={{ ...tdFootRight, fontWeight: 800, color: C.accent }}>{num(totals.qty)}</td>
                <td style={tdFootRight}>—</td>
                <td style={{ ...tdFootRight, fontWeight: 800 }}>{money(totals.sum)}</td>
                <td style={tdFootLeft} colSpan={3}></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* История отгрузок переехала на отдельную страницу /shipments (с 2026-07-18).
          Кнопка «📋 Все отгрузки» сверху ведёт туда. Создать отгрузку можно кнопкой 📦. */}
    </div>
  );
}

// =====================================================================
//  Строка: товар (фото+имя inline) + кол-во + себест + сумма + категория inline + артикул
// =====================================================================
function Row({ it, cabinetId, locations, reload, onShipFromRow }) {
  const [editingQty, setEditingQty] = useState(false);
  const [qtyText, setQtyText] = useState("");
  const [linking, setLinking] = useState(false);

  // Универсальный inline-post: правка любого поля через update_field.
  const saveField = async (field, value) => {
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/inventory`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_field", id: it.id, field, value }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "save failed");
      reload();
    } catch (e) { alert("Не сохранилось: " + e.message); }
  };

  async function commitQty() {
    setEditingQty(false);
    const v = parseInt(qtyText, 10);
    if (!Number.isFinite(v) || v < 0) return;
    if (v === it.qty) return;
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/inventory`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_qty", id: it.id, qty: v }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "update_qty failed");
      reload();
    } catch (e) { alert("Не сохранилось: " + e.message); }
  }

  const hasSku = (it.skus?.length || 0) > 0;  // хоть одна привязка → фото/имя с МП

  return (
    <tr style={{ borderBottom: `1px solid ${soft("line", 20)}` }}>
      {/* Товар: фото (загружаемое если нет SKU) + имя (inline) */}
      <td style={{ padding: "8px 10px", verticalAlign: "middle" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <PhotoControl
            imUrl={it.im_url}
            canEdit={!hasSku}
            onUpload={(dataUrl) => saveField("im_url", dataUrl)}
            onClear={() => saveField("im_url", "")}
          />
          <div style={{ minWidth: 0 }}>
            <InlineText value={it.sku_name || it.internal_name} placeholder="наименование товара"
              onCommit={(v) => saveField("internal_name", v)} />
            {hasSku && it.internal_name && it.internal_name !== it.sku_name && (
              <div style={{ fontSize: 11, color: C.faint }}>{it.internal_name}</div>
            )}
          </div>
        </div>
      </td>
      {/* Место (inline-select из справочника мест) */}
      <td style={{ padding: "8px 10px", verticalAlign: "middle" }}>
        <select
          value={it.location_id ? String(it.location_id) : ""}
          onChange={(e) => saveField("location_id", e.target.value)}
          style={{ ...inputStyle, width: "auto", padding: "4px 8px", fontSize: 12,
            color: it.loc_type === "ff" ? C.pink : it.loc_type === "stock" ? C.pos : C.faint }}
          title="Место хранения товара"
        >
          <option value="">— без места —</option>
          {["stock", "ff"].map((t) => {
            const locs = (locations || []).filter((l) => l.loc_type === t);
            if (!locs.length) return null;
            return (
              <optgroup key={t} label={t === "stock" ? "Склады" : "Фулфилмент"}>
                {locs.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
              </optgroup>
            );
          })}
        </select>
      </td>
      {/* Кол-во (inline) */}
      <td style={tdRight}>
        {editingQty ? (
          <input autoFocus type="number" value={qtyText}
            onChange={(e) => setQtyText(e.target.value)}
            onBlur={commitQty}
            onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditingQty(false); }}
            style={{ ...inputStyle, width: 80, padding: "4px 6px" }} />
        ) : (
          <button onClick={() => { setQtyText(String(it.qty)); setEditingQty(true); }}
            style={editBtn} title="Кликни чтобы править кол-во">
            <strong style={{ color: it.qty < 10 ? C.neg : C.ink }}>{num(it.qty)}</strong>
          </button>
        )}
      </td>
      {/* Себест. до МП (inline) */}
      <td style={tdRight}>
        <InlineNumber value={it.unit_cost} placeholder="0"
          fmt={money}
          onCommit={(v) => saveField("unit_cost", v)} accent />
      </td>
      {/* Сумма */}
      <td style={tdRight}><strong>{money(it.sum)}</strong></td>
      {/* Категория (inline) */}
      <td style={{ padding: "8px 10px", fontSize: 12, color: C.muted }}>
        <InlineText value={it.category} placeholder="категория" small
          onCommit={(v) => saveField("category", v)} />
      </td>
      {/* Артикул МП — список всех привязок (мультисвязка с 2026-07-18). */}
      <td style={{ padding: "8px 10px" }}>
        {hasSku ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 140 }}>
            {(it.skus || []).map((s, idx) => (
              <SkuChip
                key={s.id ?? `${s.platform}-${s.nm_id || s.product_id}`}
                sku={s}
                isPrimary={idx === 0}
                cabinetId={cabinetId}
                reload={reload}
              />
            ))}
            <button onClick={() => setLinking(true)} style={{ ...miniBtn, color: C.faint, alignSelf: "flex-start" }}
              title="Привязать ещё один артикул (другой МП или карточку)">
              + ещё артикул
            </button>
          </div>
        ) : (
          <button onClick={() => setLinking(true)} style={{ ...miniBtn, color: C.pos }}>+ привязать</button>
        )}
      </td>
      {/* Отгрузка на МП — открывает форму создания отгрузки с этим товаром (preset) */}
      <td style={{ padding: "8px 10px", textAlign: "center" }}>
        <button
          onClick={() => onShipFromRow(it)}
          disabled={it.qty <= 0}
          title={it.qty > 0 ? "Отгрузить на маркетплейс" : "Нет остатка для отгрузки"}
          style={{ ...miniBtn, color: it.qty > 0 ? C.pink : C.faint, cursor: it.qty > 0 ? "pointer" : "not-allowed" }}
        >
          📦
        </button>
      </td>
      {linking && (
        <LinkModal
          cabinetId={cabinetId}
          id={it.id}
          existingSkus={it.skus || []}
          onClose={() => setLinking(false)}
          onLinked={() => { setLinking(false); reload(); }}
        />
      )}
    </tr>
  );
}

// =====================================================================
//  Фото: миниатюра + загрузка файла (data-URL) / очистка.
//  canEdit=false (артикул привязан) → только показ, фото тянется с МП.
// =====================================================================
function PhotoControl({ imUrl, canEdit, onUpload, onClear }) {
  const fileRef = useRef(null);

  function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { alert("Выберите изображение"); return; }
    if (file.size > 2 * 1024 * 1024) { alert("Файл слишком большой (макс. 2 МБ)"); return; }
    // Сжимаем до миниатюры 200px через canvas — чтобы data-URL был компактным.
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 200;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        onUpload(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = "";  // сброс, чтобы тот же файл можно было выбрать снова
  }

  if (imUrl) {
    return (
      <div style={{ position: "relative", width: 40, height: 40, flexShrink: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imUrl} alt="" width={40} height={40}
          style={{ borderRadius: 6, objectFit: "cover", border: `1px solid ${C.line}` }} />
        {canEdit && (
          <button onClick={onClear} style={photoClearBtn} title="Удалить фото">✕</button>
        )}
      </div>
    );
  }
  if (canEdit) {
    return (
      <>
        <button onClick={() => fileRef.current?.click()} style={thumbBtn} title="Загрузить фото">📷</button>
        <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
      </>
    );
  }
  return <div style={{ ...thumb, width: 40, height: 40 }}>📦</div>;
}

// Inline-текстовая ячейка (клик → input). Сохранение на blur/Enter, отмена Esc.
function InlineText({ value, placeholder, onCommit, small }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  if (editing) {
    return (
      <input autoFocus value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { setEditing(false); const v = text.trim(); if (v !== (value || "")) onCommit(v); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.target.blur();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder={placeholder}
        style={{ ...inputStyle, width: "100%", minWidth: 120, padding: "3px 6px", fontSize: small ? 11 : 13 }} />
    );
  }
  return (
    <button onClick={() => { setText(value || ""); setEditing(true); }}
      style={{ ...editBtn, textAlign: "left", fontSize: small ? 11 : 13, fontWeight: small ? 400 : 600 }}
      title="Кликни чтобы править">
      {value
        ? <span style={{ color: C.ink }}>{value}</span>
        : <span style={{ color: C.faint, fontWeight: 400 }}>{placeholder}</span>}
    </button>
  );
}

// Inline-числовая ячейка (клик → input number).
function InlineNumber({ value, placeholder, fmt, onCommit, accent }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  if (editing) {
    return (
      <input autoFocus type="number" step="any" value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const v = text.trim();
          if (v === "" && value == null) return;
          const n = Number(v);
          if (!Number.isFinite(n)) return;
          if (n === value) return;
          onCommit(v);
        }}
        onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditing(false); }}
        placeholder={placeholder}
        style={{ ...inputStyle, width: 100, padding: "3px 6px" }} />
    );
  }
  return (
    <button onClick={() => { setText(value != null ? String(value) : ""); setEditing(true); }}
      style={editBtn} title="Кликни чтобы править">
      <span style={{ color: accent ? C.accent : C.ink }}>{value != null ? fmt(value) : <span style={{ color: C.faint }}>—</span>}</span>
    </button>
  );
}

// Чип привязки артикула (одна строка в списке привязок позиции).
// Показывает бейдж МП + id + метку «осн.» для primary + кнопку отвязки (по sku_link_id).
// С 2026-07-18: одна позиция может иметь несколько чипов.
function SkuChip({ sku, isPrimary, cabinetId, reload }) {
  const [busy, setBusy] = useState(false);
  async function unlink() {
    const label = sku.platform === "wb" ? `WB ${sku.nm_id}` : `Ozon ${sku.product_id}`;
    if (!confirm(`Отвязать артикул ${label} от позиции?`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/inventory`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unlink_sku", sku_link_id: sku.id }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "unlink failed");
      reload();
    } catch (e) { alert("Не отвязать: " + e.message); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <MpBadge platform={sku.platform} />
      <span style={{ fontSize: 12, color: C.ink, fontVariantNumeric: "tabular-nums" }}>
        {sku.platform === "wb" ? sku.nm_id : sku.product_id}
      </span>
      {isPrimary && (0,
        <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
          background: soft("accent", 15), color: C.accent }} title="Основной артикул (имя и фото строки от него)">осн.</span>
      )}
      <button onClick={unlink} disabled={busy}
        style={{ ...miniBtn, color: C.neg, padding: "2px 7px", marginLeft: "auto" }}
        title="Отвязать этот артикул">
        {busy ? "⏳" : "✕"}
      </button>
    </div>
  );
}

// =====================================================================
//  Модалка привязки артикула: выбор МП + ввод nm_id/product_id.
//  С 2026-07-18 — добавляет артикул к позиции (может быть уже привязанные).
// =====================================================================
function LinkModal({ cabinetId, id, existingSkus = [], onClose, onLinked }) {
  const [platform, setPlatform] = useState("wb");
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  // С 2026-07-19: список уже подгруженных карточек МП для combobox (datalist),
  // чтобы клиент выбирал из известных nm_id/product_id, а не вводил вслепую.
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Подгрузка справочника при смене МП. catalogue хранит ВСЕ артикулы кабинета
  // по выбранному МП (limit 1000 в API), независимо от того, привязаны ли они.
  useEffect(() => {
    let cancelled = false;
    setCatalog([]);
    setCatalogLoading(true);
    fetch(`/api/cabinets/${cabinetId}/articles?mp=${platform}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        // Унифицируем ключи для datalist: id = числовой артикул, label = имя + артикул.
        const list = (d.articles || []).map((a) => ({
          id: platform === "wb" ? a.nm_id : a.product_id,
          name: a.name,
          brand: a.brand,
          offer: a.offer_id,
          im_url: a.im_url,
        })).filter((x) => Number.isFinite(Number(x.id)));
        setCatalog(list);
      })
      .catch(() => { if (!cancelled) setCatalog([]); })
      .finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [cabinetId, platform]);

  // Совпадение выбранного значения с подгруженной карточкой — для превью имени/фото.
  const picked = catalog.find((c) => String(c.id) === String(val).trim());

  // Список уже привязанных артикулов выбранного МП — для предупреждения о повторе.
  const taken = existingSkus
    .filter((s) => s.platform === platform)
    .map((s) => String(s.platform === "wb" ? s.nm_id : s.product_id));

  async function save() {
    const v = parseInt(val, 10);
    if (!Number.isFinite(v) || v <= 0) { alert("Введите или выберите числовой артикул"); return; }
    if (taken.includes(String(v))) { alert("Этот артикул уже привязан к позиции"); return; }
    setBusy(true);
    try {
      const body = { action: "link_sku", id, platform };
      if (platform === "wb") body.nm_id = v; else body.product_id = v;
      const r = await fetch(`/api/cabinets/${cabinetId}/inventory`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "link failed");
      onLinked();
    } catch (e) { alert("Не привязать: " + e.message); }
    finally { setBusy(false); }
  }

  // datalist id должен быть стабильным и уникальным для этого инстанса модалки.
  const listId = `inv-link-skus-${platform}`;

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>
          {existingSkus.length > 0 ? "Добавить артикул маркетплейса" : "Привязать артикул маркетплейса"}
        </div>
        {existingSkus.length > 0 && (
          <div style={{ fontSize: 11, color: C.faint, marginBottom: 10, padding: "6px 8px",
            background: C.surfaceAlt, borderRadius: 6 }}>
            Уже привязано: {existingSkus.map((s) =>
              (s.platform === "wb" ? `WB ${s.nm_id}` : `Ozon ${s.product_id}`)
            ).join(", ")}
          </div>
        )}
        <Field label="Маркетплейс">
          <select value={platform} onChange={(e) => { setPlatform(e.target.value); setVal(""); }} style={inputStyle}>
            <option value="wb">Wildberries (nm_id)</option>
            <option value="ozon">Ozon (product_id)</option>
          </select>
        </Field>
        <div style={{ height: 8 }} />
        <Field label={platform === "wb" ? "Артикул WB (nm_id)" : "Артикул Ozon (product_id)"}>
          {/* Combobox: input + datalist. Пользователь либо выбирает из списка
              подгруженных карточек, либо вводит числовой артикул вручную (fallback
              для случая, когда карточки ещё нет в БД). */}
          <input autoFocus type="number" value={val} list={listId}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            placeholder={platform === "wb" ? "напр. 1055493730" : "напр. 3124567007"}
            style={{ ...inputStyle, width: "100%" }} />
          <datalist id={listId}>
            {catalog.map((c) => (
              <option key={c.id} value={c.id}
                label={`${c.name}${c.brand ? " · " + c.brand : ""}${c.offer ? " · " + c.offer : ""}`} />
            ))}
          </datalist>
        </Field>
        {/* Превью выбранной карточки: имя + миниатюра, если артикул нашёлся в БД. */}
        {picked && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8, padding: 8,
            background: C.surfaceAlt, borderRadius: 6 }}>
            {picked.im_url ? (
              <img src={picked.im_url} alt="" style={{ width: 40, height: 40, objectFit: "cover",
                borderRadius: 6, background: C.surface }} />
            ) : (
              <div style={{ width: 40, height: 40, borderRadius: 6, background: C.surface,
                display: "flex", alignItems: "center", justifyContent: "center",
                color: C.faint, fontSize: 16 }}>📦</div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.ink,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {picked.name || "—"}
              </div>
              <div style={{ fontSize: 11, color: C.faint }}>
                {picked.brand ? picked.brand + " · " : ""}артикул {picked.id}
                {picked.offer ? " · " + picked.offer : ""}
              </div>
            </div>
          </div>
        )}
        {/* Подсказка о покрытии справочника. */}
        <div style={{ fontSize: 11, color: C.faint, marginTop: 8 }}>
          {catalogLoading ? "Загружаю список карточек…" :
           catalog.length === 0
             ? <>Список карточек пуст — введите артикул вручную. Справочник
                наполняется сборщиком (раз в день).</>
             : <>В списке {catalog.length} {pluralRu(catalog.length, "карточка", "карточки", "карточек")}.
                Можно выбрать из списка или ввести свой.</>}
        </div>
        <div style={{ fontSize: 11, color: C.faint, marginTop: 8 }}>
          Привязка подтянет имя и фото карточки с маркетплейса. Один товар можно
          привязать к нескольким артикулам (например, WB + Ozon). Складская
          себестоимость остаётся внутренней цифрой партии и <strong>не меняет</strong>
          себестоимость на странице «Себестоимость».
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={resetBtnStyle}>Отмена</button>
          <button onClick={save} disabled={busy} style={primaryBtn}>{busy ? "⏳" : "Привязать"}</button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
//  Старая модалка отгрузки (ShipmentModal) и блок «История отгрузок»
//  (ShipmentsHistory) удалены — отгрузки переехали на отдельную страницу
//  /shipments (с 2026-07-18). Форма создания переиспользуется: кнопка 📦
//  здесь открывает ../shipments/ShipmentFormModal. Список документов — на /shipments.
// =====================================================================

function AddForm({ cabinetId, locations, onDone }) {
  const [form, setForm] = useState({ internal_name: "", qty: "", unit_cost: "", category: "", im_url: "", location_id: "" });
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { alert("Выберите изображение"); return; }
    if (file.size > 2 * 1024 * 1024) { alert("Файл слишком большой (макс. 2 МБ)"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 200;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        setForm((f) => ({ ...f, im_url: canvas.toDataURL("image/jpeg", 0.85) }));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  async function submit() {
    const name = form.internal_name.trim();
    if (!name) { alert("Введите наименование товара"); return; }
    const qty = Number(form.qty);
    if (!Number.isFinite(qty) || qty < 0) { alert("Кол-во должно быть числом >= 0"); return; }
    const cost = form.unit_cost === "" ? null : Number(form.unit_cost);
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) { alert("Себестоимость должна быть числом >= 0"); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/inventory`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", internal_name: name, qty, unit_cost: cost, category: form.category.trim() || null, im_url: form.im_url || null, location_id: form.location_id || null }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "add failed");
      onDone();
    } catch (e) { alert("Не добавилось: " + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ ...addFormCard }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Фото */}
        <div>
          {form.im_url ? (
            <div style={{ position: "relative", width: 56, height: 56 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={form.im_url} alt="" width={56} height={56} style={{ borderRadius: 8, objectFit: "cover", border: `1px solid ${C.line}` }} />
              <button onClick={() => setForm({ ...form, im_url: "" })} style={photoClearBtn} title="Удалить фото">✕</button>
            </div>
          ) : (
            <button onClick={() => fileRef.current?.click()} style={{ ...thumbBtn, width: 56, height: 56, fontSize: 20 }} title="Загрузить фото">📷</button>
          )}
          <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
        </div>
        {/* Поля */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", flex: 1, minWidth: 300 }}>
          <Field label="Наименование *">
            <input autoFocus value={form.internal_name} onChange={set("internal_name")}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="напр. Видеорегистратор 3 камеры" style={{ ...inputStyle, width: 220 }} />
          </Field>
          <Field label="Категория">
            <input value={form.category} onChange={set("category")}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="напр. Экшн-камеры" style={{ ...inputStyle, width: 160 }} />
          </Field>
          <Field label="Место">
            <select value={form.location_id} onChange={set("location_id")} style={{ ...inputStyle, width: "auto" }}>
              <option value="">— выберите —</option>
              {["stock", "ff"].map((t) => {
                const locs = (locations || []).filter((l) => l.loc_type === t);
                if (!locs.length) return null;
                return (
                  <optgroup key={t} label={t === "stock" ? "Склады" : "Фулфилмент"}>
                    {locs.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                  </optgroup>
                );
              })}
            </select>
          </Field>
          <Field label="Кол-во *">
            <input type="number" value={form.qty} onChange={set("qty")}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              style={{ ...inputStyle, width: 90 }} />
          </Field>
          <Field label="Себест. до МП ₽">
            <input type="number" step="any" value={form.unit_cost} onChange={set("unit_cost")}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="0" style={{ ...inputStyle, width: 120 }} />
          </Field>
          <button onClick={submit} disabled={busy} style={primaryBtn}>{busy ? "⏳" : "+ Добавить"}</button>
        </div>
      </div>
      <div style={{ fontSize: 11, color: C.faint, marginTop: 8 }}>
        Артикулы маркетплейсов (можно несколько) и фото с МП привязываются после добавления. Если артикула нет — фото загружено выше.
      </div>
    </div>
  );
}

// =====================================================================
//  Управление местами хранения (создать/переименовать/удалить)
// =====================================================================
function LocationsManager({ cabinetId, locations, reload }) {
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
            <button onClick={() => renameLoc(l)} style={{ ...miniBtn, color: C.muted }} title="Переименовать">✎</button>
            <button onClick={() => delLoc(l)} style={{ ...miniBtn, color: C.neg }} title="Удалить">🗑</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// =====================================================================
//  Мелкие компоненты
// =====================================================================
function Header() {
  return (
    <div style={{ marginBottom: 18 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Остатки склад/ФФ</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        Приходы от завершённых закупок с себестоимостью «до МП». К позиции можно привязать несколько артикулов МП — для отображения имени/фото.
      </p>
    </div>
  );
}
function Centered({ children }) {
  return <div style={{ minHeight: "80vh", display: "grid", placeItems: "center", color: C.muted, fontFamily: FONT, background: C.bg, padding: 20, textAlign: "center" }}>{children}</div>;
}
function Kpi({ label, value, accent, pos, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 140px", minWidth: 120 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent ? C.accent : pos === false ? C.neg : color || C.ink }}>{value}</div>
    </div>
  );
}
function MpBadge({ platform }) {
  const isWb = platform === "wb";
  return <span className={`mp-badge ${isWb ? "mp-wb" : "mp-ozon"}`}>{isWb ? "WB" : "OZON"}</span>;
}
function Field({ label, children }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>{label}{children}</label>;
}

// ---------------- Стили ----------------
const inputStyle = { padding: "6px 10px", borderRadius: 6, fontSize: 13, background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 120 };
const primaryBtn = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", fontWeight: 600, background: C.accent, color: "var(--accentInk)", border: "none" };
const resetBtnStyle = { padding: "8px 14px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const miniBtn = { padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer", background: C.surface, color: C.ink, border: `1px solid ${C.line}` };
const editBtn = { border: "none", background: "transparent", cursor: "pointer", padding: "2px 4px", fontVariantNumeric: "tabular-nums", color: C.ink };
const thumb = { borderRadius: 6, background: C.surfaceAlt, color: C.faint, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, border: `1px solid ${C.line}` };
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 };
const thR = { ...thLeft, textAlign: "right" };
const tdRight = { padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const tdLeft = { padding: "8px 10px", verticalAlign: "middle", textAlign: "left" };
const tdFootLeft = { padding: "12px 10px", fontSize: 13, fontWeight: 800, color: C.ink, textAlign: "left" };
const tdFootRight = { padding: "12px 10px", fontSize: 13, color: C.ink, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const alertStyle = { padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5, background: C.surfaceAlt, border: `1px solid ${C.line}`, color: C.muted };
const modalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", zIndex: 1000 };
const modalCard = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20, width: 380, maxWidth: "90vw" };
const thumbBtn = { width: 40, height: 40, borderRadius: 6, background: C.surfaceAlt, color: C.faint, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, border: `1px dashed ${C.line}`, cursor: "pointer", flexShrink: 0 };
const photoClearBtn = { position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 9, background: C.neg, color: "#fff", border: "none", fontSize: 11, cursor: "pointer", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" };
const addFormCard = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, marginBottom: 14 };
