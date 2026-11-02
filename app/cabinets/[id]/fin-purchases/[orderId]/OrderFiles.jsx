"use client";
import { C, soft } from "@/lib/palette.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { FILE_KINDS, ACCEPT, MAX_FILE_BYTES } from "@/lib/purchaseOrderFiles.js";
import { inp, btn } from "./styles";

// Документы заказа: накладные карго и фабрик. Рендерится только у владельца (OrderPage), а сервер
// (purchase-orders/files, requireRole 'owner') отказывает остальным и сам по себе.
const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const size = (b) => (b >= 1048576 ? `${nf1.format(b / 1048576)} МБ` : `${nf1.format(b / 1024)} КБ`);
const INLINE = /\.(pdf|jpe?g|png|webp)$/i;

export default function OrderFiles({ cabinetId, orderId }) {
  const base = `/api/cabinets/${cabinetId}/purchase-orders/files`;
  const [files, setFiles] = useState(null);
  const [kind, setKind] = useState("cargo");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const input = useRef(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`${base}?order_id=${orderId}`);
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setFiles(j.files); setErr(null);
    } catch (e) { console.error("order files load", e); setErr(String(e.message || e)); }
  }, [base, orderId]);
  useEffect(() => { reload(); }, [reload]);

  const upload = async (list) => {
    const picked = [...(list || [])];
    if (!picked.length) return;
    setBusy(true);
    try {
      for (const f of picked) {
        if (f.size > MAX_FILE_BYTES) { alert(`${f.name}: больше 10 МБ`); continue; }
        const fd = new FormData();
        fd.append("order_id", String(orderId)); fd.append("kind", kind); fd.append("file", f);
        const r = await fetch(base, { method: "POST", body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) alert(`${f.name}: ${j.error || `ошибка ${r.status}`}`);
      }
      await reload();
    } catch (e) { console.error("order files upload", e); alert(String(e.message || e)); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };

  const remove = async (f) => {
    if (!confirm(`Удалить «${f.file_name}»?`)) return;
    setBusy(true);
    try {
      const r = await fetch(`${base}?file_id=${f.id}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) alert(j.error || `Ошибка ${r.status}`);
      await reload();
    } catch (e) { console.error("order files delete", e); alert(String(e.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <section style={{ marginBottom: 22 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Документы <span style={{ fontSize: 13, color: C.muted, fontWeight: 400 }}>🔒 видите только вы — менеджерам не показываются</span></h2>
      {err && <div style={{ color: C.neg, fontSize: 13, marginBottom: 6 }}>Ошибка: {err}</div>}
      {files && files.length > 0 && (
        <table style={{ borderCollapse: "collapse", fontSize: 13, marginBottom: 8 }}>
          <thead><tr style={{ color: C.muted, textAlign: "left" }}>
            <th style={{ padding: 6 }}>Тип</th><th style={{ padding: 6 }}>Файл</th><th style={{ padding: 6 }}>Размер</th><th style={{ padding: 6 }}>Загружен</th><th />
          </tr></thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id} style={{ borderTop: `1px solid ${soft("line", 50)}` }}>
                <td style={{ padding: 6 }}>{FILE_KINDS[f.kind] || f.kind}</td>
                <td style={{ padding: 6 }}>
                  <a href={`${base}?file_id=${f.id}${INLINE.test(f.file_name) ? "&inline=1" : ""}`} target="_blank" rel="noopener noreferrer" style={{ color: C.accent }}>{f.file_name}</a>
                  {" "}<a href={`${base}?file_id=${f.id}`} title="Скачать" style={{ color: C.muted, textDecoration: "none" }}>⬇</a>
                </td>
                <td style={{ padding: 6, color: C.muted }}>{size(f.size_bytes)}</td>
                <td style={{ padding: 6, color: C.muted }}>{String(f.created_at).slice(0, 10)}</td>
                <td style={{ padding: 6 }}><button style={btn} disabled={busy} onClick={() => remove(f)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {files && files.length === 0 && <div style={{ color: C.muted, fontSize: 13, marginBottom: 8 }}>Пока нет документов.</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy} style={inp}>
          {Object.entries(FILE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input ref={input} type="file" multiple accept={ACCEPT} disabled={busy} style={{ display: "none" }} onChange={(e) => upload(e.target.files)} />
        <button style={{ ...btn, borderColor: C.accent }} disabled={busy} onClick={() => input.current?.click()}>{busy ? "Загрузка…" : "+ Загрузить"}</button>
        <span style={{ fontSize: 12, color: C.muted }}>PDF, фото, Excel, Word · до 10 МБ</span>
      </div>
    </section>
  );
}
