-- =====================================================================
--  SaaS, Этап 3+: шифрование credentials клиентов (pgcrypto).
--  api_creds (JSONB) — НЕсекретная структура (какие МП, есть ли perf-creds).
--  api_creds_enc (TEXT) — секреты (токены/ключи), зашифрованные pgp_sym_encrypt.
--  Ключ передаётся в запросе параметром из env SAAS_CRED_MASTER_KEY — НЕ хранится в БД.
--  Идемпотентно.
-- =====================================================================

ALTER TABLE auth.cabinets ADD COLUMN IF NOT EXISTS api_creds_enc TEXT;

COMMENT ON COLUMN auth.cabinets.api_creds_enc IS
  'Шифртекст pgp_sym_encrypt полных credentials JSON (токены/ключи). Ключ — в env SAAS_CRED_MASTER_KEY, НЕ в БД. Расшифровка: pgp_sym_decrypt(api_creds_enc::bytea, $key).';
