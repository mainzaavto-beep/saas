-- 032: регистронезависимая уникальность email.
-- До этого UNIQUE был по точному значению: user@x.ru и User@x.ru — два аккаунта,
-- при том что приложение нормализует email в нижний регистр при входе.
-- Проверено 2026-08-06: дублей по lower(email) в проде нет.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq ON auth.users (lower(email));
