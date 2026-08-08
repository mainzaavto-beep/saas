'use client';
// Полоса «идёт первичная загрузка». Сервер решает, показывать ли её при рендере
// (см. showLoading в layout.js); дальше компонент сам опрашивает статус, чтобы
// полоса исчезла без F5, когда данные доедут.
import { useEffect, useState } from 'react';

export default function LoadingBanner({ cabinetId }) {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/cabinets/${cabinetId}/onboarding-status`, { cache: 'no-store' });
        const j = await r.json();
        if (alive && j && j.loading === false) setLoading(false);
      } catch { /* сеть моргнула — покажем полосу дальше, следующая попытка через 30 с */ }
    };
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [cabinetId]);

  if (!loading) return null;
  // Тот же вид, что у остальных баннеров в layout.js (тон warn — нейтральной
  // тональности для баннеров нет, отдельный CSS-класс не заводим).
  return (
    <div style={{
      padding: "8px 16px", textAlign: "center", fontSize: 13,
      background: "rgba(255,193,7,.12)",
      color: "var(--warn, #d9a400)",
      borderBottom: "1px solid var(--border)",
    }}>
      Загружаем историю за 75 дней — обычно это занимает несколько минут. Данные появятся автоматически.
    </div>
  );
}
