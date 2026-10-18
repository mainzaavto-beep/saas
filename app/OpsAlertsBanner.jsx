'use client';
// Операторский баннер поверх всей панели (app/layout.js — на всех страницах,
// включая /cabinets/*, /settings, /health). Обычный клиент запрос делает
// (fetch безусловный — так дешевле, чем городить проверку роли на клиенте),
// но тело получает только ops (allowlist в /api/ops/alerts): для остальных
// роут отвечает 401/403, и баннер рендерит null — обычный пользователь его
// не видит.
import { useEffect, useRef, useState } from 'react';
import { C, soft } from '@/lib/palette.js';

export default function OpsAlertsBanner() {
  const [alerts, setAlerts] = useState([]);
  const ref = useRef(null);

  // Высота баннера → CSS-переменная --ops-h: липкие шапка и левая панель кабинета
  // (CabinetFrame) отступают на неё, иначе баннер срезает низ панели.
  useEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!el) { root.style.removeProperty('--ops-h'); return; }
    const set = () => root.style.setProperty('--ops-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty('--ops-h'); };
  }, [alerts.length]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/ops/alerts', { cache: 'no-store' });
        if (!r.ok) return; // 401/403 — не ops, баннера нет
        const j = await r.json();
        if (alive && Array.isArray(j?.alerts)) setAlerts(j.alerts);
      } catch { /* сеть моргнула — баннера нет, не страшно: это диагностика оператора */ }
    })();
    return () => { alive = false; };
  }, []);

  if (alerts.length === 0) return null;

  const isRed = alerts.some((a) => a.level === 'red');

  return (
    <div ref={ref} style={{
      position: 'sticky', top: 0, zIndex: 1000,
      padding: '8px 16px', fontSize: 13,
      background: isRed ? soft('neg', 12) : soft('warn', 12),
      // тёмный сдвиг к ink держит AA (>=4.5:1) на soft(...,12)-подложке в обеих
      // темах: в light ink тёмный — текст темнеет, в dark ink светлый — светлеет.
      color: `color-mix(in srgb, ${isRed ? 'var(--neg)' : 'var(--warn)'} 78%, var(--ink))`,
      border: `1px solid ${isRed ? soft('neg', 35) : soft('warn', 35)}`,
      borderBottom: '1px solid var(--border)',
    }}>
      <strong>Оператор:</strong>{' '}
      {alerts.map((a, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {a.text}
        </span>
      ))}
    </div>
  );
}
