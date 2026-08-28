# География 2.0 — этап 1 «Данные»: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Спека:** `docs/superpowers/specs/2026-08-28-geography-v2-design.md` (этап 1 из 3).

**Goal:** Собрать фундамент данных для анализа складов и схем: починить склад Ozon, влить Ozon FBS во всю панель, добыть даты доставки Ozon, поставки WB FBS и справочник кластеров Ozon.

**Architecture:** Расширяем существующие сборщики Ozon (заказы/продажи) вторым источником `/v3/posting/fbs/list` и новыми полями из `analytics_data`; дату доставки берём из уже собираемых начислений (типы «последней мили» 28/29/30); добавляем два новых маленьких сборщика — `wb_supplies` (marketplace-api WB) и `ozon_references` (кластеры). Одна идемпотентная миграция, бэкфилл перезбором окна с 2026-05-01.

**Tech Stack:** Python-воркер (requests, psycopg3), PostgreSQL (RLS), миграции — сырой SQL через psql.

## Global Constraints

- Язык кода, комментариев, коммитов — русский (соглашение проекта).
- `git add` — ТОЛЬКО явно перечисленные файлы, никаких `git add -A/.` (урок 26.08).
- Прод-воркер работает прямо из `/opt/agents/saas` (master): миграция применяется ДО коммита кода, который использует новые колонки (таймер может сработать между шагами).
- Чтение боевой БД — `psql "host=localhost dbname=saas user=saas_ro"`; запись/DDL — только `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas`.
- Миграции идемпотентны (`IF NOT EXISTS` / `DO $$ ... $$`), нумерация `0NN_*.sql`; следующий номер — 047.
- pytest-инфраструктуры в проекте НЕТ: каждая задача завершается смоук-проверкой с реальным выводом (соглашение, зафиксированное в плане 2026-08-02-worker-alerting).
- Новый сборщик регистрируется в ДВУХ местах: `worker/orchestrator.py` (списки WB_COLLECTORS/OZON_COLLECTORS) И `worker/run_saas_collect.sh` (урок 2026-08-15).
- Даты в существующих tenant-таблицах Ozon — TEXT (новые `shipment_dt`/`delivered_dt` тоже TEXT); новая таблица `wb_supplies` — TIMESTAMPTZ (WB отдаёт ISO-строки, PG кастует сам).
- `MockOzonClient` (в `worker/collectors/ozon_client.py:624-695`) обновляется вместе с `OzonClient` — новые методы получают заглушки.
- В `_OZ_ORDERS_MAP` НЕ добавлять `delivered_dt`: колонку заполняет UPDATE из начислений, upsert заказов не должен затирать её NULL-ом.

## Карта файлов

| Файл | Что происходит |
|---|---|
| `db/migrations/047_geo_foundation.sql` | создать: колонки Ozon, `tenant.wb_supplies`, `shared.ozon_clusters` |
| `worker/collectors/ozon_client.py` | изменить: `posting_fbs_list`, `iter_fbs_postings`, `cluster_list`, Mock |
| `worker/collectors/ozon_orders.py` | изменить: фикс `warehouse_name`, новые поля, FBS-ветка, `_resolve_pid` |
| `worker/collectors/ozon_sales.py` | изменить: FBS-проходы, `scheme`, `_resolve_pid` |
| `worker/collectors/ozon_accruals.py` | изменить: вызов `update_ozon_delivered_dt` в конце `collect()` |
| `worker/collectors/wb_supplies.py` | создать: сборщик поставок WB FBS |
| `worker/collectors/ozon_references.py` | создать: сборщик кластеров Ozon |
| `worker/db_pg.py` | изменить: карты колонок, `update_ozon_delivered_dt`, `upsert_wb_supplies_many`, `upsert_shared_ozon_clusters` |
| `worker/orchestrator.py`, `worker/run_saas_collect.sh` | изменить: регистрация двух сборщиков |
| `scripts/check-geo-foundation.sql` | создать: смоук-сторож фундамента |

Факты, проверенные живым API/БД 27–28.08 (использовать как есть, не перепроверять):
- `analytics_data` FBO-постинга: `city`, `delivery_type` (PVZ/…), `warehouse_id`, `warehouse_name`; поля `region` у FBO НЕТ (только город); ключа `warehouse` НЕ существует — это и есть баг пустых складов.
- FBS-постинг: есть `shipment_date`, `analytics_data.region` и `city`, склад `рФБС`; `/v3/posting/fbs/list` работает с `limit`/`offset` (probe: 57 постингов с 01.05 у кабинета 1, has_next-пагинация).
- `/v1/cluster/list` (`cluster_type=CLUSTER_TYPE_OZON`): 22 кластера → `logistic_clusters[].warehouses[]` (`warehouse_id`, `type`, `name`); ответ БЕЗ обёртки `result`.
- Начисления: `type_id=29` (LastMileCourier) у постинга `77388497-0210-2` датирован 2026-08-22 — день в день с `OperationAgentDeliveredToCustomer` из `/v3/finance/transaction/list`; покрытие типами 28/29/30 — 1410 из 1578 доставленных постингов (89%).
- `tenant.ozon_products` имеет только `fbo_sku` (колонки fbs_sku нет) → для FBS нужен fallback-маппинг по `offer_id`.
- WB `/api/v3/supplies?limit=...&next=...`: ключи `id, name, createdAt, closedAt, scanDt, rejectDt, done, cargoType, destinationOfficeId, crossBorderType, isB2b, recommendedWhId, isPickupPointShipmentAllowed`; первая страница 100 строк, курсор `next`.
- С июня в `ozon_order_costs` 0 строк без заказа → прибыль строится только по постингам из `ozon_orders`, двоения FBS при интеграции не будет.

---

### Task 1: Миграция 047 — колонки Ozon, wb_supplies, ozon_clusters

**Files:**
- Create: `db/migrations/047_geo_foundation.sql`

**Interfaces:**
- Produces: колонки `tenant.ozon_orders.scheme/warehouse_id/delivery_type/shipment_dt/delivered_dt`, `tenant.ozon_sales.scheme`, таблицы `tenant.wb_supplies`, `shared.ozon_clusters` — на них опираются задачи 3–7.

- [ ] **Step 1: Написать миграцию**

```sql
-- 047_geo_foundation.sql — фундамент «Географии 2.0» (этап 1, спека 2026-08-28).
-- 1) Ozon: схема поставки (fbo/fbs), склад отгрузки, тип доставки, даты.
-- 2) tenant.wb_supplies — поставки WB FBS (лаг отгрузки на СЦ).
-- 3) shared.ozon_clusters — справочник «склад Ozon → кластер».
BEGIN;

ALTER TABLE tenant.ozon_orders ADD COLUMN IF NOT EXISTS scheme        TEXT;   -- 'fbo' | 'fbs'
ALTER TABLE tenant.ozon_orders ADD COLUMN IF NOT EXISTS warehouse_id  BIGINT; -- analytics_data.warehouse_id
ALTER TABLE tenant.ozon_orders ADD COLUMN IF NOT EXISTS delivery_type TEXT;   -- PVZ / Courier / ...
ALTER TABLE tenant.ozon_orders ADD COLUMN IF NOT EXISTS shipment_dt   TEXT;   -- posting.shipment_date
-- delivered_dt заполняется UPDATE-ом из начислений (последняя миля 28/29/30),
-- НЕ upsert-ом заказов — поэтому её нет в _OZ_ORDERS_MAP.
ALTER TABLE tenant.ozon_orders ADD COLUMN IF NOT EXISTS delivered_dt  TEXT;
ALTER TABLE tenant.ozon_sales  ADD COLUMN IF NOT EXISTS scheme        TEXT;

CREATE TABLE IF NOT EXISTS tenant.wb_supplies (
    cabinet_id            BIGINT NOT NULL,
    supply_id             TEXT   NOT NULL,   -- WB-GI-…
    name                  TEXT,              -- «Поставка Казань от 28.08.2026»
    created_at            TIMESTAMPTZ,       -- создана продавцом
    closed_at             TIMESTAMPTZ,       -- закрыта (передана в доставку)
    scan_dt               TIMESTAMPTZ,       -- отсканирована на СЦ (приёмка)
    reject_dt             TIMESTAMPTZ,
    done                  BOOLEAN NOT NULL DEFAULT false,
    cargo_type            INTEGER,
    destination_office_id BIGINT,            -- СЦ назначения
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cabinet_id, supply_id)
);
CREATE INDEX IF NOT EXISTS wb_supplies_created_idx ON tenant.wb_supplies (cabinet_id, created_at);

ALTER TABLE tenant.wb_supplies ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='wb_supplies' AND policyname='tenant_iso_wb_supplies') THEN
        CREATE POLICY tenant_iso_wb_supplies ON tenant.wb_supplies
        FOR ALL TO saas_app
        USING (cabinet_id = current_setting('app.cabinet_id')::bigint)
        WITH CHECK (cabinet_id = current_setting('app.cabinet_id')::bigint);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='tenant' AND tablename='wb_supplies' AND policyname='panel_local_ro_cab1') THEN
        CREATE POLICY panel_local_ro_cab1 ON tenant.wb_supplies
        FOR SELECT TO panel_local_ro
        USING (cabinet_id = 1);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant.wb_supplies TO saas_app;
-- panel_local_ro_cab1 без базового GRANT SELECT бесполезна (RLS не заменяет
-- табличную привилегию) — как в 041/043/046.
GRANT SELECT ON tenant.wb_supplies TO panel_local_ro;

-- Справочник кластеров Ozon: глобальный, без cabinet_id и RLS (как shared.wb_warehouses).
CREATE TABLE IF NOT EXISTS shared.ozon_clusters (
    warehouse_id   BIGINT PRIMARY KEY,   -- склад/СЦ Ozon
    warehouse_name TEXT NOT NULL,
    warehouse_type TEXT,                 -- FULL_FILLMENT / SORTING_CENTER / CROSS_DOCK
    cluster_id     BIGINT NOT NULL,
    cluster_name   TEXT NOT NULL,        -- «Казань», «Москва, МО и Дальние регионы», …
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON shared.ozon_clusters TO saas_app;

COMMIT;
```

- [ ] **Step 2: Применить на боевой БД**

Run: `PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -f db/migrations/047_geo_foundation.sql`
Expected: `BEGIN ... COMMIT` без ошибок.

- [ ] **Step 3: Проверить схему**

Run: `psql "host=localhost dbname=saas user=saas_ro" -X -c "\d tenant.wb_supplies" -c "\d shared.ozon_clusters" -c "SELECT column_name FROM information_schema.columns WHERE table_schema='tenant' AND table_name='ozon_orders' AND column_name IN ('scheme','warehouse_id','delivery_type','shipment_dt','delivered_dt');"`
Expected: обе таблицы существуют (у `wb_supplies` — обе политики), 5 колонок на месте.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/047_geo_foundation.sql
git commit -m "feat(db): 047 — фундамент географии: схема/склад/даты Ozon, wb_supplies, ozon_clusters"
```

---

### Task 2: Ozon-клиент — fbs/list, cluster/list

**Files:**
- Modify: `worker/collectors/ozon_client.py` (методы после `posting_fbo_list`/`iter_postings` ~`:287-340`; Mock `:624-695`)

**Interfaces:**
- Consumes: существующие `_post` (`:157-160`), `_iso` (`:578`), `REQUEST_PAUSE_SEC`.
- Produces: `OzonClient.posting_fbs_list(since, to, status=None, limit=1000, offset=0) -> dict`, `OzonClient.iter_fbs_postings(since, to, status=None)` (генератор постингов), `OzonClient.cluster_list(cluster_type="CLUSTER_TYPE_OZON") -> list` — используются задачами 3, 4, 7.

- [ ] **Step 1: Добавить методы в OzonClient** (рядом с `posting_fbo_list`/`iter_postings`)

```python
    def posting_fbs_list(self, since, to, status: str | None = None,
                         limit: int = 1000, offset: int = 0) -> dict:
        """FBS-отправления за период (фильтр по дате создания). limit/offset-пагинация."""
        body: dict[str, Any] = {
            "dir": "ASC",
            "filter": {"since": _iso(since), "to": _iso(to)},
            "limit": limit,
            "offset": offset,
            "with": {"analytics_data": True},
        }
        if status:
            body["filter"]["status"] = status
        return self._post(self.host, "/v3/posting/fbs/list", body)

    def iter_fbs_postings(self, since, to, status: str | None = None):
        """Итератор FBS-постингов: limit/offset, выход по has_next=False."""
        offset = 0
        first = True
        while True:
            if not first:
                time.sleep(REQUEST_PAUSE_SEC)
            first = False
            res = self.posting_fbs_list(since, to, status=status, offset=offset) or {}
            postings = res.get("postings") or []
            for p in postings:
                yield p
            if not res.get("has_next") or not postings:
                break
            offset += len(postings)

    def cluster_list(self, cluster_type: str = "CLUSTER_TYPE_OZON") -> list:
        """Справочник кластеров: кластер → logistic_clusters → склады.
        Ответ приходит БЕЗ обёртки result (проверено живым API 28.08.2026)."""
        res = self._post(self.host, "/v1/cluster/list", {"cluster_type": cluster_type}) or {}
        return res.get("clusters") or []
```

- [ ] **Step 2: Добавить заглушки в MockOzonClient**

```python
    def posting_fbs_list(self, since, to, status=None, limit=1000, offset=0):
        return {"postings": [], "has_next": False}

    def iter_fbs_postings(self, since, to, status=None):
        return iter([])

    def cluster_list(self, cluster_type="CLUSTER_TYPE_OZON"):
        return []
```

- [ ] **Step 3: Смоук на живом API** (креды кабинета 1 через оркестратор)

```bash
set -a; . /etc/saas-worker.env; set +a; python3 - <<'EOF'
import sys; sys.path.insert(0, "/opt/agents/saas"); sys.path.insert(0, "/opt/agents/saas/worker/collectors")
from worker import orchestrator as orch
from ozon_client import OzonClient
cab = orch._read_one_cabinet(1)
s = [x for x in cab["shops"] if x["mp_code"] == "ozon"][0]
c = orch._decrypt_creds(s.get("api_creds_enc"), s.get("api_creds"))["ozon"]
cli = OzonClient(client_id=str(c["client_id"]), api_key=c["api_key"])
fbs = list(cli.iter_fbs_postings("2026-05-01", "2026-08-28"))
print("fbs постингов:", len(fbs))
cl = cli.cluster_list()
print("кластеров:", len(cl), "| складов в 1-м:", sum(len(lc.get("warehouses") or []) for lc in cl[0]["logistic_clusters"]))
EOF
```
Expected: `fbs постингов: 57` (или чуть больше — окно живое), `кластеров: 22`.

- [ ] **Step 4: Commit**

```bash
git add worker/collectors/ozon_client.py
git commit -m "feat(worker): ozon_client — FBS-постинги (fbs/list) и справочник кластеров (cluster/list)"
```

---

### Task 3: ozon_orders — фикс склада, новые поля, FBS-ветка

**Files:**
- Modify: `worker/collectors/ozon_orders.py`
- Modify: `worker/db_pg.py` (`_OZ_ORDERS_MAP`, `:805-820`)

**Interfaces:**
- Consumes: `cli.iter_postings`, `cli.iter_fbs_postings` (Task 2), колонки из Task 1.
- Produces: строки `ozon_orders` с `scheme/warehouse_id/delivery_type/shipment_dt`, корректный `warehouse`; хелпер `_resolve_pid(prod, sku2pid, offer2pid)` (переиспользуется в Task 4 по образцу).

- [ ] **Step 1: Расширить `_OZ_ORDERS_MAP` в db_pg.py** (`delivered_dt` НЕ добавлять — см. Global Constraints)

```python
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
```

- [ ] **Step 2: Переписать сбор строк в ozon_orders.py**

Докстроку дополнить: «+ /v3/posting/fbs/list — обе схемы, колонка scheme». После загрузки `sku2pid` (`:60-64`) добавить fallback-карту и хелпер (FBS-постинги несут sku, которого может не быть в `fbo_sku`, — тогда ищем по `offer_id`; `tenant.ozon_products` другой sku-колонки не имеет, проверено 28.08):

```python
    offer2pid = {}
    for r in db_pg.query("SELECT offer_id, product_id FROM tenant.ozon_products WHERE offer_id IS NOT NULL"):
        offer2pid[r["offer_id"]] = int(r["product_id"])
```

```python
def _resolve_pid(prod, sku2pid, offer2pid):
    """product_id по sku (fbo_sku), иначе по offer_id (нужно для FBS)."""
    sku = prod.get("sku")
    if sku:
        pid = sku2pid.get(int(sku))
        if pid:
            return pid
    return offer2pid.get(prod.get("offer_id"))
```

Основной цикл (`:66-104`) заменить на проход по двум источникам; тело построения строки — прежнее, с изменениями: `warehouse` из `warehouse_name` (фикс бага пустых складов), четыре новых поля, `product_id` через `_resolve_pid`:

```python
    rows = []
    n_postings = {"fbo": 0, "fbs": 0}
    sources = [("fbo", cli.iter_postings(since, to)),
               ("fbs", cli.iter_fbs_postings(since, to))]
    for scheme, postings in sources:
        for p in postings:
            n_postings[scheme] += 1
            posting_number = p.get("posting_number")
            status = p.get("status")
            is_cancel = 1 if status == "cancelled" else 0
            order_dt = p.get("in_process_at") or p.get("created_at")
            last_change_dt = p.get("last_change_date") or p.get("shipment_date")
            analytics = p.get("analytics_data") or {}
            # API отдаёт warehouse_name; ключа `warehouse` не существует — из-за
            # него склад был пуст во всех строках (баг вскрыт 27.08).
            warehouse = analytics.get("warehouse_name") or ""
            region = analytics.get("region") or analytics.get("city", "")
            products = p.get("products") or p.get("product") or []
            for prod in products:
                cancel_dt = last_change_dt if is_cancel else None
                price_raw = prod.get("price")
                if isinstance(price_raw, dict):
                    price_val = float(price_raw.get("amount", 0) or 0)
                elif isinstance(price_raw, (int, float)):
                    price_val = float(price_raw)
                else:
                    price_val = 0.0
                qty = int(prod.get("quantity", 1) or 1)
                rows.append({
                    "posting_number": posting_number,
                    "product_id": _resolve_pid(prod, sku2pid, offer2pid),
                    "offer_id": prod.get("offer_id"),
                    "order_dt": order_dt,
                    "last_change_dt": last_change_dt,
                    "in_process_at": p.get("in_process_at"),
                    "status": status,
                    "is_cancel": is_cancel,
                    "cancel_dt": cancel_dt,
                    "qty": qty,
                    "price": price_val,
                    "total": price_val * qty,
                    "warehouse": warehouse,
                    "region": region,
                    "scheme": scheme,
                    "warehouse_id": analytics.get("warehouse_id"),
                    "delivery_type": analytics.get("delivery_type", ""),
                    "shipment_dt": p.get("shipment_date"),
                })
```

Итоговый print (`:109-110`) дополнить разбивкой: `f"[ozon_orders] отправлений fbo {n_postings['fbo']}, fbs {n_postings['fbs']}, записано {written}"`.

- [ ] **Step 3: Смоук — прогон узким окном через оркестратор**

Run: `set -a; . /etc/saas-worker.env; set +a; cd /opt/agents/saas && python3 -m worker.orchestrator --all --collectors ozon_orders --date-from 2026-08-25 --date-to 2026-08-28`
Expected: в логе `отправлений fbo N, fbs M` (N>0), exit 0.

- [ ] **Step 4: Проверить заполнение в БД**

Run: `psql "host=localhost dbname=saas user=saas_ro" -X -c "SELECT scheme, COUNT(*), COUNT(*) FILTER (WHERE warehouse<>'') AS with_wh, COUNT(*) FILTER (WHERE delivery_type<>'') AS with_dt FROM tenant.ozon_orders WHERE order_dt >= '2026-08-25' GROUP BY 1;"`
Expected: строки `fbo` (и `fbs`, если были заказы в окне); `with_wh` == COUNT для fbo (склад больше не пустой).

- [ ] **Step 5: Commit**

```bash
git add worker/collectors/ozon_orders.py worker/db_pg.py
git commit -m "fix(worker): ozon_orders — склад из warehouse_name (был пуст всегда), FBS-постинги, scheme/delivery_type/shipment_dt"
```

---

### Task 4: ozon_sales — FBS-проходы и scheme

**Files:**
- Modify: `worker/collectors/ozon_sales.py`
- Modify: `worker/db_pg.py` (`_OZ_SALES_MAP`, `:821-827`)

**Interfaces:**
- Consumes: `cli.iter_fbs_postings` (Task 2), `ozon_sales.scheme` (Task 1).
- Produces: продажи/возвраты обеих схем с колонкой `scheme`.

- [ ] **Step 1: Расширить `_OZ_SALES_MAP`**

```python
_OZ_SALES_MAP = [
    ("posting_number", "posting_number"), ("product_id", "product_id"),
    ("offer_id", "offer_id"), ("sale_dt", "sale_dt"),
    ("last_change_dt", "last_change_dt"), ("status", "status"),
    ("is_return", "is_return"), ("qty", "qty"), ("price", "price"),
    ("revenue", "revenue"), ("payout_amount", "payout_amount"),
    ("scheme", "scheme"),  # география 2.0 (047)
]
```

- [ ] **Step 2: Обновить ozon_sales.py**

Докстроку дополнить: «обе схемы: fbo/list + fbs/list, колонка scheme». `_rows_for_status` получает параметр `scheme` и выбирает итератор; `product_id` — через тот же `_resolve_pid`, что в ozon_orders (скопировать хелпер и карту `offer2pid` — сборщики самостоятельные модули, общей библиотеки хелперов нет):

```python
def _resolve_pid(prod, sku2pid, offer2pid):
    """product_id по sku (fbo_sku), иначе по offer_id (нужно для FBS)."""
    sku = prod.get("sku")
    if sku:
        pid = sku2pid.get(int(sku))
        if pid:
            return pid
    return offer2pid.get(prod.get("offer_id"))


def _rows_for_status(cli, since, to, status, is_return, sku2pid, offer2pid, scheme):
    rows = []
    it = (cli.iter_fbs_postings(since, to, status=status) if scheme == "fbs"
          else cli.iter_postings(since, to, status=status))
    for p in it:
        posting_number = p.get("posting_number")
        sale_dt = p.get("in_process_at") or p.get("last_change_date") or p.get("created_at")
        last_change_dt = p.get("last_change_date")
        for prod in (p.get("products") or []):
            price_raw = prod.get("price")
            if isinstance(price_raw, dict):
                price = float(price_raw.get("amount", 0) or 0)
            elif isinstance(price_raw, (int, float)):
                price = float(price_raw)
            else:
                price = 0.0
            qty = int(prod.get("quantity", 1) or 1)
            revenue = price * qty
            if is_return:
                revenue = -abs(revenue)
            rows.append({
                "posting_number": posting_number,
                "product_id": _resolve_pid(prod, sku2pid, offer2pid),
                "offer_id": prod.get("offer_id"),
                "sale_dt": sale_dt,
                "last_change_dt": last_change_dt,
                "status": status,
                "is_return": 1 if is_return else 0,
                "qty": qty,
                "price": price,
                "revenue": revenue,
                "payout_amount": None,
                "scheme": scheme,
            })
    return rows
```

(Тело повторяет прежние строки 22–51 файла; изменения — только выбор итератора, вычисление `product_id` через `_resolve_pid` вместо старого fallback `prod.get("product_id") or prod.get("sku")` и ключ `scheme`.)

В `collect()` после загрузки `sku2pid` добавить `offer2pid` (тот же запрос, что в Task 3) и заменить два прохода на четыре:

```python
    delivered = _rows_for_status(cli, since, to, "delivered", False, sku2pid, offer2pid, "fbo") \
              + _rows_for_status(cli, since, to, "delivered", False, sku2pid, offer2pid, "fbs")
    cancelled = _rows_for_status(cli, since, to, "cancelled", True, sku2pid, offer2pid, "fbo") \
              + _rows_for_status(cli, since, to, "cancelled", True, sku2pid, offer2pid, "fbs")
```

- [ ] **Step 3: Смоук — прогон и проверка**

Run: `set -a; . /etc/saas-worker.env; set +a; cd /opt/agents/saas && python3 -m worker.orchestrator --all --collectors ozon_sales --date-from 2026-08-20 --date-to 2026-08-28`
затем: `psql "host=localhost dbname=saas user=saas_ro" -X -c "SELECT scheme, is_return, COUNT(*) FROM tenant.ozon_sales WHERE sale_dt >= '2026-08-20' GROUP BY 1,2 ORDER BY 1,2;"`
Expected: exit 0; у свежих строк `scheme='fbo'` (fbs — если в окне были FBS-продажи), NULL только у старых.

- [ ] **Step 4: Commit**

```bash
git add worker/collectors/ozon_sales.py worker/db_pg.py
git commit -m "feat(worker): ozon_sales — FBS-продажи/возвраты, колонка scheme"
```

---

### Task 5: delivered_dt из начислений «последней мили»

**Files:**
- Modify: `worker/db_pg.py` (рядом с `upsert_ozon_accruals_many`, `:861`)
- Modify: `worker/collectors/ozon_accruals.py` (конец `collect()`, после записи строк `:309`)

**Interfaces:**
- Consumes: `tenant.ozon_accruals` (type_id 28/29/30), `ozon_orders.delivered_dt` (Task 1), `get_connection()`.
- Produces: `db_pg.update_ozon_delivered_dt(date_from=None) -> int` — число обновлённых строк; вызывается после каждого сбора начислений.

- [ ] **Step 1: Функция в db_pg.py**

```python
def update_ozon_delivered_dt(date_from=None):
    """ozon_orders.delivered_dt := MIN(date) начислений «последней мили» по unit_number
    (type_id: 28 LastMile, 29 LastMileCourier «Доставка до места выдачи»,
    30 LastMilePickUpPoint «Выдача товара»). Семантика сверена с живым API 28.08.2026:
    у постинга 77388497-0210-2 тип 29 датирован 2026-08-22 — день в день с
    OperationAgentDeliveredToCustomer из /v3/finance/transaction/list.
    Вне _OZ_ORDERS_MAP сознательно: upsert заказов не должен затирать дату NULL-ом.
    date_from сужает окно по дате начисления (плановый прогон); None — вся история."""
    cond = "AND date >= %s" if date_from else ""
    sql = f"""
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
    params = [date_from] if date_from else []
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount
```

- [ ] **Step 2: Вызов в ozon_accruals.py**

В конце `collect()` (после итогового upsert и перед финальным `##OBS`/return; имя переменной нижней границы окна — как в файле, `d_from` из `resolve_window`):

```python
    upd = db_pg.update_ozon_delivered_dt(date_from=d_from)
    print(f"[ozon_accruals] delivered_dt: обновлено {upd} строк ozon_orders", flush=True)
```

- [ ] **Step 3: Смоук — узкое окно**

Run: `set -a; . /etc/saas-worker.env; set +a; cd /opt/agents/saas && python3 -m worker.orchestrator --all --collectors ozon_accruals --date-from 2026-08-20 --date-to 2026-08-27`
Expected: в логе `delivered_dt: обновлено N строк` (N > 0 при первом прогоне).

- [ ] **Step 4: Проверка данных**

Run: `psql "host=localhost dbname=saas user=saas_ro" -X -c "SELECT COUNT(*) FILTER (WHERE delivered_dt IS NOT NULL) AS with_dd, COUNT(*) AS total, ROUND(AVG((delivered_dt::date - substr(order_dt,1,10)::date))::numeric, 1) AS avg_days FROM tenant.ozon_orders WHERE status='delivered' AND order_dt >= '2026-08-01';"`
Expected: `with_dd` близко к `total` (покрытие последней милей ~89%), `avg_days` — разумные 2–7 дней (санити на перепутанные даты).

- [ ] **Step 5: Commit**

```bash
git add worker/db_pg.py worker/collectors/ozon_accruals.py
git commit -m "feat(worker): delivered_dt Ozon из начислений последней мили (28/29/30) после каждого сбора"
```

---

### Task 6: Сборщик wb_supplies + регистрация

**Files:**
- Create: `worker/collectors/wb_supplies.py`
- Modify: `worker/db_pg.py` (карта + upsert, рядом с прочими `_upsert_raw_multi_pk`-обёртками)
- Modify: `worker/orchestrator.py` (`WB_COLLECTORS`, `:169-183`)
- Modify: `worker/run_saas_collect.sh` (`MAIN_COLLECTORS`, `:50`)

**Interfaces:**
- Consumes: `tenant.wb_supplies` (Task 1), `db_pg._upsert_raw_multi_pk`, env `WB_TOKEN` (оркестратор кладёт per-shop).
- Produces: `db_pg.upsert_wb_supplies_many(rows) -> int`; модуль `worker.collectors.wb_supplies` с `collect()` без аргументов (аргументы дат от оркестратора игнорирует, как wb_references).

- [ ] **Step 1: Карта и upsert в db_pg.py**

```python
_WB_SUPPLIES_MAP = [
    ("supply_id", "id"), ("name", "name"), ("created_at", "createdAt"),
    ("closed_at", "closedAt"), ("scan_dt", "scanDt"), ("reject_dt", "rejectDt"),
    ("done", "done"), ("cargo_type", "cargoType"),
    ("destination_office_id", "destinationOfficeId"),
]


def upsert_wb_supplies_many(rows):
    """Поставки WB FBS (marketplace-api /api/v3/supplies). ISO-строки дат
    кастуются в TIMESTAMPTZ самим Postgres."""
    return _upsert_raw_multi_pk("wb_supplies", ["supply_id"], _WB_SUPPLIES_MAP, rows)
```

- [ ] **Step 2: Сборщик wb_supplies.py** (ретраи — по образцу `wb_references._request`, `:64-104`)

```python
"""
SaaS-сборщик ПОСТАВОК WB FBS → tenant.wb_supplies.

marketplace-api /api/v3/supplies, курсорная пагинация (limit/next).
Даты жизненного цикла: createdAt (создана) → closedAt (закрыта, передана
в доставку) → scanDt (отсканирована на СЦ). Лаг closedAt→scanDt — «время
отгрузки на СЦ» для вкладки «География» (спека 2026-08-28-geography-v2).

Список отдаётся целиком с начала работы кабинета (сотни строк) — тянем все
страницы каждый прогон, upsert идемпотентен. Аргументы дат от оркестратора
игнорируются (как wb_references).
"""
import os
import sys
import time
from datetime import datetime

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db_pg

WB_TOKEN = os.getenv("WB_TOKEN")
SUPPLIES_URL = "https://marketplace-api.wildberries.ru/api/v3/supplies"
PAGE_LIMIT = 1000
MAX_ATTEMPTS = 4


def _get(url):
    """GET с ретраями на 429/5xx; None при недоступности (не роняем прогон)."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.get(url, headers={"Authorization": WB_TOKEN}, timeout=60)
        except requests.RequestException as e:
            print(f"  сеть ({attempt}/{MAX_ATTEMPTS}): {e}", flush=True)
            time.sleep(2 * attempt)
            continue
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", "10") or 10)
            print(f"  429, ждём {wait}с ({attempt}/{MAX_ATTEMPTS})", flush=True)
            time.sleep(min(wait, 60))
            continue
        if resp.status_code >= 500:
            print(f"  {resp.status_code} ({attempt}/{MAX_ATTEMPTS})", flush=True)
            time.sleep(2 * attempt)
            continue
        print(f"  ОШИБКА {resp.status_code}: {resp.text[:200]}", flush=True)
        return None
    return None


def collect():
    print(f"[wb_supplies] поставки FBS ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    db_pg.init()
    rows, nxt, pages = [], 0, 0
    while True:
        data = _get(f"{SUPPLIES_URL}?limit={PAGE_LIMIT}&next={nxt}")
        if data is None:
            if not rows:
                print("[wb_supplies] ПРОПУСК: API недоступен (exit 0)", flush=True)
                return 0
            break  # часть страниц уже есть — пишем что собрали
        page = data.get("supplies") or []
        rows.extend(page)
        pages += 1
        nxt = data.get("next")
        if len(page) < PAGE_LIMIT or not nxt:
            break
        time.sleep(0.5)
    written = db_pg.upsert_wb_supplies_many(rows)
    print(f"[wb_supplies] страниц {pages}, поставок {len(rows)}, записано {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
```

- [ ] **Step 3: Регистрация в двух местах**

`worker/orchestrator.py`, в конец `WB_COLLECTORS` (после `"wb_references"`):
```python
    "wb_supplies",     # поставки FBS → tenant.wb_supplies (лаг отгрузки на СЦ)
```
`worker/run_saas_collect.sh:50` — в конец `MAIN_COLLECTORS` добавить `,wb_supplies`.

- [ ] **Step 4: Смоук — прогон и лаги**

Run: `set -a; . /etc/saas-worker.env; set +a; cd /opt/agents/saas && python3 -m worker.orchestrator --all --collectors wb_supplies`
затем: `psql "host=localhost dbname=saas user=saas_ro" -X -c "SELECT COUNT(*) AS supplies, COUNT(scan_dt) AS scanned, ROUND(AVG(EXTRACT(EPOCH FROM (scan_dt-closed_at))/3600)::numeric,1) AS avg_lag_h FROM tenant.wb_supplies WHERE scan_dt IS NOT NULL OR closed_at IS NOT NULL;"`
Expected: supplies > 100 (первая страница пробы была полной сотней), avg_lag_h — положительные часы.

- [ ] **Step 5: Commit**

```bash
git add worker/collectors/wb_supplies.py worker/db_pg.py worker/orchestrator.py worker/run_saas_collect.sh
git commit -m "feat(worker): wb_supplies — поставки WB FBS (создана→закрыта→скан СЦ), регистрация в main-тике"
```

---

### Task 7: Сборщик ozon_references (кластеры) + регистрация

**Files:**
- Create: `worker/collectors/ozon_references.py`
- Modify: `worker/db_pg.py` (upsert в shared-блок, рядом с `upsert_shared_wb_warehouses`, `:1237`)
- Modify: `worker/orchestrator.py` (`OZON_COLLECTORS`, `:184-201`)
- Modify: `worker/run_saas_collect.sh` (`REFERENCES_COLLECTORS`, `:55`)

**Interfaces:**
- Consumes: `cli.cluster_list()` (Task 2), `shared.ozon_clusters` (Task 1), `get_shared_connection()`.
- Produces: `db_pg.upsert_shared_ozon_clusters(rows) -> int`; модуль `worker.collectors.ozon_references` с `collect()`.

- [ ] **Step 1: Upsert в db_pg.py** (shared-блок, по образцу `upsert_shared_wb_warehouses`)

```python
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
```

- [ ] **Step 2: Сборщик ozon_references.py**

```python
"""
SaaS-сборщик СПРАВОЧНИКА КЛАСТЕРОВ Ozon → shared.ozon_clusters.

/v1/cluster/list (CLUSTER_TYPE_OZON): кластер → logistic_clusters → склады
(warehouse_id, name, type). Нужен вкладке «География» для локальности Ozon
(склад отгрузки → кластер). Почти статичен — тик references (weekly),
как wb_references. Аргументы дат игнорируются. Глобальный справочник:
пишется без cabinet_id, кредами любого Ozon-кабинета.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
import db_pg
from ozon_client import OzonClient


def collect():
    print(f"[ozon_references] кластеры Ozon ({datetime.now():%Y-%m-%d %H:%M})", flush=True)
    db_pg.init()
    cli = OzonClient()
    clusters = cli.cluster_list()
    rows = []
    for c in clusters:
        for lc in c.get("logistic_clusters") or []:
            for w in lc.get("warehouses") or []:
                if w.get("warehouse_id") is None:
                    continue
                rows.append({
                    "warehouse_id": w["warehouse_id"],
                    "warehouse_name": w.get("name") or "",
                    "warehouse_type": w.get("type"),
                    "cluster_id": c.get("id"),
                    "cluster_name": c.get("name") or "",
                })
    if not rows:
        print("[ozon_references] ПРОПУСК: API вернул пусто (exit 0)", flush=True)
        return 0
    written = db_pg.upsert_shared_ozon_clusters(rows)
    print(f"[ozon_references] кластеров {len(clusters)}, складов {written}", flush=True)
    print(f"##OBS rows={written}", flush=True)
    return written


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    os.environ["NO_PROXY"] = "*"
    collect()
```

- [ ] **Step 3: Регистрация**

`worker/orchestrator.py` — в конец `OZON_COLLECTORS`:
```python
    "ozon_references", # справочник кластеров → shared.ozon_clusters (таймер saas-references)
```
`worker/run_saas_collect.sh:55`:
```bash
REFERENCES_COLLECTORS="wb_references,ozon_references"
```

- [ ] **Step 4: Смоук**

Run: `set -a; . /etc/saas-worker.env; set +a; cd /opt/agents/saas && python3 -m worker.orchestrator --all --collectors ozon_references`
затем: `psql "host=localhost dbname=saas user=saas_ro" -X -c "SELECT COUNT(DISTINCT cluster_id) AS clusters, COUNT(*) AS warehouses FROM shared.ozon_clusters;" -c "SELECT cluster_name FROM shared.ozon_clusters WHERE warehouse_name='ЖУКОВСКИЙ_РФЦ';"`
Expected: clusters = 22, warehouses — сотни; ЖУКОВСКИЙ_РФЦ найден с кластером «Москва, МО и Дальние регионы».

- [ ] **Step 5: Commit**

```bash
git add worker/collectors/ozon_references.py worker/db_pg.py worker/orchestrator.py worker/run_saas_collect.sh
git commit -m "feat(worker): ozon_references — справочник кластеров Ozon в shared, тик references"
```

---

### Task 8: Бэкфилл с 01.05, финансовая сверка, смоук-сторож

**Files:**
- Create: `scripts/check-geo-foundation.sql`

**Interfaces:**
- Consumes: всё из задач 1–7.
- Produces: заполненная история (склады, схемы, даты, FBS в деньгах), повторяемый смоук-скрипт.

- [ ] **Step 0: Очистить мусорную ozon_sales** (вскрыто 28.08 в задаче 4: /v3/posting/fbo/list игнорирует filter.status, cancelled-проход исторически перезаписывал все продажи как возвраты — вся таблица до фикса мусорная; бэкфилл не перезапишет строки-фантомы недоставленных постингов, поэтому чистим целиком и пересобираем)

```bash
PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -c "DELETE FROM tenant.ozon_sales;"
```
Expected: `DELETE N` (~3600+); дальше Step 1 наполняет таблицу заново честными строками.

- [ ] **Step 1: Бэкфилл Ozon** (окно с 01.05 — начало истории заказов; порядок сборщиков в списке не важен, оркестратор соблюдает инвариант accruals→costs сам; таймаут поднят на время бэкфилла)

Run: `set -a; . /etc/saas-worker.env; set +a; cd /opt/agents/saas && SAAS_COLLECTOR_TIMEOUT_SEC=3600 python3 -m worker.orchestrator --all --collectors ozon_orders,ozon_sales,ozon_accruals,ozon_order_costs --date-from 2026-05-01 --date-to $(date +%F)`
Expected: все сборщики exit 0; в логе ozon_orders «отправлений fbo ~3200+, fbs ~57».

- [ ] **Step 2: Бэкфилл delivered_dt по всей истории** (одним UPDATE от админа — RLS обходится, все кабинеты сразу; та же семантика, что в `update_ozon_delivered_dt`)

```bash
PGPASSFILE=/root/.pgpass-admin psql -h localhost -U postgres -d saas -c "
UPDATE tenant.ozon_orders o
   SET delivered_dt = d.dt, updated_at = now()
  FROM (SELECT cabinet_id, unit_number, MIN(date)::text AS dt
          FROM tenant.ozon_accruals
         WHERE type_id IN (28,29,30) AND unit_number IS NOT NULL AND unit_number <> ''
         GROUP BY cabinet_id, unit_number) d
 WHERE o.cabinet_id = d.cabinet_id AND o.posting_number = d.unit_number
   AND o.delivered_dt IS DISTINCT FROM d.dt;"
```
Expected: `UPDATE N`, N в районе полутора тысяч и больше.

- [ ] **Step 3: Смоук-сторож** — записать `scripts/check-geo-foundation.sql` и прогнать

```sql
-- Смоук-сторож фундамента «Географии 2.0» (этап 1). Запуск:
--   psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-geo-foundation.sql
-- Все четыре проверки должны отдать ok=t.

-- 1. Склад Ozon больше не пустой (свежие FBO-заказы)
SELECT 'ozon_warehouse_filled' AS check,
       COUNT(*) FILTER (WHERE warehouse='') = 0 AS ok, COUNT(*) AS n
FROM tenant.ozon_orders WHERE scheme='fbo' AND order_dt >= '2026-06-01';

-- 2. FBS-постинги появились и попали в деньги
SELECT 'ozon_fbs_in_money' AS check,
       COUNT(DISTINCT o.posting_number) > 0
       AND COUNT(DISTINCT c.posting_number) > 0 AS ok,
       COUNT(DISTINCT o.posting_number) AS fbs_orders,
       COUNT(DISTINCT c.posting_number) AS fbs_costs
FROM tenant.ozon_orders o
LEFT JOIN tenant.ozon_order_costs c
       ON c.cabinet_id=o.cabinet_id AND c.posting_number=o.posting_number
WHERE o.scheme='fbs';

-- 3. delivered_dt покрывает большинство доставленных (последняя миля ~89%)
SELECT 'ozon_delivered_dt' AS check,
       COUNT(*) FILTER (WHERE delivered_dt IS NOT NULL)::float / GREATEST(COUNT(*),1) > 0.7 AS ok,
       COUNT(*) FILTER (WHERE delivered_dt IS NOT NULL) AS with_dd, COUNT(*) AS delivered
FROM tenant.ozon_orders WHERE status='delivered' AND order_dt >= '2026-06-01';

-- 4. Поставки WB собраны, лаг отгрузки на СЦ считается
SELECT 'wb_supplies' AS check,
       COUNT(*) > 0 AND COUNT(scan_dt) > 0 AS ok,
       COUNT(*) AS supplies, COUNT(scan_dt) AS scanned
FROM tenant.wb_supplies;
```
Run: `psql "host=localhost dbname=saas user=saas_ro" -X -f scripts/check-geo-foundation.sql`
Expected: четыре строки, все `ok = t`.

- [ ] **Step 4: Финансовая сверка** (правило: расхождение = наш баг)

1) Существующий сторож сверки прибыли: `systemctl start saas-ozon-recon.service && journalctl -u saas-ozon-recon.service -n 30 --no-pager` — Expected: PASS/OK, без новых расхождений.
2) Полнота FBS в деньгах: у каждого доставленного FBS-постинга, по которому есть начисления, должны появиться строки costs (0 «сирот»):
```bash
psql "host=localhost dbname=saas user=saas_ro" -X -c "
WITH fbs AS (SELECT DISTINCT cabinet_id, posting_number FROM tenant.ozon_orders
             WHERE scheme='fbs' AND status='delivered')
SELECT COUNT(*) AS fbs_delivered,
       COUNT(*) FILTER (WHERE NOT EXISTS
         (SELECT 1 FROM tenant.ozon_order_costs c
           WHERE c.cabinet_id=f.cabinet_id AND c.posting_number=f.posting_number)) AS without_costs,
       (SELECT ROUND(SUM(a.accrued)::numeric,2) FROM tenant.ozon_accruals a
         JOIN fbs f2 ON f2.cabinet_id=a.cabinet_id AND f2.posting_number=a.unit_number) AS fbs_accrued_sum
FROM fbs f;"
```
Expected: `without_costs = 0`; `fbs_accrued_sum` — ненулевая (справочно, для отчёта владельцу). Любой «сирота» = стоп и разбор через `ozon_profit_map.py`/`ozon_order_costs.py`, а не подгонка проверки.

- [ ] **Step 5: Полный тик воркера** (регресс: ничего не сломали в остальных сборщиках)

Run: `cd /opt/agents/saas && ./worker/run_saas_collect.sh main; echo "exit=$?"`
Expected: exit=0, в логе `/opt/agentsDB/logs/saas_worker.log` все сборщики без ошибок, включая новые поля.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-geo-foundation.sql
git commit -m "chore(scripts): смоук-сторож фундамента географии (склад, FBS в деньгах, delivered_dt, поставки)"
```

---

## После завершения этапа

- Обновить память (`worker-hardening…`/новый файл): что задеплоено, счётчики сверки.
- Сообщить владельцу: FBS Ozon теперь в цифрах панели (выручка/прибыль подрастут задним числом с мая) — ждать вопрос «почему цифры изменились» и сослаться на сверку.
- Этап 2 (канон + витрина) — отдельный план; открытый вопрос туда: карта «город покупателя → кластер Ozon» (527 городов; решение — статический справочник город→ФО + кластер→ФО).
