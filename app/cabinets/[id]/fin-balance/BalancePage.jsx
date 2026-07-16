"use client";
import { C, soft } from "@/lib/palette.js";

import { useEffect, useState, useCallback } from "react";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";

// postToDds заглушён — будет запись в ДДС после сохранения баланса (отдельная задача).
const postToDds = async (opts) => { try { await fetch(`/api/cabinets/${opts.cabinetId || ""}/dds`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) }); } catch {} };

// =====================================================================
//  /finance/balance — бухгалтерский баланс актив/пассив (заявка №38).
//
//  Источник правды = fin_data.db.balance_snapshot (дашборд-first). Sheets = backup.
//  Снапшот на дату (UNIQUE): повторный ввод = replace. Поля вводятся вручную
//  (бухгалтерский, НЕ авто-расчёт). assets/liabilities/net_worth — расчётные.
//
//  Счета ИП/физлица (заявка №38-счета, 2026-06-25): «Деньги на счетах» = авто-сумма
//  всех счетов (решение «Заменить сумму»). Каталог счётов редактируемый — тянется
//  во все снапшоты; add/rename/soft-delete через /api/balance-accounts.
// =====================================================================

const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const money = (v) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽";
const today = () => new Date().toISOString().slice(0, 10);

// Поля, которые НЕ редактируются (read-only авто-расчёт):
//   cash_on_hand  = сумма счетов ИП/физлица
//   stock_value   = авто-себестоимость остатков МП (lib/mpStockValue по дате)
//   ff_stock      = авто-себестоимость остатков склад/ФФ (lib/ffStockValue по дате)
const ASSETS = [
  ["cash_on_hand", "Деньги на счетах", true /* readOnly */],
  ["mp_balance", "Деньги в кабинете МП", true /* readOnly, авто по API (WB+Ozon, Яндекс=0) */],
  ["stock_value", "Товар на складах МП (×себест.)", true /* readOnly, авто из остатков */],
  ["ff_stock", "Склад/ФФ (товар у фулфилмента)", true /* readOnly, авто из /items/ff-stock */],
  ["stock_in_transit", "Товар в пути (×себест.)", true /* readOnly, авто из закупок */],
  // receivables (дебиторка) ВЫНЕСЕНО в отдельную секцию «ПОД ВОПРОСОМ» — в активы не входит.
  ["other_assets", "Прочие активы", false],
];
const LIABILITIES = [
  ["payables", "Кредиторка (мы должны)"],
  ["loans", "Кредиты / займы"],
  ["owner_equity", "Вложения владельца (ИП)"],
  ["retained_earnings", "Накопленная прибыль"],
  ["other_liabilities", "Прочие пассивы"],
];

const SUBJECTS = [
  ["ip", "ИП"],
  ["person", "Физлицо"],
];

export default function BalancePage({ cabinetId }) {
  const [date, setDate] = useState(today());
  const [snap, setSnap] = useState(null);
  const [history, setHistory] = useState([]);
  const [available, setAvailable] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(null);

  // Форма активов/пассивов (cash_on_hand — вычисляется из счетов, read-only в форме).
  const [form, setForm] = useState(emptyForm());
  const [note, setNote] = useState("");

  // Счета: суммы на дату (formAccounts) + каталог (catalog).
  const [accounts, setAccounts] = useState([]);     // [{subject, account_name, amount}]
  const [catalog, setCatalog] = useState([]);        // [{id, subject, account_name, sort_order}]

  // Дебиторка «ПОД ВОПРОСОМ» (в активы/net_worth не входит): [{source, amount, note, received}]
  const [receivables, setReceivables] = useState([]);

  // Себестоимость остатков МП на дату (расшифровка stock_value): {wb, ozon, yandex, total}.
  const [stockBr, setStockBr] = useState({ wb: 0, ozon: 0, yandex: 0, total: 0, dateWb: null, dateOzon: null });
  // Себестоимость остатков на складе/ФФ на дату (расшифровка ff_stock): {total, date, byLocation[], rows}.
  const [ffStockBr, setFfStockBr] = useState({ total: 0, date: null, byLocation: [], rows: 0 });
  // «Товар в пути» из закупок (расшифровка stock_in_transit): {total, count, items[]}.
  const [inTransit, setInTransit] = useState({ total: 0, count: 0, items: [] });
  // «Деньги в кабинете МП» по API (расшифровка mp_balance): {wb, ozon, yandex, total}.
  const [mpBal, setMpBal] = useState({ wb: 0, ozon: 0, yandex: 0, total: 0, cached: false });

  const loadSnapshot = useCallback(async (d) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/balance?date=${d}`);
      const data = await r.json();
      if (data.error) { setError(data.error); return; }
      setSnap(data.snapshot);
      setAvailable(data.available_dates || []);
      const s = data.snapshot || {};
      setForm({ ...emptyForm(), ...pickAll(s) });
      setNote(s.note || "");
      // Счета на дату + каталог.
      const cat = data.catalog || [];
      setCatalog(cat);
      const accs = data.accounts || [];
      setAccounts(buildAccountsState(cat, accs));
      // Дебиторка «ПОД ВОПРОСОМ» на дату.
      setReceivables((data.receivables || []).map((r) => ({ source: r.source, amount: r.amount, note: r.note || "", received: !!r.received })));
      // Себестоимость остатков МП на дату (расшифровка stock_value).
      setStockBr(data.stockBreakdown || { wb: 0, ozon: 0, yandex: 0, total: 0 });
      // Себестоимость остатков на складе/ФФ на дату (расшифровка ff_stock).
      setFfStockBr(data.ffStockBreakdown || { total: 0, date: null, byLocation: [], rows: 0 });
      // «Товар в пути» из закупок (расшифровка stock_in_transit).
      setInTransit(data.inTransitBreakdown || { total: 0, count: 0, items: [] });
      // «Деньги в кабинете МП» по API (расшифровка mp_balance).
      setMpBal(data.mpBalanceBreakdown || { wb: 0, ozon: 0, yandex: 0, total: 0, cached: false });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/balance?history=1`);
      const data = await r.json();
      if (!data.error) setHistory(data.items || []);
    } catch {}
  }, []);

  useEffect(() => { loadSnapshot(date); }, [date, loadSnapshot]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // ↧ Записать Δ денег (cash_on_hand) между снапшотами в ДДС.
  // delta>0 = деньги пришли (income), delta<0 = ушли (expense).
  async function postDeltaToDds(snap, delta) {
    const type = delta >= 0 ? "income" : "expense";
    if (!confirm(`Записать в ДДС: ${type === "income" ? "поступление" : "списание"} ${money(Math.abs(delta))} на ${snap.as_of_date} (Δ денег между снапшотами)?`)) return;
    try {
      await postToDds({
        date: snap.as_of_date, type, amount: Math.abs(delta),
        category: "Корректировка баланса", source: "auto_balance",
        reference: `balance:${snap.as_of_date}`,
        description: `Δ cash_on_hand (корректировка баланса на ${snap.as_of_date})`,
        status: "planned",
      });
      alert("Записано в ДДС (статус: planned).");
    } catch (e) {
      alert("Не получилось: " + e.message);
    }
  }

  // cash_on_hand (live preview) = сумма всех введённых счетов.
  // stock_value (live preview) = авто-себестоимость остатков МП из stockBr (read-only).
  // ff_stock (live preview) = авто-себестоимость остатков склад/ФФ из ffStockBr (read-only).
  const accountsSum = accounts.reduce((s, a) => s + (Number(a.amount) || 0), 0);
  const formWithStock = { ...form, cash_on_hand: accountsSum, stock_value: stockBr.total, ff_stock: ffStockBr.total, stock_in_transit: inTransit.total, mp_balance: mpBal.total };

  async function save() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert("Дата должна быть ГГГГ-ММ-ДД"); return; }
    setSaving(true);
    setSavedMsg(null);
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          as_of_date: date,
          fields: formWithStock,
          note: note || null,
          accounts: accounts.map((a) => ({ subject: a.subject, account_name: a.account_name, amount: Number(a.amount) || 0 })),
          receivables: receivables.map((r) => ({ source: r.source, amount: Number(r.amount) || 0, note: r.note || null, received: r.received ? 1 : 0 })),
        }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { alert("Не сохранилось: " + (d.error || "")); return; }
      setSnap(d.snapshot);
      setAccounts(buildAccountsState(d.catalog || catalog, d.accounts || []));
      if (d.receivables) setReceivables(d.receivables.map((r) => ({ source: r.source, amount: r.amount, note: r.note || "", received: !!r.received })));
      if (d.stockBreakdown) setStockBr(d.stockBreakdown);
      if (d.ffStockBreakdown) setFfStockBr(d.ffStockBreakdown);
      if (d.inTransitBreakdown) setInTransit(d.inTransitBreakdown);
      if (d.mpBalanceBreakdown) setMpBal(d.mpBalanceBreakdown);
      setSavedMsg(`✅ Снапшот на ${date} сохранён`);
      loadHistory();
    } catch (e) {
      alert("Ошибка: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  // --- Каталог: добавить / переименовать / удалить счёт. ---
  async function addAccount(subject, name) {
    const clean = (name || "").trim();
    if (!clean) return;
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, account_name: clean }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { alert("Не удалось добавить: " + (d.error || "")); return; }
      // Перезагружаем каталог и аккуратно добавляем новый счёт в форму с суммой 0.
      const cat = await reloadCatalog();
      setAccounts(buildAccountsState(cat, accounts));
    } catch (e) {
      alert("Ошибка: " + e.message);
    }
  }
  async function renameAccount(id, newName) {
    const clean = (newName || "").trim();
    if (!clean) return;
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/balance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, account_name: clean }),
      });
      const d = await r.json();
      if (!r.ok || d.error) { alert("Не удалось переименовать: " + (d.error || "")); return; }
      // Локально переименовываем и в форме (сумма сохраняется), и в каталоге.
      setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, account_name: clean } : a)));
      setCatalog((prev) => prev.map((c) => (c.id === id ? { ...c, account_name: clean } : c)));
    } catch (e) {
      alert("Ошибка: " + e.message);
    }
  }
  async function removeAccount(id) {
    if (!confirm("Убрать счёт из каталога? Исторические снапшоты не затрагиваются.")) return;
    try {
      const r = await fetch(`/api/cabinets/${cabinetId}/balance?id=${id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok || d.error) { alert("Не удалось удалить: " + (d.error || "")); return; }
      const cat = await reloadCatalog();
      setAccounts(buildAccountsState(cat, accounts));
    } catch (e) {
      alert("Ошибка: " + e.message);
    }
  }
  async function reloadCatalog() {
    const r = await fetch(`/api/cabinets/${cabinetId}/balance`);
    const d = await r.json();
    const cat = d.items || [];
    setCatalog(cat);
    return cat;
  }

  // Установить сумму счёта в локальной форме.
  function setAccountAmount(subject, accountName, value) {
    setAccounts((prev) =>
      prev.map((a) =>
        a.subject === subject && a.account_name === accountName
          ? { ...a, amount: value === "" ? "" : Number(value) }
          : a
      )
    );
  }

  // Расчётные totals из формы (live preview).
  const assetsTotal = sumCols(formWithStock, ASSETS.map(([k]) => k));
  const liabTotal = sumCols(form, LIABILITIES.map(([k]) => k));
  const netWorth = assetsTotal - liabTotal;

  const chartData = [...history].reverse().map((h) => ({
    date: h.as_of_date,
    net: h.net_worth ?? 0,
    assets: h.assets_total ?? 0,
    liabilities: h.liabilities_total ?? 0,
  }));

  return (
    <div style={{ fontFamily: FONT, color: C.ink, padding: "20px 28px", maxWidth: 1300, margin: "0 auto" }}>
      <Header />

      <div style={{ ...alertStyle, marginBottom: 16 }}>
        <strong>Баланс</strong> — бухгалтерский актив/пассив на дату (снапшот). Вводится вручную
        (НЕ авто-расчёт). Один снапшот на дату: повторный ввод на ту же дату = замена.
        <strong> net_worth = активы − пассивы.</strong> «Деньги на счетах» = авто-сумма счетов
        ИП + Физлицо. Источник правды = дашборд, Sheets = backup.
      </div>

      {/* Селектор даты + сохранение */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
        <Field label="Снапшот на дату">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        </Field>
        {available.length > 0 && (
          <Field label="Или выбрать существующий">
            <select value={snap?.as_of_date || ""} onChange={(e) => setDate(e.target.value)} style={inputStyle}>
              <option value="">—</option>
              {available.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
        )}
        <button onClick={save} disabled={saving} style={addBtnStyle}>
          {saving ? "⏳" : "💾 Сохранить снапшот"}
        </button>
        {savedMsg && <span style={{ color: C.pos, fontSize: 13, alignSelf: "center" }}>{savedMsg}</span>}
      </div>

      {error && <div style={{ color: C.neg, margin: "0 0 12px" }}>⚠ {error}</div>}

      {/* KPI */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <Kpi label="Активы" value={money(assetsTotal)} color={C.pos} />
        <Kpi label="Пассивы" value={money(liabTotal)} color={C.neg} />
        <Kpi label="Net worth" value={money(netWorth)} color={netWorth >= 0 ? C.pos : C.neg} />
      </div>

      {/* Две колонки: Активы | Пассивы */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <SectionCard title="АКТИВЫ" rows={ASSETS} form={formWithStock} setForm={setForm} total={assetsTotal} totalColor={C.pos} loading={loading} stockBr={stockBr} inTransit={inTransit} mpBal={mpBal} />
        <SectionCard title="ПАССИВЫ" rows={LIABILITIES.map(([k, l]) => [k, l, false])} form={form} setForm={setForm} total={liabTotal} totalColor={C.neg} loading={loading} />
      </div>

      {/* Себестоимость остатков на складе/ФФ (расшифровка «Склад/ФФ») */}
      <FfStockBreakdownCard ffStockBr={ffStockBr} />

      {/* Дебиторка «ПОД ВОПРОСОМ» (в активы/net_worth НЕ входит) */}
      <ReceivablesCard
        receivables={receivables}
        setReceivables={setReceivables}
        loading={loading}
      />

      {/* Счета (расшифровка «Денег на счетах») */}
      <AccountsCard
        accounts={accounts}
        setAccountAmount={setAccountAmount}
        onAdd={addAccount}
        onRename={renameAccount}
        onRemove={removeAccount}
        loading={loading}
      />

      <Field label="Комментарий к снапшоту">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="опц." style={{ ...inputStyle, width: "100%" }} />
      </Field>

      {/* График истории net_worth */}
      {chartData.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Динамика net worth</div>
          <div style={{ height: 280, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 6, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={C.line} vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: C.faint }} axisLine={false} tickLine={false} width={48}
                  tickFormatter={(v) => new Intl.NumberFormat("ru-RU", { notation: "compact" }).format(v)} />
                <Tooltip
                  formatter={(v) => [money(v), ""]}
                  contentStyle={{ borderRadius: 10, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 13 }}
                />
                <ReferenceLine y={0} stroke={C.line} />
                <Line type="monotone" dataKey="net" name="Net worth" stroke={C.accent} strokeWidth={2.5} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="assets" name="Активы" stroke={C.pos} strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
                <Line type="monotone" dataKey="liabilities" name="Пассивы" stroke={C.neg} strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Таблица истории */}
      {history.length > 0 && (
        <div style={{ marginTop: 20, overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: C.surface, borderBottom: `1px solid ${C.line}` }}>
                <th style={thLeft}>Дата</th>
                <th style={thR}>Активы</th>
                <th style={thR}>Пассивы</th>
                <th style={thR}>Net worth</th>
                <th style={thR}>Δ Деньги</th>
                <th style={thLeft}></th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => {
                // Δ cash_on_hand от следующего (более раннего) снапшота.
                const prev = history[i + 1];
                const delta = prev ? (h.cash_on_hand ?? 0) - (prev.cash_on_hand ?? 0) : null;
                return (
                <tr key={h.as_of_date} style={{ borderBottom: `1px solid ${soft("line", 20)}`, cursor: "pointer" }} onClick={() => setDate(h.as_of_date)}>
                  <td style={{ padding: "8px 10px" }}>{h.as_of_date}</td>
                  <td style={tdRight}>{money(h.assets_total)}</td>
                  <td style={tdRight}>{money(h.liabilities_total)}</td>
                  <td style={tdRight}><strong style={{ color: (h.net_worth ?? 0) >= 0 ? C.pos : C.neg }}>{money(h.net_worth)}</strong></td>
                  <td style={tdRight}>
                    {delta == null ? <span style={{ color: C.faint }}>—</span> : (
                      <strong style={{ color: delta >= 0 ? C.pos : C.neg }}>{delta >= 0 ? "+" : ""}{money(delta)}</strong>
                    )}
                  </td>
                  <td style={{ padding: "6px 8px" }} onClick={(e) => e.stopPropagation()}>
                    {delta != null && Math.abs(delta) > 0.01 && (
                      <button onClick={() => postDeltaToDds(h, delta)} style={{ ...miniBtnStyle, color: C.accent }} title="Записать Δ денег в ДДС">↧ В ДДС</button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------- Карточка остатков склад/ФФ (расшифровка ff_stock) ----------------
// read-only: себестоимость остатков на собственном складе и фулфилменте на дату
// снапшота (lib/ffStockValue из stock_ff_balances). Расшифровка по местам хранения.
// ИТОГО = ff_stock. Источник данных — страница /items/ff-stock (вводит владелец).
function FfStockBreakdownCard({ ffStockBr }) {
  const total = ffStockBr.total || 0;
  const byLocation = ffStockBr.byLocation || [];
  const date = ffStockBr.date;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.5 }}>ОСТАТКИ НА СКЛАДЕ/ФФ (РАСШИФРОВКА «СКЛАД/ФФ»)</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.accent }}>{money(total)}</div>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
        Себестоимость товара на собственном складе и фулфилменте на дату снапшота (× себест.).
        Поле «Склад/ФФ» в активах = ИТОГО, read-only (считается автоматически со страницы «Остатки склад/ФФ»).
        {!date && " Данных по остаткам склад/ФФ на эту дату нет — заведите их в разделе «Товары → Остатки склад/ФФ»."}
        {!!date && date !== "—" && ` Срез остатков: ${date}.`}
      </div>
      {byLocation.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {byLocation.map((r) => (
            <div key={r.location_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: C.accent2, display: "inline-block", flex: "none" }} />
                <span style={{ fontSize: 12.5, color: C.muted }}>{r.location_name || "—"}</span>
                <span style={{ fontSize: 10.5, color: C.faint }}>· {r.rows} строк · {new Intl.NumberFormat("ru-RU").format(r.qty)} шт.</span>
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.ink, fontVariantNumeric: "tabular-nums", textAlign: "right", width: 160 }}>{money(r.value)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: C.faint, padding: "6px 0" }}>Нет остатков склад/ФФ на эту дату.</div>
      )}
    </div>
  );
}

// ---------------- Карточка дебиторки «ПОД ВОПРОСОМ» (в активы не входит) ----------------
// Дебиторская задолженность по источникам на дату. НЕ входит в assets_total/net_worth
// (ненадёжно — неизвестно, получим или нет). Чекбокс «получено» → строка сереет.
function ReceivablesCard({ receivables, setReceivables, loading }) {
  const [adding, setAdding] = useState(false);
  const [newSource, setNewSource] = useState("");

  const totalUnderQuestion = receivables.filter((r) => !r.received).reduce((s, r) => s + (Number(r.amount) || 0), 0);

  function updateField(idx, field, value) {
    setReceivables((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  }
  function removeRow(idx) {
    setReceivables((prev) => prev.filter((_, i) => i !== idx));
  }
  function addRow(source) {
    const clean = (source || "").trim();
    if (!clean) return;
    // Не дублируем источник на дату.
    if (receivables.some((r) => r.source.toLowerCase() === clean.toLowerCase())) return;
    setReceivables((prev) => [...prev, { source: clean, amount: "", note: "", received: false }]);
  }

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.5 }}>ПОД ВОПРОСОМ (в активы не входит)</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: "#fc3F1D" }}>{money(totalUnderQuestion)}</div>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
        Дебиторская задолженность по источникам. Сумма <strong>не входит</strong> в активы и net_worth, т.к. получение
        под вопросом. Отметьте «получено» — строка уйдёт из суммы и в активы (позже можно перенести вручную).
      </div>

      {receivables.length === 0 && !adding && (
        <div style={{ fontSize: 12, color: C.faint, fontStyle: "italic" }}>Дебиторки нет</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {receivables.map((r, idx) => {
          const dim = r.received;
          return (
            <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, opacity: dim ? 0.45 : 1 }}>
              <input
                type="checkbox"
                checked={!!r.received}
                title="Получено — не учитывать в сумме под вопросом"
                onChange={(e) => updateField(idx, "received", e.target.checked)}
                style={{ flex: "none", cursor: "pointer" }}
              />
              <input
                type="text"
                value={r.source}
                placeholder="Источник (ВБ / Ozon / Контрагент…)"
                disabled={loading}
                onChange={(e) => updateField(idx, "source", e.target.value)}
                style={{ ...inputStyle, flex: 1, minWidth: 0, padding: "5px 8px", fontSize: 12.5, ...(dim ? { textDecoration: "line-through" } : {}) }}
              />
              <input
                type="number" step="any"
                value={r.amount ?? ""}
                disabled={loading}
                onChange={(e) => updateField(idx, "amount", e.target.value === "" ? "" : Number(e.target.value))}
                style={{ ...inputStyle, width: 130, padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                placeholder="0"
              />
              <input
                type="text"
                value={r.note || ""}
                placeholder="коммент."
                disabled={loading}
                onChange={(e) => updateField(idx, "note", e.target.value)}
                style={{ ...inputStyle, width: 120, padding: "5px 8px", fontSize: 11, color: C.faint }}
              />
              <button title="Убрать строку" onClick={() => removeRow(idx)} style={iconBtnStyle}>🗑</button>
            </div>
          );
        })}
      </div>

      {adding ? (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input
            autoFocus
            value={newSource}
            onChange={(e) => setNewSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { addRow(newSource); setNewSource(""); setAdding(false); }
              if (e.key === "Escape") { setNewSource(""); setAdding(false); }
            }}
            placeholder="Источник: ВБ / Ozon / Контрагент…"
            style={{ ...inputStyle, flex: 1, padding: "5px 8px", fontSize: 12 }}
          />
          <button
            onClick={() => { addRow(newSource); setNewSource(""); setAdding(false); }}
            style={{ ...miniBtnStyle, background: C.accent, color: "#0A1A1C" }}
          >✓</button>
          <button onClick={() => { setNewSource(""); setAdding(false); }} style={miniBtnStyle}>✕</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ ...linkBtnStyle, marginTop: 8 }}>+ добавить источник</button>
      )}
    </div>
  );
}

// ---------------- Карточка счетов (расшифровка cash_on_hand) ----------------
function AccountsCard({ accounts, setAccountAmount, onAdd, onRename, onRemove, loading }) {
  const total = accounts.reduce((s, a) => s + (Number(a.amount) || 0), 0);
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.5 }}>СЧЕТА (РАСШИФРОВКА «ДЕНЕГ НА СЧЕТАХ»)</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.accent }}>{money(total)}</div>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
        Сумма всех счетов = поле «Деньги на счетах» в активах. Каталог редактируемый: можно добавлять, переименовывать и убирать счета.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {SUBJECTS.map(([subjectKey, subjectLabel]) => {
          const group = accounts.filter((a) => a.subject === subjectKey);
          const groupTotal = group.reduce((s, a) => s + (Number(a.amount) || 0), 0);
          return (
            <AccountGroup
              key={subjectKey}
              subjectKey={subjectKey}
              subjectLabel={subjectLabel}
              group={group}
              groupTotal={groupTotal}
              setAccountAmount={setAccountAmount}
              onAdd={onAdd}
              onRename={onRename}
              onRemove={onRemove}
              loading={loading}
            />
          );
        })}
      </div>
    </div>
  );
}

function AccountGroup({ subjectKey, subjectLabel, group, groupTotal, setAccountAmount, onAdd, onRename, onRemove, loading }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  return (
    <div style={{ background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.4, color: C.muted, textTransform: "uppercase" }}>{subjectLabel}</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>{money(groupTotal)}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {group.length === 0 && (
          <div style={{ fontSize: 11.5, color: C.faint, fontStyle: "italic" }}>Нет счетов</div>
        )}
        {group.map((a) => (
          <AccountRow
            key={`${a.subject}|${a.account_name}`}
            account={a}
            setAccountAmount={setAccountAmount}
            onRename={onRename}
            onRemove={onRemove}
            loading={loading}
          />
        ))}
      </div>
      {adding ? (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onAdd(subjectKey, newName); setNewName(""); setAdding(false); }
              if (e.key === "Escape") { setNewName(""); setAdding(false); }
            }}
            placeholder="Название счёта"
            style={{ ...inputStyle, flex: 1, padding: "5px 8px", fontSize: 12 }}
          />
          <button
            onClick={() => { onAdd(subjectKey, newName); setNewName(""); setAdding(false); }}
            style={{ ...miniBtnStyle, background: C.accent, color: "#0A1A1C" }}
          >✓</button>
          <button onClick={() => { setNewName(""); setAdding(false); }} style={miniBtnStyle}>✕</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ ...linkBtnStyle, marginTop: 8 }}>+ добавить счёт</button>
      )}
    </div>
  );
}

function AccountRow({ account, setAccountAmount, onRename, onRemove, loading }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.account_name);
  if (editing) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onRename(account.id, draft); setEditing(false); }
            if (e.key === "Escape") { setDraft(account.account_name); setEditing(false); }
          }}
          style={{ ...inputStyle, flex: 1, padding: "4px 8px", fontSize: 12 }}
        />
        <button
          onClick={() => { onRename(account.id, draft); setEditing(false); }}
          style={{ ...miniBtnStyle, background: C.accent, color: "#0A1A1C" }}
        >✓</button>
        <button onClick={() => { setDraft(account.account_name); setEditing(false); }} style={miniBtnStyle}>✕</button>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.account_name}</span>
        <button title="Переименовать" onClick={() => { setDraft(account.account_name); setEditing(true); }} style={iconBtnStyle}>✎</button>
        {account.id != null && <button title="Убрать из каталога" onClick={() => onRemove(account.id)} style={iconBtnStyle}>🗑</button>}
      </div>
      <input
        type="number" step="any"
        value={account.amount ?? ""}
        disabled={loading}
        onChange={(e) => setAccountAmount(account.subject, account.account_name, e.target.value)}
        style={{ ...inputStyle, width: 130, padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}
        placeholder="0"
      />
    </div>
  );
}

// ---------------- Карточка секции (активы/пассивы) ----------------
function SectionCard({ title, rows, form, setForm, total, totalColor, loading, stockBr, inTransit, mpBal }) {
  const [openStock, setOpenStock] = useState(false);
  const [openTransit, setOpenTransit] = useState(false);
  const [openMpBal, setOpenMpBal] = useState(false);
  const mpRows = stockBr
    ? [
        { label: "Wildberries", value: stockBr.wb || 0, color: C.accent, hint: stockBr.dateWb },
        { label: "Ozon", value: stockBr.ozon || 0, color: "#ff8800", hint: stockBr.dateOzon },
        { label: "Яндекс Маркет", value: stockBr.yandex || 0, color: "#fc3F1D", hint: "заглушка (нет данных)" },
      ]
    : [];
  const mpBalRows = mpBal
    ? [
        { label: "Wildberries", value: mpBal.wb || 0, color: C.accent, hint: mpBal.wb_withdraw != null ? `к выводу: ${money(mpBal.wb_withdraw)}` : null },
        { label: "Ozon", value: mpBal.ozon || 0, color: "#ff8800" },
        { label: "Яндекс Маркет", value: mpBal.yandex || 0, color: "#fc3F1D", hint: "заглушка (нет данных)" },
      ]
    : [];
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 0.5 }}>{title}</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: totalColor }}>{money(total)}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map(([key, label, readOnly]) => {
          // Expandable-строки: «Деньги в МП» (по МП), «Товар на складах МП» (по МП), «Товар в пути» (по закупкам).
          const isMpBalRow = key === "mp_balance" && mpBal;
          const isStockRow = key === "stock_value" && stockBr;
          const isTransitRow = key === "stock_in_transit" && inTransit;
          const expandable = isStockRow || isTransitRow || isMpBalRow;
          const expanded = isMpBalRow ? openMpBal : isStockRow ? openStock : openTransit;
          const setExpanded = isMpBalRow ? setOpenMpBal : isStockRow ? setOpenStock : setOpenTransit;
          const expandLabel = isMpBalRow
            ? `Деньги в кабинете МП (авто${mpBal?.cached ? " · кэш" : ""})`
            : isStockRow
              ? "Товар на складах МП (авто)"
              : isTransitRow
                ? `Товар в пути (авто · ${inTransit.count} ${pluralPurchases(inTransit.count)})`
                : "";
          return (
            <div key={key}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                {expandable ? (
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    style={{
                      background: "none", border: "none", cursor: "pointer", padding: 0,
                      display: "flex", alignItems: "center", gap: 6, flex: 1, textAlign: "left",
                      color: C.faint, fontSize: 12.5,
                    }}
                    title="Развернуть расшифровку"
                  >
                    <span style={{ width: 12, display: "inline-block", fontWeight: 700 }}>{expanded ? "▾" : "▸"}</span>
                    <span>{expandLabel}</span>
                  </button>
                ) : (
                  <label style={{ fontSize: 12.5, color: readOnly ? C.faint : C.muted, flex: 1 }}>{label}{readOnly ? " (авто)" : ""}</label>
                )}
                <input
                  type="number" step="any"
                  value={form[key] ?? ""}
                  disabled={loading || readOnly}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value === "" ? "" : Number(e.target.value) })}
                  style={{
                    ...inputStyle, width: 150, padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums",
                    ...(readOnly ? { background: C.surfaceAlt, color: C.faint, cursor: "default", opacity: 0.9 } : {}),
                  }}
                  placeholder="0"
                />
              </div>
              {isStockRow && openStock && (
                <div style={{ marginLeft: 18, marginTop: 6, display: "flex", flexDirection: "column", gap: 6, borderLeft: `2px solid ${C.line}`, paddingLeft: 12 }}>
                  {mpRows.map((r) => (
                    <div key={r.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, display: "inline-block", flex: "none" }} />
                        <span style={{ fontSize: 12, color: C.muted }}>{r.label}</span>
                        {r.hint && <span style={{ fontSize: 10, color: C.faint }}>· {r.hint}</span>}
                      </div>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, fontVariantNumeric: "tabular-nums", textAlign: "right", width: 150 }}>{money(r.value)}</span>
                    </div>
                  ))}
                </div>
              )}
              {isMpBalRow && openMpBal && (
                <div style={{ marginLeft: 18, marginTop: 6, display: "flex", flexDirection: "column", gap: 6, borderLeft: `2px solid ${C.line}`, paddingLeft: 12 }}>
                  {mpBalRows.map((r) => (
                    <div key={r.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, display: "inline-block", flex: "none" }} />
                        <span style={{ fontSize: 12, color: C.muted }}>{r.label}</span>
                        {r.hint && <span style={{ fontSize: 10, color: C.faint }}>· {r.hint}</span>}
                      </div>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, fontVariantNumeric: "tabular-nums", textAlign: "right", width: 150 }}>{money(r.value)}</span>
                    </div>
                  ))}
                </div>
              )}
              {isTransitRow && openTransit && (
                <div style={{ marginLeft: 18, marginTop: 6, display: "flex", flexDirection: "column", gap: 4, borderLeft: `2px solid ${C.line}`, paddingLeft: 12, maxHeight: 220, overflowY: "auto" }}>
                  {inTransit.items.length === 0 && (
                    <div style={{ fontSize: 11.5, color: C.faint, fontStyle: "italic" }}>Партий в пути нет</div>
                  )}
                  {inTransit.items.map((p) => (
                    <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: 11, color: C.faint, whiteSpace: "nowrap" }}>×{p.qty}</span>
                        <span style={{ fontSize: 11.5, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, color: C.ink, fontVariantNumeric: "tabular-nums", textAlign: "right", width: 150 }}>{money(p.value)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function pluralPurchases(n) {
  // простая русская плюрализация для «партия/партии/партий»
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "партия";
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "партии";
  return "партий";
}

// ---------------- Хелперы ----------------
function emptyForm() {
  const o = {};
  for (const [k] of [...ASSETS, ...LIABILITIES]) o[k] = "";
  return o;
}
function pickAll(s) {
  const o = {};
  for (const [k] of [...ASSETS, ...LIABILITIES]) o[k] = s[k] != null ? s[k] : "";
  return o;
}
function sumCols(form, keys) {
  let s = 0;
  for (const k of keys) { const n = Number(form[k]); if (Number.isFinite(n)) s += n; }
  return s;
}
/**
 * Сливает каталог счётов с суммами на дату: для каждого счёта из каталога
 * подставляем сумму из accs (если есть), иначе 0. Так новая дата показывает
 * все счета каталога с пустыми суммами.
 */
function buildAccountsState(catalog, accs) {
  const map = new Map();
  for (const a of accs) map.set(`${a.subject}|${a.account_name}`, a.amount);
  return catalog.map((c) => ({
    id: c.id,
    subject: c.subject,
    account_name: c.account_name,
    amount: map.has(`${c.subject}|${c.account_name}`) ? map.get(`${c.subject}|${c.account_name}`) : "",
  }));
}

// ---------------- UI-компоненты ----------------
function Header() {
  return (
    <div style={{ marginBottom: 14 }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>Баланс</h1>
      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 13 }}>
        Бухгалтерский актив/пассив на дату. net_worth = активы − пассивы.
      </p>
    </div>
  );
}
function Kpi({ label, value, color }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 160px", minWidth: 140 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || C.ink }}>{value}</div>
    </div>
  );
}
function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: C.muted }}>
      {label}{children}
    </label>
  );
}

// ---------------- Стили ----------------
const inputStyle = {
  padding: "6px 10px", borderRadius: 6, fontSize: 13,
  background: C.bg, color: C.ink, border: `1px solid ${C.line}`, minWidth: 100,
};
const addBtnStyle = {
  padding: "8px 18px", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer",
  background: C.accent, color: "#0A1A1C", border: "none",
};
const miniBtnStyle = {
  padding: "4px 10px", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer",
  background: C.bg, color: C.ink, border: `1px solid ${C.line}`,
};
const linkBtnStyle = {
  background: "none", border: "none", color: C.accent, cursor: "pointer",
  fontSize: 12, padding: "4px 0", textAlign: "left",
};
const iconBtnStyle = {
  background: "none", border: "none", color: C.faint, cursor: "pointer",
  fontSize: 13, padding: "0 2px", lineHeight: 1,
};
const thLeft = { padding: "10px", fontWeight: 600, fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left" };
const thR = { ...thLeft, textAlign: "right" };
const tdRight = { padding: "8px 10px", verticalAlign: "middle", textAlign: "right", fontVariantNumeric: "tabular-nums" };
const alertStyle = {
  padding: "10px 14px", borderRadius: 8, fontSize: 12, lineHeight: 1.5,
  background: C.surface, border: `1px solid ${C.line}`, color: C.muted,
};
