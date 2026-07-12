-- Создание БД saas с портативным collate C (для корректной сортировки в SaaS)
CREATE DATABASE saas WITH ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
