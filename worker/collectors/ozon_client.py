"""
Клиент Ozon Seller API.

Авторизация — два заголовка: Client-Id и Api-Key (берутся из окружения).
Особенность Ozon: почти все методы «чтения» — это POST с JSON-телом (не GET).
Пагинация — cursor через last_item_id + limit.

Клиент знает только о ЧТЕНИИ. Побочные действия (ответ на отзыв, смена медиа) —
в отдельном классе (используется менеджером, см. manager/ozon_agent/sources/ozon_api.py),
вызывается ТОЛЬКО после подтверждения proposals.json.

Эндпоинты по документации Ozon на начало 2026 (api-seller.ozon.ru).
Проверяй актуальность на docs.ozon.ru/api/seller — их периодически меняют.
"""
from __future__ import annotations
import os
import random
import time
from typing import Any, Iterator

import requests

REQUEST_PAUSE_SEC = 1.0  # ≥1 с между страницами пагинации (см. iter_postings) —
                         # тот же лимит и та же константа, что в ozon_accruals.py

ACCRUAL_MAX_PAGES = 200  # потолок страниц/день: выше — что-то не так с курсором

# Тот же принцип потолка/защиты от зацикливания курсора, что ACCRUAL_MAX_PAGES
# (см. accrual_by_day) — переиспользуется в stocks_by_warehouse_fbs,
# iter_supply_order_ids, supply_order_bundle_items (ревью раунд 1, 2026-09-06:
# ни один из трёх циклов не имел guard'а на повтор курсора).
CURSOR_MAX_PAGES = 200

DEPTH_WARN_PAGES = 30  # аномальная глубина offset-пагинации — предупреждаем, не роняем

# --- Ретраи/бэкофф одного HTTP-запроса (флап Ozon API 25-27.08.2026: /v1/finance/
# accrual/types и /v1/analytics/data периодически не отвечают — таймаут/обрыв
# соединения без HTTP-статуса — по несколько минут подряд, баннер зажигался почти
# каждый прогон). Экспоненциальный бэкофф с джиттером: пауза перед повтором =
# BASE_DELAY_SEC * 2^attempt + random[0, JITTER_SEC) — т.е. между 5 попытками паузы
# ~2с → 4с → 8с → 16с (+ до 1с джиттера). Джиттер нужен, чтобы параллельные кабинеты/
# сборщики не били по Ozon синхронной волной ретраев ровно в момент, когда API
# отходит от сбоя (thundering herd после общего восстановления).
RETRY_ATTEMPTS = 5
RETRY_BASE_DELAY_SEC = 2.0
RETRY_JITTER_SEC = 1.0

# Per-request timeout снижен с прежних 60с до 20с (правка 2026-08-27, флап Ozon).
# Причина: при 5 попытках по 60с ОДИН полностью исчерпанный запрос стоил бы ~5.5 мин —
# а COLLECTOR_TIMEOUT сборщика (worker/orchestrator.py) = 900с, и сборщик делает
# десятки запросов за прогон. 2-3 таких запроса съедали бы весь бюджет прогона ещё
# ДО того, как воркер узнает о проблеме (процесс просто убьют по timeout без внятного
# сообщения — то же самое, от чего лечит задача 4 ниже). 20с — с запасом больше
# типичного времени ответа Ozon (обычно секунды), но достаточно мало, чтобы 5 попыток
# с бэкоффом укладывались в ~2 мин worst-case на один запрос (см. арифметику в отчёте).
REQUEST_TIMEOUT_SEC = 20

SELLER_HOST = "https://api-seller.ozon.ru"
# ВНИМАНИЕ: api-analytics.ozon.ru НЕ резолвится с нашего сервера (проверено в Фазе 2,
# 2026-06-17). Все методы, которые раньше шли на analytics_host
# (/v2/analytics/stock_on_warehouses, /v1/analytics/data), проверены и РАБОТАЮТ
# на seller-host с теми же заголовками. Поэтому по умолчанию analytics_host =
# seller-host. Если отдельный analytics-хост когда-нибудь заработает, верните
# константу ANALYTICS_HOST выше.
ANALYTICS_HOST = SELLER_HOST


class OzonError(RuntimeError):
    """Ошибка Ozon API (с code/message из тела ответа)."""


class OzonClient:
    def __init__(self, client_id: str | None = None, api_key: str | None = None,
                 host: str = SELLER_HOST, analytics_host: str = ANALYTICS_HOST):
        self.client_id = client_id or os.getenv("OZON_CLIENT_ID", "")
        self.api_key = api_key or os.getenv("OZON_API_KEY", "")
        self.host = host
        self.analytics_host = analytics_host
        if not (self.client_id and self.api_key):
            raise OzonError("Не заданы OZON_CLIENT_ID / OZON_API_KEY в окружении.")

    def _headers(self) -> dict:
        return {
            "Client-Id": self.client_id,
            "Api-Key": self.api_key,
            "Content-Type": "application/json",
        }

    def _request(self, method: str, host: str, path: str, body: dict | None = None,
                 retries: int = RETRY_ATTEMPTS, timeout: int = REQUEST_TIMEOUT_SEC) -> dict:
        """HTTP-запрос с ретраями на флап Ozon API: таймаут/обрыв соединения, 5xx, 429.
        Экспоненциальный бэкофф с джиттером — см. RETRY_*/REQUEST_TIMEOUT_SEC вверху файла.
        4xx-логические ошибки (400/403/404 и т.п., КРОМЕ 429) — это ошибка запроса,
        не флап сети: ретраить бессмысленно, поднимаем OzonError сразу, без пауз.
        429 — уважаем Retry-After (секунды, стандартный заголовок), если Ozon его
        не отдаёт — X-RateLimit-Reset, иначе свой экспоненциальный бэкофф.
        method: 'post' | 'get'. Для GET body игнорируется (Ozon /v1/actions — GET).

        При исчерпании всех попыток сообщение включает ПОСЛЕДНЮЮ причину, число
        попыток и реальное затраченное время (было — голое «: None» на некоторых
        путях исчерпания, т.к. причина не сохранялась для 429/5xx — см. отчёт
        ozon-client-retries.md)."""
        url = host.rstrip("/") + path
        last_reason = "неизвестная причина"
        start = time.monotonic()
        for attempt in range(retries):
            is_last = attempt == retries - 1
            try:
                if method.lower() == "get":
                    r = requests.get(url, headers=self._headers(), timeout=timeout)
                else:
                    r = requests.post(url, headers=self._headers(), json=body or {},
                                      timeout=timeout)
            except requests.RequestException as e:
                last_reason = f"{type(e).__name__}: {e}"
                if is_last:
                    break
                time.sleep(_backoff_delay(attempt))
                continue

            if r.status_code == 429:
                # У Ozon лимит по окну — ждём столько, сколько говорит Ozon, иначе
                # свой экспоненциальный бэкофф (не голые 30/60с, как раньше).
                last_reason = "429 too many requests"
                if is_last:
                    break
                retry_after = r.headers.get("Retry-After")
                reset = r.headers.get("X-RateLimit-Reset")
                if retry_after and retry_after.replace(".", "", 1).isdigit():
                    wait = min(float(retry_after), 60.0)
                elif reset and reset.replace(".", "", 1).isdigit():
                    wait = min(float(reset), 60.0)
                else:
                    wait = _backoff_delay(attempt)
                # 05.09.2026: Ozon стал отдавать крошечный Retry-After — все 5
                # попыток сгорали за 4с и исчерпание билось почти сразу.
                # Пол ожидания — наш экспоненциальный бэкофф: заголовок Ozon
                # уважаем, но не короче нижнего предела. Потолок 60с как был.
                wait = max(wait, _backoff_delay(attempt))
                time.sleep(wait)
                continue

            if r.status_code >= 500:
                last_reason = f"{r.status_code} server error: {r.text[:200]}"
                if is_last:
                    break
                time.sleep(_backoff_delay(attempt))
                continue

            # 4xx (кроме 429) — не флап, а ошибка запроса. Разбор тела и немедленный
            # отказ БЕЗ ретраев. Ozon возвращает JSON с code/message.
            try:
                data = r.json()
            except ValueError:
                r.raise_for_status()
                raise
            if r.status_code >= 400:
                code = data.get("code")
                msg = data.get("message") or data.get("error", {}).get("message") or r.text
                raise OzonError(f"Ozon API {r.status_code} [{code}]: {msg}")
            return data.get("result", data)

        elapsed = time.monotonic() - start
        raise OzonError(
            f"Исчерпаны попытки запроса {path}: {last_reason} "
            f"после {retries} попыток за {elapsed:.0f}с")

    def _post(self, host: str, path: str, body: dict | None = None,
              retries: int = RETRY_ATTEMPTS, timeout: int = REQUEST_TIMEOUT_SEC) -> dict:
        """POST с retry/backoff (делегирует в _request)."""
        return self._request("post", host, path, body, retries, timeout)

    def _get(self, host: str, path: str, retries: int = RETRY_ATTEMPTS,
             timeout: int = REQUEST_TIMEOUT_SEC) -> dict:
        """GET с retry/backoff (делегирует в _request). Для /v1/actions и др."""
        return self._request("get", host, path, None, retries, timeout)

    # --- КАТАЛОГ: справочник товаров ---

    def products_list(self, limit: int = 1000, visibility: str = "ALL") -> dict:
        """Список product_id + offer_id (пагинация last_id).

        С 2026 Ozon отключил /v2/product/list — используем /v3/product/list
        (схема filter/limit/last_id та же). См. dev.ozon.ru/news/497.
        """
        return self._post(self.host, "/v3/product/list",
                          {"filter": {"visibility": visibility}, "limit": limit})

    def product_info(self, product_ids: list[int], sku: int = 0) -> list[dict]:
        """Детальная инфо по товарам (offer_id, имя, штрихкод, категория).

        /v2/product/info/list отключён — используем /v3/product/info/list.
        ВАЖНО: v3 принимает массив ОДНОГО типа идентификаторов. Передаём
        только product_id (массив). Параметр sku скаляром тут недопустим —
        Ozon вернёт «proto: syntax error ... unexpected token».
        Бьём батчами по 1000 (лимит метода).
        """
        out: list[dict] = []
        for i in range(0, len(product_ids), 1000):
            chunk = product_ids[i:i + 1000]
            data = self._post(self.host, "/v3/product/info/list",
                              {"product_id": chunk})
            out.extend(data.get("items", []) if isinstance(data, dict) else data)
        return out

    def iter_all_products(self, visibility: str = "ALL") -> Iterator[dict]:
        """Итератор по всем товарам (курсор last_id). /v3/product/list с 2026."""
        last_id = ""
        while True:
            body = {"filter": {"visibility": visibility}, "limit": 1000}
            if last_id:
                body["last_id"] = last_id
            data = self._post(self.host, "/v3/product/list", body)
            items = data.get("items", [])
            for it in items:
                yield it
            last_id = data.get("last_id", "")
            if not last_id or not items:
                break

    def product_info_attributes(self, product_ids: list[int],
                                visibility: str = "ALL") -> list[dict]:
        """Габариты и атрибуты товаров: /v4/product/info/attributes.

        Возвращает items[] (по одному на товар). На верхнем уровне каждого item:
          weight (г), weight_unit, dimension_unit,
          height/width/depth (мм) — ВНИМАНИЕ: поле называется 'depth', не 'length',
          volume_weight отсутствует тут (он в /v3/product/info/list),
          description_category_id, type_id (нужны для тарифа).
        Бьём батчами по 1000 (лимит метода). Фильтр по visibility обязателен.
        """
        out: list[dict] = []
        for i in range(0, len(product_ids), 1000):
            chunk = product_ids[i:i + 1000]
            data = self._post(self.host, "/v4/product/info/attributes",
                              {"filter": {"product_id": chunk, "visibility": visibility},
                               "limit": 1000})
            items = data.get("items", []) if isinstance(data, dict) else data
            out.extend(items)
        return out

    def category_tree(self) -> list[dict]:
        """Дерево категорий Ozon: /v1/description-category/tree (№30, 2026-06-21).

        Возвращает result[] (29 категорий верхнего уровня), каждая с рекурсивным
        children[]. Узлы-категории: {description_category_id, category_name, children}.
        Листья-типы: {type_id, type_name, children}. Используется для построения
        id→полный-путь карты (напр. «Мебель / Чехлы для мебели / Чехол на диван»).

        ⚠️ `/v2/category/tree` (старый endpoint) даёт 404 в API 2026 — использовать /v1.
        Сверено 2026-06-21 (#85).
        """
        data = self._post(self.host, "/v1/description-category/tree", {})
        # _post уже разворачивает result (см. _post: возвращает распарсенный JSON, который
        # для этого endpoint'а = список категорий). Поэтому возвращаем как есть.
        if isinstance(data, list):
            return data
        return data.get("result") or []

    def product_info_prices(self, product_ids: list[int],
                            visibility: str = "ALL") -> list[dict]:
        """Цены товаров: /v5/product/info/prices (DATA_CONTRACT №21, 2026-06-20).

        ⚠️ ВАЖНО: рабочий endpoint — /v5, НЕ /v4 (как писали ТЗ и старая память
        ozon-agent). /v4/product/info/prices даёт 404 в API 2026 — проверено живым
        запросом (урок #18: имена полей/версии сверять живым запросом, не докой).

        Возвращает items[] (по одному на товар). Структура каждого item (проверена
        на 66 товарах 2026-06-20):
          product_id, offer_id,
          price: {price, old_price, marketing_seller_price, min_price, retail_price,
                  net_price, vat, currency_code, ...},
          commissions: {sales_percent_fbo, fbo_deliv_to_customer_amount, ...} (повтор /v3),
          marketing_actions, price_indexes, acquiring, volume_weight.

        ⚠️ ВАЖНО про поля цены (правка №22, 2026-06-20, gotcha #57):
          - price.marketing_seller_price — цена ПРОДАВЦА со скидкой (включая акции
            Ozon/соинвест). СТАБИЛЬНА, всегда > 0. ЭТО ИСТОЧНИК для products.price.
          - price.price — «розничная цена», НО при активной акции Ozon = цена БЕЗ акции
            (завышена: 7777 вместо 3300 на «плитке 90*160»). НЕ использовать для цены
            со скидкой. Без акции price == marketing_seller_price.
          - price.old_price — зачёркнутая (до скидки). Цена покупателя с соинвестом
            в API не отдаётся (динамическая Ozon-скидка, считается на лету).
        Бьём батчами по 1000, фильтр visibility обязателен.
        """
        out: list[dict] = []
        for i in range(0, len(product_ids), 1000):
            chunk = product_ids[i:i + 1000]
            data = self._post(self.host, "/v5/product/info/prices",
                              {"filter": {"product_id": chunk, "visibility": visibility},
                               "limit": 1000})
            items = data.get("items", []) if isinstance(data, dict) else data
            out.extend(items)
        return out

    # --- ЗАКАЗЫ/ПРОДАЖИ: posting fbo ---

    def posting_fbo_list(self, since, to, status: str | None = None,
                         limit: int = 50, cursor: str | None = None) -> dict:
        """Список отправлений FBO за период. since/to — datetime, status — фильтр статуса.
        Пагинация — КУРСОРНАЯ через поле cursor (API 2026). Ozon отдаёт cursor в ответе;
        его нужно передать в следующем запросе, чтобы получить следующую страницу.
        ВАЖНО (фикс 2026-07-02): старая модель last_id/offset УСТАРЕЛА — API её игнорирует
        и отдаёт одну и ту же первую страницу → бесконечный цикл → сборщик зависал
        (Ozon стоял на 25.06). Корректная пагинация — только cursor."""
        body: dict[str, Any] = {
            "dir": "ASC",
            "filter": {
                "since": _iso(since),
                "to": _iso(to),
            },
            "limit": limit,
            "translit": False,
            "with": {"analytics_data": True, "financial_data": True},
        }
        if status:
            body["filter"]["status"] = status
        if cursor:
            body["cursor"] = cursor
        return self._post(self.host, "/v3/posting/fbo/list", body)

    def iter_postings(self, since, to, status: str | None = None) -> Iterator[dict]:
        """Итератор по всем отправлениям FBO за период (КУРСОРНАЯ пагинация API 2026).
        На каждой странице Ozon возвращает cursor — передаём его в следующий запрос.
        Выход: has_next=false или пустая страница. Защита от зацикливания: проверяем,
        что cursor меняется между запросами (иначе break — не зависнем как раньше).
        Пауза ≥1 с ПЕРЕД каждой страницей, кроме первой (тот же приём и константа
        REQUEST_PAUSE_SEC, что в ozon_accruals.py — Ozon лимитирует частые подряд
        запросы; расширение окна ozon_orders до 45 дней даёт заметно больше страниц
        на кабинет с активными продажами)."""
        limit = 50
        cursor = None
        seen_cursors = set()
        first = True
        while True:
            if not first:
                time.sleep(REQUEST_PAUSE_SEC)
            first = False
            data = self.posting_fbo_list(since, to, status, limit, cursor)
            postings = data.get("postings", []) if isinstance(data, dict) else []
            for p in postings:
                yield p
            has_next = data.get("has_next", False) if isinstance(data, dict) else False
            new_cursor = data.get("cursor") if isinstance(data, dict) else None
            if not has_next or not postings or not new_cursor:
                break
            # Защита от зацикливания: если курсор не меняется — выходим (API баг/старый).
            if new_cursor in seen_cursors:
                break
            seen_cursors.add(new_cursor)
            cursor = new_cursor

    # --- ЗАКАЗЫ/ПРОДАЖИ: posting fbs ---

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

    # --- СПРАВОЧНИКИ: кластеры/склады ---

    def cluster_list(self, cluster_type: str = "CLUSTER_TYPE_OZON") -> list:
        """Справочник кластеров: кластер → logistic_clusters → склады.
        Ответ приходит БЕЗ обёртки result (проверено живым API 28.08.2026)."""
        res = self._post(self.host, "/v1/cluster/list", {"cluster_type": cluster_type}) or {}
        return res.get("clusters") or []

    # --- СКЛАДЫ ПРОДАВЦА / FBS-ОСТАТКИ / ЗАКАЗЫ НА ПОСТАВКУ (план «Склады 2.0», этап 1) ---

    def warehouse_list(self) -> list:
        """Склады продавца (FBS/rFBS): POST /v2/warehouse/list, тело пустое.
        v1 отключён Ozon 07.04.2026 («obsolete method cannot be used», код 9, живая проба
        задачи 5 плана «Склады 2.0» 06.09.2026) — поля ответа те же (warehouse_id, name,
        is_rfbs, status, ...), поменялся путь. Ответ оборачивает список НЕ в result
        (там нет такого ключа — _request отдаёт весь dict как есть), а в "warehouses"
        (проверено живым запросом 06.09.2026) — снимаем обёртку явно."""
        res = self._post(self.host, "/v2/warehouse/list", {})
        if isinstance(res, list):
            return res
        return (res or {}).get("warehouses") or (res or {}).get("result") or []

    def stocks_by_warehouse_fbs(self, skus: list, chunk: int = 100) -> list:
        """FBS-остатки по складам продавца: POST /v2/product/info/stocks-by-warehouse/fbs.
        v1 отключён Ozon («obsolete method cannot be used», код 9 — та же ошибка и тот же
        код, что при отключении /v1/warehouse/list, см. warehouse_list выше; проверено живым
        запросом задачи 7 плана «Склады 2.0» 06.09.2026) — путь /v2 с тем же суффиксом
        подтверждён отдельным живым запросом в тот же день (см. также тему на dev.ozon.ru
        «/v2/product/info/stocks-by-warehouse/fbs»).

        Тело v2 ИНАЧЕ устроено, чем было в v1: {sku:[str], limit:int, cursor:str}. limit —
        НЕ длина sku[], а размер СТРАНИЦЫ РЕЗУЛЬТАТА (число строк products в ответе, ≤1000,
        400 при значении вне (0,1000]) — передаём максимум 1000. Ответ оборачивает список
        в "products" (НЕ "result", НЕ голый список, как было в v1): {products:[{sku, present,
        reserved, warehouse_id, warehouse_name, product_id, offer_id, free_stock}],
        has_next: bool, cursor: str}. Пачки ВХОДНЫХ sku — по chunk (100, лимит эндпоинта на
        размер sku[] уточняется пробой, при 400 — уменьшить); внутри каждой пачки —
        отдельная пагинация по has_next/cursor (на пробе 06.09.2026 с ≤145 sku всегда
        has_next=False за один запрос, но у продавца с большим числом складов на sku
        страница может не уместиться в limit=1000)."""
        # Пачки — непересекающиеся срезы skus, страницы курсора внутри пачки идут строго
        # последовательно (курсор предыдущего ответа → тело следующего запроса), поэтому
        # (warehouse_id, sku) в out не могут повториться — дедуп не нужен.
        out = []
        for i in range(0, len(skus), chunk):
            if i:
                time.sleep(REQUEST_PAUSE_SEC)
            part = [str(s) for s in skus[i:i + chunk]]
            cursor = ""
            seen_cursors = set()
            pages = 0
            while True:
                body = {"sku": part, "limit": 1000}
                if cursor:
                    body["cursor"] = cursor
                res = self._post(self.host, "/v2/product/info/stocks-by-warehouse/fbs", body)
                pages += 1
                if isinstance(res, dict):
                    out.extend(res.get("products") or [])
                    cursor = res.get("cursor") or ""
                    if not res.get("has_next") or not cursor:
                        break
                    if cursor in seen_cursors:
                        raise OzonError(
                            f"stocks_by_warehouse_fbs: повтор курсора={cursor!r} "
                            f"— API игнорирует курсор, остатки собрать целиком нельзя")
                    seen_cursors.add(cursor)
                    if pages >= CURSOR_MAX_PAGES:
                        raise OzonError(
                            f"stocks_by_warehouse_fbs: {pages} страниц — "
                            f"превышен потолок CURSOR_MAX_PAGES")
                else:
                    out.extend(res or [])
                    break
                time.sleep(REQUEST_PAUSE_SEC)
        return out

    # Состояния заказа на поставку FBO для /v3/supply-order/list (проба 2026-09-06):
    # ЦЕЛЫЕ коды 1..11 БЕЗ префикса ORDER_STATE_ (0 и ≥12 — 400 invalid). Это
    # «все состояния» — конкретных имён состояний per-код API не документирует.
    SUPPLY_ORDER_STATES = list(range(1, 12))

    def iter_supply_order_ids(self, limit: int = 100) -> Iterator[int]:
        """Заказы на поставку FBO: POST /v3/supply-order/list (обновлено 2026-09-06 —
        Ozon отключил /v2/supply-order/list, отвечал 404 "page not found"; проверено
        живым вызовом api-seller.ozon.ru). Отличия /v3 от /v2:
        - filter.states ОБЯЗАТЕЛЕН и не может быть пустым (иначе 400) — передаём все
          коды SUPPLY_ORDER_STATES;
        - тело требует sort_by ≠ 0 (используем 1);
        - курсор — непрозрачная строка last_id (не число last_supply_order_id);
        - ответ {"order_ids": [int,...], "last_id": "<cursor|''>"}, а не
          {"supply_order_id": [...], "last_supply_order_id": ...}."""
        cursor = ""
        seen_last_ids = set()
        pages = 0
        while True:
            body = {"filter": {"states": self.SUPPLY_ORDER_STATES}, "limit": limit, "sort_by": 1}
            if cursor:
                body["last_id"] = cursor
            res = self._post(self.host, "/v3/supply-order/list", body) or {}
            pages += 1
            ids = res.get("order_ids") or []
            for i in ids:
                yield int(i)
            last = res.get("last_id") or ""
            if not ids or not last:
                break
            if last in seen_last_ids:
                raise OzonError(
                    f"iter_supply_order_ids: повтор курсора last_id={last!r} "
                    f"— API игнорирует курсор, список заказов собрать целиком нельзя")
            seen_last_ids.add(last)
            if pages >= CURSOR_MAX_PAGES:
                raise OzonError(
                    f"iter_supply_order_ids: {pages} страниц — "
                    f"превышен потолок CURSOR_MAX_PAGES")
            cursor = last
            time.sleep(REQUEST_PAUSE_SEC)

    def supply_order_get(self, order_ids: list, chunk: int = 50) -> dict:
        """POST /v3/supply-order/get по пачкам ≤ chunk (обновлено 2026-09-06 — /v2
        отключён так же, как /v2/supply-order/list). Возвращает {"orders": [...]}
        со склейкой всех пачек. В /v3 НЕТ top-level "warehouses" (был в /v2) — склад
        назначения приходит embedded-объектом в каждой supplies[].storage_warehouse
        (см. ozon_supply_orders.parse_orders)."""
        orders = []
        for i in range(0, len(order_ids), chunk):
            if i:
                time.sleep(REQUEST_PAUSE_SEC)
            res = self._post(self.host, "/v3/supply-order/get",
                             {"order_ids": [int(x) for x in order_ids[i:i + chunk]]}) or {}
            orders.extend(res.get("orders") or [])
        return {"orders": orders}

    def supply_order_bundle_items(self, bundle_ids: list, limit: int = 100) -> list:
        """Состав поставки: POST /v1/supply-order/bundle, пагинация last_id/has_next.
        Ответ: items [{sku, quantity, offer_id, ...}]."""
        out, last_id = [], None
        seen_last_ids = set()
        pages = 0
        while True:
            body = {"bundle_ids": list(bundle_ids), "limit": limit}
            if last_id:
                body["last_id"] = last_id
            res = self._post(self.host, "/v1/supply-order/bundle", body) or {}
            pages += 1
            out.extend(res.get("items") or [])
            if not res.get("has_next") or not res.get("last_id"):
                break
            last_id = res["last_id"]
            if last_id in seen_last_ids:
                raise OzonError(
                    f"supply_order_bundle_items: повтор курсора last_id={last_id!r} "
                    f"— API игнорирует курсор, состав поставки собрать целиком нельзя")
            seen_last_ids.add(last_id)
            if pages >= CURSOR_MAX_PAGES:
                raise OzonError(
                    f"supply_order_bundle_items: {pages} страниц — "
                    f"превышен потолок CURSOR_MAX_PAGES")
            time.sleep(REQUEST_PAUSE_SEC)
        return out

    # --- ОСТАТКИ ---

    def stock_on_warehouses(self, limit: int = 1000) -> dict:
        """Остатки по складам (аналитика). Пагинация offset."""
        return self._post(self.analytics_host, "/v2/analytics/stock_on_warehouses",
                          {"limit": limit, "offset": 0})

    def iter_stock(self) -> Iterator[dict]:
        """Итератор по остаткам по складам (offset-пагинация)."""
        limit = 1000
        offset = 0
        while True:
            data = self._post(self.analytics_host, "/v2/analytics/stock_on_warehouses",
                              {"limit": limit, "offset": offset})
            rows = data.get("rows", []) if isinstance(data, dict) else []
            for r in rows:
                yield r
            if len(rows) < limit:
                break
            if offset // limit + 1 == DEPTH_WARN_PAGES:
                print(f"⚠️ iter_stock: пагинация глубже {DEPTH_WARN_PAGES} страниц "
                      f"(offset={offset}) — проверить лимиты API", flush=True)
            offset += limit

    # --- АНАЛИТИКА: Rating Report (метрики по товарам/дням) ---

    def analytics_data(self, date_from, date_to, dimensions: list,
                       metrics: list[str], limit: int = 1000, offset: int = 0) -> dict:
        """Универсальный запрос /v1/analytics/data (Rating Report).

        ВАЖНО (2026): dimensions — это МАССИВ СТРОК, не объектов. Раньше Ozon
        принимал [{"name":"day"}, {"name":"sku"}], теперь строго ["day","sku"].
        Передавайте ["day","sku",...] — метод нормализует обе формы в строки.
        metrics — напр. ["ordered_units","hits_to_cart","revenue"].
        Запрос идёт на analytics_host, который по умолчанию = seller-host
        (см. ANALYTICS_HOST вверху файла).
        """
        # Нормализуем dimensions: [{"name":"x"}] → ["x"], ["x"] → ["x"]
        dims = []
        for d in dimensions:
            if isinstance(d, dict):
                dims.append(d.get("name", ""))
            else:
                dims.append(str(d))
        return self._post(self.analytics_host, "/v1/analytics/data", {
            "date_from": _date_iso(date_from),
            "date_to": _date_iso(date_to),
            "dimensions": dims,
            "metrics": metrics,
            "sort": [{"key": metrics[0], "order": "DESC"}] if metrics else [],
            "limit": limit,
            "offset": offset,
        })

    def iter_analytics(self, date_from, date_to, dimensions: list,
                       metrics: list[str]) -> Iterator[dict]:
        """Итератор по аналитике (offset-пагинация).

        Реальная структура ответа /v1/analytics/data (проверено 2026):
          {"data": [ {"dimensions":[{id,name},...], "metrics":[...]} , ...],
           "totals": [...]}
        Где data — СПИСОК записей (не data.rows). Каждая запись:
          dimensions[0] — day: {id:"YYYY-MM-DD", name:""}
          dimensions[1] — sku:  {id:"<sku>", name:"<название товара>"}
          metrics — список значений в порядке запроса.
        """
        limit = 1000
        offset = 0
        while True:
            data = self.analytics_data(date_from, date_to, dimensions, metrics, limit, offset)
            rows = []
            if isinstance(data, dict):
                d = data.get("data", [])
                if isinstance(d, list):      # актуальная структура
                    rows = d
                elif isinstance(d, dict):    # старый формат data.rows
                    rows = d.get("rows", [])
            for r in rows:
                yield r
            if len(rows) < limit:
                break
            if offset // limit + 1 == DEPTH_WARN_PAGES:
                print(f"⚠️ iter_analytics: пагинация глубже {DEPTH_WARN_PAGES} страниц "
                      f"(offset={offset}) — проверить лимиты API", flush=True)
            offset += limit

    # --- ФИНАНСЫ: операции ---

    def finance_transactions(self, since, to, limit: int = 1000, offset: int = 0) -> dict:
        """/v3/finance/transaction/list — операции за период (начисления/компенсации).

        ВАЖНО (2026): /v1 удалён, актуальный — /v3. Схема отличается от v1:
          - даты в filter.date.from / filter.date.to (НЕ date_from/date_to),
          - operation_type ждёт конкретное значение (OperationClaim, ...), НЕ "All".
            Чтобы получить ВСЕ операции — не передаём operation_type/transaction_type.
          - пагинация через page (номер страницы, с 1) + page_size, НЕ limit/offset.
            page_size в диапазоне (0, 1000].
        Ограничение: максимум 1 месяц за запрос.
        """
        # v3 ждёт page (1-based) и page_size, не offset/limit.
        page = (offset // limit) + 1
        return self._post(self.host, "/v3/finance/transaction/list", {
            "filter": {"date": {"from": _iso(since), "to": _iso(to)}},
            "page": page,
            "page_size": min(limit, 1000),
        })

    def iter_finance(self, since, to) -> Iterator[dict]:
        """Итератор по финоперациям (offset-пагинация)."""
        limit = 1000
        offset = 0
        while True:
            data = self.finance_transactions(since, to, limit, offset)
            ops = data.get("operations", []) if isinstance(data, dict) else []
            for op in ops:
                yield op
            if len(ops) < limit:
                break
            offset += limit

    # --- ФИНАНСЫ: начисления (метод accrual, задача 3 плана переезда финансов
    # Ozon на методы начислений, 2026-08-11; не путать с finance_transactions
    # выше — тот метод /v3/finance/transaction/list, другая семантика) ---

    def accrual_by_day(self, date) -> dict:
        """POST /v1/finance/accrual/by-day — начисления за сутки по методу
        начислений, ВСЕ страницы (курсор last_id; реализовано 2026-08-22 —
        «до онбординга крупных клиентов», спека ozon-accruals-pagination).
        Возвращает {"accruals": [...все строки...], "pages": N} — last_id
        наружу не отдаётся, потребителю он больше не нужен.
        Защита от зацикливания (урок iter_postings 2026-07-02: API может
        игнорировать курсор и отдавать ту же страницу): повтор last_id или
        больше ACCRUAL_MAX_PAGES страниц → RuntimeError; вызывающий сборщик
        обрабатывает это как failed (exit 1), окно НЕ записывается — громкий отказ
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
            time.sleep(REQUEST_PAUSE_SEC)  # межстраничная пауза: проба 2026-08-11 ловила code 8
        return {"accruals": accruals, "pages": pages}

    def accrual_types(self) -> list[dict]:
        """POST /v1/finance/accrual/types — общий (не per-кабинет) справочник
        кодов типов начислений: [{id, name, description}, ...]. На пробе —
        119 типов. См. shared.ozon_accrual_types (миграция 040)."""
        data = self._post(self.host, "/v1/finance/accrual/types", {})
        return data.get("accrual_types", []) if isinstance(data, dict) else []

    # --- ОТЗЫВЫ: только чтение (ответ — побочное действие, в менеджере) ---

    def review_list(self, unanswered_only: bool = True, limit: int = 20) -> list[dict]:
        """/v1/review/list — отзывы (неотвеченные по умолчанию).
        limit должен быть в диапазоне [20, 100] (проверено: при <20 Ozon вернёт
        400 «value must be inside range [20, 100]»)."""
        limit = max(20, min(limit, 100))
        body = {"limit": limit, "offset": 0}
        if unanswered_only:
            body["filter"] = {"status": "UNANSWERED"}
        data = self._post(self.host, "/v1/review/list", body)
        return data.get("items", []) if isinstance(data, dict) else []

    # --- АКЦИИ / БУСТИНГ (соинвест Ozon, probe 2026-07-07) ---

    def actions_list(self) -> list[dict]:
        """GET /v1/actions — список акций бустинга (ELASTIC_BOOSTING / STOCK_DISCOUNT).
        Возвращает массив акций. Каждая акция: id, title, action_type, discount_type,
        discount_value, date_start, date_end, is_participating, participating_products_count,
        potential_products_count, auto_add_dates. Буст = скидка Ozon (аналог СПП WB),
        продавец получает цену кабинета (буст НЕ вычитается из прибыли).
        ⚠️ Endpoint метод GET (POST даёт 405 — проверено probe)."""
        data = self._get(self.host, "/v1/actions")
        return data if isinstance(data, list) else []

    def actions_candidates(self, action_id: int, limit: int = 1000) -> dict:
        """POST /v1/actions/candidates — товары-участники + кандидаты акции.
        Возвращает result-объект {products: [...], total: int, last_id: str}.
        Каждый товар в products: id (=product_id), price, action_price, max_action_price,
        current_boost (% соинвеста, 15-75 по факту), min_boost, max_boost,
        price_min_elastic, price_max_elastic, add_mode, stock.
        body: {action_id, limit}. По probe отдаёт одним ответом (42+2+4 товаров)."""
        data = self._post(self.host, "/v1/actions/candidates",
                          {"action_id": action_id, "limit": limit})
        return data if isinstance(data, dict) else {}

    def actions_products(self, action_id: int, limit: int = 1000) -> dict:
        """POST /v1/actions/products — РЕАЛЬНЫЕ участники акции (с активированным бустом).

        ⚠️ ВАЖНО (gotcha, probe 2026-07-08): /v1/actions/candidates отдаёт КАНДИДАТОВ
        (add_mode=NOT_SET, current_boost=15 — это РЕКОМЕНДУЕМЫЙ минимум, НЕ активирован).
        Этот же endpoint — /v1/actions/products — отдаёт реальные товары-участники
        (add_mode=MANUAL/AUTO, current_boost=58-75 — РЕАЛЬНЫЙ активный буст).
        Наборы НЕ пересекаются (probe: candidates=13, products=42, пересечение=0).
        Поэтому для метрики «соинвест» надо звать ОБА: candidates хранит кандидатов,
        products — реальных участников с рабочим бустом.

        Возвращает result-объект {products: [...], total: int, last_id: str}.
        Структура товара та же, что у candidates (probe 2026-07-08): id, price,
        action_price, max_action_price, add_mode (MANUAL), stock, current_boost,
        price_min_elastic, price_max_elastic, min_boost, max_boost.
        body: {action_id, limit}."""
        data = self._post(self.host, "/v1/actions/products",
                          {"action_id": action_id, "limit": limit})
        return data if isinstance(data, dict) else {}


def _backoff_delay(attempt: int) -> float:
    """Пауза перед следующей попыткой (attempt — индекс только что провалившейся
    попытки, с 0): экспонента RETRY_BASE_DELAY_SEC*2^attempt + джиттер [0, RETRY_JITTER_SEC).
    При RETRY_ATTEMPTS=5 даёт паузы ~2с → 4с → 8с → 16с перед попытками 2..5."""
    return RETRY_BASE_DELAY_SEC * (2 ** attempt) + random.uniform(0, RETRY_JITTER_SEC)


# --- вспомогательное форматирование дат для тела запроса ---

def _iso(dt) -> str:
    """ISO-8601 с 'Z' для since/to (напр. '2026-06-15T00:00:00.000Z').

    ВАЖНО: Ozon строго требует миллисекундную точность (.fffZ) и НЕ принимает
    микросекунды (.ffffff) или наложение '.ffffff.000Z'. Поэтому:
      - обрезаем микросекунды до 3 цифр (миллисекунды),
      - убираем любое смещение часового пояса, добавляем 'Z'.
    """
    if dt is None:
        return ""
    if hasattr(dt, "isoformat"):
        # isoformat() даёт '2026-06-15T00:00:00[.ffffff][±HH:MM]'
        s = dt.isoformat()
        # отрежем смещение tz (если есть): всё после '+'/'-' после 'T'
        # безопаснее: найдём позицию tz-знака после 'T'
        t_idx = s.find("T")
        if t_idx > 0:
            tail = s[t_idx + 1:]
            # tz-маркеры: '+HH:MM', 'Z' в конце. отрежем их.
            for marker in ("+", "-"):
                mi = tail.rfind(marker)
                if mi > 0:  # игнорируем '-' в дате (он до 'T')
                    tail = tail[:mi]
                    break
            s = s[:t_idx + 1] + tail
        # теперь s = 'YYYY-MM-DDTHH:MM:SS' или '...HH:MM:SS.ffffff'
        # нормализуем доли секунды к 3 цифрам (миллисекунды)
        if "." in s:
            base, frac = s.split(".", 1)
            frac = (frac + "000")[:3]  # дополняем/обрезаем до 3 знаков
            s = base + "." + frac
        else:
            s = s + ".000"
        return s + "Z"
    return str(dt)


def _date_iso(dt) -> str:
    """Только дата YYYY-MM-DD для analytics/data."""
    if dt is None:
        return ""
    if hasattr(dt, "strftime"):
        return dt.strftime("%Y-%m-%d")
    return str(dt)[:10]


class MockOzonClient(OzonClient):
    """Заглушка для --mock: не ходит в сеть, отдаёт тестовые данные."""
    def __init__(self):
        # Обходим проверку токенов.
        self.client_id = "mock"
        self.api_key = "mock"
        self.host = SELLER_HOST
        self.analytics_host = ANALYTICS_HOST

    def iter_all_products(self, visibility: str = "ALL"):
        yield {"product_id": 100100, "offer_id": "OZ-SKU-A"}
        yield {"product_id": 100200, "offer_id": "OZ-SKU-B"}

    def product_info(self, product_ids: list[int], sku: int = 0):
        names = {100100: "Товар A (mock)", 100200: "Товар B (mock)"}
        # Возвращаем commissions (с sale_schema FBO) + volume_weight + vat — как реальный API.
        return [{"product_id": pid, "id": pid, "name": names.get(pid, f"Товар {pid}"),
                 "offer_id": f"OZ-{pid}", "primary_image": [""],
                 "volume_weight": 0.1, "vat": "0.00",
                 "commissions": [{"sale_schema": "FBO", "percent": 20,
                                  "delivery_amount": 25, "return_amount": 22.37,
                                  "value": 40}]}
                for pid in product_ids]

    def product_info_attributes(self, product_ids: list[int], visibility: str = "ALL"):
        return [{"id": pid, "weight": 46, "weight_unit": "g", "dimension_unit": "mm",
                 "height": 18, "width": 174, "depth": 233,
                 "description_category_id": 17028968, "type_id": 95249}
                for pid in product_ids]

    def category_tree(self):
        return [{
            "description_category_id": 17027487,
            "category_name": "Товары для животных",
            "children": [{"description_category_id": 17028968,
                          "category_name": "Уход за животными",
                          "children": [{"type_id": 95249, "type_name": "Пуходерка", "children": []}]}]
        }]

    def product_info_prices(self, product_ids: list[int], visibility: str = "ALL"):
        # /v5/product/info/prices: items[].price.{price, old_price, marketing_seller_price, ...}
        # catalog.py берёт marketing_seller_price (цена продавца со скидкой), не price.price.
        return [{"product_id": pid,
                 "price": {"price": 200, "old_price": 999,
                           "marketing_seller_price": 200, "min_price": 165,
                           "retail_price": 0, "net_price": 0,
                           "vat": 0, "currency_code": "RUB"}}
                for pid in product_ids]

    def iter_postings(self, since, to, status: str | None = None):
        return iter([])

    def posting_fbs_list(self, since, to, status=None, limit=1000, offset=0):
        return {"postings": [], "has_next": False}

    def iter_fbs_postings(self, since, to, status=None):
        return iter([])

    def cluster_list(self, cluster_type="CLUSTER_TYPE_OZON"):
        return []

    def iter_stock(self):
        return iter([])

    def iter_analytics(self, date_from, date_to, dimensions, metrics):
        return iter([])

    def iter_finance(self, since, to):
        return iter([])

    def review_list(self, unanswered_only: bool = True, limit: int = 50):
        return []

    def actions_list(self):
        return []

    def actions_candidates(self, action_id: int, limit: int = 1000):
        return []

    def actions_products(self, action_id: int, limit: int = 1000):
        return []
