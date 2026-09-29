"""
SaaS-сборщик ФИНАНСОВОГО ОТЧЁТА WB (sales-reports/detailed, до 24.09.2026 — v5
reportDetailByPeriod) → tenant.wb_finance_report.

Дневная гранулярность (period=daily, заявка №28): отчёт доступен на следующий день
без недельного лага. Требует ПЕРСОНАЛЬНЫЙ токен клиента (базовый → 204).

Диапазон: по умолчанию 7 дней до вчера; argv[0]=start, argv[1]=end (бэкфилл).
Токен из env WB_TOKEN. Идемпотентно по (cabinet_id, rrd_id).
"""
import os
import sys
import time
import requests
from datetime import datetime, timedelta, date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
# С 24.09.2026 WB отключил GET statistics-api /api/v5/supplier/reportDetailByPeriod
# (404 «This method is deprecated», release-notes?id=498). Замена — POST
# finance-api /api/finance/v1/sales-reports/detailed: тот же отчёт реализации,
# но поля в camelCase, денежные суммы строками, курсор rrdId в теле запроса,
# лимит WB — 1 запрос в минуту (X-Ratelimit-Limit: 1). Проба 29.09.2026.
REPORT_URL = "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed"
PAGE_LIMIT = 100000
RATE_PAUSE = 61  # сек между запросами: лимит WB 1/мин

# Новое имя поля → колонка tenant.wb_finance_report (имена колонок — от старого v5,
# на них завязаны wb_order_costs, wb_cabinet_costs и lib/wbMetrics.js).
FIELD_MAP = {
    "rrdId": "rrd_id", "reportId": "realizationreport_id",
    "dateFrom": "date_from", "dateTo": "date_to", "rrDate": "rr_dt",
    "nmId": "nm_id", "vendorCode": "sa_name", "subjectName": "subject_name",
    "sellerOperName": "supplier_oper_name", "docTypeName": "doc_type_name",
    "bonusTypeName": "bonus_type_name", "quantity": "quantity",
    "retailPrice": "retail_price", "retailAmount": "retail_amount",
    "retailPriceWithDisc": "retail_price_withdisc_rub", "forPay": "ppvz_for_pay",
    "deliveryService": "delivery_rub", "paidStorage": "storage_fee",
    "penalty": "penalty", "additionalPayment": "additional_payment",
    "deduction": "deduction", "paidAcceptance": "acceptance",
    "acquiringFee": "acquiring_fee", "ppvzSalesCommission": "ppvz_sales_commission",
    "vw": "ppvz_vw", "returnAmount": "return_amount", "salePercent": "sale_percent",
    "commissionPercent": "commission_percent", "srid": "srid",
    "orderDt": "order_dt", "saleDt": "sale_dt",
}
# Денежные поля новый метод отдаёт строками ("1646.47") — приводим к числу.
MONEY_COLS = {"retail_price", "retail_amount", "retail_price_withdisc_rub", "ppvz_for_pay",
              "delivery_rub", "storage_fee", "penalty", "additional_payment", "deduction",
              "acceptance", "acquiring_fee", "ppvz_sales_commission", "ppvz_vw"}

# Окна, пропущенные из-за 429 после 5 попыток. >0 → exit 3 (partial) —
# контракт exit-кодов оркестратора (orchestrator.py, _run_one).
_SKIPPED_429 = 0


def _num(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def map_row(r):
    """Строка нового отчёта → dict с колонками tenant.wb_finance_report."""
    out = {}
    for src, col in FIELD_MAP.items():
        v = r.get(src)
        out[col] = _num(v) if col in MONEY_COLS else v
    return out


def fetch_realization(date_from, date_to, daily=True):
    """Выгрузка строк отчёта за период: POST, курсор rrdId, period=daily."""
    if not WB_TOKEN:
        raise RuntimeError("WB_TOKEN не выставлен воркером")
    headers = {"Authorization": WB_TOKEN, "Content-Type": "application/json"}
    all_rows = []
    rrdid = 0
    page = 0
    while True:
        page += 1
        body = {"dateFrom": date_from, "dateTo": date_to, "limit": PAGE_LIMIT}
        if rrdid:
            body["rrdId"] = rrdid
        if daily:
            body["period"] = "daily"
        for attempt in range(5):
            try:
                r = requests.post(REPORT_URL, headers=headers, json=body, timeout=120)
            except requests.RequestException as e:
                if attempt == 4:
                    raise
                print(f"    сетевой сбой ({e.__class__.__name__}), повтор...", flush=True)
                time.sleep(10)
                continue
            if r.status_code == 429:
                wait = int(r.headers.get("X-Ratelimit-Retry") or r.headers.get("Retry-After")
                           or RATE_PAUSE)
                wait = max(wait, RATE_PAUSE)
                print(f"    429 (попытка {attempt+1}/5), жду {wait}с...", flush=True)
                time.sleep(wait)
                continue
            # 204/пусто = отчёт ещё не сформирован (напр. за сегодня). Не падаем.
            if r.status_code == 204 or not r.text or not r.text.strip():
                return []
            if r.status_code >= 400:
                # Тело WB объясняет причину (deprecated, неверный токен…) — без него
                # в журнале прогонов остаётся голое «404 Not Found» (урок 24–29.09.2026).
                raise RuntimeError(f"WB {r.status_code} {REPORT_URL}: {r.text[:400]}")
            break
        else:
            global _SKIPPED_429
            _SKIPPED_429 += 1
            print(f"    429 после 5 попыток — пропускаю окно", flush=True)
            return []
        rows = r.json() or []
        if not rows:
            break
        all_rows.extend(map_row(x) for x in rows)
        print(f"  страница {page}: +{len(rows)} (всего {len(all_rows)})", flush=True)
        last = rows[-1]["rrdId"]
        if len(rows) < PAGE_LIMIT or last <= rrdid:
            # last <= rrdid — WB не сдвинул курсор: выходим, а не крутим одну страницу.
            break
        rrdid = last
        time.sleep(RATE_PAUSE)
    return all_rows


def fetch_by_days(date_from, date_to):
    """Тянет дневные отчёты, но НЕ по одному дню, а 7-дневными окнами (компромисс
    скорости и надёжности). Отчёт отдаёт период любой длины с period=daily,
    поэтому 7-дневное окно = ОДИН запрос с дневными строками внутри (realizationreport_id
    на каждый день). Это в ~7 раз быстрее по-дневного цикла и меньше подвержено 429.
    Последнее окно может быть короче 7 дней."""
    start = datetime.strptime(date_from, "%Y-%m-%d").date()
    end = datetime.strptime(date_to, "%Y-%m-%d").date()
    all_rows = []
    cur = start
    window = 7
    while cur <= end:
        win_end = min(cur + timedelta(days=window - 1), end)
        rows = fetch_realization(cur.isoformat(), win_end.isoformat(), daily=True)
        if rows:
            print(f"  окно {cur}..{win_end}: {len(rows)} строк (всего {len(all_rows)})", flush=True)
        else:
            print(f"  окно {cur}..{win_end}: 0 (отчёт ещё не сформирован)", flush=True)
        all_rows.extend(rows)
        cur = win_end + timedelta(days=1)
        # Пауза между окнами: лимит нового метода WB — 1 запрос/мин (X-Ratelimit-Limit: 1).
        if cur <= end:
            time.sleep(RATE_PAUSE)
    return all_rows


def collect(start=None, end=None):
    """Собрать финансовый отчёт. По умолчанию 7 дней до вчера."""
    yest = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    start = start or (date.today() - timedelta(days=7)).strftime("%Y-%m-%d")
    end = end or yest
    print(f"[wb_finance] дневные отчёты {start}…{end}", flush=True)
    db_pg.init()
    rows = fetch_by_days(start, end)
    n = db_pg.upsert_finance_many(rows)
    print(f"[wb_finance] записано {n} строк → tenant.wb_finance_report", flush=True)
    print(f"##OBS rows={n} from={start} to={end}", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    args = sys.argv[1:]
    collect(args[0] if len(args) > 0 else None, args[1] if len(args) > 1 else None)
    if _SKIPPED_429:
        print(f"[wb_finance] PARTIAL: пропущено окон из-за 429: {_SKIPPED_429}",
              file=sys.stderr, flush=True)
        sys.exit(3)
