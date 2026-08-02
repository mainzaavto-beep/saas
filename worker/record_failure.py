"""
record_failure.py — фиксация падения systemd-юнита в jobs.collector_runs.

Вызов из saas-failure@.service (OnFailure=saas-failure@%n.service у всех saas-юнитов):
    python -m worker.record_failure <имя-юнита>

Ловит смерти, до которых оркестратор не доживает: TimeoutStartSec, OOM,
скрипт не стартовал. Подключение как postgres — env из /etc/saas-worker.env
(EnvironmentFile юнита). cabinet_id NULL: авария уровня прогона, не кабинета.
"""
import os
import sys
from datetime import datetime, timezone

import psycopg


def main():
    unit = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    now = datetime.now(timezone.utc)
    with psycopg.connect(
        host=os.environ.get("SAAS_DB_HOST", "localhost"),
        port=os.environ.get("SAAS_DB_PORT", "5432"),
        dbname=os.environ.get("SAAS_DB", "saas"),
        user="postgres",
        password=os.environ.get("POSTGRES_PASSWORD", ""),
    ) as conn:
        conn.execute(
            "INSERT INTO jobs.collector_runs "
            "(cabinet_id, collector, run_kind, status, error, started_at, finished_at) "
            "VALUES (NULL, %s, 'systemd', 'failed', %s, %s, %s)",
            (f"unit:{unit}",
             f"OnFailure: юнит {unit} завершился с ошибкой (см. journalctl -u {unit})",
             now, now))
    print(f"[record_failure] зафиксировано падение {unit}", flush=True)


if __name__ == "__main__":
    main()
