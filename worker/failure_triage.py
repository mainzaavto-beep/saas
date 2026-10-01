"""
failure_triage.py — тик сторожа авторазбора падений (таймер saas-triage, каждые 15 мин).
Спека docs/superpowers/specs/2026-09-30-failure-triage-design.md.

  python -m worker.failure_triage             # обычный тик
  python -m worker.failure_triage --dry-run   # план тика и выбранный эпизод, без записи и без claude
  python -m worker.failure_triage --episode N # разобрать конкретный queued-эпизод (лимиты не проверяются)

Решения — worker/triage_core.py (чистое ядро). Здесь только I/O: PG под postgres
(как worker/record_failure.py), сбор контекста, subprocess claude, вызов писем.
Разбор — только диагноз: claude запускается с инструментами на чтение и БД под saas_ro.
"""
import argparse
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from worker import triage_core as core

REPO = Path(__file__).resolve().parent.parent
PROMPT = REPO / "worker" / "triage_prompt.md"
SCHEMA = REPO / "worker" / "triage_schema.json"
NOTIFY = REPO / "scripts" / "notify-triage.mjs"
WORKER_LOG = Path("/opt/agentsDB/logs/saas_worker.log")
LOG_TAIL_BYTES = 4 * 1024 * 1024
MSK = ZoneInfo("Europe/Moscow")
CLAUDE = os.environ.get("SAAS_TRIAGE_CLAUDE", "/usr/bin/claude")
MODEL = os.environ.get("SAAS_TRIAGE_MODEL", "sonnet")
TIMEOUT = int(os.environ.get("SAAS_TRIAGE_TIMEOUT_SEC", "1200"))
ALLOWED = ["Read", "Grep", "Glob", "WebFetch", "WebSearch",
           "Bash(psql -h localhost -U saas_ro:*)", "Bash(journalctl:*)",
           "Bash(git log:*)", "Bash(git show:*)", "Bash(git diff:*)",
           "Bash(grep:*)", "Bash(tail:*)", "Bash(head:*)", "Bash(wc:*)", "Bash(ls:*)"]
DISALLOWED = ["Edit", "Write", "NotebookEdit", "Agent",
              "Read(/root/.pgpass*)", "Read(/opt/agents/saas/.env.local)",
              "Read(/etc/saas-worker.env)", "Read(/etc/collectors.env)"]

RUNS_SQL = """SELECT id, collector, cabinet_id, run_kind, status, started_at
                FROM jobs.collector_runs WHERE started_at > now() - interval '7 days'"""
OPEN_SQL = """SELECT id, collector, cabinet_id, status, opened_at, started_at, last_failed_run_id
                FROM jobs.failure_triage WHERE status <> 'closed'"""


def log(msg):
    print(f"[triage] {msg}", flush=True)


def connect():
    return psycopg.connect(
        host=os.environ.get("SAAS_DB_HOST", "localhost"),
        port=os.environ.get("SAAS_DB_PORT", "5432"),
        dbname=os.environ.get("SAAS_DB", "saas"),
        user="postgres",
        password=os.environ.get("POSTGRES_PASSWORD", ""),
        row_factory=dict_row)


def apply_plan(conn, plan):
    for o in plan["open"]:
        conn.execute(
            "INSERT INTO jobs.failure_triage (collector, cabinet_id, status, opened_at, last_failed_run_id) "
            "VALUES (%s, %s, 'queued', %s, %s) "
            "ON CONFLICT (collector, (COALESCE(cabinet_id, 0))) WHERE status <> 'closed' DO NOTHING",
            (o["collector"], o["cabinet_id"], o["opened_at"], o["last_failed_run_id"]))
    if plan["close"]:
        conn.execute("UPDATE jobs.failure_triage SET status = 'closed', closed_at = now() "
                     "WHERE id = ANY(%s) AND status <> 'running'", (plan["close"],))
    for ep_id, run_id in plan["bump"]:
        conn.execute("UPDATE jobs.failure_triage SET last_failed_run_id = %s WHERE id = %s", (run_id, ep_id))
    if plan["stale"]:
        conn.execute("UPDATE jobs.failure_triage SET status = 'error', finished_at = now(), "
                     "raw_output = 'разбор прерван: running дольше 30 мин' "
                     "WHERE id = ANY(%s) AND status = 'running'", (plan["stale"],))


def _sh(cmd, timeout=30):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=REPO)
        return (p.stdout or p.stderr).strip()
    except Exception as e:  # контекст необязателен — разбор идёт и без него
        log(f"контекст: {cmd[0]} не отработал: {e}")
        return ""


def _worker_log_tail():
    try:
        with WORKER_LOG.open("rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - LOG_TAIL_BYTES))
            return f.read().decode("utf-8", "replace")
    except OSError as e:
        log(f"лог воркера не прочитан: {e}")
        return ""


def build_context(conn, ep):
    runs = conn.execute(
        "SELECT started_at, run_kind, status, rows_written, left(error, 2000) AS error "
        "FROM jobs.collector_runs WHERE collector = %s AND cabinet_id IS NOT DISTINCT FROM %s "
        "ORDER BY started_at DESC LIMIT 10", (ep["collector"], ep["cabinet_id"])).fetchall()
    runs_txt = "\n".join(
        f"- {r['started_at'].astimezone(MSK):%Y-%m-%d %H:%M} MSK [{r['run_kind']}] {r['status']}"
        f" rows={r['rows_written']}" + (f"\n  error: {r['error']}" if r["error"] else "")
        for r in runs) or "(нет)"
    last = conn.execute("SELECT run_kind, started_at FROM jobs.collector_runs WHERE id = %s",
                        (ep["last_failed_run_id"],)).fetchone()
    at = (last["started_at"] if last else ep["opened_at"])
    since = (at - timedelta(minutes=5)).astimezone(MSK).strftime("%Y-%m-%d %H:%M:%S")
    until = (at + timedelta(minutes=70)).astimezone(MSK).strftime("%Y-%m-%d %H:%M:%S")
    if core.is_unit(ep["collector"]):
        unit = ep["collector"][len("unit:"):]
        log_txt = _sh(["journalctl", "-u", unit, "--since", since, "--until", until, "--no-pager", "-n", "200"])
    else:
        log_txt = core.slice_worker_log(_worker_log_tail(), ep["collector"],
                                        at.astimezone(MSK).replace(tzinfo=None))
        if not log_txt and last and last["run_kind"] in core.KIND_UNIT:
            log_txt = _sh(["journalctl", "-u", core.KIND_UNIT[last["run_kind"]], "--since", since,
                           "--until", until, "--no-pager", "-n", "200"])
    src = REPO / "worker" / "collectors" / f"{ep['collector']}.py"
    source = str(src.relative_to(REPO)) if src.exists() else "(не найден — определи по AGENTS.md)"
    git_log = _sh(["git", "log", "--oneline", "-15", "--", source]) if src.exists() else "(нет)"
    return {
        "episode_id": str(ep["id"]),
        "collector": ep["collector"],
        "cabinet": "сервер (юнит systemd)" if ep["cabinet_id"] is None else f"#{ep['cabinet_id']}",
        "opened_at": f"{ep['opened_at'].astimezone(MSK):%Y-%m-%d %H:%M} MSK",
        "runs": runs_txt,
        "log": log_txt or "(строк не найдено)",
        "source": source,
        "git_log": git_log or "(нет)",
    }


def run_claude(prompt):
    cmd = [CLAUDE, "-p", "--model", MODEL, "--output-format", "json",
           "--json-schema", SCHEMA.read_text(),
           "--setting-sources", "user", "--permission-mode", "default",
           "--allowedTools", *ALLOWED, "--disallowedTools", *DISALLOWED]
    env = {k: v for k, v in os.environ.items()
           if k not in ("POSTGRES_PASSWORD", "SAAS_APP_DB_PASSWORD", "SAAS_CRED_MASTER_KEY")}
    try:
        p = subprocess.run(cmd, input=prompt, capture_output=True, text=True,
                           timeout=TIMEOUT, cwd=REPO, env=env)
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return None, f"таймаут {TIMEOUT} с", out
    except (OSError, subprocess.SubprocessError) as e:
        return None, f"не удалось запустить claude: {e}", ""
    rep, err = core.parse_claude_output(p.stdout, p.returncode)
    return rep, err, f"{p.stdout}\n--- stderr ---\n{p.stderr}"


def triage(ep):
    with connect() as conn:
        ctx = build_context(conn, ep)
    prompt = core.build_prompt(PROMPT.read_text(), ctx)
    log(f"разбор эпизода #{ep['id']} {ep['collector']} каб={ep['cabinet_id']}")
    rep, err, raw = run_claude(prompt)
    with connect() as conn:
        if rep:
            conn.execute(
                "UPDATE jobs.failure_triage SET status = 'done', finished_at = now(), summary = %s, "
                "cause = %s, confidence = %s, urgent = %s, report_json = %s, raw_output = NULL "
                "WHERE id = %s AND status = 'running'",
                (rep["summary"], rep["cause"], rep["confidence"], rep["urgent"], Jsonb(rep), ep["id"]))
            log(f"#{ep['id']} готов: {rep['cause']} ({rep['confidence']})")
        else:
            conn.execute(
                "UPDATE jobs.failure_triage SET status = 'error', finished_at = now(), raw_output = %s "
                "WHERE id = %s AND status = 'running'",
                (f"{err}\n\n{raw}"[:20000], ep["id"]))
            log(f"#{ep['id']} разбор не удался: {err}")


def notify():
    if not NOTIFY.exists():
        return
    try:
        p = subprocess.run(["/usr/bin/node", str(NOTIFY)], capture_output=True, text=True, timeout=120, cwd=REPO)
        if p.stdout.strip():
            log(p.stdout.strip())
        if p.returncode != 0:
            log(f"письма: exit {p.returncode}: {p.stderr.strip()[:500]}")
    except Exception as e:
        log(f"письма не отправлены: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--episode", type=int)
    a = ap.parse_args()
    if os.environ.get("SAAS_TRIAGE_ENABLED", "1") == "0":
        log("выключен (SAAS_TRIAGE_ENABLED=0)")
        return 0
    now = datetime.now(timezone.utc)
    claimed = None
    with connect() as conn:
        plan = core.plan_tick(conn.execute(RUNS_SQL).fetchall(), conn.execute(OPEN_SQL).fetchall(), now)
        log(f"план: открыть {len(plan['open'])}, закрыть {len(plan['close'])}, "
            f"обновить {len(plan['bump'])}, зависших {len(plan['stale'])}")
        if a.dry_run:
            for o in plan["open"]:
                log(f"  открыть: {o['collector']} каб={o['cabinet_id']} с {o['opened_at']}")
            conn.rollback()
            return 0
        apply_plan(conn, plan)
        conn.commit()
        if a.episode:
            ep_id = a.episode
        else:
            started = conn.execute("SELECT count(*) AS n FROM jobs.failure_triage "
                                   "WHERE started_at > now() - interval '24 hours'").fetchone()["n"]
            ep_id = core.pick_next(conn.execute(OPEN_SQL).fetchall(), started)
        if ep_id:
            claimed = conn.execute(
                "UPDATE jobs.failure_triage SET status = 'running', started_at = now() "
                "WHERE id = %s AND status = 'queued' RETURNING *", (ep_id,)).fetchone()
            conn.commit()
    if claimed:
        triage(claimed)
    notify()
    return 0


if __name__ == "__main__":
    sys.exit(main())
