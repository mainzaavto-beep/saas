-- =====================================================================
--  SaaS, Этап 21: changelog — «Что нового» (глобальная лента для всех).
--
--  Таблица в shared.* БЕЗ RLS: записи общие для всех клиентов (фишки/
--  правки продукта), читает каждый залогиненный пользователь. Пишет
--  хозяин/агент через psql (UI-админки нет — намеренно: записи заводит
--  агент по мере работы).
--
--  type: feature (новая фишка) | improvement (улучшение) | fix (правка)
-- =====================================================================

CREATE TABLE IF NOT EXISTS shared.changelog (
    id          BIGSERIAL PRIMARY KEY,
    date        DATE     NOT NULL DEFAULT current_date,
    type        TEXT     NOT NULL DEFAULT 'feature',  -- feature | improvement | fix
    title       TEXT     NOT NULL,
    body        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_changelog_date ON shared.changelog(date DESC, id DESC);

-- Приложение читает только SELECT. INSERT/UPDATE — через postgres/агента.
GRANT SELECT ON shared.changelog TO saas_app;
