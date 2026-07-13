// app/cabinets/[id]/layout.js — верхняя горизонтальная навигация + проверка доступа.
import { getSession } from "@/lib/session.js";
import { query } from "@/lib/db.js";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import "./cabinet.css";

export const dynamic = "force-dynamic";

// Навигация с группами (как в эталоне data-presenter/Nav.jsx).
// Группа = { label, icon, items: [{href, label}] } — рендерится как dropdown.
// Пункт = { href, label, icon } — плоский.
const MENU = [
  { href: "", label: "Главная", icon: "📊" },
  { href: "/briefing", label: "Брифинг", icon: "📋" },
  {
    label: "Сводка по товарам", icon: "📦", groupBase: "/summary",
    items: [
      { href: "/summary", label: "По товарам" },
      { href: "/orders", label: "Заказы" },
      { href: "/geo", label: "География" },
      { href: "/timing", label: "Заказы по времени" },
      { href: "/abc", label: "ABC анализ" },
      { href: "/stocks", label: "Склады и индексы" },
    ],
  },
  { href: "/pnl", label: "Сводка по прибыли", icon: "💰" },
  { href: "/reviews", label: "Отзывы", icon: "⭐" },
  {
    label: "Товары", icon: "🏷️", groupBase: "/items",
    items: [
      { href: "/catalog", label: "Справочник товаров" },
      { href: "/items", label: "Себестоимость" },
      { href: "/mp-stock", label: "Остатки на МП" },
      { href: "/ff-stock", label: "Остатки склад/ФФ" },
      { href: "/move", label: "Перемещение" },
    ],
  },
  {
    label: "Финансы", icon: "📐", groupBase: "/unit",
    items: [
      { href: "/unit", label: "Юнит-экономика" },
      { href: "/fin-plan", label: "План продаж" },
      { href: "/fin-manual", label: "Сопутств. расходы" },
      { href: "/fin-purchases", label: "Закупки" },
      { href: "/fin-balance", label: "Баланс" },
      { href: "/fin-self-buyouts", label: "Самовыкупы" },
      { href: "/fin-dds", label: "ДДС" },
      { href: "/fin-calendar", label: "План платежей" },
      { href: "/fin-purchase-plan", label: "План закупок" },
    ],
  },
  { href: "/alerts", label: "Оповещения", icon: "🔔" },
  { href: "/settings", label: "Настройки", icon: "⚙️" },
  { href: "/team", label: "Команда", icon: "👥" },
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
          <nav className="topnav" id="topnav-groups">
            {MENU.map((item) => {
              // Группа с подменю (dropdown по hover)
              if (item.items) {
                const groupActive = item.items.some((sub) => current === sub.href);
                return (
                  <div key={item.label} className="topnav-group">
                    <button
                      className={"topnav-link" + (groupActive ? " active" : "")}
                      title={item.label}
                    >
                      <span className="topnav-icon">{item.icon}</span>
                      <span className="topnav-label">{item.label}</span>
                      <span style={{ fontSize: 9, opacity: 0.6 }}>▼</span>
                    </button>
                    <div className="topnav-dropdown">
                      {item.items.map((sub) => (
                        <Link
                          key={sub.href}
                          href={basePath + sub.href}
                          className={"topnav-sublink" + (current === sub.href ? " active" : "")}
                        >
                          {sub.label}
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              }
              // Плоский пункт
              const active = item.href === "" ? current === "" : current === item.href;
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
            <Link href="/settings" className="topbar-action" title="Профиль">👤 Профиль</Link>
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
