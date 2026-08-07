"""
SaaS-сборщик КАБИНЕТНЫХ РАСХОДОВ WB → tenant.wb_cabinet_costs (заявка №27/№28).

Агрегирует уже собранные строки tenant.wb_finance_report (от wb_finance.py) по
типу операции + дню → кабинетные расходы БЕЗ привязки к SKU (хранение, штрафы,
удержания, возмещения). Это то, что WB НЕ привязывает к товару и что по
контракту №27 нельзя размазывать по марже SKU.

Гранулярность: по дням (period_from = period_to = дата операции), заявка №28 —
дневной отчёт доступен на следующий день без недельного лага.

Знаки сумм нативные (SUM без ABS): сторно гасит начисление внутри дня,
возмещения WB кодирует отрицательными — так P&L сходится по модулю.

Маппинг cost_type → лейблы см. в app/api/cabinets/[id]/cabinet-costs/route.js (LABELS).
Идемпотентно по (cabinet_id, cost_type, period_from, period_to). Без HTTP — чистый SQL.
"""
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg


# Тип операции WB → cost_type. Порядок CASE важен (от специфичного к общему),
# т.к. 'Удержание' по bonus_type_name скрывает разные услуги (gotcha #148).
#
# Колонка суммы зависит от oper_name:
#   Хранение/Штраф/Удержание → storage_fee / penalty / deduction
#   Возмещения (перевозка/ПВЗ) → ppvz_vw (отрицательное = приток продавцу)
_SQL = """\
WITH classified AS (
  SELECT
    substr(rr_dt,1,10) AS dt,
    CASE
      WHEN supplier_oper_name = 'Хранение' THEN 'storage'
      WHEN supplier_oper_name = 'Штраф'    THEN 'penalty'
      WHEN supplier_oper_name = 'Удержание'
           AND bonus_type_name LIKE '%%Баллы за отзывы%%'                THEN 'reviews'
      WHEN supplier_oper_name = 'Удержание'
           AND bonus_type_name LIKE '%%Продвижение%%'                    THEN 'promotion'
      WHEN supplier_oper_name = 'Удержание'
           AND (bonus_type_name LIKE '%%Джем%%'
                OR bonus_type_name LIKE '%%Premium Plus%%')              THEN 'subscription'
      WHEN supplier_oper_name = 'Удержание'
           AND bonus_type_name LIKE '%%утилиз%%'                         THEN 'deduction_other'
      -- Прочие «Удержания» разделяем по знаку, как это делает /pnl: положительное —
      -- удержание с продавца (расход), отрицательное — разовая выплата продавцу
      -- (например компенсация за пострадавший товар). В одном типе они гасили друг
      -- друга, и «Сводка» показывала итог, не сходящийся со «Сводкой по прибыли».
      WHEN supplier_oper_name = 'Удержание'
           AND COALESCE(deduction, 0) < 0                                THEN 'payout_other'
      WHEN supplier_oper_name = 'Удержание'                              THEN 'deduction_other'
      WHEN supplier_oper_name LIKE 'Возмещение издержек по перевозке%%'  THEN 'transport_compensation'
      WHEN supplier_oper_name LIKE 'Возмещение за выдачу%%'              THEN 'pvz_compensation'
    END AS cost_type,
    CASE
      WHEN supplier_oper_name = 'Хранение' THEN COALESCE(storage_fee, 0)
      WHEN supplier_oper_name = 'Штраф'    THEN COALESCE(penalty, 0)
      WHEN supplier_oper_name = 'Удержание' THEN COALESCE(deduction, 0)
      WHEN supplier_oper_name LIKE 'Возмещение%%' THEN COALESCE(ppvz_vw, 0)
    END AS amount
  FROM tenant.wb_finance_report
  WHERE rr_dt IS NOT NULL
    AND substr(rr_dt,1,10) BETWEEN %s AND %s
    AND (
         supplier_oper_name IN ('Хранение','Штраф','Удержание')
      OR supplier_oper_name LIKE 'Возмещение издержек по перевозке%%'
      OR supplier_oper_name LIKE 'Возмещение за выдачу%%'
    )
)
SELECT dt, cost_type, SUM(amount) AS amount
FROM classified
WHERE cost_type IS NOT NULL
GROUP BY dt, cost_type"""


def _aggregate_sql(start, end):
    """Агрегация tenant.wb_finance_report → rows cabinet_costs (по дням × тип).
    Возвращает list[dict] под db_pg.upsert_cabinet_costs_many."""
    rows = db_pg.query(_SQL, (start, end))
    out = []
    for r in rows:
        amount = r.get("amount")
        if amount is None:
            continue
        out.append({
            "cost_type":   r["cost_type"],
            "period_from": r["dt"],
            "period_to":   r["dt"],
            "amount":      float(amount),
            "detail":      None,
        })
    return out


def collect(start=None, end=None):
    """Агрегировать cabinet_costs. По умолчанию 7 дней до вчера."""
    yest = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    start = start or (date.today() - timedelta(days=7)).strftime("%Y-%m-%d")
    end = end or yest
    print(f"[wb_cabinet_costs] агрегация {start}…{end} из finance_report", flush=True)
    db_pg.init()
    rows = _aggregate_sql(start, end)
    # Переписываем период целиком: upsert оставил бы висеть строки со старым
    # cost_type, если правила разнесения поменялись или операция исчезла из отчёта.
    n = db_pg.replace_cabinet_costs_range(rows, start, end)
    print(f"[wb_cabinet_costs] записано {n} строк → tenant.wb_cabinet_costs", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    collect(args[0] if len(args) > 0 else None, args[1] if len(args) > 1 else None)
