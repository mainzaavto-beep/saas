# Резервные копии и восстановление

## Что и где

| Слой | Где | Когда |
|---|---|---|
| Дамп БД (локально, 14 дн) | `/opt/agentsDB/backups/saas_*.sql.gz` | 03:00, `saas-backup` шаг 1 (`/opt/agentsDB/backup_saas.sh`) |
| Копия вне сервера: дамп + код с `.git` + секреты + юниты | restic → Yandex Object Storage, бакет `saas-backup1`, путь `restic/` | 03:00, `saas-backup` шаг 2 (`deploy/backup/offsite_backup.sh`) |
| Код | GitHub `mainzaavto-beep/saas` (приватный), ключ деплоя `/root/.ssh/saas_github` | `git push` после работы |

Хранение restic: 14 дневных, 8 недельных, 12 месячных. По воскресеньям `restic check` 5% данных.
Падение любого шага → `OnFailure=saas-failure@`. Лог — `/opt/agentsDB/logs/backup_saas.log`.

Креды бакета и пароль restic — `/etc/saas-backup.env` (root, 600, вне git).
**Пароль restic и `SAAS_CRED_MASTER_KEY` хранятся у владельца вне сервера** — без первого копию не
расшифровать, без второго восстановленная БД не расшифрует ключи маркетплейсов (`auth.shops.api_creds_enc`).

## Восстановление на чистом сервере

```bash
apt-get install -y restic postgresql
cat > /etc/saas-backup.env <<'E'   # chmod 600
AWS_ACCESS_KEY_ID=...              # статический ключ сервисного аккаунта Yandex
AWS_SECRET_ACCESS_KEY=...
RESTIC_REPOSITORY=s3:https://storage.yandexcloud.net/saas-backup1/restic
RESTIC_PASSWORD=...                # из менеджера паролей владельца
E
set -a; . /etc/saas-backup.env; set +a
restic snapshots                   # выбрать снимок (latest — последний)
restic restore latest --target /   # вернёт код, секреты, юниты, дамп на свои места
```

База (роли `saas_app`/`saas_ro`/`saas_triage`/`panel_local_ro` живут в кластере, не в дампе —
сначала `db/ops/*.sql` и `CREATE ROLE saas_app LOGIN PASSWORD '<из /etc/saas-worker.env>'`):

```bash
createdb -U postgres saas
gunzip -c /opt/agentsDB/backups/saas_<последний>.sql.gz | psql -U postgres -d saas
```

Дальше: `npm ci && npm run build` в `/opt/agents/saas`, `bash deploy/install-systemd.sh`,
`bash deploy/install-triage-user.sh`, venv воркера. Профиль браузера кабинета Ozon в копию не входит —
владелец входит заново (СМС).

## Проверка восстановления (раз в месяц)

Достать дамп из облака во временный каталог, развернуть в `saas_restore_test`, сверить `count(*)`
ключевых таблиц с боевой, удалить базу. Первая проверка 12.11.2026: 8 таблиц совпали до строки,
мастер-ключ из копии расшифровал ключи всех 3 магазинов.
