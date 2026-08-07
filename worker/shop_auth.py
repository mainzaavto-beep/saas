"""Состояние ключей магазина: пауза при отказах авторизации и возврат в работу.

Единственное место, где меняется auth_state. Правило простое:
  ok → failing → paused, любой успех сбрасывает в ok.
Пауза проверяется по времени: раз в сутки магазин пробуется снова — вдруг
отказ был на стороне маркетплейса, а не у клиента.

Два разных поля времени, не путать:
  auth_failed_at       — НАЧАЛО эпизода (для баннера/письма клиенту).
                          Ставится один раз, при первом отказе после ok.
  auth_last_attempt_at — последняя попытка (для should_skip/cadence).
                          Двигается на каждый отказ, включая суточные
                          контрольные попытки — от него отсчитываются сутки
                          до следующей попытки.
"""
import os
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.rows import dict_row

# Сколько отказов подряд до паузы и как часто пробовать паузу на прочность.
FAIL_THRESHOLD = int(os.environ.get("SAAS_AUTH_FAIL_THRESHOLD", "2"))
RETRY_AFTER = timedelta(hours=int(os.environ.get("SAAS_AUTH_RETRY_HOURS", "24")))

# Параметры подключения повторяют PG_SUPER из worker/orchestrator.py. Держим
# копию, а не импорт: с задачи 3 оркестратор импортирует этот модуль, и
# обратный импорт замкнул бы цикл. При правке одного места правь оба.
PG = {
    "host": os.environ.get("SAAS_DB_HOST", "localhost"),
    "port": os.environ.get("SAAS_DB_PORT", "5432"),
    "dbname": os.environ.get("SAAS_DB", "saas"),
    "user": "postgres",
    "password": os.environ.get("POSTGRES_PASSWORD", ""),
}


def load_state(shop_id):
    """Строка состояния магазина или None, если магазина нет."""
    with psycopg.connect(**PG, row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT shop_id, mp_code, auth_state, auth_fail_count, auth_failed_at, "
                "       auth_last_attempt_at, auth_last_error "
                "  FROM auth.shops WHERE shop_id = %s",
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
                          -- Дата начала эпизода, не последнего отказа: ставим
                          -- только на переходе ok→failing (счётчик был 0),
                          -- иначе суточные контрольные попытки переписывают
                          -- дату и баннер/письмо занижают масштаб поломки.
                          auth_failed_at = CASE WHEN auth_fail_count = 0
                                            THEN now() ELSE auth_failed_at END,
                          -- А это двигаем всегда — should_skip считает сутки
                          -- паузы от последней попытки, не от начала эпизода.
                          auth_last_attempt_at = now(),
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
            "       auth_failed_at = NULL, auth_last_attempt_at = NULL, "
            "       auth_last_error = NULL, auth_notified_at = NULL "
            " WHERE shop_id = %s AND (auth_state <> 'ok' OR auth_fail_count <> 0)",
            (shop_id,),
        )


def should_skip(state_row, now=None):
    """Пропустить магазин в этом прогоне? Пауза держится сутки, потом даём
    контрольную попытку (её результат снова пройдёт через mark_ok/mark_failure).

    Считаем от auth_last_attempt_at (последняя попытка), а не auth_failed_at
    (начало эпизода) — иначе после первых суток пауза переставала бы работать
    вовсе: now() - <дата начала эпизода> рано или поздно навсегда превышает
    RETRY_AFTER, и магазин снова пробовался бы на каждом прогоне (см. 038).
    Fallback на auth_failed_at — для строк, обновлённых до миграции 038,
    у которых auth_last_attempt_at ещё не заполнен."""
    if not state_row or state_row.get("auth_state") != "paused":
        return False
    checked_at = state_row.get("auth_last_attempt_at") or state_row.get("auth_failed_at")
    if not checked_at:
        return False
    now = now or datetime.now(timezone.utc)
    return (now - checked_at) < RETRY_AFTER
