"""
SaaS-сборщик ЦЕН Ozon → tenant.ozon_prices (дневной снимок, миграция 030).

Цель — СОИНВЕСТ (спек docs/superpowers/specs/2026-08-02-ozon-coinvest-design.md):
marketing_seller_price = цена со скидками ПРОДАВЦА,
marketing_price = итог с доплатой ОЗОНА (None = соинвеста нет → честный 0%).
Соинвест % = 1 − marketing_price / marketing_seller_price. Считает РНП-роут,
здесь храним сырые цены. Буст из акций (current_boost) — НЕ соинвест
(решение хозяина 2026-08-02), его не собираем.

Ошибка батча — в лог + счётчик; 0 строк при непустом каталоге — exit 1
(FAIL прогона, не «OK с нулём» — урок аудита 2026-08). Токен из env.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient, OzonError

BATCH = 500  # product_info_prices принимает до 1000 id; 500 — с запасом


def collect():
    today = date.today().isoformat()
    print(f"[ozon_prices] снимок цен/соинвеста на {today}", flush=True)
    db_pg.init()

    cli = OzonClient()
    pids = []
    for p in cli.iter_all_products():
        pid = p.get("product_id")
        if pid is not None:
            pids.append(int(pid))

    rows = []
    failed_batches = 0
    for i in range(0, len(pids), BATCH):
        chunk = pids[i:i + BATCH]
        try:
            info = cli.product_info_prices(chunk)
        except OzonError as e:
            print(f"  [prices] батч {i//BATCH}: {e}", flush=True)
            failed_batches += 1
            continue
        for p in (info if isinstance(info, list) else []):
            pid = p.get("product_id")
            price = p.get("price") or {}
            if pid is None:
                continue

            def num(k):
                v = price.get(k)
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    return None
                return v if v > 0 else None

            rows.append({
                "product_id": int(pid),
                "date": today,
                "price": num("price"),
                "old_price": num("old_price"),
                "marketing_seller_price": num("marketing_seller_price"),
                "marketing_price": num("marketing_price"),
                "min_price": num("min_price"),
            })

    n = db_pg.upsert_ozon_prices_many(rows)
    print(f"[ozon_prices] записано {n} из {len(pids)} товаров"
          + (f", сбойных батчей: {failed_batches}" if failed_batches else ""), flush=True)
    if len(pids) > 0 and n == 0:
        # Каталог есть, а цен нет — это провал сбора, кричим, не молчим.
        print("[ozon_prices] FAIL: каталог непустой, но не записано ни одной цены", flush=True)
        sys.exit(1)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
