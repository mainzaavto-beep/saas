"""
Планировщик авто-списания FBS (спека «Склады 2.0» §3.4). ЧИСТЫЕ функции: вход —
списки из БД, выход — движения и пробелы. Применяет worker/stock_ledger.py.

WB: задание списывается (out_fbs, −1), когда товар физически уехал со склада продавца:
поставка задания закрыта (wb_supplies.closed_at) ИЛИ wb_status ∈ SHIPPED_WB.
Возврат на склад (return_in, +1): статус ∈ RETURNED_WB при уже сделанном списании
(тот же rid, kind другой — уникальность stock_moves позволяет; "canceled" — отмена
продавцом после закрытой поставки, товар тоже едет обратно), либо возвратная продажа
wb_sales 'R…' по srid задания (src_kind wb_fbs_return, тот же базовый src_ref — rid).
Ozon: постинг FBS списывается при статусе ∈ SHIPPED_OZON на qty строки; cancelled
после списания → return_in; возврат покупателем (ozon_sales is_return) → return_in
ozon_return. src_ref Ozon = posting_number:product_id (в постинге несколько товаров).
Возврат может ссылаться на списание, сделанное в ЭТОМ ЖЕ прогоне (не только на
existing_out из БД) — planner ведёт объединённую карту ref→[(ff_inventory_id, qty), …]
(WB и Ozon).

Дедуп возврата — ПО КОЛИЧЕСТВУ, а не по факту «реф уже возвращали»: одно списание может
вернуться частями (постинг на 3 → возвраты 2 и 1), и оба зачисления обязаны пройти.
planner ведёт returned = {базовый реф: сколько зачислено} (из БД —
db_pg.existing_return_qty по обоим src_kind платформы — плюс зачисленное в этом прогоне) и
никогда не зачисляет по рефу больше, чем по нему списано (Σ out_fbs). Статусный путь
(wb_fbs_task / ozon_posting) и продажный (wb_fbs_return / ozon_return) могут описывать одно
и то же событие: статусный идёт первым и зачисляет ВСЁ оставшееся, поэтому продажный после
него не добавляет ничего (и наоборот). Второе и последующие зачисления по рефу получают
src_ref '<ref>#r<n>' (n = уже зачислено + 1) — иначе уникальный индекс stock_moves
(cabinet_id, src_kind, src_ref, kind) съел бы их через ON CONFLICT DO NOTHING.

Третье возвращаемое значение планировщиков — closed_refs: рефы, по которым списания уже не
будет НИКОГДА (задание/постинг отменён или возвращён, а out_fbs так и не случился).
Сборщик закрывает их пробелы наравне с теми, по которым движение удалось: иначе пробел,
который никогда не «дозреет», висел бы в /inventory вечно.

Место: (platform, warehouse_id) → location_id через stock_ff_locations. NULL
warehouse_id → gap no_location (loc_by_wh не содержит None-ключей).
Позиции: (location_id, platform, sku_key) → строки ff_inventory (через ff_inventory_skus),
FIFO по completed_at (NULL последними), затем id. Остаток расходуется в пределах прогона.
NULL sku_key (nm_id/product_id) → gap no_item (items не содержит None-ключей). Нет места
→ gap no_location; нет позиций → no_item; не хватило → insufficient.

Возврат по позициям разнесения: списание может быть разнесено по нескольким строкам
ff_inventory (src_ref с суффиксом #<id>) — возврат обходит те же позиции FIFO (в порядке
исходного списания) и зачисляет туда же, пропуская единицы, зачисленные предыдущими
возвратами по этому же рефу. Полный возврат/отмена — всё, что ещё не вернулось; частичный
(qty из возврата-продажи) — по позициям, пока qty не исчерпан.
"""
SHIPPED_WB = {"sorted", "ready_for_pickup", "sold"}
RETURNED_WB = {"canceled_by_client", "declined_by_client", "defect", "canceled"}
SHIPPED_OZON = {"awaiting_deliver", "delivering", "delivered"}


def resolve_item(rows, qty):
    """FIFO-разнесение qty по строкам позиции. rows: [{id, qty, completed_at}]. Возвращает
    ([(id, take), …], shortage). Мутирует rows[i]["qty"] (остаток в пределах прогона)."""
    ordered = sorted(rows, key=lambda r: (r.get("completed_at") is None, r.get("completed_at") or "", r["id"]))
    out, need = [], int(qty)
    for r in ordered:
        if need <= 0:
            break
        avail = int(r.get("qty") or 0)
        if avail <= 0:
            continue
        take = min(avail, need)
        out.append((r["id"], take))
        r["qty"] = avail - take
        need -= take
    return out, need


def _writeoff(platform, src_kind, src_ref, wh, sku_key, qty, moved_at, loc_by_wh, items, moves, gaps):
    """wh/sku_key могут быть None (нет склада/артикула у источника) — тогда сразу gap
    no_location/no_item, без обращения к БД-словарям (dict.get с None-ключом — не ошибка,
    просто промах)."""
    loc = loc_by_wh.get((platform, wh))
    gap = {"src_kind": src_kind, "src_ref": src_ref, "platform": platform, "warehouse_id": wh, "sku_key": sku_key, "qty": qty}
    if loc is None:
        gaps.append({**gap, "reason": "no_location"})
        return
    rows = items.get((loc, platform, sku_key)) or []
    if not rows:
        gaps.append({**gap, "reason": "no_item"})
        return
    parts, shortage = resolve_item(rows, qty)
    if shortage:
        # Частичного списания не делаем: остаток вернуть строкам и записать пробел.
        for r in rows:
            for pid, take in parts:
                if r["id"] == pid:
                    r["qty"] += take
        gaps.append({**gap, "reason": "insufficient"})
        return
    for pid, take in parts:
        moves.append({"ff_inventory_id": pid, "kind": "out_fbs", "qty": -take, "src_kind": src_kind,
                      "src_ref": src_ref if len(parts) == 1 else f"{src_ref}#{pid}",
                      "moved_at": moved_at, "note": None})


def _credit_positions(positions, qty, skip, ref, src_kind, moved_at, note, moves):
    """Кредитует возврат по позициям исходного списания, FIFO в порядке списания.
    positions: [(ff_inventory_id, qty_abs), …] (из existing_out/out_map). skip — сколько
    единиц по этому рефу уже зачислено раньше: их пропускаем, чтобы новый возврат лёг на
    ещё не возвращённые единицы (порядок обхода тот же, что при списании, поэтому пропуск
    по количеству эквивалентен «продолжить с того места, где остановились»). qty=None —
    зачислить всё оставшееся (отмена целиком); иначе — не больше qty. Задета >1 позиция →
    src_ref с суффиксом #<id> (как при списании), иначе — переданный ref.
    Возвращает зачисленное количество."""
    if not positions:
        return 0
    total = sum(t for _, t in positions)
    remaining = total - int(skip or 0)
    if remaining <= 0:
        return 0
    need = remaining if qty is None else min(int(qty), remaining)
    if need <= 0:
        return 0
    to_skip, touched = int(skip or 0), []
    for pid, take in positions:
        if need <= 0:
            break
        if to_skip >= take:
            to_skip -= take
            continue
        amt = min(take - to_skip, need)
        to_skip = 0
        if amt <= 0:
            continue
        touched.append((pid, amt))
        need -= amt
    for pid, amt in touched:
        moves.append({"ff_inventory_id": pid, "kind": "return_in", "qty": amt, "src_kind": src_kind,
                      "src_ref": ref if len(touched) == 1 else f"{ref}#{pid}",
                      "moved_at": moved_at, "note": note})
    return sum(a for _, a in touched)


def _return_ref(ref, credited):
    """src_ref движения возврата. Первое зачисление по рефу — сам ref (рефы, записанные до
    частичных возвратов, остаются валидными). Каждое следующее — '<ref>#r<n>', где
    n = уже зачислено + 1. Величина строго растёт с каждым зачислением, значит реф уникален
    в пределах (src_kind, ref): без этого второй возврат по тому же рефу упирался бы в
    уникальный индекс stock_moves (ON CONFLICT DO NOTHING) и молча терялся. Возвраты по
    штуке (WB) → n — это просто порядковый номер возврата."""
    return ref if credited <= 0 else f"{ref}#r{credited + 1}"


def _credit_return(out_map, returned, seen, ref, src_kind, qty, moved_at, note, moves):
    """ОДНО событие возврата по базовому рефу. Дедуп — по КОЛИЧЕСТВУ, не по факту «реф уже
    возвращали»: частичные возвраты (2 + 1 по списанию −3) должны зачисляться оба.
      cap      = Σ out_fbs по рефу — больше, чем уехало, вернуться не может;
      seen     = Σ qty всех источников возврата по рефу, встреченных в этом прогоне;
      target   = min(seen, cap), либо cap для статусного пути (отмена = всё оставшееся);
      зачисляем target − credited.
    Отсюда идемпотентность: источники читаются из БД целиком (вся история возвратов), поэтому
    повторный прогон даёт тот же target при уже равном credited → 0 движений. Наивное
    min(qty, remaining) на каждый прогон дозачисляло бы возврат, меньший списания (постинг на
    3, возврат на 2 → второй прогон добавил бы ещё 1).
    qty=None — статусный путь (отмена/возврат по статусу): target = cap.
    Возвращает зачисленное количество."""
    positions = out_map.get(ref)
    if not positions:
        return 0
    cap = sum(t for _, t in positions)
    credited = int(returned.get(ref, 0))
    if qty is None:
        target = cap
    else:
        seen[ref] = seen.get(ref, 0) + int(qty)
        target = min(seen[ref], cap)
    delta = target - credited
    if delta <= 0:
        return 0
    got = _credit_positions(positions, delta, credited, _return_ref(ref, credited), src_kind, moved_at, note, moves)
    if got:
        returned[ref] = credited + got
    return got


def plan_wb(tasks, supplies_closed, loc_by_wh, items, existing_out, returns, existing_returns=None):
    """→ (moves, gaps, closed_refs). closed_refs — базовые рефы, по которым списания уже не
    будет никогда (задание отменено/возвращено, а out_fbs так и не случился): их пробелы
    сборщик закрывает вместе с теми, по которым движение удалось, — иначе безнадёжный
    пробел висел бы в /inventory вечно."""
    moves, gaps, closed_refs = [], [], []
    # returned: {базовый реф: сколько уже зачислено обратно} — из БД (existing_returns,
    # db_pg.existing_return_qty) и из этого прогона. seen: сколько возврата по рефу
    # предъявили источники этого прогона (см. _credit_return).
    returned, seen = dict(existing_returns or {}), {}
    # out_map: existing_out (из БД, {ref: [(ff_inventory_id, qty_abs), …]}) + списанное в
    # этом же прогоне — возврат может ссылаться на списание, которое planner только что создал.
    out_map = {ref: list(pos) for ref, pos in existing_out.items()}
    for t in tasks:
        rid, st = t["rid"], t.get("wb_status")
        moved_at = t.get("wb_status_at") or t.get("created_at")
        if rid in out_map:
            if st in RETURNED_WB:
                _credit_return(out_map, returned, seen, rid, "wb_fbs_task", None, moved_at,
                               f"возврат на склад: {st}", moves)
            continue
        if st in RETURNED_WB:
            # Отменено/возвращено, а списания не было (и не будет: задание уже не уедет) —
            # пробел по нему безнадёжен, закрываем.
            closed_refs.append(rid)
            continue
        shipped = (t.get("supply_id") in supplies_closed) or (st in SHIPPED_WB)
        if not shipped:
            continue
        wh = int(t["warehouse_id"]) if t.get("warehouse_id") is not None else None
        sku_key = int(t["nm_id"]) if t.get("nm_id") is not None else None
        before = len(moves)
        _writeoff("wb", "wb_fbs_task", rid, wh, sku_key, 1, moved_at, loc_by_wh, items, moves, gaps)
        added = moves[before:]
        if added:
            out_map[rid] = [(m["ff_inventory_id"], abs(m["qty"])) for m in added]
    for r in returns:  # wb_sales 'R…' по srid задания — тот же базовый ref (rid), что и у списания
        _credit_return(out_map, returned, seen, r["srid"], "wb_fbs_return", 1, r.get("sale_dt"),
                       f"возврат покупателя: {r['sale_id']}", moves)
    return moves, gaps, closed_refs


def plan_ozon(postings, loc_by_wh, items, existing_out, returns, existing_returns=None):
    """→ (moves, gaps, closed_refs) — см. plan_wb."""
    moves, gaps, closed_refs = [], [], []
    returned, seen = dict(existing_returns or {}), {}
    out_map = {ref: list(pos) for ref, pos in existing_out.items()}
    for p in postings:
        ref = f"{p['posting_number']}:{p['product_id']}"
        st, qty = p.get("status"), int(p.get("qty") or 0)
        moved_at = p.get("last_change_dt") or p.get("in_process_at")
        if ref in out_map:
            if st == "cancelled":
                _credit_return(out_map, returned, seen, ref, "ozon_posting", None, moved_at,
                               "отмена после отгрузки", moves)
            continue
        if st == "cancelled":
            closed_refs.append(ref)  # отменён, не списан — списания не будет, пробел безнадёжен
            continue
        if st not in SHIPPED_OZON:
            continue
        wh = int(p["warehouse_id"]) if p.get("warehouse_id") is not None else None
        sku_key = int(p["product_id"]) if p.get("product_id") is not None else None
        if qty <= 0:
            # Отгруженный постинг без количества — списывать нечего, но молчать нельзя:
            # это дефект данных строки постинга, владелец должен его увидеть.
            gaps.append({"src_kind": "ozon_posting", "src_ref": ref, "platform": "ozon",
                         "warehouse_id": wh, "sku_key": sku_key, "qty": qty, "reason": "no_item"})
            continue
        before = len(moves)
        _writeoff("ozon", "ozon_posting", ref, wh, sku_key, qty, moved_at, loc_by_wh, items, moves, gaps)
        added = moves[before:]
        if added:
            out_map[ref] = [(m["ff_inventory_id"], abs(m["qty"])) for m in added]
    for r in returns:
        ref = f"{r['posting_number']}:{r['product_id']}"
        qty = int(r.get("qty") if r.get("qty") is not None else 1)
        _credit_return(out_map, returned, seen, ref, "ozon_return", qty, r.get("moved_at"),
                       "возврат покупателя", moves)
    return moves, gaps, closed_refs
