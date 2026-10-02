#!/bin/bash
# deploy/install-triage-user.sh — вариант 2 авторазбора (02.10.2026): отдельный системный
# пользователь saas-triage для claude -p и своя роль БД saas_triage без доступа к ключам.
# Идемпотентен, запуск под root: bash deploy/install-triage-user.sh
#
# Что делает:
#   1. системный пользователь saas-triage (nologin, HOME=/var/lib/saas-triage 700), группа
#      systemd-journal — для triage-journal;
#   2. роль БД saas_triage (db/ops/saas_triage_role.sql); пароль генерируется один раз и лежит
#      только в /var/lib/saas-triage/.pgpass (600, saas-triage) — triage-sql берёт его оттуда;
#   3. каталог /run/saas-triage (750 root:saas-triage) — туда тик кладёт список строк для
#      вычёркивания из вывода triage-git (tmpfiles.d, переживает перезагрузку).
# Вход в claude под этим пользователем делает владелец (см. AGENTS.md, «Авторазбор»).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
U=saas-triage
H=/var/lib/saas-triage

getent passwd "$U" >/dev/null || useradd --system --home-dir "$H" --create-home \
  --shell /usr/sbin/nologin --comment "SAAS failure triage (claude -p, read-only)" "$U"
usermod -aG systemd-journal "$U"
install -d -m 700 -o "$U" -g "$U" "$H"

echo "d /run/saas-triage 0750 root $U -" > /etc/tmpfiles.d/saas-triage.conf
systemd-tmpfiles --create /etc/tmpfiles.d/saas-triage.conf

PGP="$H/.pgpass"
if [ -s "$PGP" ]; then
  pw="$(cut -d: -f5- "$PGP" | head -1)"
else
  pw="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  umask 077
  printf 'localhost:5432:saas:saas_triage:%s\n' "$pw" > "$PGP"
  chown "$U:$U" "$PGP"; chmod 600 "$PGP"
fi
# Пароль — через stdin psql (\set), не в argv: не виден в списке процессов.
{ printf '\\set pw %s\n' "'$pw'"; cat "$REPO/db/ops/saas_triage_role.sql"; } |
  PGPASSFILE=/root/.pgpass-admin psql -X -q -h localhost -U postgres -d saas -v ON_ERROR_STOP=1
unset pw

echo "saas-triage: пользователь, роль БД и /run/saas-triage готовы."
if runuser -u "$U" -- test -s "$H/.claude/.credentials.json" 2>/dev/null; then
  echo "вход в claude под $U: есть"
else
  echo "вход в claude под $U: НЕТ — до входа тик авторазбора эпизоды не берёт (см. AGENTS.md)."
fi
