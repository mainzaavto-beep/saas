"use client";

// app/ThemeToggle.jsx — кнопка переключения тёмной/светлой темы.
// mounted-проверка нужна: next-themes на сервере не знает тему, а на клиенте
// подтягивает из localStorage/класса <html> — без gated-рендера виден блик
// иконки и hydration-warning.
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="topbar-action"
      title={isDark ? "Светлая тема" : "Тёмная тема"}
      aria-label="Переключить тему"
      // Зарезервируем ширину до маунта, чтобы кнопка не «прыгала» в layout.
      style={{ minWidth: 34, opacity: mounted ? 1 : 0 }}
    >
      {/* Иконку рендерим только после маунта — иначе SSR-размечание иконки
          не совпадёт с актуальной темой клиента. */}
      {mounted ? (isDark ? "☀️" : "🌙") : "·"}
    </button>
  );
}
