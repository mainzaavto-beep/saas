#!/bin/bash
# run_saas_backfill.sh — запуск воркера в режиме drain-queue (onboarding backfill).
#   saas-backfill.service → run_saas_backfill.sh
#
# Берёт queued onboarding-jobs из jobs.collect_jobs (создаются при онбординге
# нового клиента) и прогоняет backfill за 75 дней (date_from/date_to из job).
# Идемпотентно (ON CONFLICT в сборщиках) — повторный прогон безопасен.
# Пауза между jobs внутри drain (DRAIN_PAUSE_SEC) — rate-limit для очереди клиентов.
#
# Таймер saas-backfill.timer крутит это 4×/день — подхватывает новых клиентов.
set -uo pipefail
export PYTHONIOENCODING=utf-8
export NO_PROXY=*

# Грузим env как run_saas_collect.sh: /etc/saas-worker.env + /etc/collectors.env.
set -a
[ -f /etc/saas-worker.env ] && . /etc/saas-worker.env
[ -f /etc/collectors.env ] && . /etc/collectors.env
set +a
export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas

mkdir -p /opt/agentsDB/logs
PY=/opt/agents/data-presenter-agent/.venv/bin/python

echo "=== SaaS backfill [drain-queue] $(date) ===" >> /opt/agentsDB/logs/saas_worker.log
cd /opt/agents/saas
$PY -m worker.orchestrator --drain-queue >> /opt/agentsDB/logs/saas_worker.log 2>&1
EXIT=$?
echo "EXIT=$EXIT" >> /opt/agentsDB/logs/saas_worker.log
exit $EXIT
