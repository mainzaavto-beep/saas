"""
SaaS-сборщик ЗАКАЗОВ Ozon (FBO + FBS) → tenant.ozon_orders.

/v3/posting/fbo/list за период + /v3/posting/fbs/list — обе схемы, колонка scheme.
Один posting → несколько строк (по product_id).
sku (fbo_sku) маппится в product_id через tenant.ozon_products; для FBS,
где sku может отсутствовать в fbo_sku, — fallback по offer_id (_resolve_pid).
Токен из env (воркер). Без Google Sheets.

⚠️ ОКНО СБОРА — размораживание статусов (задача «Размораживание статусов
ozon_orders», .superpowers/sdd/2026-08-18-orders-vitrina/): /v3/posting/fbo/list
фильтрует по дате СОЗДАНИЯ отправления (`since`/`to`), а плановый прогон
(run_saas_collect.sh, MAIN_COLLECTORS) вызывает сборщик узким окном −2..сегодня
(DAYS_FROM=2, DAYS_TO=0) — отправление старше 2 дней больше никогда не
переспрашивается, и его `status` замерзает навсегда, даже когда продажа давно
завершена (497 строк на живой БД застряли в in-transit, `updated_at` не
двигался месяц — подтверждено ре-ревью чтением кода и данных).

Починка — тот же lookback-пол, что у ozon_accruals.py/ozon_order_costs.py
(resolve_window, MIN_LOOKBACK_DAYS=45 дней, импортирован отсюда, не
продублирован), но с ПРОТИВОПОЛОЖНЫМ концом окна: у начислений конец —
не позже вчера (Ozon дополняет сегодняшний день постепенно), а у заказов
статус СЕГОДНЯШНЕГО отправления нужен сразу — поэтому resolve_window
вызывается с cap_to_yesterday=False. Верхняя граница периода при этом не
округляется до полуночи текущих суток (иначе сегодняшние отправления снова
выпадали бы из окна) — берётся текущий момент `datetime.now(timezone.utc)`.
Каждый плановый прогон переспрашивает и идемпотентно освежает status/
cancel_dt/updated_at всех отправлений, созданных за последние 45 дней.

⚠️ ДОСБОР «ЗАМЁРЗШИХ» (12.10.2026): статус может смениться и позже 45 дней (53 FBO-
отправления 31.07–01.08 у нас висели в delivering, в API давно cancelled «Покупатель не
забрал заказ»). После основного окна — refresh_stale(): незавершённые отправления в БД,
созданные раньше окна, но не старше STALE_MAX_DAYS, переспрашиваются тем же /v3/posting/
{fbo,fbs}/list узкими окнами вокруг их дат создания (±1 день, соседние дни сливаются).
/v2/posting/fbo/get не годится — он не отдаёт объект cancellation (проба 12.10.2026).

ПРИЧИНЫ ОТМЕН (миграция 066): cancellation.cancel_reason / cancellation_type /
cancellation_initiator — есть и в FBO, и в FBS ответе (проверено живым API 12.10.2026);
канон невыкупа по ним — lib/buyout.js classifyOzonPosting.
"""
import os
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient, REQUEST_PAUSE_SEC
from ozon_accruals import resolve_window

STALE_MAX_DAYS = 180  # потолок досбора незавершённых: старше — не переспрашиваем


def _resolve_pid(prod, sku2pid, offer2pid):
    """product_id по sku (fbo_sku), иначе по offer_id (нужно для FBS)."""
    sku = prod.get("sku")
    if sku:
        pid = sku2pid.get(int(sku))
        if pid:
            return pid
    return offer2pid.get(prod.get("offer_id"))


def _posting_rows(p, scheme, sku2pid, offer2pid):
    """Строки tenant.ozon_orders одного отправления (по строке на товар)."""
    out = []
    posting_number = p.get("posting_number")
    status = p.get("status")
    is_cancel = 1 if status == "cancelled" else 0
    order_dt = p.get("in_process_at") or p.get("created_at")
    last_change_dt = p.get("last_change_date") or p.get("shipment_date")
    analytics = p.get("analytics_data") or {}
    # FBO кладёт имя склада в warehouse_name (ключа `warehouse` там нет —
    # из-за него склад был пуст во всех строках, баг вскрыт 27.08),
    # а FBS — наоборот, в warehouse (проверено живым API 28.08).
    warehouse = analytics.get("warehouse_name") or analytics.get("warehouse") or ""
    region = analytics.get("region") or analytics.get("city", "")
    # Причина отмены (066). У неотменённых Ozon отдаёт пустые строки/null — пишем NULL.
    cx = p.get("cancellation") or {}
    cancel_reason = (cx.get("cancel_reason") or None) if is_cancel else None
    cancellation_type = (cx.get("cancellation_type") or None) if is_cancel else None
    cancel_initiator = (cx.get("cancellation_initiator") or None) if is_cancel else None
    products = p.get("products") or p.get("product") or []
    for prod in products:
        cancel_dt = last_change_dt if is_cancel else None
        price_raw = prod.get("price")
        if isinstance(price_raw, dict):
            price_val = float(price_raw.get("amount", 0) or 0)
        elif isinstance(price_raw, (int, float)):
            price_val = float(price_raw)
        else:
            price_val = 0.0
        qty = int(prod.get("quantity", 1) or 1)
        out.append({
            "posting_number": posting_number,
            "product_id": _resolve_pid(prod, sku2pid, offer2pid),
            "offer_id": prod.get("offer_id"),
            "order_dt": order_dt,
            "last_change_dt": last_change_dt,
            "in_process_at": p.get("in_process_at"),
            "status": status,
            "is_cancel": is_cancel,
            "cancel_dt": cancel_dt,
            "qty": qty,
            "price": price_val,
            "total": price_val * qty,
            "warehouse": warehouse,
            "region": region,
            "scheme": scheme,
            "warehouse_id": analytics.get("warehouse_id"),
            "delivery_type": analytics.get("delivery_type", ""),
            "shipment_dt": p.get("shipment_date"),
            "cancel_reason": cancel_reason,
            "cancellation_type": cancellation_type,
            "cancel_initiator": cancel_initiator,
        })
    return out


def stale_windows(dates):
    """Даты создания (date) → слитые окна [(from_date, to_date)] с запасом ±1 день
    (order_dt = in_process_at, а фильтр API — по created_at; они могут разойтись)."""
    days = sorted({d for d in dates})
    out = []
    for d in days:
        lo, hi = d - timedelta(days=1), d + timedelta(days=1)
        if out and lo <= out[-1][1] + timedelta(days=1):
            out[-1] = (out[-1][0], max(out[-1][1], hi))
        else:
            out.append((lo, hi))
    return out


def refresh_stale(cli, window_start, sku2pid, offer2pid, now=None):
    """Досбор незавершённых отправлений старше основного окна (см. шапку модуля).
    window_start — начало основного окна (datetime UTC). Возвращает число записанных строк."""
    now = now or datetime.now(timezone.utc)
    floor = now - timedelta(days=STALE_MAX_DAYS)
    stale = db_pg.ozon_orders_stale(window_start, floor)
    if not stale:
        print("[ozon_orders] досбор незавершённых: нет", flush=True)
        return 0
    by_scheme = {}
    for r in stale:
        d = datetime.fromisoformat(str(r["order_dt"]).replace("Z", "+00:00")).date()
        by_scheme.setdefault(r["scheme"], {})[r["posting_number"]] = d
    written = 0
    for scheme, pn2d in sorted(by_scheme.items()):
        want = set(pn2d)
        rows, found, statuses = [], set(), {}
        for i, (lo, hi) in enumerate(stale_windows(pn2d.values())):
            if i:
                time.sleep(REQUEST_PAUSE_SEC)  # тот же лимит Ozon на частые подряд запросы
            since = datetime.combine(lo, datetime.min.time(), tzinfo=timezone.utc)
            to = datetime.combine(hi, datetime.max.time(), tzinfo=timezone.utc)
            it = cli.iter_postings(since, to) if scheme == "fbo" else cli.iter_fbs_postings(since, to)
            for p in it:
                pn = p.get("posting_number")
                if pn not in want:
                    continue
                found.add(pn)
                statuses[p.get("status")] = statuses.get(p.get("status"), 0) + 1
                rows.extend(_posting_rows(p, scheme, sku2pid, offer2pid))
        clean = [r for r in rows if r["product_id"] is not None]
        n_orphans = len(rows) - len(clean)
        n = db_pg.upsert_ozon_orders_many(clean)
        written += n
        print(f"[ozon_orders] досбор незавершённых {scheme}: в БД {len(want)}, найдено в API {len(found)}, "
              f"статусы {statuses}, записано строк {n}"
              + (f", пропущено(нет в каталоге) {n_orphans}" if n_orphans else "")
              + (f", не найдено {len(want - found)}" if want - found else ""), flush=True)
    return written


def collect(since=None, to=None):
    print("[ozon_orders] постинги FBO+FBS", flush=True)
    db_pg.init()
    cli = OzonClient()

    d_from, d_to = resolve_window(since, to, cap_to_yesterday=False)
    now_utc = datetime.now(timezone.utc)
    since_dt = datetime.combine(d_from, datetime.min.time(), tzinfo=timezone.utc)
    if d_to >= now_utc.date():
        # Конец окна — сегодня: берём текущий момент, а не полночь суток
        # (иначе сегодняшние отправления снова выпадали бы из окна).
        to_dt = now_utc
    else:
        to_dt = datetime.combine(d_to, datetime.max.time(), tzinfo=timezone.utc)
    print(f"  период: {d_from}..{d_to}"
          + (" (конец = сейчас)" if d_to >= now_utc.date() else ""), flush=True)
    since, to = since_dt, to_dt

    # Карта fbo_sku → product_id из PG (вместо прямого sqlite3.connect).
    sku2pid = {}
    for r in db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        if r["fbo_sku"] is not None:
            sku2pid[int(r["fbo_sku"])] = int(r["product_id"])
    print(f"  справочник: {len(sku2pid)} sku→product_id", flush=True)

    # Fallback-карта offer_id → product_id: FBS-постинги несут sku, которого
    # может не быть в fbo_sku, — тогда ищем по offer_id (tenant.ozon_products
    # другой sku-колонки не имеет, проверено 28.08).
    offer2pid = {}
    for r in db_pg.query("SELECT offer_id, product_id FROM tenant.ozon_products WHERE offer_id IS NOT NULL"):
        offer2pid[r["offer_id"]] = int(r["product_id"])

    rows = []
    n_postings = {"fbo": 0, "fbs": 0}
    sources = [("fbo", cli.iter_postings(since, to)),
               ("fbs", cli.iter_fbs_postings(since, to))]
    for scheme, postings in sources:
        for p in postings:
            n_postings[scheme] += 1
            rows.extend(_posting_rows(p, scheme, sku2pid, offer2pid))

    clean = [r for r in rows if r["product_id"] is not None]
    n_orphans = len(rows) - len(clean)
    written = db_pg.upsert_ozon_orders_many(clean)
    print(f"[ozon_orders] отправлений fbo {n_postings['fbo']}, fbs {n_postings['fbs']}, записано {written}"
          + (f", пропущено(нет в каталоге) {n_orphans}" if n_orphans else ""), flush=True)
    # Досбор незавершённых — после того, как основное окно уже записано (upsert закоммичен):
    # его сбой не должен ронять прогон в failed — это partial (exit 3, контракт оркестратора).
    stale_ok = True
    try:
        written += refresh_stale(cli, since, sku2pid, offer2pid)
    except Exception:
        stale_ok = False
        print("[ozon_orders] PARTIAL: досбор незавершённых упал, основное окно записано:", flush=True)
        traceback.print_exc()
        sys.stdout.flush()
    print(f"##OBS rows={written} from={d_from.isoformat()} to={d_to.isoformat()}", flush=True)
    if not stale_ok:
        sys.exit(3)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    collect(s, t)
