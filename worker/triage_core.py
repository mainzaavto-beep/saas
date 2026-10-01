"""
triage_core.py — чистое ядро авторазбора падений сборщиков
(спека docs/superpowers/specs/2026-09-30-failure-triage-design.md §4–5).

Без БД, сети и subprocess: оболочка worker/failure_triage.py подаёт выборки и
применяет решения. Селф-тест: worker/triage_core_selftest.py.
"""
import json
import re
from datetime import datetime, timedelta

FAIL = {"failed", "timeout"}
COUNTED = {"ok", "partial", "failed", "timeout"}   # skipped / no_token не учитываются
IGNORED_KINDS = {"manual"}                        # ручные пробы не порождают разборы
SELF_PREFIX = "unit:saas-triage"                  # разбор не разбирает себя

# Юнит → run_kind его сборщиков. Запись unit:* делает OnFailure в КОНЦЕ прогона,
# а прогон длится до часа, поэтому эхо ищется в окне [−70; +5] мин.
UNIT_KIND = {
    "unit:saas-worker.service": "main",
    "unit:saas-stocks.service": "stocks",
    "unit:saas-metrics30m.service": "metrics30m",
    "unit:saas-references.service": "references",
    "unit:saas-backfill.service": "backfill",
    "unit:saas-cabinet.service": "cabinet",
    "unit:saas-fbs-status.service": "fbsstatus",
    "unit:saas-sku-ad-night.service": "skuad",
}
KIND_UNIT = {v: k[len("unit:"):] for k, v in UNIT_KIND.items()}
ECHO_BEFORE = timedelta(minutes=70)
ECHO_AFTER = timedelta(minutes=5)
UNIT_QUIET = timedelta(hours=24)
STALE = timedelta(minutes=30)
DAILY_LIMIT = 3

STRUCTURED_KEY = "structured_output"   # ключ конверта claude -p --output-format json (проба Task 1)
CAUSES = {"mp_method_changed", "rate_limit", "auth", "our_bug", "data", "infra", "unknown"}
CONFIDENCE = {"high", "medium", "low"}
REQUIRED = {"summary": str, "cause": str, "confidence": str, "evidence": list,
            "proposed_fix": str, "data_impact": str, "urgent": bool}


def is_unit(collector):
    return collector.startswith("unit:")


def _desc(rs):
    return sorted(rs, key=lambda r: (r["started_at"], r["id"]), reverse=True)


def _is_echo(unit_run, collector_fails):
    kind = UNIT_KIND.get(unit_run["collector"])
    if kind is None:
        return False
    t = unit_run["started_at"]
    return any(r["run_kind"] == kind and t - ECHO_BEFORE <= r["started_at"] <= t + ECHO_AFTER
               for r in collector_fails)


def _new(key, opened_at, last_id):
    return {"collector": key[0], "cabinet_id": key[1], "opened_at": opened_at, "last_failed_run_id": last_id}


def plan_tick(runs, open_episodes, now):
    """Решения одного тика. runs — прогоны за 7 дней, open_episodes — status <> 'closed'."""
    runs = [r for r in runs
            if r["run_kind"] not in IGNORED_KINDS and not r["collector"].startswith(SELF_PREFIX)]
    eps = {(e["collector"], e["cabinet_id"]): e for e in open_episodes}
    collector_fails = [r for r in runs if not is_unit(r["collector"]) and r["status"] in FAIL]
    pairs = {}
    for r in runs:
        pairs.setdefault((r["collector"], r["cabinet_id"]), []).append(r)

    out = {"open": [], "close": [], "bump": [], "stale": []}

    def close(e):
        if e["status"] != "running":
            out["close"].append(e["id"])

    for key, rs in pairs.items():
        rs = _desc(rs)
        e = eps.get(key)
        if is_unit(key[0]):
            fails = [r for r in rs if r["status"] in FAIL and not _is_echo(r, collector_fails)]
            if not fails:
                if e:
                    close(e)
                continue
            head = fails[0]
            if e is None:
                if (len(fails) >= 2 and head["started_at"] - fails[1]["started_at"] <= UNIT_QUIET
                        and now - head["started_at"] < UNIT_QUIET):
                    out["open"].append(_new(key, fails[1]["started_at"], head["id"]))
            elif now - head["started_at"] >= UNIT_QUIET:
                close(e)
            elif head["id"] != e["last_failed_run_id"]:
                out["bump"].append((e["id"], head["id"]))
            continue

        counted = [r for r in rs if r["status"] in COUNTED]
        if not counted:
            continue
        head = counted[0]
        if e is not None:
            if head["status"] == "ok":
                close(e)
            elif head["status"] in FAIL and head["id"] != e["last_failed_run_id"]:
                out["bump"].append((e["id"], head["id"]))
            continue
        if len(counted) >= 2 and counted[0]["status"] in FAIL and counted[1]["status"] in FAIL:
            start = head
            for r in counted:
                if r["status"] not in FAIL:
                    break
                start = r
            out["open"].append(_new(key, start["started_at"], head["id"]))

    for key, e in eps.items():
        if key not in pairs:
            close(e)
        if e["status"] == "running" and e.get("started_at") and now - e["started_at"] > STALE:
            out["stale"].append(e["id"])
    return out


def pick_next(open_episodes, started_24h):
    """Следующий эпизод к разбору: самый старый queued, если нет running и лимит не выбран."""
    if any(e["status"] == "running" for e in open_episodes):
        return None
    if started_24h >= DAILY_LIMIT:
        return None
    queued = [e for e in open_episodes if e["status"] == "queued"]
    if not queued:
        return None
    return min(queued, key=lambda e: (e["opened_at"], e["id"]))["id"]


def validate_report(rep):
    if not isinstance(rep, dict):
        return None, "отчёт не объект"
    for k, t in REQUIRED.items():
        if not isinstance(rep.get(k), t):
            return None, f"поле {k}: ожидался {t.__name__}"
    if rep["cause"] not in CAUSES:
        return None, f"cause вне перечня: {rep['cause']}"
    if rep["confidence"] not in CONFIDENCE:
        return None, f"confidence вне перечня: {rep['confidence']}"
    return rep, None


def parse_claude_output(stdout, returncode):
    """(отчёт, None) либо (None, причина ошибки)."""
    if returncode != 0:
        return None, f"claude завершился с кодом {returncode}"
    try:
        env = json.loads(stdout)
    except ValueError as e:
        return None, f"ответ не JSON: {e}"
    if not isinstance(env, dict):
        return None, "конверт ответа не объект"
    if env.get("is_error"):
        return None, f"claude is_error: {str(env.get('result'))[:300]}"
    rep = env.get(STRUCTURED_KEY)
    if rep is None:
        try:
            rep = json.loads(env.get("result") or "")
        except ValueError:
            return None, f"нет {STRUCTURED_KEY}, а result не JSON"
    return validate_report(rep)


_HDR = re.compile(r"^=== SaaS \S+ \[[^\]]*\] \w{3} (\w{3}) +(\d+) (\d\d:\d\d:\d\d) \S+ (\d{4})")


def _hdr_time(line):
    mt = _HDR.match(line)
    if not mt:
        return None
    try:
        return datetime.strptime(f"{mt[1]} {mt[2]} {mt[3]} {mt[4]}", "%b %d %H:%M:%S %Y")
    except ValueError:
        return None


def slice_worker_log(text, collector, at_msk, max_lines=200):
    """Строки сборщика из блока прогона saas_worker.log, начавшегося последним до at_msk.
    Строка с [collector] + 3 следующих (трейсбек). at_msk — naive MSK (как `date` в логе)."""
    blocks, cur = [], None
    for line in text.splitlines():
        t = _hdr_time(line)
        if t is not None:
            cur = (t, [])
            blocks.append(cur)
        elif cur is not None:
            cur[1].append(line)
    cand = [b for b in blocks if b[0] <= at_msk + timedelta(minutes=1)]
    if not cand:
        return ""
    lines = cand[-1][1]
    tag = f"[{collector}]"
    keep = set()
    for i, line in enumerate(lines):
        if tag in line:
            keep.update(range(i, min(i + 4, len(lines))))
    out = [lines[i] for i in sorted(keep) if not _hdr_time(lines[i])]
    return "\n".join(out[-max_lines:])


def build_prompt(template, ctx):
    out = template
    for k, v in ctx.items():
        out = out.replace("{{" + k + "}}", v)
    return out
