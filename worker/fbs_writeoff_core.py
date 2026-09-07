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

Один физический возврат — одно зачисление. Статусный путь (wb_fbs_task / ozon_posting)
и продажный путь (wb_fbs_return / ozon_return) могут описывать ОДНО И ТО ЖЕ событие —
planner ведёt returned = existing_returns (из БД, db_pg.existing_return_refs, базовые
рефы обоих src_kind на платформу) ∪ рефы, зачисленные в этом прогоне; статусный путь
идёт первым, продажный пропускается, если базовый реф уже в returned (и наоборот —
если existing_returns уже содержит реф, статусный путь тоже пропускается).

Место: (platform, warehouse_id) → location_id через stock_ff_locations. NULL
warehouse_id → gap no_location (loc_by_wh не содержит None-ключей).
Позиции: (location_id, platform, sku_key) → строки ff_inventory (через ff_inventory_skus),
FIFO по completed_at (NULL последними), затем id. Остаток расходуется в пределах прогона.
NULL sku_key (nm_id/product_id) → gap no_item (items не содержит None-ключей). Нет места
→ gap no_location; нет позиций → no_item; не хватило → insufficient.

Возврат по позициям разнесения: списание может быть разнесено по нескольким строкам
ff_inventory (src_ref с суффиксом #<id>) — возврат обходит те же позиции FIFO (в порядке
исходного списания) и зачисляет туда же. Полный возврат/отмена — все позиции целиком;
частичный (qty из возврата-продажи) — по позициям, пока qty не исчерпан.
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


def _credit_positions(positions, qty, ref, src_kind, moved_at, note, moves):
    """Кредитует возврат по позициям исходного списания, FIFO в порядке списания.
    positions: [(ff_inventory_id, qty_abs), …] (из existing_out/out_map). qty=None — полный
    возврат (сумма всех позиций, отмена целиком); иначе — частичный, обходит позиции по
    порядку, пока не наберёт qty. Задета >1 позиция → src_ref с суффиксом #<id> (как при
    списании), иначе — исходный ref."""
    if not positions:
        return
    need = sum(t for _, t in positions) if qty is None else int(qty)
    touched = []
    for pid, take in positions:
        if need <= 0:
            break
        amt = min(take, need)
        if amt <= 0:
            continue
        touched.append((pid, amt))
        need -= amt
    for pid, amt in touched:
        moves.append({"ff_inventory_id": pid, "kind": "return_in", "qty": amt, "src_kind": src_kind,
                      "src_ref": ref if len(touched) == 1 else f"{ref}#{pid}",
                      "moved_at": moved_at, "note": note})


def plan_wb(tasks, supplies_closed, loc_by_wh, items, existing_out, returns, existing_returns=set()):
    moves, gaps = [], []
    # returned: базовые рефы (rid), уже зачисленные обратно — из БД (existing_returns) и из
    # этого прогона. Один физический возврат — одно зачисление (статусный путь первый).
    returned = set(existing_returns)
    # out_map: existing_out (из БД, {ref: [(ff_inventory_id, qty_abs), …]}) + списанное в
    # этом же прогоне — возврат может ссылаться на списание, которое planner только что создал.
    out_map = {ref: list(pos) for ref, pos in existing_out.items()}
    for t in tasks:
        rid, st = t["rid"], t.get("wb_status")
        moved_at = t.get("wb_status_at") or t.get("created_at")
        if rid in out_map:
            if st in RETURNED_WB and rid not in returned:
                _credit_positions(out_map[rid], None, rid, "wb_fbs_task", moved_at,
                                  f"возврат на склад: {st}", moves)
                returned.add(rid)
            continue
        shipped = (t.get("supply_id") in supplies_closed) or (st in SHIPPED_WB)
        if not shipped or st in RETURNED_WB:
            continue
        wh = int(t["warehouse_id"]) if t.get("warehouse_id") is not None else None
        sku_key = int(t["nm_id"]) if t.get("nm_id") is not None else None
        before = len(moves)
        _writeoff("wb", "wb_fbs_task", rid, wh, sku_key, 1, moved_at, loc_by_wh, items, moves, gaps)
        added = moves[before:]
        if added:
            out_map[rid] = [(m["ff_inventory_id"], abs(m["qty"])) for m in added]
    for r in returns:  # wb_sales 'R…' по srid задания — тот же базовый ref (rid), что и у списания
        srid = r["srid"]
        if srid in returned or srid not in out_map:
            continue
        _credit_positions(out_map[srid], 1, srid, "wb_fbs_return", r.get("sale_dt"),
                          f"возврат покупателя: {r['sale_id']}", moves)
        returned.add(srid)
    return moves, gaps


def plan_ozon(postings, loc_by_wh, items, existing_out, returns, existing_returns=set()):
    moves, gaps = [], []
    returned = set(existing_returns)
    out_map = {ref: list(pos) for ref, pos in existing_out.items()}
    for p in postings:
        ref = f"{p['posting_number']}:{p['product_id']}"
        st, qty = p.get("status"), int(p.get("qty") or 0)
        moved_at = p.get("last_change_dt") or p.get("in_process_at")
        if ref in out_map:
            if st == "cancelled" and ref not in returned:
                _credit_positions(out_map[ref], None, ref, "ozon_posting", moved_at,
                                  "отмена после отгрузки", moves)
                returned.add(ref)
            continue
        if st not in SHIPPED_OZON or qty <= 0:
            continue
        wh = int(p["warehouse_id"]) if p.get("warehouse_id") is not None else None
        sku_key = int(p["product_id"]) if p.get("product_id") is not None else None
        before = len(moves)
        _writeoff("ozon", "ozon_posting", ref, wh, sku_key, qty, moved_at, loc_by_wh, items, moves, gaps)
        added = moves[before:]
        if added:
            out_map[ref] = [(m["ff_inventory_id"], abs(m["qty"])) for m in added]
    for r in returns:
        ref = f"{r['posting_number']}:{r['product_id']}"
        if ref in returned or ref not in out_map:
            continue
        qty = int(r.get("qty") if r.get("qty") is not None else 1)
        _credit_positions(out_map[ref], qty, ref, "ozon_return", r.get("moved_at"), "возврат покупателя", moves)
        returned.add(ref)
    return moves, gaps
