"""
SaaS-сборщик РЕКЛАМЫ OZON ПО ТОВАРАМ → tenant.ozon_daily_sku_ad (+ пересчёт
tenant.ozon_daily_metrics.ad_* по product_id).

Источник: Performance API, async-отчёт POST /api/client/statistics с
groupBy=DATE → poll → download ZIP (CSV на кампанию, строки день×sku,
колонка «Расход, ₽, с НДС»). Доказано живой пробой 2026-08-21: суммы по
(кампания, день) сходятся с tenant.ozon_daily_campaign_ad до копейки на
закрытых днях; расходятся законно: текущий день (растёт), ретро-ревизии
(лечится lookback-окном), строки «Корректировка» без даты/sku (остаются
только в кампанийном итоге).

⚠️ Скачивание готового отчёта ТРЕБУЕТ Authorization: Bearer — без него 401.
⚠️ OAuth: JSON-тело (basic auth = 401, грабля 2026-08-02).
⚠️ Окно дат ≤60 дней, кампаний в отчёте ≤10, паузы ≥2с, 429 → 65с.
Без perf-creds — мягкий skip (как ozon_efficiency).
Кампании берём из tenant.ozon_daily_campaign_ad (их ведёт ozon_efficiency) —
отдельного похода в /api/client/campaign не нужно, и мы заведомо запрашиваем
только кампании, у которых в окне был расход.
"""
import os
import io
import re
import csv
import sys
import time
import zipfile
import requests
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

HOST = "https://api-performance.ozon.ru"
CHUNK_DAYS = 60          # >61 дня — HTTP 400 (грабля ozon_efficiency)
CHUNK_CAMPAIGNS = 10     # лимит кампаний на один async-отчёт
SLEEP = 2.0              # пауза между HTTP-запросами
SLEEP_429 = 65.0
POLL_SLEEP = 5.0
POLL_MAX = 60            # ~5 минут на отчёт
_TOTAL_ROWS = ("всего", "итого")
_CORRECTION = "корректировка"
_DATE_DMY = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})$")


class PartialError(Exception):
    """Чанк не собрался — окно писать нельзя (иначе DELETE снесёт больше,
    чем INSERT вернёт). Прогон завершается exit 3, данные окна не трогаются."""


def _num(s):
    try:
        return float(str(s or "0").replace("\xa0", "").replace(" ", "").replace(",", "."))
    except ValueError:
        return 0.0


def _norm_date(s):
    m = _DATE_DMY.match((s or "").strip())
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def _request(method, url, token, *, body=None, params=None, stream_bytes=False):
    """HTTP с паузой и одним повтором на 429. Возвращает Response.
    Ошибки != 200 после повтора → PartialError (не пишем окно молча)."""
    for attempt in (1, 2):
        time.sleep(SLEEP)
        if method == "get":
            r = requests.get(url, headers={"Authorization": f"Bearer {token}"},
                             params=params, timeout=120)
        else:
            r = requests.post(url, headers={"Authorization": f"Bearer {token}"},
                              json=body or {}, timeout=120)
        if r.status_code == 429 and attempt == 1:
            print(f"  429 на {url[-40:]} — пауза {SLEEP_429}с", flush=True)
            time.sleep(SLEEP_429)
            continue
        return r
    return r


def _token():
    perf_id = os.environ.get("OZON_PERF_CLIENT_ID")
    perf_secret = os.environ.get("OZON_PERF_CLIENT_SECRET")
    if not (perf_id and perf_secret):
        return None
    tr = requests.post(HOST + "/api/client/token",
                       json={"client_id": perf_id, "client_secret": perf_secret,
                             "grant_type": "client_credentials"}, timeout=30)
    if tr.status_code != 200:
        print(f"  Performance token HTTP {tr.status_code}: {tr.text[:120]}", flush=True)
        return None
    return tr.json().get("access_token")


def _campaigns_in_window(since_s, to_s):
    rows = db_pg.query(
        "SELECT DISTINCT campaign_id FROM tenant.ozon_daily_campaign_ad "
        "WHERE date >= %s AND date <= %s AND spend > 0 ORDER BY campaign_id",
        (since_s, to_s))
    return [str(r["campaign_id"]) for r in rows]


def _fetch_report(token, campaign_ids, since_s, to_s):
    """create → poll → download → список членов ZIP [(имя, текст)].
    Любой сбой → PartialError."""
    r = _request("post", HOST + "/api/client/statistics", token,
                 body={"campaigns": campaign_ids, "dateFrom": since_s,
                       "dateTo": to_s, "groupBy": "DATE"})
    if r.status_code != 200:
        raise PartialError(f"create HTTP {r.status_code}: {r.text[:120]}")
    uuid = (r.json() or {}).get("UUID")
    if not uuid:
        raise PartialError(f"create без UUID: {r.text[:120]}")
    link = None
    for _ in range(POLL_MAX):
        time.sleep(POLL_SLEEP)
        p = _request("get", f"{HOST}/api/client/statistics/{uuid}", token)
        if p.status_code != 200:
            raise PartialError(f"poll HTTP {p.status_code}")
        data = p.json() or {}
        state = (data.get("state") or "").upper()
        if state == "OK":
            link = data.get("link")
            break
        if state in ("ERROR", "FAILED"):
            raise PartialError(f"отчёт {uuid} state={state}")
    if not link:
        raise PartialError(f"отчёт {uuid} не готов за {POLL_MAX * POLL_SLEEP:.0f}с")
    d = _request("get", link if link.startswith("http") else HOST + link, token)
    if d.status_code != 200:
        raise PartialError(f"download HTTP {d.status_code}")
    content = d.content
    if content[:2] != b"PK":
        # Один CSV без архива (одна кампания) — API так тоже умеет. Не-ZIP ответ
        # бывает только при одной кампании в запросе — имя восстанавливаем из
        # запрошенного списка, иначе _parse_member не извлечёт campaign_id и
        # кампания молча пропадёт.
        return [(f"{campaign_ids[0]}_single.csv", content.decode("utf-8-sig", errors="replace"))]
    zf = zipfile.ZipFile(io.BytesIO(content))
    return [(n, zf.read(n).decode("utf-8-sig", errors="replace")) for n in zf.namelist()]


def _parse_member(name, text, sku_to_pid, counters):
    """CSV одной кампании → строки для upsert. campaign_id — из имени файла."""
    m = re.match(r"^(\d+)_", name)
    if not m:
        counters["bad_member"] += 1
        return []
    campaign_id = int(m.group(1))
    rows = list(csv.reader(io.StringIO(text), delimiter=";"))
    hdr_i = None
    for i, row in enumerate(rows[:5]):
        low = [c.strip().lower() for c in row]
        if "sku" in low and any("расход" in c for c in low):
            hdr_i = i
            break
    if hdr_i is None:
        counters["no_header"] += 1
        return []
    headers = [c.strip().lower() for c in rows[hdr_i]]
    def col(pred):
        for i, h in enumerate(headers):
            if pred(h):
                return i
        return None
    day_i = col(lambda h: h in ("день", "дата"))
    sku_i = col(lambda h: h == "sku")
    spend_i = col(lambda h: "расход" in h)
    views_i = col(lambda h: h == "показы")
    clicks_i = col(lambda h: h == "клики")
    sold_i = col(lambda h: h.startswith("продано товаров") and "модели" not in h)
    osum_i = col(lambda h: h.startswith("заказано на сумму"))
    if day_i is None or sku_i is None or spend_i is None:
        counters["no_header"] += 1
        return []
    out = []
    for row in rows[hdr_i + 1:]:
        if len(row) <= max(day_i, sku_i, spend_i):
            continue
        first = (row[0] or "").strip().lower()
        if first.startswith(_CORRECTION):
            counters["correction_sum"] += _num(row[spend_i])
            continue
        if any(first.startswith(t) for t in _TOTAL_ROWS):
            continue
        d = _norm_date(row[day_i])
        if not d:
            continue
        sku = (row[sku_i] or "").strip()
        if not sku:
            continue
        pid = sku_to_pid.get(sku)
        if pid is None:
            counters["unresolved_sku"] += 1
        out.append({
            "date": d, "campaign_id": campaign_id, "sku": sku, "product_id": pid,
            "spend": _num(row[spend_i]),
            "views": int(_num(row[views_i])) if views_i is not None and views_i < len(row) else None,
            "clicks": int(_num(row[clicks_i])) if clicks_i is not None and clicks_i < len(row) else None,
            "ordered_units": int(_num(row[sold_i])) if sold_i is not None and sold_i < len(row) else None,
            "ordered_amount": _num(row[osum_i]) if osum_i is not None and osum_i < len(row) else None,
        })
    return out


def _sku_map():
    rows = db_pg.query(
        "SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL", ())
    return {str(r["fbo_sku"]): r["product_id"] for r in rows}


def collect(since=None, to=None):
    print("[ozon_sku_ad] реклама Ozon по товарам", flush=True)
    db_pg.init()
    yesterday = datetime.now() - timedelta(days=1)
    if to is None or to > yesterday:
        to = yesterday          # текущий день не пишем — растёт внутри дня
    if since is None:
        since = datetime.now() - timedelta(days=14)
    token = _token()
    if not token:
        print("  Performance credentials нет/токен не получен — skip "
              "(товарная реклама не обновится в этом прогоне)", flush=True)
        return 0
    sku_to_pid = _sku_map()
    all_rows = []
    counters = {"bad_member": 0, "no_header": 0, "unresolved_sku": 0, "correction_sum": 0.0}
    win_start = since
    while win_start <= to:
        win_end = min(win_start + timedelta(days=CHUNK_DAYS - 1), to)
        s, e = win_start.strftime("%Y-%m-%d"), win_end.strftime("%Y-%m-%d")
        campaigns = _campaigns_in_window(s, e)
        print(f"  окно {s}..{e}: кампаний со spend>0: {len(campaigns)}", flush=True)
        for i in range(0, len(campaigns), CHUNK_CAMPAIGNS):
            chunk = campaigns[i:i + CHUNK_CAMPAIGNS]
            members = _fetch_report(token, chunk, s, e)
            for name, text in members:
                all_rows.extend(_parse_member(name, text, sku_to_pid, counters))
        win_start = win_end + timedelta(days=1)
    # Потеря целой кампании (bad_member) не должна коммититься молча — окно не пишем.
    if counters["bad_member"] > 0:
        raise PartialError(f"{counters['bad_member']} членов отчёта без campaign_id в имени — окно не пишем")
    since_s, to_s = since.strftime("%Y-%m-%d"), to.strftime("%Y-%m-%d")
    n = db_pg.upsert_ozon_sku_ad_many(all_rows, since_s, to_s)
    m = db_pg.recompute_ozon_daily_ad(since_s, to_s)
    # Видимые счётчики — не молчим (урок «молчаливое падение очистки»).
    if counters["unresolved_sku"]:
        print(f"  ⚠️ sku без товара в каталоге: {counters['unresolved_sku']} строк "
              f"(spend остаётся в сыром слое и кабинетном итоге)", flush=True)
    if counters["no_header"] or counters["bad_member"]:
        print(f"  ⚠️ членов ZIP без разбора: no_header={counters['no_header']} "
              f"bad_member={counters['bad_member']}", flush=True)
    if counters["correction_sum"]:
        print(f"  «Корректировка» (без даты/sku, в товары не пишется): "
              f"{counters['correction_sum']:.2f} ₽", flush=True)
    print(f"[ozon_sku_ad] записано строк {n}, товар-дней пересчитано {m}", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    try:
        collect(datetime.fromisoformat(s) if s else None,
                datetime.fromisoformat(t) if t else None)
    except PartialError as e:
        print(f"[ozon_sku_ad] PARTIAL: {e} — окно НЕ записано", flush=True)
        sys.exit(3)
