"""Состояние ключей магазина: пауза при отказах авторизации и возврат в работу.

Единственное место, где меняется auth_state. Правило простое:
  ok → failing → paused, любой успех сбрасывает в ok.
Пауза проверяется по времени: раз в сутки магазин пробуется снова — вдруг
отказ был на стороне маркетплейса, а не у клиента.
"""
import os
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

# Сколько отказов подряд до паузы и как часто пробовать паузу на прочность.
FAIL_THRESHOLD = int(os.environ.get("SAAS_AUTH_FAIL_THRESHOLD", "2"))
RETRY_AFTER = timedelta(hours=int(os.environ.get("SAAS_AUTH_RETRY_HOURS", "24")))

PG = {
    "host": os.environ.get("SAAS_DB_HOST", "localhost"),
    "port": int(os.environ.get("SAAS_DB_PORT", "5432")),
    "dbname": os.environ.get("SAAS_DB", "saas"),
    "user": os.environ.get("POSTGRES_USER", "postgres"),
    "password": os.environ.get("POSTGRES_PASSWORD"),
}


def load_state(shop_id):
    """Строка состояния магазина или None, если магазина нет."""
    with psycopg.connect(**PG, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT shop_id, mp_code, auth_state, auth_fail_count, auth_failed_at, "
                "       auth_last_error FROM auth.shops WHERE shop_id = %s",
                (shop_id,),
            )
            return cur.fetchone()


def mark_failure(shop_id, error):
    """Засчитать отказ авторизации. Возвращает новое состояние ('failing'|'paused')."""
    with psycopg.connect(**PG, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE auth.shops
                      SET auth_fail_count = auth_fail_count + 1,
                          auth_state = CASE WHEN auth_fail_count + 1 >= %s
                                            THEN 'paused' ELSE 'failing' END,
                          auth_failed_at = now(),
                          auth_last_error = %s
                    WHERE shop_id = %s
                RETURNING auth_state""",
                (FAIL_THRESHOLD, str(error)[:500], shop_id),
            )
            row = cur.fetchone()
            return row["auth_state"] if row else None


def mark_ok(shop_id):
    """Успешный сбор: сбрасываем счётчик и состояние. Серия отказов должна быть
    непрерывной, иначе редкие одиночные сбои за месяц накопятся в ложную паузу."""
    with psycopg.connect(**PG) as conn:
        conn.execute(
            "UPDATE auth.shops SET auth_state = 'ok', auth_fail_count = 0, "
            "       auth_last_error = NULL, auth_notified_at = NULL "
            " WHERE shop_id = %s AND (auth_state <> 'ok' OR auth_fail_count <> 0)",
            (shop_id,),
        )


def should_skip(state_row, now=None):
    """Пропустить магазин в этом прогоне? Пауза держится сутки, потом даём
    контрольную попытку (её результат снова пройдёт через mark_ok/mark_failure)."""
    if not state_row or state_row.get("auth_state") != "paused":
        return False
    failed_at = state_row.get("auth_failed_at")
    if not failed_at:
        return False
    now = now or datetime.now(timezone.utc)
    return (now - failed_at) < RETRY_AFTER
