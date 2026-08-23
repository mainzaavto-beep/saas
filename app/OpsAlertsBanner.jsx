'use client';
// Операторский баннер поверх всей панели (app/layout.js — на всех страницах,
// включая /cabinets/*, /settings, /health). Обычный клиент запрос делает
// (fetch безусловный — так дешевле, чем городить проверку роли на клиенте),
// но тело получает только ops (allowlist в /api/ops/alerts): для остальных
// роут отвечает 401/403, и баннер рендерит null — обычный пользователь его
// не видит.
import { useEffect, useState } from 'react';
import { C, soft } from '@/lib/palette.js';

export default function OpsAlertsBanner() {
  const [alerts, setAlerts] = useState([]);

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
    <div style={{
      position: 'sticky', top: 0, zIndex: 1000,
      padding: '8px 16px', fontSize: 13,
      background: isRed ? soft('neg', 12) : soft('warn', 12),
      color: isRed ? C.neg : C.warn,
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
