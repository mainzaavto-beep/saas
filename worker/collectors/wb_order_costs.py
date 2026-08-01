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
    cid_sql = """  -- агрегация по srid из finance_report.
    -- Отбор srid — по наличию операций в периоде rr_dt (period_srid), но все
    -- агрегаты (суммы И даты) — по ВСЕЙ истории srid целиком.
    -- Причина: WB шлёт к одному заказу строки-поправки («Возмещение издержек
    -- по перевозке») с rr_dt на дни позже продажи. Если суммировать только за
    -- период — srid, чья Продажа за пределами периода, в выдачу не попадает
    -- (cost_value_retail=0, qty=0 → отсекается) и остаётся со старым мусорным
    -- order_dt (инцидент 2026-07-29: 912 srid с order_dt > sale_dt). Берём всё
    -- по srid — суммы и даты согласованы. Период отвечает только за «какие
    -- заказы трогаем в этом прогоне».
    WITH period_srid AS (
      SELECT DISTINCT srid
      FROM tenant.wb_finance_report
      WHERE srid IS NOT NULL AND rr_dt IS NOT NULL
        AND substr(rr_dt,1,10) BETWEEN %s AND %s
    ),
    ops AS (  -- суммы + даты + идентификация по ВСЕЙ истории srid
      SELECT
        f.srid,
        MAX(f.nm_id) FILTER (WHERE f.nm_id IS NOT NULL) AS nm_id,
        MAX(f.sa_name) FILTER (WHERE f.sa_name IS NOT NULL) AS sa_name,
        -- order_dt = реальная дата ОФОРМЛЕНИЯ (минимум), с отсевом строк-поправок
        -- (nm_id=0 / qty=0), где order_dt = дата фин. проводки, а не заказа.
        MIN(f.order_dt) FILTER (WHERE f.order_dt IS NOT NULL
                                AND COALESCE(f.nm_id,0) <> 0
                                AND COALESCE(f.quantity,0) <> 0) AS order_dt,
        MAX(f.sale_dt) FILTER (WHERE f.supplier_oper_name = 'Продажа') AS sale_dt,
        MAX(f.rr_dt) FILTER (WHERE f.supplier_oper_name = 'Возврат') AS return_dt,
        MAX(CASE WHEN f.supplier_oper_name = 'Возврат' THEN 1 ELSE 0 END) AS is_return,
        SUM(CASE WHEN f.supplier_oper_name IN ('Продажа','Возврат')
                 THEN COALESCE(f.retail_amount,0) ELSE 0 END) AS cost_value_retail,
        SUM(CASE WHEN f.supplier_oper_name IN ('Продажа','Возврат')
                 THEN COALESCE(f.ppvz_for_pay,0) ELSE 0 END) AS cost_value_pay,
        SUM(CASE WHEN f.supplier_oper_name IN ('Продажа','Возврат')
                 THEN ABS(COALESCE(f.ppvz_sales_commission,0)) ELSE 0 END) AS commission,
        SUM(CASE WHEN f.supplier_oper_name IN ('Продажа','Возврат')
                 THEN COALESCE(f.acquiring_fee,0) ELSE 0 END) AS acquiring,
        SUM(CASE WHEN f.supplier_oper_name = 'Логистика'
                 THEN COALESCE(f.delivery_rub,0) ELSE 0 END) AS logistics,
        SUM(CASE WHEN f.supplier_oper_name = 'Компенсация скидки по программе лояльности'
                       OR f.bonus_type_name LIKE '%%ояльност%%'
                 THEN COALESCE(f.ppvz_vw,0) + COALESCE(f.additional_payment,0) ELSE 0 END) AS loyalty,
        SUM(CASE WHEN f.supplier_oper_name IN ('Продажа','Возврат')
                 THEN COALESCE(f.quantity,0) ELSE 0 END) AS qty
      FROM tenant.wb_finance_report f
      JOIN period_srid p ON p.srid = f.srid
      GROUP BY f.srid
    )
    SELECT o.srid, o.nm_id, o.sa_name, o.is_return, o.return_dt,
           o.order_dt, o.sale_dt,
           COALESCE(ord.total_price, o.cost_value_retail) AS cost_value_total,
           CASE WHEN o.is_return = 1 THEN 0 ELSE o.cost_value_retail END AS cost_value_retail,
           CASE WHEN o.is_return = 1 THEN 0 ELSE o.cost_value_pay END AS cost_value_pay,
           o.commission, o.acquiring, o.logistics, o.loyalty,
           co.cost AS cost,
           o.qty
    FROM ops o
    LEFT JOIN tenant.wb_orders ord ON ord.cabinet_id = current_setting('app.cabinet_id')::bigint
                                    AND ord.srid = o.srid
    LEFT JOIN LATERAL (
      SELECT cost FROM tenant.cost_overrides
      WHERE cabinet_id = current_setting('app.cabinet_id')::bigint
        AND nm_id = o.nm_id AND platform = 'wb'
        AND effective_from <= COALESCE(substr(o.sale_dt,1,10)::date, substr(o.order_dt,1,10)::date, current_date)
      ORDER BY effective_from DESC LIMIT 1
    ) co ON true
    WHERE o.qty > 0 OR o.cost_value_retail > 0"""
    rows = db_pg.query(cid_sql, (start, end))
    # Считаем profit/profit_alt/self_buyout на стороне Python (как боевой).
    for r in rows:
        # cost из cost_overrides.cost (numeric → Decimal), остальные компоненты —
        # SUM(double precision) → float. Decimal + float = TypeError (урок: сборщик
        # падал с 14.07, пока не появились override'ы). Приводим к float единообразно.
        cost = float(r["cost"]) if r.get("cost") is not None else 0
        # ── Модель ppvz_for_pay (фикс 2026-07-31, урок D15) ──────────────────
        # profit = cost_value_pay (ppvz_for_pay, «к перечислению продавцу»)
        #          − себестоимость − логистика.
        # Эталон установлен свркой на 2030 заказах cabinet #1: компонентный метод
        # (retail − ABS(комиссия) − acquiring − logistics − loyalty) НЕ воспроизводит
        # ppvz_for_pay ни на одном заказе (средняя ошибка −289 ₽, 0/2030 точных) — WB
        # включает в ppvz_for_pay СПП/переоценки/корректировки, которых нет в отдельных
        # полях. commission/acquiring/loyalty УЖЕ внутри ppvz_for_pay → НЕ вычитаем.
        # Логистика идёт ОТДЕЛЬНОЙ операцией («Логистика», delivery_rub) и НЕ входит
        # в ppvz_for_pay операции «Продажа» → вычитаем явно.
        # Для возврата cost_value_pay обнуляется в SQL (CASE WHEN is_return=1 THEN 0),
        # поэтому profit возврата = −logistics (убыток на логистику, себест. не списываем).
        r["profit"] = round((r["cost_value_pay"] or 0) - cost - (r["logistics"] or 0), 2)
        # profit_alt — контрольная метрика от cost_value_total (прайс-цена). Компонентная,
        # оставлена для диагностики, в расчётах не используется.
        total = r.get("cost_value_total")
        comps_alt = cost + (r["commission"] or 0) + (r["acquiring"] or 0) + (r["logistics"] or 0) + (r["loyalty"] or 0)
        r["profit_alt"] = round(total - comps_alt, 2) if total is not None else None
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
