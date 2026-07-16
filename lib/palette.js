// =====================================================================
//  lib/palette.js — единая палитра дашборда поверх CSS-переменных.
//
//  Значения — строки вида "var(--token)". Браузер резолвит их реактивно
//  при смене класса темы (.dark/.light) на <html>, поэтому все inline-стили
//  вроде style={{ background: C.surface }} мгновенно перекрашиваются.
//
//  Заменяет ~30 дублированных per-page объектов const C = {...}.
//  Токены определены в app/globals.css (базовые + алиасы).
//
//  soft(token, pct) — alpha-эффект через color-mix (замена конкатенации
//  вида ${C.line}33). pct = процент непрозрачности (33 → ~20% alpha-байт 0x33).
//  Полностью поддерживается в 2026 (Chrome 111+, FF 113+, Safari 16.4+).
// =====================================================================

export const C = {
  bg: "var(--bg)",
  surface: "var(--surface)",
  surfaceAlt: "var(--surfaceAlt)",
  ink: "var(--ink)",
  muted: "var(--muted)",
  faint: "var(--faint)",
  line: "var(--line)",
  accent: "var(--accent)",
  accent2: "var(--accent2)",
  pos: "var(--pos)",
  neg: "var(--neg)",
  warn: "var(--warn)",
  pink: "var(--pink)",
  blue: "var(--blue)",
};

// Alpha-эффект для цвета по имени токена. Пример: soft("line", 20) ≈ rgba линии
// с ~20% непрозрачности. Использовать вместо устаревшей конкатенации `${C.line}33`.
export function soft(token, pct) {
  return `color-mix(in srgb, var(--${token}) ${pct}%, transparent)`;
}
