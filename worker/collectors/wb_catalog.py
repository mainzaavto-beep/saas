"""
SaaS-сборщик каталога WB (proof-of-concept для Этапа 3).
Тянет ВСЕ товары клиента через Content API /content/v2/get/cards/list и пишет
в tenant.wb_articles через db_pg (RLS изолирует по cabinet_id).

Отличия от боевого collector_wb/wb_catalog.py:
- НЕ зависит от ярлыка «АКТИВНЫЙ» (клиент мог его не ставить) — берём весь каталог.
- Пишет в PostgreSQL (tenant.wb_articles), не SQLite.
- Токен из env WB_TOKEN (воркер выставляет per-process из auth.cabinets.api_creds).

Запуск: python -m worker.collectors.wb_catalog  (воркер выставляет env beforehand)
"""
import os
import sys
import time
import requests

# Токен: воркер выставляет WB_TOKEN в env ПЕРЕД импортом этого модуля.
# (боевой паттерн: WB_TOKEN = os.getenv на верхнем уровне — сохраняем совместимость.)
WB_TOKEN = os.getenv("WB_TOKEN")
CARDS_URL = "https://content-api.wildberries.ru/content/v2/get/cards/list"
PAGE_LIMIT = 100

# Импорт db_pg — адаптер PG с cabinet_id. Запускается как worker.collectors.wb_catalog,
# поэтому db_pg (в worker/) доступен через родительский пакет.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg


def parse_card_barcodes(card: dict) -> list[dict]:
    """Штрихкоды карточки: sizes[].skus (Content API v2). Один nm_id → много
    штрихкодов (размеры/цвета). Нужны marketplace-api /api/v3/stocks/{warehouseId}
    (FBS-остатки складов продавца, план «Склады 2.0, этап 1», задача 6)."""
    nm = card.get("nmID")
    out = []
    for s in card.get("sizes") or []:
        for bc in s.get("skus") or []:
            if bc:
                out.append({"barcode": str(bc), "nm_id": nm,
                            "chrt_id": s.get("chrtID"), "tech_size": s.get("techSize")})
    return out


def fetch_all_cards() -> list[dict]:
    """Постранично тянет весь каталог клиента. cursor-пагинация Content API."""
    if not WB_TOKEN:
        raise RuntimeError("WB_TOKEN не выставлен воркером")
    headers = {"Authorization": WB_TOKEN, "Content-Type": "application/json"}
    cursor = {"limit": PAGE_LIMIT}
    result = []
    while True:
        body = {"settings": {"cursor": cursor, "filter": {"withPhoto": -1}}}
        r = None
        for _attempt in range(3):
            r = requests.post(CARDS_URL, headers=headers, json=body, timeout=30)
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 60))
                print(f"    Content API 429, жду {wait}с...", flush=True)
                time.sleep(wait)
                continue
            r.raise_for_status()
            break
        else:
            raise RuntimeError("Content API вернул 429 после 3 попыток")
        data = r.json()
        cards = data.get("cards", [])
        for c in cards:
            photos = c.get("photos") or []
            im_url = None
            if photos and isinstance(photos[0], dict):
                im_url = photos[0].get("c246x328") or photos[0].get("big")
            result.append({
                "nm_id": c["nmID"],
                "name": c.get("vendorCode") or str(c["nmID"]),
                "brand": c.get("brand"),
                "subject": c.get("subjectName"),
                "im_url": im_url,
                "imt_id": c.get("imtID"),
                "barcodes": parse_card_barcodes(c),
            })
        cur = data.get("cursor", {})
        if len(cards) < cursor["limit"]:
            break
        cursor = {"limit": PAGE_LIMIT, "updatedAt": cur.get("updatedAt"), "nmID": cur.get("nmID")}
        time.sleep(0.3)
    return result


def collect() -> int:
    """Собрать каталог клиента → tenant.wb_articles. Возвращает кол-во товаров."""
    db_pg.init()
    cards = fetch_all_cards()
    count = 0
    for c in cards:
        db_pg.upsert_article(c["nm_id"], c["name"], c.get("brand"), c.get("subject"), c.get("im_url"), imt_id=c.get("imt_id"))
        count += 1
    print(f"[wb_catalog] собрано {count} артикулов → tenant.wb_articles", flush=True)
    barcodes = [b for c in cards for b in c.get("barcodes") or []]
    n_bc = db_pg.upsert_wb_barcodes_many(barcodes)
    print(f"[wb_catalog] штрихкодов {n_bc} → tenant.wb_barcodes", flush=True)
    print(f"##OBS rows={count}", flush=True)
    return count


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    n = collect()
    print(f"Итого: {n} артикулов")
