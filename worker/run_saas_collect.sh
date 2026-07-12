#!/bin/bash
# run_saas_collect.sh — параметризуемый запуск SAAS-воркера для systemd-таймеров.
#   saas-worker.service  → run_saas_collect.sh main    (4×/день, −2..сегодня)
#   saas-stocks.service  → run_saas_collect.sh stocks  (1×/день, снимок)
#
# Аргументы:
#   $1 = режим: "main" (14 сборщиков, без остатков) | "stocks" (только остатки)
#   $2 = дней назад FROM (по умолчанию: main=2, stocks=0)
#   $3 = дней назад TO   (по умолчанию: 0 = сегодня)
set -uo pipefail
export PYTHONIOENCODING=utf-8
export NO_PROXY=*

MODE="${1:-all}"
DAYS_FROM="${2:-}"
DAYS_TO="${3:-0}"

# Списки сборщиков по группам.
MAIN_COLLECTORS="wb_catalog,wb_orders,wb_finance,wb_order_costs,wb_metrics,wb_ads,wb_prices,ozon_catalog,ozon_orders,ozon_sales,ozon_finance,ozon_order_costs,ozon_metrics,ozon_efficiency"
STOCKS_COLLECTORS="wb_stocks,ozon_stocks"

case "$MODE" in
  main)   COLLECTORS="$MAIN_COLLECTORS";   DAYS_FROM="${DAYS_FROM:-2}" ;;
  stocks) COLLECTORS="$STOCKS_COLLECTORS"; DAYS_FROM="${DAYS_FROM:-0}" ;;
  *) echo "Неизвестный режим: $MODE (ожидаются main|stocks)" >&2; exit 1 ;;
esac

# Диапазон дат: FROM = сегодня − DAYS_FROM, TO = сегодня − DAYS_TO.
FROM=$(date -d "-${DAYS_FROM} days" +%Y-%m-%d)
TO=$(date -d "-${DAYS_TO} days" +%Y-%m-%d)

# Грузим env как run_orchestrator.py: /etc/saas-worker.env + /etc/collectors.env.
set -a
[ -f /etc/saas-worker.env ] && . /etc/saas-worker.env
[ -f /etc/collectors.env ] && . /etc/collectors.env
set +a
export SAAS_DB_HOST=localhost SAAS_DB_PORT=5432 SAAS_DB=saas

mkdir -p /opt/agentsDB/logs
PY=/opt/agents/data-presenter-agent/.venv/bin/python

echo "=== SaaS collect [$MODE] $(date) — период $FROM..$TO ===" >> /opt/agentsDB/logs/saas_worker.log
cd /opt/agents/saas
$PY -m worker.orchestrator --all --collectors "$COLLECTORS" --date-from "$FROM" --date-to "$TO" >> /opt/agentsDB/logs/saas_worker.log 2>&1
EXIT=$?
echo "EXIT=$EXIT" >> /opt/agentsDB/logs/saas_worker.log
exit $EXIT
