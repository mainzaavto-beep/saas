"""
SaaS-сборщик КАТАЛОГА Ozon → tenant.ozon_products.

Источники: /v3/product/list + /v3/product/info/list (комиссии/объём) +
/v4/product/info/attributes (габариты) + /v5/product/info/prices (цены).
БЕЗ дерева категорий (упрощение — добавим позже; description_category_id сохраняем).

Использует ozon_client.OzonClient (скопирован из боевого, параметризуемый —
воркер выставляет OZON_CLIENT_ID/OZON_API_KEY в env).
Без Google Sheets. Токен из env.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient


def _fbo_commission(item):
    for c in (item.get("commissions") or []):
        if (c.get("sale_schema") or "").upper() == "FBO":
            return c
    return None


def _to_float(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def collect(visibility="ALL"):
    print(f"[ozon_catalog] товары visibility={visibility}", flush=True)
    db_pg.init()
    cli = OzonClient()  # читает OZON_CLIENT_ID/OZON_API_KEY из env (воркер выставил)

    # 1. Список product_id + offer_id.
    product_ids = []
    for it in cli.iter_all_products(visibility):
        pid = it.get("product_id")
        if pid is not None:
            product_ids.append(int(pid))
    print(f"  найдено товаров: {len(product_ids)}", flush=True)
    if not product_ids:
        return 0

    # 2. Габариты из /v4 attributes.
    attrs_by_pid = {}
    for a in cli.product_info_attributes(product_ids, visibility):
        apid = a.get("id") or a.get("product_id")
        if apid is not None:
            attrs_by_pid[int(apid)] = a

    # 3. Цены из /v5.
    prices_by_pid = {}
    for p in cli.product_info_prices(product_ids, visibility):
        ppid = p.get("product_id")
        if ppid is not None:
            prices_by_pid[int(ppid)] = p.get("price") or {}

    # 4. Детали + комиссии → products.
    n = 0
    for chunk_start in range(0, len(product_ids), 1000):
        chunk = product_ids[chunk_start:chunk_start + 1000]
        for item in cli.product_info(chunk):
            pid = item.get("id") or item.get("product_id")
            if pid is None:
                continue
            sources = item.get("sources") or []
            fbs = next((s for s in sources if s.get("source") == "fbs"), None)
            fbo_sku = (fbs or sources[0] if sources else {}).get("sku") if sources else None
            barcodes = item.get("barcodes") or []
            fbo_comm = _fbo_commission(item)
            a = attrs_by_pid.get(int(pid), {})
            p = prices_by_pid.get(int(pid), {})
            primary = item.get("primary_image") or []
            images = item.get("images") or []
            im_url = None
            if primary and isinstance(primary, list):
                im_url = primary[0]
            elif images and isinstance(images, list):
                im_url = images[0]
            elif isinstance(primary, str):
                im_url = primary

            db_pg.upsert_product(
                int(pid), item.get("name") or str(pid),
                offer_id=item.get("offer_id"),
                barcode=barcodes[0] if barcodes else None,
                fbo_sku=fbo_sku,
                brand=item.get("brand"),
                visibility=item.get("visibility") or visibility,
                commission_pct=_to_float(fbo_comm.get("percent")) if fbo_comm else None,
                logistics_fbo_tariff=_to_float(fbo_comm.get("delivery_amount")) if fbo_comm else None,
                weight=_to_float(a.get("weight")),
                length=_to_float(a.get("depth")),  # API: depth → length
                width=_to_float(a.get("width")),
                height=_to_float(a.get("height")),
                volume_weight=_to_float(item.get("volume_weight")),
                vat=_to_float(item.get("vat")),
                price=_to_float(p.get("marketing_seller_price")),
                old_price=_to_float(p.get("old_price")),
                im_url=im_url,
                description_category_id=a.get("description_category_id"),
                type_name=a.get("type_name"),
            )
            n += 1
    print(f"[ozon_catalog] записано {n} товаров → tenant.ozon_products", flush=True)
    return n


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("visibility", nargs="?", default="ALL")
    # orchestrator передаёт даты (date-from/to) всем сборщикам; catalog их не использует —
    # parse_known_args игнорирует лишние позиционные (даты), не падая.
    a, _unknown = ap.parse_known_args()
    # visibility не должно выглядеть как дата (если orchestrator передал дату первой).
    vis = a.visibility if not a.visibility or a.visibility[0].isdigit() else a.visibility
    collect(vis or "ALL")
