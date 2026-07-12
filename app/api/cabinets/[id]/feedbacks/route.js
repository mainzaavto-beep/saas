// /api/cabinets/[id]/feedbacks — отзывы WB+Ozon из PostgreSQL.
// Чтение (GET): список отзывов с фильтрами.
// Запись (POST): сохранение черновика ответа (draft_reply/status).
import { NextResponse } from "next/server";
import { DatabaseSync } from "@/lib/db.js";
import { withCabinet } from "@/lib/withCabinet.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withCabinet(async (req, { cabinet }) => {
  const url = new URL(req.url);
  const mp = url.searchParams.get("mp") || "all"; // all|wb|ozon
  const ratingMin = url.searchParams.get("ratingMin");
  const ratingMax = url.searchParams.get("ratingMax");
  const nm = url.searchParams.get("nm");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 500);
  const unanswered = url.searchParams.get("unanswered") === "1";
  const mps = cabinet.marketplaces || [];

  const items = [];

  // WB
  if (mp !== "ozon" && mps.includes("wb")) {
    const db = new DatabaseSync("wb", { readOnly: true });
    const where = [];
    const args = [];
    if (ratingMin) { where.push("rating >= ?"); args.push(Number(ratingMin)); }
    if (ratingMax) { where.push("rating <= ?"); args.push(Number(ratingMax)); }
    if (nm) { where.push("nm_id = ?"); args.push(Number(nm)); }
    if (unanswered) where.push("(was_answered IS NULL OR was_answered = 0)");
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const rows = await db.prepare(
      `SELECT f.id, f.nm_id, f.rating, f.text, f.author, f.created_at,
              f.was_answered, f.wb_answer, f.product, f.status, f.draft_reply,
              a.name AS product_name, a.im_url
       FROM feedbacks f
       LEFT JOIN articles a ON a.nm_id = f.nm_id
       ${whereSql}
       ORDER BY f.created_at DESC NULLS LAST
       LIMIT ?`
    ).all(...args, limit);
    items.push(...rows.map((r) => ({ ...r, platform: "wb" })));
  }

  // Ozon
  if (mp !== "wb" && mps.includes("ozon")) {
    const db = new DatabaseSync("ozon", { readOnly: true });
    const where = [];
    const args = [];
    if (ratingMin) { where.push("rating >= ?"); args.push(Number(ratingMin)); }
    if (ratingMax) { where.push("rating <= ?"); args.push(Number(ratingMax)); }
    if (nm) { where.push("product_id = ?"); args.push(Number(nm)); }
    if (unanswered) where.push("(was_answered IS NULL OR was_answered = 0)");
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    const rows = await db.prepare(
      `SELECT f.id, f.product_id AS nm_id, f.rating, f.text, f.author, f.created_at,
              f.was_answered, f.mp_answer AS wb_answer, f.product, f.status, f.draft_reply,
              p.name AS product_name, '' AS im_url
       FROM feedbacks f
       LEFT JOIN products p ON p.product_id = f.product_id
       ${whereSql}
       ORDER BY f.created_at DESC NULLS LAST
       LIMIT ?`
    ).all(...args, limit);
    items.push(...rows.map((r) => ({ ...r, platform: "ozon" })));
  }

  // Сортировка по дате (оба МП вместе)
  items.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

  // Статистика
  const stats = {
    total: items.length,
    unanswered: items.filter((i) => !i.was_answered).length,
    lowRating: items.filter((i) => i.rating && i.rating <= 2).length,
    avgRating: items.length > 0 && items.some((i) => i.rating)
      ? Math.round((items.reduce((s, i) => s + (i.rating || 0), 0) / items.filter((i) => i.rating).length) * 10) / 10
      : null,
  };

  return NextResponse.json({ items: items.slice(0, limit), stats });
});

// POST — сохранить черновик ответа
export const POST = withCabinet(async (req, { cabinet }) => {
  const body = await req.json();
  const { id, platform, draft, status } = body;
  if (!id || !platform) return NextResponse.json({ error: "id + platform required" }, { status: 400 });

  const mp = platform === "ozon" ? "ozon" : "wb";
  const db = new DatabaseSync(mp, { readOnly: false });
  const now = new Date().toISOString();
  const repliedAt = status === "answered" ? now : null;

  await db.prepare(
    `UPDATE feedbacks SET draft_reply = ?, status = ?, replied_at = COALESCE(?, replied_at), updated_at = ? WHERE id = ?`
  ).run(String(draft || "").slice(0, 4000), status || "draft", repliedAt, now, String(id));

  return NextResponse.json({ ok: true });
});
