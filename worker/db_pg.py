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
from datetime import datetime
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


def replace_cards_glue(rows, now_iso):
    cid = _cabinet_id()
    with get_connection() as conn:
        conn.execute("DELETE FROM tenant.wb_cards_glue WHERE cabinet_id = %s", (cid,))
        conn.executemany(
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
    now = datetime.now().isoformat(timespec="seconds")
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
    now = datetime.now().isoformat(timespec="seconds")
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
    now = datetime.now().isoformat(timespec="seconds")
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
    now = datetime.now().isoformat(timespec="seconds")
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


def upsert_ad(nm_id, date, model, **fields):
    cols = [c for c in _AD_COLS if c in fields]
    if not cols:
        return
    now = datetime.now().isoformat(timespec="seconds")
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
    now = datetime.now().isoformat(timespec="seconds")
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


_STOCK_COLS = ["nm_id", "date", "warehouse", "quantity", "quantity_full", "in_way_to", "in_way_from"]


def upsert_stock_many(rows):
    if not rows:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
    cid = _cabinet_id()
    all_cols = ["cabinet_id"] + _STOCK_COLS + ["updated_at"]
    placeholders = ", ".join(["%s"] * len(all_cols))
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in _STOCK_COLS + ["updated_at"])
    sql = (f"INSERT INTO tenant.wb_daily_stock ({', '.join(all_cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT (cabinet_id, nm_id, date, warehouse) DO UPDATE SET {upd}")
    batch = [[cid] + [r.get(c) for c in _STOCK_COLS] + [now] for r in rows]
    with get_connection() as conn:
        conn.executemany(sql, batch)
    return len(rows)


def _batch_upsert(table, pk_cols, data_cols, rows):
    """Общий батч-upsert для таблиц с однородной структурой."""
    if not rows:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
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
    now = datetime.now().isoformat(timespec="seconds")
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
    now = datetime.now().isoformat(timespec="seconds")
    with get_connection() as conn:
        conn.execute(
            _q("""INSERT INTO tenant.wb_cogs (cabinet_id, nm_id, cost, updated_at)
                   VALUES (?,?,?,?)
                   ON CONFLICT (cabinet_id, nm_id) DO UPDATE SET cost=EXCLUDED.cost, updated_at=EXCLUDED.updated_at"""),
            [cid, nm_id, cost, now],
        )


_PRICES_COLS = ["nm_id", "price_seller", "discount", "spp_auto"]


def upsert_prices_many(rows):
    return _batch_upsert("wb_prices", ["nm_id"], _PRICES_COLS, rows)


_PSKU_COLS = ["nm_id", "period_from", "period_to", "penalty", "logistics_correction",
              "loyalty_correction", "voluntary_comp", "other"]


def upsert_per_sku_costs_many(rows):
    return _batch_upsert("wb_per_sku_costs", ["nm_id", "period_from", "period_to"], _PSKU_COLS, rows)


_CAB_COLS = ["cost_type", "period_from", "period_to", "amount", "detail"]


def upsert_cabinet_costs_many(rows):
    return _batch_upsert("wb_cabinet_costs", ["cost_type", "period_from", "period_to"], _CAB_COLS, rows)


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

def _upsert_raw_multi_pk(table, pk_cols, mapping, rows):
    """Батч-upsert СЫРЫХ строк по карте (колонка_БД, ключ_источника) с СОСТАВНЫМ pk.
    cabinet_id добавляется автоматически. Булевы → 0/1. pk_cols — без cabinet_id."""
    if not rows:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
    cid = _cabinet_id()
    data_cols = [c for c, _ in mapping] + ["updated_at"]
    all_cols = ["cabinet_id"] + data_cols
    placeholders = ", ".join(["%s"] * len(all_cols))
    conflict = ", ".join(["cabinet_id"] + pk_cols)
    upd_cols = [c for c in data_cols if c not in pk_cols]
    upd = ", ".join(f"{c}=EXCLUDED.{c}" for c in upd_cols)
    sql = (f"INSERT INTO tenant.{table} (cabinet_id, {', '.join(data_cols)}) "
           f"VALUES ({placeholders}) ON CONFLICT ({conflict}) DO UPDATE SET {upd}")
    batch = [[cid] + [_conv(r.get(src)) for _, src in mapping] + [now] for r in rows]
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
    now = datetime.now().isoformat(timespec="seconds")
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
]
_OZ_SALES_MAP = [
    ("posting_number", "posting_number"), ("product_id", "product_id"),
    ("offer_id", "offer_id"), ("sale_dt", "sale_dt"),
    ("last_change_dt", "last_change_dt"), ("status", "status"),
    ("is_return", "is_return"), ("qty", "qty"), ("price", "price"),
    ("revenue", "revenue"), ("payout_amount", "payout_amount"),
]


def upsert_ozon_orders_many(rows):
    return _upsert_raw_multi_pk("ozon_orders", ["posting_number", "product_id"], _OZ_ORDERS_MAP, rows)


def upsert_ozon_sales_many(rows):
    return _upsert_raw_multi_pk("ozon_sales", ["posting_number", "product_id"], _OZ_SALES_MAP, rows)


# --- finance_report (/v3/finance/transaction/list) ---
_OZ_FIN_COLS = ["posting_id", "operation_id", "operation_type_name", "operation_type_id",
                "operation_dt", "product_id", "item_spp", "item_category_name", "item_offer_id",
                "item_name", "item_qty", "item_price", "sale_amount", "accruals_for_sale",
                "commission_amount", "payout_amount", "services_amount"]


def upsert_ozon_finance_many(rows):
    if not rows:
        return 0
    now = datetime.now().isoformat(timespec="seconds")
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


# --- daily_stock (остатки FBO) ---
_OZ_STOCK_COLS = ["product_id", "date", "warehouse", "fbo_present", "fbo_reserved", "fbo_defect"]


def upsert_ozon_stock_many(rows):
    return _batch_upsert("ozon_daily_stock", ["product_id", "date", "warehouse"], _OZ_STOCK_COLS, rows)


# --- order_costs (прибыль по заказу Ozon) ---
_OZ_OC_COLS = ["posting_number", "product_id", "size", "is_return", "order_dt", "sale_dt",
               "return_dt", "cost_value_retail", "commission", "acquiring", "logistics",
               "loyalty", "cost", "qty", "profit", "self_buyout"]


def upsert_ozon_order_costs_many(rows):
    return _batch_upsert("ozon_order_costs", ["posting_number"], _OZ_OC_COLS, rows)


# --- cogs (себестоимость Ozon) ---
def upsert_ozon_cogs(product_id, cost):
    cid = _cabinet_id()
    now = datetime.now().isoformat(timespec="seconds")
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
    now = datetime.now().isoformat(timespec="seconds")
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

