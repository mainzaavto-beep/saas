"""Состояние сессии кабинета продавца Ozon у магазина (auth.shops.cabinet_*) —
зеркало worker/shop_auth.py для «сломанных ключей», но проще: одно состояние
'expired' без счётчиков (сессия либо жива, либо нет; вход делает только владелец).
Пока expired — оркестратор пропускает сборщики кабинета, раз в RETRY_HOURS
пробует снова (владелец мог войти). Успех → 'ok'. Письмо/баннер читают
cabinet_state/cabinet_failed_at/cabinet_notified_at (задача 6)."""
import os
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

PG = dict(host=os.environ.get("SAAS_DB_HOST", "localhost"), port=int(os.environ.get("SAAS_DB_PORT", "5432")),
          dbname=os.environ.get("SAAS_DB", "saas"), user="postgres",
          password=os.environ.get("POSTGRES_PASSWORD", ""))
RETRY_HOURS = int(os.environ.get("SAAS_CABINET_RETRY_HOURS", "20"))


def load_state(shop_id):
    with psycopg.connect(**PG, row_factory=dict_row) as conn:
        return conn.execute(
            "SELECT cabinet_state, cabinet_failed_at, cabinet_last_attempt_at, cabinet_last_error "
            "FROM auth.shops WHERE shop_id = %s", (shop_id,)).fetchone() or {}


def mark_expired(shop_id, error):
    """Переход в expired; дата начала эпизода ставится один раз (для баннера/письма),
    последняя попытка двигается всегда (для should_skip)."""
    with psycopg.connect(**PG) as conn:
        conn.execute(
            """UPDATE auth.shops
                  SET cabinet_failed_at = CASE WHEN cabinet_state <> 'expired' THEN now() ELSE cabinet_failed_at END,
                      cabinet_notified_at = CASE WHEN cabinet_state <> 'expired' THEN NULL ELSE cabinet_notified_at END,
                      cabinet_state = 'expired',
                      cabinet_last_attempt_at = now(),
                      cabinet_last_error = %s
                WHERE shop_id = %s""", (str(error)[:500], shop_id))


def mark_ok(shop_id):
    with psycopg.connect(**PG) as conn:
        conn.execute(
            "UPDATE auth.shops SET cabinet_state = 'ok', cabinet_failed_at = NULL, cabinet_last_attempt_at = now(), "
            "       cabinet_last_error = NULL, cabinet_notified_at = NULL "
            " WHERE shop_id = %s AND cabinet_state <> 'ok'", (shop_id,))


def should_skip(state, now=None):
    """expired и последняя попытка моложе RETRY_HOURS → пропустить тик."""
    if (state or {}).get("cabinet_state") != "expired":
        return False
    last = state.get("cabinet_last_attempt_at")
    if not last:
        return False
    now = now or datetime.now(timezone.utc)
    return now - last < timedelta(hours=RETRY_HOURS)
