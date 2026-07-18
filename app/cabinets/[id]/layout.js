// app/cabinets/[id]/layout.js — верхняя горизонтальная навигация + проверка доступа.
import { getSession } from "@/lib/session.js";
import { query } from "@/lib/db.js";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import ThemeToggle from "@/app/ThemeToggle.jsx";
import "./cabinet.css";

export const dynamic = "force-dynamic";

// Навигация с группами (как в эталоне data-presenter/Nav.jsx).
// Группа = { label, icon, items: [{href, label}] } — рендерится как dropdown.
// Пункт = { href, label, icon } — плоский.
// Настройки и Команда перенесены в профиль (/settings).
const MENU = [
  { href: "", label: "Главная", icon: "📊" },
  { href: "/briefing", label: "Брифинг", icon: "📋" },
  {
    label: "Сводка по товарам", icon: "📦", groupBase: "/summary",
    items: [
      { href: "/rnp", label: "РНП (пульс)" },
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
      { href: "/items", label: "Себестоимость" },
      { href: "/mp-stock", label: "Остатки на МП" },
      { href: "/inventory", label: "Остатки склад/ФФ" },
      { href: "/shipments", label: "Отгрузки" },
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
  { href: "/whats-new", label: "Что нового", icon: "✨" },
  { href: "/support", label: "Поддержка", icon: "💬" },
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

  // Список всех проектов пользователя — для dropdown выбора.
  const allProjects = await query(
    `SELECT c.cabinet_id, c.display_name, c.marketplaces
     FROM auth.cabinets c
     JOIN auth.memberships m ON m.cabinet_id = c.cabinet_id
     WHERE m.user_id = $1 AND c.status <> 'deleted'
     ORDER BY c.cabinet_id`,
    [session.user_id]
  );

  // Текущий путь — для подсветки активного пункта меню.
  const h = await headers();
  const pathname = h.get("x-invoke-path") || h.get("referer") || "";
  const current = pathname.replace(basePath, "") || "";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="topbar-brand">
            <span className="brand-mark">📊</span>
            <span className="brand-text">SySell</span>
          </div>

          <nav className="topnav" id="topnav-groups">
            {MENU.map((item) => {
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
            {/* Селектор проекта */}
            <div className="topnav-group project-switcher">
              <button className="topnav-link" title="Сменить проект">
                <span className="brand-cab">{cab.display_name}</span>
                <span style={{ fontSize: 9, opacity: 0.6, marginLeft: 4 }}>▼</span>
              </button>
              <div className="topnav-dropdown">
                {allProjects.map((p) => (
                  <Link
                    key={p.cabinet_id}
                    href={`/cabinets/${p.cabinet_id}`}
                    className={"topnav-sublink" + (p.cabinet_id === cabinetId ? " active" : "")}
                  >
                    {p.display_name || `Проект #${p.cabinet_id}`}
                  </Link>
                ))}
                <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />
                <Link href="/onboarding" className="topnav-sublink">+ Новый проект</Link>
              </div>
            </div>

            {/* Переключатель темы */}
            <ThemeToggle />

            {/* Аватар-профиль */}
            <Link
              href={`/settings?cabinet=${cabinetId}`}
              className="avatar-btn"
              title="Профиль и настройки"
            >
              {(session.email || "?")[0].toUpperCase()}
            </Link>

            <form action="/api/auth/logout" method="post" style={{ display: "inline" }}>
              <button type="submit" className="topbar-action" title="Выйти">⏻</button>
            </form>
          </div>
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
