"""
Планировщик авто-списания FBS (спека «Склады 2.0» §3.4). ЧИСТЫЕ функции: вход —
списки из БД, выход — движения и пробелы. Применяет worker/stock_ledger.py.

WB: задание списывается (out_fbs, −1), когда товар физически уехал со склада продавца:
поставка задания закрыта (wb_supplies.closed_at) ИЛИ wb_status ∈ SHIPPED_WB.
Возврат на склад (return_in, +1): статус ∈ RETURNED_WB при уже сделанном списании
(тот же rid, kind другой — уникальность stock_moves позволяет), либо возвратная
продажа wb_sales 'R…' по srid задания (src_kind wb_fbs_return).
Ozon: постинг FBS списывается при статусе ∈ SHIPPED_OZON на qty строки; cancelled
после списания → return_in; возврат покупателем (ozon_sales is_return) → return_in
ozon_return. src_ref Ozon = posting_number:product_id (в постинге несколько товаров).
Возврат может ссылаться на списание, сделанное в ЭТОМ ЖЕ прогоне (не только на
existing_out из БД) — planner ведёт объединённую карту ref→ff_inventory_id (WB и Ozon).

Место: (platform, warehouse_id) → location_id через stock_ff_locations.
Позиции: (location_id, platform, sku_key) → строки ff_inventory (через ff_inventory_skus),
FIFO по completed_at (NULL последними), затем id. Остаток расходуется в пределах прогона.
Нет места → gap no_location; нет позиций → no_item; не хватило → insufficient.
"""
SHIPPED_WB = {"sorted", "ready_for_pickup", "sold"}
RETURNED_WB = {"canceled_by_client", "declined_by_client", "defect"}
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


def plan_wb(tasks, supplies_closed, loc_by_wh, items, existing_out, returns):
    moves, gaps = [], []
    # out_map: существующие out_fbs (из БД) + сделанные в этом же прогоне — возврат может
    # ссылаться на списание, которое planner только что создал в этом же вызове.
    out_map = dict(existing_out)
    for t in tasks:
        rid, st = t["rid"], t.get("wb_status")
        shipped = (t.get("supply_id") in supplies_closed) or (st in SHIPPED_WB) or (st in RETURNED_WB and rid in existing_out)
        moved_at = t.get("wb_status_at") or t.get("created_at")
        if rid in existing_out:
            if st in RETURNED_WB:
                moves.append({"ff_inventory_id": existing_out[rid], "kind": "return_in", "qty": 1, "src_kind": "wb_fbs_task",
                              "src_ref": rid, "moved_at": moved_at, "note": f"возврат на склад: {st}"})
            continue
        if not shipped or st in RETURNED_WB or t.get("warehouse_id") is None:
            continue
        before = len(moves)
        _writeoff("wb", "wb_fbs_task", rid, int(t["warehouse_id"]), int(t["nm_id"]), 1, moved_at, loc_by_wh, items, moves, gaps)
        added = moves[before:]
        if added:
            out_map[rid] = added[0]["ff_inventory_id"]
    for r in returns:  # wb_sales 'R…' по srid задания
        inv = out_map.get(r["srid"])
        if inv is None:
            continue
        moves.append({"ff_inventory_id": inv, "kind": "return_in", "qty": 1, "src_kind": "wb_fbs_return",
                      "src_ref": r["sale_id"], "moved_at": r.get("sale_dt"), "note": "возврат покупателя"})
    return moves, gaps


def plan_ozon(postings, loc_by_wh, items, existing_out, returns):
    moves, gaps = [], []
    # out_map: существующие out_fbs (из БД) + сделанные в этом же прогоне — возврат
    # покупателя может относиться к постингу, который planner только что списал (тот же
    # цикл сбора: постинг уже delivered и уже есть возврат в ozon_sales).
    out_map = dict(existing_out)
    for p in postings:
        ref = f"{p['posting_number']}:{p['product_id']}"
        st, qty = p.get("status"), int(p.get("qty") or 0)
        moved_at = p.get("last_change_dt") or p.get("in_process_at")
        if ref in existing_out:
            if st == "cancelled":
                moves.append({"ff_inventory_id": existing_out[ref], "kind": "return_in", "qty": qty, "src_kind": "ozon_posting",
                              "src_ref": ref, "moved_at": moved_at, "note": "отмена после отгрузки"})
            continue
        if st not in SHIPPED_OZON or qty <= 0 or p.get("warehouse_id") is None:
            continue
        before = len(moves)
        _writeoff("ozon", "ozon_posting", ref, int(p["warehouse_id"]), int(p["product_id"]), qty, moved_at, loc_by_wh, items, moves, gaps)
        added = moves[before:]
        if added:
            out_map[ref] = added[0]["ff_inventory_id"]
    for r in returns:
        ref = f"{r['posting_number']}:{r['product_id']}"
        inv = out_map.get(ref)
        if inv is None:
            continue
        moves.append({"ff_inventory_id": inv, "kind": "return_in", "qty": int(r.get("qty") or 1), "src_kind": "ozon_return",
                      "src_ref": ref, "moved_at": r.get("moved_at"), "note": "возврат покупателя"})
    return moves, gaps
