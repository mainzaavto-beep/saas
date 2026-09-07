#!/usr/bin/env python3
"""worker/stock_ledger.py: контракт SQL и обработка результатов без БД — курсор подменяется."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker"))
import stock_ledger as L


class FakeCur:
    def __init__(self, script):
        self.script = list(script); self.sql = []; self._row = None
    def execute(self, sql, params=None):
        self.sql.append((sql.strip().split()[0].upper(), params))
        if sql.strip().upper().startswith(("SAVEPOINT", "RELEASE", "ROLLBACK")):
            self._row = None; return
        self._row = self.script.pop(0) if self.script else None
    def fetchone(self):
        return self._row


class FakeConn:
    def __init__(self, script): self.cur = FakeCur(script)
    def cursor(self): return self.cur
    def __enter__(self): return self
    def __exit__(self, *a): return False


moves = [
    {"ff_inventory_id": 10, "kind": "out_fbs", "qty": -1, "src_kind": "wb_fbs_task", "src_ref": "r1", "moved_at": "2026-09-01", "note": None},
    {"ff_inventory_id": 10, "kind": "out_fbs", "qty": -1, "src_kind": "wb_fbs_task", "src_ref": "r1", "moved_at": "2026-09-01", "note": None},
    {"ff_inventory_id": 11, "kind": "out_fbs", "qty": -5, "src_kind": "wb_fbs_task", "src_ref": "r9", "moved_at": "2026-09-01", "note": None},
]
# script: SELECT location → INSERT RETURNING → UPDATE RETURNING; дубль: SELECT → INSERT (None);
# insufficient: SELECT → INSERT → UPDATE (None)
conn = FakeConn([{"location_id": 7}, {"id": 1}, {"qty": 0},
                 {"location_id": 7}, None,
                 {"location_id": 7}, {"id": 2}, None])
res = L.apply_moves_conn(conn, moves)
assert res == {"applied": 1, "duplicate": 1, "insufficient": ["r9"]}, res
ops = [s for s, _ in conn.cur.sql]
assert ops.count("SAVEPOINT") == 3 and ops.count("ROLLBACK") == 1 and ops.count("RELEASE") == 2, ops
ins = [p for s, p in conn.cur.sql if s == "INSERT"][0]
assert ins[:6] == (10, 7, "out_fbs", -1, "wb_fbs_task", "r1"), ins
print("OK: 3 проверки")
