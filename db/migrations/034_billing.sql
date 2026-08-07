-- 034: оплата подписки. Состояние доступа НЕ хранится — вычисляется из
-- trial_ends_at и paid_until (lib/billing.js). billing.payments — журнал
-- платежей и источник истины для сверки с кабинетом ЮKassa.
ALTER TABLE auth.cabinets ADD COLUMN IF NOT EXISTS paid_until TIMESTAMPTZ;

CREATE SCHEMA IF NOT EXISTS billing;
GRANT USAGE ON SCHEMA billing TO saas_app;

-- Тарифы. Цены задаёт владелец INSERT'ом при внедрении: в коде их нет,
-- менять можно без пересборки панели.
CREATE TABLE IF NOT EXISTS billing.plans (
  code       TEXT PRIMARY KEY,
  months     INT NOT NULL CHECK (months > 0),
  price_rub  NUMERIC(10,2) NOT NULL CHECK (price_rub > 0),
  title      TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  sort       INT NOT NULL DEFAULT 0
);

-- Журнал платежей. payment_id — идентификатор ЮKassa, он же ключ
-- идемпотентности: повторное уведомление по тому же платежу не продлит
-- подписку второй раз.
CREATE TABLE IF NOT EXISTS billing.payments (
  payment_id        TEXT PRIMARY KEY,
  cabinet_id        BIGINT NOT NULL REFERENCES auth.cabinets(cabinet_id) ON DELETE CASCADE,
  user_id           BIGINT NOT NULL REFERENCES auth.users(user_id),
  plan_code         TEXT NOT NULL,
  months            INT NOT NULL,
  amount_rub        NUMERIC(10,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','succeeded','canceled')),
  paid_until_before TIMESTAMPTZ,
  paid_until_after  TIMESTAMPTZ,
  raw               JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_cabinet_idx ON billing.payments (cabinet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_pending_idx ON billing.payments (created_at) WHERE status = 'pending';

GRANT SELECT ON billing.plans TO saas_app;
GRANT SELECT, INSERT, UPDATE ON billing.payments TO saas_app;
