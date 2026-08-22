"""
SaaS-сборщик КАТАЛОГА Ozon → tenant.ozon_products.

Источники: /v3/product/list + /v3/product/info/list (комиссии/объём) +
/v4/product/info/attributes (габариты, description_category_id, type_id) +
/v5/product/info/prices (цены) + /v1/description-category/tree (имена категорий/
типов — ОДИН запрос на прогон, дерево кэшируется в памяти процесса, см. collect()).

products.category (задача 2026-08-21: находка «category пуст у ВСЕХ товаров» —
фильтры категорий на Сводке были пусты для Ozon) = человекочитаемое имя КАТЕГОРИИ
(description_category_id → category_name из дерева), не типа товара. Панель
одноуровневая: category одновременно кормит и «Группу», и «Категорию» в фильтрах
Сводки (см. app/api/cabinets/[id]/products-summary/route.js, cat=grp=p.category).
Категория выбрана вместо типа, потому что type_name у Ozon почти 1:1 с товаром
(узкие "листья" дерева) — как фильтр даёт кучу групп по 1 товару. category_name —
более широкий уровень (аналог o.category у WB, а не узкого a.subject) — даёт
few содержательных групп, пригодных для фильтрации. type_name тоже сохраняем
(колонка products.type_name) — fallback, если для description_category_id вдруг
нет узла в дереве (не должно случаться, но не роняем сборщик).

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


def _flatten_category_tree(nodes):
    """Разворачивает дерево /v1/description-category/tree в две плоские карты:
    description_category_id → category_name и type_id → type_name.

    Дерево рекурсивно (children на любом уровне); узлы-категории и узлы-типы
    неразличимы по форме, кроме наличия своего id/name — берём оба, если есть,
    на КАЖДОМ уровне (description_category_id у Ozon может указывать и на
    промежуточный, и на листовой узел категории)."""
    cat_map, type_map = {}, {}

    def walk(items):
        for n in (items or []):
            if not isinstance(n, dict):
                continue
            cid = n.get("description_category_id")
            if cid is not None and n.get("category_name"):
                cat_map[int(cid)] = n["category_name"]
            tid = n.get("type_id")
            if tid is not None and n.get("type_name"):
                type_map[int(tid)] = n["type_name"]
            walk(n.get("children"))

    walk(nodes)
    return cat_map, type_map


def collect(visibility="ALL"):
    print(f"[ozon_catalog] товары visibility={visibility}", flush=True)
    db_pg.init()
    cli = OzonClient()  # читает OZON_CLIENT_ID/OZON_API_KEY из env (воркер выставил)

    # 0. Дерево категорий — ОДИН запрос на весь прогон (кэш в памяти процесса,
    # не в БД: дерево общее для всех продавцов, дёшево запросить каждый раз).
    cat_by_id, type_by_id = _flatten_category_tree(cli.category_tree())
    print(f"  дерево категорий: {len(cat_by_id)} категорий, {len(type_by_id)} типов", flush=True)

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

            # Категория/тип — по id из attributes (/v4) + имена из дерева (шаг 0).
            # ⚠️ Раньше здесь читался несуществующий ключ a.get("type_name") —
            # /v4/product/info/attributes отдаёт только type_id (числовой), не имя;
            # поэтому колонка type_name всегда была NULL. Имя типа теперь тоже
            # берём из дерева, по type_id.
            desc_cat_id = a.get("description_category_id")
            type_id = a.get("type_id")
            cat_name = cat_by_id.get(int(desc_cat_id)) if desc_cat_id is not None else None
            typ_name = type_by_id.get(int(type_id)) if type_id is not None else None
            # category = категория (широкий уровень), не тип (см. докстрока файла).
            # Fallback на type_name, если для description_category_id нет узла
            # в дереве (не должно случаться при живом id, но не роняем сборщик).
            category = cat_name or typ_name

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
                description_category_id=desc_cat_id,
                type_name=typ_name,
                category=category,
            )
            n += 1
    print(f"[ozon_catalog] записано {n} товаров → tenant.ozon_products", flush=True)
    print(f"##OBS rows={n}", flush=True)
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
