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

# --- triage-git: отклоняющие ветки (до exec git) ---
check_rc "triage-git: --no-index запрещён"                             2 "$BIN/triage-git" diff --no-index
check_rc "triage-git: абсолютный путь запрещён"                        2 "$BIN/triage-git" show /etc/hostname
check_rc "triage-git: '..' в пути запрещён"                            2 "$BIN/triage-git" log ../x
check_rc "triage-git: голый -- запрещён"                               2 "$BIN/triage-git" log --
check_rc "triage-git: -O (запрещённый флаг -[oO]*) запрещён"           2 "$BIN/triage-git" log -O
check_rc "triage-git: 001_tenant_core запрещён (захардкоженный пароль)" 2 "$BIN/triage-git" show HEAD:db/migrations/001_tenant_core.sql
check_rc "triage-git: диапазон a..b запрещён"                          2 "$BIN/triage-git" log a..b
check_rc "triage-git: обычный log работает (позитив)"                  0 "$BIN/triage-git" log --oneline -1

# --- triage-sql: отклоняющие ветки (до PGOPTIONS/psql) ---
check_rc "triage-sql: обратная косая запрещена"                        2 "$BIN/triage-sql" 'bad\sql'
check_rc "triage-sql: два аргумента запрещены"                         2 "$BIN/triage-sql" "select 1" "select 2"

# --- triage-journal: отклоняющие ветки (до exec journalctl) ---
check_rc "triage-journal: юнит не saas-* запрещён"                     2 "$BIN/triage-journal" notaunit "2026-10-01 00:00" "2026-10-01 01:00"
check_rc "triage-journal: битое время запрещено"                       2 "$BIN/triage-journal" saas-worker.service "bad-time" "2026-10-01 01:00"

echo
if [ "$failed" -eq 0 ]; then
    echo "Итого: всё PASS"
else
    echo "Итого: есть FAIL"
fi
exit "$failed"
