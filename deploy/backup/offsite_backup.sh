#!/bin/bash
# offsite_backup.sh — копия вне сервера (restic → Yandex Object Storage, бакет saas-backup1).
# Запускается вторым шагом saas-backup.service, сразу после ночного pg_dump (/opt/agentsDB/backup_saas.sh).
#
# Что уходит (restic шифрует на сервере до отправки):
#   - последний дамп БД /opt/agentsDB/backups/saas_*.sql.gz
#   - код проекта целиком, включая .git (дублирует GitHub, ловит и неотправленные коммиты)
#   - секреты: .env.local, /etc/saas-*.env (кроме saas-backup.env), /etc/collectors.env, .pgpass-файлы,
#     ключ деплоя GitHub — без SAAS_CRED_MASTER_KEY восстановленная база не расшифрует ключи МП
#   - системная обвязка: юниты saas-*, tmpfiles, скрипт ночного дампа
# Не уходит: node_modules/.next/venv (пересобираются), профиль браузера кабинета Ozon (владелец входит заново).
#
# Креды и пароль restic — /etc/saas-backup.env (root, 600). Пароль restic хранится ТАКЖЕ у владельца
# вне сервера: без него копию не расшифровать. Восстановление — docs/backup-restore.md.
set -euo pipefail

LOG_FILE="/opt/agentsDB/logs/backup_saas.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] offsite: $*" | tee -a "$LOG_FILE"; }

: "${RESTIC_REPOSITORY:?нет RESTIC_REPOSITORY (/etc/saas-backup.env)}"
: "${RESTIC_PASSWORD:?нет RESTIC_PASSWORD (/etc/saas-backup.env)}"
export RESTIC_CACHE_DIR=/var/cache/restic

LATEST_DUMP=$(ls -1t /opt/agentsDB/backups/saas_*.sql.gz 2>/dev/null | head -1 || true)
[ -n "$LATEST_DUMP" ] || { log "FAIL: нет дампа saas_*.sql.gz"; exit 1; }
# Дамп должен быть свежим (этой ночи), иначе отправили бы вчерашний под видом сегодняшнего
if [ -n "$(find "$LATEST_DUMP" -mmin +180)" ]; then
    log "FAIL: последний дамп старше 3 часов: $LATEST_DUMP"; exit 1
fi

PATHS=(
    "$LATEST_DUMP"
    /opt/agents/saas
    /opt/agentsDB/backup_saas.sh
    /etc/saas-worker.env /etc/collectors.env /etc/saas-triage.env
    /etc/systemd/system/saas-*
    /etc/tmpfiles.d/saas-triage.conf
    /root/.pgpass /root/.pgpass-admin
    /var/lib/saas-triage/.pgpass
    /root/.ssh/saas_github /root/.ssh/saas_github.pub
)
EXISTING=()
for p in "${PATHS[@]}"; do [ -e "$p" ] && EXISTING+=("$p"); done

log "старт: дамп $(basename "$LATEST_DUMP"), путей ${#EXISTING[@]}"
restic backup --quiet --tag nightly \
    --exclude '/opt/agents/saas/node_modules' \
    --exclude '/opt/agents/saas/.next' \
    --exclude '/opt/agents/saas/worker/.venv-cabinet' \
    --exclude '**/__pycache__' \
    "${EXISTING[@]}"
log "backup OK"

# Хранение: 14 дневных, 8 недельных, 12 месячных
restic forget --quiet --tag nightly --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
log "retention OK"

# По воскресеньям — проверка целостности 5% данных хранилища
if [ "$(date +%u)" = 7 ]; then
    restic check --read-data-subset=5% >/dev/null
    log "check OK"
fi

log "$(restic snapshots --tag nightly --compact | tail -1)"
