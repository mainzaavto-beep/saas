"use client";
import { C, soft, SERIES } from "@/lib/palette.js";
import { ALERT } from "@/lib/callout.js";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";
import {
  DOMAINS,
  DOMAIN_SHORT,
  DOMAIN_LABELS,
  DOMAIN_COLORS,
  CATEGORIES,
  CAT_COLORS,
  SOURCE_LABELS,
} from "@/lib/opexMeta";

// =====================================================================
//  /finance/manual — Сопутствующие расходы (OPEX, заявка №34, контракт №35).
//
//  Источник правды = ТОЛЬКО дашборд (НЕ Sheets). fin_data.db.opex.
//
//  ДОМЕНЫ (2026-07-02, голосовой финконтроль): одна таблица хранит бизнес- и
//  личные/семейные расходы. Переключатель «Все/Бизнес/Личное/Семья» фильтрует
//  список и итоги. ТОЛЬКО business попадает в P&L/ДДС (фильтр на стороне
//  читателей — здесь только показ).
//
//  ГОЛОСОВОЙ ВВОД (тест NER): кнопка 🎤 Диктовать → Web Speech API (Chrome)
//  распознаёт речь в текст → POST /api/cabinets/${cabinetId}/opex → карточка подтверждения
//  с правкой пальцем → «Сохранить» = POST /api/opex (source='voice').
//
//  ГРАФИКИ: PieChart по категориям + BarChart динамики по дням (recharts).
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽";
const num = (v) => (v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("ru-RU").format(v));
const curMonth = () => new Date().toISOString().slice(0, 7);
// 'YYYY-MM-DDTHH:MM' (datetime-local) — дефолт для поля «дата расхода» = сейчас.
const curLocalDT = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// ISO-строка из БД → 'DD.MM.YYYY HH:MM' для отображения.
function fmtDT(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// ISO → 'YYYY-MM-DDTHH:MM' для подстановки в <input type="datetime-local">.
function isoToLocalDT(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// ISO YYYY-MM-DD → DD.MM для оси BarChart.
function dayLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

// Тема (совпадает с соседними страницами кабинета).

// Запись OPEX-строки в ДДС (фиксация движения денег). Паттерн из соседних страниц.
const postToDds = async (opts) => {
  try {
    await fetch(`/api/cabinets/${opts.cabinetId || ""}/dds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
  } catch {}
};

const DOMAIN_FILTERS = ["all", ...DOMAINS]; // «Все» + 3 домена
const PIE_PALETTE = SERIES;

// Поддержка Web Speech API в браузере (Chrome). SSR-безопасно.
function getSpeechRecognition() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export default function OpexPage({ cabinetId }) {
  const [period, setPeriod] = useState(curMonth());
  const [domainFilter, setDomainFilter] = useState("all"); // all|business|personal|family
  const [items, setItems] = useState([]);
  const [totals, setTotals] = useState({ count: 0, total: 0, by_category: [], by_domain: [] });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Форма добавления. Домен по умолчанию — business (обратная совместимость).
  const [fDomain, setFDomain] = useState("business");
  const [fCategory, setFCategory] = useState(CATEGORIES[0]);
  const [fAmount, setFAmount] = useState("");
  const [fNote, setFNote] = useState("");
  const [fCounterparty, setFCounterparty] = useState("");
  const [fRecordedBy, setFRecordedBy] = useState("");
  const [fInCogs, setFInCogs] = useState(false); // «учтено в себестоимости»
  const [fOpDate, setFOpDate] = useState(curLocalDT());
  const [adding, setAdding] = useState(false);

  // Инлайн-редактирование
  const [editing, setEditing] = useState(null); // id
  const [editVal, setEditVal] = useState({ amount: "", note: "", counterparty: "", op_date: "" });

  // Голосовой ввод (Web Speech API + карточка подтверждения NER).
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);     // идёт запись?
  const [voiceBusy, setVoiceBusy] = useState(false);          // отправка на NER?
  const [voiceErr, setVoiceErr] = useState(null);
  const [preview, setPreview] = useState(null);               // entities из /api/cabinets/${cabinetId}/opex
  const recogRef = useRef(null);

  useEffect(() => {
    setVoiceSupported(!!getSpeechRecognition());
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ period });
    if (domainFilter !== "all") qs.set("domain", domainFilter);
    fetch(`/api/cabinets/${cabinetId}/opex?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else {
          setItems(d.items || []);
          // API отдаёт totals={count,total} и facets.categories=[{category,n,total}].
          // Собираем by_category из facets (с маппингом n→count), чтобы все места
          // фронта (pieData, KPI-карточки), ждущие totals.by_category, работали.
          const facets = d.facets || {};
          const byCategory = (facets.categories || []).map((c) => ({
            category: c.category,
            count: Number(c.n) || 0,
            total: Number(c.total) || 0,
          }));
          setTotals({ ...(d.totals || { count: 0, total: 0 }), by_category: byCategory });
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [period, domainFilter]);

  useEffect(() => { reload(); }, [reload]);

  // ---- Голосовой ввод ----
  function startVoice() {
    setVoiceErr(null);
    const SR = getSpeechRecognition();
    if (!SR) {
      setVoiceErr("Голосовой ввод не поддерживается этим браузером. Используйте Chrome.");
      return;
    }
    if (fDomain === "all") {
      setVoiceErr("Выберите домен (Бизнес/Личное/Семья) перед диктовкой.");
      return;
    }
    const recog = new SR();
    recog.lang = "ru-RU";
    recog.interimResults = false;
    recog.maxAlternatives = 1;
    recog.onresult = async (ev) => {
      const text = Array.from(ev.results || [])
        .map((r) => r[0]?.transcript || "")
        .join(" ")
        .trim();
      setVoiceActive(false);
      if (!text) {
        setVoiceErr("Не удалось распознать речь. Попробуйте ещё раз.");
        return;
      }
      await sendToNER(text);
    };
    recog.onerror = (ev) => {
      setVoiceActive(false);
      setVoiceErr("Ошибка распознавания: " + (ev?.error || "неизвестно"));
    };
    recog.onend = () => setVoiceActive(false);
    recogRef.current = recog;
    setVoiceActive(true);
    recog.start();
  }
  function stopVoice() {
    try { recogRef.current?.stop(); } catch { /* */ }
    setVoiceActive(false);
  }
  async function sendToNER(text) {
    setVoiceBusy(true);
    setVoiceErr(null);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/voice-expense`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, domain: fDomain }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setVoiceErr("NER: " + (d.error || "ошибка"));
        return;
      }
      setPreview({ ...d.entities, _text: text });
    } catch (e) {
      setVoiceErr("Сеть: " + e.message);
    } finally {
      setVoiceBusy(false);
    }
  }
  // Сохранение из карточки подтверждения (preview → POST /api/opex с source='voice').
  async function confirmPreview() {
    if (!preview) return;
    const amount = Number(preview.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setVoiceErr("Сумма не распознана — введите вручную в карточке.");
      return;
    }
    setAdding(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/opex`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period: preview.period || period,
          domain: preview.domain || fDomain,
          category: preview.category,
          amount,
          note: preview.note || null,
          counterparty: preview.counterparty || null,
          op_date: preview.op_date || curLocalDT(),
          source: "voice",
          recorded_by: fRecordedBy || null,
          included_in_cogs: fInCogs ? 1 : 0,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        setVoiceErr("Не сохранилось: " + (d.error || ""));
        return;
      }
      setPreview(null);
      reload();
    } catch (e) {
      setVoiceErr("Ошибка: " + e.message);
    } finally {
      setAdding(false);
    }
  }

  // ---- Ручной ввод ----
  async function addRecord() {
    const amount = Number(fAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Сумма должна быть числом > 0");
      return;
    }
    setAdding(true);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/opex`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period,
          domain: fDomain,
          category: fCategory,
          amount,
          note: fNote || null,
          counterparty: fCounterparty || null,
          op_date: fOpDate || null,
          source: "manual",
          recorded_by: fRecordedBy || null,
          included_in_cogs: fInCogs ? 1 : 0,
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        alert("Не добавилось: " + (d.error || ""));
        return;
      }
      setFAmount("");
      setFNote("");
      setFCounterparty("");
      setFInCogs(false);
      setFOpDate(curLocalDT());
      reload();
    } catch (e) {
      alert("Ошибка: " + e.message);
    } finally {
      setAdding(false);
    }
  }

  function startEdit(it) {
    setEditing(it.id);
    setEditVal({
      amount: String(it.amount),
      note: it.note || "",
      counterparty: it.counterparty || "",
      op_date: isoToLocalDT(it.op_date),
      domain: it.domain || "business",
      included_in_cogs: !!(it.included_in_cogs),
    });
  }

  async function saveEdit(it) {
    const amount = Number(editVal.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("Сумма должна быть числом > 0");
      return;
    }
    const r = await fetch(`/api/cabinets/${cabinetId}/opex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: it.id,
        period: it.period,
        domain: editVal.domain || it.domain || "business",
        category: it.category,
        amount,
        note: editVal.note || null,
        counterparty: editVal.counterparty || null,
        op_date: editVal.op_date || null,
        included_in_cogs: editVal.included_in_cogs ? 1 : 0,
      }),
    });
    const d = await r.json();
    if (!r.ok || d.error) {
      alert("Не сохранилось: " + (d.error || ""));
      return;
    }
    setEditing(null);
    reload();
  }

  async function delRecord(id) {
    if (!confirm("Удалить запись? (мягкое удаление — остаётся в аудите)")) return;
    const r = await fetch(`/api/cabinets/${cabinetId}/opex?id=${id}`, { method: "DELETE" });
    const d = await r.json();
    if (!r.ok || d.error) {
      alert("Не удалилось: " + (d.error || ""));
      return;
    }
    reload();
  }

  // ↧ Записать эту OPEX-строку в ДДС (фиксация движения). Только для business.
  async function postToDdsRecord(it) {
    const date = it.op_date || (period + "-01");
    if (!confirm(`Записать OPEX «${it.category}» ${money(it.amount)} от ${date} в ДДС?`)) return;
    try {
      await postToDds({
        date, type: "expense", amount: it.amount,
        category: it.category, source: "auto_opex",
        reference: `opex:${it.id}`,
        description: it.note || `OPEX ${it.category}`,
        counterparty: it.counterparty, status: "planned",
      });
      alert("Записано в ДДС (статус: planned).");
    } catch (e) {
      alert("Не получилось: " + e.message);
    }
  }

  // Данные для графиков (на основе загруженных items — уже отфильтрованы по домену).
  const pieData = (totals.by_category || []).map((b) => ({ name: b.category, value: b.total }));
  // Динамика по дням: группируем op_date (без времени) → сумма.
  const byDay = {};
  for (const it of items) {
    if (!it.op_date) continue;
    const day = String(it.op_date).slice(0, 10); // YYYY-MM-DD
    byDay[day] = (byDay[day] || 0) + Number(it.amount || 0);
  }
  const barData = Object.keys(byDay).sort().map((d) => ({ day: d, label: dayLabel(d), amount: Math.round(byDay[d] * 100) / 100 }));

  // При смене домена формы: категория сбрасывается на допустимую (enum для business).
  function onFDomainChange(d) {
    setFDomain(d);
    if (d === "business" && !CATEGORIES.includes(fCategory)) setFCategory(CATEGORIES[0]);
  }

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1200, margin: "0 auto" }}>
      <Header period={period} domainFilter={domainFilter} />

      {/* Плашка методологии */}
      <div style={{ ...alertStyle, marginBottom: 16 }}>
        <strong>Сопутствующие расходы</strong> — ручной и голосовой ввод затрат. Переключатель домена
        разделяет потоки: <strong>Бизнес</strong> (Коммерческие/Административные/Прочие — попадает в
        P&L и ДДС), <strong>Личное</strong> и <strong>Семья</strong> (свободные категории — в бизнес-отчёты
        НЕ идут). Источник правды = дашборд. Голос: 🎤 → распознавание → подтверждение.
      </div>

      {/* Фильтры: месяц + домен */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <Field label="Месяц">
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={inputStyle} />
        </Field>
        <div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>Домен</div>
          <Segmented
            value={domainFilter}
            options={DOMAIN_FILTERS.map((d) => ({ id: d, label: DOMAIN_SHORT[d] || "Все" }))}
            onChange={setDomainFilter}
          />
        </div>
        {/* Голосовая кнопка */}
        <div style={{ marginLeft: "auto" }}>
          {voiceActive ? (
            <button onClick={stopVoice} style={{ ...voiceBtnRec, background: C.neg, color: "#0A1A1C" }}>
              ⏹ Стоп
            </button>
          ) : (
            <button
              onClick={startVoice}
              disabled={!voiceSupported || voiceBusy}
              title={voiceSupported ? "Диктовать расход" : "Голос не поддерживается (нужен Chrome)"}
              style={{ ...voiceBtn, opacity: voiceSupported ? 1 : 0.5, cursor: voiceSupported ? "pointer" : "not-allowed" }}
            >
              🎤 Диктовать
            </button>
          )}
        </div>
      </div>

      {voiceErr && (
        <div style={{ padding: "8px 12px", margin: "0 0 12px", borderRadius: 8, fontSize: 13, background: ALERT.warn.background, border: ALERT.warn.border, color: ALERT.warn.color }}>
          ⚠ {voiceErr}
        </div>
      )}

      {/* Карточка подтверждения NER (после диктовки) */}
      {preview && (
        <PreviewCard
          preview={preview}
          domain={fDomain}
          onChange={setPreview}
          onConfirm={confirmPreview}
          onCancel={() => { setPreview(null); setVoiceErr(null); }}
          busy={adding}
        />
      )}

      {/* KPI */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Σ расходов" value={money(totals.total)} color={C.neg} />
        <Kpi label="Записей" value={num(totals.count)} />
        {(totals.by_category || []).map((b) => (
          <Kpi key={b.category} label={b.category} value={money(b.total)} hint={`${b.count} зап.`} />
        ))}
        {totals.count === 0 && <Kpi label="—" value="нет данных за период" />}
      </div>

      {/* Графики */}
      {(pieData.length > 0 || barData.length > 0) && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 18 }}>
          {pieData.length > 0 && (
            <div style={{ ...chartCardStyle, flex: "1 1 320px" }}>
              <div style={chartTitleStyle}>Структура по категориям</div>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75} innerRadius={40} paddingAngle={2}>
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={PIE_PALETTE[i % PIE_PALETTE.length]} stroke={C.bg} strokeWidth={1} />
                    ))}
                  </Pie>
                  <Tooltip content={<DarkTooltip money />} />
                </PieChart>
              </ResponsiveContainer>
              <Legend items={pieData.map((p, i) => ({ label: p.name, color: PIE_PALETTE[i % PIE_PALETTE.length] }))} />
            </div>
          )}
          {barData.length > 0 && (
            <div style={{ ...chartCardStyle, flex: "1 1 420px" }}>
              <div style={chartTitleStyle}>Динамика по дням</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={barData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: C.faint, fontSize: 11 }} tickLine={false} axisLine={{ stroke: C.line }} />
                  <YAxis tick={{ fill: C.faint, fontSize: 11 }} tickLine={false} axisLine={false} width={48}
                    tickFormatter={(v) => new Intl.NumberFormat("ru-RU", { notation: "compact" }).format(v)} />
                  <Tooltip content={<DarkTooltip money />} cursor={{ fill: "rgba(0,229,255,0.06)" }} />
                  <Bar dataKey="amount" fill={C.accent} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Форма добавления */}
      <div style={formCardStyle}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Домен">
            <select value={fDomain} onChange={(e) => onFDomainChange(e.target.value)} style={{ ...inputStyle, width: 120 }}>
              {DOMAINS.map((d) => (
                <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>
              ))}
            </select>
          </Field>
          <Field label="Дата расхода">
            <input
              type="datetime-local"
              value={fOpDate}
              onChange={(e) => setFOpDate(e.target.value)}
              style={inputStyle}
            />
          </Field>
          {fDomain === "business" ? (
            <Field label="Категория">
              <select value={fCategory} onChange={(e) => setFCategory(e.target.value)} style={inputStyle}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Категория (свободная)">
              <input
                value={fCategory}
                onChange={(e) => setFCategory(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addRecord(); }}
                placeholder="Продукты, Транспорт…"
                style={{ ...inputStyle, width: 180 }}
              />
            </Field>
          )}
          <Field label="Сумма ₽">
            <input
              type="number"
              value={fAmount}
              onChange={(e) => setFAmount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addRecord(); }}
              placeholder="0.00"
              style={{ ...inputStyle, width: 130 }}
            />
          </Field>
          <Field label="Контрагент">
            <input
              value={fCounterparty}
              onChange={(e) => setFCounterparty(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addRecord(); }}
              placeholder="кому (опц.)"
              style={{ ...inputStyle, width: 180 }}
            />
          </Field>
          <Field label="Кто записал">
            <input
              value={fRecordedBy}
              onChange={(e) => setFRecordedBy(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addRecord(); }}
              placeholder="имя (опц.)"
              style={{ ...inputStyle, width: 130 }}
            />
          </Field>
          <Field label="Описание">
            <input
              value={fNote}
              onChange={(e) => setFNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addRecord(); }}
              placeholder="за что (опц.)"
              style={{ ...inputStyle, width: 220 }}
            />
          </Field>
          <label
            title="Поставьте, если этот расход (доставка, таможня и т.п.) размазывается на себестоимость товара. Тогда он НЕ плюсуется в прибыль (P&L) повторно — но в ДДС остаётся (деньги ушли)."
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.muted, cursor: "pointer", paddingTop: 18 }}
          >
            <input
              type="checkbox"
              checked={fInCogs}
              onChange={(e) => setFInCogs(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: C.accent, cursor: "pointer" }}
            />
            🏷️ в себест.
          </label>
          <button onClick={addRecord} disabled={adding} style={addBtnStyle}>
            {adding ? "…" : "+ Добавить"}
          </button>
        </div>
      </div>

      {error && <div style={{ color: C.neg, margin: "12px 0" }}>⚠ {error}</div>}

      {/* Таблица записей */}
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10, marginTop: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: C.surface, borderBottom: `1px solid ${C.line}` }}>
              <th style={thLeft}>Дата</th>
              <th style={thLeft}>Домен</th>
              <th style={thLeft}>Категория</th>
              <th style={thR}>Сумма</th>
              <th style={thLeft}>Контрагент</th>
              <th style={thLeft}>Описание</th>
              <th style={thR}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr
                key={it.id}
                style={{
                  borderBottom: `1px solid ${soft("line", 20)}`,
                  background: it.included_in_cogs ? "rgba(217,176,140,0.06)" : "transparent",
                }}
              >
                {editing === it.id ? (
                  <>
                    <td style={{ padding: "4px 10px" }}>
                      <input
                        type="datetime-local"
                        value={editVal.op_date}
                        onChange={(e) => setEditVal({ ...editVal, op_date: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") saveEdit(it); if (e.key === "Escape") setEditing(null); }}
                        style={{ ...inputStyle, padding: "3px 6px", fontSize: 12 }}
                      />
                    </td>
                    <td style={{ padding: "4px 10px" }}>
                      <select
                        value={editVal.domain || it.domain || "business"}
                        onChange={(e) => setEditVal({ ...editVal, domain: e.target.value })}
                        style={{ ...inputStyle, padding: "3px 6px", fontSize: 12, marginBottom: 4 }}
                      >
                        {DOMAINS.map((d) => (
                          <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>
                        ))}
                      </select>
                      <label
                        title="Учтено в себестоимости: исключается из P&L (идёт через COGS товара), но остаётся в ДДС"
                        style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: C.muted, cursor: "pointer", whiteSpace: "nowrap" }}
                      >
                        <input
                          type="checkbox"
                          checked={!!editVal.included_in_cogs}
                          onChange={(e) => setEditVal({ ...editVal, included_in_cogs: e.target.checked })}
                          style={{ width: 14, height: 14, accentColor: C.accent2, cursor: "pointer" }}
                        />
                        🏷️ в себест.
                      </label>
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ ...badgeStyle, background: CAT_COLORS[it.category] || C.surface }}>{it.category}</span>
                    </td>
                    <td style={tdRight}>
                      <input
                        autoFocus
                        type="number"
                        value={editVal.amount}
                        onChange={(e) => setEditVal({ ...editVal, amount: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") saveEdit(it); if (e.key === "Escape") setEditing(null); }}
                        style={{ ...inputStyle, width: 110, padding: "3px 6px" }}
                      />
                    </td>
                    <td style={{ padding: "4px 10px" }}>
                      <input
                        value={editVal.counterparty}
                        onChange={(e) => setEditVal({ ...editVal, counterparty: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") saveEdit(it); if (e.key === "Escape") setEditing(null); }}
                        placeholder="кому"
                        style={{ ...inputStyle, width: "100%", padding: "3px 6px" }}
                      />
                    </td>
                    <td style={{ padding: "4px 10px" }}>
                      <input
                        value={editVal.note}
                        onChange={(e) => setEditVal({ ...editVal, note: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") saveEdit(it); if (e.key === "Escape") setEditing(null); }}
                        style={{ ...inputStyle, width: "100%", padding: "3px 6px" }}
                      />
                    </td>
                    <td style={tdRight}>
                      <button onClick={() => saveEdit(it)} style={{ ...miniBtn, color: C.pos, marginRight: 4 }}>✓</button>
                      <button onClick={() => setEditing(null)} style={miniBtn}>✕</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td style={{ padding: "8px 10px", color: C.muted, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", fontSize: 12.5 }}>
                      {fmtDT(it.op_date)}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <DomainBadge domain={it.domain} source={it.source} inCogs={it.included_in_cogs} />
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ ...badgeStyle, background: CAT_COLORS[it.category] || C.surface }}>{it.category}</span>
                    </td>
                    <td style={tdRight}><strong style={{ color: C.neg }}>{money(it.amount)}</strong></td>
                    <td style={{ padding: "8px 10px", color: C.ink }}>{it.counterparty || <span style={{ color: C.faint }}>—</span>}</td>
                    <td style={{ padding: "8px 10px", color: C.muted }}>{it.note || "—"}</td>
                    <td style={tdRight}>
                      <button onClick={() => startEdit(it)} style={miniBtn} title="Править">✎</button>
                      {it.domain !== "business" ? null : (
                        <button onClick={() => postToDdsRecord(it)} style={{ ...miniBtn, color: C.accent, marginLeft: 4 }} title="Записать в ДДС">↧</button>
                      )}
                      <button onClick={() => delRecord(it.id)} style={{ ...miniBtn, color: C.neg, marginLeft: 4 }} title="Удалить">🗑</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
            {items.length === 0 && !loading && (
              <tr>
                <td colSpan={7} style={{ padding: 24, textAlign: "center", color: C.faint }}>
                  Нет записей за {period}
                  {domainFilter !== "all" ? ` (домен: ${DOMAIN_LABELS[domainFilter]})` : ""}. Добавьте первую через форму выше или наговорите 🎤.
                </td>
              </tr>
            )}
          </tbody>
          {items.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: `2px solid ${C.line}`, background: C.surface, fontWeight: 700 }}>
                <td style={tdLeftFoot}>Итого ({totals.count})</td>
                <td></td>
                <td></td>
                <td style={tdFootR}><span style={{ color: C.neg }}>{money(totals.total)}</span></td>
                <td colSpan={3}></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ---------------- UI-компоненты ----------------

function Header({ period, domainFilter }) {
  const dLabel = domainFilter === "all" ? "все домены" : DOMAIN_LABELS[domainFilter];
  return (
    <div style={{ marginBottom: 14 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Сопутствующие расходы</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        Затраты за {period} · {dLabel}. Ручной и голосовой ввод.
      </p>
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div style={{ display: "inline-flex", gap: 4, background: C.surfaceAlt, borderRadius: 10, padding: 3 }}>
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          style={{
            border: "none", padding: "6px 14px", borderRadius: 8,
            fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer",
            background: value === o.id ? C.accent : "transparent",
            color: value === o.id ? "var(--accentInk)" : C.muted,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function DomainBadge({ domain, source, inCogs }) {
  const d = domain || "business";
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <span style={{ ...badgeStyle, background: DOMAIN_COLORS[d] || C.surface }}>{DOMAIN_LABELS[d] || d}</span>
      {source === "voice" && (
        <span title="Голосовой ввод" style={{ fontSize: 11 }}>🎤</span>
      )}
      {inCogs ? (
        <span
          title="Учтено в себестоимости — не плюсуется в P&L (идёт через COGS товара), но остаётся в ДДС"
          style={{ ...badgeStyle, background: "rgba(217,176,140,0.22)", color: C.accent2 }}
        >
          🏷️ себест.
        </span>
      ) : null}
    </span>
  );
}

// Карточка подтверждения распознанного расхода (после NER).
function PreviewCard({ preview, domain, onChange, onConfirm, onCancel, busy }) {
  const set = (patch) => onChange({ ...preview, ...patch });
  const isBusiness = (preview.domain || domain) === "business";
  return (
    <div style={previewCardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ color: C.accent }}>🎤 Распознано — проверьте и сохраните</strong>
        {preview._fallback && (
          <span style={{ ...badgeStyle, background: ALERT.warn.background, color: ALERT.warn.color, border: ALERT.warn.border }}>
            ⚠ часть полей — оценка
          </span>
        )}
      </div>
      <div style={{ opacity: 0.7, fontSize: 12, color: C.muted, marginBottom: 10, fontStyle: "italic" }}>
        «{preview._text || ""}»
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Сумма ₽">
          <input
            type="number"
            value={preview.amount ?? ""}
            onChange={(e) => set({ amount: e.target.value })}
            style={{ ...inputStyle, width: 120 }}
          />
        </Field>
        {isBusiness ? (
          <Field label="Категория">
            <select value={preview.category} onChange={(e) => set({ category: e.target.value })} style={inputStyle}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        ) : (
          <Field label="Категория">
            <input value={preview.category} onChange={(e) => set({ category: e.target.value })} style={{ ...inputStyle, width: 160 }} />
          </Field>
        )}
        <Field label="Дата">
          <input
            type="date"
            value={(preview.op_date || "").slice(0, 10)}
            onChange={(e) => set({ op_date: e.target.value, period: e.target.value.slice(0, 7) })}
            style={inputStyle}
          />
        </Field>
        <Field label="Контрагент">
          <input value={preview.counterparty || ""} onChange={(e) => set({ counterparty: e.target.value })} placeholder="кому (опц.)" style={{ ...inputStyle, width: 160 }} />
        </Field>
        <Field label="Описание">
          <input value={preview.note || ""} onChange={(e) => set({ note: e.target.value })} style={{ ...inputStyle, width: 200 }} />
        </Field>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onConfirm} disabled={busy} style={addBtnStyle}>{busy ? "…" : "✓ Сохранить"}</button>
          <button onClick={onCancel} style={miniBtn}>✕ Отмена</button>
        </div>
      </div>
      {preview._parse_warning && (
        <div style={{ marginTop: 8, fontSize: 12, color: ALERT.warn.color }}>⚠ {preview._parse_warning}</div>
      )}
    </div>
  );
}

function DarkTooltip({ active, payload, label, money: asMoney }) {
  if (!active || !payload || !payload.length) return null;
  const v = payload[0].value;
  const name = payload[0].name || label;
  return (
    <div style={{ background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 10px", fontSize: 12, color: C.ink }}>
      <div style={{ color: C.muted }}>{name}</div>
      <div style={{ fontWeight: 700 }}>{asMoney ? money(v) : num(v)}</div>
    </div>
  );
}

function Legend({ items }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", marginTop: 8, justifyContent: "center" }}>
      {items.map((it, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: C.muted }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: it.color, display: "inline-block" }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function Kpi({ label, value, color, hint }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 160px", minWidth: 140 }} title={hint}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || C.ink }}>{value}</div>
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
const addBtnStyle = {
  padding: "8px 18px", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer",
  background: C.accent, color: "var(--accentInk)", border: "none",
};
const miniBtn = {
  padding: "4px 10px", borderRadius: 6, fontSize: 13, cursor: "pointer",
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const voiceBtn = {
  padding: "9px 18px", borderRadius: 8, fontSize: 14, fontWeight: 700,
  background: C.surface, color: C.ink, border: `1px solid ${C.line}`,
};
const voiceBtnRec = {
  padding: "9px 18px", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer",
  border: "none",
};
const badgeStyle = { padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" };
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left" };
const thR = { ...thLeft, textAlign: "right" };
const tdRight = { padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const tdLeftFoot = { padding: "10px", textAlign: "left" };
const tdFootR = { padding: "10px", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const formCardStyle = {
  background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10,
  padding: "14px 16px",
};
const chartCardStyle = {
  background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px",
};
const chartTitleStyle = { fontSize: 12, color: C.muted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.3 };
const previewCardStyle = {
  background: "rgba(0,229,255,0.06)", border: `1px solid ${soft("accent", 33)}`, borderRadius: 10,
  padding: "14px 16px", marginBottom: 16,
};
const alertStyle = {
  padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
  background: C.surface, border: `1px solid ${C.line}`, color: C.muted,
};
