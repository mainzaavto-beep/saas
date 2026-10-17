// /api/cabinets/[id]/dds-refs — справочники ДДС: статьи (manager+), счета и настройки (owner) (17.10.2026,
// спека docs/superpowers/specs/2026-10-17-dds-design.md §4). Счета не-владельцу — только {id,name,kind,is_archived}.
import { NextResponse } from "next/server";
import { withCabinet } from "@/lib/withCabinet.js";
import { redactAccounts, balancesAt } from "@/lib/dds.js";
import { tenantQuery } from "@/lib/db.js";
import {
  loadRefs, saveArticle, archiveArticle, saveAccount, archiveAccount, saveDdsSettings,
} from "@/lib/ddsData.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const mskToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const tomorrow = (s) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

export const GET = withCabinet(async (req, { cabinet }) => {
  const isOwner = cabinet.role === "owner";
  const { articles, accounts, settings } = await loadRefs();
  const out = { articles, accounts: redactAccounts(accounts, isOwner), canEdit: isOwner || cabinet.role === "manager", isOwner };
  if (isOwner) {
    const ms = await tenantQuery(
      `SELECT date, type, amount::float8 AS amount, account_id::int AS account_id, account_to_id::int AS account_to_id
         FROM tenant.dds_movements WHERE status = 'paid'`);
    out.settings = settings;
    out.balances = Object.fromEntries(balancesAt(accounts, ms, tomorrow(mskToday())));
  }
  return NextResponse.json(out);
});

const OWNER_ACTIONS = new Set(["account_save", "account_archive", "settings_save"]);
export const POST = withCabinet(async (req, { cabinet }) => {
  const b = await req.json();
  if (OWNER_ACTIONS.has(b.action) && cabinet.role !== "owner") {
    return NextResponse.json({ error: "Счета и настройки ДДС — только владелец" }, { status: 403 });
  }
  try {
    switch (b.action) {
      case "article_save": return NextResponse.json({ ok: true, key: await saveArticle(b) });
      case "article_archive": await archiveArticle(String(b.key), b.archived !== false); break;
      case "account_save": return NextResponse.json({ ok: true, id: await saveAccount(b) });
      case "account_archive": await archiveAccount(Number(b.id), b.archived !== false); break;
      case "settings_save": await saveDdsSettings(b); break;
      default: return NextResponse.json({ error: `неизвестное действие: ${b.action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e.status) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}, { requireRole: "manager" });
