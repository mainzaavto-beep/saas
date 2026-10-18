// lib/cabinetNav.js — навигация кабинета: раздел (сверху) → пункт (слева) → вкладки (над страницей).
// Чистые данные и функции, без React и БД — общие для layout.js (сервер, фильтр по роли) и
// CabinetNav.jsx (клиент, подсветка по пути). Спека docs/superpowers/specs/2026-10-18-nav-sections-design.md.
// href — путь внутри кабинета (без /cabinets/<id>); "" — Главная.
// roles — видимость пункта (нет поля — видят все); только витрина, доступ режет сервер (requireRole).

export const NAV = [
  {
    key: "analytics", label: "Аналитика", icon: "📊",
    items: [
      { key: "home", label: "Главная", icon: "🏠", href: "" },
      { key: "kpi", label: "Дашборд показателей", icon: "📈", href: "/kpi" },
      { key: "rnp", label: "РНП (пульс)", icon: "💓", href: "/rnp" },
      { key: "summary", label: "Сводка по товарам", icon: "📦", href: "/summary" },
      {
        key: "orders", label: "Заказы", icon: "🧾",
        tabs: [
          { label: "Заказы", href: "/orders" },
          { label: "Матрица заказов", href: "/order-matrix" },
          { label: "Заказы по времени", href: "/timing" },
          { label: "География", href: "/geo" },
        ],
      },
      { key: "search", label: "Поиск и запросы", icon: "🔎", href: "/search" },
      { key: "abc", label: "ABC анализ", icon: "🔤", href: "/abc" },
      { key: "reviews", label: "Отзывы", icon: "⭐", href: "/reviews" },
    ],
  },
  {
    key: "goods", label: "Товары", icon: "🏷️",
    items: [
      { key: "stocks", label: "Склады и индексы", icon: "🏬", href: "/stocks" },
      {
        key: "stock", label: "Остатки", icon: "📚",
        tabs: [
          { label: "Остатки на МП", href: "/mp-stock" },
          { label: "Остатки склад/ФФ", href: "/inventory" },
          { label: "Отгрузки", href: "/shipments" },
          { label: "Перемещение", href: "/move" },
        ],
      },
      { key: "buyout", label: "Процент выкупа", icon: "🔁", href: "/buyout" },
      { key: "items", label: "Себестоимость", icon: "🧮", href: "/items" },
    ],
  },
  {
    key: "purchases", label: "Закупки", icon: "🛒",
    items: [
      { key: "fin-purchases", label: "Закупки", icon: "🛒", href: "/fin-purchases" },
      { key: "deliveries", label: "Доставлено на склад", icon: "🚚", href: "/deliveries" },
      { key: "purchase-need", label: "Потребность", icon: "📋", href: "/purchase-need" },
      { key: "purchase-plan", label: "План закупок", icon: "🗓️", href: "/fin-purchase-plan" },
    ],
  },
  {
    key: "finance", label: "Финансы", icon: "💰",
    items: [
      {
        key: "profit", label: "Прибыль", icon: "📊",
        tabs: [
          { label: "Сводка по прибыли", href: "/pnl" },
          { label: "Юнит-экономика", href: "/unit" },
          { label: "План продаж", href: "/fin-plan" },
        ],
      },
      {
        key: "money", label: "Деньги", icon: "💳",
        tabs: [
          { label: "ДДС", href: "/fin-dds" },
          { label: "План поступлений", href: "/fin-income" },
          { label: "Платёжный календарь", href: "/fin-calendar" },
        ],
      },
      {
        key: "costs", label: "Расходы", icon: "🧾",
        tabs: [
          { label: "Сопутств. расходы", href: "/fin-manual" },
          { label: "Самовыкупы", href: "/fin-self-buyouts" },
        ],
      },
      { key: "balance", label: "Баланс", icon: "⚖️", href: "/fin-balance", roles: ["owner"] },
      { key: "bonus", label: "Премия", icon: "🏆", href: "/bonus", roles: ["owner", "manager"] },
    ],
  },
];

// Страницы без своего пункта меню подсвечивают «родителя» (значение — href из NAV).
export const ALIASES = {
  "/detail": "/summary",
  "/buyer-portrait": "/summary",
  "/briefing": "",
  "/warehouses": "/stocks",
  "/ff-stock": "/inventory",
};

// Страницы вне разделов: доступны из правого угла сверху и из блока пользователя слева.
export const OUTSIDE = ["/alerts", "/whats-new", "/support", "/billing", "/settings", "/team", "/content"];

const canSee = (role) => (x) => !x.roles || x.roles.includes(role);

// Дерево без недоступных роли пунктов; пустые разделы/пункты выпадают.
export function navForRole(nav, role) {
  return nav
    .map((s) => ({
      ...s,
      items: s.items
        .filter(canSee(role))
        .map((i) => (i.tabs ? { ...i, tabs: i.tabs.filter(canSee(role)) } : i))
        .filter((i) => !i.tabs || i.tabs.length),
    }))
    .filter((s) => s.items.length);
}

// Куда ведёт клик: раздел → первый пункт, пункт с вкладками → первая вкладка.
export function firstHref(node) {
  if (node.items) return firstHref(node.items[0]);
  if (node.tabs) return node.tabs[0].href;
  return node.href;
}

export function allHrefs(nav) {
  return nav.flatMap((s) => s.items.flatMap((i) => (i.tabs ? i.tabs.map((t) => t.href) : [i.href])));
}

// Путь внутри кабинета → активные раздел/пункт/вкладка. Совпадение — сам href или его подпуть
// (/orders/123 → /orders, но /order-matrix ≠ /orders). Вне меню — все null.
export function resolveNav(path, nav) {
  const p = (path || "").replace(/\/+$/, "");
  const under = (href) => (href === "" ? p === "" : p === href || p.startsWith(href + "/"));
  const aliasFrom = Object.keys(ALIASES).find(under);
  const target = aliasFrom !== undefined ? ALIASES[aliasFrom] : null;
  const hit = (href) => (target !== null ? href === target : under(href));
  for (const s of nav) {
    for (const i of s.items) {
      if (i.tabs) {
        const t = i.tabs.find((x) => hit(x.href));
        if (t) return { sectionKey: s.key, itemKey: i.key, tabHref: t.href };
      } else if (hit(i.href)) {
        return { sectionKey: s.key, itemKey: i.key, tabHref: null };
      }
    }
  }
  return { sectionKey: null, itemKey: null, tabHref: null };
}
