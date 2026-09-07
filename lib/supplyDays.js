// lib/supplyDays.js — общие дефолты/кламп порогов планирования поставок
// (спека «Склады 2.0» §4.1). Без «@/» — импортируется относительным путём и из
// lib/supplyPlanData.js, и из app/api/cabinets/[id]/settings/route.js, и из
// тестов через `node --test` (ревью раунд 1, 2026-09-07: раньше дефолты/кламп
// были продублированы в обоих местах).
export const SUPPLY_TARGET_DEFAULT = 30;
export const SUPPLY_MIN_DEFAULT = 14;

/** Целое 1..365, иначе dflt. */
export function clampDays(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(365, Math.max(1, Math.round(n)));
}
