'use client';
// Полоса «идёт первичная загрузка». Сервер решает, показывать ли её при рендере
// (см. showLoading в layout.js); дальше компонент сам опрашивает статус, чтобы
// полоса исчезла без F5, когда данные доедут — а если задание упадёт прямо во
// время ожидания клиента (status='failed'), полоса «загружаем» не должна тихо
// пропасть: клиенту нужно узнать, что случился сбой, а не ждать бесконечно.
import { useEffect, useState } from 'react';
import { BACKFILL_DAYS } from '@/lib/mpConfig.js';
import { soft } from '@/lib/palette.js';

export default function LoadingBanner({ cabinetId }) {
  // 'loading' — показываем полосу (стартовое состояние: компонент рендерится
  // сервером только когда onboardingState === 'loading'); 'failed' — задание
  // упало, показываем баннер ошибки; 'done' — прятать баннер вовсе.
  const [phase, setPhase] = useState('loading');

  useEffect(() => {
    let alive = true;
    let id;
    const tick = async () => {
      try {
        const r = await fetch(`/api/cabinets/${cabinetId}/onboarding-status`, { cache: 'no-store' });
        const j = await r.json();
        if (!alive || !j) return;
        if (j.state === 'loading') return; // ждём дальше, следующий опрос через 30 с
        // Любое другое состояние — терминальное для этой полосы: 'failed' показываем,
        // остальное ('idle'/'broken_keys' — ключи сломались уже после рендера,
        // страницу обновит следующий переход) прячем и останавливаем опрос.
        setPhase(j.state === 'failed' ? 'failed' : 'done');
        clearInterval(id);
      } catch { /* сеть моргнула — попробуем на следующем тике через 30 с */ }
    };
    id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [cabinetId]);

  if (phase === 'done') return null;

  if (phase === 'failed') {
    // Тот же вид, что у баннера сломанных ключей в layout.js — тон «ошибка»:
    // это реальный сбой сборки без ретраев, а не «подождите ещё немного».
    return (
      <div style={{
        padding: "8px 16px", textAlign: "center", fontSize: 13,
        background: soft("neg", 12),
        color: "var(--neg, #ff6b6b)",
        borderBottom: "1px solid var(--border)",
      }}>
        Не получилось загрузить историю заказов — сбой на нашей стороне, не в ваших ключах. Мы уже знаем о проблеме и разбираемся.
      </div>
    );
  }

  // Тот же вид, что у остальных баннеров в layout.js (тон warn — нейтральной
  // тональности для баннеров нет, отдельный CSS-класс не заводим).
  return (
    <div style={{
      padding: "8px 16px", textAlign: "center", fontSize: 13,
      background: "rgba(255,193,7,.12)",
      color: "var(--warn, #d9a400)",
      borderBottom: "1px solid var(--border)",
    }}>
      Загружаем историю за {BACKFILL_DAYS} дней — обычно это занимает несколько минут. Данные появятся автоматически.
    </div>
  );
}
