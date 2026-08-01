"""
SaaS-сборщик «Портрет покупателя» (подписка «Джем» WB)
  → tenant.wb_search_queries + tenant.wb_funnel_daily.

Коллега был прав против моего первого ответа: WB публикует «Джем»-only методы
в открытой API-документации, дающие поисковые запросы, позиции и воронку
конверсий. Пол/возраст через API так и НЕ отдаётся (виджет в ЛК без endpoint'а,
см. форум dev.wildberries.ru/forum/1308) — но 80% «портрета» здесь.

Два метода на хосте seller-analytics-api.wildberries.ru:

  1) POST /api/v2/search-report/report — агрегированно ПО ТОВАРАМ (воронка + позиция).
     Запрос: {isType:"supplier", currentPeriod:{start,end}, positionCluster:"all",
              orderBy:{field,mode}, limit, offset}
     Ответ: data.groups[].items[] — nm_id + avgPosition/openCard/addToCart/openToCart/
            orders/cartToOrder/visibility (current).
     → пишет в wb_funnel_daily (PK cabinet_id, nm_id, date).

  2) POST /api/v2/search-report/product/search-texts — ПО КЛЮЧЕВЫМ ЗАПРОСАМ.
     Запрос: {nmIds:[...], currentPeriod:{start,end}, topOrderBy:"orders",
              orderBy:{field,mode}, limit, offset}
     Ответ: data.items[] — text(keyword) + frequency/weekFrequency/medianPosition/
            avgPosition/openCard/addToCart/orders/cartToOrder/visibility (current+percentile).
     → пишет в wb_search_queries (PK cabinet_id, nm_id, date, keyword).

⚠️ Тело запроса и поля ответа СВЕРЕНЫ ЖИВЫМ PROBE'ом на cabinet #1 (2026-07-19).
   Дока WB систематически расходится с реальностью (грабля #18/#57): например,
   в доке фигурируют startDate/endDate/orderColumn/page, а реально WB требует
   currentPeriod/orderBy/limit/offset; positionCluster — enum "all"|"firstHundred"|
   "secondHundred"|"below" (а не "1-100" как можно подумать); topOrderBy — enum-строка
   "orders"|"openCard"|..., а не объект orderBy. НЕ править тело/поля без повторного probe'а.

⚠️ Мягкая деградация (как wb_stocks/wb_references): при недоступности WB
   завершается exit 0, снимок не пишется, сервис не падает. Если «Джем» не активна
   (402) — то же поведение (другие сборщики продолжают работать).

Идемпотентно по (cabinet_id, nm_id, date[, keyword]). Токен из env WB_TOKEN
(воркер выставляет через _env_for_shop в orchestrator.py).
Запуск: python -m worker.collectors.wb_jem [YYYY-MM-DD] [YYYY-MM-DD]
  (по умолчанию — вчера; backfill: две даты).
"""
import os
import sys
import time
from datetime import datetime, timedelta, date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

try:
    import requests
except ImportError:
    requests = None

WB_TOKEN = os.getenv("WB_TOKEN")

REPORT_URL = "https://seller-analytics-api.wildberries.ru/api/v2/search-report/report"
SEARCH_TEXTS_URL = "https://seller-analytics-api.wildberries.ru/api/v2/search-report/product/search-texts"

# WB использует per-seller rate-limiter; окно 7 дней + батч по 20 nm_id — безопасно.
SEARCH_TEXTS_BATCH = 20
# Минимальное окно для search-texts: WB на периодах <14 дней отдаёт ПУСТЫЕ items
# (без ошибки) — недостаточно данных для keyword-агрегации. Расширяем старт.
MIN_SEARCH_WINDOW = 14
# ⚠️ Лимит 30 = максимум тарифа «Джем» (стандартного). На 50 WB отвечает:
#   400 "Validate: invalid texts limit. Check your jam tariff". Для тарифа
#   «Продвинутый» (если появится) можно поднять до 100.
SEARCH_TEXTS_LIMIT = 30
REPORT_LIMIT = 100         # товаров на страницу (одна страница обычно покрывает каталог)
# WB держит per-seller rate-limiter; после агрессивных probe'ов он может
# троттлить ~час. Даём экспоненциальный retry с потолком ~10 минут на запрос.
MAX_ATTEMPTS = 3
MAX_TOTAL_WAIT = 600


# =====================================================================
#  HTTP с retry (эталон wb_references._request)
# =====================================================================
def _wb_post(url, body):
    """POST с retry на 429/5xx. Возвращает parsed JSON или None при недоступности.
    Детектит 429+deprecated (грабля #11) — мгновенный None без loop'а."""
    if not WB_TOKEN:
        print("[wb_jem] WB_TOKEN не выставлен — пропуск", flush=True)
        return None
    if requests is None:
        raise RuntimeError("модуль requests не установлен")
    headers = {"Authorization": WB_TOKEN, "Content-Type": "application/json"}
    waited = 0
    for attempt in range(MAX_ATTEMPTS):
        try:
            r = requests.post(url, headers=headers, json=body, timeout=120)
        except requests.RequestException as e:
            print(f"  сетевой сбой ({e.__class__.__name__}), попытка {attempt+1}/{MAX_ATTEMPTS}", flush=True)
            time.sleep(8); waited += 8
            continue
        if r.status_code == 429:
            # WB per-seller rate-limiter. Retry-After часто отсутствует («global limiter»),
            # тогда ждём экспоненциально: 60 → 120 → 240с. Это «прохлопает» окно лимитера
            # (~час после агрессивных probe'ов), но не зависнет навсегда.
            ra = r.headers.get("Retry-After")
            wait = int(ra) if ra and ra.isdigit() else 60 * (attempt + 1)
            try:
                detail = (r.json() or {}).get("detail", "")
            except Exception:
                detail = ""
            if "deprecated" in str(detail).lower():
                print(f"  429 + deprecated: endpoint устарел — {detail}", flush=True)
                return None
            if waited + wait > MAX_TOTAL_WAIT:
                print(f"  429: потолок ожидания исчерпан ({waited}с/{MAX_TOTAL_WAIT}с) — сдаёмся", flush=True)
                return None
            print(f"  429 (rate-limiter), жду {wait}с... (попытка {attempt+1}/{MAX_ATTEMPTS}, всего ждали {waited}с)", flush=True)
            time.sleep(wait); waited += wait
            continue
        if r.status_code == 402:
            print(f"  402: подписка «Джем» не активна у кабинета — пропуск", flush=True)
            return None
        if r.status_code == 400:
            # 400 = неверное тело (например, превышен лимит текстов тарифом).
            # Не роняем сборщик — возвращаем спец-маркер, чтобы вызывающий код
            # пропустил этот батч и шёл дальше. r.json() ради detail в логе.
            try:
                detail = (r.json() or {}).get("detail", "")
            except Exception:
                detail = r.text[:200]
            print(f"  400: {str(detail)[:160]}", flush=True)
            return {"__bad_request__": True}
        if r.status_code >= 500:
            print(f"  {r.status_code} (сервер WB), попытка {attempt+1}/{MAX_ATTEMPTS}", flush=True)
            time.sleep(10); waited += 10
            continue
        r.raise_for_status()
        return r.json()
    print(f"  {url}: недоступен после {MAX_ATTEMPTS} попыток — пропуск", flush=True)
    return None


def _date_windows(begin, end, max_days=7):
    """Разбивает [begin, end] на окна ≤ max_days. «Джем» обновляется раз в час,
    но окно 7 дней держит объём ответа компактным (rate-limiter per-seller)."""
    b = datetime.strptime(begin, "%Y-%m-%d").date()
    e = datetime.strptime(end, "%Y-%m-%d").date()
    out, cur = [], b
    while cur <= e:
        win_end = min(cur + timedelta(days=max_days - 1), e)
        out.append((cur.isoformat(), win_end.isoformat()))
        cur = win_end + timedelta(days=1)
    return out


# =====================================================================
#  Метод 1: search-report/report → wb_funnel_daily (по товарам)
# =====================================================================
def _collect_funnel(start, end, known):
    """Агрегированный отчёт по товарам (воронка + позиция). Пишет в wb_funnel_daily.
    Возвращает число строк. date снимка = currentPeriod.end."""
    rows = []
    for win_begin, win_end in _date_windows(start, end, 7):
        offset = 0
        while True:
            body = {
                "isType": "supplier",
                "currentPeriod": {"start": win_begin, "end": win_end},
                "positionCluster": "all",
                "orderBy": {"field": "orders", "mode": "desc"},
                "limit": REPORT_LIMIT,
                "offset": offset,
            }
            data = _wb_post(REPORT_URL, body)
            if data is None:
                return len(rows) if rows else None  # мягкая деградация (WB недоступен)
            if data.get("__bad_request__"):
                # 400 на этом окне — пропускаем, идём к следующему окну.
                break
            groups = (data.get("data") or {}).get("groups") or []
            items = []
            for g in groups:
                items.extend(g.get("items") or [])
            if not items:
                break
            for it in items:
                nm = it.get("nmId")
                if nm not in known:
                    continue
                rows.append({
                    "nm_id": nm,
                    "date": win_end,
                    "avg_position": (it.get("avgPosition") or {}).get("current"),
                    "visibility": (it.get("visibility") or {}).get("current"),
                    "open_card": (it.get("openCard") or {}).get("current"),
                    "add_to_cart": (it.get("addToCart") or {}).get("current"),
                    "open_to_cart": (it.get("openToCart") or {}).get("current"),
                    "orders": (it.get("orders") or {}).get("current"),
                    "cart_to_order": (it.get("cartToOrder") or {}).get("current"),
                })
            if len(items) < REPORT_LIMIT:
                break  # последняя страница
            offset += REPORT_LIMIT
            time.sleep(0.5)
        print(f"  funnel {win_begin}…{win_end}: накоплено {len(rows)} строк", flush=True)
    if rows:
        db_pg.upsert_jem_funnel_many(rows)
    return len(rows)


# =====================================================================
#  Метод 2: search-report/product/search-texts → wb_search_queries (по ключам)
# =====================================================================
def _collect_search_texts(start, end, known):
    """Топ поисковых запросов на каждый nm_id. Пишет в wb_search_queries.
    Возвращает число строк. date снимка = end.

    ⚠️ Поведенческая грабля WB: на коротких периодах (<14 дней) WB отдаёт
    ПУСТОЙ items (без ошибки) — недостаточно данных для keyword-агрегации.
    Поэтому для search-texts период расширяем до MIN_SEARCH_WINDOW дней от end
    (WB сам агрегирует за период). date снимка всё равно = end (как snapshot).

    ⚠️ Оптимизация: WB использует per-seller rate-limiter, и 143 nm_id × 1 батч
    каждый → десятки минут ожидания. Поэтому для search-texts берём ТОЛЬКО
    товары с продажами (orders>0 в воронке за период) — это ~5-15% каталога,
    но именно по ним смысл анализировать «как меня ищут». Без_sales товары
    keyword-данных почти не дают в любом случае (проверено probe'ом).
    """
    # Берём только nm_id с реальными продажами за период (из воронки).
    try:
        sold = db_pg.query(
            "SELECT DISTINCT nm_id FROM tenant.wb_funnel_daily "
            "WHERE date >= %s AND date <= %s AND COALESCE(orders,0) > 0",
            (start, end),
        )
        sold_set = {r["nm_id"] for r in sold} & known
    except Exception as e:
        print(f"  [search-texts] не удалось получить список nm с продажами ({e}), "
              f"берём все known", flush=True)
        sold_set = known
    if not sold_set:
        print(f"  [search-texts] нет nm_id с продажами за {start}..{end} — пропуск", flush=True)
        return 0
    known_list = sorted(sold_set)
    print(f"  [search-texts] кандидатов с продажами: {len(known_list)} "
          f"(из {len(known)} в каталоге)", flush=True)

    rows = []
    # Расширяем старт до MIN_SEARCH_WINDOW дней от end.
    end_d = datetime.strptime(end, "%Y-%m-%d").date()
    start_d = datetime.strptime(start, "%Y-%m-%d").date()
    min_start = end_d - timedelta(days=MIN_SEARCH_WINDOW - 1)
    if start_d > min_start:
        start_d = min_start
    st = start_d.isoformat()

    for i in range(0, len(known_list), SEARCH_TEXTS_BATCH):
        batch = known_list[i:i + SEARCH_TEXTS_BATCH]
        offset = 0
        batch_rows = []
        while True:
            body = {
                "nmIds": batch,
                "currentPeriod": {"start": st, "end": end},
                "topOrderBy": "orders",          # enum-строка (не объект!)
                "orderBy": {"field": "orders", "mode": "desc"},
                "limit": SEARCH_TEXTS_LIMIT,
                "offset": offset,
            }
            data = _wb_post(SEARCH_TEXTS_URL, body)
            if data is None:
                # мягкая деградация: WB недоступен — выходим из батча, что есть сохраняем
                break
            if data.get("__bad_request__"):
                # 400 на этом батче (превышен лимит тарифа / неверный период) —
                # пропускаем батч, идём к следующему nm_id. Лог уже выведен в _wb_post.
                break
            items = (data.get("data") or {}).get("items") or []
            if not items:
                break
            for it in items:
                nm = it.get("nmId")
                if nm not in known:
                    continue
                kw = (it.get("text") or "").strip()
                if not kw:
                    continue
                rows.append({
                    "nm_id": nm,
                    "date": end,
                    "keyword": kw,
                    "freq": (it.get("frequency") or {}).get("current"),
                    "week_freq": it.get("weekFrequency"),
                    "avg_position": (it.get("avgPosition") or {}).get("current"),
                    "median_position": (it.get("medianPosition") or {}).get("current"),
                    "open_card": (it.get("openCard") or {}).get("current"),
                    "add_to_cart": (it.get("addToCart") or {}).get("current"),
                    "open_to_cart": (it.get("openToCart") or {}).get("current"),
                    "orders": (it.get("orders") or {}).get("current"),
                    "cart_to_order": (it.get("cartToOrder") or {}).get("current"),
                    "visibility": (it.get("visibility") or {}).get("current"),
                    "open_card_pct": (it.get("openCard") or {}).get("percentile"),
                    "orders_pct": (it.get("orders") or {}).get("percentile"),
                })
                batch_rows.append(it)
            if len(items) < SEARCH_TEXTS_LIMIT:
                break  # последняя страница
            offset += SEARCH_TEXTS_LIMIT
            time.sleep(0.5)
        print(f"  search-texts батч nm[{i}..{i+len(batch)}] за {st}..{end}: +{len(batch_rows)} ключей", flush=True)
        time.sleep(0.5)
    if rows:
        db_pg.upsert_jem_search_many(rows)
    return len(rows)


# =====================================================================
#  Точка входа
# =====================================================================
def collect(start=None, end=None):
    """Собрать Джем-аналитику. start/end — YYYY-MM-DD. По умолчанию — вчера."""
    yest = (date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    start = start or yest
    end = end or yest
    if end < start:
        start, end = end, start
    print(f"[wb_jem] Портрет покупателя (Джем) {start}…{end}", flush=True)
    db_pg.init()
    known = set(db_pg.active_nm_ids())
    if not known:
        print("[wb_jem] каталог пуст — нечего собирать", flush=True)
        return 0

    # 1) Воронка по товарам (search-report/report). Если WB недоступен — стоп.
    n_funnel = _collect_funnel(start, end, known)
    if n_funnel is None:
        print("[wb_jem] ПРОПУСК: WB API недоступен, снимок не записан (exit 0)", flush=True)
        return 0
    print(f"[wb_jem] funnel: {n_funnel} строк", flush=True)

    # 2) Поисковые запросы (search-texts).
    n_search = _collect_search_texts(start, end, known)
    print(f"[wb_jem] search_queries: {n_search} строк", flush=True)

    return n_funnel + n_search


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    args = sys.argv[1:]
    collect(args[0] if len(args) > 0 else None, args[1] if len(args) > 1 else None)
