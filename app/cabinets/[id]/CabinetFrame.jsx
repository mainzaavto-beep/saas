"use client";

// app/cabinets/[id]/CabinetFrame.jsx — каркас кабинета: разделы сверху, подразделы слева, вкладки над
// страницей (спека 2026-10-18-nav-sections). Дерево меню приходит уже отфильтрованным по роли
// (layout.js → navForRole). Активный пункт считается здесь, по usePathname: серверный layout в App
// Router не перерисовывается при переходах по <Link>, поэтому подсветка из заголовка x-pathname
// «застревала» на странице первой загрузки.
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { resolveNav, firstHref } from "@/lib/cabinetNav.js";

const COLLAPSE_KEY = "cab-side-collapsed";

export default function CabinetFrame({ nav, basePath, actions, userBlock, banners, children }) {
  const pathname = usePathname() || "";
  const current = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : "";
  const { sectionKey, itemKey, tabHref } = resolveNav(current, nav);
  // Вне разделов (настройки, поддержка…) панель показывает первый раздел без активного пункта.
  const section = nav.find((s) => s.key === sectionKey) || nav[0];
  const item = section?.items.find((i) => i.key === itemKey);

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1"); } catch (e) { console.error(e); }
  }, []);
  useEffect(() => { setMobileOpen(false); }, [pathname]);
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      try { localStorage.setItem(COLLAPSE_KEY, v ? "0" : "1"); } catch (e) { console.error(e); }
      return !v;
    });
  };

  return (
    <div className={"cab-frame" + (collapsed ? " collapsed" : "")}>
      {mobileOpen && <div className="cab-overlay" onClick={() => setMobileOpen(false)} />}
      <aside className={"cab-side" + (mobileOpen ? " open" : "")}>
        <div className="cab-side-head">
          <Link href={basePath} className="cab-brand" title="SySell">
            <span className="brand-mark">📊</span>
            <span className="cab-brand-text">SySell</span>
          </Link>
          <button type="button" className="cab-collapse" onClick={toggleCollapsed}
            title={collapsed ? "Развернуть панель" : "Свернуть панель"}>
            {collapsed ? "»" : "«"}
          </button>
        </div>
        {section && (
          <nav className="cab-side-nav">
            <div className="cab-side-title">{section.label}</div>
            {section.items.map((i) => (
              <Link key={i.key} href={basePath + firstHref(i)} title={i.label}
                className={"cab-side-link" + (i.key === itemKey && section.key === sectionKey ? " active" : "")}>
                <span className="cab-side-icon">{i.icon}</span>
                <span className="cab-side-label">{i.label}</span>
                {i.tabs && i.tabs.length > 1 && <span className="cab-side-chev">›</span>}
              </Link>
            ))}
          </nav>
        )}
        <div className="cab-side-foot">{userBlock}</div>
      </aside>

      <div className="cab-body">
        <header className="topbar">
          <div className="topbar-inner">
            <button type="button" className="cab-burger" onClick={() => setMobileOpen(true)} aria-label="Меню">☰</button>
            <nav className="topnav">
              {nav.map((s) => (
                <Link key={s.key} href={basePath + firstHref(s)}
                  className={"topnav-link" + (s.key === sectionKey ? " active" : "")}>
                  <span className="topnav-icon">{s.icon}</span>
                  <span className="topnav-label">{s.label}</span>
                </Link>
              ))}
            </nav>
            <div className="topbar-actions">{actions}</div>
          </div>
        </header>
        {banners}
        <main className="main">
          {item?.tabs && item.tabs.length > 1 && (
            <div className="cab-tabs">
              {item.tabs.map((t) => (
                <Link key={t.href} href={basePath + t.href}
                  className={"cab-tab" + (t.href === tabHref ? " active" : "")}>
                  {t.label}
                </Link>
              ))}
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
