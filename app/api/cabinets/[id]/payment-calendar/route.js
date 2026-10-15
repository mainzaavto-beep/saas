// /api/cabinets/[id]/payment-calendar — платёжный календарь (kind=expense) и план поступлений
// (kind=income), 15.10.2026. Данные — tenant.dds_movements (+ прогноз выплат МП на лету).
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { tenantQuery } from "@/lib/db.js";
import { monthGrid, summarize, weekSummary, categoryOf, CATEGORIES } from "@/lib/paymentCalendar.js";
import {
  loadMonth, createMovement, updateMovement, markPaid, unmarkPaid, archiveMovement,
  receivePayout, saveRecurring, deleteRecurring,
} from "@/lib/paymentCalendarData.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const mskToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const today = mskToday();
  const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : today.slice(0, 7);
  const kind = url.searchParams.get("kind") === "income" ? "income" : "expense";
  const { rows, forecasts } = await loadMonth({ cabinetId: cabinet.cabinet_id, month, kind, today });

  const items = [
    ...rows.map((r) => ({ id: Number(r.id), ref: r.source_ref, date: r.date, amount: Number(r.amount), status: r.status,
      category: r.category, cat: categoryOf(r.category), counterparty: r.counterparty, description: r.description,
      source_kind: r.source_kind, date_locked: r.date_locked, amount_planned: r.amount_planned })),
    ...forecasts.map((f) => ({ id: null, ref: f.ref, date: f.date, amount: f.amount, status: "forecast",
      category: "Выплата МП", cat: "mp", counterparty: f.platform === "wb" ? "Wildberries" : "Ozon",
      description: `Выплата ${f.platform === "wb" ? "WB" : "Ozon"} за ${f.winFrom.slice(8)}.${f.winFrom.slice(5, 7)}–${f.winTo.slice(8)}.${f.winTo.slice(5, 7)}`,
      source_kind: "mp_payout", platform: f.platform, accruing: f.accruing, winFrom: f.winFrom, winTo: f.winTo })),
  ];
  const byDate = new Map();
  for (const it of items) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  const weeks = monthGrid(month).map((w) => {
    const days = w.map((d) => {
      const its = byDate.get(d.date) || [];
      return { ...d, items: its, total: Math.round(its.reduce((s, x) => s + x.amount, 0) * 100) / 100 };
    });
    const all = days.flatMap((d) => d.items).map((x) => ({ ...x, status: x.status === "forecast" ? "planned" : x.status }));
    return { days, ...weekSummary(all) };
  });
  const inMonth = items.filter((x) => x.date.slice(0, 7) === month).map((x) => ({ ...x, status: x.status === "forecast" ? "planned" : x.status }));
  const recurring = await tenantQuery(
    `SELECT id, type, amount::float8 AS amount, category, counterparty, description, rule, rule_day, every_n,
            date_from::text AS date_from, date_to::text AS date_to
       FROM tenant.dds_recurring WHERE is_active AND type = $1 ORDER BY id`, [kind]);
  return NextResponse.json({ month, kind, today, categories: CATEGORIES, weeks, totals: summarize(inMonth, { today }), recurring });
});

export const POST = withCabinet(async (req) => {
  const b = await req.json();
  try {
    switch (b.action) {
      case "create": return NextResponse.json({ ok: true, id: await createMovement(b) });
      case "update": await updateMovement(Number(b.id), b); break;
      case "mark_paid": await markPaid(Number(b.id), b.amount); break;
      case "unmark": await unmarkPaid(Number(b.id)); break;
      case "delete": await archiveMovement(Number(b.id)); break;
      case "receive_payout": return NextResponse.json({ ok: true, id: await receivePayout(b) });
      case "recurring_save": return NextResponse.json({ ok: true, id: await saveRecurring(b) });
      case "recurring_delete": await deleteRecurring(Number(b.id)); break;
      default: return NextResponse.json({ error: `неизвестное действие: ${b.action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e.status) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e; // 500 → withCabinet откатывает транзакцию
  }
}, { requireRole: "manager" });
