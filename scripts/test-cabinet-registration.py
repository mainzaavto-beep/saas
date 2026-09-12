#!/usr/bin/env python3
"""Гард регистрации сборщиков кабинета Ozon (урок 2026-08-15: регистрация =
оркестратор И run_saas_collect.sh). Часть проверок — исполнением вырезанного
блока shell-скрипта с фейками, не текстом (методика testing-discipline §4).
Запуск: python3 scripts/test-cabinet-registration.py"""
import ast, os, re, subprocess, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
failed = 0
def check(name, cond, detail=""):
    global failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  ' + str(detail)}")
    if not cond:
        failed += 1

COLLS = {"ozon_cabinet_search", "ozon_cabinet_traffic"}

# 1. Оркестратор: списки через AST (без импорта — импорт тянет psycopg/env).
tree = ast.parse(open(os.path.join(ROOT, "worker/orchestrator.py"), encoding="utf-8").read())
lists = {}
for node in ast.walk(tree):
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        try:
            lists[node.targets[0].id] = ast.literal_eval(node.value)
        except Exception:
            pass
check("OZON_COLLECTORS содержит оба сборщика", COLLS <= set(lists.get("OZON_COLLECTORS", [])), lists.get("OZON_COLLECTORS"))
check("ozon_catalog раньше сборщиков кабинета", lists["OZON_COLLECTORS"].index("ozon_catalog") < min(lists["OZON_COLLECTORS"].index(c) for c in COLLS))
check("CABINET_COLLECTORS объявлен", set(lists.get("CABINET_COLLECTORS", [])) == COLLS, lists.get("CABINET_COLLECTORS"))
src = open(os.path.join(ROOT, "worker/orchestrator.py"), encoding="utf-8").read()
m = re.search(r'SAAS_PAUSE_EXEMPT",\s*"([^"]+)"', src)
check("PAUSE_EXEMPT по умолчанию включает сборщики кабинета", m and COLLS <= set(m.group(1).split(",")), m and m.group(1))

# _run_one: blocked_cabinet (истёкшие сессии кабинета, exit 5) обязан попасть в
# результат на всех путях — инициализация "blocked = list(blocked_cabinet)" ДО
# ветвления paused/auth_errors_seen/ok (ревью задачи 5, находка №1).
run_one_fn = next((n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_run_one"), None)
has_blocked_init = run_one_fn is not None and any(
    isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)
    and n.targets[0].id == "blocked"
    and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name) and n.value.func.id == "list"
    and len(n.value.args) == 1 and isinstance(n.value.args[0], ast.Name) and n.value.args[0].id == "blocked_cabinet"
    for n in ast.walk(run_one_fn)
)
check("_run_one: blocked = list(blocked_cabinet) инициализирован до ветвления", has_blocked_init)

# 2. run_saas_collect.sh: режим cabinet — исполняем блок case с фейком, смотрим переменные.
sh = open(os.path.join(ROOT, "worker/run_saas_collect.sh"), encoding="utf-8").read()
block = sh[sh.index("# Списки сборщиков по группам."):sh.index("# Диапазон дат")]
script = "MODE=cabinet\nDAYS_FROM=\nDAYS_TO=0\n" + block + "\necho \"COLLECTORS=$COLLECTORS\"; echo \"DAYS_FROM=$DAYS_FROM\"; echo \"DAYS_TO=$DAYS_TO\"; echo \"PY=$PY\"; echo \"DISPLAY=$DISPLAY\"; echo \"HTTP_PROXY=${HTTP_PROXY:-unset}\"\n"
with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
    f.write(script)
out = subprocess.run(["bash", f.name], capture_output=True, text=True, env={**os.environ, "HTTP_PROXY": "http://user:pw@proxy:3128"}).stdout
vals = dict(line.split("=", 1) for line in out.strip().splitlines() if "=" in line)
check("cabinet: оба сборщика", set(vals.get("COLLECTORS", "").split(",")) == COLLS, vals)
check("cabinet: окно 3 дня по вчера", (vals.get("DAYS_FROM"), vals.get("DAYS_TO")) == ("3", "1"), vals)
check("cabinet: интерпретатор .venv-cabinet", vals.get("PY", "").endswith("worker/.venv-cabinet/bin/python"), vals)
check("cabinet: DISPLAY=:99", vals.get("DISPLAY") == ":99", vals)
check("cabinet: прокси снят", vals.get("HTTP_PROXY") == "unset", vals)
check("cabinet: flock на /run/lock/saas-cabinet.lock", "flock" in sh and "/run/lock/saas-cabinet.lock" in sh)

# 3. systemd: юнит и таймер.
svc = open(os.path.join(ROOT, "deploy/systemd/saas-cabinet.service"), encoding="utf-8").read()
tmr = open(os.path.join(ROOT, "deploy/systemd/saas-cabinet.timer"), encoding="utf-8").read()
check("service зовёт режим cabinet", "run_saas_collect.sh cabinet" in svc)
check("service: OnFailure", "OnFailure=saas-failure@%n.service" in svc)
check("timer: 06:00 и 20:00, не 07:00", "06,20:00:00" in tmr and "07:" not in tmr, tmr)

print("FAILED" if failed else "ALL PASS", failed)
sys.exit(1 if failed else 0)
