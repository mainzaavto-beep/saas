"""
SaaS-сборщик ЕЖЕДНЕВНОЙ ЭФФЕКТИВНОСТИ Ozon → tenant.ozon_daily_efficiency.

Агрегат по кабинету за день (1 строка/день): orders/sales_sum/profit/returns.
Из tenant.ozon_order_costs (COALESCE(sale_dt, return_dt)).
Реклама (ad_spend/drr) из Performance API — опциональна (без perf-creds → NULL).
Без Google Sheets. Токен из env (опц. OZON_PERF_*).
"""
import os
import sys
import csv
import io
import requests
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg

TARGET_DRR = 0.09


def _collect_sales(since, to):
    """Агрегация order_costs по дням → daily_efficiency."""
    rows = db_pg.query(
        "SELECT substr(COALESCE(sale_dt, return_dt), 1, 10) AS d, "
        "SUM(CASE WHEN is_return = 0 THEN 1 ELSE 0 END) AS orders, "
        "SUM(CASE WHEN is_return = 0 THEN cost_value_retail * qty ELSE 0 END) AS sales_sum, "
        "SUM(CASE WHEN is_return = 1 THEN 1 ELSE 0 END) AS returns_count, "
        "SUM(CASE WHEN is_return = 1 THEN profit ELSE 0 END) AS returns_loss, "
        "SUM(profit) AS profit "
        "FROM tenant.ozon_order_costs "
        "WHERE COALESCE(sale_dt, return_dt) IS NOT NULL "
        "AND substr(COALESCE(sale_dt, return_dt), 1, 10) >= %s "
        "AND substr(COALESCE(sale_dt, return_dt), 1, 10) <= %s "
        "GROUP BY d ORDER BY d",
        (since.strftime("%Y-%m-%d"), to.strftime("%Y-%m-%d")))
    cid = db_pg._cabinet_id()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for r in rows:
        with db_pg.get_connection() as conn:
            conn.execute(
                "INSERT INTO tenant.ozon_daily_efficiency "
                "(cabinet_id, date, orders, sales_sum, returns_count, returns_loss, profit, target_drr, updated_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (cabinet_id, date) DO UPDATE SET "
                "orders=EXCLUDED.orders, sales_sum=EXCLUDED.sales_sum, "
                "returns_count=EXCLUDED.returns_count, returns_loss=EXCLUDED.returns_loss, "
                "profit=EXCLUDED.profit, target_drr=EXCLUDED.target_drr, updated_at=EXCLUDED.updated_at",
                [cid, r["d"], r["orders"], r["sales_sum"], r["returns_count"],
                 r["returns_loss"], r["profit"], TARGET_DRR, now])
    return len(rows)


def _collect_ads(since, to):
    """Расход рекламы из Performance API (опц.). Без perf-creds → 0."""
    perf_id = os.environ.get("OZON_PERF_CLIENT_ID")
    perf_secret = os.environ.get("OZON_PERF_CLIENT_SECRET")
    if not (perf_id and perf_secret):
        print("  Performance credentials нет — ad_spend NULL", flush=True)
        return 0
    try:
        # OAuth2 token. ⚠️ Грабля 2026-08-02: basic auth даёт 401
        # (invalid_client) — из-за этого расход рекламы Ozon НИКОГДА не
        # собирался (сборщик тихо возвращал 0, ad_spend был NULL, прибыль
        # Ozon завышалась). Рабочий формат — JSON-тело с client_id/secret.
        tr = requests.post("https://api-performance.ozon.ru/api/client/token",
                           json={"client_id": perf_id, "client_secret": perf_secret,
                                 "grant_type": "client_credentials"}, timeout=30)
        if tr.status_code != 200:
            print(f"  Performance token HTTP {tr.status_code}: {tr.text[:120]}", flush=True)
            return 0
        token = tr.json().get("access_token")
        # ⚠️ Грабля 2026-08-02: /statistics/daily отдаёт максимум 62 дня за
        # запрос («max statistics period: 62 days», причём ровно 62 тоже 400)
        # → длинный backfill режем окнами по 60 дней.
        def _num(s):
            try:
                return float((s or "0").replace(",", "."))
            except ValueError:
                return 0.0

        spend_by_day = {}
        campaign_rows = []
        bad_campaign_rows = 0
        win_start = since
        while win_start <= to:
            win_end = min(win_start + timedelta(days=59), to)
            r = requests.get("https://api-performance.ozon.ru/api/client/statistics/daily",
                             headers={"Authorization": f"Bearer {token}"},
                             params={"dateFrom": win_start.strftime("%Y-%m-%d"),
                                     "dateTo": win_end.strftime("%Y-%m-%d")},
                             timeout=60)
            if r.status_code != 200:
                print(f"  Performance /daily HTTP {r.status_code}: {r.text[:120]}", flush=True)
                win_start = win_end + timedelta(days=1)
                continue
            # CSV: 8 колонок — ID, Название, Дата, Показы, Клики, «Расход, ₽»
            # (русская запятая), «Заказы, шт.», «Заказы, ₽». Уровень —
            # кампания×день, товарного разреза нет (см. миграцию 039).
            # Раньше строки выбрасывались — здесь сохраняем их целиком в
            # tenant.ozon_daily_campaign_ad, ПОМИМО суммарного ad_spend/день
            # ниже (его меняться не должно — на нём завязана прибыль/сверка).
            reader = csv.reader(io.StringIO(r.text), delimiter=";")
            next(reader, None)
            for row in reader:
                # Порог для суммарного ad_spend — ПРЕЖНИЙ (< 7, нужен только
                # индекс 5): это обязано вести себя как раньше, независимо
                # от того, разбираем ли мы кампанию из этой же строки.
                if len(row) < 7:
                    continue
                d = (row[2] or "")[:10]
                spend = _num(row[5])
                spend_by_day[d] = spend_by_day.get(d, 0) + spend
                # Разбор по кампаниям требует всех 8 колонок — свой,
                # более строгий порог, не влияющий на ad_spend выше.
                if len(row) < 8:
                    bad_campaign_rows += 1
                    continue
                try:
                    campaign_id = int(row[0])
                except (ValueError, TypeError):
                    bad_campaign_rows += 1
                    continue
                campaign_rows.append({
                    "campaign_id": campaign_id,
                    "date": d,
                    "campaign_name": row[1] or None,
                    "views": int(_num(row[3])),
                    "clicks": int(_num(row[4])),
                    "spend": spend,
                    "orders": int(_num(row[6])),
                    "orders_sum": _num(row[7]),
                })
            win_start = win_end + timedelta(days=1)
        if campaign_rows:
            db_pg.upsert_ozon_campaign_ad_many(campaign_rows)
        # Не глотаем молча: если строки с кампанией не разобрались (короче
        # 8 колонок или нечитаемый ID), это должно быть видно в логе, а не
        # просто исчезнуть — ровно то, что годами маскировало другие сбои
        # в этом воркере.
        if bad_campaign_rows:
            print(f"  Performance: {bad_campaign_rows} строк(и) не разобрано "
                  f"в разрез по кампаниям (пропущены)", flush=True)
        cid = db_pg._cabinet_id()
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for d, spend in spend_by_day.items():
            drr = None
            eff = db_pg.query("SELECT sales_sum FROM tenant.ozon_daily_efficiency WHERE date=%s", (d,))
            if eff and eff[0]["sales_sum"]:
                drr = spend / eff[0]["sales_sum"]
            with db_pg.get_connection() as conn:
                conn.execute(
                    "UPDATE tenant.ozon_daily_efficiency SET ad_spend=%s, drr=%s, updated_at=%s "
                    "WHERE cabinet_id=%s AND date=%s",
                    [spend, drr, now, cid, d])
        return len(spend_by_day)
    except Exception as e:
        print(f"  Performance ошибка: {type(e).__name__}: {str(e)[:120]}", flush=True)
        return 0


def collect(since=None, to=None):
    print("[ozon_efficiency] агрегат по дням", flush=True)
    db_pg.init()
    if since is None:
        since = datetime.now() - timedelta(days=7)
    if to is None:
        to = datetime.now()
    n_sales = _collect_sales(since, to)
    n_ads = _collect_ads(since, to)
    print(f"[ozon_efficiency] дней с продажами {n_sales}, дней с рекламой {n_ads}", flush=True)
    return n_sales


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    collect(datetime.fromisoformat(s) if s else None, datetime.fromisoformat(t) if t else None)
