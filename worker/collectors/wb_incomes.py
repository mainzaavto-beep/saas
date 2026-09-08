"""
SaaS-сборщик ПРИЁМОК FBO WB → tenant.wb_incomes (план «Склады 2.0», этап 3).

2026-09-07, фикс раунд 1: старый источник (statistics-api GET
/api/v1/supplier/incomes) ОТКЛЮЧЁН WB — гейтвей ag-statistics отвечает 404
«path not found» (не 429/5xx, не текст про deprecated, как у /supplier/stocks;
воспроизводится с любыми параметрами и на альтернативных путях — не угадывается).
Живой пробой (кабинет #1) найден рабочий источник — supplies-api (тот же хост,
что wb_references — план поставок FBW):
  • POST /api/v1/supplies {"dateFrom": ...} → список поставок (заголовки:
    supplyID, createDate, factDate, updatedDate, statusID, ...). ⚠️ dateFrom
    ИГНОРИРУЕТСЯ этим методом — отдаёт ВСЮ историю поставок аккаунта (проверено:
    запрос с dateFrom=2026-06-01 вернул записи с 2024-09); окно применяем сами,
    фильтром по createDate после ответа. limit/offset в теле тоже игнорируются
    (проверено: offset за пределами списка вернул тот же полный список) — реальной
    постраничности у метода нет, тянем один ответ.
  • GET /api/v1/supplies/{id}       → детали: statusID, createDate, factDate
    (дата приёмки, null пока не принято), updatedDate, warehouseName/
    actualWarehouseName (фактический склад приоритетнее планового), quantity/
    acceptedQuantity (агрегат по поставке).
  • GET /api/v1/supplies/{id}/goods → товарные строки: barcode, nmID, techSize,
    quantity (заявлено), acceptedQuantity (принято).
WB убрал текстовые статусы 03.11.2025 (WB API release notes) — status хранит
str(statusID) как есть, текстового имени в ответе больше нет ни у одного метода.
«number» (номер поставки в ЛК) в новом API не отдаётся ни одним из трёх методов —
остаётся NULL (в отличие от старого supplier/incomes, где было number: "ПОС-1").

Дизайн опроса (лимиты supplies-api строгие): один POST-список на прогон, затем
detail+goods ТОЛЬКО для поставок (а) созданных в окне INCOMES_DAYS И (б) ещё не
сохранённых у нас в терминальном статусе (db_pg.wb_incomes_terminal_ids() —
statusID=5 + date_close уже проставлен: WB такую поставку больше не меняет).
quantity = ПРИНЯТО, NULL пока не принято (date_close IS NULL) — 0 принятых после
факта приёмки отличаем от «ещё не известно». quantity_declared (миграция 056) —
заявленное количество, есть всегда.

Мягкая деградация. SAAS_PROBE=1 — дамп списка и окна, без записи.

Exit-коды (контракт orchestrator.py:80-82): 0 — прогон состоялся (в том числе когда
писать нечего: все поставки окна уже терминальны — это норма, не «ПРОПУСК»);
3 — partial: часть поставок опросить не удалось (detail/goods недоступны), записано
меньше, чем планировалось. Ноль строк и exit 0 — законный исход, поэтому ##OBS rows=0
печатается и в этом случае: наблюдаемость должна видеть, что сборщик отработал.
"""
import os
import sys
import time
from datetime import datetime, timedelta

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
import _probe

WB_TOKEN = os.getenv("WB_TOKEN")
SUPPLIES_URL = "https://supplies-api.wildberries.ru/api/v1/supplies"
SUPPLY_DETAIL_URL = "https://supplies-api.wildberries.ru/api/v1/supplies/{id}"
SUPPLY_GOODS_URL = "https://supplies-api.wildberries.ru/api/v1/supplies/{id}/goods"
INCOMES_DAYS = int(os.getenv("SAAS_INCOMES_DAYS", "90"))
MAX_ATTEMPTS = 4
BETWEEN_CALLS = 0.4  # пауза между detail/goods — лимиты supplies-api строгие

# Сколько поставок не удалось опросить в последнем прогоне (для partial_exit_code).
_NOT_FETCHED = 0


def partial_exit_code(n_not_fetched):
    """Контракт exit-кодов (orchestrator.py:80-82, образец —
    ozon_supply_orders.py::partial_exit_code): опрошено меньше поставок, чем
    планировалось → 3 (partial: то, что удалось, записано; падать нельзя)."""
    return 3 if n_not_fetched else None


def _request(method, url, body=None):
    """GET/POST с ретраями на 429/5xx; None при недоступности (не роняем прогон)."""
    headers = {"Authorization": WB_TOKEN}
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            if method == "GET":
                resp = requests.get(url, headers=headers, timeout=60)
            else:
                headers["Content-Type"] = "application/json"
                resp = requests.post(url, headers=headers, json=body or {}, timeout=60)
        except requests.RequestException as e:
            print(f"  сеть {url} ({attempt}/{MAX_ATTEMPTS}): {e}", flush=True)
            time.sleep(2 * attempt)
            continue
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", "10") or 10)
            print(f"  429 {url}, ждём {wait}с ({attempt}/{MAX_ATTEMPTS})", flush=True)
            time.sleep(min(wait, 60))
            continue
        if resp.status_code >= 500:
            print(f"  {resp.status_code} {url} ({attempt}/{MAX_ATTEMPTS})", flush=True)
            time.sleep(2 * attempt)
            continue
        print(f"  ОШИБКА {resp.status_code} {url}: {resp.text[:200]}", flush=True)
        return None
    return None


def _get(url):
    return _request("GET", url)


def _post(url, body):
    return _request("POST", url, body)


def parse_rows(income_id, detail, goods) -> list[dict]:
    """detail — GET /api/v1/supplies/{id} (dict), goods — GET .../{id}/goods
    (list). Одна строка на nmID×barcode; товарные строки без nmID пропускаем.
    quantity — принято, NULL пока факт приёмки (factDate) не наступил.
    quantity_declared — заявлено, NULL если в товарной строке нет ключа quantity
    (в норме есть всегда, даже до приёмки; NULL — сигнал неожиданной формы ответа,
    а не «заявлено 0»)."""
    if not detail:
        return []
    status = str(detail.get("statusID")) if detail.get("statusID") is not None else None
    accepted = bool(detail.get("factDate"))
    warehouse = detail.get("actualWarehouseName") or detail.get("warehouseName")
    date = (detail.get("createDate") or "")[:10] or None
    date_close = (detail.get("factDate") or "")[:10] if accepted else None
    last_change = detail.get("updatedDate")
    out = []
    for g in goods or []:
        nm = g.get("nmID")
        if nm is None:
            continue
        accepted_qty = g.get("acceptedQuantity")
        declared_qty = g.get("quantity")
        out.append({
            "income_id": int(income_id),
            "nm_id": int(nm),
            "barcode": str(g.get("barcode")) if g.get("barcode") is not None else "",
            "number": None,  # supplies-api номер поставки не отдаёт (был в старом API)
            "date": date,
            "date_close": date_close,
            "last_change": last_change,
            "warehouse_name": warehouse,
            "tech_size": g.get("techSize"),
            "quantity": int(accepted_qty) if accepted and accepted_qty is not None else None,
            "quantity_declared": int(declared_qty) if declared_qty is not None else None,
            "total_price": None,  # supplies-api сумму по строке не отдаёт
            "status": status,
        })
    return out


def collect():
    global _NOT_FETCHED
    _NOT_FETCHED = 0
    print(f"[wb_incomes] приёмки FBO WB, supplies-api ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    if not WB_TOKEN:
        print("[wb_incomes] ПРОПУСК: нет WB_TOKEN (exit 0)", flush=True)
        return 0
    cutoff = (datetime.now() - timedelta(days=INCOMES_DAYS)).strftime("%Y-%m-%d")
    data = _post(SUPPLIES_URL, {"dateFrom": cutoff})
    if data is None:
        print(f"[wb_incomes] ПРОПУСК: {SUPPLIES_URL} недоступен (exit 0)", flush=True)
        return 0
    if not isinstance(data, list):
        print(f"[wb_incomes] ПРОПУСК: неожиданная форма ответа POST /supplies (exit 0)", flush=True)
        return 0
    # dateFrom API игнорирует (отдаёт всю историю) — окно фильтруем сами.
    candidates = [it for it in data if it.get("supplyID") is not None
                  and (it.get("createDate") or "")[:10] >= cutoff]
    if _probe.is_probe():
        _probe.dump(f"POST /api/v1/supplies dateFrom={cutoff} (dateFrom игнорируется WB)", data, n=10)
        _probe.dump(f"кандидаты в окне {cutoff}..сегодня", candidates, n=10)
        return 0
    db_pg.init()
    terminal = db_pg.wb_incomes_terminal_ids()
    to_fetch = [it for it in candidates if it["supplyID"] not in terminal]
    skipped_terminal = len(candidates) - len(to_fetch)

    rows = []
    fetched = 0
    for it in to_fetch:
        sid = it["supplyID"]
        detail = _get(SUPPLY_DETAIL_URL.format(id=sid))
        if detail is None:
            print(f"  [{sid}] детали недоступны, пропуск", flush=True)
            continue
        time.sleep(BETWEEN_CALLS)
        goods = _get(SUPPLY_GOODS_URL.format(id=sid))
        if goods is None:
            print(f"  [{sid}] товарные строки недоступны, пропуск", flush=True)
            continue
        rows.extend(parse_rows(sid, detail, goods))
        fetched += 1
        time.sleep(BETWEEN_CALLS)

    _NOT_FETCHED = len(to_fetch) - fetched
    print(f"[wb_incomes] окно {cutoff}..сегодня: поставок {len(candidates)}, "
          f"терминальных пропущено {skipped_terminal}, опрошено {fetched}"
          + (f", не опрошено {_NOT_FETCHED} из {len(to_fetch)}" if _NOT_FETCHED else ""),
          flush=True)
    if not rows:
        # Не «ПРОПУСК»: прогон состоялся, просто нет ни одной новой/изменившейся
        # поставки (все терминальные). Строк 0 — законный исход, не деградация.
        print("[wb_incomes] нечего обновлять: новых строк нет", flush=True)
        print("##OBS rows=0", flush=True)
        return 0
    written = db_pg.upsert_wb_incomes_many(rows)
    print(f"[wb_incomes] строк {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
    _code = partial_exit_code(_NOT_FETCHED)
    if _code is not None:
        sys.exit(_code)
