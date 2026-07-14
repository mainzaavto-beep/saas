-- 011_tax_mode.sql — Налоговый режим на магазин (per legal entity).
--
-- Модель (по просьбе хозяина, 2026-07-14):
--   type: 'usn_income'           — УСН «Доходы»,    tax = revenue × rate
--   type: 'usn_income_expenses'  — УСН «Доходы−Расходы», tax = max(0, revenue − expenses) × rate,
--                                  но не менее revenue × 1% (минимальный налог).
--   rate: int 1..15 (льготные регионы: 1-6 для Доходы, 5-15 для Доходы−Расходы).
--   vat:  number 0|5|7 — ставка НДС (0=без НДС, 5%, 7%). Пользователь выбирает сам,
--                        т.к. мы не знаем выручку за прошлый год (порог 20 млн ₽).
--
-- До этого tax_mode жил только на auth.cabinets (один режим на проект).
-- Теперь — на auth.shops (на каждое юрлицо отдельно).

ALTER TABLE auth.shops
  ADD COLUMN IF NOT EXISTS tax_mode JSONB DEFAULT '{"type":"usn_income","rate":6,"vat":false}'::jsonb;

-- Нормализовать legacy-формат {usn_pct, vat} → {type, rate, vat} (идемпотентно).
UPDATE auth.shops
SET tax_mode = jsonb_build_object(
  'type', 'usn_income',
  'rate', COALESCE((tax_mode->>'usn_pct')::int, 6),
  'vat', CASE WHEN COALESCE((tax_mode->>'vat')::boolean, false) THEN 7 ELSE 0 END
)
WHERE tax_mode ? 'usn_pct' OR NOT (tax_mode ? 'type');

-- Аналогично для cabinets (legacy project-level, оставляем для обратной совместимости).
UPDATE auth.cabinets
SET tax_mode = jsonb_build_object(
  'type', 'usn_income',
  'rate', COALESCE((tax_mode->>'usn_pct')::int, 6),
  'vat', CASE WHEN COALESCE((tax_mode->>'vat')::boolean, false) THEN 7 ELSE 0 END
)
WHERE tax_mode ? 'usn_pct' OR NOT (tax_mode ? 'type');

-- Если vat уже number но type/rate ещё legacy — нормализуем.
UPDATE auth.shops
SET tax_mode = jsonb_set(tax_mode, '{vat}', to_jsonb(CASE WHEN (tax_mode->>'vat')::boolean THEN 7 ELSE 0 END))
WHERE tax_mode ? 'vat' AND jsonb_typeof(tax_mode->'vat') = 'boolean';

UPDATE auth.cabinets
SET tax_mode = jsonb_set(tax_mode, '{vat}', to_jsonb(CASE WHEN (tax_mode->>'vat')::boolean THEN 7 ELSE 0 END))
WHERE tax_mode ? 'vat' AND jsonb_typeof(tax_mode->'vat') = 'boolean';
