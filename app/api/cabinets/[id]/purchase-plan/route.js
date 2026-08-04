import { NextResponse } from "next/server";
import { tenantQuery } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// =====================================================================
//  /api/purchase-plan — план закупок (контракт №36, заявка №35).
//
//  fin_data.db.purchase_plan: длинная узкая таблица (week, nm_id, type, amount).
//  type=purchase (Закуп=деньги наружу), type=receipt (Поступление=товар внутрь).
//  Источник правды = дашборд (НЕ Sheets-roundtrip, решение №36).
//
//  GET  ?pivot=1&from=&to=      pivot: недели=строки, (nm_id×type)=колонки
//  GET  ?from=&to=&nm_id=       длинный список
//  POST {week,nm_id,type,amount,qty?,note?}  upsert по UNIQUE(week,nm_id,type)
//  DELETE ?id=N                 мягкое удаление status=archived
//
//  Эталон: fin/db_local.py:fetch_purchase_plan_pivot. JOIN wb_data.db.articles
//  по nm_id для фото/имени в шапке колонок.
// =====================================================================

const TYPES = ["purchase", "receipt"];
const nowISO = () => new Date().toISOString();

function validWeek(w) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(w || ""));
}

// 🔒 Роут был экспортирован БЕЗ withCabinet: cabinet_id не читался вовсе, а
// единственной преградой был middleware («залогинен») — любой пользователь
// панели мог править чужой план закупок. Теперь как у остальных финансовых
// разделов: чтение — участнику кабинета, запись — только владельцу.
export const GET = withCabinet(async (req) => {
  try {
    const url = new URL(req.url);
    const pivot = url.searchParams.get("pivot") === "1";
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const nmId = url.searchParams.get("nm_id") || "";

    
    try {
      const where = ["status <> 'archived'"];
      if (from && validWeek(from)) where.push(`week >= '${from}'`);
      if (to && validWeek(to)) where.push(`week <= '${to}'`);
      if (nmId && /^\d+$/.test(nmId)) where.push(`nm_id = ${Number(nmId)}`);
      const rows = await db
        .prepare(
          `SELECT id, week, nm_id, type, amount, qty, note, status, updated_at
             FROM tenant.purchase_plan
            WHERE ${where.join(" AND ")}
            ORDER BY week, nm_id, type`
        )
        .all();

      if (!pivot) {
        return NextResponse.json({ count: rows.length, items: rows });
      }

      // Pivot-разворачивание (зеркало fin/db_local.py:fetch_purchase_plan_pivot).
      const weeksMap = {};
      const allNms = new Set();
      for (const r of rows) {
        const w = weeksMap[r.week] || { week: r.week, cells: {}, purchase_total: 0, receipt_total: 0 };
        const key = `${r.nm_id}:${r.type}`;
        w.cells[key] = r.amount;
        allNms.add(r.nm_id);
        if (r.type === "purchase") w.purchase_total += r.amount;
        else w.receipt_total += r.amount;
        weeksMap[r.week] = w;
      }
      const weeks = Object.values(weeksMap).map((w) => ({
        ...w,
        purchase_total: Math.round(w.purchase_total * 100) / 100,
        receipt_total: Math.round(w.receipt_total * 100) / 100,
        delta: Math.round((w.receipt_total - w.purchase_total) * 100) / 100,
      }));

      // Метаданные nm_id (фото/имя из wb_data.db.articles).
      const nms = [...allNms].sort((a, b) => a - b);
      const nmMeta = {};
      if (nms.length) {
        try {
          const wb = new DatabaseSync(WB_DB, { readOnly: true });
          const metaRows = wb
            .prepare(`SELECT nm_id, name, im_url FROM articles WHERE nm_id IN (${nms.join(",")})`)
            .all();
          for (const m of metaRows) nmMeta[m.nm_id] = { name: m.name, im_url: m.im_url };
          wb.close();
        } catch {
          /* articles недоступен — не критично */
        }
      }

      return NextResponse.json({
        weeks,
        nms,
        nms_meta: nmMeta,
        types: TYPES,
      });
    } finally {
      
    }
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
});

export const POST = withCabinet(async (req) => {
  try {
    const b = await req.json();
    const week = String(b.week || "");
    const nmId = Number(b.nm_id);
    const type = String(b.type || "");
    const amount = Number(b.amount);
    const qty = b.qty != null ? Number(b.qty) : null;
    const note = b.note ? String(b.note) : null;

    if (!validWeek(week)) {
      return NextResponse.json({ error: "week должен быть YYYY-MM-DD" }, { status: 400 });
    }
    if (!nmId || nmId <= 0) {
      return NextResponse.json({ error: "nm_id должен быть положительным числом" }, { status: 400 });
    }
    if (!TYPES.includes(type)) {
      return NextResponse.json({ error: `type должен быть одним из: ${TYPES.join(", ")}` }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: "amount должен быть числом >= 0" }, { status: 400 });
    }

    
    try {
      const ts = nowISO();
      // Upsert по UNIQUE(week, nm_id, type).
      const r = await db
        .prepare(
          `INSERT INTO tenant.purchase_plan (week, nm_id, type, amount, qty, note, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(week, nm_id, type) DO UPDATE SET
             amount=excluded.amount, qty=excluded.qty, note=excluded.note,
             status='active', updated_at=excluded.updated_at`
        )
        .run(week, nmId, type, amount, qty, note, ts, ts);
      return NextResponse.json({ ok: true, action: "upserted" });
    } finally {
      
    }
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}, { requireRole: 'owner' });

export const DELETE = withCabinet(async (req) => {
  try {
    const url = new URL(req.url);
    const id = Number(url.searchParams.get("id") || 0);
    if (!id) return NextResponse.json({ error: "нужен id" }, { status: 400 });
    
    try {
      const r = await db
        .prepare("UPDATE purchase_plan SET status='archived', updated_at=? WHERE id=?")
        .run(nowISO(), id);
      if ((r.changes || 0) === 0) {
        return NextResponse.json({ error: "запись не найдена" }, { status: 404 });
      }
      return NextResponse.json({ ok: true, id, action: "archived" });
    } finally {

    }
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}, { requireRole: 'owner' });
