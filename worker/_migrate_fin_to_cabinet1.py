"""
Одноразовая миграция фин-данных из эталона (fin_data.db, SQLite) → SaaS
(PostgreSQL tenant.*, cabinet_id=1).

Переносит 12 таблиц фин-контекста с реальными датами, сохраняя legacy id
(для FK-связей purchase_payments в будущем). Производные/хеш-колонки
эталона (raw_hash, sum_no_spp и т.п.) отбрасываются — они пересчитаются.

2 таблицы (balance_account_catalog, balance_receivables) отсутствуют в
SaaS — создаются здесь же (минимальная схема, cabinet_id-first).

Идемпотентно по ON CONFLICT — безопасно перезапускать.
После вставки сбрасывает sequences на MAX(id), чтобы будущие BIGSERIAL-вставки
не столкнулись с сохранёнными legacy id.

Запуск (под postgres, RLS не мешает):
  set -a; . /etc/saas-worker.env; . /etc/collectors.env; set +a
  /opt/agents/data-presenter-agent/.venv/bin/python worker/_migrate_fin_to_cabinet1.py
"""
import sqlite3
import psycopg
from datetime import datetime

LEGACY = "/opt/agentsDB/fin_data.db"
CABINET = 1


def _pg():
    import os
    return psycopg.connect(
        host="localhost", port=5432, dbname="saas",
        user="postgres", password=os.environ["POSTGRES_PASSWORD"],
        autocommit=False,
    )


def _ts(v):
    """Legacy TEXT-таймстемп → ISO для PG timestamptz. None/пусто → None (→ DEFAULT now())."""
    if not v:
        return None
    return str(v)


def _date(v):
    """Legacy TEXT-дата → YYYY-MM-DD (или None)."""
    if not v:
        return None
    s = str(v)
    return s[:10] if len(s) >= 10 else s


def main():
    src = sqlite3.connect(f"file:{LEGACY}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    pg = _pg()
    cur = pg.cursor()

    stats = {}

    def migrate(table, columns, sql_template, transform=None, fetch_where="1=1"):
        """Перенести одну таблицу. columns — список колонок legacy (= saas, кроме cabinet_id)."""
        rows = src.execute(f"SELECT {', '.join(columns)} FROM {table} WHERE {fetch_where}").fetchall()
        n = 0
        for r in rows:
            vals = [r[c] for c in columns]
            if transform:
                vals = transform(vals, r)
            # cabinet_id добавляется первым (в sql_template).
            cur.execute(sql_template, [CABINET] + vals)
            n += cur.rowcount if cur.rowcount > 0 else 1
        stats[table] = (len(rows), n)

    # ===================================================================
    # 0. Создать недостающие таблицы (если нет) — balance_account_catalog, balance_receivables.
    # ===================================================================
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tenant.balance_account_catalog (
            cabinet_id   BIGINT NOT NULL,
            id           BIGSERIAL,
            subject      TEXT NOT NULL,
            account_name TEXT NOT NULL,
            sort_order   INTEGER DEFAULT 0,
            archived     INTEGER DEFAULT 0,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (cabinet_id, id),
            UNIQUE (cabinet_id, subject, account_name)
        );
        ALTER TABLE tenant.balance_account_catalog ENABLE ROW LEVEL SECURITY;
    """)
    # RLS-политика может уже быть или нет — CREATE POLICY IF NOT EXISTS не поддерживается в PG<17.
    cur.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant'
                           AND policyname='tenant_iso_balance_account_catalog') THEN
                CREATE POLICY tenant_iso_balance_account_catalog ON tenant.balance_account_catalog
                    FOR ALL TO saas_app
                    USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
                    WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
            END IF;
        END $$;
    """)
    cur.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.balance_account_catalog TO saas_app;")
    cur.execute("GRANT USAGE, SELECT ON SEQUENCE tenant.balance_account_catalog_id_seq TO saas_app;")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS tenant.balance_receivables (
            cabinet_id  BIGINT NOT NULL,
            id          BIGSERIAL,
            as_of_date  TEXT NOT NULL,
            source      TEXT NOT NULL,
            amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
            note        TEXT,
            received    INTEGER NOT NULL DEFAULT 0,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (cabinet_id, id),
            UNIQUE (cabinet_id, as_of_date, source)
        );
        ALTER TABLE tenant.balance_receivables ENABLE ROW LEVEL SECURITY;
    """)
    cur.execute("""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant'
                           AND policyname='tenant_iso_balance_receivables') THEN
                CREATE POLICY tenant_iso_balance_receivables ON tenant.balance_receivables
                    FOR ALL TO saas_app
                    USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
                    WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
            END IF;
        END $$;
    """)
    cur.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.balance_receivables TO saas_app;")
    cur.execute("GRANT USAGE, SELECT ON SEQUENCE tenant.balance_receivables_id_seq TO saas_app;")

    # ===================================================================
    # 1. purchases (52) — без raw_hash; deleted_at → ::timestamptz
    # ===================================================================
    cols = ["id","nm_id","qty","unit_cost","date","supplier","supplier_name","paid","note",
            "order_dt","delivery_dt","ship_dt","status","lifecycle_status","source",
            "source_country","order_no","total_amount","unit_cost_yuan","unit_cost_est",
            "exchange_rate","logistics_yuan","logistics_rub","logistics_rub_per_unit",
            "prepay_yuan","prepay_rate","plan_order_dt","plan_ship_dt","plan_arrival_dt",
            "pay_status","photo_url","deleted_at","created_at"]
    # Проверим какие колонки реально есть в legacy (на случай отсутствия deleted_at в старых).
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(purchases)")}
    cols = [c for c in cols if c in legacy_cols]

    def t_purchases(vals, r):
        # deleted_at TEXT → timestamptz-совместимая строка (пусто → None).
        out = list(vals)
        if "deleted_at" in cols:
            i = cols.index("deleted_at")
            out[i] = _ts(out[i]) if out[i] else None
        return out

    migrate("purchases", cols,
            f"""INSERT INTO tenant.purchases (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_purchases)

    # ===================================================================
    # 2. opex (17) — без recorded_by
    # ===================================================================
    cols = ["id","period","category","amount","note","status","counterparty","op_date",
            "domain","source","included_in_cogs","created_at","updated_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(opex)")}
    cols = [c for c in cols if c in legacy_cols]
    def t_ts(vals, r):
        return [(_ts(v) if c in ("created_at","updated_at") else v) for c, v in zip(cols, vals)]
    migrate("opex", cols,
            f"""INSERT INTO tenant.opex (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_ts)

    # ===================================================================
    # 3. sales_plan (4) — 1:1
    # ===================================================================
    cols = ["id","period","platform","nm_id","product_id","sku_label","category",
            "qty_plan","buyout_rate_plan","revenue_plan","drr_plan","margin_plan_pct",
            "price_no_spp","cost_plan","launch_date","is_new_sku","status","approved",
            "note","created_at","updated_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(sales_plan)")}
    cols = [c for c in cols if c in legacy_cols]
    migrate("sales_plan", cols,
            f"""INSERT INTO tenant.sales_plan (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_ts)

    # ===================================================================
    # 4. plan_targets (1) — 1:1, PK (cabinet_id, target_period, platform)
    # ===================================================================
    cols = ["target_period","platform","revenue_target","margin_target_pct",
            "profit_target","drr_target","note","updated_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(plan_targets)")}
    cols = [c for c in cols if c in legacy_cols]
    def t_pt(vals, r):
        return [(_ts(v) if c == "updated_at" else v) for c, v in zip(cols, vals)]
    rows = src.execute(f"SELECT {', '.join(cols)} FROM plan_targets").fetchall()
    n = 0
    for r in rows:
        vals = [(_ts(r[c]) if c == "updated_at" else r[c]) for c in cols]
        cur.execute(f"""INSERT INTO tenant.plan_targets (cabinet_id, {", ".join(cols)})
                        VALUES ({", ".join(["%s"] * (len(cols)+1))})
                        ON CONFLICT (cabinet_id, target_period, platform) DO NOTHING""",
                    [CABINET] + vals)
        n += 1
    stats["plan_targets"] = (len(rows), n)

    # ===================================================================
    # 5. purchase_plan (21) — 1:1
    # ===================================================================
    cols = ["id","week","nm_id","type","amount","qty","note","status","created_at","updated_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(purchase_plan)")}
    cols = [c for c in cols if c in legacy_cols]
    migrate("purchase_plan", cols,
            f"""INSERT INTO tenant.purchase_plan (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_ts)

    # ===================================================================
    # 6. self_buyouts (1) — без 7 derived/hash колонок
    # ===================================================================
    cols = ["id","claim_dt","nm_id","seller_article","qty","price","wb_discount","spp",
            "commission_pct","constructor_pct","logistics_unit","buyout_price","tax_pct",
            "total","source","created_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(self_buyouts)")}
    cols = [c for c in cols if c in legacy_cols]
    migrate("self_buyouts", cols,
            f"""INSERT INTO tenant.self_buyouts (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_ts)

    # ===================================================================
    # 7. cost_overrides (4) — effective_from TEXT → DATE
    # ===================================================================
    cols = ["id","platform","nm_id","product_id","cost","effective_from","note","created_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(cost_overrides)")}
    cols = [c for c in cols if c in legacy_cols]
    def t_co(vals, r):
        out = list(vals)
        if "effective_from" in cols:
            i = cols.index("effective_from")
            out[i] = _date(out[i])
        if "created_at" in cols:
            out[cols.index("created_at")] = _ts(out[cols.index("created_at")])
        return out
    migrate("cost_overrides", cols,
            f"""INSERT INTO tenant.cost_overrides (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_co)

    # ===================================================================
    # 8. item_status (143) — 1:1
    # ===================================================================
    cols = ["id","platform","nm_id","product_id","status","updated_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(item_status)")}
    cols = [c for c in cols if c in legacy_cols]
    migrate("item_status", cols,
            f"""INSERT INTO tenant.item_status (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_ts)

    # ===================================================================
    # 9. dds_movements (8) — 1:1
    # ===================================================================
    cols = ["id","date","type","amount","category","counterparty","description","status",
            "platform","nm_id","income_type","account_from","account_to","source",
            "reference","created_at","updated_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(dds_movements)")}
    cols = [c for c in cols if c in legacy_cols]
    migrate("dds_movements", cols,
            f"""INSERT INTO tenant.dds_movements (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_ts)

    # ===================================================================
    # 10. balance_accounts (8) — 1:1
    # ===================================================================
    cols = ["id","as_of_date","subject","account_name","amount","created_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(balance_accounts)")}
    cols = [c for c in cols if c in legacy_cols]
    migrate("balance_accounts", cols,
            f"""INSERT INTO tenant.balance_accounts (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_ts)

    # ===================================================================
    # 11. balance_account_catalog (8) — новая таблица, создана выше
    # ===================================================================
    cols = ["id","subject","account_name","sort_order","archived","created_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(balance_account_catalog)")}
    cols = [c for c in cols if c in legacy_cols]
    migrate("balance_account_catalog", cols,
            f"""INSERT INTO tenant.balance_account_catalog (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_ts)

    # ===================================================================
    # 12. balance_receivables (2) — новая таблица
    # ===================================================================
    cols = ["id","as_of_date","source","amount","note","received","created_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(balance_receivables)")}
    cols = [c for c in cols if c in legacy_cols]
    migrate("balance_receivables", cols,
            f"""INSERT INTO tenant.balance_receivables (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_ts)

    # ===================================================================
    # 13. balance_snapshot (2) — 1:1
    # ===================================================================
    cols = ["id","as_of_date","cash_on_hand","mp_balance","stock_value","stock_in_transit",
            "receivables","other_assets","payables","loans","owner_equity","retained_earnings",
            "other_liabilities","ff_stock","note","created_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(balance_snapshot)")}
    cols = [c for c in cols if c in legacy_cols]
    migrate("balance_snapshot", cols,
            f"""INSERT INTO tenant.balance_snapshot (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_ts)

    # ===================================================================
    # 14. bank_transactions (5) — 1:1
    # ===================================================================
    cols = ["id","date","type","amount","currency","category","counterparty","status",
            "description","created_at"]
    legacy_cols = {r[1] for r in src.execute("PRAGMA table_info(bank_transactions)")}
    cols = [c for c in cols if c in legacy_cols]
    migrate("bank_transactions", cols,
            f"""INSERT INTO tenant.bank_transactions (cabinet_id, {", ".join(cols)})
                VALUES ({", ".join(["%s"] * (len(cols)+1))})
                ON CONFLICT (cabinet_id, id) DO NOTHING""",
            transform=t_ts)

    # ===================================================================
    # Сброс sequences на MAX(id), чтобы будущие BIGSERIAL не столкнулись с legacy id.
    # ===================================================================
    seq_tables = ["purchases","opex","sales_plan","purchase_plan","self_buyouts",
                  "cost_overrides","item_status","dds_movements","balance_accounts",
                  "balance_account_catalog","balance_receivables","balance_snapshot",
                  "bank_transactions"]
    for t in seq_tables:
        seq = f"tenant.{t}_id_seq"
        cur.execute(f"SELECT setval('{seq}', COALESCE((SELECT MAX(id) FROM tenant.{t} WHERE cabinet_id=%s), 1), true)", (CABINET,))

    pg.commit()
    src.close()

    print("=== Миграция fin_data.db → tenant.* (cabinet_id=1) ===")
    for t, (src_n, dst_n) in stats.items():
        flag = "OK" if src_n == dst_n or dst_n == src_n else "разница(ON CONFLICT)"
        print(f"  {t:30s} legacy={src_n:5d} → saas={dst_n:5d}  [{flag}]")
    print("Готово.")


if __name__ == "__main__":
    main()
