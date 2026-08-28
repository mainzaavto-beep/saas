"""
SaaS-сборщик ПРОДАЖ/ВОЗВРАТОВ Ozon → tenant.ozon_sales.

Обе схемы: fbo/list + fbs/list, колонка scheme. product_id — через тот же
_resolve_pid, что в ozon_orders (sku→product_id, fallback по offer_id —
нужен для FBS, где sku может отсутствовать в fbo_sku). Токен из env.
Без Google Sheets.

⚠️ БАГ API — статус-фильтр НЕ используется (вскрыт живой пробой 28.08.2026,
фикс-раунд 1 задачи 4 «География 2.0»): /v3/posting/fbo/list ИГНОРИРУЕТ
filter.status — запросы status=delivered и status=cancelled на одно и то же
окно вернули ИДЕНТИЧНЫЕ 74 постинга со смесью реальных статусов (delivered:
54, cancelled: 13, delivering: 6, awaiting_packaging: 1). Из-за этого
cancelled-проход прежней версии сборщика перезаписывал ВСЕ продажи окна как
возвраты — вся историческая tenant.ozon_sales до 28.08.2026 замусорена
(is_return=1 у 100% старых строк, полная очистка и пересбор — отдельная
задача 8). У /v3/posting/fbs/list фильтр status работает штатно, но чинить
надо единообразно на обеих схемах: теперь оба прохода идут БЕЗ статус-
фильтра, а является ли постинг продажей/возвратом/промежуточным статусом —
решаем по РЕАЛЬНОМУ p["status"] в ответе API, а не по тому, что запросили.
"""
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient


def _resolve_pid(prod, sku2pid, offer2pid):
    """product_id по sku (fbo_sku), иначе по offer_id (нужно для FBS)."""
    sku = prod.get("sku")
    if sku:
        pid = sku2pid.get(int(sku))
        if pid:
            return pid
    return offer2pid.get(prod.get("offer_id"))


def _rows_for_scheme(cli, since, to, scheme, sku2pid, offer2pid):
    """Без статус-фильтра (баг API — см. докстроку модуля): классификация
    продажа/возврат/пропуск — по реальному status постинга в ответе."""
    rows = []
    it = cli.iter_fbs_postings(since, to) if scheme == "fbs" else cli.iter_postings(since, to)
    for p in it:
        status = p.get("status")
        if status == "delivered":
            is_return = False
        elif status == "cancelled":
            is_return = True
        else:
            # Промежуточный статус (delivering, awaiting_packaging, ...) —
            # продажа ещё не состоялась, строку не пишем.
            continue
        posting_number = p.get("posting_number")
        sale_dt = p.get("in_process_at") or p.get("last_change_date") or p.get("created_at")
        last_change_dt = p.get("last_change_date")
        for prod in (p.get("products") or []):
            price_raw = prod.get("price")
            if isinstance(price_raw, dict):
                price = float(price_raw.get("amount", 0) or 0)
            elif isinstance(price_raw, (int, float)):
                price = float(price_raw)
            else:
                price = 0.0
            qty = int(prod.get("quantity", 1) or 1)
            revenue = price * qty
            if is_return:
                revenue = -abs(revenue)
            rows.append({
                "posting_number": posting_number,
                "product_id": _resolve_pid(prod, sku2pid, offer2pid),
                "offer_id": prod.get("offer_id"),
                "sale_dt": sale_dt,
                "last_change_dt": last_change_dt,
                "status": status,
                "is_return": 1 if is_return else 0,
                "qty": qty,
                "price": price,
                "revenue": revenue,
                "payout_amount": None,
                "scheme": scheme,
            })
    return rows


def collect(since=None, to=None):
    print("[ozon_sales] fbo + fbs, классификация по реальному статусу", flush=True)
    db_pg.init()
    cli = OzonClient()
    if since is None:
        since = datetime.now() - timedelta(days=7)
    if to is None:
        to = datetime.now()
    if isinstance(since, str):
        since = datetime.fromisoformat(since)
    if isinstance(to, str):
        to = datetime.fromisoformat(to)
    print(f"  период: {since.date()}..{to.date()}", flush=True)

    sku2pid = {}
    for r in db_pg.query("SELECT fbo_sku, product_id FROM tenant.ozon_products WHERE fbo_sku IS NOT NULL"):
        if r["fbo_sku"] is not None:
            sku2pid[int(r["fbo_sku"])] = int(r["product_id"])

    # Fallback-карта offer_id → product_id (та же, что в ozon_orders): FBS-
    # постингам sku из fbo_sku может не хватать.
    offer2pid = {}
    for r in db_pg.query("SELECT offer_id, product_id FROM tenant.ozon_products WHERE offer_id IS NOT NULL"):
        offer2pid[r["offer_id"]] = int(r["product_id"])

    fbo_rows = _rows_for_scheme(cli, since, to, "fbo", sku2pid, offer2pid)
    fbs_rows = _rows_for_scheme(cli, since, to, "fbs", sku2pid, offer2pid)
    combined = fbo_rows + fbs_rows
    all_rows = [r for r in combined if r["product_id"] is not None]
    n_orphans = len(combined) - len(all_rows)
    n_delivered = sum(1 for r in combined if not r["is_return"])
    n_cancelled = sum(1 for r in combined if r["is_return"])
    written = db_pg.upsert_ozon_sales_many(all_rows)
    print(f"[ozon_sales] delivered {n_delivered}, cancelled {n_cancelled}, записано {written}"
          + (f", пропущено {n_orphans}" if n_orphans else ""), flush=True)
    print(f"##OBS rows={written} from={since.strftime('%Y-%m-%d')} to={to.strftime('%Y-%m-%d')}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    s = sys.argv[1] if len(sys.argv) > 1 else None
    t = sys.argv[2] if len(sys.argv) > 2 else None
    collect(s, t)
