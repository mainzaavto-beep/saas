"""
db_pg.py — SaaS адаптер WB-сборщика: тот же API что боевой collector_wb/db.py,
но на PostgreSQL + cabinet_id (RLS). Импортируется SaaS-версиями сборщиков.

Принцип:
- get_connection() → psycopg-соединение к БД saas под ролью saas_app.
- Текущий cabinet_id читается из env WB_SaaS_CABINET_ID (воркер выставляет перед
  запуском процесса) и выставляется в сессии: SET LOCAL app.cabinet_id. RLS
  изолирует все запросы автоматически.
- Все upsert-функции принимают тот же набор полей что боевой db.py + НЕСЯТ
  cabinet_id в PK автоматически (через _ctx()).
- ?-плейсхолдеры конвертируются в %s через _q() (чтобы сборщики минимально править).

Координация: боевой C:\\Agents\\data-presenter-agent\\collector_wb\\db.py НЕ трогается.
Это отдельный модуль в SaaS-контуре (C:\\Agents\\saas\\worker\\).
"""
import os
import re
import json
import psycopg
from psycopg.rows import dict_row
from datetime import datetime, timezone, timedelta
from contextlib import contextmanager

# Параметры подключения (читаются из env, воркер их выставляет).
_DSN = (
    f"host={os.environ.get('SAAS_DB_HOST','localhost')} "
    f"port={os.environ.get('SAAS_DB_PORT','5432')} "
    f"dbname={os.environ.get('SAAS_DB','saas')} "
    f"user={os.environ.get('SAAS_DB_USER','saas_app')} "
    f"password={os.environ.get('SAAS_DB_PASSWORD','')} "
)


def _cabinet_id() -> int:
    cid = os.environ.get("WB_SaaS_CABINET_ID")
    if not cid:
        raise RuntimeError("WB_SaaS_CABINET_ID не выставлен воркером")
    return int(cid)


# Конвертация ? → %s (psycopg3 использует %s). Именованные :x не трогаем
# (используем только позиционные %s в адаптере).
_QMARK = re.compile(r"(?<![%:])\?")


def _q(sql: str) -> str:
    """Конвертирует SQLite-style SQL с ? в PG-style с %s. :name оставляем как есть."""
    return _QMARK.sub("%s", sql)


@contextmanager
def get_connection():
    """Контекст-менеджер: открывает соединение, выставляет app.cabinet_id,
    отдаёт курсор с autocommit=False. На выходе — commit (как боевой with conn)."""
    conn = psycopg.connect(_DSN, autocommit=False, row_factory=dict_row)
    try:
        # app.cabinet_id — custom GUC. SET не принимает bind-параметры, но set_config()
        # (3-й аргумент true = local) принимает и работает в транзакции. RLS читает
        # current_setting('app.cabinet_id').
        conn.execute("SELECT set_config('app.cabinet_id', %s, true)", (str(_cabinet_id()),))
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init():
    """Схема создаётся SQL-миграцией 002_tenant_wb_tables.sql. Здесь — noop,
    чтобы сборщики (вызывающие db.init()) не падали."""
    pass


# =====================================================================
#  Универсальный upsert-хелпер (уменьшает дублирование).
# =====================================================================
def _upsert_row(table: str, pk_cols: list[str], data_cols: list[str],
                row: dict, coalesce_cols: list[str] | None = None):
    """INSERT ... ON CONFLICT(pk) DO UPDATE. cabinet_id добавляется автоматически.
    table без префикса tenant. (напр 'wb_articles')
    pk_cols — колонки PK БЕЗ cabinet_id (cabinet_id добавим сами).
    data_cols — вставляемые колонки БЕЗ cabinet_id.
    coalesce_cols — какие из data_cols обновлять через COALESCE(excluded, table.col)
    (чтобы None не затирал существующее значение).
    """
    cid = _cabinet_id()
    all_cols = ["cabinet_id"] + data_cols
    placeholders = ", ".join(["%s"] * len(all_cols))
    conflict_cols = ", ".join(["cabinet_id"] + pk_cols)
    upd_parts = []
    for c in data_cols:
        if coalesce_cols and c in coalesce_cols:
            upd_parts.append(f"{c} = COALESCE(EXCLUDED.{c}, {table}.{c})")
        else:
            upd_parts.append(f"{c} = EXCLUDED.{c}")
    upd_clause = ", ".join(upd_parts)
    sql = (
        f"INSERT INTO tenant.{table} ({', '.join(all_cols)}) "
        f"VALUES ({placeholders}) "
        f"ON CONFLICT ({conflict_cols}) DO UPDATE SET {upd_clause}"
    )
    vals = [cid] + [row.get(c) for c in data_cols]
    with get_connection() as conn:
        conn.execute(_q(sql), vals)


# =====================================================================
#  Articles (каталог)
# =====================================================================
def upsert_article(nm_id, name, brand=None, subject=None, im_url=None):
    _upsert_row(
        "wb_articles", ["nm_id"],
        ["nm_id", "name", "brand", "subject", "im_url"],
        {"nm_id": nm_id, "name": name, "brand": brand, "subject": subject, "im_url": im_url},
        coalesce_cols=["brand", "subject", "im_url"],
    )


def upsert_wb_barcodes_many(rows):
    """Штрихкоды карточек WB (Content API sizes[].skus) → tenant.wb_barcodes.
    Ключ /api/v3/stocks/{warehouseId} (FBS-остатки складов продавца)."""
    return _batch_upsert("wb_barcodes", ["barcode"], ["barcode", "nm_id", "chrt_id", "tech_size"], rows)


def replace_cards_glue(rows, now_iso):
    cid = _cabinet_id()
    with get_connection() as conn:
        conn.execute("DELETE FROM tenant.wb_cards_glue WHERE cabinet_id = %s", (cid,))
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO tenant.wb_cards_glue (cabinet_id, nm_id, imt_id, imt_nm_count, updated_at) "
                "VALUES (%s, %s, %s, %s, %s)",
                [(cid, r["nm_id"], r["imt_id"], r.get("imt_nm_count"), now_iso) for r in rows],
            )


# =====================================================================
#  Feedbacks / Questions (полные тексты + workflow)
# =====================================================================
def upsert_feedbacks(rows):
    if not rows:
        return 0
    cols = ["id", "marketplace", "nm_id", "imt_id", "rating", "text", "author",
            "created_at", "was_answered", "wb_answer", "product",
            "moderation_state", "is_hidden", "was_viewed"]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    with get_connection() as conn:
        for r in rows:
            vals = {c: r.get(c) for c in cols}
            if vals.get("text"):
                vals["text"] = str(vals["text"])[:4000]
            if vals.get("wb_answer"):
                vals["wb_answer"] = str(vals["wb_answer"])[:4000]
            if not vals.get("marketplace"):
                vals["marketplace"] = "wb"
            conn.execute(
                _q("""INSERT INTO tenant.wb_feedbacks (cabinet_id, id, marketplace, nm_id, imt_id,
                       rating, text, author, created_at, was_answered, wb_answer, product,
                       moderation_state, is_hidden, was_viewed, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT (cabinet_id, id) DO UPDATE SET
                     marketplace=EXCLUDED.marketplace, nm_id=EXCLUDED.nm_id, imt_id=EXCLUDED.imt_id,
                     rating=EXCLUDED.rating, text=EXCLUDED.text, author=EXCLUDED.author,
                     created_at=EXCLUDED.created_at, was_answered=EXCLUDED.was_answered,
                     wb_answer=EXCLUDED.wb_answer, product=EXCLUDED.product,
                     moderation_state=EXCLUDED.moderation_state, is_hidden=EXCLUDED.is_hidden,
                     was_viewed=EXCLUDED.was_viewed, updated_at=EXCLUDED.updated_at"""),
                [cid] + [vals.get(c) for c in cols] + [now],
            )
    return len(rows)


def upsert_questions(rows):
    if not rows:
        return 0
    cols = ["id", "marketplace", "nm_id", "imt_id", "text", "author", "created_at",
            "was_answered", "mp_answer", "answer_editable", "product",
            "moderation_state", "is_warned", "is_hidden", "was_viewed"]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    with get_connection() as conn:
        for r in rows:
            vals = {c: r.get(c) for c in cols}
            if not vals.get("marketplace"):
                vals["marketplace"] = "wb"
            conn.execute(
                _q("""INSERT INTO tenant.wb_questions (cabinet_id, id, marketplace, nm_id, imt_id, text,
                       author, created_at, was_answered, mp_answer, answer_editable, product,
                       moderation_state, is_warned, is_hidden, was_viewed, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT (cabinet_id, id) DO UPDATE SET
                     marketplace=EXCLUDED.marketplace, nm_id=EXCLUDED.nm_id, imt_id=EXCLUDED.imt_id,
                     text=EXCLUDED.text, author=EXCLUDED.author, created_at=EXCLUDED.created_at,
                     was_answered=EXCLUDED.was_answered, mp_answer=EXCLUDED.mp_answer,
                     answer_editable=EXCLUDED.answer_editable, product=EXCLUDED.product,
                     moderation_state=EXCLUDED.moderation_state, is_warned=EXCLUDED.is_warned,
                     is_hidden=EXCLUDED.is_hidden, was_viewed=EXCLUDED.was_viewed,
                     updated_at=EXCLUDED.updated_at"""),
                [cid] + [vals.get(c) for c in cols] + [now],
            )
    return len(rows)


# =====================================================================
#  Feedback summary / history
# =====================================================================
def upsert_feedback(scope, key_id, rating, feedbacks_count, now_iso):
    _upsert_row(
        "wb_feedback_summary", ["scope", "key_id"],
        ["scope", "key_id", "rating", "feedbacks_count", "updated_at"],
        {"scope": scope, "key_id": key_id, "rating": rating,
         "feedbacks_count": feedbacks_count, "updated_at": now_iso},
    )


def upsert_feedback_history(scope, key_id, date, rating, feedbacks_count):
    cid = _cabinet_id()
    with get_connection() as conn:
        conn.execute(
            _q("""INSERT INTO tenant.wb_feedback_history (cabinet_id, scope, key_id, date, rating, feedbacks_count)
                   VALUES (?,?,?,?,?,?)
                   ON CONFLICT (cabinet_id, scope, key_id, date) DO UPDATE SET
                     rating=EXCLUDED.rating, feedbacks_count=EXCLUDED.feedbacks_count"""),
            [cid, scope, key_id, date, rating, feedbacks_count],
        )


def upsert_item_keyword(nm_id, date, keyword, position, is_ad, traffic=None):
    cid = _cabinet_id()
    with get_connection() as conn:
        conn.execute(
            _q("""INSERT INTO tenant.wb_item_keywords (cabinet_id, nm_id, date, keyword, position, is_ad, traffic)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT (cabinet_id, nm_id, date, keyword) DO UPDATE SET
                     position=EXCLUDED.position, is_ad=EXCLUDED.is_ad, traffic=EXCLUDED.traffic"""),
            [cid, nm_id, date, keyword, position, is_ad, traffic],
        )


# =====================================================================
#  daily_metrics / metrics_30m / daily_ad (динамические поля через **fields)
# =====================================================================
_DM_COLS = {"orders", "clicks", "cart", "rating", "price", "spp", "ad_views",
            "ad_clicks", "ad_atbs", "ad_orders", "ad_spend"}


def upsert_daily(nm_id, date, **fields):
    cols = [c for c in _DM_COLS if c in fields]
    if not cols:
        return
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    all_cols = ["cabinet_id", "nm_id", "date"] + cols + ["updated_at"]
    vals = [cid, nm_id, date] + [fields[c] for c in cols] + [now]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols + ["updated_at"])
    with get_connection() as conn:
        conn.execute(
            f"INSERT INTO tenant.wb_daily_metrics ({', '.join(all_cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT (cabinet_id, nm_id, date) DO UPDATE SET {upd}",
            vals,
        )


_M30M_COLS = {"clicks", "cart", "orders", "order_sum", "favorites", "buyouts", "cancels"}


def upsert_metric_30m(nm_id, date, ts, **fields):
    cols = [c for c in _M30M_COLS if c in fields]
    if not cols:
        return
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    all_cols = ["cabinet_id", "nm_id", "date", "ts"] + cols + ["updated_at"]
    vals = [cid, nm_id, date, ts] + [fields[c] for c in cols] + [now]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols + ["updated_at"])
    with get_connection() as conn:
        conn.execute(
            f"INSERT INTO tenant.wb_metrics_30m ({', '.join(all_cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT (cabinet_id, nm_id, ts) DO UPDATE SET {upd}",
            vals,
        )


_AD_COLS = {"views", "clicks", "atbs", "orders", "spend"}


def cleanup_metrics_30m(days=60):
    """Удалить 30-минутные снапшоты старше `days` дней. Возвращает кол-во удалённых.

    datetime.now() здесь НАМЕРЕННО наивный (не timezone.utc), в отличие от
    updated_at в остальном файле: колонка `date` в wb_metrics_30m — не метка
    времени записи, а календарная бизнес-дата, и она сама пишется из наивного
    datetime.now() в worker/collectors/wb_metrics_30m.py (day_str). Если тут
    считать порог от UTC-времени, а колонку — от местного, у полуночи будет
    расхождение в дату и удержание в 60 дней станет то короче, то длиннее на
    несколько часов. Чтобы порог совпадал по смыслу с тем, что в колонке,
    оставляем ту же (наивную) шкалу времени с обеих сторон.
    """
    cid = _cabinet_id()
    with get_connection() as conn:
        cur = conn.execute(
            "DELETE FROM tenant.wb_metrics_30m WHERE cabinet_id=%s AND date < %s",
            (cid, (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")),
        )
        return cur.rowcount if hasattr(cur, "rowcount") else 0


def upsert_ad(nm_id, date, model, **fields):
    cols = [c for c in _AD_COLS if c in fields]
    if not cols:
        return
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    all_cols = ["cabinet_id", "nm_id", "date", "model"] + cols + ["updated_at"]
    vals = [cid, nm_id, date, model] + [fields[c] for c in cols] + [now]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols + ["updated_at"])
    with get_connection() as conn:
        conn.execute(
            f"INSERT INTO tenant.wb_daily_ad ({', '.join(all_cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT (cabinet_id, nm_id, date, model) DO UPDATE SET {upd}",
            vals,
        )


def get_metric_snapshots(from_ts, to_ts):
    cid = _cabinet_id()
    with get_connection() as conn:
        cur = conn.execute(
            "SELECT nm_id, date, ts, clicks, cart, orders, order_sum, favorites, buyouts, cancels "
            "FROM tenant.wb_metrics_30m WHERE cabinet_id=%s AND ts >= %s AND ts <= %s ORDER BY ts",
            (cid, from_ts, to_ts),
        )
        return [dict(r) for r in cur.fetchall()]


def get_metric_snapshots_range():
    cid = _cabinet_id()
    with get_connection() as conn:
        cur = conn.execute(
            "SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM tenant.wb_metrics_30m WHERE cabinet_id=%s",
            (cid,),
        )
        return dict(cur.fetchone() or {})


# =====================================================================
#  Batch upserts (finance, stock, orders, sales, order_costs, ...)
# =====================================================================
_FIN_COLS = ["rrd_id", "realizationreport_id", "date_from", "date_to", "rr_dt", "nm_id",
             "sa_name", "subject_name", "supplier_oper_name", "doc_type_name", "bonus_type_name",
             "quantity", "retail_price", "retail_amount", "retail_price_withdisc_rub", "ppvz_for_pay",
             "delivery_rub", "storage_fee", "penalty", "additional_payment", "deduction",
             "acceptance", "acquiring_fee", "ppvz_sales_commission", "ppvz_vw", "return_amount",
             "sale_percent", "commission_percent",
             "srid", "order_dt", "sale_dt"]


def upsert_finance_many(rows):
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    all_cols = ["cabinet_id"] + _FIN_COLS + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in _FIN_COLS + ["updated_at"])
    sql = (f"INSERT INTO tenant.wb_finance_report ({', '.join(all_cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT (cabinet_id, rrd_id) DO UPDATE SET {upd}")
    batch = [[cid] + [r.get(c) for c in _FIN_COLS] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, batch)
    return len(rows)


_STOCK_COLS = ["nm_id", "date", "warehouse", "warehouse_id", "quantity", "quantity_full", "in_way_to", "in_way_from"]
# warehouse_id добавлен (миграция 025): сборщик wb_stocks получает warehouseId
# из API, но раньше не сохранял. Нужен для надёжного маппинга stocks↔shared.wb_warehouses
# (по именам совпадение только 45%, по id — 84%+; кросс-чек 2026-07-18). Колонка
# NULLable — старые строки (до правки сборщика) остаются NULL, маппинг падает на имя.


def upsert_stock_many(rows):
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    all_cols = ["cabinet_id"] + _STOCK_COLS + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in _STOCK_COLS + ["updated_at"])
    sql = (f"INSERT INTO tenant.wb_daily_stock ({', '.join(all_cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT (cabinet_id, nm_id, date, warehouse) DO UPDATE SET {upd}")
    batch = [[cid] + [r.get(c) for c in _STOCK_COLS] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, batch)
    return len(rows)


def _batch_upsert(table, pk_cols, data_cols, rows):
    """Общий батч-upsert для таблиц с однородной структурой."""
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    all_cols = ["cabinet_id"] + data_cols + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    conflict = ", ".join(["cabinet_id"] + pk_cols)
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in data_cols + ["updated_at"])
    sql = (f"INSERT INTO tenant.{table} ({', '.join(all_cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT ({conflict}) DO UPDATE SET {upd}")
    batch = [[cid] + [r.get(c) for c in data_cols] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, batch)
    return len(rows)


def _conv(v):
    """Булевы → int 0/1 (как боевой db.py). None пропускает."""
    return int(v) if isinstance(v, bool) else v


def _upsert_raw(table, pk_col, mapping, rows):
    """Батч-upsert СЫРЫХ WB-записей по карте (колонка_БД, ключ_WB_API). cabinet_id
    добавляется автоматически в начало. Булевы → 0/1. Идемпотентно по (cabinet_id, pk)."""
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    data_cols = [c for c, _ in mapping] + ["updated_at"]
    all_cols = ["cabinet_id"] + data_cols
    placeholders = ", ".join(["%s"] * len(all_cols))
    conflict = f"cabinet_id, {pk_col}"
    upd_cols = [c for c in data_cols if c != pk_col]
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in upd_cols)
    sql = (f"INSERT INTO tenant.{table} (cabinet_id, {', '.join(data_cols)}) "
           f"VALUES ({placeholders}) ON CONFLICT ({conflict}) DO UPDATE SET {upd}")
    batch = [[cid] + [_conv(r.get(wb)) for _, wb in mapping] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, batch)
    return len(rows)


# Карты WB-API-key → DB-column (перенесены из боевого db.py для совместимости).
_ORDERS_MAP = [
    ("srid", "srid"), ("g_number", "gNumber"), ("order_dt", "date"),
    ("last_change_dt", "lastChangeDate"), ("nm_id", "nmId"),
    ("supplier_article", "supplierArticle"), ("barcode", "barcode"),
    ("tech_size", "techSize"), ("brand", "brand"), ("category", "category"),
    ("subject", "subject"), ("warehouse_name", "warehouseName"),
    ("warehouse_type", "warehouseType"), ("country_name", "countryName"),
    ("okrug_name", "oblastOkrugName"), ("region_name", "regionName"),
    ("income_id", "incomeID"), ("is_cancel", "isCancel"), ("cancel_dt", "cancelDate"),
    ("total_price", "totalPrice"), ("discount_percent", "discountPercent"),
    ("price_with_disc", "priceWithDisc"), ("finished_price", "finishedPrice"),
    ("spp", "spp"), ("sticker", "sticker"),
]
_SALES_MAP = [
    ("sale_id", "saleID"), ("srid", "srid"), ("sale_dt", "date"),
    ("last_change_dt", "lastChangeDate"), ("nm_id", "nmId"),
    ("supplier_article", "supplierArticle"), ("barcode", "barcode"),
    ("tech_size", "techSize"), ("brand", "brand"), ("category", "category"),
    ("subject", "subject"), ("warehouse_name", "warehouseName"),
    ("warehouse_type", "warehouseType"), ("country_name", "countryName"),
    ("okrug_name", "oblastOkrugName"), ("region_name", "regionName"),
    ("income_id", "incomeID"), ("is_realization", "isRealization"),
    ("total_price", "totalPrice"), ("discount_percent", "discountPercent"),
    ("price_with_disc", "priceWithDisc"), ("finished_price", "finishedPrice"),
    ("for_pay", "forPay"), ("payment_sale_amount", "paymentSaleAmount"), ("spp", "spp"),
]


_ORDERS_COLS = ["srid", "g_number", "order_dt", "last_change_dt", "nm_id", "supplier_article",
                "barcode", "tech_size", "brand", "category", "subject", "warehouse_name",
                "warehouse_type", "country_name", "okrug_name", "region_name", "income_id",
                "is_cancel", "cancel_dt", "total_price", "discount_percent", "price_with_disc",
                "finished_price", "spp", "sticker"]


def upsert_orders_many(rows):
    """Пакетно пишет СЫРЫЕ заказы (supplier/orders, ключи WB API). Маппинг → колонки."""
    return _upsert_raw("wb_orders", "srid", _ORDERS_MAP, rows)


_SALES_COLS = ["sale_id", "srid", "sale_dt", "last_change_dt", "nm_id", "supplier_article",
               "barcode", "tech_size", "brand", "category", "subject", "warehouse_name",
               "warehouse_type", "country_name", "okrug_name", "region_name", "income_id",
               "is_realization", "total_price", "discount_percent", "price_with_disc",
               "finished_price", "for_pay", "payment_sale_amount", "spp"]


def upsert_sales_many(rows):
    """Пакетно пишет СЫРЫЕ продажи/возвраты (supplier/sales, ключи WB API)."""
    return _upsert_raw("wb_sales", "sale_id", _SALES_MAP, rows)


_OC_COLS = ["srid", "nm_id", "sa_name", "is_return", "return_dt", "self_buyout", "order_dt",
            "sale_dt", "cost_value_total", "cost_value_retail", "cost_value_pay", "commission",
            "acquiring", "logistics", "loyalty", "cost", "profit", "profit_alt", "qty"]


def upsert_order_costs_many(rows):
    return _batch_upsert("wb_order_costs", ["srid"], _OC_COLS, rows)


# =====================================================================
#  cogs / prices / per_sku / cabinet_costs
# =====================================================================
def upsert_cogs(nm_id, cost):
    cid = _cabinet_id()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_connection() as conn:
        conn.execute(
            _q("""INSERT INTO tenant.wb_cogs (cabinet_id, nm_id, cost, updated_at)
                   VALUES (?,?,?,?)
                   ON CONFLICT (cabinet_id, nm_id) DO UPDATE SET cost=EXCLUDED.cost, updated_at=EXCLUDED.updated_at"""),
            [cid, nm_id, cost, now],
        )


_PRICES_COLS = ["nm_id", "price_seller", "discount", "price_buyer", "spp_auto"]
# Fallback без price_buyer — если миграция 028 ещё не применена (нет owner-прав),
# чтобы НЕ сломать запись всех цен WB. После применения 028 эта ветка не нужна.
_PRICES_COLS_LEGACY = ["nm_id", "price_seller", "discount", "spp_auto"]


def upsert_prices_many(rows):
    try:
        return _batch_upsert("wb_prices", ["nm_id"], _PRICES_COLS, rows)
    except Exception as e:
        # Колонки price_buyer нет → повтор без неё (старая схема).
        if "price_buyer" in str(e):
            legacy_rows = [{k: v for k, v in r.items() if k != "price_buyer"} for r in rows]
            return _batch_upsert("wb_prices", ["nm_id"], _PRICES_COLS_LEGACY, legacy_rows)
        raise


_OZON_PRICES_COLS = ["product_id", "date", "price", "old_price",
                     "marketing_seller_price", "marketing_price", "min_price"]


def upsert_ozon_prices_many(rows):
    """Дневной снимок цен Ozon → соинвест (миграция 030, спек 2026-08-02).
    PK (cabinet_id, product_id, date): повтор в тот же день перезаписывает."""
    return _batch_upsert("ozon_prices", ["product_id", "date"], _OZON_PRICES_COLS, rows)


def update_site_prices_many(rows):
    """Реальная цена сайта (card.wb.ru, миграция 029) — ОТДЕЛЬНЫЙ UPDATE,
    не upsert: сбой публичного API не должен затирать вчерашние price_site
    NULL'ами (урок аудита 2026-08: «затирание хорошего плохим»). Обновляем
    только пришедшие nm_id; price_site_at показывает свежесть снимка.
    rows: [{nm_id, price_site}]."""
    if not rows:
        return 0
    cid = _cabinet_id()
    sql = ("UPDATE tenant.wb_prices SET price_site = %s, price_site_at = now() "
           "WHERE cabinet_id = %s AND nm_id = %s")
    batch = [[r["price_site"], cid, r["nm_id"]] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, batch)
    return len(rows)


_PSKU_COLS = ["nm_id", "period_from", "period_to", "penalty", "logistics_correction",
              "loyalty_correction", "voluntary_comp", "other"]


def upsert_per_sku_costs_many(rows):
    return _batch_upsert("wb_per_sku_costs", ["nm_id", "period_from", "period_to"], _PSKU_COLS, rows)


_CAB_COLS = ["cost_type", "period_from", "period_to", "amount", "detail"]


def upsert_cabinet_costs_many(rows):
    return _batch_upsert("wb_cabinet_costs", ["cost_type", "period_from", "period_to"], _CAB_COLS, rows)


def replace_cabinet_costs_range(rows, start, end):
    """Переписать кабинетные расходы за период: сначала удалить, потом вставить.

    Один upsert недостаточен: если правила разнесения по типам поменялись (или
    строка в отчёте исчезла), старая запись с прежним cost_type останется висеть
    и будет учтена повторно. Сборщик всегда пересчитывает период целиком из
    finance_report, поэтому «удалить и записать заново» — единственный способ
    получить состояние, точно равное источнику. Обе операции в одной транзакции:
    период не должен оставаться пустым, если вставка не удалась.
    """
    cid = _cabinet_id()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    all_cols = ["cabinet_id"] + _CAB_COLS + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    sql = (f"INSERT INTO tenant.wb_cabinet_costs ({', '.join(all_cols)}) "
           f"VALUES ({placeholders})")
    batch = [[cid] + [r.get(c) for c in _CAB_COLS] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            # Удаляем по ПЕРЕСЕЧЕНИЮ с окном, а не по вложенности: читатель
            # (/api/cabinets/[id]/cabinet-costs) тоже берёт строки по пересечению,
            # и легаси-строка с многодневным периодом, задевающая край окна,
            # пережила бы перезапись и задвоилась бы с дневными.
            cur.execute(
                "DELETE FROM tenant.wb_cabinet_costs "
                "WHERE cabinet_id = %s AND period_from <= %s AND period_to >= %s",
                (cid, end, start),
            )
            if batch:
                cur.executemany(sql, batch)
    return len(rows)


# =====================================================================
#  «Портрет покупателя» (подписка «Джем» WB, миграция 027, с 2026-07-19).
#  Колонки сверены живым probe'ом на cabinet #1 — это реальные поля ответа
#  WB API (дока расходится с реальностью, грабля #18/#57).
# =====================================================================
_JEM_SEARCH_COLS = ["nm_id", "date", "keyword", "freq", "week_freq",
                    "avg_position", "median_position", "open_card", "add_to_cart",
                    "open_to_cart", "orders", "cart_to_order", "visibility",
                    "open_card_pct", "orders_pct"]


def upsert_jem_search_many(rows):
    """Batch-upsert поисковых запросов (источник: /search-report/product/search-texts).
    PK = (nm_id, date, keyword)."""
    return _batch_upsert("wb_search_queries", ["nm_id", "date", "keyword"], _JEM_SEARCH_COLS, rows)


_JEM_FUNNEL_COLS = ["nm_id", "date", "avg_position", "visibility", "open_card",
                    "add_to_cart", "open_to_cart", "orders", "cart_to_order"]


def upsert_jem_funnel_many(rows):
    """Batch-upsert воронки конверсий (источник: /search-report/report).
    PK = (nm_id, date)."""
    return _batch_upsert("wb_funnel_daily", ["nm_id", "date"], _JEM_FUNNEL_COLS, rows)


# =====================================================================
#  fetch-функции (для чтения; RLS фильтрует по cabinet_id автоматически)
# =====================================================================
def query(sql, params=()):
    # ⚠️ НЕ применяем _q() здесь: SQL от вызывающего уже в PG-стиле (%s).
    # _q() нужен только для боевых upsert с ?-плейсхолдерами. Здесь же caller
    # пишет %s сам (и LIKE '%%...%%' для литеральных %).
    with get_connection() as conn:
        cur = conn.execute(sql, list(params))
        return [dict(r) for r in cur.fetchall()]


def active_nm_ids() -> list:
    rows = query("SELECT nm_id FROM tenant.wb_articles")
    return [r["nm_id"] for r in rows]


def imt_of(nm_id):
    rows = query("SELECT imt_id FROM tenant.wb_cards_glue WHERE nm_id = %s", (nm_id,))
    return rows[0]["imt_id"] if rows else None


def fetch_order_costs(nm_id=None, date_from=None, date_to=None):
    sql = "SELECT * FROM tenant.wb_order_costs WHERE 1=1"
    params = []
    if nm_id is not None:
        sql += " AND nm_id = %s"; params.append(nm_id)
    if date_from:
        sql += " AND sale_dt >= %s"; params.append(date_from)
    if date_to:
        sql += " AND sale_dt <= %s"; params.append(date_to)
    return query(sql, params)


def fetch_article_warehouses(nm_id):
    return [r["warehouse"] for r in query(
        "SELECT DISTINCT warehouse FROM tenant.wb_daily_stock WHERE nm_id = %s", (nm_id,))]


def fetch_stock(nm_id, date):
    rows = query("SELECT SUM(quantity) AS q FROM tenant.wb_daily_stock WHERE nm_id=%s AND date=%s",
                 (nm_id, date))
    return {"quantity": rows[0]["q"] if rows else 0}


def fetch_prices_db():
    return query("SELECT * FROM tenant.wb_prices")


def fetch_daily(nm_id=None, date_from=None, date_to=None):
    sql = "SELECT * FROM tenant.wb_daily_metrics WHERE 1=1"
    params = []
    if nm_id is not None:
        sql += " AND nm_id = %s"; params.append(nm_id)
    if date_from:
        sql += " AND date >= %s"; params.append(date_from)
    if date_to:
        sql += " AND date <= %s"; params.append(date_to)
    return query(sql, params)


def fetch_per_sku_costs(date_from=None, date_to=None):
    sql = "SELECT * FROM tenant.wb_per_sku_costs WHERE 1=1"
    params = []
    if date_from:
        sql += " AND period_from >= %s"; params.append(date_from)
    if date_to:
        sql += " AND period_to <= %s"; params.append(date_to)
    return query(sql, params)


def fetch_cabinet_costs(date_from=None, date_to=None):
    sql = "SELECT * FROM tenant.wb_cabinet_costs WHERE 1=1"
    params = []
    if date_from:
        sql += " AND period_from >= %s"; params.append(date_from)
    if date_to:
        sql += " AND period_to <= %s"; params.append(date_to)
    return query(sql, params)


def compact_redundant_weekly_costs():
    """Перенос gotcha #142: удаляем недельные строки cabinet/per_sku, полностью
    покрытые дневными с тем же итогом (после миграции на дневную гранулярность)."""
    cid = _cabinet_id()
    with get_connection() as conn:
        # cabinet_costs: недельные (period_from <> period_to), где есть дневные с тем же итогом
        conn.execute(
            """DELETE FROM tenant.wb_cabinet_costs a
               WHERE a.cabinet_id = %s
                 AND a.period_from <> a.period_to
                 AND EXISTS (
                   SELECT 1 FROM tenant.wb_cabinet_costs b
                   WHERE b.cabinet_id = %s AND b.period_from = b.period_to
                     AND b.period_from >= a.period_from AND b.period_from <= a.period_to
                     AND b.cost_type = a.cost_type
                 )""",
            (cid, cid),
        )


# =====================================================================
#  OZON — upsert-функции для tenant.ozon_*
#  PK составной у orders/sales/finance (posting+product / posting+operation).
# =====================================================================

def _upsert_raw_multi_pk(table, pk_cols, mapping, rows, bool_cols=None):
    """Батч-upsert СЫРЫХ строк по карте (колонка_БД, ключ_источника) с СОСТАВНЫМ pk.
    cabinet_id добавляется автоматически. Булевы → 0/1 (_conv), кроме колонок из
    bool_cols — для них значение остаётся настоящим Python bool (psycopg сам
    адаптирует его в boolean); нужно для таблиц, где колонка BOOLEAN, а не
    legacy INTEGER, см. tenant.wb_supplies.done. ::boolean-каст параметра НЕ
    спасает: psycopg биндит маленькие int как smallint, а smallint→boolean
    каста в Postgres нет (только int4→boolean)."""
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    bool_cols = set(bool_cols or ())
    data_cols = [c for c, _ in mapping] + ["updated_at"]
    all_cols = ["cabinet_id"] + data_cols
    placeholders = ", ".join(["%s"] * len(all_cols))
    conflict = ", ".join(["cabinet_id"] + pk_cols)
    upd_cols = [c for c in data_cols if c not in pk_cols]
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in upd_cols)
    sql = (f"INSERT INTO tenant.{table} (cabinet_id, {', '.join(data_cols)}) "
           f"VALUES ({placeholders}) ON CONFLICT ({conflict}) DO UPDATE SET {upd}")

    def _conv_col(c, v):
        if c in bool_cols:
            # колонка NOT NULL BOOLEAN — None от API превращаем в False,
            # а не пробрасываем дальше (иначе upsert падает на constraint).
            return False if v is None else bool(v)
        return _conv(v)

    batch = [[cid] + [_conv_col(c, r.get(src)) for c, src in mapping] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, batch)
    return len(rows)


# --- products (каталог Ozon) ---
_OZ_PRODUCT_COLS = ["product_id", "offer_id", "name", "barcode", "fbo_sku", "category",
                    "brand", "visibility", "commission_pct", "weight", "length", "width",
                    "height", "volume_weight", "logistics_fbo_tariff", "last_mile_pct",
                    "vat", "price", "old_price", "im_url", "description_category_id", "type_name"]


def upsert_product(product_id, name, **fields):
    """Регистрация/обновление товара Ozon. fields — опциональные колонки из _OZ_PRODUCT_COLS."""
    cid = _cabinet_id()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    row = {"product_id": product_id, "name": name}
    for c in _OZ_PRODUCT_COLS:
        if c in fields:
            row[c] = fields[c]
    data_cols = list(row.keys())
    all_cols = ["cabinet_id"] + data_cols + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=COALESCE(EXCLUDED.{c}, tenant.ozon_products.{c})" if c == "name" else f"{c}=EXCLUDED.{c}"
                    for c in data_cols + ["updated_at"])
    vals = [cid] + [row.get(c) for c in data_cols] + [now]
    with get_connection() as conn:
        conn.execute(
            f"INSERT INTO tenant.ozon_products ({', '.join(all_cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT (cabinet_id, product_id) DO UPDATE SET {upd}",
            vals,
        )


def active_ozon_product_ids() -> list:
    return [r["product_id"] for r in query("SELECT product_id FROM tenant.ozon_products")]


# --- orders / sales (постинги Ozon) ---
_OZ_ORDERS_MAP = [
    ("posting_number", "posting_number"), ("product_id", "product_id"),
    ("offer_id", "offer_id"), ("order_dt", "order_dt"),
    ("last_change_dt", "last_change_dt"), ("in_process_at", "in_process_at"),
    ("status", "status"), ("is_cancel", "is_cancel"), ("cancel_dt", "cancel_dt"),
    ("qty", "qty"), ("price", "price"), ("total", "total"),
    ("warehouse", "warehouse"), ("region", "region"), ("size", "size"),
    # география 2.0 (047): delivered_dt сознательно отсутствует —
    # её заполняет update_ozon_delivered_dt() из начислений.
    ("scheme", "scheme"), ("warehouse_id", "warehouse_id"),
    ("delivery_type", "delivery_type"), ("shipment_dt", "shipment_dt"),
]
_OZ_SALES_MAP = [
    ("posting_number", "posting_number"), ("product_id", "product_id"),
    ("offer_id", "offer_id"), ("sale_dt", "sale_dt"),
    ("last_change_dt", "last_change_dt"), ("status", "status"),
    ("is_return", "is_return"), ("qty", "qty"), ("price", "price"),
    ("revenue", "revenue"), ("payout_amount", "payout_amount"),
    ("scheme", "scheme"),  # география 2.0 (047)
]


def upsert_ozon_orders_many(rows):
    return _upsert_raw_multi_pk("ozon_orders", ["posting_number", "product_id"], _OZ_ORDERS_MAP, rows)


def upsert_ozon_sales_many(rows):
    return _upsert_raw_multi_pk("ozon_sales", ["posting_number", "product_id"], _OZ_SALES_MAP, rows)


# --- wb_supplies (поставки WB FBS, marketplace-api /api/v3/supplies) ---
_WB_SUPPLIES_MAP = [
    ("supply_id", "id"), ("name", "name"), ("created_at", "createdAt"),
    ("closed_at", "closedAt"), ("scan_dt", "scanDt"), ("reject_dt", "rejectDt"),
    ("done", "done"), ("cargo_type", "cargoType"),
    ("destination_office_id", "destinationOfficeId"),
]


def upsert_wb_supplies_many(rows):
    """Поставки WB FBS (marketplace-api /api/v3/supplies). ISO-строки дат
    кастуются в TIMESTAMPTZ самим Postgres. done — настоящий BOOLEAN (не legacy
    INTEGER, как is_cancel/is_return у Ozon) — bool_cols кастует явно, иначе
    Postgres роняет upsert (integer→boolean без explicit cast не работает)."""
    return _upsert_raw_multi_pk("wb_supplies", ["supply_id"], _WB_SUPPLIES_MAP, rows,
                                 bool_cols=["done"])


# --- wb_fbs_tasks (FBS-задания WB, marketplace-api /api/v3/orders) ---
_WB_FBS_TASKS_MAP = [
    ("rid", "rid"), ("supply_id", "supplyId"),
    ("created_at", "createdAt"), ("nm_id", "nmId"),
    ("order_id", "id"),   # ключ POST /api/v3/orders/status (миграция 051)
]

# Финальные wbStatus задания — дальше не опрашиваем (миграция 051, wb_fbs_status).
WB_FBS_FINAL_STATUSES = ("sold", "canceled", "canceled_by_client", "declined_by_client", "defect")


def upsert_wb_fbs_tasks_many(rows):
    """FBS-задания WB (marketplace-api /api/v3/orders): связка rid↔supply_id.
    Колонки статуса (wb_status/wb_status_at/pvz_at) в карте НЕТ намеренно —
    upsert ленты их не затирает, ими владеет apply_wb_fbs_statuses."""
    return _upsert_raw_multi_pk("wb_fbs_tasks", ["rid"], _WB_FBS_TASKS_MAP, rows)


# --- mp_seller_warehouses (склады продавца WB/Ozon, план «Склады 2.0», этап 1) ---
def upsert_mp_seller_warehouses(platform, rows):
    """rows: [{warehouse_id, name, kind}]. Присутствующие → is_active=true,
    last_seen_at=now(); отсутствующие в ответе МП склады той же платформы → is_active=false
    (склад удалён/скрыт в кабинете). first_seen_at не затирается.
    Пустой rows ничего не пишет (защита от пустого/сдвинутого по форме ответа МП —
    иначе деактивация ниже снесла бы весь справочник платформы; ревью задачи 5,
    2026-09-06). Основной барьер — в самих сборщиках (ПРОПУСК до вызова), это —
    defence in depth на случай прямого вызова с пустым rows."""
    if not rows:
        return 0
    cid = _cabinet_id()
    ids = [int(r["warehouse_id"]) for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO tenant.mp_seller_warehouses "
                "(cabinet_id, platform, warehouse_id, name, kind, is_active, last_seen_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, true, now(), now()) "
                "ON CONFLICT (cabinet_id, platform, warehouse_id) DO UPDATE SET "
                "name=EXCLUDED.name, kind=EXCLUDED.kind, is_active=true, last_seen_at=now(), updated_at=now()",
                [[cid, platform, int(r["warehouse_id"]), r.get("name") or str(r["warehouse_id"]), r.get("kind")]
                 for r in rows])
            cur.execute(
                "UPDATE tenant.mp_seller_warehouses SET is_active=false, updated_at=now() "
                "WHERE cabinet_id=%s AND platform=%s AND is_active AND NOT (warehouse_id = ANY(%s))",
                (cid, platform, ids))
    return len(rows)


def seller_warehouse_ids(platform):
    rows = query("SELECT warehouse_id FROM tenant.mp_seller_warehouses "
                 "WHERE platform=%s AND is_active ORDER BY warehouse_id", (platform,))
    return [int(r["warehouse_id"]) for r in rows]


# --- mp_fbs_daily_stock (FBS-остатки складов продавца, план «Склады 2.0», этап 1) ---
_MP_FBS_STOCK_COLS = ["platform", "warehouse_id", "sku_key", "date", "present", "reserved"]


def upsert_mp_fbs_stock_many(rows):
    return _batch_upsert("mp_fbs_daily_stock", ["platform", "warehouse_id", "sku_key", "date"],
                         _MP_FBS_STOCK_COLS, rows)


def wb_barcode_map():
    """штрихкод → nm_id: карточки (wb_barcodes) ∪ заказы (wb_orders.barcode, на случай
    карточек без размеров). Карточки приоритетнее."""
    m = {}
    for r in query("SELECT DISTINCT barcode, nm_id FROM tenant.wb_orders "
                   "WHERE barcode IS NOT NULL AND nm_id IS NOT NULL"):
        m[str(r["barcode"])] = int(r["nm_id"])
    for r in query("SELECT barcode, nm_id FROM tenant.wb_barcodes"):
        m[str(r["barcode"])] = int(r["nm_id"])
    return m


def mp_fbs_stock_today(platform, date):
    """(warehouse_id, sku_key) → present за дату — для SAAS_PROBE=verify."""
    return {(int(r["warehouse_id"]), int(r["sku_key"])): r["present"]
            for r in query("SELECT warehouse_id, sku_key, present FROM tenant.mp_fbs_daily_stock "
                           "WHERE platform=%s AND date=%s", (platform, date))}


def wb_fbs_open_order_ids():
    """order_id заданий, у которых статус ещё может измениться (нет статуса
    или не финальный). Их и опрашивает часовой wb_fbs_status."""
    rows = query(
        "SELECT order_id FROM tenant.wb_fbs_tasks "
        "WHERE order_id IS NOT NULL AND (wb_status IS NULL OR NOT (wb_status = ANY(%s))) "
        "ORDER BY order_id",
        (list(WB_FBS_FINAL_STATUSES),))
    return [r["order_id"] for r in rows]


def apply_wb_fbs_statuses(pairs):
    """pairs: [(order_id, wbStatus)]. Переход waiting|sorted → ready_for_pickup
    ставит pvz_at = now() (один раз). Первое наблюдение (wb_status IS NULL)
    pvz_at НЕ ставит: задание могло лежать на ПВЗ давно — честный NULL.
    Все SET-выражения Postgres вычисляет над СТАРОЙ строкой, поэтому wb_status
    в CASE — прежний статус. Возвращает число заданий, у которых появился pvz_at."""
    if not pairs:
        return 0
    sql = (
        "UPDATE tenant.wb_fbs_tasks SET "
        "  pvz_at = CASE WHEN pvz_at IS NULL AND %(st)s = 'ready_for_pickup' "
        "                     AND wb_status IN ('waiting', 'sorted') THEN now() ELSE pvz_at END, "
        "  wb_status_at = CASE WHEN wb_status IS DISTINCT FROM %(st)s THEN now() ELSE wb_status_at END, "
        "  wb_status = %(st)s, updated_at = now() "
        "WHERE order_id = %(oid)s "
        "RETURNING (pvz_at = now()) AS arrived"  # now() стабилен в транзакции: = «поставлен этим опросом»
    )
    arrived = 0
    with get_connection() as conn:
        with conn.cursor() as cur:
            for oid, st in pairs:
                cur.execute(sql, {"oid": oid, "st": st})
                r = cur.fetchone()
                if r and r["arrived"]:
                    arrived += 1
    return arrived


# --- finance_report (/v3/finance/transaction/list) ---
_OZ_FIN_COLS = ["posting_id", "operation_id", "operation_type_name", "operation_type_id",
                "operation_dt", "product_id", "item_spp", "item_category_name", "item_offer_id",
                "item_name", "item_qty", "item_price", "sale_amount", "accruals_for_sale",
                "commission_amount", "payout_amount", "services_amount"]


def upsert_ozon_finance_many(rows):
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    all_cols = ["cabinet_id"] + _OZ_FIN_COLS + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in _OZ_FIN_COLS + ["updated_at"])
    sql = (f"INSERT INTO tenant.ozon_finance_report ({', '.join(all_cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT (cabinet_id, posting_id, operation_id) DO UPDATE SET {upd}")
    batch = [[cid] + [r.get(c) for c in _OZ_FIN_COLS] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, batch)
    return len(rows)


# --- accruals (/v1/finance/accrual/by-day, метод начислений — задача 3
#     плана «переезд финансов Ozon на методы начислений», 2026-08-11) ---
_OZ_ACCRUALS_COLS = ["accrual_id", "line_no", "date", "unit_number", "accrued_category",
                     "type_id", "sku", "quantity", "accrued", "seller_price",
                     "sale_price", "sale_commission", "coinvestment", "bonus"]


def upsert_ozon_accruals_many(rows):
    """Batch-upsert строк начислений в tenant.ozon_accruals.
    Ключ конфликта — (cabinet_id, accrual_id, line_no): один accrual_id может
    состоять из нескольких строк (услуги доставки + комиссия / несколько
    элементов item_fees.fees[]), line_no различает их внутри записи.

    Ревью fixwave (F3, .superpowers/sdd/2026-08-11-ozon-accrual-migration/):
    обычный ON CONFLICT DO UPDATE (как в _batch_upsert) только обновляет/
    добавляет строки — если при пересборе число строк записи СТАЛО МЕНЬШЕ
    (Ozon изменил состав услуг), хвостовые line_no от прошлого разбора
    остаются строками-призраками, ничем не перезаписанными. Поэтому перед
    вставкой удаляем все существующие строки пересобираемых accrual_id (в
    рамках кабинета), затем вставляем заново — DELETE и INSERT в ОДНОЙ
    транзакции (get_connection коммитит один раз при выходе из `with`),
    чтобы сбой между ними не оставил дыру в данных."""
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    accrual_ids = sorted({r["accrual_id"] for r in rows if r.get("accrual_id") is not None})
    all_cols = ["cabinet_id"] + _OZ_ACCRUALS_COLS + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in _OZ_ACCRUALS_COLS + ["updated_at"])
    sql = (f"INSERT INTO tenant.ozon_accruals ({', '.join(all_cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT (cabinet_id, accrual_id, line_no) DO UPDATE SET {upd}")
    batch = [[cid] + [r.get(c) for c in _OZ_ACCRUALS_COLS] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            if accrual_ids:
                cur.execute(
                    "DELETE FROM tenant.ozon_accruals WHERE cabinet_id = %s AND accrual_id = ANY(%s)",
                    [cid, accrual_ids],
                )
            cur.executemany(sql, batch)
    return len(rows)


def update_ozon_delivered_dt(date_from=None):
    """ozon_orders.delivered_dt := MIN(date) начислений «последней мили» по unit_number
    (type_id: 28 LastMile, 29 LastMileCourier «Доставка до места выдачи»,
    30 LastMilePickUpPoint «Выдача товара»). Семантика сверена с живым API 28.08.2026:
    у постинга 77388497-0210-2 тип 29 датирован 2026-08-22 — день в день с
    OperationAgentDeliveredToCustomer из /v3/finance/transaction/list.
    Вне _OZ_ORDERS_MAP сознательно: upsert заказов не должен затирать дату NULL-ом.

    date_from сужает только ОТБОР затронутых юнитов (плановый прогон видит начисление
    последней мили в окне date_from..) — сам MIN(date) считается по ВСЕЙ истории
    начислений юнита, а не только внутри окна. Иначе при повторном прогоне (юнит
    уже сузился до конкретной даты в прошлом, а окно захватывает только более
    позднее начисление того же unit_number — например, задвоенный/скорректированный
    начисление) MIN внутри окна может оказаться ПОЗЖЕ настоящей ранней даты и
    затереть уже верное delivered_dt более поздним значением. None — вся история,
    отбор не нужен (подзапрос упрощается).

    Задача 0 этапа 2 (жалоба 05.09.2026 «за вчера 0 продаж»): вторым UPDATE
    в той же транзакции и по той же выборке d передатирует tenant.ozon_sales.
    sale_dt писался как in_process_at (дата СОЗДАНИЯ заказа) — доставленная
    вчера продажа могла быть датирована днём заказа тремя днями раньше, и
    окно «вчера» по продажам Ozon почти всегда оказывалось пустым (у WB
    sale_dt изначально из statistics-api — уже дата продажи). Возвращаемый
    rowcount — сумма по обоим UPDATE (заказы + продажи); вызывающий код
    (ozon_accruals.collect()) использует его только для лога."""
    if date_from:
        cond = """
                       AND unit_number IN (
                           SELECT unit_number FROM tenant.ozon_accruals
                            WHERE type_id IN (28, 29, 30)
                              AND unit_number IS NOT NULL AND unit_number <> ''
                              AND date >= %s
                       )"""
    else:
        cond = ""
    sql_orders = f"""
            UPDATE tenant.ozon_orders o
               SET delivered_dt = d.dt, updated_at = now()
              FROM (SELECT unit_number, MIN(date)::text AS dt
                      FROM tenant.ozon_accruals
                     WHERE type_id IN (28, 29, 30)
                       AND unit_number IS NOT NULL AND unit_number <> ''
                       {cond}
                     GROUP BY unit_number) d
             WHERE o.posting_number = d.unit_number
               AND o.delivered_dt IS DISTINCT FROM d.dt
        """
    # Продажи датируем выкупом (жалоба 05.09.2026: «за вчера 0 продаж» — sale_dt
    # был датой создания заказа). Только delivered-строки; возвраты (cancelled)
    # остаются на своей дате. Формат TEXT 'YYYY-MM-DD' совместим с потребителями
    # (везде substr(sale_dt,1,10)). Σ revenue не меняется — только распределение
    # по дням (сторож в Step 3).
    sql_sales = f"""
        UPDATE tenant.ozon_sales s
           SET sale_dt = d.dt, updated_at = now()
          FROM (SELECT unit_number, MIN(date)::text AS dt
                  FROM tenant.ozon_accruals
                 WHERE type_id IN (28, 29, 30)
                   AND unit_number IS NOT NULL AND unit_number <> ''
                   {cond}
                 GROUP BY unit_number) d
         WHERE s.posting_number = d.unit_number
           AND s.is_return = 0
           AND substr(s.sale_dt, 1, 10) IS DISTINCT FROM d.dt
    """
    params = [date_from] if date_from else []
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql_orders, params)
            n_orders = cur.rowcount
            cur.execute(sql_sales, params)
            n_sales = cur.rowcount
            return n_orders + n_sales


# --- daily_stock (остатки FBO) ---
_OZ_STOCK_COLS = ["product_id", "date", "warehouse", "fbo_present", "fbo_reserved", "fbo_defect"]


def upsert_ozon_stock_many(rows):
    return _batch_upsert("ozon_daily_stock", ["product_id", "date", "warehouse"], _OZ_STOCK_COLS, rows)


# --- daily_campaign_ad (реклама Ozon в разрезе кампаний, Performance API) ---
# Уровень источника — кампания × день (товарного разреза в /statistics/daily
# нет), см. db/migrations/039_ozon_campaign_ad.sql.
_OZ_CAMPAIGN_AD_COLS = ["campaign_id", "date", "campaign_name", "views", "clicks",
                        "spend", "orders", "orders_sum"]


def upsert_ozon_campaign_ad_many(rows):
    return _batch_upsert("ozon_daily_campaign_ad", ["campaign_id", "date"], _OZ_CAMPAIGN_AD_COLS, rows)


# --- order_costs (прибыль по заказу Ozon) ---
# src_unit_number — задача 3 плана «ремонт данных прибыли Ozon» (миграция 042,
# db/migrations/042_ozon_order_costs_src_unit.sql): исходный (сырой)
# unit_number начислений, ДО резолва в posting_number (см. docstring
# build_order_costs). Аддитивно — контракт остальных колонок панели не
# меняется, роуты панели о ней не знают.
_OZ_OC_COLS = ["posting_number", "src_unit_number", "product_id", "size", "is_return", "order_dt",
               "sale_dt", "return_dt", "cost_value_retail", "commission", "acquiring", "logistics",
               "services", "loyalty", "cost", "qty", "profit", "self_buyout"]

# Белый список коротких имён таблиц (без "tenant."), в которые допустимо писать
# order_costs — задача 3 плана «переезд финансов Ozon на методы начислений»
# (--target-table сборщика: боевая таблица либо теневая для пересчёта
# истории). Имя таблицы подставляется в SQL f-строкой ТОЛЬКО после проверки
# принадлежности этому множеству — никакая внешняя строка сюда не попадает.
_OZ_OC_ALLOWED_TABLES = {"ozon_order_costs", "ozon_order_costs_shadow"}


def _order_costs_delete_keys(rows, extra_keys=None):
    """Чистая функция (без БД) — множество ключей DELETE для
    upsert_ozon_order_costs_many: posting_number всех вставляемых строк
    ОБЪЕДИНЁННЫЙ с extra_keys (исходные unit_number ВСЕХ пересобираемых в
    этом прогоне юнитов — см. докстроку upsert_ozon_order_costs_many, I3
    фикс-волны финального ревью задачи «переезд финансов Ozon на методы
    начислений»). Вынесена отдельно ради юнит-теста без БД
    (scripts/check-ozon-profit-calc.py)."""
    keys = {r["posting_number"] for r in rows if r.get("posting_number")}
    if extra_keys:
        keys |= set(extra_keys)
    return sorted(keys)


def _order_costs_delete_unit_keys(extra_keys=None):
    """Чистая функция (без БД) — множество src_unit_number для ВТОРОГО
    условия DELETE в upsert_ozon_order_costs_many (I4, находка задачи 6
    плана «ремонт данных прибыли Ozon», task-6-report.md: 20 задвоенных
    постингов кабинета 1 после подмены).

    I3 (см. _order_costs_delete_keys) страхует ТОЛЬКО переход «юнит
    записан под сырым unit_number (fallback, meta не нашлась) -> в этом
    прогоне резолвится в posting_number» — extra_keys (сырой unit_number)
    сам оказывается ключом DELETE. Но posting_number юнита может смениться
    и МЕЖДУ ДВУМЯ УЖЕ РЕЗОЛВЛЕННЫМИ формами: resolve_meta() резолвит его
    против ЖИВОЙ tenant.ozon_orders на каждом прогоне без фиксации снимка
    — если на одном прогоне точного совпадения ещё не было и юнит
    резолвился уникальным base-кандидатом (суффиксная форма, например
    "0115022887-0449-5"), а на следующем прогоне (после того как
    ozon_orders догнал точное совпадение) резолвится буквально
    ("0115022887-0449"), НИ posting_number этого прогона, НИ сырой
    unit_number (extra_keys) не совпадают со СТАРЫМ суффиксным
    posting_number — I3-ключи его не ловят, старая строка осиротевает,
    двойной счёт денег одного и того же начисления.

    Закрывается ВТОРЫМ условием DELETE — по src_unit_number, а не
    posting_number: build_order_costs пишет в src_unit_number ИСХОДНЫЙ
    (сырой) unit_number буквально, независимо от того, как резолвился
    posting_number (см. докстроку колонки в ozon_order_costs.py) — поэтому
    ЛЮБАЯ ранее записанная строка пересобираемого в этом прогоне юнита,
    под какой бы формой posting_number она ни лежала, имеет src_unit_number
    РОВНО из extra_keys и будет найдена и удалена этим условием, вне
    зависимости от того, как юнит резолвился раньше и сейчас."""
    return sorted(set(extra_keys)) if extra_keys else []


def upsert_ozon_order_costs_many(rows, table="ozon_order_costs", extra_keys=None):
    """Batch DELETE+INSERT (одна транзакция) строк прибыли по отправлению.

    table — короткое имя таблицы БЕЗ "tenant." (по умолчанию боевая); второе
    допустимое значение — "ozon_order_costs_shadow" (пересчёт истории,
    задача 3-5 плана). Валидация — белый список _OZ_OC_ALLOWED_TABLES,
    вызывающий код (ozon_order_costs.py) ДОПОЛНИТЕЛЬНО проверяет полное имя
    --target-table своим списком до вызова сюда (defence in depth).

    DELETE перед INSERT (не просто ON CONFLICT DO UPDATE) — по требованию
    брифа задачи 3, явная идемпотентность пересборки periода: удаляем строки
    ИМЕННО пересобираемых posting_number этого прогона, затем вставляем
    заново, в той же транзакции (образец — upsert_ozon_accruals_many,
    db_pg.py). Для этой таблицы (PK ровно posting_number, максимум одна
    строка на отправление) ON CONFLICT DO UPDATE дал бы тот же результат, но
    явный DELETE+INSERT — тот же приём, что и в остальных пересобираемых
    таблицах проекта, и явно гарантирует состояние "ровно из этого прогона".

    extra_keys — ДОПОЛНИТЕЛЬНЫЕ ключи DELETE поверх posting_number строк rows
    (I3, фикс-волна финального ревью): исходные (сырые) unit_number всех
    пересобираемых юнитов этого прогона. Нужны, потому что posting_number
    строки может СМЕНИТЬСЯ между прогонами — resolve_meta() резолвит его по
    tenant.ozon_orders, который сам пополняется отдельным сборщиком; юнит,
    попавший в БД в прошлый раз под сырым unit_number (meta ещё не нашлась,
    fallback), в этом прогоне может резолвиться в ПОЛНУЮ форму
    (posting_number с финальным "-N") — DELETE по одному только НОВОМУ
    posting_number старую fallback-строку не заденет, она осиротеет и даст
    двойной счёт. extra_keys закрывает это: раз юнит пересобирается в этом
    прогоне (он в списке touched), удаляем И под его сырым unit_number
    тоже, независимо от того, как он резолвился раньше и сейчас.

    ВТОРОЕ условие DELETE — по src_unit_number (I4, находка задачи 6 плана
    «ремонт данных прибыли Ozon», task-6-report.md): I3 закрывает только
    переход «нерезолвлено -> резолвлено». Между ДВУМЯ УЖЕ РЕЗОЛВЛЕННЫМИ
    формами (например, суффиксная "0115022887-0449-5" на одном прогоне ->
    точная "0115022887-0449" на другом, resolve_meta резолвит против ЖИВОЙ
    tenant.ozon_orders без фиксации снимка) НИ posting_number этого
    прогона, НИ сырой unit_number (I3) со старым ключом не совпадают —
    старая строка осиротевает, деньги считаются дважды (живые данные,
    2026-08-18: 20 таких пар кабинета 1 после полного пересчёта). Функция
    _order_costs_delete_unit_keys добавляет DELETE по src_unit_number =
    ANY(extra_keys) — эта колонка хранит ИСХОДНЫЙ unit_number буквально
    независимо от того, как резолвился posting_number, поэтому находит
    старую строку под ЛЮБОЙ её прежней формой."""
    if table not in _OZ_OC_ALLOWED_TABLES:
        raise ValueError(f"недопустимая таблица order_costs: {table!r} "
                          f"(разрешено: {sorted(_OZ_OC_ALLOWED_TABLES)})")
    if not rows and not extra_keys:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    delete_keys = _order_costs_delete_keys(rows, extra_keys)
    delete_unit_keys = _order_costs_delete_unit_keys(extra_keys)
    all_cols = ["cabinet_id"] + _OZ_OC_COLS + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in _OZ_OC_COLS + ["updated_at"])
    sql = (f"INSERT INTO tenant.{table} ({', '.join(all_cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT (cabinet_id, posting_number) DO UPDATE SET {upd}")
    batch = [[cid] + [r.get(c) for c in _OZ_OC_COLS] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            if delete_keys:
                cur.execute(
                    f"DELETE FROM tenant.{table} WHERE cabinet_id = %s "
                    f"AND (posting_number = ANY(%s) OR src_unit_number = ANY(%s))",
                    [cid, delete_keys, delete_unit_keys],
                )
            if batch:
                cur.executemany(sql, batch)
    return len(rows)


# --- cabinet_costs (расходы уровня кабинета Ozon из начислений, задача 3) ---
_OZ_CAB_COLS = ["cost_type", "date", "amount", "description"]


def upsert_ozon_cabinet_costs_many(rows, date_from, date_to):
    """Batch DELETE+INSERT кабинетных статей Ozon, разнесённых из начислений
    (tenant.ozon_accruals, категория NON_ITEM, корзина 'cabinet' классификатора
    ozon_profit_map.classify_row). cost_type = 'accrual_<type_id>'.

    Идемпотентность пересборки периода ТРЕБУЕТ DELETE перед INSERT (в отличие
    от upsert_ozon_order_costs_many, где PK = ровно posting_number): здесь
    ключ (cost_type, date), и при пересборе состав типов за день может
    измениться (новый type_id появился, старый исчез) — простой ON CONFLICT
    DO UPDATE оставил бы "статьи-призраки" от предыдущего разбора висеть
    нетронутыми. Поэтому удаляем ВСЕ строки cost_type LIKE 'accrual_%' за
    [date_from, date_to] СВОЕГО кабинета (чужие cost_type, которые кабинетные
    расходы могут нести из других источников/будущих сборщиков, не задеваем —
    брифовое ограничение), затем вставляем заново. Одна транзакция."""
    cid = _cabinet_id()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    all_cols = ["cabinet_id"] + _OZ_CAB_COLS + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in _OZ_CAB_COLS + ["updated_at"])
    sql = (f"INSERT INTO tenant.ozon_cabinet_costs ({', '.join(all_cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT (cabinet_id, cost_type, date) DO UPDATE SET {upd}")
    batch = [[cid] + [r.get(c) for c in _OZ_CAB_COLS] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            if date_from and date_to:
                cur.execute(
                    "DELETE FROM tenant.ozon_cabinet_costs "
                    "WHERE cabinet_id = %s AND cost_type LIKE 'accrual\\_%%' "
                    "AND date >= %s AND date <= %s",
                    [cid, date_from, date_to],
                )
            if batch:
                cur.executemany(sql, batch)
    return len(rows)


# --- sku_ad (реклама по товарам Ozon) ---
_OZ_SKU_AD_COLS = ["date", "campaign_id", "sku", "product_id", "spend",
                   "views", "clicks", "ordered_units", "ordered_amount"]


def upsert_ozon_sku_ad_many(rows, date_from, date_to):
    """Batch DELETE+INSERT рекламы Ozon товар×день×кампания
    (tenant.ozon_daily_sku_ad, миграция 043). Источник — async-отчёт
    Performance API groupBy=DATE (сборщик ozon_sku_ad). Идемпотентность
    пересборки окна ТРЕБУЕТ DELETE перед INSERT: кампания, переставшая
    отдаваться отчётом (расход обнулён/пересчитан Озоном), должна исчезнуть
    из окна, а не остаться от прошлого прогона. DELETE и INSERT — одна
    транзакция (get_connection коммитит на выходе): упавший прогон не
    оставляет дыру вместо данных."""
    cid = _cabinet_id()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    all_cols = ["cabinet_id"] + _OZ_SKU_AD_COLS + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in _OZ_SKU_AD_COLS[1:] + ["updated_at"])
    sql = (f"INSERT INTO tenant.ozon_daily_sku_ad ({', '.join(all_cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT (cabinet_id, date, campaign_id, sku) DO UPDATE SET {upd}")
    batch = [[cid] + [r.get(c) for c in _OZ_SKU_AD_COLS] + [now] for r in rows]
    with get_connection() as conn:
        with conn.cursor() as cur:
            if date_from and date_to:
                cur.execute(
                    "DELETE FROM tenant.ozon_daily_sku_ad "
                    "WHERE cabinet_id = %s AND date >= %s AND date <= %s",
                    [cid, date_from, date_to],
                )
            if batch:
                cur.executemany(sql, batch)
    return len(rows)


def recompute_ozon_daily_ad(date_from, date_to):
    """Пересчёт товарных рекламных метрик tenant.ozon_daily_metrics
    (ad_spend/ad_views/ad_clicks/ad_orders) SQL-суммой из
    tenant.ozon_daily_sku_ad по (product_id, date) внутри окна. Колонки
    ad_* в ozon_daily_metrics никем больше не пишутся (ozon_metrics пишет
    только clicks/orders/cart — проверено grep 2026-08-21), владелец
    колонок — этот пересчёт. Сначала NULL-им ad_* всего окна (товар,
    выпавший из рекламы после пересборки, не должен возить старый расход),
    затем upsert свежих сумм; upsert, НЕ update-only — день с рекламой без
    заказов создаёт свою строку сам (грабля ozon_efficiency 2026-08-17).
    product_id IS NULL (не отрезолвленный sku) в товарные метрики не
    попадает — расход остаётся видимым в сыром слое и в кабинетном итоге."""
    cid = _cabinet_id()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE tenant.ozon_daily_metrics SET ad_spend=NULL, ad_views=NULL, "
                "ad_clicks=NULL, ad_orders=NULL, updated_at=%s "
                "WHERE cabinet_id = %s AND date >= %s AND date <= %s AND ad_spend IS NOT NULL",
                [now, cid, date_from, date_to],
            )
            cur.execute(
                "SELECT product_id, date::text AS d, SUM(spend) AS spend, "
                "SUM(views) AS views, SUM(clicks) AS clicks, SUM(ordered_units) AS ord "
                "FROM tenant.ozon_daily_sku_ad "
                "WHERE cabinet_id = %s AND product_id IS NOT NULL "
                "AND date >= %s AND date <= %s "
                "GROUP BY product_id, date",
                [cid, date_from, date_to],
            )
            sums = cur.fetchall()
            for r in sums:
                cur.execute(
                    "INSERT INTO tenant.ozon_daily_metrics "
                    "(cabinet_id, product_id, date, ad_spend, ad_views, ad_clicks, ad_orders, updated_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) "
                    "ON CONFLICT (cabinet_id, product_id, date) DO UPDATE SET "
                    "ad_spend=EXCLUDED.ad_spend, ad_views=EXCLUDED.ad_views, "
                    "ad_clicks=EXCLUDED.ad_clicks, ad_orders=EXCLUDED.ad_orders, "
                    "updated_at=EXCLUDED.updated_at",
                    [cid, r["product_id"], r["d"], r["spend"], r["views"], r["clicks"], r["ord"], now],
                )
    return len(sums)


# --- cogs (себестоимость Ozon) ---
def upsert_ozon_cogs(product_id, cost):
    cid = _cabinet_id()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO tenant.ozon_cogs (cabinet_id, product_id, cost, updated_at) "
            "VALUES (%s,%s,%s,%s) ON CONFLICT (cabinet_id, product_id) "
            "DO UPDATE SET cost=EXCLUDED.cost, updated_at=EXCLUDED.updated_at",
            [cid, product_id, cost, now],
        )


# --- daily_metrics Ozon (динамические поля) ---
_OZ_DM_COLS = {"orders", "clicks", "cart", "rating", "price", "revenue",
               "ad_views", "ad_clicks", "ad_orders", "ad_spend"}


def upsert_ozon_daily(product_id, date, **fields):
    cols = [c for c in _OZ_DM_COLS if c in fields]
    if not cols:
        return
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cid = _cabinet_id()
    all_cols = ["cabinet_id", "product_id", "date"] + cols + ["updated_at"]
    vals = [cid, product_id, date] + [fields[c] for c in cols] + [now]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols + ["updated_at"])
    with get_connection() as conn:
        conn.execute(
            f"INSERT INTO tenant.ozon_daily_metrics ({', '.join(all_cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT (cabinet_id, product_id, date) DO UPDATE SET {upd}",
            vals,
        )


# =====================================================================
#  shared.* — глобальные справочники (без cabinet_id, без RLS).
#  Склады WB и тарифы перевозок едины для всех кабинетов. Пишет сборщик
#  wb_references (таймер saas-references, 1×/неделю). Читают: route.js
#  (stocks) для построения рекомендаций по перевозке.
#
#  ВНИМАНИЕ: эти хелперы НЕ используют _cabinet_id()/get_connection() —
#  те выставляют GUC app.cabinet_id и заворачивают в tenant-RLS. Shared.*
#  таблицам RLS не нужен, а _cabinet_id() и вовсе рейзит RuntimeError при
#  отсутствии env. Здесь — отдельный контекст без GUC-сетапа.
# =====================================================================
@contextmanager
def get_shared_connection():
    """Подключение к PG БЕЗ выставления app.cabinet_id — для записи в shared.*.
    Сборщик wb_references запускается отдельным таймером (не через orchestrator
    per-cabinet loop), поэтому cabinet_id тут не нужен и не должен мешать."""
    conn = psycopg.connect(_DSN, autocommit=False, row_factory=dict_row)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def upsert_shared_wb_warehouses(rows):
    """Batch-upsert справочника складов WB в shared.wb_warehouses.
    rows: [{id, name, address, work_time, is_active, is_transit_active, region}].
    region (кластер) может прийти пустым для части складов — ON CONFLICT не затирает
    существующее значение через COALESCE (если новый ответ WB не содержит region
    для склада, сохраняем старый). Перезаписывает остальные поля — справочник
    сервисный, обновляем целиком."""
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cols = ["id", "name", "address", "work_time", "is_active", "is_transit_active", "region"]
    placeholders = ", ".join(["%s"] * (len(cols) + 1))
    # region, is_active, is_transit_active обновляем через COALESCE — stocks-report
    # (первичный источник) не отдаёт активность, а /warehouses не отдаёт регион.
    # COALESCE сохраняет существующее значение, если новый ответ WB пуст.
    coalesce_cols = {"region", "is_active", "is_transit_active", "address", "work_time"}
    upd_parts = []
    for c in cols[1:]:
        if c in coalesce_cols:
            upd_parts.append(f"{c}=COALESCE(EXCLUDED.{c}, shared.wb_warehouses.{c})")
        else:
            upd_parts.append(f"{c}=EXCLUDED.{c}")
    upd_parts.append("updated_at=EXCLUDED.updated_at")
    upd = ", ".join(upd_parts)
    sql = (
        f"INSERT INTO shared.wb_warehouses ({', '.join(cols)}, updated_at) "
        f"VALUES ({placeholders}) "
        f"ON CONFLICT (id) DO UPDATE SET {upd}"
    )
    batch = [[r.get(c) for c in cols] + [now] for r in rows]
    with get_shared_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, batch)
    return len(rows)


def upsert_shared_ozon_clusters(rows):
    """Справочник «склад Ozon → кластер» из /v1/cluster/list (глобальный, без RLS)."""
    if not rows:
        return 0
    now = datetime.now(timezone.utc)
    cols = ["warehouse_id", "warehouse_name", "warehouse_type", "cluster_id", "cluster_name"]
    placeholders = ", ".join(["%s"] * (len(cols) + 1))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols[1:]) + ", updated_at=EXCLUDED.updated_at"
    sql = (f"INSERT INTO shared.ozon_clusters ({', '.join(cols)}, updated_at) "
           f"VALUES ({placeholders}) ON CONFLICT (warehouse_id) DO UPDATE SET {upd}")
    batch = [[r.get(c) for c in cols] + [now] for r in rows]
    with get_shared_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, batch)
    return len(rows)


def upsert_shared_wb_transit_tariffs(rows):
    """Batch-upsert тарифов перевозок в shared.wb_transit_tariffs.
    rows: [{transit_warehouse_name, destination_warehouse_name, active_from,
            box_tariff(JSON-serializable), pallet_tariff}].
    box_tariff конвертируется в JSONB через psycopg (передаём как json.dumps)."""
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cols = ["transit_warehouse_name", "destination_warehouse_name",
            "active_from", "box_tariff", "pallet_tariff"]
    placeholders = ", ".join(["%s"] * (len(cols) + 1))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols + ["updated_at"])
    sql = (
        f"INSERT INTO shared.wb_transit_tariffs ({', '.join(cols)}, updated_at) "
        f"VALUES ({placeholders}) "
        f"ON CONFLICT (transit_warehouse_name, destination_warehouse_name) DO UPDATE SET {upd}"
    )
    batch = []
    for r in rows:
        box = r.get("box_tariff")
        box_val = json.dumps(box) if isinstance(box, (list, dict)) else box
        batch.append([
            r.get("transit_warehouse_name"),
            r.get("destination_warehouse_name"),
            r.get("active_from"),
            box_val,
            r.get("pallet_tariff"),
            now,
        ])
    with get_shared_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, batch)
    return len(rows)


def upsert_ozon_accrual_types(rows):
    """Batch-upsert справочника кодов типов начислений Ozon в
    shared.ozon_accrual_types (общий для всех кабинетов, задача 3 плана
    «переезд финансов Ozon на методы начислений», 2026-08-11).
    rows: [{type_id, name, description}]. Ключ конфликта — type_id."""
    if not rows:
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cols = ["type_id", "name", "description"]
    placeholders = ", ".join(["%s"] * (len(cols) + 1))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols[1:] + ["updated_at"])
    sql = (
        f"INSERT INTO shared.ozon_accrual_types ({', '.join(cols)}, updated_at) "
        f"VALUES ({placeholders}) "
        f"ON CONFLICT (type_id) DO UPDATE SET {upd}"
    )
    batch = [[r.get(c) for c in cols] + [now] for r in rows]
    with get_shared_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(sql, batch)
    return len(rows)

