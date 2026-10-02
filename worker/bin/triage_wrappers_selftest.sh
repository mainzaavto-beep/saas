#!/bin/bash
# worker/bin/triage_wrappers_selftest.sh — проверка отклоняющих веток песочниц claude -p
# (triage-sql/triage-git/triage-journal), которые должны отказать ДО обращения к БД/файлам/
# journalctl (ревью task-9 раунд 1, 01.10.2026, Minor 4). Не бьёт по сети/БД: единственная
# позитивная ветка — дешёвый `git log` по локальному репозиторию.
# Запуск: worker/bin/triage_wrappers_selftest.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
BIN="$(pwd)/worker/bin"
failed=0

check_rc() {
    local desc="$1" want="$2"; shift 2
    local out
    out="$("$@" 2>&1)"
    local rc=$?
    if [ "$rc" -eq "$want" ]; then
        echo "PASS — $desc (exit $rc)"
    else
        echo "FAIL — $desc (хотели exit $want, получили $rc): $out"
        failed=1
    fi
}

# I1 (ревью раунд 2, 01.10.2026): пароль saas_app не должен попасть в вывод triage-git, даже
# когда путь к 001_tenant_core.sql не назван в аргументах явно (ревизия вместо пути). Значение
# читаем так же, как сама обёртка — из /etc/saas-worker.env, не экспортируем, не печатаем,
# считаем только количество совпавших строк.
check_no_password() {
    local desc="$1"; shift
    local pass cnt
    pass="$( . /etc/saas-worker.env 2>/dev/null; printf '%s' "${SAAS_APP_DB_PASSWORD:-}" )" || true
    if [ -z "$pass" ]; then
        echo "SKIP — $desc (SAAS_APP_DB_PASSWORD не задан)"
        return
    fi
    cnt="$("$@" 2>&1 | grep -cF -f <(printf '%s\n' "$pass"))" || true
    if [ "${cnt:-0}" -eq 0 ]; then
        echo "PASS — $desc (0 строк с паролем)"
    else
        echo "FAIL — $desc (строк с паролем: $cnt)"
        failed=1
    fi
}

# --- triage-git: отклоняющие ветки (до exec git) ---
check_rc "triage-git: --no-index запрещён"                             2 "$BIN/triage-git" diff --no-index
check_rc "triage-git: абсолютный путь запрещён"                        2 "$BIN/triage-git" show /etc/hostname
check_rc "triage-git: '..' в пути запрещён"                            2 "$BIN/triage-git" log ../x
check_rc "triage-git: голый -- запрещён"                               2 "$BIN/triage-git" log --
check_rc "triage-git: -O (запрещённый флаг -[oO]*) запрещён"           2 "$BIN/triage-git" log -O
check_rc "triage-git: 001_tenant_core запрещён (захардкоженный пароль)" 2 "$BIN/triage-git" show HEAD:db/migrations/001_tenant_core.sql
check_rc "triage-git: диапазон a..b запрещён"                          2 "$BIN/triage-git" log a..b
check_rc "triage-git: обычный log работает (позитив)"                  0 "$BIN/triage-git" log --oneline -1
check_no_password "triage-git: show f288080 без пароля"                  "$BIN/triage-git" show f288080
check_no_password "triage-git: log -p db/migrations без пароля"          "$BIN/triage-git" log -p db/migrations

# --- triage-sql: отклоняющие ветки (до PGOPTIONS/psql) ---
check_rc "triage-sql: обратная косая запрещена"                        2 "$BIN/triage-sql" 'bad\sql'
check_rc "triage-sql: два аргумента запрещены"                         2 "$BIN/triage-sql" "select 1" "select 2"

# --- triage-journal: отклоняющие ветки (до exec journalctl) ---
check_rc "triage-journal: юнит не saas-* запрещён"                     2 "$BIN/triage-journal" notaunit "2026-10-01 00:00" "2026-10-01 01:00"
check_rc "triage-journal: битое время запрещено"                       2 "$BIN/triage-journal" saas-worker.service "bad-time" "2026-10-01 01:00"

# --- вариант 2 (02.10.2026): граница под пользователем saas-triage ---
TU=saas-triage
if getent passwd "$TU" >/dev/null && [ "$(id -u)" -eq 0 ]; then
    as_u() { runuser -u "$TU" -- "$@"; }
    for f in /etc/saas-worker.env /etc/collectors.env /etc/saas-triage.env /opt/agents/saas/.env.local /root/.pgpass /root/.claude/settings.local.json; do
        check_rc "saas-triage: не читает $f"                            1 as_u test -r "$f"
    done
    check_rc "saas-triage: не пишет в worker/"                           1 as_u test -w /opt/agents/saas/worker
    check_rc "saas-triage: не пишет в worker/bin/"                       1 as_u test -w /opt/agents/saas/worker/bin
    check_rc "saas-triage: triage-sql читает tenant (позитив)"          0 as_u "$BIN/triage-sql" "select count(*) from tenant.wb_orders where cabinet_id=1"
    check_rc "saas-triage: triage-sql не видит api_creds_enc"            1 as_u "$BIN/triage-sql" "select api_creds_enc from auth.shops limit 1"
    check_rc "saas-triage: triage-sql не видит хэши паролей"             1 as_u "$BIN/triage-sql" "select password_hash from auth.users limit 1"
    check_rc "saas-triage: triage-sql не видит user_tokens"              1 as_u "$BIN/triage-sql" "select count(*) from auth.user_tokens"
    check_rc "saas-triage: triage-sql запись отклонена"                  1 as_u "$BIN/triage-sql" "create table tenant.triage_probe(i int)"
    if [ -s /run/saas-triage/redact ]; then
        echo "SKIP — saas-triage: отказ triage-git без redact (идёт разбор, файл есть)"
    else
        check_rc "saas-triage: triage-git без redact отказывает"        3 as_u "$BIN/triage-git" log --oneline -1
        # позитив: со списком вычёркивания (как его кладёт тик) git работает и пароля в выводе нет
        tmp_r=/run/saas-triage/redact.selftest
        if [ -d /run/saas-triage ] && ( . /etc/saas-worker.env 2>/dev/null; [ -n "${SAAS_APP_DB_PASSWORD:-}" ] ); then
            ( umask 027; . /etc/saas-worker.env; printf '%s\n' "$SAAS_APP_DB_PASSWORD" > "$tmp_r" ); chgrp "$TU" "$tmp_r"
            check_rc "saas-triage: triage-git с redact работает (позитив)" 0 as_u env SAAS_TRIAGE_REDACT="$tmp_r" "$BIN/triage-git" log --oneline -1
            check_no_password "saas-triage: show f288080 без пароля"           as_u env SAAS_TRIAGE_REDACT="$tmp_r" "$BIN/triage-git" show f288080
            rm -f "$tmp_r"
        fi
    fi
else
    echo "SKIP — проверки пользователя saas-triage (нет пользователя или не root)"
fi

echo
if [ "$failed" -eq 0 ]; then
    echo "Итого: всё PASS"
else
    echo "Итого: есть FAIL"
fi
exit "$failed"
