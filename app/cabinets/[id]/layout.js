// app/cabinets/[id]/layout.js — верхняя горизонтальная навигация + проверка доступа.
import { getSession } from "@/lib/session.js";
import { query } from "@/lib/db.js";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import "./cabinet.css";

export const dynamic = "force-dynamic";

const MENU = [
  { href: "", label: "Главная", icon: "📊" },
  { href: "/summary", label: "Сводка по товарам", icon: "📦" },
  { href: "/orders", label: "Заказы", icon: "🛒" },
  { href: "/geo", label: "География", icon: "🗺️" },
  { href: "/timing", label: "Время заказов", icon: "⏰" },
  { href: "/unit", label: "Юнит-экономика", icon: "📐" },
  { href: "/pnl", label: "Сводка по прибыли", icon: "💰" },
  { href: "/items", label: "Товары (себест.)", icon: "🏷️" },
  { href: "/mp-stock", label: "Остатки на МП", icon: "📦" },
  { href: "/catalog", label: "Справочник", icon: "📒" },
  { href: "/ff-stock", label: "Склад/ФФ", icon: "🏭" },
  { href: "/move", label: "Перемещения", icon: "🚚" },
  { href: "/abc", label: "ABC анализ", icon: "🔤" },
  { href: "/stocks", label: "Склады", icon: "🏢" },
  { href: "/alerts", label: "Оповещения", icon: "🔔" },
  { href: "/reviews", label: "Отзывы", icon: "⭐" },
  { href: "/briefing", label: "Брифинг", icon: "📋" },
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

  // Текущий путь — для подсветки активного пункта меню.
  const h = await headers();
  const pathname = h.get("x-invoke-path") || h.get("referer") || "";
  // x-invoke-path отдаёт путь без basePath; fallback на referer при отсутствии.
  const current = pathname.replace(basePath, "") || "";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="topbar-brand">
            <span className="brand-mark">📊</span>
            <span className="brand-text">MP Analytics</span>
            <span className="brand-cab">{cab.display_name}</span>
          </div>
          <nav className="topnav">
            {MENU.map((item) => {
              const itemPath = item.href; // "" для главной, "/summary" и т.д.
              const active = itemPath === "" ? current === "" : current === itemPath;
              return (
                <Link
                  key={item.href || "home"}
                  href={basePath + item.href}
                  className={"topnav-link" + (active ? " active" : "")}
                  title={item.label}
                >
                  <span className="topnav-icon">{item.icon}</span>
                  <span className="topnav-label">{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="topbar-actions">
            <Link href="/" className="topbar-action" title="Все кабинеты">← Кабинеты</Link>
            <form action="/api/auth/logout" method="post" style={{ display: "inline" }}>
              <button type="submit" className="topbar-action" title="Выйти">Выйти</button>
            </form>
          </div>
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
