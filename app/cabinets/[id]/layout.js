// app/cabinets/[id]/layout.js — навигация со всеми экранами.
import { getSession } from "@/lib/session.js";
import { query } from "@/lib/db.js";
import { redirect } from "next/navigation";
import Link from "next/link";
import "./cabinet.css";

export const dynamic = "force-dynamic";

const MENU = [
  { href: "", label: "📊 Главная" },
  { href: "/summary", label: "📦 Сводка по товарам" },
  { href: "/orders", label: "🛒 Заказы" },
  { href: "/unit", label: "📐 Юнит-экономика" },
  { href: "/pnl", label: "💰 Сводка по прибыли" },
  { href: "/items", label: "🏷️ Товары (себест.)" },
  { href: "/reviews", label: "⭐ Отзывы" },
  { href: "/briefing", label: "📋 Брифинг" },
];

export default async function CabinetLayout({ children, params }) {
  const cabinetId = Number(params.id);
  const session = await getSession();
  if (!session?.user_id) redirect("/login");

  const mem = await query(
    `SELECT c.display_name, c.marketplaces
     FROM auth.memberships m
     JOIN auth.cabinets c ON c.cabinet_id = m.cabinet_id
     WHERE m.user_id = $1 AND m.cabinet_id = $2`,
    [session.user_id, cabinetId]
  );
  if (!mem.length) redirect("/");

  const cab = mem[0];
  const basePath = `/cabinets/${cabinetId}`;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">📊 MP Analytics</div>
        <div style={{ fontSize: 12, color: "#8a99b8", marginBottom: 16, padding: "0 12px" }}>
          {cab.display_name}
        </div>
        {MENU.map((item) => (
          <Link key={item.href} href={basePath + item.href} className="nav-link">
            {item.label}
          </Link>
        ))}
        <hr style={{ border: "none", borderTop: "1px solid #243049", margin: "16px 0" }} />
        <Link href="/" className="nav-link">← Все кабинеты</Link>
        <form action="/api/auth/logout" method="post" style={{ marginTop: 12 }}>
          <button type="submit" className="btn secondary" style={{ padding: "8px", fontSize: 13 }}>Выйти</button>
        </form>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
