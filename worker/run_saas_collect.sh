#!/bin/bash
# run_saas_collect.sh — параметризуемый запуск SAAS-воркера для systemd-таймеров.
#   saas-worker.service       → run_saas_collect.sh main    (4×/день, −2..сегодня)
#   saas-stocks.service       → run_saas_collect.sh stocks  (1×/день, снимок)
#   saas-sku-ad-night.service → run_saas_collect.sh skuad   (1×/ночь, ozon_sku_ad)
#
# Аргументы:
#   $1 = режим: "main" (14 сборщиков, без остатков) | "stocks" (только остатки)
#        | "skuad" (только ozon_sku_ad, ночной тик)
#        | "fbsstatus" (только wb_fbs_status, часовой опрос статусов FBS)
#   $2 = дней назад FROM (по умолчанию: main=2, stocks=0, skuad=2)
#   $3 = дней назад TO   (по умолчанию: 0 = сегодня)
set -uo pipefail
export PYTHONIOENCODING=utf-8
export NO_PROXY=*

MODE="${1:-all}"
DAYS_FROM="${2:-}"
DAYS_TO="${3:-0}"

# Списки сборщиков по группам.
# ⚠️ 2026-07-27: wb_jem ВРЕМЕННО убран из MAIN_COLLECTORS. Сборщик «Портрет
# покупателя» (подписка Джем, untracked worker/collectors/wb_jem.py) зависает
# намертво при запуске (молчит, exit по таймауту). Т.к. orchestrator гоняет
# сборщики последовательно, wb_jem вешал весь saas-worker на 1 час
# (TimeoutStartSec=1h) → Ozon-сборщики в конце очереди НИКОГДА не запускались
# → данные Ozon замёрзли на 22-23 июля. Файл wb_jem.py НЕ трогаем (из параллельной
# сессии) — хозяин решает, чинить ли его. После фикса — вернуть wb_jem сюда.
# ⚠️ ИНВАРИАНТ: wb_finance раньше wb_order_costs И wb_cabinet_costs, ozon_finance
# раньше ozon_order_costs (guard от затирания в orchestrator._run_one — GUARD_DEPS).
# 2026-08-07: wb_cabinet_costs добавлен сюда. До этого он был только в WB_COLLECTORS
# оркестратора, то есть отрабатывал лишь при онбординге и backfill, а регулярный
# прогон его не звал — таблица wb_cabinet_costs застывала на дате онбординга, и
# секция «Кабинетные расходы» на «Сводке» расходилась со «Сводкой по прибыли»
# (та считает те же расходы напрямую из finance_report). Сборщик — чистый SQL
# поверх уже собранного finance_report, к API WB не ходит, работает секунды.
# 2026-08-15: ozon_accruals добавлен сюда тем же порядком, что и wb_cabinet_costs
# выше — тот же прецедент. Сборщик зарегистрирован в OZON_COLLECTORS оркестратора
# (задача 3 плана «переезд финансов Ozon на методы начислений»), но этот список
# передаётся orchestrator'у явно через --collectors и живёт отдельно от
# OZON_COLLECTORS — регистрация там сама по себе НЕ включает сборщик в плановый
# прогон systemd-таймера saas-worker. Без этой строки ozon_accruals отрабатывал
# бы только при онбординге/backfill, а данные tenant.ozon_accruals застывали бы
# на дате последнего ручного прогона, как и было с wb_cabinet_costs до 2026-08-07.
# 2026-08-22: ozon_sku_ad добавлен сюда тем же порядком (план «реклама Ozon по
# товарам», задача 7) — зарегистрирован в OZON_COLLECTORS оркестратора (задача 3
# того же плана), но без явного упоминания здесь регулярный прогон его бы не звал
# → tenant.ozon_daily_sku_ad и товарная реклама на «Сводке» застывали бы на дате
# последнего ручного прогона/бэкфилла. ⚠️ Отчёт Performance API отдаёт ОДИН
# активный отчёт кабинета одновременно — прогон занимает ~9 минут НА КАБИНЕТ
# (опрос статуса до готовности отчёта), заметно дольше остальных Ozon-сборщиков
# в этом списке — учтено в docs/metrics-contract.md (окно сбора/расписание).
MAIN_COLLECTORS="wb_catalog,wb_orders,wb_finance,wb_order_costs,wb_cabinet_costs,wb_metrics,wb_ads,wb_prices,ozon_catalog,ozon_orders,ozon_sales,ozon_finance,ozon_accruals,ozon_order_costs,ozon_metrics,ozon_efficiency,ozon_sku_ad,wb_supplies,wb_fbs_tasks,ozon_supply_orders,wb_fbs_writeoff,ozon_fbs_writeoff,wb_incomes"
STOCKS_COLLECTORS="wb_stocks,ozon_stocks,wb_fbs_stocks,ozon_fbs_stocks"
METRICS30M_COLLECTORS="wb_metrics_30m,ozon_metrics_30m"
# Справочники WB (склады + тарифы перевозок) — почти статичны, тащим раз в неделю
# (таймер saas-references, Mon 06:00). wb_references пишет в shared.* (без RLS).
REFERENCES_COLLECTORS="wb_references,ozon_references,wb_seller_warehouses,ozon_seller_warehouses"
# 2026-09-05: отдельный ночной тик ТОЛЬКО для ozon_sku_ad (реклама Ozon по
# товарам). Сборщик уже стоит в MAIN_COLLECTORS выше, но у него своё «умное»
# дневное окно очереди Performance API — SKIP_WINDOW_MSK=(4,16) в
# worker/collectors/ozon_sku_ad.py (задача «наблюдаемость воркера»,
# 2026-08-23). Все три утренних тика saas-worker (05:15/09:00/12:00) попадают
# в это окно и мягко скипаются (см. STALE_FALLBACK_H в том же файле) —
# реально сборщик отрабатывал только вечерний тик 17:00. Ночных тиков у
# saas-worker нет, а хозяин подтвердил: данные Ozon за вчера доступны у них
# уже утром, лаг «до вечера» — это дыра в НАШЕМ расписании, а не ограничение
# API (проверено 2026-09-05: campaign-реклама за вчера уже собрана к 06:06,
# per-SKU — нет). Этот режим гоняется в 03:30 MSK — вне SKIP_WINDOW_MSK,
# сборщик реально соберёт данные, а не скипнет тик. 2026-09-06: догон таймера
# после простоя (Persistent=true) попал в окно 08:22 и ушёл вхолостую → режим
# skuad теперь собирает ПРИНУДИТЕЛЬНО: orchestrator отдаёт --run-kind сборщику
# через SAAS_RUN_KIND, ozon_sku_ad при 'skuad' окно/свежесть не смотрит
# (FORCE_RUN_KINDS). run_kind 'skuad' в CHECK jobs.collector_runs — миграция 050.
SKUAD_COLLECTORS="ozon_sku_ad"
# 2026-09-06: часовой опрос статусов FBS-заданий WB (таймер saas-fbs-status,
# режим fbsstatus). WB не отдаёт время смены статуса — момент «доехало до
# ПВЗ» (pvz_at, колонка «До ПВЗ» на Географии) ловится переходом между
# опросами, точность = шаг таймера. Один дешёвый POST на ≤1000 заданий.
# Сам сборщик в MAIN_COLLECTORS не нужен: order_id заданий даёт лента
# wb_fbs_tasks из main-тика, статусы — этот таймер.
FBSSTATUS_COLLECTORS="wb_fbs_status,wb_fbs_writeoff"

case "$MODE" in
  main)       COLLECTORS="$MAIN_COLLECTORS";       DAYS_FROM="${DAYS_FROM:-2}" ;;
  stocks)     COLLECTORS="$STOCKS_COLLECTORS";     DAYS_FROM="${DAYS_FROM:-0}" ;;
  metrics30m) COLLECTORS="$METRICS30M_COLLECTORS"; DAYS_FROM="${DAYS_FROM:-0}" ;;
  references) COLLECTORS="$REFERENCES_COLLECTORS"; DAYS_FROM="${DAYS_FROM:-0}" ;;
  skuad)      COLLECTORS="$SKUAD_COLLECTORS";      DAYS_FROM="${DAYS_FROM:-2}" ;;
  fbsstatus)  COLLECTORS="$FBSSTATUS_COLLECTORS";  DAYS_FROM="${DAYS_FROM:-0}" ;;
  *) echo "Неизвестный режим: $MODE (ожидаются main|stocks|metrics30m|references|skuad|fbsstatus)" >&2; exit 1 ;;
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
$PY -m worker.orchestrator --all --collectors "$COLLECTORS" --date-from "$FROM" --date-to "$TO" --run-kind "$MODE" >> /opt/agentsDB/logs/saas_worker.log 2>&1
EXIT=$?
echo "EXIT=$EXIT" >> /opt/agentsDB/logs/saas_worker.log
exit $EXIT
