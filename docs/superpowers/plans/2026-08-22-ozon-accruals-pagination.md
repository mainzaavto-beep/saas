# Курсор last_id в начислениях Ozon + детекторы глубины — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Начисления Ozon читаются целиком при любом объёме (все страницы last_id); offset-циклы перестают молчать при аномальной глубине.

**Architecture:** Цикл по курсору в `ozon_client.accrual_by_day` (с защитой от зацикливания), удаление ставшего лишним `check_single_page`, синтетический тест стыков страниц, депт-детекторы в трёх циклах.

**Tech Stack:** Python (worker). Панель не трогается.

**Спека:** `docs/superpowers/specs/2026-08-22-ozon-accruals-pagination-design.md` (71d50c9).

## Global Constraints

- Правки сборщиков = мгновенный деплой (плановые тики). Логика записи НЕ меняется (DELETE+INSERT окна идемпотентен); меняется только полнота чтения.
- БД читать под `saas_ro` (BYPASSRLS → явный `WHERE cabinet_id`), не писать (прогоны сборщиков — идемпотентные, разрешены).
- Сторожа после задач: `node scripts/check-ozon-accruals.mjs 1 …` / `1008 …` (форма вызова — как в deploy/systemd/saas-ozon-recon.service), `node scripts/check-profit-canon.mjs`, `node scripts/profit-snapshot.mjs --verify` — ALL PASS.
- Комментарии по-русски. Расхождение цифр = наш баг.
- Никакого шлюза владельца: на текущих объёмах изменение обязано быть no-op (задача 4 это доказывает Δ=0).

---

### Task 1: Пагинация accrual_by_day + удаление check_single_page

**Files:**
- Modify: `worker/collectors/ozon_client.py` (:403-412 `accrual_by_day`)
- Modify: `worker/collectors/ozon_accruals.py` (:39-41 докстрока, :185-199 `check_single_page`, :305-309 вызов)

**Interfaces:**
- Produces: `accrual_by_day(date) -> {"accruals": [...все страницы...], "pages": N}` (ключ `last_id` из ответа НАРУЖУ больше не отдаётся); `ACCRUAL_MAX_PAGES = 200` (константа модуля ozon_client).

- [ ] **Step 1: Найти всех потребителей** `accrual_by_day` и `check_single_page`: `grep -rn "accrual_by_day\|check_single_page" worker/ scripts/`. Ожидаемо: `ozon_accruals.py` и, возможно, `scripts/check-ozon-accruals-parse.py` — каждый найденный потребитель адаптируется в этом же коммите (если parse-скрипт читает `data["accruals"]` — совместимо; если читает `last_id` — убрать это чтение с комментарием).

- [ ] **Step 2: ozon_client.py** — заменить `accrual_by_day` (докстроку про «пагинация не реализована — гадать» заменить на актуальную):

```python
ACCRUAL_MAX_PAGES = 200  # потолок страниц/день: выше — что-то не так с курсором


    def accrual_by_day(self, date) -> dict:
        """POST /v1/finance/accrual/by-day — начисления за сутки по методу
        начислений, ВСЕ страницы (курсор last_id; реализовано 2026-08-22 —
        «до онбординга крупных клиентов», спека ozon-accruals-pagination).
        Возвращает {"accruals": [...все строки...], "pages": N} — last_id
        наружу не отдаётся, потребителю он больше не нужен.
        Защита от зацикливания (урок iter_postings 2026-07-02: API может
        игнорировать курсор и отдавать ту же страницу): повтор last_id или
        больше ACCRUAL_MAX_PAGES страниц → RuntimeError; вызывающий сборщик
        обрабатывает это как partial, окно НЕ записывается — громкий отказ
        вместо молчаливо неполного дня (принцип check_single_page, который
        этот цикл заменяет)."""
        accruals = []
        seen_last_ids = set()
        pages = 0
        last_id = ""
        while True:
            body = {"date": _date_iso(date)}
            if last_id:
                body["last_id"] = last_id
            data = self._post(self.host, "/v1/finance/accrual/by-day", body)
            pages += 1
            page_rows = data.get("accruals") or [] if isinstance(data, dict) else []
            accruals.extend(page_rows)
            last_id = (data.get("last_id") or "") if isinstance(data, dict) else ""
            if not last_id or not page_rows:
                break
            if last_id in seen_last_ids:
                raise RuntimeError(
                    f"accrual_by_day({_date_iso(date)}): повтор last_id={last_id!r} "
                    f"— API игнорирует курсор, день собрать целиком нельзя")
            seen_last_ids.add(last_id)
            if pages >= ACCRUAL_MAX_PAGES:
                raise RuntimeError(
                    f"accrual_by_day({_date_iso(date)}): {pages} страниц — "
                    f"превышен потолок ACCRUAL_MAX_PAGES")
            time.sleep(1.0)  # межстраничная пауза: проба 2026-08-11 ловила code 8
        return {"accruals": accruals, "pages": pages}
```
⚠️ Проверить, что `import time` в ozon_client.py есть (если нет — добавить). Константу разместить на уровне модуля (не класса) рядом с другими.

- [ ] **Step 3: ozon_accruals.py** — удалить `check_single_page` целиком (:185-199) и упоминание в докстроке (:39-41); в `collect()` вызов (:308-309) заменить на счётчик страниц:

```python
        # Пагинация курсором last_id реализована в accrual_by_day (2026-08-22);
        # многостраничные дни — норма для крупных кабинетов, но видимость оставляем.
        if data.get("pages", 1) > 1:
            print(f"  {day}: {data['pages']} страниц начислений", flush=True)
```
Остальной код `collect()` (чтение `data.get("accruals")`, инварианты, upsert, ##OBS) — без изменений.

- [ ] **Step 4:** `python3 -m py_compile worker/collectors/ozon_client.py worker/collectors/ozon_accruals.py` → чисто. Сборщик НЕ запускать (прогон — задача 4).

- [ ] **Step 5: Commit**: `git add -A && git commit -m "feat(worker): accrual_by_day читает все страницы last_id (до онбординга крупных)"`

---

### Task 2: Синтетический тест стыков страниц

**Files:**
- Create: `scripts/test-ozon-accruals-pagination.py`

**Interfaces:**
- Consumes: `OzonClient.accrual_by_day` задачи 1 (подмена `_post`).
- Produces: `python3 scripts/test-ozon-accruals-pagination.py` → «OK 4/4», exit 0 (или assert-фейл, exit ≠0). В systemd НЕ добавляется.

- [ ] **Step 1: Написать тест** (без сети/БД; monkeypatch `_post` и `time.sleep`):

```python
#!/usr/bin/env python3
"""Синтетический тест пагинации accrual_by_day (спека 2026-08-22).
На живых данных многостраничности нет (кабинеты ≤2 тыс. заказов) — стыки
страниц проверяются только здесь. Без сети и БД: _post подменяется."""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker", "collectors"))
import ozon_client as oc


def make_client(pages):
    """pages: список ответов, которые _post отдаёт по очереди."""
    cli = oc.OzonClient.__new__(oc.OzonClient)   # без __init__ (не нужны креды)
    cli.host = "test"
    calls = {"n": 0, "bodies": []}
    def fake_post(host, path, body):
        calls["bodies"].append(dict(body))
        resp = pages[min(calls["n"], len(pages) - 1)]
        calls["n"] += 1
        return resp
    cli._post = fake_post
    return cli, calls


oc.time.sleep = lambda s: None  # межстраничные паузы в тесте не нужны

ok = 0

# 1) Две страницы склеиваются, курсор передан во 2-й запрос, pages=2.
cli, calls = make_client([
    {"accruals": [{"id": 1}, {"id": 2}], "last_id": "abc"},
    {"accruals": [{"id": 3}], "last_id": ""},
])
r = cli.accrual_by_day("2026-08-01")
assert [a["id"] for a in r["accruals"]] == [1, 2, 3], r
assert r["pages"] == 2, r
assert "last_id" not in calls["bodies"][0] and calls["bodies"][1].get("last_id") == "abc", calls
ok += 1

# 2) Повтор last_id → RuntimeError (API игнорирует курсор).
cli, _ = make_client([
    {"accruals": [{"id": 1}], "last_id": "loop"},
    {"accruals": [{"id": 1}], "last_id": "loop"},
])
try:
    cli.accrual_by_day("2026-08-01")
    raise AssertionError("ожидали RuntimeError на повторе last_id")
except RuntimeError as e:
    assert "повтор last_id" in str(e), e
ok += 1

# 3) Непустой last_id, но пустая вторая страница → стоп без ошибки.
cli, _ = make_client([
    {"accruals": [{"id": 1}], "last_id": "next"},
    {"accruals": [], "last_id": "next2"},
])
r = cli.accrual_by_day("2026-08-01")
assert len(r["accruals"]) == 1 and r["pages"] == 2, r
ok += 1

# 4) Одна страница (сегодняшняя норма): pages=1, один запрос.
cli, calls = make_client([{"accruals": [{"id": 7}], "last_id": ""}])
r = cli.accrual_by_day("2026-08-01")
assert r["pages"] == 1 and len(calls["bodies"]) == 1, (r, calls)
ok += 1

print(f"OK {ok}/4")
```
⚠️ Если конструктор `OzonClient` позволяет создание без кредов проще (посмотреть `__init__`) — использовать штатный путь вместо `__new__`; суть теста не менять.

- [ ] **Step 2:** `python3 scripts/test-ozon-accruals-pagination.py` → OK 4/4.
- [ ] **Step 3: Commit**: `git add scripts/test-ozon-accruals-pagination.py && git commit -m "test(worker): синтетические стыки страниц accrual_by_day"`

---

### Task 3: Детекторы глубины offset-циклов

**Files:**
- Modify: `worker/collectors/ozon_client.py` (`iter_stock` :292-304, `iter_analytics` :336-363)
- Modify: `worker/collectors/wb_prices.py` (:70-80 цикл)

- [ ] **Step 1: ozon_client.py** — константа `DEPTH_WARN_PAGES = 30` (уровень модуля, рядом с ACCRUAL_MAX_PAGES, комментарий: «аномальная глубина offset-пагинации — предупреждаем, не роняем»). В `iter_stock` и `iter_analytics` перед `offset += limit` добавить (однократная печать на цикл):

```python
            if offset // limit + 1 == DEPTH_WARN_PAGES:
                print(f"⚠️ {метод}: пагинация глубже {DEPTH_WARN_PAGES} страниц "
                      f"(offset={offset}) — проверить лимиты API", flush=True)
```
(`{метод}` — литеральные "iter_stock" / "iter_analytics".)

- [ ] **Step 2: wb_prices.py** — после цикла `while offset <= 50000` определить, вышли ли по потолку с полной последней страницей, и предупредить:

```python
    # Потолок 50000 — не молчим: полная последняя страница на потолке значит,
    # что каталог, вероятно, больше и снимок цен неполон (спека 2026-08-22).
    if offset > 50000 and last_page_full:
        print("⚠️ wb_prices: упёрлись в потолок offset=50000 при полной "
              "последней странице — возможен недобор каталога", flush=True)
```
Флаг `last_page_full = (len(items) == limit)` выставлять в теле цикла (посмотреть точную структуру по месту; существующую логику `break`/`seen` не менять).

- [ ] **Step 3:** `python3 -m py_compile worker/collectors/ozon_client.py worker/collectors/wb_prices.py` → чисто.
- [ ] **Step 4: Commit**: `git add -A && git commit -m "feat(worker): детекторы аномальной глубины offset-пагинации"`

---

### Task 4: No-op-прогон и сторожа

**Files:** нет (прогоны и SQL).

- [ ] **Step 1: Снимок ДО** (под saas_ro, по каждому кабинету 1 и 1008): `SELECT count(*), COALESCE(SUM(amount),0) FROM tenant.ozon_accruals WHERE cabinet_id=<id> AND date >= current_date - 45` — числа в отчёт. ⚠️ Имя суммируемой колонки сверить с фактической схемой (`information_schema.columns` для tenant.ozon_accruals) — если колонка называется иначе (accrued/total), взять её.
- [ ] **Step 2: Идемпотентный прогон** `ozon_accruals` кабинетов 1 и 1008 за стандартное 45-дневное окно — тем же механизмом запуска через оркестратор, что использовался в прошлых планах (рецепт в истории: onboarding/backfill-прогон; при блокировке классификатора — команда владельцу через `!`, не обходить). В stdout ожидаемо НЕТ строк «N страниц начислений» (все дни одностраничные сегодня).
- [ ] **Step 3: Снимок ПОСЛЕ** — те же SQL: count и сумма ОБЯЗАНЫ совпасть со Step 1 до копейки (Δ=0). Любое расхождение = находка, разбирать до конца (расхождение цифр = наш баг).
- [ ] **Step 4: Сторожа**: `check-ozon-accruals.mjs` оба кабинета, `check-profit-canon.mjs`, `profit-snapshot.mjs --verify` → ALL PASS.
- [ ] **Step 5:** Результаты в отчёт задачи; коммитов нет.

---

## Self-review (выполнено при написании)

- Покрытие спеки: компонент 1 (T1+T2), компонент 2 (T3), компонент 3 (T4). «Что НЕ входит» не нарушено (iter_postings/finance/каталоги не тронуты).
- Типы/имена: `{"accruals", "pages"}` согласованы между T1 и T2; `ACCRUAL_MAX_PAGES`/`DEPTH_WARN_PAGES` — модульные константы ozon_client.
- Ловушки проверены: `_date_iso` существует (используется текущим кодом accrual_by_day); межстраничная пауза наследует грабли rate-limit (code 8); тест не требует кредов/сети.
- Плейсхолдеров нет; два ⚠️ — команды проверки по месту (кол-во колонки, __init__ клиента), не дыры.
