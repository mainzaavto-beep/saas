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
import signal
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
BIN = REPO / "worker" / "bin"
# Абсолютные пути в правилах Claude Code — с двумя слешами (//path); один слеш = от каталога проекта.
# Read/Grep/Glob — allow-list по каталогам, а не голые имена инструментов: голое "Read" читало
# ЛЮБОЙ путь на диске (под rootʼом воркера), включая чужие продукты (`/opt/agents/*/.env*`,
# `ozon-panel/.../.pw-profile/**` — живая сессия владельца, `/opt/agentsDB/backups/**` — дампы PG).
# Разбор падений сборщика никогда не выходит за пределы своего репозитория и общего лога воркера —
# им и ограничен allow-list. Разбор итераций, проб обхода и почему это не no-op — §11 спеки.
ALLOWED = ["Read(//opt/agents/saas/**)", "Read(//opt/agentsDB/logs/**)",
           "Grep(//opt/agents/saas/**)", "Grep(//opt/agentsDB/logs/**)",
           "Glob(//opt/agents/saas/**)", "Glob(//opt/agentsDB/logs/**)",
           "WebFetch(domain:dev.wildberries.ru)", "WebFetch(domain:docs.ozon.ru)",
           f"Bash({BIN}/triage-sql:*)", f"Bash({BIN}/triage-journal:*)", f"Bash({BIN}/triage-git:*)"]
# Deny поверх allow — для исключений ВНУТРИ уже разрешённого /opt/agents/saas/** (deny побеждает
# allow на более глубоком пути) плюс общая подстраховка на случай растущего allow-списка.
DISALLOWED = ["Edit", "Write", "NotebookEdit", "Agent", "WebSearch",
              "Read(//root/**)", "Read(//proc/**)", "Read(//sys/**)", "Read(//etc/**)",
              "Read(//opt/agents/saas/.env*)", "Read(//opt/agents/saas/.claude/**)",
              # заплатка до отдельной чистки: захардкоженный пароль БД в этом файле (см. triage-git).
              "Read(//opt/agents/saas/db/migrations/001_tenant_core.sql)"]
# Окружение claude — белый список: секреты воркера (POSTGRES_PASSWORD, SAAS_*_PASSWORD,
# SAAS_CRED_MASTER_KEY и любые будущие) не наследуются ни claude, ни его Bash-детьми.
ENV_KEEP = ("PATH", "HOME", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME", "TERM")

RUNS_SQL = """SELECT id, collector, cabinet_id, run_kind, status, started_at
                FROM jobs.collector_runs WHERE started_at > now() - interval '7 days'"""
OPEN_SQL = """SELECT id, collector, cabinet_id, status, opened_at, started_at, finished_at,
                     last_failed_run_id, attempts
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
        # Minor 2 (ревью task-9 раунд 1): зависший running — тот же сбой, что и неудачный
        # claude (retryable=True), решение через core.after_failure по attempts этого
        # эпизода — повтор, если лимит не исчерпан, а не сразу окончательный error.
        rows = conn.execute("SELECT id, attempts FROM jobs.failure_triage WHERE id = ANY(%s)",
                            (plan["stale"],)).fetchall()
        for r in rows:
            status = core.after_failure(r["attempts"], True)
            conn.execute(
                "UPDATE jobs.failure_triage SET status = %s, finished_at = now(), "
                "raw_output = 'разбор прерван: running дольше 30 мин' "
                "WHERE id = %s AND status = 'running'", (status, r["id"]))


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
    # Окно журнала несимметрично: у сборщиков started_at близко к моменту ошибки в логе
    # (−5/+70 — прогон длится до часа); у unit:* запись OnFailure делает В КОНЦЕ прогона, поэтому
    # сам сбой в journalctl мог случиться до 70 мин РАНЬШЕ started_at записи (I1, task-9).
    since_c = (at - timedelta(minutes=5)).astimezone(MSK).strftime("%Y-%m-%d %H:%M:%S")
    until_c = (at + timedelta(minutes=70)).astimezone(MSK).strftime("%Y-%m-%d %H:%M:%S")
    if core.is_unit(ep["collector"]):
        unit = ep["collector"][len("unit:"):]
        since_u = (at - timedelta(minutes=70)).astimezone(MSK).strftime("%Y-%m-%d %H:%M:%S")
        until_u = (at + timedelta(minutes=5)).astimezone(MSK).strftime("%Y-%m-%d %H:%M:%S")
        log_txt = _sh(["journalctl", "-u", unit, "--since", since_u, "--until", until_u, "--no-pager", "-n", "200"])
    else:
        log_txt = core.slice_worker_log(_worker_log_tail(), ep["collector"],
                                        at.astimezone(MSK).replace(tzinfo=None))
        if not log_txt and last and last["run_kind"] in core.KIND_UNIT:
            log_txt = _sh(["journalctl", "-u", core.KIND_UNIT[last["run_kind"]], "--since", since_c,
                           "--until", until_c, "--no-pager", "-n", "200"])
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


def _scrub_proxy(text, proxy):
    """M1: значение SAAS_TRIAGE_PROXY (если задано) не должно осесть в raw_output в БД."""
    return text.replace(proxy, "***") if proxy and text else text


def run_claude(prompt):
    """(rep, err, raw, retryable). Сбой запуска/таймаут claude → retryable=True (стоит
    повторить); иначе решение берётся из core.parse_claude_output."""
    cmd = [CLAUDE, "-p", "--model", MODEL, "--output-format", "json",
           "--json-schema", SCHEMA.read_text(),
           "--setting-sources", "user", "--permission-mode", "default",
           "--allowedTools", *ALLOWED, "--disallowedTools", *DISALLOWED]
    env = {k: os.environ[k] for k in ENV_KEEP if k in os.environ}
    proxy = os.environ.get("SAAS_TRIAGE_PROXY")
    if proxy:
        env["HTTPS_PROXY"] = proxy
        env["HTTP_PROXY"] = proxy
    try:
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, cwd=REPO, env=env, start_new_session=True)
    except (OSError, subprocess.SubprocessError) as e:
        return None, f"не удалось запустить claude: {e}", "", True
    # M2: start_new_session=True делает claude лидером отдельной группы процессов — на таймауте
    # убиваем всю группу (SIGKILL), а не только claude: Bash-детей (triage-sql/journal/git)
    # subprocess.run/Popen без group-kill оставлял бы сиротами после TimeoutExpired.
    try:
        out, err_out = p.communicate(input=prompt, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            # SIGKILL к группе обычно закрывает пайпы почти мгновенно — 10 с с запасом на
            # случай осиротевшего внука вне группы (не наш процесс — не ждём его вечно).
            out, err_out = p.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            out, err_out = "", ""
        raw = _scrub_proxy(f"{out}\n--- stderr ---\n{err_out}", proxy)
        return None, f"таймаут {TIMEOUT} с", raw, True
    rep, err, retryable = core.parse_claude_output(out, p.returncode)
    # err — часть ответа claude (сообщение is_error/ответ маркетплейса) и сохраняется вместе
    # с raw в raw_output (triage()) — скраб нужен и ему, иначе прокси утекает в БД в обход raw.
    err = _scrub_proxy(err, proxy)
    raw = _scrub_proxy(f"{out}\n--- stderr ---\n{err_out}", proxy)
    return rep, err, raw, retryable


def triage(ep):
    with connect() as conn:
        ctx = build_context(conn, ep)
    prompt = core.build_prompt(PROMPT.read_text(), ctx)
    log(f"разбор эпизода #{ep['id']} {ep['collector']} каб={ep['cabinet_id']} "
        f"(попытка {ep['attempts']}/{core.MAX_ATTEMPTS})")
    rep, err, raw, retryable = run_claude(prompt)
    with connect() as conn:
        if rep:
            conn.execute(
                "UPDATE jobs.failure_triage SET status = 'done', finished_at = now(), summary = %s, "
                "cause = %s, confidence = %s, urgent = %s, report_json = %s, raw_output = NULL "
                "WHERE id = %s AND status = 'running'",
                (rep["summary"], rep["cause"], rep["confidence"], rep["urgent"], Jsonb(rep), ep["id"]))
            log(f"#{ep['id']} готов: {rep['cause']} ({rep['confidence']})")
        else:
            # ep["attempts"] — уже увеличенное значение из RETURNING * на claim (main()).
            status = core.after_failure(ep["attempts"], retryable)
            conn.execute(
                "UPDATE jobs.failure_triage SET status = %s, finished_at = now(), raw_output = %s "
                "WHERE id = %s AND status = 'running'",
                (status, f"{err}\n\n{raw}"[:20000], ep["id"]))
            log(f"#{ep['id']} попытка {ep['attempts']}/{core.MAX_ATTEMPTS} не удалась: {err} → {status}")


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
            # Бюджет — ЗАПУСКИ claude за сутки (включая повторы одного эпизода), не эпизоды:
            # иначе эпизод с 3 попытками занимал бы 1 слот из DAILY_LIMIT вместо честных 3.
            started = conn.execute(
                "SELECT count(*) AS n FROM jobs.failure_triage, unnest(run_starts) s "
                "WHERE s > now() - interval '24 hours'").fetchone()["n"]
            ep_id = core.pick_next(conn.execute(OPEN_SQL).fetchall(), started, now)
        if ep_id:
            claimed = conn.execute(
                "UPDATE jobs.failure_triage SET status = 'running', started_at = now(), "
                "finished_at = NULL, attempts = attempts + 1, "
                "run_starts = array_append(run_starts, now()) "
                "WHERE id = %s AND status = 'queued' RETURNING *", (ep_id,)).fetchone()
            conn.commit()
    if claimed:
        triage(claimed)
    notify()
    return 0


if __name__ == "__main__":
    sys.exit(main())
