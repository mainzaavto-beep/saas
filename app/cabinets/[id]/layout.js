// app/cabinets/[id]/layout.js — верхняя горизонтальная навигация + проверка доступа.
import { getSession } from "@/lib/session.js";
import { query } from "@/lib/db.js";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import ThemeToggle from "@/app/ThemeToggle.jsx";
import { cabinetAccess } from "@/lib/billing.js";
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
  { href: "/billing", label: "Подписка", icon: "💳" },
];

export default async function CabinetLayout({ children, params }) {
  const cabinetId = Number(params.id);
  const session = await getSession();
  if (!session?.user_id) redirect("/login");

  const mem = await query(
    `SELECT c.display_name, c.marketplaces, c.trial_ends_at, c.paid_until, u.email_verified_at
     FROM auth.memberships m
     JOIN auth.cabinets c ON c.cabinet_id = m.cabinet_id
     JOIN auth.users u ON u.user_id = m.user_id
     WHERE m.user_id = $1 AND m.cabinet_id = $2`,
    [session.user_id, cabinetId]
  );
  if (!mem.length) redirect("/");

  const cab = mem[0];
  const basePath = `/cabinets/${cabinetId}`;

  // Магазины со сломанными ключами: данные по ним не собираются, и клиент
  // должен узнать об этом сам, а не по устаревшим цифрам в отчётах.
  const brokenShops = await query(
    `SELECT mp_code, shop_name, auth_state, auth_failed_at
       FROM auth.shops
      WHERE cabinet_id = $1 AND is_active = true AND auth_state <> 'ok'
      ORDER BY mp_code`,
    [cabinetId]
  );

  // Список всех проектов пользователя — для dropdown выбора.
  const allProjects = await query(
    `SELECT c.cabinet_id, c.display_name, c.marketplaces
     FROM auth.cabinets c
     JOIN auth.memberships m ON m.cabinet_id = c.cabinet_id
     WHERE m.user_id = $1 AND c.status <> 'deleted'
     ORDER BY c.cabinet_id`,
    [session.user_id]
  );

  // Текущий путь — для подсветки активного пункта меню (приходит из
  // middleware.js: x-invoke-path — внутренний заголовок Next, наружу не идёт).
  const h = await headers();
  const pathname = h.get("x-pathname") || "";
  const current = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : "";

  // Состояние подписки — один расчёт на всю панель (lib/billing.js).
  const access = cabinetAccess(cab);
  // Заблокированный кабинет пускаем только на страницу оплаты — иначе редирект
  // на неё же зациклится.
  const isBilling = current.startsWith("/billing");
  if (access.state === "locked" && !isBilling) redirect(`${basePath}/billing`);

  const banners = [];
  if (access.state === "trial") {
    banners.push({ tone: "warn", text: `Пробный период — осталось ${access.daysLeft} дн. (до ${access.until.toLocaleDateString("ru-RU")})` });
  } else if (access.state === "active" && access.daysLeft <= 5) {
    banners.push({ tone: "warn", text: `Подписка заканчивается ${access.until.toLocaleDateString("ru-RU")}` });
  } else if (access.state === "grace") {
    banners.push({ tone: "neg", text: `Срок подписки истёк. Доступ закроется ${access.graceUntil.toLocaleDateString("ru-RU")} — оплатите подписку.` });
  }
  for (const s of brokenShops) {
    const mp = s.mp_code === "wb" ? "Wildberries" : s.mp_code === "ozon" ? "Ozon" : s.mp_code;
    const since = s.auth_failed_at
      ? ` — данные не обновляются с ${new Date(s.auth_failed_at).toLocaleDateString("ru-RU")}`
      : "";
    banners.push({
      tone: "neg",
      text: `${mp}: ключи не работают${since}.`,
      link: { href: `/settings?cabinet=${cabinetId}&tab=settings`, label: "Обновить ключи" },
    });
  }
  if (!cab.email_verified_at) {
    banners.push({ tone: "warn", text: `Подтвердите почту — мы отправили письмо на ${session.email}.`, link: { href: "/settings", label: "Выслать ещё раз" } });
  }

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
      {banners.map((b, i) => (
        <div key={i} style={{
          padding: "8px 16px", textAlign: "center", fontSize: 13,
          background: b.tone === "neg" ? "rgba(255,107,107,.12)" : "rgba(255,193,7,.12)",
          color: b.tone === "neg" ? "var(--neg, #ff6b6b)" : "var(--warn, #d9a400)",
          borderBottom: "1px solid var(--border)",
        }}>
          {b.text}{" "}
          {b.link && <a href={b.link.href} style={{ color: "inherit", textDecoration: "underline" }}>{b.link.label}</a>}
          {(b.tone === "neg" || b.tone === "warn") && !b.link && (
            <a href={`${basePath}/billing`} style={{ color: "inherit", textDecoration: "underline" }}>Оплатить</a>
          )}
        </div>
      ))}
      <main className="main">{children}</main>
    </div>
  );
}
