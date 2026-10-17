// /api/cabinets/[id]/dds — ДДС: журнал фактических операций и отчёт (17.10.2026, спека
// docs/superpowers/specs/2026-10-17-dds-design.md §4). Запись — через lib/paymentCalendarData.js.
// Остатки (endBalance, opening/closing/byAccount отчёта) — только владельцу (redactReport).
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { editRules, redactReport } from "@/lib/dds.js";
import { loadJournal, loadReport, loadEndBalance } from "@/lib/ddsData.js";
import { createMovement, updateMovement, archiveMovement, assignAccount } from "@/lib/paymentCalendarData.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const mskToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const monthsBack = (today, n) => { const [y, m] = today.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 - n, 1)); return d.toISOString().slice(0, 10); };

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const sp = (k) => url.searchParams.get(k) || "";
  const today = mskToday();
  const isOwner = cabinet.role === "owner";
  const canEdit = isOwner || cabinet.role === "manager";
  if (sp("view") === "report") {
    const to = ISO.test(sp("to")) ? sp("to") : today;
    const from = ISO.test(sp("from")) ? sp("from") : monthsBack(today, 5);
    if (from > to) return NextResponse.json({ error: "from > to" }, { status: 400 });
    const report = await loadReport({ from, to, grain: sp("grain"), today });
    return NextResponse.json({ ...redactReport(report, isOwner), from, to, today, canEdit, isOwner });
  }
  const f = { from: sp("from"), to: sp("to"), account: sp("account"), article: sp("article"), type: sp("type"),
    source: sp("source"), q: sp("q"), page: sp("page") };
  const j = await loadJournal(f);
  const items = j.items.map((it) => ({ ...it, rules: editRules(it) }));
  const out = { ...j, items, canEdit, isOwner, today };
  if (isOwner) out.endBalance = await loadEndBalance(ISO.test(f.to) ? f.to : today);
  return NextResponse.json(out);
});

export const POST = withCabinet(async (req) => {
  const b = await req.json();
  try {
    switch (b.action) {
      case "create": return NextResponse.json({ ok: true, id: await createMovement(b) });
      case "update": await updateMovement(Number(b.id), b); break;
      case "delete": await archiveMovement(Number(b.id)); break;
      case "assign_account": return NextResponse.json({ ok: true, n: await assignAccount(b.ids, b.account_id) });
      default: return NextResponse.json({ error: `неизвестное действие: ${b.action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e.status) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e; // 500 → withCabinet откатывает транзакцию
  }
}, { requireRole: "manager" });
