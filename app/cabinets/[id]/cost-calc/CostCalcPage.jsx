"use client";
import { C, soft } from "@/lib/palette.js";
import { useEffect, useMemo, useState } from "react";
import { calcCost, CALC_FIELDS } from "@/lib/costCalc.js";

// /cabinets/[id]/cost-calc — «Калькулятор себестоимости» (22.10.2026): товар из Китая до ФФ.
// Считает на лету (lib/costCalc.js), сохраняет расчёты: GET/POST /api/cabinets/[id]/cost-calc.
// Прикидка, не учёт — в закупки и себестоимость ничего не пишет.

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const rub2 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const pct = new Intl.NumberFormat("ru-RU", { style: "percent", maximumFractionDigits: 1 });
const fmtRub = (v) => (v == null ? "—" : `${rub2.format(v)} ₽`);
const fmtDate = (s) => new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

// Группы полей формы: [ключ, подпись, единица].
const GROUPS = [
  { title: "Товар", fields: [["qty", "Количество", "шт"], ["weight_kg", "Вес 1 шт", "кг"], ["price_cny", "Цена 1 шт", "¥"]] },
  { title: "Доставка", fields: [["china_delivery_cny", "Доставка по Китаю", "¥ за партию"],
    ["cargo_usd_per_kg", "Ставка карго", "$ за кг"], ["ff_logistics_rub", "Карго → фулфилмент", "₽ за партию"]] },
  { title: "Курсы", fields: [["rate_cny", "Курс юаня", "₽ за ¥"], ["rate_usd", "Курс доллара", "₽ за $"]] },
];
const RATE_KEYS = ["china_delivery_cny", "cargo_usd_per_kg", "ff_logistics_rub", "rate_cny", "rate_usd"];

// В форме — строки (можно вводить «0,5»); в расчёт и API — числа.
const toNum = (s) => { const t = String(s ?? "").replace(/\s/g, "").replace(",", "."); return t === "" ? "" : Number(t); };
const emptyForm = (defaults) => {
  const f = { name: "", note: "" };
  for (const k of CALC_FIELDS) f[k] = "";
  if (defaults) for (const k of RATE_KEYS) f[k] = defaults[k] ? String(defaults[k]) : "";
  return f;
};
const formOf = (it) => {
  const f = { name: it.name, note: it.note || "" };
  for (const k of CALC_FIELDS) f[k] = String(it[k]);
  return f;
};
const numeric = (f) => Object.fromEntries(CALC_FIELDS.map((k) => [k, toNum(f[k])]));

export default function CostCalcPage({ cabinetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);   // форма открытого сохранённого расчёта (для «изменено»)
  const [editId, setEditId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    fetch(`/api/cabinets/${cabinetId}/cost-calc`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setData(d); setError(null);
        setForm((f) => f || emptyForm(d.defaults));
      })
      .catch((e) => setError(String(e)));
  }, [cabinetId, reload]);

  const nums = useMemo(() => (form ? numeric(form) : {}), [form]);
  const res = useMemo(() => calcCost(nums), [nums]);
  const invalid = useMemo(() => CALC_FIELDS.filter((k) => form && (Number.isNaN(nums[k]) || nums[k] < 0)), [form, nums]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const items = data?.items || [];
    return s ? items.filter((it) => it.name.toLowerCase().includes(s) || (it.note || "").toLowerCase().includes(s)) : items;
  }, [data, q]);

  if (error) return <Centered>⚠️ Ошибка: {error}</Centered>;
  if (!data || !form) return <Centered>Загрузка…</Centered>;

  const canWrite = data.role !== "viewer";
  const dirty = saved ? JSON.stringify(saved) !== JSON.stringify(form) : false;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const post = async (body) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/cost-calc`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) { window.alert(d.error || `Ошибка ${r.status}`); return null; }
      setReload((x) => x + 1);
      return d;
    } finally { setBusy(false); }
  };
  const save = async (asNew) => {
    if (!form.name.trim()) { window.alert("Укажите название товара."); return; }
    if (invalid.length) { window.alert("Исправьте поля, подсвеченные красным: нужно число ≥ 0."); return; }
    const d = await post({ action: "save", id: asNew ? null : editId, name: form.name, note: form.note, ...nums });
    if (d) { setEditId(d.id); setSaved(form); }
  };
  const open = (it) => {
    if (dirty && !window.confirm("Текущий расчёт изменён и не сохранён. Открыть другой?")) return;
    const f = formOf(it);
    setForm(f); setSaved(f); setEditId(it.id);
  };
  const startNew = () => {
    if (dirty && !window.confirm("Текущий расчёт изменён и не сохранён. Начать новый?")) return;
    setForm(emptyForm(data.defaults)); setSaved(null); setEditId(null);
  };
  const remove = async (it) => {
    if (!window.confirm(`Удалить расчёт «${it.name}»?`)) return;
    const d = await post({ action: "delete", id: it.id });
    if (d && it.id === editId) { setEditId(null); setSaved(null); }
  };

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", opacity: busy ? 0.6 : 1 }}>
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Калькулятор себестоимости</h1>
        <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13, maxWidth: 900 }}>
          Себестоимость товара из Китая до фулфилмента. Считается сразу при вводе. Сохранённый расчёт можно открыть,
          поправить или сохранить копией для другого товара. Это прикидка: в «Закупки» и «Себестоимость» ничего не попадает.
        </p>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 24 }}>
        <div style={{ ...card, flex: "1 1 460px", maxWidth: 640 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: C.muted }}>
              {editId ? <>Расчёт №{editId}{dirty && <span style={{ color: C.warn }}> · изменён, не сохранён</span>}</> : "Новый расчёт"}
            </span>
          </div>
          <Field label="Товар">
            <input value={form.name} onChange={set("name")} placeholder="Название, артикул поставщика…" style={{ ...inputStyle, width: "100%" }} />
          </Field>
          {GROUPS.map((g) => (
            <div key={g.title} style={{ marginTop: 12 }}>
              <div style={groupTitle}>{g.title}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10 }}>
                {g.fields.map(([k, label, unit]) => (
                  <Field key={k} label={label} unit={unit}>
                    <input inputMode="decimal" value={form[k]} onChange={set(k)} placeholder="0"
                      style={{ ...inputStyle, width: "100%", textAlign: "right",
                        borderColor: invalid.includes(k) ? C.neg : undefined }} />
                  </Field>
                ))}
              </div>
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            <Field label="Комментарий">
              <input value={form.note} onChange={set("note")} placeholder="Поставщик, карго, условия…" style={{ ...inputStyle, width: "100%" }} />
            </Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            {canWrite && <button onClick={() => save(false)} disabled={busy} style={{ ...btnStyle, ...btnPrimary }}>
              {editId ? "Сохранить" : "Сохранить расчёт"}</button>}
            {canWrite && editId && <button onClick={() => save(true)} disabled={busy} style={btnStyle}
              title="Сохранить отдельной строкой — открытый расчёт не изменится">Сохранить как новый</button>}
            <button onClick={startNew} disabled={busy} style={btnStyle}
              title="Очистить товар; курсы и ставки — из последнего сохранённого расчёта">Новый расчёт</button>
          </div>
        </div>

        <div style={{ ...card, flex: "1 1 380px", maxWidth: 560 }}>
          <div style={{ fontSize: 12, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>Себестоимость 1 шт</div>
          <div style={{ fontSize: 34, fontWeight: 800, color: C.accent, fontVariantNumeric: "tabular-nums", margin: "2px 0 10px" }}>
            {fmtRub(res.unitRub)}
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 13, color: C.muted, marginBottom: 14 }}>
            <span>Партия: <b style={{ color: C.ink }}>{fmtRub(res.totalRub)}</b></span>
            <span>Вес партии: <b style={{ color: C.ink }}>{nf.format(res.weightTotal)} кг</b></span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left" }}>Статья</th>
                <th style={th}>За партию</th>
                <th style={th}>На 1 шт</th>
                <th style={th}>Доля</th>
              </tr>
            </thead>
            <tbody>
              {res.lines.map((l) => (
                <tr key={l.key}>
                  <td style={{ ...td, textAlign: "left" }}>{l.label}</td>
                  <td style={td}>{fmtRub(l.rub)}</td>
                  <td style={td}>{fmtRub(l.perUnit)}</td>
                  <td style={{ ...td, color: C.muted }}>{l.share == null ? "—" : pct.format(l.share)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...td, textAlign: "left", fontWeight: 800 }}>Итого</td>
                <td style={{ ...td, fontWeight: 800 }}>{fmtRub(res.totalRub)}</td>
                <td style={{ ...td, fontWeight: 800 }}>{fmtRub(res.unitRub)}</td>
                <td style={td} />
              </tr>
            </tbody>
          </table>
          {!(nums.qty > 0) && <div style={{ marginTop: 10, fontSize: 12, color: C.warn }}>Укажите количество — без него себестоимость 1 шт не посчитать.</div>}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Сохранённые расчёты</h2>
        <span style={{ color: C.muted, fontSize: 13 }}>{data.items.length}</span>
        <div style={{ flex: 1 }} />
        <input placeholder="Поиск по названию" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...inputStyle, minWidth: 220 }} />
      </div>
      <div style={{ ...card, padding: 0, overflow: "auto" }}>
        {list.length === 0 ? (
          <div style={{ padding: 20, color: C.muted, fontSize: 13 }}>
            {data.items.length ? "Ничего не найдено." : "Пока нет сохранённых расчётов."}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left", paddingLeft: 14 }}>Товар</th>
                <th style={th}>Изменён</th>
                <th style={th}>Кол-во</th>
                <th style={th}>Цена 1 шт</th>
                <th style={th}>Себестоимость 1 шт</th>
                <th style={th}>Партия</th>
                {canWrite && <th style={th} />}
              </tr>
            </thead>
            <tbody>
              {list.map((it) => (
                <tr key={it.id} onClick={() => open(it)} title="Открыть расчёт"
                  style={{ cursor: "pointer", background: it.id === editId ? soft("accent", 10) : undefined }}>
                  <td style={{ ...td, textAlign: "left", paddingLeft: 14, whiteSpace: "normal" }}>
                    <div style={{ fontWeight: 600 }}>{it.name}</div>
                    {it.note && <div style={{ fontSize: 12, color: C.muted }}>{it.note}</div>}
                  </td>
                  <td style={{ ...td, color: C.muted, fontSize: 12 }}>{fmtDate(it.updated_at)}</td>
                  <td style={td}>{nf.format(it.qty)}</td>
                  <td style={td}>{nf.format(it.price_cny)} ¥</td>
                  <td style={{ ...td, fontWeight: 700 }}>{fmtRub(it.result.unitRub)}</td>
                  <td style={td}>{fmtRub(it.result.totalRub)}</td>
                  {canWrite && (
                    <td style={td}>
                      <button onClick={(e) => { e.stopPropagation(); remove(it); }} disabled={busy}
                        title="Удалить расчёт" style={{ ...btnStyle, padding: "2px 8px", color: C.neg }}>✕</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Field({ label, unit, children }) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>
        {label}{unit && <span style={{ color: C.faint }}> · {unit}</span>}
      </div>
      {children}
    </label>
  );
}

function Centered({ children }) {
  return <div style={{ padding: 40, textAlign: "center", color: C.muted, fontFamily: FONT }}>{children}</div>;
}

const card = { background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18 };
const groupTitle = { fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 };
const inputStyle = { padding: "7px 10px", borderRadius: 6, fontSize: 14, background: C.bg, color: C.ink, border: `1px solid ${C.line}`, boxSizing: "border-box" };
const btnStyle = { padding: "7px 14px", fontSize: 13, fontWeight: 600, borderRadius: 7, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, cursor: "pointer" };
const btnPrimary = { background: C.accent, borderColor: C.accent, color: "var(--accentInk)" };
const th = { padding: "8px 10px", fontWeight: 600, fontSize: 11, color: C.muted, textAlign: "right", borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" };
const td = { padding: "8px 10px", textAlign: "right", borderTop: `1px solid ${soft("line", 60)}`, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
