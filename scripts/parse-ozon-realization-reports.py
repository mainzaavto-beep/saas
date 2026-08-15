#!/usr/bin/env python3
# Разбор 4 файлов "Отчет о реализации товара" (апрель-июль 2026, /root/ozon-reports/обмен с клодом/)
# для внешней сверки третьего уровня (документ Ozon vs tenant.ozon_accruals).
# Запуск: /opt/agents/data-presenter-agent/.venv/bin/python parse_reports.py
import openpyxl

files = {
    "20260430": "апрель",
    "20260531": "май",
    "20260630": "июнь",
    "20260731": "июль",
}

for fname, mon in files.items():
    f = f"/root/ozon-reports/обмен с клодом/Отчет о реализации товара_{fname}.xlsx"
    wb = openpyxl.load_workbook(f, data_only=True)
    ws = wb["Отчет о реализации"]
    period = ws["C4"].value
    inn = ws["L9"].value
    sumF = sumG = sumJ = sumK = 0.0
    n_items = 0
    n_returns = 0
    max_r = ws.max_row
    total_row = None
    total_F = total_G = total_J = total_K = None
    for r in range(16, max_r + 1):
        a = ws.cell(r, 1).value
        if isinstance(a, int):
            n_items += 1
            fv = ws.cell(r, 6).value or 0
            gv = ws.cell(r, 7).value or 0
            jv = ws.cell(r, 10).value or 0
            kv = ws.cell(r, 11).value or 0
            sumF += fv
            sumG += gv
            sumJ += jv
            sumK += kv
            if jv:
                n_returns += 1
        else:
            f_ = ws.cell(r, 6).value
            if f_ is not None and isinstance(f_, (int, float)) and total_row is None and a is None:
                total_row = r
                total_F = ws.cell(r, 6).value
                total_G = ws.cell(r, 7).value
                total_J = ws.cell(r, 10).value
                total_K = ws.cell(r, 11).value
    itogo_realiz = None
    vyplaty = None
    for r in range(1, max_r + 1):
        b = ws.cell(r, 2).value
        if isinstance(b, str) and "Итого реализовано" in b:
            itogo_realiz = ws.cell(r, 3).value
        if isinstance(b, str) and "Всего выплат" in b:
            vyplaty = ws.cell(r, 3).value
    print(f"=== {mon} ({fname}) === period={period!r} ИНН получателя={inn}")
    print(f"  items rows: {n_items}, rows with returns(J!=0): {n_returns}")
    print(f"  sum(F)={sumF:.2f} sum(G)={sumG:.2f} sum(J)={sumJ:.2f} sum(K)={sumK:.2f}")
    print(f"  printed total row {total_row}: F={total_F} G={total_G} J={total_J} K={total_K}")
    print(f"  printed 'Итого реализовано (за вычетом возвратов)'={itogo_realiz}  'Всего выплат от партнёров'={vyplaty}")
    print(f"  check: sumF-sumJ={sumF - sumJ:.2f} (should == itogo_realiz); sumG-sumK={sumG - sumK:.2f} (should == vyplaty)")
    print()
