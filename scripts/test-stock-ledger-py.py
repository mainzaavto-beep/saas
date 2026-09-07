#!/usr/bin/env python3
"""worker/stock_ledger.py: контракт SQL и обработка результатов без БД — курсор подменяется."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker"))
import stock_ledger as L


class FakeCur:
    def __init__(self, script):
        self.script = list(script); self.sql = []; self._row = None; self.closed = False
    def execute(self, sql, params=None):
        self.sql.append((sql.strip().split()[0].upper(), params))
        if sql.strip().upper().startswith(("SAVEPOINT", "RELEASE", "ROLLBACK")):
            self._row = None; return
        nxt = self.script.pop(0) if self.script else None
        if isinstance(nxt, BaseException):
            raise nxt
        self._row = nxt
    def fetchone(self):
        return self._row
    def close(self):
        self.closed = True


class FakeConn:
    def __init__(self, script): self.cur = FakeCur(script)
    def cursor(self): return self.cur
    def __enter__(self): return self
    def __exit__(self, *a): return False


# Пять движений: applied, duplicate, insufficient, missing (позиция не найдена/архивна —
# _SQL_LOC вернул None), failed (любая другая ошибка на движении — SELECT бросает
# исключение). SAVEPOINT на каждое; RELEASE — applied/duplicate; ROLLBACK TO —
# insufficient/missing/failed (fix round 1, п.2 и п.5).
moves = [
    {"ff_inventory_id": 10, "kind": "out_fbs", "qty": -1, "src_kind": "wb_fbs_task", "src_ref": "r1", "moved_at": "2026-09-01", "note": None},
    {"ff_inventory_id": 10, "kind": "out_fbs", "qty": -1, "src_kind": "wb_fbs_task", "src_ref": "r1", "moved_at": "2026-09-01", "note": None},
    {"ff_inventory_id": 11, "kind": "out_fbs", "qty": -5, "src_kind": "wb_fbs_task", "src_ref": "r9", "moved_at": "2026-09-01", "note": None},
    {"ff_inventory_id": 12, "kind": "out_fbs", "qty": -1, "src_kind": "wb_fbs_task", "src_ref": "r5", "moved_at": "2026-09-01", "note": None},
    {"ff_inventory_id": 13, "kind": "out_fbs", "qty": -1, "src_kind": "wb_fbs_task", "src_ref": "r7", "moved_at": None, "note": None},
]
# script по числу НЕ-savepoint/release/rollback execute(): m1 SELECT→INSERT→UPDATE (applied);
# m2 SELECT→INSERT(None) (дубль); m3 SELECT→INSERT→UPDATE(None) (insufficient);
# m4 SELECT(None) (missing, INSERT не вызывается); m5 SELECT бросает RuntimeError (failed).
conn = FakeConn([
    {"location_id": 7}, {"id": 1}, {"qty": 5},
    {"location_id": 7}, None,
    {"location_id": 7}, {"id": 2}, None,
    None,
    RuntimeError("boom"),
])
res = L.apply_moves_conn(conn, moves)
assert res == {"applied": 1, "duplicate": 1, "insufficient": ["r9"], "missing": ["r5"], "failed": [("r7", "boom")]}, res
ops = [s for s, _ in conn.cur.sql]
assert ops.count("SAVEPOINT") == 5 and ops.count("ROLLBACK") == 3 and ops.count("RELEASE") == 2, ops
ins = [p for s, p in conn.cur.sql if s == "INSERT"][0]
assert ins[:6] == (10, 7, "out_fbs", -1, "wb_fbs_task", "r1"), ins
assert conn.cur.closed, "курсор должен закрываться (fix round 1, п.8)"

# SQL-контракт: archived_at IS NULL в UPDATE (fix round 1, п.5), COALESCE(%s, now()) на
# moved_at в INSERT (fix round 1, п.1 — источник может отдать NULL-дату, moved_at NOT NULL).
assert "archived_at IS NULL" in L._SQL_UPD, L._SQL_UPD
assert "COALESCE(%s, now())" in L._SQL_INS, L._SQL_INS
print("OK: 6 проверок")
