"""
Python-ledger остатков (спека «Склады 2.0» §3.3) — зеркало lib/stockLedger.js для
воркера. Тот же SQL-контракт: INSERT в stock_moves с ON CONFLICT (stock_moves_src_uq)
DO NOTHING → дубль = no-op; UPDATE ff_inventory с проверкой неотрицательности (кроме
adjust) и archived_at IS NULL. Батч — одна транзакция, SAVEPOINT на движение: нехватка
остатка, отсутствующая/архивная позиция или любая другая ошибка на движении откатывают
только своё движение (ROLLBACK TO SAVEPOINT) и попадают в insufficient/missing/failed —
остальные движения применяются. moved_at может прийти NULL из источника (защитные
COALESCE в читалках db_pg не всегда достаточны) — INSERT подставляет now() через
SQL COALESCE, а не падает. Единственное место в воркере, где меняется ff_inventory.qty.
"""
import db_pg

_SQL_LOC = "SELECT location_id FROM tenant.ff_inventory WHERE id = %s AND archived_at IS NULL FOR UPDATE"
_SQL_INS = ("INSERT INTO tenant.stock_moves (cabinet_id, ff_inventory_id, location_id, kind, qty, src_kind, src_ref, moved_at, note) "
            "VALUES (current_setting('app.cabinet_id')::bigint, %s, %s, %s, %s, %s, %s, COALESCE(%s, now()), %s) "
            "ON CONFLICT (cabinet_id, src_kind, src_ref, kind) DO NOTHING RETURNING id")
_SQL_UPD = ("UPDATE tenant.ff_inventory SET qty = qty + %s, updated_at = now() "
            "WHERE id = %s AND archived_at IS NULL AND (%s OR qty + %s >= 0) RETURNING qty")


def apply_moves_conn(conn, moves):
    res = {"applied": 0, "duplicate": 0, "insufficient": [], "missing": [], "failed": []}
    cur = conn.cursor()
    try:
        for i, m in enumerate(moves):
            sp = f"mv{i}"
            cur.execute(f"SAVEPOINT {sp}")
            try:
                cur.execute(_SQL_LOC, (m["ff_inventory_id"],))
                row = cur.fetchone()
                if row is None:
                    # Позиция не найдена или архивна — списывать/зачислять некуда.
                    cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                    res["missing"].append((m["src_ref"], m["src_kind"]))
                    continue
                cur.execute(_SQL_INS, (m["ff_inventory_id"], row["location_id"], m["kind"], m["qty"], m["src_kind"], m["src_ref"], m["moved_at"], m.get("note")))
                if cur.fetchone() is None:
                    res["duplicate"] += 1
                    cur.execute(f"RELEASE SAVEPOINT {sp}")
                    continue
                cur.execute(_SQL_UPD, (m["qty"], m["ff_inventory_id"], m["kind"] == "adjust", m["qty"]))
                if cur.fetchone() is None:
                    cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                    res["insufficient"].append((m["src_ref"], m["src_kind"]))
                    continue
                cur.execute(f"RELEASE SAVEPOINT {sp}")
                res["applied"] += 1
            except Exception as e:
                # Любая другая ошибка на движении (сеть/констрейнт/тип) — откатить только
                # его, продолжить батч; сборщик решает, что делать с failed.
                cur.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                res["failed"].append((m["src_ref"], m["src_kind"], str(e)[:200]))
    finally:
        cur.close()
    return res


def apply_moves(moves):
    if not moves:
        return {"applied": 0, "duplicate": 0, "insufficient": [], "missing": [], "failed": []}
    with db_pg.get_connection() as conn:
        return apply_moves_conn(conn, moves)


def record_gaps(gaps):
    """Открытые пробелы: новый — INSERT, существующий — reason/last_seen_at обновить, resolved_at снять."""
    if not gaps:
        return 0
    cid = db_pg._cabinet_id()
    with db_pg.get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO tenant.stock_move_gaps (cabinet_id, src_kind, src_ref, platform, warehouse_id, sku_key, qty, reason) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (cabinet_id, src_kind, src_ref) DO UPDATE SET reason=EXCLUDED.reason, warehouse_id=EXCLUDED.warehouse_id, "
                "sku_key=EXCLUDED.sku_key, qty=EXCLUDED.qty, last_seen_at=now(), resolved_at=NULL",
                [[cid, g["src_kind"], g["src_ref"], g["platform"], g.get("warehouse_id"), g.get("sku_key"), g["qty"], g["reason"]] for g in gaps])
    return len(gaps)


def resolve_gaps(pairs):
    """Пробелы закрываются по ПАРАМ (src_kind, src_ref): движение теперь создано либо его
    уже никогда не будет (задание/постинг отменён — closed_refs планировщика). Пара, а не
    один src_kind на вызов: возврат пишется своим источником (wb_fbs_return/ozon_return),
    и его пробел заведён под тем же src_kind — закрывать его как wb_fbs_task было бы мимо."""
    uniq = sorted({(str(k), str(r)) for k, r in pairs})
    if not uniq:
        return 0
    with db_pg.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE tenant.stock_move_gaps SET resolved_at = now() "
                        "WHERE resolved_at IS NULL AND (src_kind, src_ref) IN "
                        "(SELECT * FROM unnest(%s::text[], %s::text[]))",
                        ([k for k, _ in uniq], [r for _, r in uniq]))
            return cur.rowcount


def close_gaps_all(platform):
    """Закрыть ВСЕ открытые пробелы платформы. Нужно ровно в одном случае: кабинет не
    использует ФФ-контур (нет ни одного места с привязкой к складу продавца) — разносить
    некуда, и висящие пробелы только шумят в /inventory. Пробелы откроются заново сами,
    как только места будут привязаны и планировщик отработает."""
    with db_pg.get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE tenant.stock_move_gaps SET resolved_at = now() "
                        "WHERE platform = %s AND resolved_at IS NULL", (platform,))
            return cur.rowcount
