-- 036: гигиена. Отметка о последнем входе (для поддержки и разбора инцидентов)
-- и отдельный статус для платежа, чья сумма не сошлась с тарифом: раньше он
-- помечался succeeded, из-за чего выглядел как обычная успешная оплата.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

ALTER TABLE billing.payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE billing.payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending','succeeded','canceled','mismatch'));
