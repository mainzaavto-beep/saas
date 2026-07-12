"""
SaaS-сборщик ПРИБЫЛИ ПО ЗАКАЗУ → tenant.wb_order_costs.

В отличие от боевого (тянет reportDetailByPeriod отдельно), эта SaaS-версия
агрегирует уже собранные строки tenant.wb_finance_report (от wb_finance.py).
Один API-источник = эффективнее для мультитенанта + нет дублей запросов.

Агрегация по srid: Продажа/Возврат → revenue/commission; Логистика → delivery;
Компенсация лояльности → loyalty; cost (себест) из tenant.wb_cogs (денормализовано);
cost_value_total из tenant.wb_orders.total_price (+ profit_alt); self_buyout эвристика.

Идемпотентно по (cabinet_id, srid). Без HTTP — чистый SQL.
"""
import os
import sys
from datetime import datetime, timedelta, date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg


def _aggregate_sql(start, end):
    """Агрегация tenant.wb_finance_report → rows order_costs (за период rr_dt).
    Возвращает list[dict] под _batch_upsert(wb_order_costs)."""
    cid_sql = """  -- агрегация по srid из finance_report
    WITH ops AS (
      SELECT
        srid,
        MAX(nm_id) FILTER (WHERE nm_id IS NOT NULL) AS nm_id,
        MAX(sa_name) FILTER (WHERE sa_name IS NOT NULL) AS sa_name,
        MAX(order_dt) FILTER (WHERE order_dt IS NOT NULL) AS order_dt,
        MAX(sale_dt) FILTER (WHERE supplier_oper_name = 'Продажа') AS sale_dt,
        MAX(rr_dt) FILTER (WHERE supplier_oper_name = 'Возврат') AS return_dt,
        MAX(CASE WHEN supplier_oper_name = 'Возврат' THEN 1 ELSE 0 END) AS is_return,
        SUM(CASE WHEN supplier_oper_name IN ('Продажа','Возврат')
                 THEN COALESCE(retail_amount,0) ELSE 0 END) AS cost_value_retail,
        SUM(CASE WHEN supplier_oper_name IN ('Продажа','Возврат')
                 THEN COALESCE(ppvz_for_pay,0) ELSE 0 END) AS cost_value_pay,
        SUM(CASE WHEN supplier_oper_name IN ('Продажа','Возврат')
                 THEN ABS(COALESCE(ppvz_sales_commission,0)) ELSE 0 END) AS commission,
        SUM(CASE WHEN supplier_oper_name IN ('Продажа','Возврат')
                 THEN COALESCE(acquiring_fee,0) ELSE 0 END) AS acquiring,
        SUM(CASE WHEN supplier_oper_name = 'Логистика'
                 THEN COALESCE(delivery_rub,0) ELSE 0 END) AS logistics,
        SUM(CASE WHEN supplier_oper_name = 'Компенсация скидки по программе лояльности'
                       OR bonus_type_name LIKE '%%ояльност%%'
                 THEN COALESCE(ppvz_vw,0) + COALESCE(additional_payment,0) ELSE 0 END) AS loyalty,
        SUM(CASE WHEN supplier_oper_name IN ('Продажа','Возврат')
                 THEN COALESCE(quantity,0) ELSE 0 END) AS qty
      FROM tenant.wb_finance_report
      WHERE srid IS NOT NULL AND rr_dt IS NOT NULL
        AND substr(rr_dt,1,10) BETWEEN %s AND %s
      GROUP BY srid
    )
    SELECT o.srid, o.nm_id, o.sa_name, o.is_return, o.return_dt,
           o.order_dt, o.sale_dt,
           COALESCE(ord.total_price, o.cost_value_retail) AS cost_value_total,
           CASE WHEN o.is_return = 1 THEN 0 ELSE o.cost_value_retail END AS cost_value_retail,
           CASE WHEN o.is_return = 1 THEN 0 ELSE o.cost_value_pay END AS cost_value_pay,
           o.commission, o.acquiring, o.logistics, o.loyalty,
           c.cost AS cost,
           o.qty
    FROM ops o
    LEFT JOIN tenant.wb_orders ord ON ord.cabinet_id = current_setting('app.cabinet_id')::bigint
                                    AND ord.srid = o.srid
    LEFT JOIN tenant.wb_cogs c ON c.cabinet_id = current_setting('app.cabinet_id')::bigint
                                AND c.nm_id = o.nm_id
    WHERE o.qty > 0 OR o.cost_value_retail > 0"""
    rows = db_pg.query(cid_sql, (start, end))
    # Считаем profit/profit_alt/self_buyout на стороне Python (как боевой).
    for r in rows:
        cost = r.get("cost") or 0
        comps = cost + (r["commission"] or 0) + (r["acquiring"] or 0) + (r["logistics"] or 0) + (r["loyalty"] or 0)
        r["profit"] = round((r["cost_value_retail"] or 0) - comps, 2)
        total = r.get("cost_value_total")
        r["profit_alt"] = round(total - comps, 2) if total is not None else None
        # self_buyout: возврат с быстрым циклом (sale-order < 3 дней) — эвристика
        sb = 0
        if r["is_return"] and r.get("sale_dt") and r.get("order_dt"):
            try:
                sale = datetime.fromisoformat(str(r["sale_dt"]).replace("Z", "+00:00"))
                order = datetime.fromisoformat(str(r["order_dt"]).replace("Z", "+00:00"))
                if (sale - order).days < 3:
                    sb = 1
            except (ValueError, TypeError):
                pass
        r["self_buyout"] = sb
        # postgres возвращает Decimal/Int — приводим к float для consist
        for k in ("cost_value_total", "cost_value_retail", "cost_value_pay",
                  "commission", "acquiring", "logistics", "loyalty", "cost"):
            if r.get(k) is not None:
                r[k] = float(r[k])
    return rows


def collect(start=None, end=None):
    """Агрегировать order_costs. По умолчанию 7 дней до вчера."""
    yest = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    start = start or (date.today() - timedelta(days=7)).strftime("%Y-%m-%d")
    end = end or yest
    print(f"[wb_order_costs] агрегация {start}…{end} из finance_report", flush=True)
    db_pg.init()
    rows = _aggregate_sql(start, end)
    n = db_pg.upsert_order_costs_many(rows)
    print(f"[wb_order_costs] записано {n} строк → tenant.wb_order_costs", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    collect(args[0] if len(args) > 0 else None, args[1] if len(args) > 1 else None)
