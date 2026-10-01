"""
Селф-тест ядра авторазбора падений (спека 2026-09-30-failure-triage-design.md §4–5).
Без БД, сети и Claude.
Запуск: /opt/agents/data-presenter-agent/.venv/bin/python worker/triage_core_selftest.py
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import triage_core as m  # noqa: E402

failed = 0


def check(cond, msg):
    global failed
    print(("PASS — " if cond else "FAIL — ") + msg, flush=True)
    if not cond:
        failed += 1


NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
_id = [0]


def run(coll, cab, status, mins_ago, kind="main"):
    _id[0] += 1
    return {"id": _id[0], "collector": coll, "cabinet_id": cab, "run_kind": kind,
            "status": status, "started_at": NOW - timedelta(minutes=mins_ago)}


def ep(i, coll, cab, status="queued", last=None, started_mins_ago=None, opened_mins_ago=100):
    return {"id": i, "collector": coll, "cabinet_id": cab, "status": status,
            "opened_at": NOW - timedelta(minutes=opened_mins_ago),
            "started_at": None if started_mins_ago is None else NOW - timedelta(minutes=started_mins_ago),
            "last_failed_run_id": last}


# --- открытие ---
rs = [run("ozon_finance", 1, "ok", 600), run("ozon_finance", 1, "failed", 400), run("ozon_finance", 1, "failed", 200)]
p = m.plan_tick(rs, [], NOW)
check(len(p["open"]) == 1 and p["open"][0]["collector"] == "ozon_finance" and p["open"][0]["cabinet_id"] == 1,
      "два failed подряд открывают эпизод")
check(p["open"][0]["opened_at"] == rs[1]["started_at"], "opened_at = начало серии failed")
check(p["open"][0]["last_failed_run_id"] == rs[2]["id"], "last_failed_run_id = последний failed")

rs = [run("x", 1, "failed", 300), run("x", 1, "timeout", 100)]
check(len(m.plan_tick(rs, [], NOW)["open"]) == 1, "timeout считается падением")

rs = [run("x", 1, "failed", 300), run("x", 1, "ok", 200), run("x", 1, "failed", 100)]
check(m.plan_tick(rs, [], NOW)["open"] == [], "одно failed после ok — не эпизод")

rs = [run("x", 1, "failed", 300), run("x", 1, "skipped", 200), run("x", 1, "no_token", 150), run("x", 1, "failed", 100)]
check(len(m.plan_tick(rs, [], NOW)["open"]) == 1, "skipped/no_token между падениями не рвут серию")

rs = [run("x", 1, "failed", 300), run("x", 1, "partial", 100)]
check(m.plan_tick(rs, [], NOW)["open"] == [], "partial последним — не открывает")

rs = [run("x", 1, "failed", 300, kind="manual"), run("x", 1, "failed", 100, kind="manual")]
check(m.plan_tick(rs, [], NOW)["open"] == [], "manual-прогоны игнорируются")

rs = [run("x", 1, "failed", 300), run("x", 1, "failed", 100)]
p = m.plan_tick(rs, [ep(7, "x", 1, last=rs[1]["id"])], NOW)
check(p["open"] == [] and p["bump"] == [], "открытый эпизод не дублируется, bump не нужен")

rs = [run("x", 1, "failed", 300), run("x", 1, "failed", 100)]
p = m.plan_tick(rs, [ep(7, "x", 1, status="done", last=rs[0]["id"])], NOW)
check(p["bump"] == [(7, rs[1]["id"])], "новое падение двигает last_failed_run_id")

rs = [run("x", 1, "failed", 300), run("x", 1, "failed", 100), run("x", 2, "failed", 90)]
check([o["cabinet_id"] for o in m.plan_tick(rs, [], NOW)["open"]] == [1], "пары по кабинетам раздельны")

# --- закрытие ---
rs = [run("x", 1, "failed", 300), run("x", 1, "ok", 100)]
check(m.plan_tick(rs, [ep(7, "x", 1, status="done")], NOW)["close"] == [7], "ok закрывает эпизод")
check(m.plan_tick(rs, [ep(7, "x", 1, status="running", started_mins_ago=5)], NOW)["close"] == [],
      "running не закрывается (закроется следующим тиком)")
rs = [run("x", 1, "failed", 300), run("x", 1, "partial", 100)]
check(m.plan_tick(rs, [ep(7, "x", 1, status="done")], NOW)["close"] == [], "partial не закрывает")
check(m.plan_tick([], [ep(7, "x", 1, status="queued")], NOW)["close"] == [7],
      "эпизод без прогонов в окне закрывается")

# --- юниты ---
U = "unit:saas-worker.service"
rs = [run("ozon_finance", 1, "failed", 400), run(U, None, "failed", 380, kind="systemd"),
      run("ozon_finance", 1, "failed", 200), run(U, None, "failed", 180, kind="systemd")]
p = m.plan_tick(rs, [], NOW)
check([o["collector"] for o in p["open"]] == ["ozon_finance"], "эхо юнита (сборщик main упал в окне) не открывает")

rs = [run("ozon_metrics_30m", 1, "failed", 395, kind="metrics30m"), run(U, None, "failed", 380, kind="systemd"),
      run(U, None, "failed", 180, kind="systemd")]
opened = [o["collector"] for o in m.plan_tick(rs, [], NOW)["open"]]
check(U in opened, "падение сборщика ДРУГОГО юнита эхом не считается")

rs = [run(U, None, "failed", 600, kind="systemd"), run(U, None, "failed", 300, kind="systemd")]
p = m.plan_tick(rs, [], NOW)
check(len(p["open"]) == 1 and p["open"][0]["cabinet_id"] is None, "два одиночных падения юнита за сутки открывают")

rs = [run(U, None, "failed", 60 * 60, kind="systemd"), run(U, None, "failed", 60 * 30, kind="systemd")]
check(m.plan_tick(rs, [], NOW)["open"] == [], "падения юнита с разрывом > 24 ч — не серия")

rs = [run(U, None, "failed", 60 * 26, kind="systemd")]
check(m.plan_tick(rs, [ep(9, U, None, status="done", last=rs[0]["id"])], NOW)["close"] == [9],
      "юнит закрывается после 24 ч без новых падений")

R = "unit:saas-ozon-recon.service"
rs = [run("ozon_finance", 1, "failed", 305), run(R, None, "failed", 300, kind="systemd"),
      run(R, None, "failed", 100, kind="systemd")]
check(R in [o["collector"] for o in m.plan_tick(rs, [], NOW)["open"]],
      "юнит без своих сборщиков (recon) эхом не считается")

rs = [run("unit:saas-triage.service", None, "failed", 300, kind="systemd"),
      run("unit:saas-triage.service", None, "failed", 100, kind="systemd")]
check(m.plan_tick(rs, [], NOW)["open"] == [], "unit:saas-triage исключён")

# --- зависшие и выбор ---
p = m.plan_tick([], [ep(5, "x", 1, status="running", started_mins_ago=31)], NOW)
check(p["stale"] == [5], "running > 30 мин — stale")
p = m.plan_tick([run("x", 1, "failed", 10)], [ep(5, "x", 1, status="running", started_mins_ago=10)], NOW)
check(p["stale"] == [], "running 10 мин — не stale")

eps = [ep(1, "a", 1, opened_mins_ago=50), ep(2, "b", 1, opened_mins_ago=90), ep(3, "c", 1, status="done")]
check(m.pick_next(eps, 0) == 2, "берётся самый старый queued")
check(m.pick_next(eps, 3) is None, "лимит 3 за сутки")
check(m.pick_next(eps + [ep(4, "d", 1, status="running", started_mins_ago=1)], 0) is None, "не больше одного running")
check(m.pick_next([ep(3, "c", 1, status="done")], 0) is None, "нет queued — None")

# --- разбор ответа ---
GOOD = {"summary": "s", "cause": "mp_method_changed", "confidence": "high", "evidence": ["e"],
        "proposed_fix": "f", "data_impact": "d", "urgent": True}
env = {"type": "result", "is_error": False, "result": "", m.STRUCTURED_KEY: GOOD}
rep, err = m.parse_claude_output(json.dumps(env), 0)
check(rep == GOOD and err is None, "валидный конверт")
env2 = {"type": "result", "is_error": False, "result": json.dumps(GOOD)}
check(m.parse_claude_output(json.dumps(env2), 0)[0] == GOOD, "fallback: отчёт JSON-строкой в result")
check(m.parse_claude_output("garbage", 0)[0] is None, "битый JSON → ошибка")
check(m.parse_claude_output(json.dumps(env), 1)[0] is None, "ненулевой код → ошибка")
bad = dict(GOOD, cause="whatever")
check(m.parse_claude_output(json.dumps({"is_error": False, m.STRUCTURED_KEY: bad}), 0)[0] is None,
      "cause вне перечня → ошибка")
bad = {k: v for k, v in GOOD.items() if k != "urgent"}
check(m.parse_claude_output(json.dumps({"is_error": False, m.STRUCTURED_KEY: bad}), 0)[0] is None,
      "нет обязательного поля → ошибка")
check(m.parse_claude_output(json.dumps({"is_error": True, "result": "boom"}), 0)[0] is None, "is_error → ошибка")

# --- нарезка лога ---
LOG = "\n".join([
    "=== SaaS collect [main] Thu Oct  1 05:15:02 MSK 2026 — период 2026-09-29..2026-10-01 ===",
    "  -- shop #3 [ozon]: ['ozon_finance']",
    "     [ozon_finance] FAIL (exit 1): OLD",
    "EXIT=0",
    "=== SaaS collect [main] Thu Oct  1 09:00:05 MSK 2026 — период 2026-09-29..2026-10-01 ===",
    "     [wb_orders] ok",
    "     [ozon_finance] FAIL (exit 1): requests.exceptions.HTTPError: 404",
    "     Traceback line",
    "EXIT=0",
    "=== SaaS collect [main] Thu Oct  1 12:00:01 MSK 2026 — период x ===",
    "     [ozon_finance] FAIL (exit 1): FUTURE",
])
s = m.slice_worker_log(LOG, "ozon_finance", datetime(2026, 10, 1, 9, 20))
check("404" in s and "Traceback line" in s, "берётся блок прогона, в котором шло падение, с хвостом")
check("OLD" not in s and "FUTURE" not in s and "wb_orders" not in s, "чужие прогоны и сборщики отрезаны")
check(m.slice_worker_log("нет заголовков", "x", datetime(2026, 10, 1)) == "", "без заголовков — пусто")

# --- промпт ---
check(m.build_prompt("a {{x}} b {{y}} {x}", {"x": "1", "y": "{2}"}) == "a 1 b {2} {x}",
      "подстановка только {{key}}, фигурные скобки значений не ломают")

print(f"\nИтого провалов: {failed}")
sys.exit(1 if failed else 0)
