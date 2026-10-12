# AGENTS.md — карта SaaS-дашборда WB/Ozon (для старта сессии)

> **Этот файл автоматически загружается в контекст при старте каждой сессии.**
> Здесь — обзорная карта: что где лежит, как течёт сбор данных, где править.
> Детали — в комментариях внутри соответствующих файлов.

SaaS-аналитика для продавцов WB/Ozon. **Next.js 14** (App Router, порт 3200) +
**PostgreSQL** с row-level security (RLS) по `cabinet_id`. Мультитенант:
один инстанс → много клиентов, данные изолированы.

> ⚠️ **Кабинет для экспериментов = `cabinet #1` (ИП Матвеев, хозяин проекта).**
> Все тесты, пробы, отладочные правки, ручные проверки в БД — **только на #1**.
> Остальные активные кабинеты (`#1008` и т.д.) — **боевые кабинеты клиентов**:
> ничего не пишем, не гоняем воркер `--cabinet N`, не делаем upsert/DELETE в их
> данных без явного разрешения хозяина. Подробнее — в разделе «Состояние» внизу.

## TL;DR — где что искать

| Нужно | Смотри |
|---|---|
| Добавить/изменить API-эндпоинт | `app/api/cabinets/[id]/<name>/route.js` |
| Страницу дашборда (UI) | `app/cabinets/[id]/<name>/page.js` + `*Page.jsx` |
| Схему БД / миграции | `db/migrations/0NN_*.sql` (пронумерованы, идемпотентны) |
| Журнал прогонов сборщиков | jobs.collector_runs (пишет orchestrator; ok/partial/failed/timeout/no_token/skipped; ретеншн 90 дн) |
| Здоровье данных | /health (доступ: SAAS_OPS_USER_IDS в .env.local) + OnFailure=saas-failure@%n во всех юнитах |
| Авторазбор падений сборщиков | jobs.failure_triage + worker/failure_triage.py (таймер saas-triage, claude -p только чтение) |
| systemd-юниты | deploy/systemd/ (источник истины) + deploy/install-systemd.sh |
| Слой расчёта метрик WB | `lib/wbMetrics.js` (единый источник правды по заказам/выручке/прибыли) |
| Слой расчёта метрик Ozon | `lib/ozonMetrics.js` |
| Юнит-экономику | `lib/unit.js` (calcWB / calcOzon, налоги в отдельных колонках) |
| Премия менеджеров / роли | `lib/bonus.js`, `lib/bonusData.js`, `app/api/cabinets/[id]/bonus/route.js` |
| Процент выкупа (когорта по заказам, размеры WB) | `lib/buyout.js`, `lib/buyoutData.js`, `/buyout`, контракт §18 |
| Адаптер БД (PG + RLS) | `lib/db.js` (DatabaseSync, withTenant, query, tenantQuery) |
| Сборщики (тянут данные из API МП) | `worker/collectors/*.py` |
| Оркестратор воркера | `worker/orchestrator.py` |
| Запуск воркера (systemd) | `/etc/systemd/system/saas-*.service` + `worker/run_saas_*.sh` |

## Архитектура данных (главное — всё в PostgreSQL, никакого SQLite)

```
┌─────────────────────────────────────────────────────────────┐
│  API маркетплейсов (WB / Ozon)                              │
└───────────┬─────────────────────────────────────────────────┘
            │ Python-сборщики (worker/collectors/*.py)
            │ подключаются как saas_app, RLS по cabinet_id
            ▼
┌─────────────────────────────────────────────────────────────┐
│  PostgreSQL, схема tenant.*                                 │
│  wb_* (19 таблиц) и ozon_* (18 таблиц) — все с cabinet_id   │
│  в PK + RLS-политика «строка видна если cabinet_id = GUC»   │
└───────────┬─────────────────────────────────────────────────┘
            │ Next.js route (lib/db.js DatabaseSync поверх PG)
            │ withTenant(cid) → SET app.cabinet_id → RLS режет
            ▼
┌─────────────────────────────────────────────────────────────┤
│  Дашборд (React, порт 3200)                                 │
└─────────────────────────────────────────────────────────────┘
```

⚠️ **Ловушка, на которую наступали:** в `lib/` раньше лежали SQLite-файлы
из старого single-tenant проекта (`wb_data.db`, `fin_data.db`...) — они
**удалены**. Всё, что используется, идёт через `lib/db.js` (PostgreSQL).
Если видишь путь к `.db` файлу — это устаревший код, не активный.

## Схемы PostgreSQL

- `auth.*` — пользователи, кабинеты, memberships, shops, приглашения. **Без RLS**
  (изоляция через `WHERE cabinet_id` в запросах).
- `tenant.*` — клиентские данные (заказы, продажи, финансы, метрики, остатки,
  отзывы). **С RLS** по `app.cabinet_id`.
- `shared.*` — общие справочники (список МП).
- `jobs.*` — очередь сбора (`jobs.collect_jobs`: типы daily/resync/onboarding).

Ключевые таблицы tenancy: `auth.cabinets` (кабинет = проект, 1 кабинет → много
магазинов разных МП), `auth.shops` (магазин = 1 МП + 1 юрлицо, здесь лежат
**зашифрованные pgcrypto API-ключи** в `api_creds_enc`), `auth.memberships`
(user ↔ cabinet с ролью owner/manager/viewer).

## Как изолируется тенант (RLS)

1. Запрос приходит в API-роут `app/api/cabinets/[id]/...`.
2. `withCabinet` (`lib/withCabinet.js`) проверяет session + membership,
   затем вызывает `withTenant(cabinetId, fn)` (`lib/db.js`).
3. `withTenant`: `BEGIN` → `SELECT set_config('app.cabinet_id', $cid, true)` →
   выполняет handler → `COMMIT`. GUC `app.cabinet_id` живёт в транзакции.
4. RLS-политики на `tenant.*` (см. миграции 002/003): `USING (cabinet_id = current_setting('app.cabinet_id')::bigint)`.
5. `DatabaseSync('wb')` в коде роута — это **не** файл, а PG-адаптер: `'wb'` —
   просто флаг МП для маппинга имён таблиц (`orders` → `tenant.wb_orders`).
   Маппинг `?`→`$N` и таблиц делает `convertSql()` в `lib/db.js`.

## Сбор данных (воркер)

**Оркестратор** `worker/orchestrator.py` читает активные кабинеты из PG,
расшифровывает API-ключи из `auth.shops.api_creds_enc` (pgcrypto, ключ в env
`SAAS_CRED_MASTER_KEY`) и для каждого магазина запускает сборщики в отдельном
subprocess с env-инъекцией (`WB_TOKEN` / `OZON_*` + `WB_SaaS_CABINET_ID`).

**Три режима оркестратора:**
- `--all` — ежедневный сбор (вчера/сегодня) по всем active-кабинетам. Таймер `saas-worker` 4×/день.
- `--cabinet N [--date-from .. --date-to ..]` — один кабинет, для ручного backfill/теста.
- `--drain-queue` — прогон onboarding-jobs (backfill за 75 дней) из `jobs.collect_jobs`.
  Таймер `saas-backfill` 4×/день. Job создаётся при онбординге нового клиента.

**Белый список кабинетов (с 12.10.2026):** `SAAS_COLLECT_CABINETS=1` в `/etc/saas-worker.env` — `--all` и
`--drain-queue` собирают только перечисленные кабинеты (пусто/нет переменной — все active; явный `--cabinet N` не
фильтруется). Решение владельца: пока нет клиентов, ресурсы на #1008/#1009 не тратим; их данные заморожены на 12.10.

**Сборщики** (`worker/collectors/wb_*.py`, `ozon_*.py`) пишут в `tenant.*` через
`worker/db_pg.py` (тот же паттерн RLS по `WB_SaaS_CABINET_ID`). Все upsert'ы
идемпотентны (`ON CONFLICT`). Порядок важен: catalog → orders → finance →
order_costs → metrics → prices → stocks (зависимости по FK).

Контракт exit-кодов сборщиков: 0 = ok, 3 = partial (часть окон пропущена, напр.
429 у wb_finance), прочее = failed. Guard: если *_finance прогона не-ok,
*_order_costs НЕ запускается (иначе безусловный DO UPDATE затёр бы хорошие
агрегаты дырявыми) — GUARD_DEPS в orchestrator._run_one.

**Ретраи Ozon (`worker/collectors/ozon_client.py`).** Сеть/5xx — экспонента
2→4→8→16 с; 429 — своя экспонента 5→10→20→40 с (≈75 с за 5 попыток, ≥ минутного
окна лимита Ozon; Retry-After уважаем, но не короче пола). Сообщение об
исчерпании несёт заголовки `ratelimit-*`/`Retry-After` и начало тела — по логу
видно, какой лимит сработал (08.09.2026 оба кабинета с разными ключами получили
429 в одну минуту ночного тика 05:15 — это Ozon-сторона, не наш перебор).
Сборщики не должны портить БД до похода в сеть: `ozon_metrics` собирает ответ
analytics/data в память и только потом одной транзакцией чистит окно и пишет
(раньше обнулял `orders` за 3 дня ДО запроса и при 429 оставлял скорость Ozon
на `/stocks` пустой до следующего тика). Селф-тесты без сети/БД:
`worker/collectors/ozon_client_selftest.py`, `ozon_metrics_selftest.py`.
**Склейка сиблингов в `ozon_order_costs` (фикс 12.10.2026):** разные отправления одного
заказа НЕ склеиваются — вместе сливаются только 2-частная база (`…-0449`) и 3-частная форма
(`…-0449-5`) одного отправления; два 3-частных (`…-0062-2` невыкуп и `…-0062-3` продажа) — разные
строки (до фикса невыкуп делал продажу «возвратом»: выручка 0, COGS не списан). Контракт §1.5,
регрессии — `scripts/check-ozon-profit-calc.py` 17f–17i.

**Сломанные ключи магазина.** Отказ авторизации (401/403 или отсутствие
кредов) считается проблемой клиента, а не сбоем сборки: после двух отказов
подряд магазин переходит в `auth.shops.auth_state='paused'` и пропускается
(строка `skipped`/`auth_paused` в `jobs.collector_runs`), прогон при этом
остаётся зелёным. Раз в сутки — контрольная попытка; сохранение новых ключей
снимает паузу сразу. Клиент видит красный баннер в шапке кабинета и получает
письмо (таймер `saas-notify-keys`, одно письмо на эпизод). Владелец сервиса
видит список на `/health`. Пороги: `SAAS_AUTH_FAIL_THRESHOLD` (2),
`SAAS_AUTH_RETRY_HOURS` (24). Таймаут одного сборщика —
`SAAS_COLLECTOR_TIMEOUT_SEC` (900, было 3600).

**Авторазбор падений (с 2026-10-01).** Таймер `saas-triage` (15 мин) открывает эпизод в
`jobs.failure_triage` после 2 падений подряд (`failed`/`timeout`) у пары «сборщик × кабинет»
и молчит до `ok`; эхо `unit:*` (упал сборщик того же юнита) не учитывается, `manual` — тоже.
Суточный юнит не закрывает/не переоткрывает эпизод на джиттере таймера — порог тишины
юнитов `UNIT_QUIET` 30 ч (не 24 ч: сутки + запас). Разбор — `claude -p --model sonnet` с
инструментами только на чтение (БД под `saas_ro`, без `Edit`/`Write`), ≤3 запуска claude в
сутки (включая повторы — бюджет считает `run_starts` эпизодов, не сами эпизоды, миграция 062:
у одного эпизода с 3 попытками иначе ушёл бы только 1 слот вместо честных 3), таймаут 20 мин;
доступ claude к БД/журналу/git — только через обёртки `worker/bin/triage-{sql,journal,git}`
(единственный путь, метакоманды psql и `--no-index`/абсолютные пути git запрещены);
`triage-sql` ограничивает запрос `statement_timeout=60000` через `PGOPTIONS`, а снаружи ещё и
`timeout 90` — но клиентский `timeout` убивает только psql, а не серверный бэкенд (постгрес не
замечает обрыв TCP, пока не попробует писать/читать), поэтому сессия с уникальным
`PGAPPNAME=triage-$$` при коде возврата 124 дополнительно добивается `pg_terminate_backend`
по своему же `application_name` (saas_ro сигналит собственные сессии без грантов); текстовый
запрет слова `timeout` в SQL был снят (ложно блокировал `WHERE status='timeout'` и обходился
конкатенацией `'statement_time'||'out'`). `triage-git` отдельно отклоняет любой аргумент с
подстрокой `001_tenant_core` (в этой миграции захардкожен пароль БД, заплатка до отдельной
чистки) — тот же путь закрыт и `Read` claude (`DISALLOWED` в `worker/failure_triage.py`); сверх
запрета по имени файла обёртка читает значение `SAAS_APP_DB_PASSWORD` из `/etc/saas-worker.env`
(не экспортирует, не печатает) и вычёркивает его построчно (`grep -vF`) из вывода `git show`/
`log -p` — редакция пароля на случай, если он всплывёт в выводе не через имя файла в аргументах
(ревью, раунд 2, 01.10.2026).
`WebFetch` — только `dev.wildberries.ru`/`docs.ozon.ru`. Окружение claude — белый список
`ENV_KEEP` (секреты воркера не наследуются). Сбой самого `claude -p` (не нашёлся бинарник,
таймаут, битый/не-JSON ответ) — отличается от валидного, но не прошедшего схему отчёта:
первое повторяется до `MAX_ATTEMPTS=3` раз не чаще раза в час (`RETRY_BACKOFF`, счётчик
`attempts` — миграция 061), второе сразу уходит в `error` (повтор не поможет, схема и промпт
те же); зависший (`running` дольше 30 мин) эпизод идёт через то же решение
(`core.after_failure`, как будто сбой повторяемый) — тоже уходит на повтор, если лимит попыток
не исчерпан, а не сразу в `error`. На таймауте процесс claude и его сессионная группа убиваются
`SIGKILL` через `os.killpg` (`start_new_session=True` в `run_claude`) — но Bash-дети
(`triage-sql`/`triage-git`/`triage-journal`), которых claude успел запустить, не гарантированно
попадают в ту же группу (зависит от того, как их порождает сам `claude`), так что `killpg` не
даёт стопроцентной гарантии их немедленной смерти; границу держат независимые страховки:
`triage-sql` сам ограничен `timeout 90` (и добивает бэкенд `pg_terminate_backend` при коде 124),
`triage-journal`/`triage-git` — короткие разовые команды без фонового состояния, а что всё же
осталось живо — подчищается cgroup systemd-юнита `saas-triage.service` в конце тика. Сбор вывода
claude после килла ограничен ещё 10 с (пусто, если и это не успело). Прокси `SAAS_TRIAGE_PROXY`
вырезается из `raw_output` перед записью в
БД. Итог — письмо пользователям `SAAS_OPS_USER_IDS` (уходит, если доставлено хотя бы одному
адресату — сбой по части списка не блокирует остальных; `closed` без готового отчёта —
эпизод сам отыграл задачу на ретрае и закрылся раньше разбора — письмо не шлётся) и блок
«Разборы падений» на `/health`. Только диагноз — чинит человек. Выключатель
`SAAS_TRIAGE_ENABLED=0` в `/etc/saas-worker.env`. Данные кабинетов кроме #1 — в отчёт только
агрегаты (без строк заказов/сумм/имён, см. `worker/triage_prompt.md`). Решения тика — чистое
ядро `worker/triage_core.py` (селф-тест `worker/triage_core_selftest.py`), промпт —
`worker/triage_prompt.md`, письмо — `lib/triageMail.js`; селф-тест обёрток-песочниц —
`worker/bin/triage_wrappers_selftest.sh`. Спека
`docs/superpowers/specs/2026-09-30-failure-triage-design.md`. Прокси для `claude -p` —
`SAAS_TRIAGE_PROXY` в `/etc/saas-triage.env` (root, 600, вне git): напрямую с сервера API
Anthropic отвечает 403 «Request not allowed».
**Вариант 2 (02.10.2026): claude — под отдельным пользователем.** Тик (`failure_triage.py`, запись
в `jobs.failure_triage`, письма) остаётся под root, а сам `claude -p` запускается через
`runuser -u saas-triage` (системный, nologin, HOME `/var/lib/saas-triage` 700, группа
`systemd-journal`): ему не читаются `/etc/saas-*.env`, `/etc/collectors.env`, `.env.local` (теперь
600), `/root` (включая `/root/.claude/settings*.json` — пользовательские настройки владельца больше
не входят в границу песочницы), в `worker/` (теперь 755) писать нельзя. БД — роль `saas_triage`
(`db/ops/saas_triage_role.sql`): tenant/jobs/shared целиком, из auth/billing — только колонки без
ключей (`api_creds*`, `external_keys`), хэшей, токенов и ПДн; новые таблицы auth/billing не выдаются
автоматически; пароль только в `/var/lib/saas-triage/.pgpass`. Пароль `saas_app` для вычёркивания
из `triage-git` тик кладёт на время разбора в `/run/saas-triage/redact` (root:saas-triage 640,
`/etc/tmpfiles.d/saas-triage.conf`) и удаляет после; обёртка читает его через `grep -f`, не argv;
нет списка — отказ (exit 3), не вывод без вычёркивания. После разбора всё, что осталось под
`saas-triage`, добивается `pkill -KILL -u saas-triage`. Пока у пользователя нет входа в claude
(`~/.claude/.credentials.json` либо `CLAUDE_CODE_OAUTH_TOKEN` в `/etc/saas-triage.env`), тик эпизоды
не берёт (лог «ждёт: нет входа в claude»), попытки не тратятся. Установка/починка — идемпотентный
`bash deploy/install-triage-user.sh`; граница проверяется `worker/bin/triage_wrappers_selftest.sh`
(под root). `SAAS_TRIAGE_USER=` (пусто) — старый режим под root, только для отладки.

## Боевое расписание (systemd, `/etc/systemd/system/`)

| Таймер | Когда | Что делает |
|---|---|---|
| `saas-worker` | 05:15, 09:00, 12:00, 17:00 | основной сбор 14 сборщиков (−2 дня..сегодня) |
| `saas-stocks` | 08:00 | снимок остатков WB (`stocks-report/wb-warehouses`, с 2026-07-18 — старый `supplier/stocks` отключён WB, см. gotcha #11) + Ozon |
| `saas-metrics30m` | каждые 30 мин | 30-мин снапшоты воронки WB |
| `saas-backfill` | 07:00, 10:30, 14:00, 19:00 | прогон очереди onboarding-jobs (75 дней) |
| `saas-cabinet` | 06:00, 20:00 | кабинет Ozon: позиции по запросам + трафик по SKU (Playwright, профиль владельца, только чтение) |
| `saas-backup` | 03:00 | дамп PG |
| `saas-triage` | каждые 15 мин | авторазбор падений: 2 failed подряд → `claude -p` (Sonnet, только чтение) → письмо + `/health` (≤3 запуска claude/сутки, включая повторы) |

Логи: `/opt/agentsDB/logs/saas_worker.log`. Веб: `saas.service` (`next start -p 3200`).

## Онбординг нового клиента (поток)

1. `/onboarding` (фронт) → `POST /api/onboarding/start` с `marketplaces[]`.
2. Эндпоинт создаёт кабинет (`status='active'`, `marketplaces` заполнен) +
   в той же транзакции **job** `job_type='onboarding'` (`date_from=сегодня−75`,
   `status='queued'`) в `jobs.collect_jobs`.
3. Магазины добавляются `POST /api/cabinets/[id]/shops` — креды шифруются (pgcrypto) и
   кладутся в `auth.shops.api_creds_enc` (per-МП, per-юрлицо).
4. Таймер `saas-backfill` (4×/день: 07:00, 10:30, 14:00, 19:00) подхватывает queued-job
   (`orchestrator --drain-queue`), гоняет сборщики за 75 дней. Воркер читает креды из
   `auth.shops`, legacy-fallback на кабинетные creds (для cabinet #1).
5. После — ежедневный `saas-worker` (4×/день) тянет свежие данные.
6. Прокси НЕ нужен (сервер в РФ). Закладывать при 50+ клиентах.

## Конфигурация / env

- `.env.local` — DB-креды, `SAAS_SESSION_SECRET`, `SAAS_CRED_MASTER_KEY`.
  Регистрация открытая: `SAAS_INVITE_CODE` удалён (фаза 2 auth-редизайна).
  Пробный период: `SAAS_TRIAL_DAYS` (дефолт 14).
  Лимиты попыток: `SAAS_RL_LOGIN_ACCOUNT` (дефолт 5 неудачных входов/мин на
  аккаунт), `SAAS_RL_LOGIN_IP` (дефолт 20/мин с IP), `SAAS_RL_REGISTER_IP`
  (дефолт 30 регистраций/мин с IP).
- Оплата подписки: `SAAS_YOOKASSA_SHOP_ID`, `SAAS_YOOKASSA_SECRET_KEY`,
  `SAAS_YOOKASSA_WEBHOOK_SECRET` (сегмент URL вебхука),
  `SAAS_YOOKASSA_VAT_CODE` (ставка НДС в чеке, 1 = без НДС),
  `SAAS_GRACE_DAYS` (отсрочка после истечения, дефолт 3).
  Пока боевых ключей нет — `SAAS_YOOKASSA_MOCK=1` (оплата-заглушка).
  Тарифы живут в `billing.plans`, цены меняются SQL-ом без пересборки.
  `saas-web` и `saas-billing-reconcile` запускаются с `Environment=TZ=Europe/Moscow`:
  расчёт сроков подписки (`lib/billing.js`) идёт по локальному времени, и
  системная зона не должна на него влиять.
- `/etc/saas-worker.env` + `/etc/collectors.env` — env для воркера (читают
  `run_saas_*.sh` и `run_orchestrator.py`): `POSTGRES_PASSWORD`,
  `SAAS_APP_DB_PASSWORD`, `SAAS_CRED_MASTER_KEY`.
- Алиас путей: `@/*` → `./*` (`jsconfig.json`). Импорты lib: `@/lib/db.js`.

## Где что считается (чтобы не разойтись в цифрах)

> 🔴 **ЖЁСТКОЕ ПРАВИЛО ПО ФИНАНСАМ (хозяин, 2026-08-01): расхождение цифр =
> НАШ БАГ, пока не доказано обратное.** Если две страницы/отчёта показывают
> разные числа за один период — это дефект по умолчанию. Нельзя объяснять
> «так задумано» / «разные методологии» без доказательства: найти обе формулы,
> показать разницу на конкретных данных и получить решение хозяина. Следствия:
> (1) новые метрики — только через единый слой (`lib/wbMetrics.js` /
> `lib/ozonMetrics.js` / `lib/unit.js`), никаких инлайн-копий формул в роутах;
> (2) пустой `catch {}` без `console.error` запрещён — тихая ошибка превращает
> баг в «неправильную цифру», которую никто не замечает (2 таких бага чинили
> 2026-08-01: `get()?.m` на Promise в products-summary/rnp-summary — дефолтный
> период всегда был «от сегодня UTC»; проглоченный ReferenceError `prevTo` —
> динамика соинвеста Ozon всегда была пустой).

- **Метрики WB** (заказы/выручка/комиссия/прибыль): `lib/wbMetrics.js` —
  единственный источник формул; деньги считаются по `wb_order_costs`
  (`wbRawProfitAggregate` и её by-day/batch/cabinet-варианты), см.
  `docs/metrics-contract.md`. Прямые формулы по `finance_report`
  (`retail_price_withdisc_rub`, `commission_percent × …`) — НЕ канон:
  они остались только витринными справками в `wbFinanceByDay`.
- **Реклама WB — один источник (решение владельца 12.10.2026)**: в прибыли только расход
  кампаний (`daily_metrics.ad_spend`, по дням/товарам). Удержание «WB Продвижение»
  (`wb_cabinet_costs.cost_type='promotion'`) — оплата той же рекламы: `wbProfitCabinet` кладёт его
  в `cabinetCostsInfo[]` (справочно, «уже учтена в рекламе»), не в `cabinetCosts[]`/profit; признак —
  `WB_COST_INFO_ONLY` в `lib/wbMetrics.js`. Было вычитание дважды (11.10: −14 647 ₽). `/pnl`,
  `/cabinet-costs` (`info`), `products-summary` (`unallocated`) — без него в итогах. Тест
  `lib/__tests__/wbCabinetCosts.test.mjs`, контракт §19.
- **Выручка WB (переезд 06.09.2026)**: канон `revenue = Σ cost_value_withdisc`
  (цена со скидкой продавца, `retail_price_withdisc_rub`), а не «к
  перечислению» — решение владельца; см. `docs/metrics-contract.md` §1.1
  («три цены»: `revenue`/`realized`/`payout`).
- **Комиссия WB — нетто-вычет с 06.09**: `commission = realized − payout`;
  отчётные `commissionReport`/`acquiringReport`/`loyaltyReport` — справочные,
  разложение отчёта WB не сходится ни на одной строке (`docs/metrics-
  contract.md` §2.1).
- **Налоговая база WB — константа `WB_TAX_BASE`** (`lib/wbMetrics.js`,
  сейчас `"realized"`) — одна точка переключения на `"revenue"`/`"payout"`;
  двигает и базу НДС, не только УСН (`docs/metrics-contract.md` §9).
- **СПП / цена сайта (канон с 2026-08-02):** `wb_prices.price_buyer`
  (= discountedPrice из API цен продавца) **НЕ включает СПП** — это цена после
  скидки ПРОДАВЦА, не цена сайта (доказано на nm 1181386677: API 8911 ₽,
  сайт 6344 ₽, СПП в заказах 31-45%). **Реальная цена сайта = `price_site`**
  (миграция 029): публичный card.wb.ru, собирает `wb_prices.py::collect_site_prices`,
  обновление отдельным UPDATE (сбой не затирает старое; свежесть — `price_site_at`).
  ⚠️ Антибот WB режет прямые запросы с IP сервера (403 curl'у и python;
  через внешний прокси — 200, проверено 2026-08-02) → на бою price_site
  не обновляется, пока не решён вопрос прокси; UI мягко падает на
  «последний СПП из заказов».
  **Решение хозяина: база налогов/эквайринга = цена, которую платит покупатель**
  → в `lib/unit.js` calcWB: priceBuy = price_site, fallback priceCabinet×(1−spp);
  price_buyer как базу налогов НЕ подавать. СПП в РНП: заказы периода →
  оценка из price_site → последний СПП из заказов (60 дн), оценки метятся ⚙.
- **Метрики Ozon**: `lib/ozonMetrics.js`.
- **Реклама Ozon (канон с 2026-08-02): только «кабинет × день»** —
  `tenant.ozon_daily_efficiency.ad_spend` (Performance API, окна ≤60 дн).
  Пер-товарного расхода НЕТ (daily_metrics.ad_spend пуст) → по товарам
  Ozon-реклама не разносится, в totals прибыли вычитается кабинетной суммой
  (`ozAdSpend` total). До 6046d36 расход не собирался вовсе (401 basic auth) —
  прибыль Ozon была завышена (~169.5к ₽ за 75 дн на cab #1). Per-SKU —
  только асинхронные отчёты Performance (в очереди).
- **Соинвест Ozon (канон с 2026-08-02): размер НЕ доступен продавцу программно.**
  Доказано probe'ами («карта 64»: кабинет 764 ₽ при цене продавца 1120 ₽):
  цены `/v5` витрину не отдают (грабля #57), `current_boost` акций = сила буста
  показов (не соинвест), в заказах Ozon-скидки перечислены без сумм, витрина
  за антиботом. РНП показывает «—» (null), НЕ 0%. Выручку продавца соинвест
  не трогает (продавец получает свою цену). Снимки цен `tenant.ozon_prices`
  (миграция 030, сборщик ozon_prices) собираются — история цен продавца.
- **ДРР — две базы (решение хозяина 08.09.2026):** основной `drr` = реклама ÷
  сумма ЗАКАЗОВ (`orderRub`) — реклама приносит заказы, важен расход именно на
  них; `drrSales` = реклама ÷ продажи (`salesRub`) — вторая, справочная цифра.
  В сводке (`products-summary/route.js`) и РНП (`rnp-summary/route.js`) обе
  считаются; в юнит-экономике (`lib/unit.js`) ДРР — ОТДЕЛЬНАЯ ставка-константа
  10% в модели, эта правка её не касается. Подробности — `docs/metrics-
  contract.md` §15.3.
- **Юнит-экономика** (маржа/ROI товара): `lib/unit.js` (`calcWB`, `calcOzon`).
  Формула СПП нетривиальна — править осторожно.
  **Список товаров `/unit` (с 2026-07-17)**: показывает **только active** — статус берётся
  из `tenant.item_status` через `statusMap()` из `lib/finItems.js`, с fallback `"active"`
  (как на странице «Себестоимость» `/items`). Отгрузки и продажи больше НЕ критерий
  попадания. `?includeInactive=1` в `/api/cabinets/[id]/unit/all` — показать и inactive.
  Правка чисто аддитивная (фильтр `.filter(r=>r.status==='active')` в конце computeWB/
  computeOzon, `app/api/cabinets/[id]/unit/all/route.js`). Для клиентов с пустым
  `item_status` (напр. #1008) — поведение не меняется (все → active по fallback).
  **Товары без продаж (с 2026-07-17, та же сессия):** в `computeWB` убрано требование
  `discount > 0` — теперь попадают модели с ценой, но без скидки (новые отгрузки, где WB
  отдаёт `wb_prices.discount=0`). Раньше условие было `price_seller>0 AND discount>0` →
  свеже-отгруженные без акции были невидны в юнитке. `calcWB` с `discount=0` корректен
  (`priceCabinet = priceSeller`).
  ⚠️ **Слепое пятно:** такие товары приходят БЕЗ себестоимости (`cost_overrides` пуст) →
  прибыль/маржа **завышены**. Чинится привязкой артикула на `/inventory` (создаёт override).
- **Логистика WB в юнитке (с 2026-10-06)** — факт отчёта реализации за 30 дней по вчера (по `rr_dt`),
  зеркало Ozon-модели: `logisticsFbo` F = Σ «К клиенту при продаже» / продано, `returnLogistics` R =
  (вся логистика − F-часть) / невыкупы (отменённые после отгрузки srid + штуки «Возврат»), выкуп
  b = продано / (продано + невыкупы); `logistics = F + R(1−b)/b` = Σлогистики / продано. Старая
  формула `(50+20·(L−1))/J × 1.6` давала ~80 ₽ при факте ~248 ₽ (выкуп считался по «Возвратам» ≈ 99 %,
  реальный ≈ 49 %) — осталась только когда у кабинета нет продаж вовсе. Без продаж в окне — средние
  кабинета (⚙). F правится в прикидке (`WHATIF_INPUTS.wb`, белый список `unit/whatif`). Сторож —
  `node scripts/check-unit-wb.mjs 1`, тесты — `lib/__tests__/unitWb.test.mjs`.
- **Потребность в закупке (с 2026-10-06)** — страница `/purchase-need` (меню «Товары»), API
  `/api/cabinets/[id]/purchase-need?window=7|14|30&horizon=1..365&platform=all|wb|ozon` (переключатель площадки с 07.10: только артикулы/отгрузки площадки, свой склад — целиком); выгрузка в Excel — тот же роут с `&format=xlsx` (+ `q`, `onlyBuy=1`), `lib/purchaseNeedXlsx.js`, зависимость `exceljs`). Чистый расчёт `lib/purchaseNeed.js`
  (тесты `lib/__tests__/purchaseNeed.test.mjs`), данные `lib/purchaseNeedData.js`. Строка = товар как
  связная компонента позиций `/inventory` и артикулов МП (WB+Ozon сливаются только через
  `ff_inventory_skus`). Остаток = доступно на МП (как `/stocks`, отрицательное Ozon → 0) + свой склад
  (`ff_inventory.qty`) + в пути (WB `in_way_from` + строки документов отгрузки `shipped` без приёмки);
  скорость — `daily_metrics.orders` за N полных дней по вчера; закупить = `purchaseNeedQty`
  (`lib/supplyPlan.js`, та же формула, что «К закупке» на `/stocks`). Только активные (`item_status`).
  FBS-остаток складов продавца (`mp_fbs_daily_stock`) НЕ учитывается — свой склад только из
  `/inventory`. Смоук — `node scripts/smoke-purchase-need.mjs 1` (сверяет одиночные артикулы с `/stocks`).
  Окно скорости на `/stocks` с той же даты — N полных дней по вчера (раньше N+1 дат ÷ N).
- **Премия менеджеров площадок (с 2026-10-10)** — страница `/bonus` (меню «Финансы»), API
  `/api/cabinets/[id]/bonus`. Модель — лист KPI владельца: продажи / опер. прибыль / маржа ×
  % выполнения; любой < порога (0,65) → бонус 0; бонус = `bonus_pct` (0,04) × факт прибыли ×
  среднее трёх %; к оплате = оклад (40 000) + бонус, потолка нет. Факт — канон площадки
  (`wbProfitCabinet`/`ozProfitCabinet`: `revenue`, `profit` — как `/pnl`), исключённые
  артикулы снимают свой факт (`…ProfitProductBatch`) и введённую владельцем долю плана.
  Текущий месяц — по вчера; владелец фиксирует месяц (`bonus_closings.snapshot`). Ядро
  `lib/bonus.js` (тесты `lib/__tests__/bonus.test.mjs`), данные `lib/bonusData.js`, миграция
  064. Менеджер видит только свою карточку (user_id из сессии), наблюдатель — 403.
  Смоук `node scripts/smoke-bonus.mjs 1`. Спека `docs/superpowers/specs/2026-10-08-managers-bonus-design.md`.
- **Процент выкупа (с 2026-10-11)** — страница `/buyout` (меню «Товары»), API
  `/api/cabinets/[id]/buyout` (`?series=1[&nm=]` — 13 недель). WB когортно по дате заказа:
  судьба каждого `srid` (самовыкуп → возврат → выкуп → невыкуп по логистике «К клиенту при
  отмене» → отмена до отгрузки > 7 дн → в пути); `% = выкуп / (выкуп + невыкуп + возврат)`;
  размеры — `wb_orders.tech_size`. Ядро `lib/buyout.js` (тесты `lib/__tests__/buyout.test.mjs`),
  данные `lib/buyoutData.js`. «Сводка по товарам» берёт выкуп отсюда же для обеих площадок
  (одна цифра, переключатель площадки на странице); Ozon (канон с 12.10.2026) — по
  отправлениям (`status` + `ozon_order_costs.is_return`), ведро на `posting_number`,
  строка = товар (размеров нет). Отмены Ozon (с 12.10.2026) судятся по причине отмены
  `ozon_orders.cancel_reason` (миграция 066; группы «не взяли» → невыкуп даже без обратной
  логистики, Ozon/продавец → «до отгрузки» всегда — `OZ_*_REASON_PREFIXES` в `lib/buyout.js`,
  контракт §18.3). Сборщик `ozon_orders` пишет `cancel_reason`/`cancellation_type`/
  `cancel_initiator` (FBO и FBS) и после 45-дневного окна досбирает незавершённые
  отправления старше окна (≤180 дн, `refresh_stale`; `/v2/posting/fbo/get` причину не отдаёт —
  идём `/v3/posting/*/list` узкими окнами). Юнитка НЕ переведена (коэффициент модели логистики, §18.4).
  Смоук `node scripts/smoke-buyout.mjs 1` (сверяет обе площадки и `platform=all`).
- **Роли (с 2026-10-10)**: `manager` пишет и в финансы (ДДС, закупки, план, расходы,
  самовыкупы, план закупок); «Баланс» (включая чтение), настройки/ключи, команда, подписка,
  запись премии — только `owner`. Гард `lib/__tests__/roleGuards.test.mjs`.
- **Сотрудники с логином от владельца (с 2026-10-10)** — «Команда» → «Создать сотрудника»: имя,
  логин вида `имя@что-то` (настоящая почта не обязательна, `wb@sysell` подходит), пароль ≥ 8, роль
  manager/viewer; аккаунт сразу подтверждён. 🔑 у сотрудника — смена пароля владельцем, сбрасывает его
  сессии; разрешена ТОЛЬКО аккаунтам, состоящим лишь в этом кабинете (иначе владелец мог бы угнать чужой
  аккаунт). `POST`/`PATCH /api/cabinets/[id]/members` (owner), правила — `lib/teamAccounts.js` (тесты
  `lib/__tests__/teamAccounts.test.mjs`). Миграция 065: `saas_app` получил DELETE на `auth.memberships` —
  кнопка ✕ «удалить сотрудника» до этого всегда падала 500 (permission denied).
- **Налоги** (УСН/НДС): `lib/tax.js` (`normalizeTaxMode`). Хранятся per-shop
  в `auth.shops.tax_mode`.
- **Себестоимость закупки** (формулы «Себес товара», `/fin-purchases`,
  `computeExcel` в `app/api/cabinets/[id]/purchases/route.js`):
  `N=L×M, Q=O×P, R=Q−L, S=M×R, V=P×U, W=R×U+N, Z=W+(X+Y)×O, AA=Z/O`.
  **X и Y — обе «за единицу»** (с 2026-07-15): X=«Логист. до МСК/ед», Y=«Логист.
  МСК→ФФ/ед». Раньше код считал их «за партию» (без ×O) → AA занижался. Колонки
  БД: `logistics_rub_per_unit` (X), `logistics_rub` (Y) — имена не переименовывали.
- **Сигналы склада и виджет «Заканчиваются на складе» (с 2026-09-08)**: один расчёт —
  `lib/warehousesData.js loadWarehouseSignals` → `lib/warehousesMetrics.js buildSignals`.
  Главная (`app/api/cabinets/[id]/overview/route.js`, `alerts.warehouses`) и шапка
  `/warehouses` (`SignalsStrip.jsx`) читают один и тот же сигнал `low_coverage`; виджет
  главной больше не считает по-своему (раньше — WB-only, по дням с продажами). Подробности —
  «Склады 2.0 — этап 4 «Витрина»» ниже.
- **Кабинет Ozon: позиции по запросам и трафик (с 2026-09-12)**: канон средней позиции
  SKU — `tenant.ozon_sku_search_daily.position` (эндпоинт «сводка»,
  `search-query-analytics/v2/get-seller-items-search-query-analytics`); одноимённое поле в
  `ozon_sku_traffic_daily.search_position` (`charts/v3/table/by_sku`) — тот же показатель, но
  другой эндпоинт кабинета считает его иначе (медиана |Δ| ≈ 10) и хранится только как
  справочное, сторож `scripts/check-ozon-cabinet.sql` держит эту проверку СПРАВОЧНОЙ, не
  гейтом. Заказы/GMV из статистики поиска кабинета — «по запросу» (заказы покупателей,
  увидевших товар по конкретному запросу), НЕ равны заказам панели (`ozon_orders`,
  `lib/ozonMetrics.js`) и подписаны отдельно на странице «Поиск и запросы». ДРР по SKU из
  кабинета (`ozon_sku_traffic_daily.drr`) — справочная величина, канон ДРР панели (§15.3) не
  подменяет; решение о канонизации — владельца, после недели наблюдений (первая сверка
  `scripts/check-ozon-cabinet-drr.sql` 12.09.2026). Подробности — подраздел ниже и
  `docs/metrics-contract.md` §17.

### ⚠️ Себестоимость — ЕДИНЫЙ источник `tenant.cost_overrides` (с 2026-07-14)

**Раньше** было 2 таблицы (`wb_cogs`/`ozon_cogs` + `cost_overrides`) с расхождениями.
**Теперь** — только `tenant.cost_overrides`. `wb_cogs`/`ozon_cogs` оставлены в БД как
архив (откат: `/opt/agentsDB/backups/cogs_unify_20260714_200601.sql`), но **НЕ читаются кодом**.

Паттерн чтения себестоимости — LATERAL JOIN (актуальный override = последний с
`effective_from <= дата`):
```sql
LEFT JOIN LATERAL (
  SELECT cost FROM tenant.cost_overrides
  WHERE nm_id = X.nm_id AND platform = 'wb'            -- Ozon: product_id + 'ozon'
    AND effective_from <= COALESCE(substr(dateExpr,1,10)::date, current_date)
  ORDER BY effective_from DESC LIMIT 1
) co ON true
```
Хелперы: `WB_COST_JOIN(outAlias, skuExpr, dateExpr)` / `OZON_COST_JOIN(...)` в `lib/finItems.js`.
`order_costs.cost` (per-заказ) — пересчитан под override (миграция 013), для истории
использовать как есть.

### 🆕 Маршрут «Закупки → Склад/ФФ» (с 2026-07-15)

Рабочий процесс движения товара: партия закупки → завершить → остаток склада/ФФ →
привязка артикула МП → себестоимость течёт в расчёты.

**Таблицы (миграции 014, 015, 017):**
- `tenant.ff_inventory` — остатки склада/ФФ. Колонки: `cabinet_id, id, purchase_id`
  (ссылка-источник), `internal_name, qty, unit_cost` (себест. «до МП», ₽/ед), `category,
  platform, nm_id, product_id, sku_name, im_url, location_id` (ссылка на место),
  `completed_at, archived_at`. RLS. `location_type` оставлен как back-compat, но НЕ
  используется (тип берётся из места через `location_id`).
- `tenant.stock_ff_locations` — справочник мест хранения (переиспользована из старой
  ff-stock-модели). Колонки: `name, address, loc_type` ('stock'|'ff').
- `tenant.purchases` — добавлена колонка `archived BOOLEAN` (завершённые закупки скрыты
  из активных). Поле `location_type` в ff_inventory — back-compat (не трогать).

**Маршрут:**
1. На странице «Закупки» (`/fin-purchases`) — кнопка **«✓↧ склад»** в строке партии.
   → `POST /api/cabinets/[id]/purchases {action:"complete_to_stock", id}` копирует
   партию в `ff_inventory` (qty, unit_cost=AA, category) + ставит `purchases.archived=true`.
2. На странице «Остатки склад/ФФ» (`/inventory`) — позиция появляется. Можно:
   править себест/категорию/имя inline, загрузить фото (data-URL, если нет артикула),
   выбрать место (`location_id`), привязать артикул МП. Правка qty вручную (с 2026-09-07,
   этап 2 «Учёт») идёт через журнал движений (`adjust`) и требует причины — панель её просит.
3. **Привязка артикула** (`POST /api/cabinets/[id]/inventory {action:"link_sku"}`):
   выбираешь МП + nm_id/product_id → имя/фото подтягиваются из `wb_articles`/`ozon_products`
   + создаётся `cost_override` (effective_from = completed_at) → себестоимость **автоматически
   течёт в P&L, юнит-экономику, остатки на МП**.
4. Управление местами — кнопка «📍 Места» (`action:"locations"` op add/rename/delete).
5. Завершённые (archived) закупки скрыты из активных; чекбокс «архивные» показывает их.

**API `/api/cabinets/[id]/inventory`:** GET → `{items, totals, locations}`;
POST actions: `add` (ручная позиция), `link_sku`/`unlink_sku`, `update_qty`,
`update_field` (internal_name/category/unit_cost/im_url/location_id), `locations` (CRUD мест).

**Авто-списание продажами** (с 2026-09-07): реализовано в этапе 2 «Учёт» ниже —
`wb_fbs_writeoff`/`ozon_fbs_writeoff` через журнал движений. Старая ломаная `/ff-stock`
(snapshots-модель) не тронута, не используется.

### 🆕 Склады 2.0 — этап 1 «Данные» (с 2026-09-06)

Спека `docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md`, план
`docs/superpowers/plans/2026-09-06-warehouses-stage1-data.md`. Миграция 052.

| Таблица | Сборщик / источник | Тик |
|---|---|---|
| `tenant.mp_seller_warehouses` | `wb_seller_warehouses` (`/api/v3/warehouses`), `ozon_seller_warehouses` (`/v2/warehouse/list`) | references (Mon 06:00) + онбординг |
| `tenant.mp_fbs_daily_stock` | `wb_fbs_stocks` (`POST /api/v3/stocks/{wid}` по штрихкодам), `ozon_fbs_stocks` (`/v2/product/info/stocks-by-warehouse/fbs`) | stocks (08:00) |
| `tenant.wb_barcodes` | `wb_catalog` (Content API `sizes[].skus`) | main |
| `tenant.wb_fbs_tasks.warehouse_id` | `wb_fbs_tasks` (`warehouseId`) | main |
| `tenant.ozon_supply_orders(+_items)` | `ozon_supply_orders` (`/v3/supply-order/list`+`get`, `/v1/supply-order/bundle`) | main |
| `tenant.stock_ff_locations.{wb_warehouse_id, ozon_warehouse_id, city, is_active}` | панель, «📍 Места» на `/inventory` (`locations` op `update`) | — |

- **Почему FBS-остатки WB не из stocks-report:** с 01.09.2026 stocks-report отдаёт одну строку
  «Склад WB» (`warehouse_id=-999999`) — WB скрыл разбивку по складам. marketplace-api по
  штрихкодам работает (проба 06.09.2026, `SAAS_PROBE=verify` Δ = 0, 113 строк / 9 складов
  продавца).
- **Ozon `/v1` отключён:** `/v1/product/info/stocks-by-warehouse/fbs` и `/v1/warehouse/list`
  вернули 400 code 9 «obsolete method» — переведены на `/v2` (сверка Δ = 0, 80 строк / 5 из 8
  складов). `/v2/supply-order/list`+`get` — 404, переведено на `/v3/supply-order/list`+`get`
  (обязательные `filter.states` 1..11 и `sort_by`, курсор `last_id`, склад назначения из
  `supplies[].storage_warehouse`); `/v1/supply-order/bundle` без изменений, тянется только для
  незавершённых заказов.
- Часть складов Ozon имеет `status='disabled'` в ответе МП — в справочнике они всё равно
  `is_active=true` (значение = «присутствует в ответе МП»), UI показывает все.
- **Режим пробы сборщиков:** `SAAS_PROBE=1` — дамп ответа без записи; `SAAS_PROBE=verify`
  (только `*_fbs_stocks`) — сверка API↔БД, exit 1 при Δ. Пробрасывается оркестратором явно
  через `_env_for_shop`.
- **Сторож:** `scripts/check-warehouses-stage1.sql` (7 проверок, все `ok=t` на 06.09).
- Принятое количество в поставках Ozon: в API нет поля — `qty_accepted` остаётся `NULL`,
  вводится руками из отчёта приёмки (этап 3), как у WB.
- Сверка поставок Ozon с ЛК за 90 дней: панель 445 заказов всего, 14 за последние 90 дней;
  сверка с ЛК Ozon «Поставки → Заказы» — ждёт владельца.

**Удалено (миграция 016):** «Справочник товаров» — страница `/catalog`, API, `lib/catalogDb.js`,
таблицы `products_catalog` / `products_catalog_skus`. Привязка артикулов делается теперь
напрямую на остатках склада/ФФ. Бэкап кода: `/opt/agentsDB/backups/catalog_removed_*/`.

### 🆕 Склады 2.0 — этап 2 «Учёт» (с 2026-09-07)

План `docs/superpowers/plans/2026-09-06-warehouses-stage2-ledger.md`. Миграция 054.

- **Журнал движений** `tenant.stock_moves` — единственный путь изменения `ff_inventory.qty`:
  панель — `lib/stockLedger.js` (`applyMove`, `applyTransfer`, внутри транзакции), воркер —
  `worker/stock_ledger.py` (`apply_moves` — savepoint на движение, результат по вёдрам
  `applied/duplicate/insufficient/missing/failed`; `record_gaps`/`resolve_gaps`). Уникальность
  источника `(cabinet_id, src_kind, src_ref, kind)` → повтор = no-op. Прямых `UPDATE ff_inventory
  SET qty` вне этих двух файлов в коде нет — проверка покрывает и панель, и воркер:
  `grep -rnE "SET qty\b" app lib worker --include=*.js --include=*.py | grep -v "stockLedger.js\|stock_ledger.py"`
  → пусто (форма с `\b` — без неё команда ложно ловит легитимный `SET qty_accepted` в
  `lib/shipmentDocs.js`, этап 3).
- **Виды**: `in` (закупка/ручное добавление), `out_fbo` (документ отгрузки), `out_fbs`
  (авто-списание FBS), `transfer_out`/`transfer_in` (перемещение ФФ→ФФ, `/transfers`), `adjust`
  (ручная правка qty — причина обязательна; удаление документа отгрузки = `adjust` по каждой
  строке, допускает отсутствующие позиции — `skipped`), `return_in` (отмена/возврат после
  отгрузки).
- **Предохранитель нехватки**: документ отгрузки и перемещение проверяют остаток `FOR UPDATE`
  до вставки документа — нехватка → 400 и ничего не создаётся (`withCabinet` коммитит только на
  возвращённом ответе, 500 при throw откатывает всё).
- **Авто-списание FBS**: `wb_fbs_writeoff` (тики `fbsstatus` + `main`) и `ozon_fbs_writeoff`
  (`main`); правила — `worker/fbs_writeoff_core.py` (чистые функции, `SAAS_PROBE=1` печатает
  план без записи, exit 3 при `failed>0`). WB считается отгруженным, когда поставка задания
  закрыта (`wb_supplies.closed_at`) ИЛИ статус ∈ {sorted, ready_for_pickup, sold}; статусы
  {canceled_by_client, declined_by_client, defect, canceled} → `return_in`, только если списание
  уже было. Ozon считается отгруженным при статусе ∈ {awaiting_deliver, delivering, delivered}.
  Возврат по продаже (`wb_sales` `'R…'` по srid → базовый `src_ref` = rid задания, `sale_id` в
  note; `ozon_sales.is_return=1`) тоже → `return_in` — **один физический возврат зачисляется
  один раз**: статусный и продажный путь дедуплицируются по общему базовому рефу. `location_id
  IS NULL` (нет привязки склада МП к месту) → gap `no_location`; нет позиции с этим артикулом на
  месте → gap `no_item`; остатка не хватило → `insufficient`. Списание, разнесённое по нескольким
  партиям одной позиции, несёт суффикс `#<ff_inventory_id>` в `src_ref` — возврат зачисляет
  обратно по тем же партиям.
- **Перемещение ФФ→ФФ**: `POST /api/cabinets/[id]/transfers` (роль manager); приёмная позиция
  ищется по `(location_id, internal_name, unit_cost)` — НЕ по артикулу (привязки живут в
  `ff_inventory_skus` отдельно); нет — создаётся копия с теми же привязками. Строка документа
  хранит `to_ff_inventory_id`. Отдельной страницы-списка пока нет, только модалка на
  `/inventory`.
- **Здоровье журнала**: GET `/api/cabinets/[id]/inventory` отдаёт `ledger: {mismatch, gaps:
  {no_location, no_item, insufficient}}` — баннеры на `/inventory`. НЕ в `/health`
  (tenant-таблицы под RLS, `/health` их не видит).
- **Сторож**: `scripts/check-warehouses-stage2.sql` (6 проверок).
- Первые содержательные списания появятся после того, как владелец расставит места у позиций и
  привяжет склады продавца к местам (на 07.09 у всех 12 позиций кабинета #1 места нет — план
  сборщиков пуст, 349 открытых пробелов `no_location`).

### 🆕 Склады 2.0 — этап 3 «Поставки» (с 2026-09-08)

Спека `docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md` (§4), план
`docs/superpowers/plans/2026-09-07-warehouses-stage3-supplies.md`. Миграции 055–056.

- **Таблицы**: `ff_shipment_docs` — `location_id` (откуда), `dest_warehouse_id`, `status`
  (`draft`|`shipped`|`accepted`|`partial`|`rejected`), `shipped_at`, `mp_supply_id`,
  `mp_supply_kind` (`wb_income`|`ozon_supply_order`); `ff_shipment_lines.qty_accepted`;
  `ff_inventory.pack_qty` (кратность упаковки, `NULL`=1); `auth.cabinets.settings JSONB`
  (пороги планирования); новая `tenant.wb_incomes` (приёмки FBO WB, PK `cabinet_id,
  income_id, nm_id, barcode`; `quantity` = принято/`NULL` до приёмки; `quantity_declared` =
  заявлено, миграция 056).
- **Сборщик `wb_incomes`**: источник — supplies-api (`POST /api/v1/supplies` список,
  `GET .../{id}` детали, `GET .../{id}/goods` строки), НЕ старый statistics-api
  `/supplier/incomes` (WB отключил его 2026-09-07 — 404 на гейтвее). `POST /supplies`
  игнорирует и `dateFrom`, и пагинацию — отдаёт всю историю аккаунта одним ответом; окно
  `SAAS_INCOMES_DAYS` (90 по умолчанию) фильтруется на своей стороне по `createDate`.
  Терминальные поставки (`statusID=5` + `date_close` заполнен) повторно не опрашиваются
  (`db_pg.wb_incomes_terminal_ids`) — коды отклонения WB не наблюдались, набор пуст,
  дополнять по факту. `quantity` пишется только после `factDate` поставки;
  `quantity_declared` — всегда. Зарегистрирован в `WB_COLLECTORS` (`worker/orchestrator.py`)
  **и** в `MAIN_COLLECTORS` (`worker/run_saas_collect.sh`) — оба места (урок из памяти). Окно
  90 дней не покрывает старые поставки — разовый полный бэкфилл: `SAAS_INCOMES_DAYS=400`.
- **Канон покрытия (с 2026-09-08)** — `lib/stockCoverage.js`, одна пара функций на всю
  панель: `velocityPerDay(ordersQty, days)` и `coverageDays(stock, inTransit, velocity)`
  (`null` при нулевой скорости), окно `VELOCITY_WINDOW_DAYS = 28`. **Скорость = заказы за 28
  календарных дней / 28** — делим на длину окна, а НЕ на «дни, в которые были продажи»
  (старая формула завышала скорость редко продающихся товаров). **Остаток для покрытия —
  «доступно»**: WB `wb_daily_stock.quantity`, Ozon `fbo_present − fbo_reserved` (не
  `quantity_full` и не голый `fbo_present` — зарезервированное покупателем продать второй раз
  нельзя). На этот helper переведены и рекомендации перевозки между складами WB
  (`app/api/cabinets/[id]/stocks/route.js`, `buildReallocRecommendations` — блок
  «Рекомендации к перемещению» во вкладке «Эффективность»), и карточки товаров там же
  (velocity/`days_to_oos`, окно остаётся пользовательским `?vel=7|14|30|60`, но делится на
  окно; `days_to_oos` считается от `quantity` «доступно», не от `quantity_full` — с 08.09
  классы critical/low/ok у карточек тоже другие). ⚠️ **Цифры в блоке рекомендаций перевозки после 08.09 другие** (скорость ниже,
  остаток меньше, часть пар ушла/добавилась) — это смена канона, а не баг: чинить «обратно»
  не нужно.
- **Планировщик** `lib/supplyPlan.js` (чистые функции: `velocityPerDay`, `coverageDays`
  (`null` при нулевой скорости), `needQty` с округлением вверх до `pack_qty`, `pickSources`
  по близости региона, `buildSupplyPlan`) + адаптер `lib/supplyPlanData.js`. Ozon — цель на
  КАЖДЫЙ FBO-склад; WB — ОДНА цель на товар на кабинет (`warehouseKey='wb'`), потому что с
  25.08.2026 WB отдаёт остатки одной строкой «Склад WB» без разбивки. Окно скорости продаж
  зафиксировано на 28 дней, не настройка кабинета. Источники — места ФФ с привязанными
  артикулами (`ff_inventory_skus`); позиции без места в план не попадают. Пороги
  `target_days`/`min_days` — `lib/supplyDays.js` (дефолты 30/14, зажим 1..365), хранятся в
  `auth.cabinets.settings`. Скорость/покрытие — через общий `lib/stockCoverage.js` (см.
  «Канон покрытия»); `velocityPerDay`/`coverageDays` из `lib/supplyPlan.js` — ре-экспорт
  оттуда же. Роут `app/api/cabinets/[id]/supply-plan/route.js`: GET — план (`uncovered[]`
  приходит с `itemName`/`warehouseName`/`platform` — `enrichUncovered`), POST `create_doc` —
  черновик документа отгрузки (списания ещё нет); числовой `warehouseKey` становится
  `dest_warehouse_id` на ОБЕИХ площадках (у WB его даёт селект склада в карточке).
- **Документы отгрузки** `lib/shipmentDocs.js` + `app/api/cabinets/[id]/shipments/route.js`:
  жизненный цикл `draft → shipped → accepted|partial|rejected`. `create`/`ship` — списание
  `out_fbo` через `applyMove` (`src_ref='<doc_id>:<line_id>'`), ровно один раз при переходе в
  `shipped`. `link_supply` — связь с приёмкой МП (WB: `wb_income` ↔ `tenant.wb_incomes` по
  `income_id`; Ozon: `ozon_supply_order` ↔ `tenant.ozon_supply_orders` по `order_id`; вид
  поставки сверяется с площадкой документа; `mp_supply_id:null` снимает связь). `accept` —
  `qty_accepted` по строкам (400, если принято больше отгруженного). `update` — правка шапки
  ЧЕРНОВИКА (склад назначения, № документа, дата, примечание; не-черновик → 400 без записи).
  `delete` — только `draft` (у отгруженного — `adjust` с комментарием). Документ читается
  `SELECT … FOR UPDATE` во всех действиях, которые его меняют (`ship`, `update`,
  `link_supply`, `accept`). Статус в GET считается на лету по
  факту приёмки (`effectiveStatus`) — не дожидаясь ручных действий; `status_saved` — то, что
  лежит в БД. Подсказки связи (`matchSupply`): склад +2 (id либо нормализованное имя), дата
  ±3 дня +1, количество ±10 % +1; окно кандидатов — 60 дней. WB `rejected` — по кодам
  `WB_INCOME_REJECTED_STATUS_IDS` (пока пусто, WB убрал текстовые статусы 03.11.2025). Факт
  WB однороден внутри поставки: «принято» берётся, только если оно заполнено у ВСЕХ строк
  `income_id`, иначе используется заявленное.
- **UI `/shipments`**: `SupplyPlanSection.jsx` — карточки рекомендаций по (место → склад),
  селект склада назначения WB в карточке, кнопка «Создать черновик»; при пустом плане с
  непокрытым дефицитом — блок «Нечем закрыть с ФФ» с подсказкой про привязку мест;
  `ShipmentsPage.jsx` — статусы-пиллы, связь/отвязка с поставкой (подсказки-кандидаты либо
  номер вручную), у черновика кнопка «✏️ Изменить» → форма правки шапки (`update`);
  `AcceptModal.jsx` — приёмка с предзаполнением `qty_accepted` из факта WB по `nm_id`
  (`lines_by_nm`, агрегат разносится по строкам одного `nm` последовательно, не дублируется;
  у Ozon факта по товару нет — ввод руками); `ShipmentFormModal.jsx` — «Откуда»
  необязательно, склад назначения — из справочника площадки. Кратность упаковки правится
  прямо в строке `/inventory` (колонка «Кратность, шт»). Пороги планирования — два поля в
  «⚙️ Настройки» (`SettingsPage.jsx`).
- **Сторож**: `scripts/check-warehouses-stage3.sql` (8 проверок, кабинет #1, запуск как у
  этапа 2). Проверка 3 требует движение `out_fbo` у ЛЮБОГО не-черновика (не только
  `shipped`); проверка 2 меряет покрытие `income_id` заказов и не ловит поставки старше
  клиентского окна сборщика (`SAAS_INCOMES_DAYS=90`) — сырое покрытие поднимает разовый
  бэкфилл `SAAS_INCOMES_DAYS=400`. Тесты:
  `lib/__tests__/{supplyPlan,shipmentDocs,supplyPlanData}.test.mjs`,
  `scripts/test-wb-incomes-parse.py`.
- **Что руками**: без привязки мест и складов продавца в «📍 Места» план пуст и
  авто-списание молчит (как в этапе 2); склад назначения WB выбирается вручную (нет
  разбивки остатков по складам); приёмка Ozon вводится целиком руками — API не отдаёт факт
  приёмки по товару.
- **Что не делаем** (спека §4.4): создание поставок в кабинетах МП через API (запись в
  кабинеты WB/Ozon) — только рекомендация и учёт факта.

### 🆕 Склады 2.0 — этап 4 «Витрина» (с 2026-09-08)

Спека `docs/superpowers/specs/2026-09-06-multi-warehouse-stock-control-design.md` (§5), план
`docs/superpowers/plans/2026-09-08-warehouses-stage4-vitrina.md`. Новых миграций нет.

- **Файлы**: `lib/warehousesMetrics.js` (чистые функции: `buildMatrix`, `buildPlaceCards`,
  `buildSignals`, `planInventoryAdjust`, без БД) + адаптер
  `lib/warehousesData.js` (`loadWarehousesInput`, `loadWarehouseSignals`,
  `normalizePositions` — запросы строго последовательно, `lib/db.js`: один client на
  транзакцию, `Promise.all` тут маскирует порядок и риск частичного отката). Роут
  `app/api/cabinets/[id]/warehouses/route.js`: GET `?tab=matrix|places` → всегда `{signals,
  settings, generatedAt}` + данные вкладки (`matrix` либо `{places, fboWarehouses, locations,
  sellerWarehouses, items}`); вкладка «Поставки» ходит в существующие `/supply-plan` и
  `/shipments`, свой SQL не несёт. POST `{action:'inventory_adjust', location_id, note,
  lines:[{ff_inventory_id, qty_fact, qty_known}]}` — инвентаризация места (роль manager). UI —
  `app/cabinets/[id]/warehouses/{page.js, WarehousesPage.jsx, SignalsStrip.jsx, MatrixTab.jsx,
  PlacesTab.jsx, PlaceCard.jsx, FboCard.jsx, InventoryModal.jsx, SuppliesTab.jsx}`; пункт
  «Склады» первым в меню «Товары» (`app/cabinets/[id]/layout.js`).
- **Группировка строк матрицы — связная компонента, не пара (nm_id, product_id)**: спека §5.1
  формулировала строку как «одну физическую позицию по паре артикулов» — на практике товар
  часто несёт несколько WB/Ozon-артикулов на разные партии, и «первый WB + первый Ozon»
  расщепляет его на несколько строк, задваивая FBO-карточки и сигналы. `buildMatrix` строит
  union-find по ключу `${platform}:${sku_key}` среди позиций: строка = связная компонента
  (любые две позиции с общим артикулом — одна строка, транзитивно). `row.skus` — минимальный
  WB/Ozon-артикул компоненты (контракт для API/UI, как раньше, для отображения и ссылок);
  `row.skuKeys` — ВСЕ артикулы компоненты по каждой площадке, ими сопоставляются снимок FBS,
  скорость, FBO-цели и gaps (суммы по всем артикулам площадки на строку).
- **Ячейка ФФ «свой / на МП / Δ»** (§3.5): `own` = Σ `qty` позиций компоненты на месте;
  `present` — по последнему снимку `mp_fbs_daily_stock` привязанного склада продавца,
  просуммированный по всем `skuKeys` площадки; `delta = own − present`. Три состояния присут-
  ствия на МП: (1) по складу продавца в последнем снимке нет НИ ОДНОЙ строки вообще →
  `{present: null, delta: null}` — «нет данных» (снимок за площадку/склад ещё не пришёл), НЕ
  расхождение; (2) снимок по складу есть, но конкретного SKU в нём нет → подтверждённый
  `present = 0` (сборщики `wb_fbs_stocks`/`ozon_fbs_stocks` пишут нулевые строки по всем
  известным SKU, отсутствие строки было бы аномалией); (3) снимок и SKU есть → фактический
  `present`. Ячейка красная (`flags.low`) при покрытии по FBS-скорости места < `min_days`,
  жёлтая (`flags.delta`) при `delta ≠ 0` по любой площадке. Ячейка вообще НЕ создаётся, если
  `own = 0` и `present = 0` по всем площадкам (подтверждённый ноль с обеих сторон): иначе
  каждое привязанное место × каждый товар давало бы пустую «0/0» клетку. Расхождение
  `own = 0` при `present > 0` при этом остаётся видимым.
- **FBS-скорость мест**: `wb_fbs_tasks` (по `warehouse_id`+`nm_id`, окно `VELOCITY_WINDOW_DAYS
  = 28`, `lib/stockCoverage.js`) БЕЗ отменённых статусов — константа `WB_TASK_CANCELLED =
  ["canceled_by_client", "declined_by_client", "defect", "canceled"]`
  (`lib/warehousesData.js`) — тот же список, что `RETURNED_WB` в авто-списании
  (`worker/fbs_writeoff_core.py:48`); менять оба места вместе. Ozon — `ozon_orders`
  `scheme='fbs'`, `is_cancel=0`, то же окно. На кабинете #1 на 08.09 Ozon FBS без заказов в
  окне (последняя запись 12.08 — вне 28 дней): скорость и покрытие ФФ-мест по Ozon сейчас
  везде 0, это факт данных кабинета, не баг сборщика.
- **Сигналы** — `lib/warehousesMetrics.js buildSignals` (4 вида): `discrepancy` (строки с
  `flags.delta`, БЕЗ фильтра `own > 0` — `own=0` при `present>0` на привязанном месте тоже
  расхождение), `gaps` (открытые `stock_move_gaps`, `level:'crit'`), `waiting_accept`
  (документы `shipped` старше `WAITING_ACCEPT_DAYS=7` дней без приёмки), `low_coverage` (топ
  `LOW_COVERAGE_TOP=5` ячеек с покрытием < `minDays` по скорости, `crit` если у топа покрытие
  < `minDays/2`, иначе `warn`). Потребители: шапка `/warehouses` (`SignalsStrip.jsx`, те же
  данные из ответа GET) и главная — `app/api/cabinets/[id]/overview/route.js` вызывает
  `loadWarehouseSignals` напрямую (не через `lib/opsAlerts.js`), кладёт в
  `alerts.warehouses`; виджет «Заканчиваются на складе» на главной с 2026-09-08 читает
  `low_coverage` (`items[].{name, where, qty, coverage, itemKey, colKey}` — ключ строки виджета
  = `itemKey|colKey`, одинаковые имена на разных местах больше не коллидируют) — окно скорости
  28 дн, порог = `minDays` кабинета (дефолт 14, `SUPPLY_MIN_DEFAULT`; точный `minDays` в ответе
  `/overview` не приходит, порог цвета на главной — дефолт, бэклог), «доступно», обе
  площадки, колонка «Где» = место/склад. Раньше виджет был WB-only и считал по «дням с
  продажами» — своим расчётом, независимым от `/warehouses`; теперь одна цифра везде.
  **Отклонение от спеки §5.4**: там написано «через `lib/opsAlerts.js` на главную и в
  брифинг» — брифинг (внешняя SQLite-рассылка владельцу) лежит вне этого репозитория,
  сигналы туда не тянутся; спека поправлена на факт.
  **Блок сигналов на главной — последний в handler'е и под SAVEPOINT** (`SAVEPOINT
  wh_signals` → `RELEASE` / `ROLLBACK TO` в `catch`, через `tenantQuery(sql, [])`):
  `withCabinet` держит ОДНУ транзакцию на запрос, и любая ошибка SQL переводит её в aborted —
  без savepoint сломанные склады роняли бы всю Главную, хотя `catch` их «проглатывает».
  Проверено на живом соединении: `SAVEPOINT`/`ROLLBACK TO`/`RELEASE` проходят через
  `client.query(sql, [])` и восстанавливают транзакцию после ошибки.
- **Инвентаризация места** — POST `inventory_adjust` (роль manager): `location_id`
  обязателен (только позиции С местом; без места — как раньше, `/inventory` `update_qty`).
  Строки блокируются `SELECT … FOR UPDATE` по возрастанию `id`, план дельт — чистая
  `planInventoryAdjust` (400 ДО первой записи при любой ошибке — `withCabinet` коммитит
  только на возвращённом ответе). **`qty_known` обязателен в каждой строке** — это остаток,
  показанный пользователю в колонке «Учёт» модалки: роут под `FOR UPDATE` сверяет его с
  фактическим `qty` и при расхождении отдаёт 400 «остаток позиции N изменился (было X, сейчас
  Y): обновите страницу и повторите» — ДО первого `applyMove`. Без этого «факт», введённый по
  устаревшему экрану, разносился бы дельтой от чужого учёта и молча затирал движение, приехавшее
  за это время (списание FBS воркером, перемещение соседа). Каждая ненулевая дельта — движение
  `kind='adjust'`, `src_kind='manual'`, `src_ref='inv:<ISO-stamp>:<ff_inventory_id>'` (один
  stamp на всю инвентаризацию, отдельная строка на позицию), `note='инвентаризация: <причина>'`.
  `src_ref` — НЕ идемпотентный ключ: двойной клик безопасен семантикой «факт» (второй запрос под
  блокировкой видит новый `qty` → дельта 0 либо 400 по `qty_known`). При переходе контракта на
  «дельту» ключ придётся делать детерминированным.
- **`lib/useSort.js`** — общий хук сортировки таблиц (`useSort`/`cmpVal`), вынесен из
  `stocks/StocksPage.jsx`, используется `MatrixTab.jsx`. В `StocksPage.jsx` и
  `buyer-portrait/BuyerPortraitPage.jsx` остались старые локальные копии — не переведены,
  бэклог (не баг, просто дублирование).
- **`LocationsManager`** вынесен из `/inventory` в
  `app/cabinets/[id]/inventory/LocationsManager.jsx` (переиспользуется настройками места на
  `/warehouses`; `sellerWarehouses` в ответе GET `?tab=places` несёт `location_id` —
  тем же `LEFT JOIN`, что `/inventory`, менеджер мест ждёт это поле). **`ShipmentsPage`**
  получил проп `embedded` (как `TeamPage`, `ReallocTable`) — прячет свой `<Header>` и обнуляет
  свой `padding` (внешний отступ даёт `WarehousesPage`); `SuppliesTab.jsx` рендерит
  `<ShipmentsPage cabinetId={cabinetId} embedded />` целиком, без дублирования логики.
  Вкладка «Поставки» своих сигналов не грузит — `WarehousesPage` дотягивает их одним GET
  `?tab=matrix` (берёт только `signals`), чтобы полоса не пустовала.
- **Непривязанные склады продавца — одна сводная карточка** «Склады продавца без места (N)»
  (`PlaceCard.jsx` `UnboundWarehousesCard`, красная рамка, список «площадка · имя · kind», одна
  кнопка «Привязать»). `buildPlaceCards` не меняли — она по-прежнему отдаёт плоский `places[]`
  с `unbound:true`, группировка чисто в UI: десяток карточек-пустышек без метрик выдавливал
  настоящие места из первого экрана.
- **Что руками**: без привязки мест и складов продавца (как в этапах 2-3) ячейки ФФ пустые
  («нет данных»), а не жёлтые/красные.
- **Кандидаты на удаление из меню после приёмки владельцем** (решает владелец, не код):
  `/ff-stock` (страница есть, в меню её уже нет — дублирует `/inventory`), `/shipments` (целиком переехал во вкладку
  «Поставки» `/warehouses`). Судьба `/mp-stock` и `/move` — тоже решает владелец, пока
  оставлены (`/mp-stock` — источник для ручной сверки «на МП» до приёмки; `/move` — своя
  форма перемещения ФФ→ФФ вне модалки `/inventory`). Старые страницы работают без изменений
  до решения.
- **Сторож**: `scripts/check-warehouses-stage4.sql` (7 проверок, кабинет #1, запуск как у
  этапов 2-3). `matrix_inputs_consistent` (проверка 2) стережёт ИНВАРИАНТЫ ВХОДОВ матрицы —
  `orphan_location` (место, которого нет), `negative_qty`, `null_sku_key` (привязка артикула
  без `nm_id`/`product_id`): при каждом из них позиция молча выпадает из матрицы или врёт в
  ней. Прежнее «сумма с местом + сумма без места = сумма всех» было тавтологией — верно всегда,
  зелёный цвет ничего не значил; сверка «матрица = /inventory» — приёмка владельцем (спека §6),
  не SQL. `fbs_velocity_sources` (проверка 7) считает долю ПО КАЖДОЙ ПЛОЩАДКЕ ОТДЕЛЬНО:
  совместная доля позволяла живой площадке вытянуть мёртвую. Площадка с `total ≤ 20` в окне —
  только диагностика (шум на малых числах), `ok` не роняет.
- **Известный риск (бэклог, общий долг с `/supply-plan`)**: `readSupplySettings`
  (`lib/supplyPlanData.js:91`) читает `auth.cabinets` через пул (`query`), а не `tenantQuery`,
  то есть внутри транзакции `withTenant` берётся ВТОРОЕ соединение на запрос. RLS и
  консистентность витрины это не ломает (`auth.cabinets` — не tenant-таблица), но на пике
  удваивает потребление пула (`max: 10`). Чинить вместе с `/supply-plan`, чтобы не расщеплять
  источник настроек.

### 🆕 Кабинет Ozon: позиции по запросам и трафик (с 2026-09-12)

Спека `docs/superpowers/specs/2026-09-12-ozon-cabinet-search-traffic-design.md`. Официальный
Seller API не отдаёт позиции товара по поисковым запросам и разложение трафика по SKU — оба
набора берутся из внутреннего API кабинета продавца (`seller.ozon.ru`) под живой сессией
владельца в браузере, а не токеном.

- **Таблицы** (миграция 058): `tenant.ozon_search_queries_daily` (SKU × день × запрос:
  позиция, спрос, клики, заказы, GMV), `tenant.ozon_sku_search_daily` (SKU × день: средняя
  позиция — КАНОН, спрос, CTR, GMV), `tenant.ozon_sku_traffic_daily` (SKU × день: воронка
  показов/корзины/заказов, конверсии, ДРР, дни в Трафаретах, `search_position` — позиция из
  другого эндпоинта, справочно). `auth.shops`: `cabinet_company_id`, `cabinet_profile_dir`,
  `cabinet_state` (`none`/`ok`/`expired`), `cabinet_last_error`, `cabinet_failed_at`,
  `cabinet_last_attempt_at`, `cabinet_notified_at`. `jobs.collector_runs.run_kind` — добавлен
  `'cabinet'`.
- **Клиент** `worker/cabinet_client.py` (Playwright 1.62.0, свой venv `worker/.venv-cabinet` —
  браузер общий с ozon-panel, `playwright install` в этом venv не запускать, чтобы не менять
  браузер под чужим профилем) — `launch_persistent_context` под сохранённым профилем
  владельца, `headless=False` + `DISPLAY=:99` (иначе Ozon режет сессию), процесс без
  `HTTP_PROXY`/`HTTPS_PROXY` (Chromium падает на прокси с авторизацией). Только чтение: ходит
  исключительно по константе `ALLOWED_PATHS` (6 путей) — любой другой путь отклоняется до
  похода в сеть. `CabinetAuthError` (401/403 либо форма входа вместо JSON под HTTP 200) →
  сборщик выходит кодом 5 с маркером `CABINET_AUTH_EXPIRED:` последней строкой в stderr;
  `CabinetBusyError` (профиль занят другим процессом, `SingletonLock`) → до 5 повторов по 60 с,
  затем код 3; битый/обрезанный JSON под 200 трактуется как сетевая ошибка и тоже уходит в
  ретрай (не наша вина, но и не документ). Селф-тест: `worker/cabinet_client_selftest.py`.
- **Сборщики** `worker/collectors/ozon_cabinet_search.py` (сводка по SKU + запросы,
  `search-query-analytics/v2`), `ozon_cabinet_traffic.py` (`charts/v3/table/by_sku`) и
  `ozon_cabinet_prices.py` (три цены/соинвест, `get-common-prices`) →
  селф-тест `worker/collectors/ozon_cabinet_selftest.py`. Пишут одной транзакцией ПОСЛЕ всех
  сетевых вызовов дня (правило `ozon_metrics`, выше по документу) — чужие SKU дня не трогаются,
  идемпотентно. Exit: 0 ok · 3 partial (день не готов / профиль занят) · 5 сессия истекла ·
  1 прочая ошибка кабинета.
- **Окно дня различается по сборщикам.** `ozon_cabinet_search`: правая граница
  ИСКЛЮЧАЮЩАЯ (`periodFrom=d`, `periodTo=d+1`) — один и тот же день в обеих границах
  кабинет отдаёт как `NO_DATA` (проверено 12.09). `ozon_cabinet_traffic`: окно ВКЛЮЧАЮЩЕЕ
  (`date_from=date_to=день`). Страницы: запросы по SKU — по 10 (`pageNumber` с нуля, конец —
  пустой список `queries`), трафик — по 30 SKU (`offset`, конец — пустой сырой `items`, не
  отфильтрованный результат парсера).
- **⚠️ Обязательное поле `sort` — найдено при внедрении 12.09, в спеке §3.3 его не было.**
  Тело запроса `charts/v3/table/by_sku` БЕЗ `sort` кабинет отклоняет (`sort is required`);
  списком `[{...}]` — тоже отклоняет (`proto: syntax error … unexpected token [`). Рабочий
  вариант — ОДИН объект: `"sort": {"key": "ordered_units", "order": "DESC"}`. Не путать с
  Seller API `/v1/analytics/data` (`worker/collectors/ozon_client.py`), где `sort` — список.
- **Один процесс на профиль — три рубежа.** (1) Панель ozon-panel синкается через тот же
  профиль в 07:00 — таймер `saas-cabinet` идёт в 06:00 и 20:00, мимо; (2) режим `cabinet`
  берёт `flock -w 600 -E 75 /run/lock/saas-cabinet.lock` (ждёт до 10 мин, иначе код 75); (3)
  `CabinetBusyError` внутри сборщика — 5 повторов по 60 с, затем партиал. Клиент/агент
  НИКОГДА не логинится сам — код подтверждения из СМС видит только владелец.
- **`cabinet_state`** (`worker/cabinet_state.py`, зеркало `worker/shop_auth.py` для
  «сломанных ключей», но проще — одно состояние без счётчиков попыток). `expired` →
  оркестратор пропускает сборщики кабинета (`skipped`/`cabinet_expired` в
  `jobs.collector_runs`, прогон остаётся зелёным), раз в `SAAS_CABINET_RETRY_HOURS` (20)
  пробует снова — владелец мог войти заново; успех возвращает `ok`. Магазин без
  `cabinet_profile_dir`/`cabinet_company_id` — `skipped`/`no_cabinet` (как `no_token`).
  Владелец видит: баннер в шапке кабинета рядом с баннером сломанных ключей
  (`app/cabinets/[id]/layout.js`), письмо через существующий таймер `saas-notify-keys`
  (`scripts/notify-broken-keys.mjs`, одно письмо на эпизод через `cabinet_notified_at`) и
  строку на `/health` (`app/api/health/route.js` → `cabinets_expired`,
  `app/health/HealthPage.jsx`).
- **Режим `cabinet`** в `worker/run_saas_collect.sh` — позиционные аргументы
  `cabinet <DAYS_FROM> <DAYS_TO>`, дефолт 3..1 (лаг кабинета до суток + запас на пропущенный
  тик): интерпретатор `worker/.venv-cabinet/bin/python` (только этот режим; остальные
  режимы — прежний интерпретатор воркера `/opt/agents/data-presenter-agent/.venv/bin/python`),
  `DISPLAY=:99`, снятие
  `HTTP_PROXY`/`HTTPS_PROXY`, `flock` на профиль. Таймер `saas-cabinet`
  (`deploy/systemd/saas-cabinet.{service,timer}`) — 06:00/20:00 MSK,
  `TimeoutStartSec=60min` (2 сборщика × `SAAS_COLLECTOR_TIMEOUT_SEC=1500` = 50 мин
  наихудший случай + до 10 мин ожидания `flock`, с запасом). Регистрация сборщика =
  оркестратор (`OZON_COLLECTORS`, `CABINET_COLLECTORS`, `PAUSE_EXEMPT_COLLECTORS` — пауза
  по сломанным API-ключам их не глушит; отдельно в `_run_one` флаг `needs_ozon_creds`:
  если в прогоне остались только сборщики кабинета, гейт по `OZON_CLIENT_ID`/`OZON_API_KEY`
  не проверяется и `auth_state` ключей не трогается — у кабинета своя авторизация) И
  `run_saas_collect.sh` (урок памяти проекта: регистрация в одном месте — недостаточно) —
  гард `scripts/test-cabinet-registration.py` проверяет обе точки, часть проверок —
  исполнением вырезанного блока shell-скрипта с фейками, а не текстом (методика
  `testing-discipline`).
- **Сторож** `scripts/check-ozon-cabinet.sql` (`-v cab=1`): проверки 1 (SKU сводки = SKU
  запросов и наоборот), 3 (Σ спроса по запросам SKU ≥ 0,8 × спрос сводки), 4 (нет дыр в
  собранном диапазоне дней) — гейт; **проверка 2** (позиция сводки
  `ozon_sku_search_daily.position` vs `search_position` из `charts/v3`) — **СПРАВОЧНАЯ, не
  гейт**: два эндпоинта кабинета считают позицию по-разному, порог «≥90% при |Δ|≤5» не
  проходит ни в один день и только шумит, медиана |Δ| ≈ 10 (решение 12.09.2026). Отдельно
  `scripts/check-ozon-cabinet-drr.sql` сверяет ДРР кабинета (`ozon_sku_traffic_daily.drr`) с
  ДРР панели по SKU (`tenant.ozon_daily_sku_ad` ÷ `tenant.ozon_orders`) — первая сверка
  12.09.2026: медиана |Δ| 0,28 п.п. на 459 строках, выбросы до 18,6 п.п. на днях с малым числом
  заказов (малый знаменатель — большой относительный разброс); решение о канонизации —
  владельца, после недели наблюдений.
- **Витрина**: `lib/ozonSearch.js` (чистые функции, БД не трогает; селф-тест
  `scripts/check-ozon-search-selftest.mjs`) — `weightedPosition` (средняя позиция, взвешенная
  спросом `search_users`), `aggregateSkus`, `buildQueryMatrix`, `kpiFromQueries`,
  `positionTone` (≤10/≤30/≤100/>100). Страница «Поиск и запросы»
  (`/cabinets/[id]/search`, пункт меню в группе «Сводка по товарам», после «Заказы по
  времени») и API `/api/cabinets/[id]/search` (`lib/db.js` — маппинг трёх таблиц выше) —
  только Ozon, для WB позиций нет. Заказы/GMV на странице — «по запросу» (статистика поиска
  кабинета), НЕ заказы панели — подписаны явно, `lib/ozonMetrics.js` не меняется. Блок
  «Трафик по дням (кабинет Ozon)» на «Детальной сводке» товара Ozon — ключ ответа `traffic` в
  `app/api/cabinets/[id]/detail/route.js`, читает `ozon_sku_traffic_daily` по `product_id`;
  ДРР кабинета там — справочно, см. проверку выше. Подробности формул — `docs/metrics-
  contract.md` §17.
- **Бэкфилл**: кабинет #1 покрыт 04.08–10.09 (38 дней без дыр, `minStatisticsTime` кабинета —
  самый ранний доступный день). Лаг кабинета — вчерашний день появляется в течение суток.
- **Профиль — не копировать, не выгружать.** Второй кабинет с профилем (#1008) —
  архитектурно готово (те же колонки `auth.shops`), ждёт входа владельца ЭТОГО кабинета на
  сервере (бэклог).

## Правила работы с кодом

- **Миграции идемпотентны** (`CREATE ... IF NOT EXISTS`, `ON CONFLICT`). Новые —
  с номером `0NN_*.sql`, не трогают существующие.
- **Backup перед правкой** боевого файла — в `/opt/agentsDB/backups/` (правило
  экосистемы). Для новых файлов не нужно.
- **Не открывать `.db` файлы** — всё в PostgreSQL. Если нужно новое поле —
  миграция в `tenant.*` + сборщик пишет, либа читает.
- **После правок `.js` в `app/`/`lib/`** — ребилд + рестарт `saas-web.service`
  (`npm run build && systemctl restart saas-web`). Старый дубль `saas.service`
  удалён 2026-08-06 (бэкап юнита в `/opt/agentsDB/backups/`).
- **Не гонять `next dev` в каталоге прода** — dev-режим затирает продакшен-сборку
  в `.next/`, и следующий рестарт `saas-web` упадёт. Смоуки — только после
  финального `npm run build`, либо dev в отдельной копии каталога.
- **После правок сборщиков `.py`** — проверка: `python -m worker.orchestrator
  --cabinet N --collectors <name>`.
- **Доступ к боевой БД разделён (2026-08-08).** Смотреть данные — под ролью
  `saas_ro`: `psql -h localhost -U saas_ro -d saas -Atc "…"`, пароль в
  `~/.pgpass`. У роли нет прав на запись ни в одну таблицу (проверено:
  INSERT/UPDATE/DELETE/CREATE/DROP отклоняются), но есть `BYPASSRLS` — иначе
  `tenant.*` под построчной защитой отдавала бы ноль строк. Роль заводится
  скриптом `db/ops/saas_ro_role.sql` (не миграция: роли живут в кластере).
  Запись — только явным указанием админского файла:
  `PGPASSFILE=/root/.pgpass-admin psql -U postgres …`; проверочные скрипты
  запускаются так же (`scripts/lib/pgpass.mjs`). Пароль `postgres` из
  `~/.pgpass` убран, поэтому случайная запись невозможна физически, а не по
  договорённости. Воркера и панель это не касается: они берут свои пароли из
  `/etc/saas-worker.env` и `.env.local`. Памятка для сторонних агентов —
  `docs/db-read-access.md`.
- **Ключи маркетплейса проверяются при сохранении** (`lib/mpValidate.js`): проверяются
  именно те доступы, которые нужны сборщикам (у WB — статистика и цены, у Ozon —
  каталог и финансы), потому что валидный ключ без нужной роли даёт пустые отчёты.
  Отказ маркетплейса распознан → 422 и объяснение клиенту; недоступность (5xx,
  таймаут, 429, незнакомый ответ) → сохраняем с предупреждением, чтобы авария
  маркетплейса не блокировала регистрацию. Проверять модуль — `node
  scripts/check-mp-validate.mjs` (заглушка, настоящие ключи не нужны).
- **Онбординг живьём не принят.** Путь нового клиента переделан 2026-08-08, но
  ни один живой клиент им не проходил: автотесты ходят в файловую раковину
  вместо почты и в тестовые адреса вместо маркетплейсов. Чеклист ручной
  приёмки — `docs/onboarding-acceptance.md`; пока он не пройден, считать путь
  проверенным нельзя.
- **Красная сверка с эталоном — запрет на деплой.** `node scripts/check-reference.mjs
  reference/2026-07-cabinet-1` сравнивает наши цифры с официальными отчётами
  маркетплейса за эталонный период. Расхождение считается нашим багом, пока не
  доказано обратное; подгонять эталон под текущий результат панели запрещено —
  он меняется только вместе с новой выгрузкой (см. `reference/*/SOURCES.md`).
  Что означает каждая величина — `docs/metrics-contract.md`. Что выверено, а что
  нет — `docs/data-trust-map.md`. Входит в тот же проверочный набор, что смоуки
  (`scripts/smoke-*.mjs`) и `scripts/check-mp-validate.mjs` из пункта выше.
  Коды выхода (разведены ревью 2026-08-10, до этого «эталон не заполнен» и
  «БД недоступна» были одним и тем же кодом 2 — после заполнения эталона
  любая проблема с доступом к БД молча трактовалась бы как «не провал» и
  разрешала деплой):
  - `0` — сошлось.
  - `1` — есть расхождение. Провал, деплой запрещён, разбирать.
  - `2` — эталон ещё не заполнен владельцем (`reference/2026-07-cabinet-1/expected.json`
    пока весь `null` — ждём выгрузки) или скрипт вызван без аргумента. Это
    **не провал** — до заполнения эталона сверять не с чем.
  - `3` — БД недоступна или запрос не выполнился. Это **провал**, как и код 1:
    если эталон уже заполнен, а прочитать боевые данные не вышло, сверка не
    подтвердила, что всё сошлось, — трактовать как красную, не как код 2.
  Не всё, что перечислено в `expected.json`, сверяется этим скриптом на
  уровне данных: комиссия WB и пять величин Ozon (`sales`/`returns`/
  `commission`/`logistics`/`payout`) намеренно исключены из SQL-сравнения —
  причины и путь восстановления см. в шапке `scripts/check-reference.mjs` и
  в `reference/2026-07-cabinet-1/SOURCES.md`.

### ⚠️ Миграционная ловушка client-страниц (массовый баг, почищен 2026-07-14)

Страницы и роуты портированы из старого single-tenant дашборда (`data-presenter`),
где БД была **синхронным SQLite** и не было `cabinet-id`. Это порождало 6 классов
краш-багов. При добавлении/правке `.jsx`/`.js` в `app/cabinets/[id]/` ВСЕГДА проверяй:

1. **D1 (cabinetId):** компонент принимает `{ cabinetId }`:
   `function FooPage({ cabinetId })`, НЕ `function FooPage()`.
2. **D2 (URL без cabinet):** fetch к `/api/cabinets/${cabinetId}/endpoint`,
   НЕ `/api/endpoint` (кроме глобальных auth/profile/invite/onboarding).
3. **D3 (двойные кавычки):** `${cabinetId}` только в BACKTICKS.
   `fetch("/api/.../${cabinetId}/...")` ✗ (литеральный текст), `` fetch(`/...`) `` ✓.
4. **D4 (async без await):** SaaS-адаптер **асинхронный** (эталон был синхронным SQLite).
   `.all(...).map(...)` ✗ (Promise.map=TypeError) → `(await ...all(...)).map(...)` ✓.
   Вызов async-функции без `await` возвращает Promise → обращение к полю = undefined.
5. **D5 (SQLite-функции):** `datetime(dt,'+3 hours')`, `strftime`, `julianday` — НЕ
   существуют в PG. Замена: `(dt::timestamp + interval '3 hours')::text`.
6. **D6 (контракт фронт↔API):** фронт ждёт `totals.by_category`, API отдаёт `facets.categories`
   → `undefined.map()` = «a is not iterable». Сверяй имена полей.

**Скрининги:**
- `grep -rn 'fetch("[^"]*\${' app/cabinets/` → пусто (D3).
- `grep -rn 'JOIN cogs\|FROM cogs\|c\.cost' app/ lib/` → пусто (нет чтения cogs).
- `grep -rn 'datetime(' app/api/` → пусто (D5).

### ⚠️ Дополнительные грабли, найденные 2026-07-15

7. **D7 (Rules of Hooks):** `useMemo`/`useEffect` — ВСЕГДА ДО ранних `return` в
   клиентском компоненте. `if (loading) return ...; const x = useMemo(...)` ✗
   (число хуков меняется между рендерами → client-side exception). Решение:
   хуки в самом верху, данные с fallback (`data?.items || []`).
8. **D8 (ROUND в PG):** `ROUND(double_precision, 2)` НЕ существует в PG —
   `ROUND` принимает `numeric`. Решение: `ROUND((expr)::numeric, 2)`. Ловили на
   `/mp-stock` (`ROUND(qty*price, 2)` → ошибка). Проверка:
   `grep -rn 'ROUND([^)]*),' app/ | grep -v '::numeric'`.
9. **D9 (dangling `$N` в facet-запросах):** если API строит WHERE с `$1..$N` для
   основного запроса + переиспользует те же фрагменты для facet-запросов, но БЕЗ
   params → `there is no parameter $1`. Ловили на `/purchases`. Решение: единый
   `buildWhere(excludeTag)` с пересборкой `$N`+params для каждого запроса.
10. **D10 (action без id):** если POST-роут проверяет `if (!b.id) return error`
    ДО блока `action:"something"` (где id не нужен, напр. CRUD мест) → action
    всегда падает с «id required». action-блоки без id — ДО проверки id.
11. **Сборщик `wb_stocks` — миграция на новый endpoint (2026-07-18) + мягкая деградация:**
    старый endpoint `GET /api/v1/supplier/stocks` (statistics-api) **отключён WB** в конце
    июня/июле 2026 (release-notes #494/#431) — WB отдаёт на него `429` с телом
    `"This method is deprecated"`. Это НЕ rate-limit, а постоянное «метод устарел», поэтому
    любые retry бесполезны. Срез WB в БД замёрз на 2026-07-15, пока это не вскрылось при
    диагностике страницы `/stocks` (срез на 3 дня устарел).
    **Фикс:** миграция на новый endpoint `POST /api/analytics/v1/stocks-report/wb-warehouses`
    на хосте **`seller-analytics-api.wildberries.ru`** (модуль Analytics, не Supplier).
    Body: `{"isSupplyWarehouse": true, "isWBWarehouse": true}` (оба типа складов; без body →
    `400 "Request body is empty"`). Ответ: `{data:{items:[{nmId, chrtId, warehouseId,
    warehouseName, regionName, quantity, inWayToClient, inWayFromClient}]}}`.
    ⚠️ **Новый endpoint НЕ отдаёт `quantityFull`** — считаем сами:
    `quantity_full = quantity + inWayToClient + inWayFromClient`. Зато «в пути» теперь
    наполняется реальными значениями (старый endpoint в последние месяцы отдавал `inWay*=0`).
    **Мягкая деградация сохранена** (инцидент 2026-07-14): при недоступности WB API
    `wb_stocks`/`ozon_stocks` завершаются `exit 0`, снимок не пишется, но сервис не падает
    (чтобы ozon_stocks продолжал работать). Дополнительно `_fetch` теперь детектит
    `429 + detail:"deprecated"` в теле и сразу сдаётся, не loops'я retry'ями на мёртвый URL.
    Проверка: `python3 -c "import worker.collectors.wb_stocks as m; m._fetch=lambda:None; m.collect()"`.
    Сверка 2026-07-18 (cabinet #1): записано 150 строк, Σ qty=435, Σ qty_full=761
    (включая in_way_to=131, in_way_from=195). Формула quantity_full проверена.
    **Остатки по размерам (с 2026-10-01, миграция 063):** `wb_stocks` пишет ВТОРУЮ запись того же
    снимка без свёртки chrtId — `tenant.wb_daily_stock_sizes` (PK `cabinet_id, nm_id, chrt_id, date,
    warehouse`; RLS + `panel_local_ro_cab1`; в `lib/db.js` — `daily_stock_sizes`, рядом замаплен
    `wb_barcodes`). Агрегат `wb_daily_stock` не менялся; размеры пишутся отдельной транзакцией ПОСЛЕ
    него, сбой → exit 3 (partial), основной снимок цел. Разбор — чистая `build_rows` (селф-тест
    `worker/collectors/wb_stocks_selftest.py`, инвариант Σ размеров = агрегат); `SAAS_PROBE=1` —
    сводка без записи. chrtId приходит и при псевдоскладе «Склад WB» (−999999). Имя размера — из
    `wb_barcodes.tech_size` по `chrt_id`. Витрина: `/stocks` → «Индексы OOS» — строки WB с ▸
    раскрываются по размерам + режим «По размерам WB»; скорость размера = скорость товара
    (`daily_metrics`) × доля размера в `wb_orders` за окно (Σ = строка товара), закончившийся
    размер с заказами в окне — строка «нет остатка». История по размерам — только с 01.10.2026.
    Сверка 01.10 (каб. #1): 38 агрегатных строк / 66 по размерам, Σ qty 673, Σ full 1165, Δ=0;
    смоук `node scripts/smoke-stocks-sizes.mjs 1`.
    **«К закупке, шт» (с 2026-10-01)** — колонка «Индексы OOS» в обоих режимах:
    `⌈скорость × (срок поставки + запас) − доступно − в пути ОТ клиента⌉`, не меньше 0. «В пути К
    клиенту» НЕ вычитается (уже продано, едет покупателю), «от клиента» (возвраты) — вычитается.
    Формула — `lib/supplyPlan.js` `purchaseNeedQty` (поверх `needQty`, спрос за горизонт округлён до
    1e-6 против шума float) + `purchaseNeedForRow/ForItem`: товар WB с размерами = Σ по размерам
    (каждый размер округляется вверх сам), размер с неизвестной скоростью → «—». Считается на
    клиенте; параметры рядом с окном скорости: «Срок поставки, дн» (20) и «Запас, дн» (дефолт —
    `target_days` кабинета, API отдаёт `supplyTargetDays` через `readSupplySettings`), хранятся в URL
    (`?lead=&stockDays=`) и localStorage, сервер не пишет. Тесты — `lib/__tests__/supplyPlan.test.mjs`,
    смоук проверяет «товар = Σ размеров».
12. **WB цена для остатков:** `wb_daily_metrics.price` НЕ наполняется сборщиком
    (пустая). Розничную цену WB брать из `wb_prices` (`price_seller × (1 − discount/100)`).
    Ловили на `/mp-stock` (сумма реализации WB = 0).
13. **D11 (pgp_sym_encrypt → text-колонка):** `pgp_sym_encrypt()` возвращает
    **бинарный `bytea`**. Колонки `api_creds_enc` — **`text`**. Если в Node-роуте
    написать `SELECT pgp_sym_encrypt($1,$2) AS enc` (без `::text`), node-pg получает
    **Buffer** и при записи обратно в text-колонку шлёт его бинарным параметром →
    PG валидирует сырые байты как UTF-8 → `invalid byte sequence ... 0xc3 0x0d`.
    Блокировало онбординг всех новых клиентов (cabinet #1 работал лишь потому,
    что `worker/_init_owner.py` шифрует SQL-side, где сервер сам кастует bytea→text
    в hex-форму `\xc30d...`). **Фикс:** всегда `pgp_sym_encrypt($1,$2)::text AS enc`
    — серверный cast даёт hex-строку, совместимую с text-колонкой И со стороной
    чтения `pgp_sym_decrypt(%s::bytea, %s)`. Round-trip идентичен формату cabinet #1,
    миграция НЕ нужна. Проверка: `grep -rn 'pgp_sym_encrypt' app/ lib/ | grep -v '::text'`
    → должно быть пусто. Латентно тот же баг был в `settings/route.js` (mpstats).
14. **D12 (путаница Ozon Seller Api-Key vs Performance Secret при вводе):** в поле
    «Api-Key» формы /settings клиент вставил 82-символьный **Performance
    Client-Secret** (префикс `Vsds-…`) вместо 36-символьного **Seller Api-Key**
    (UUID `xxxxxxxx-xxxx-…`). Форма и маппинг корректны (проверено round-trip и
    пересохранением на cabinet #1) — ошибка на стороне копирования/автозаполнения.
    Симптом: `Ozon API 400 [3]: Invalid Api-Key`. При новом онбординге Ozon стоит
    проверять длину/формат Api-Key (≠36 или начинается с `Vsds-` → предупреждение).
15. **D13 (тема/палитра — единый источник `lib/palette.js`, с 2026-07-16):** добавлена
    светлая/тёмная тема (next-themes, кнопка 🌙/☀️ в topbar). Палитра консолидирована:
    РАНЬШЕ ~30 страниц дублировали `const C = {...}` + hardcoded hex; ТЕПЕРЬ `C` и
    `soft()` импортируются из `lib/palette.js`, а значения — строки CSS-переменных
    (`C.surface = "var(--panel)"`), которые резолвит браузер при смене класса темы
    на `<html>`. Сами токены (`--bg`/`--panel`/... и алиасы `--surface`/`--ink`/...)
    лежат в `globals.css` в `:root,.dark{}` и `.light{}`.
    **Грабля (главная):** alpha-эффекты вида `${C.line}33` (бордеры, подсветки — было
    79 сайтов) **нельзя** заменить на `${C.line}` → `"var(--line)33"` = невалидный CSS,
    игнорируется. Решение — `color-mix(in srgb, var(--token) N%, transparent)` через
    helper `soft(token, pct)` из `lib/palette.js` (`${C.line}33` ≈ `${soft("line",20)}`).
    `color-mix` поддерживается в 2026 (Chrome 111+/FF 113+/Safari 16.4+). Проверка:
    `grep -rn 'var(--[a-z]*)[0-9A-F]\{2\}' app/ lib/` → должно быть пусто.
    **colorScheme:** нативные date/select-пикеры ранее хардкодились `colorScheme:"dark"`
    inline (~24 сайта) — теперь это `color-scheme` на корневых классах в `globals.css`
    (наследуется), inline-флаги удалены. `lib/theme.js` (тёмно-бирюзовая палитра) —
    **мёртвый код**, никем не импортируется, НЕ источник правды.
16. **D14 (НДС+УСН — выделение из цены, база УСН без НДС, фикс 2026-07-17):** реформа
    УСН+НДС 2025 (порог 60 млн ₽, ставки НДС 5% без вычетов / 7% с вычетами). WB/Ozon
    отдают выручку **с НДС** (сумма, что заплатил покупатель), поэтому корректно:
      • **НДС = revenue × vat/(100+vat)** — ВЫДЕЛЕНИЕ «изнутри» цены (для 5%: × 5/105;
        для 7%: × 7/107). НЕ `vat/100` (это начисление сверху — неверная модель базы).
      • **УСН = (revenue − НДС) × rate%** — от выручки **БЕЗ НДС** (поступивший НДС не
        признаётся доходом, ст. 248/346.15 НК РФ). Минимальный налог 1% — тоже от net.
      • **profit** должен вычитать **И УСН, И НДС** (`tax.total = usn + vat`).
    **Единый источник правды:** `lib/tax.js` (`calcVatTax` = выделение, `calcUsnTax`
    автоматически вычитает НДС из базы, `calcTotalTax().total` = УСН+НДС). Все агрегатные
    роуты используют `calcTotalTax(...).total` (НЕ `calcUsnTax` — он вернёт только УСН
    без НДС, profit будет завышен на сумму НДС).
    **Грабли (3 класса багов, все пофикшены 2026-07-17):**
    (a) **НДС не вычитался из profit** — раньше все роуты звали `calcUsnTax` (только УСН),
    `calcVatTax`/`calcTotalTax` были экспортированы, но мёртвые. Для cabinet #1 (vat=5)
    profit был завышен на ≈4.76% выручки (≈76 ₽ на каждый ₽ 1.6 млн). Фикс: 13 вызовов
    в 6 роутах (`overview`, `pnl`, `detail`, `rnp-summary`, `products-summary`, `unit`)
    переведены на `calcTotalTax(...).total`.
    (b) **УСН считался от выручки с НДС** — `calcUsnTax` раньше брал `revenue` как базу
    напрямую. Теперь он внутри вызывает `calcVatTax` и вычитает НДС. Backward-compatible
    для `vat=0` (база = revenue, поведение прежнее).
    (c) **`/unit/all` ломал дефолт `lib/unit.js`** — `taxRates()` передавал
    `vatRate = vat/100` (0.05), тогда как дефолт `TAX.VAT_RATE = 5/105` (модель выделения).
    Это инвертировало базу НДС/УСН при наличии shopTax. Фикс: `vatRate = vat/(100+vat)`
    (5 → 5/105, совпадает с дефолтом).
    (d) **detail per-day без расходов** (стр. 286 WB, 529 Ozon) — `calcUsnTax(taxMode, rev)`
    без третьего аргумента → для УСН Д−Р налог от полной выручки. Фикс: расходы дня
    добавлены (для WB — сумма day-компонентов, для Ozon — `max(0, rev − grossDay) + adDay`).
    (e) **P&L Ozon netProfit** — брался готовым из `order_costs.profit` БД (без вычета
    налога), тогда как WB вычитал. Теперь оба вычитают `tax` единообразно.
    **UI-лейблы:** раньше в 6 местах захардкожено «УСН 6%» / «НДС 5%» (OverviewClient,
    PnlPage, CalendarPage, DdsPage). Теперь Overview/P&L/Detail отдают `taxLabel` через
    `describeCombinedTaxMode({wb,ozon})` / `describeTaxMode` из `lib/tax.js` (pure,
    работает на клиенте); Calendar/DDS — нейтральный текст «УСН + НДС по режиму магазина».
    Проверки: `grep -rn 'calcUsnTax' app/api/ | grep -v '//'` → пусто (все на calcTotalTax);
    `grep -rn 'vat / 100\|vat/100' app/ lib/ | grep -v '//'` → пусто; `grep -rn 'УСН 6%\|НДС 5%'
    app/cabinets/ | grep -v 'option value'` → пусто.
    ⚠️ **Влияние:** для кабинетов с `vat=0` (большинство) цифры НЕ меняются. Для `vat≠0`
    (cabinet #1, новые с НДС) profit **уменьшается** на сумму НДС (≈4.76% выручки при 5%) —
    это исправление скрытого завышения, а не регрессия. Входной НДС от поставщиков НЕ
    учитывается (себестоимость cost_overrides считается чистой) — отдельная будущая задача.
    Бэкапы: `/opt/agentsDB/backups/vat_fix_20260717_192159/` (11 файлов).
    Источник: [ФНС — НДС при УСН](https://www.nalog.gov.ru/rn77/taxation/taxes/nds_usn/),
    [методичка ФНС](https://data.nalog.ru/html/sites/www.new.nalog.ru/files/about_fts/docs/15318056.pdf).
17. **D15 (WB profit — модель ppvz_for_pay как ЭТАЛОН, фикс 2026-07-31):** прибыль WB
    считалась **компонентным методом** (`retail_amount/cost_value_retail − commission −
    acquiring − logistics − loyalty`) — и систематически врала. Сверка на 2030 заказах
    cabinet #1 показала: ни один компонентный метод **не воспроизводит** `ppvz_for_pay`
    («к перечислению продавцу» от WB). Средняя ошибка текущего кода **−289 ₽** на заказ,
    0/2030 точных; даже лучшая компонентная формула (с правильными знаками WB) даёт +40 ₽,
    0/2030 точных. Причина: WB включает в `ppvz_for_pay` СПП/переоценки/внутренние
    корректировки, которых **нет в отдельных полях** (`commission`, `acquiring`, `ppvz_vw`).
    **Три источника искажения** (на примере заказа eAy.i0aff7...):
    (a) **`loyalty` терял `ppvz_vw` из операции «Продажа».** Сборщик ловил `ppvz_vw` только
    по `supplier_oper_name='Компенсация скидки по программе лояльности'`, но WB кладёт
    `ppvz_vw` (=−1245 ₽, компенсация лояльности) в саму операцию «Продажа» → терялось.
    Масштаб: 2030 из 8801 заказов (23%), ~343 тыс ₽ «потерянных» компенсаций.
    (b) **`acquiring` вычитался как расход, хотя это компенсация.** В WB `acquiring_fee`
    всегда `>0` (2029/2029 на cabinet #1) = WB **возвращает** эквайринг продавцу. Текущий
    код делал `− acquiring` → двойной счёт.
    (c) **Знаки WB не учтены единообразно.** Минус = удержание (комиссия), плюс =
    компенсация (эквайринг, ppvz_vw). Код брал `ABS(commission)` (верно) и `- acquiring`
    (неверно — плюс уже значит приток).
    **Фикс (модель ppvz_for_pay):** `profit = ppvz_for_pay − себестоимость − логистика`.
    Комиссия/эквайринг/лояльность **УЖЕ внутри** `ppvz_for_pay` → НЕ вычитать повторно.
    Логистика идёт **отдельной операцией** («Логистика», `delivery_rub`) и НЕ входит в
    `ppvz_for_pay` операции «Продажа» → вычитаем явно. Для возврата `cost_value_pay`
    обнуляется в SQL (`CASE WHEN is_return=1 THEN 0`), поэтому profit возврата = `−logistics`
    (убыток на логистику, себестоимость не списываем — товар вернулся на склад).
    **Применено в 7 местах (все с бэкапами в `/opt/agentsDB/backups/*20260731_20*.bak`):**
    - `worker/collectors/wb_order_costs.py:100` — `profit = cost_value_pay − cost − logistics`
      + backfill истории (1950/1950 точных совпадений после пересчёта).
    - `lib/wbMetrics.js` — 3 функции `wbFinance*` теперь возвращают `forPay`; `calcOperatingProfit`
      принял параметр `forPay` (модель ppvz_for_pay), backward-compat fallback оставлен.
    - `app/api/cabinets/[id]/{overview,products-summary,rnp-summary,detail}/route.js` — profit и
      налог считаются от `forPay`, без вычитания commission/acquiring (уже внутри).
    - lossMakers в overview — то же.
    ⚠️ **Суб-баг фикса (найден и починен сразу):** lossMakers в overview берёт данные из
    **inline-SQL** (`SELECT ... FROM finance_report`, стр. 172-182), а НЕ из `wbFinancePeriodByNm`.
    Первая версия фикса переписала расчёт под `f.forPay`, но забыла добавить `SUM(ppvz_for_pay)
    AS forPay` в тот inline-SQL → `f.forPay=undefined` → `forPay=0` → profit = `0 − logist − cost
    − ad − tax` = гигантский минус (−134061 на «Регистратор 3 камеры дешевый без флеш»). Симптом:
    «проблемные места» засыпаны нереальными минусами. **Урок:** при переводе потребителя на новое
    поле — проверить ВСЕ источники этого поля (inline-SQL ≠ helper-функция), а не только формулу.
    Скрининг `grep forPay` это пропустил (forPay упоминался в расчёте, но не в источнике данных).
    Фикс: добавить колонку в inline-SQL + проверить **живой вывод lossMakers**, а не только
    SQL-симуляцию по эталонному заказу.
    **НЕ тронуто (отдельные контуры, явно помечены в шапке `lib/wbMetrics.js`):** P&L `/pnl`
    (остаточный метод комиссии, своя модель на `retail_amount`), юнит-экономика `/unit/all`
    (`lib/unit.js calcWB`, на `retail_amount`). Их модель — отдельная задача.
    ⚠️ **Ozon НЕ затронут** — у Ozon свой `order_costs.profit` (компонентный), аналог
    `ppvz_for_pay` не проверен. Отдельная задача.
    **Сверка (cabinet #1, последние 30д WB):** netPay (768 378) ≈ salesRub − commission −
    acquiring (790 242) − 22к возвраты/прочее. Старый метод завышал profit на ~22 тыс за 30д.
    После суб-баг-фикса: lossMakers показывает реальные минусы (топ −4901 реклама, −3857 себест),
    а не артефакты −134к. Проверки: `grep -n 'forPay' app/api/cabinets/[id]/overview/route.js` —
    рядом с forPay нет `- commission`/`- acquiring` (двойное вычитание). D8 чист.

---

## ⚙️ ПРАВИЛО ХОЗЯИНА: экономия токенов (с 2026-07-31)

Хозяин попросил **экономить токены** в каждой сессии. Применять по умолчанию:
- **Делегировать рутинный поиск/чтение кода субагентам на дешёвой модели** (`model: "haiku"`
  в `Agent`). Идеально для: «найди все места где X», «прочитай файл Y и дай сводку», grep-задачи.
  Сам проверил на задаче «найти все места расчёта profit WB» — `haiku` дал полный отчёт
  с file:line за ~216к токенов вместо того, чтобы мне читать 6 файлов руками.
- **Отвечать короче**, без лишних инструментальных вызовов там, где ответ очевиден.
- **Параллельные независимые вызовы** — в одном сообщении (уже правило харнесса, но важно).
- Основной диалог и правки кода — на основной модели; на `haiku` только поиск/исследование.

---

## 📍 Точка останова (2026-08-01 — РНП: стрелка тренда СПП/соинвеста в колонке «Скидка МП»)

**Контекст:** хозяин попросил добавить в РНП стрелку роста/падения СПП относительно
предыдущего дня. Выяснили: колонка «Скидка МП, %» уже показывала СПП (`AVG(wb_orders.spp)`
для WB / `current_boost` для Ozon), но без тренда. Отдельного ежедневного снапшота СПП нет
(`wb_daily_metrics.spp` мёртвый, 0/3384), но `wb_orders.spp` заполнен на 100% (с 2026-05-01) —
этого достаточно для `AVG(spp)` по периодам.

**Сделано (минимальная правка по образцу CTR/Рейтинг):**
- ✅ `app/api/cabinets/[id]/rnp-summary/route.js`:
  - блок 5б: `sppPrev` — `AVG(orders.spp)` за предыдущий период (WB), симметрично блоку 5.
  - блок 5б-ozon: `boostPrev` — последний снимок `current_boost ≤ prevTo` (Ozon).
  - в items: `mpDiscountPrev` (WB + Ozon).
  - в цикле трендов: `it.mpDiscountTrend = trendOf(it.mpDiscount, it.mpDiscountPrev)`.
- ✅ `app/cabinets/[id]/rnp/RnpPage.jsx:248` — `<Trend trend={it.mpDiscountTrend} />` в ячейке.
- Название колонки оставлено «Скидка МП, %» (по выбору хозяина).
- Сверка (cab #1, 7д): стрелки считаются корректно (3 камеры дорогой 39→45 ▲, видеорег.
  дешевый 45→39 ▼ и т.д.). Ozon-соинвест пуст → «—» без стрелки (корректно).

**Состояние:** `saas.service` ✅ боевой (HTTP 200, ребилд 2026-08-01 ~12:36). Не закоммичено.
Бэкапы: `/opt/agentsDB/backups/{rnp-summary.route.js,RnpPage.jsx}.20260801_123506.bak`.
**Дальше (опц.):** починить ежедневный сбор СПП в `wb_daily_metrics.spp` (сборщик `wb_metrics.py`
не передаёт spp в `upsert_daily`) — на будущее, для настоящей daily-динамики. Сейчас работает на заказax.

---

## 📍 Точка останова (2026-07-31 — WB profit перешёл на модель ppvz_for_pay, урок D15)

**Контекст:** хозяин на странице «Заказы» увидел profit 2083 ₽ по заказу, где экономически
`ppvz_for_pay − себест = 4769 ₽`. Диагностика вскрыла, что компонентный метод расчёта
profit WB систематически врал. Сверка на 2030 заказах cabinet #1 установила эталон.

**Сделано в сессии (баг до копейки, всё свёрено):**
- ✅ **Установлен ЭТАЛОН:** `ppvz_for_pay` («к перечислению продавцу» от WB) сходится до копейки
  на **1950/1950** заказах cabinet #1. Компонентный метод даёт среднюю ошибку −289 ₽, 0/2030
  точных — WB включает в `ppvz_for_pay` СПП/переоценки/корректировки, которых нет в отдельных
  полях (commission/acquiring/ppvz_vw).
- ✅ **Формула profit = ppvz_for_pay − себестоимость − логистика.** Комиссия/эквайринг/лояльность
  УЖЕ внутри ppvz_for_pay → НЕ вычитать повторно. Логистика — отдельная операция WB, её вычитаем.
- ✅ **7 мест (все с бэкапами `/opt/agentsDB/backups/*20260731_20*.bak`):**
  - `worker/collectors/wb_order_costs.py:100` — формула profit + backfill истории (2052 строки).
  - `lib/wbMetrics.js` — 3 функции `wbFinance*` возвращают `forPay`; `calcOperatingProfit` принял
    параметр `forPay` (модель ppvz_for_pay), backward-compat fallback оставлен для старых вызовов.
  - `app/api/cabinets/[id]/{overview,products-summary,rnp-summary,detail}/route.js` — profit и
    налог от `forPay`. lossMakers в overview — то же.
- ✅ **Сверка эталонного заказа `eAy.i0aff7...`:** profit **4621.60 ₽** (было 2082.94) =
  7018.80 − 2250 − 147.20 ✅.
- ✅ **WB за 30д:** netPay 768 378 ≈ salesRub − comm − acq (790 242) − 22к возвраты/прочее.
  Старый метод завышал profit на ~22 тыс/30д.

**НЕ тронуто (отдельные контуры, явно помечены в шапке `lib/wbMetrics.js`):**
- P&L `/pnl` — своя модель (остаточный метод комиссии, `retail_amount`).
- Юнит-экономика `/unit/all` (`lib/unit.js calcWB`, `retail_amount`).
- **Ozon** — отдельная задача, аналог `ppvz_for_pay` не проверен.

**Состояние:**
- `saas.service` — ✅ боевой (next start :3200, ребилд 2026-07-31 ~20:40, HTTP 200).
- Воркеры/таймеры — ✅ боевые. Backfill `wb_order_costs` выполнен, при следующем `saas-worker`
  новые заказы пойдут уже по правильной формуле.
- `cabinet #1` — ✅ боевой, сверки прошли. Остальные (#1008 и др.) — **боевые клиентов, не трогал**.
- **Не закоммичено.** В `git status`: мои правки — `wb_order_costs.py`, `lib/wbMetrics.js`,
  4 роута (`overview`, `products-summary`, `rnp-summary`, `detail`), `AGENTS.md`. Остальные
  изменённые файлы (products-summary/summary от 2026-07-23, и прочие из прошлых сессий) — НЕ моя
  работа, не коммитить вместе. Решает хозяин. Бэкапы: `/opt/agentsDB/backups/*20260731_20*.bak`.

**Дальше (опц.):**
- (Перенос) **Ozon-аналог `ppvz_for_pay`** — проверить, есть ли в `ozon_order_costs`/API поле
  «к перечислению», и применить ту же модель. Сейчас Ozon profit компонентный.
- (Перенос) P&L `/pnl` и юнит-экономика `/unit/all` — перевести на ppvz_for_pay-модель, если
  хозяин захочет единообразия (сейчас у них своя модель на `retail_amount`).
- (Перенос с прошлых сессий) Валидация Ozon Api-Key в /settings (урок D12).
- (Перенос) `lib/theme.js` — мёртвый код, можно удалить.
- НДС-работа (урок D14) НЕ закоммичена — ждёт хозяина.

---

## 📍 Точка останова (2026-07-23 — Сводка по товарам: фикс прибыли Ozon + все артикулы + возвраты + фильтр статуса)

**Контекст:** хозяин зашёл в «Сводку по товарам» → выбрал Ozon → увидел «прибыль минут 45000» (минус),
причём непонятно по каким товарам, и не все артикулы. Диагностика на cabinet #1 вскрыла **3 независимых
бага** + 1 методологическую дыру. Все починено в одном роуте `app/api/cabinets/[id]/products-summary/route.js`
(+ маленькая правка UI). Сверено на cabinet #1 в боевой БД.

**Сделано в сессии:**

- ✅ **БАГ 1 (главный, причина «−45к»): WB-реклама вычиталась из Ozon-прибыли.**
  В `route.js` блок пересчёта `fullAd` (Σ ad_spend периода) суммировал WB + Ozon рекламу **без platform-гарда**.
  Симметричный блок logistics имел защиту `if (platform !== "ozon")`, а блок рекламы — нет. При выборе фильтра
  «Ozon»: `fullAd = WB реклама 81 668 ₽ + Ozon 0`, и весь WB-объём вычитался из Ozon `totals.profit`.
  Арифметика сходится ровно: +36 017 (реальный profitClean) − 81 668 = **−45 651** ≈ жалоба «−45к».
  **Фикс:** обернул WB-ad блок в `if (platform !== "ozon")`, симметрично logistics-блоку.
  Проверка: totals.profit стал **+4 152 ₽** (был −45 651).

- ✅ **БАГ 2: возвраты не учитывались в прибыли → «непонятно откуда минус».**
  `profitClean` = `salesRub − comm − logist − acq − loyalty − cost − ad − tax`, где все расходы — только по
  `is_return=0`. Возвратные строки (`is_return=1`, `cost_value_retail=0`, `profit` в БД = −3231) вообще не
  входили в profit → за 30 дней **34 247 ₽** (логистика 24к + комиссия 10к) «исчезали», а на worst-товарах
  были необъяснимые минусы.
  **Трактовка хозяина:** возврат = **только логистика возврата + комиссия Ozon**; себестоимость НЕ списываем
  (товар физически вернулся на склад). НЕ «возврат = убыток» (тогда profit улетел бы в −59к), НЕ «отдельная
  колонка вне profit».
  **Фикс:** в SQL-запросе Ozon добавлены агрегаты `rLogistics` + `rCommission` (по `is_return=1` периода);
  в сборке item `returnLogistics = rLogistics + rCommission` вычитается из `profitClean` и входит в базу
  УСН (`ozItemExpenses`). WB return-объекту добавил `returnLogistics: 0` (у WB возвратная логистика уже
  ВХОДИТ в поле `logistics` — грабля #98, сторно по `delivery_rub` операции «Логистика»).
  ⚠️ **Счёт `?` плейсхолдеров в SQL Ozon:** 12 колонок с `?` (sold, returns, selfBuyout, salesRub, costRub,
  commission, logistics, acquiring, loyalty, rLogistics, rCommission, profit) = 24 аргумента. `.all()` даёт
  ровно 12 пар `from, toEnd`. Проверено через `PREPARE`/`EXECUTE` (урок D9 — dangling `$N`).

- ✅ **БАГ 3: не все артикулы Ozon (88 vs 45).** Список собирался только из `order_costs`
  (`FROM order_costs ... GROUP BY product_id`). У WB есть `addStub()` (добавляет товары из orders/sales),
  у Ozon `freshOz` убран (грабля #134), и больше ничего товары «впустую» не добавляло → 43 артикула
  (экшн-камеры, видеорегистраторы, карты памяти) были невидимы.
  **Фикс:** добавил `addStub` по `tenant.ozon_products` (симметрично WB) перед `return rows.map(...)` —
  подтягивает name/brand/im_url/sa из products, все фин. поля = 0.

- ✅ **Фильтр статуса (правка после замечания хозяина «почему ВСЕ товары»).**
  Первый вариант addStub сломал логику «показывать только активные» (как в /unit/all) — добавил все 88,
  включая 34 inactive без продаж. **Применён паттерн /api/unit/all:** `statusMap()` из `lib/finItems.js`,
  параметр `?includeInactive=1`. **Правило (выбор хозяина «active + с историей»):** товар active (или без
  записи → fallback "active") показывается; inactive БЕЗ продаж — скрывается; inactive С продажами/возвратами
  за период — показывается (чтобы не терять свежие продажи снятого с продаж товара). Ключ statusMap:
  WB=`wb|${nm}|0`, Ozon=`ozon|0|${pid}` (совпадает с unit/all). Цифры cabinet #1: 88 → **56 видимых**
  (54 active + 2 inactive-с-продажами; 32 inactive-мусора скрыто).

- ✅ **UI:** колонка «Убыток возвр.» (`returnLogistics`) рядом с «Возвраты» в `SummaryPage.jsx` COLS +
  ячейка в строке + total в tfoot. Красным если > 0. Теперь видно, по каким товарам возвраты бьют.

**Сверка (cabinet #1, Ozon, дефолт 30д):**
| Метрика | Было | Стало |
|---|---|---|
| totals.profit (Ozon) | **−45 651 ₽** | **+4 152 ₽** |
| count товаров | 45 | 56 (был 88 после первого фикса → фильтр статуса) |
| учёт возвратов | скрыт (−34к) | 34 247 ₽ видны в колонке «Убыток возвр.» |

**НЕ трогал (отдельная задача):** `commission = 47%` от выручки в `ozon_products` для ниши накидок/экшн-камер —
это **не баг**, реальная комиссия Ozon (sales commission + last mile + прочее в одном поле). Если хочется
подсветку товаров с аномальной комиссией (>30%) — отдельная задача диагностики.

**Состояние:**
- `saas.service` — ✅ боевой (next start :3200, ребилд 2026-07-23 ~14:35, HTTP 200).
- Воркеры/таймеры — ✅ боевые, правок `.py` не было.
- `cabinet #1` — ✅ боевой. Остальные активные (#1008 и др.) — **боевые клиентов, не трогать**.
- Бэкапы: `/opt/agentsDB/backups/{products-summary.route.js.20260723_131437.bak,
  SummaryPage.jsx.20260723_131437.bak, products-summary.route.js.20260723_133034.bak (перед фильтром статуса),
  AGENTS.md.20260723_143446.bak}`.
- **Не закоммичено.** В `git status`: `products-summary/route.js` + `summary/SummaryPage.jsx` — мои правки.
  Остальные изменённые файлы (`articles`, `mp-stock`, `stocks`, `inventory`, `layout`, `db.js`, `worker/*`)
  и untracked (`buyer-portrait/`, `plan/*`, `wb_jem.py`, миграция 027) — **НЕ моя работа** (из прошлых
  сессий / параллельные задачи), не коммитить вместе. Решает хозяин.

**Дальше (опц.):**
- (Перенос) Подсветка товаров с commission_pct > 30% (аномальная комиссия Ozon) — диагностика, не фикс.
- (Перенос с прошлых сессий) Валидация Ozon Api-Key в /settings (урок D12); `lib/theme.js` — мёртвый код.
- НДС-работа (урок D14) НЕ закоммичена — ждёт хозяина.

---

## 📍 Точка останова (2026-07-19 — Склады/индексы: рекомендации по перевозке + Эффективность складов + сортировка)

**Сделано в сессии (3 доработки, все на боевой, сверены на cabinet #1):**

- ✅ **1. Рекомендации по перевозке между складами WB + новая вкладка «Перевозки».**
  Контекст: на вопрос «можно ли через WB API перемещать остатки между складами» — ответ
  **НЕТ**: WB не публикует endpoint создания перевозки. Но WB отдаёт справочники
  (`GET /api/v1/warehouses` — 129 складов с id/name; `GET /api/v1/transit-tariffs` —
  138 направлений с тарифом коробки/палеты; `POST stocks-report/wb-warehouses` отдаёт
  `regionName` = кластер склада). Все подтверждены живым probe 2026-07-18.
  - **Миграция 025** `025_wb_references.sql`: `shared.wb_warehouses` (id, name, address,
    region, is_active, is_transit_active) + `shared.wb_transit_tariffs` (transit→dest,
    box_tariff JSONB, pallet_tariff). Глобальные, без RLS. + колонка `warehouse_id`
    в `tenant.wb_daily_stock` (сборщик wb_stocks уже получал warehouseId, но не сохранял —
    нужен для надёжного маппинга stocks↔warehouses, т.к. по именам совпадение лишь 45%,
    по id — 84%+).
  - **Новый сборщик** `worker/collectors/wb_references.py` (еженедельно, таймер
    `saas-references.timer` Mon 06:00): тянет warehouses + transit-tariffs + region
    (из stocks-report) в shared.*. Мягкая деградация как у wb_stocks. Режим
    `references` добавлен в `run_saas_collect.sh` + имя в `WB_COLLECTORS` orchestrator.
    ⚠️ 2026-09-08: оба источника внешне деградированы — supplies-api `/warehouses` и
    `/transit-tariffs` отдают 404 «This method is temporarily disabled»
    (release-notes?id=570, с 24.08), а stocks-report — только псевдосклад «Склад WB»
    (−999999, см. выше). Сборщик на 4xx НЕ падает (раньше три понедельника подряд ронял
    юнит после успешного stocks-report и ничего не писал): печатает detail, пропускает
    источник, exit 0; `shared.wb_warehouses`/`wb_transit_tariffs` остаются от 10.08 до
    возврата методов. Селф-тест без сети/БД: `worker/collectors/wb_references_selftest.py`.
    ⚠️ stocks-report — ПЕРВИЧНЫЙ источник (содержит warehouseId+name+regionName в одном
    ответе, имена совпадают со снимком); /warehouses — дополнение (101 склад без региона,
    т.к. там regionName не отдаётся). is_active/is_transit_active стали nullable (миграция 026)
    — stocks-report их не отдаёт, NOT NULL блокил upsert. COALESCE в db_pg.py сохраняет
    существующее значение при частичном ответе.
  - **API** `buildReallocRecommendations` в `stocks/route.js`: для каждого nm_id с
    velocity>0 — разворот остатка по складам + LATERAL JOIN к тарифам. Алгоритм:
    избыток на from-складе (≥40% остатка SKU) → дефицит на to-складе (qty=0) →
    рекомендация «везти N шт, тариф X ₽». Кол-во = половина избытка.
    **Фильтр «не истощай источник» (правило хозяина)**: если qty_from ≤ 4 И при текущей
    velocity склад протянет ≤ 8 дней → рекомендация не выдаётся. velocity=0 →
    «протянет бесконечно» → фильтр пропускает (неходовой товар, излишек по времени).
    **Дедуп назначений**: `normalizeWh()` убирает суффикс «: Питание» (WB даёт по 2 записи
    на склад — обычную и поставочную).
  - **UI** `StocksPage.jsx`: вкладка «🚚 Перевозки» с таблицей рекомендаций, шапкой про
    «через API недоступно — оформляйте в ЛК» + ссылкой.
  - Сверка (cabinet #1): после фильтра — 0 рекомендаций (правильно: склады с избытком
    WB не обслуживает как источники перевозки, а на 4 складах-источниках остатки истощены).
- ✅ **2. Сортировка колонок во всех таблицах /stocks.** Хук `useSort(key,dir)` +
  компонент `SortTh` (кликабельные `<th>` со стрелками ▲▼↕). Применён в 4 таблицах:
  Склады, Индексы OOS, Финансы, Перевозки/Эффективность. Дефолты: Склады — Полный ↓,
  OOS — Дней до OOS ↑ (критичные сверху), Финансы — Σ себест. ↓, Перевозки — Дней до OOS ↑.
  `OOS_ORDER` продублирован локально в клиенте (в route.js он серверный). `FinancesTable`:
  итоги в `<tfoot>` считаются от исходных rows (не зависят от сортировки). `ReallocTable`:
  `useSort` вызывается ДО раннего return (урок D7 — Rules of Hooks).
  Бэкап: `StocksPage.jsx.20260718_182810.bak`.
- ✅ **3. Вкладка «Эффективность складов» (вместо «Перевозки»).** Brainstorm с хозяином:
  метрики = оборачиваемость + локальность (по кластеру). Цель — понять, какие склады
  генерят выручку и где товар работает, чтобы грузить именно их.
  - **Миграция 026** `026_warehouse_efficiency.sql`: колонка `region` в `shared.wb_warehouses`
    + `shared.region_to_cluster` (11 строк: 8 ФО РФ → 7 укрупнённых кластеров
    [ЮФО+СКФО → «Южный и СКФО», СибФО+ДФО → «ДВ и Сибирский»] + 3 страны СНГ).
    ⚠️ **Терминологическая грабля:** WB использует ДВЕ разные группировки: `regionName`
    склада (7 укрупнённых) ≠ `okrug_name` покупателя в wb_sales (8 раздельных ФО).
    Карта `region_to_cluster` их согласует. DROP NOT NULL на is_active/is_transit_active
    (stocks-report их не отдаёт, NOT NULL блокил upsert).
  - **API** `buildWarehouseEfficiency(vel)` в `stocks/route.js`: для каждого склада —
    остаток (шт+₽), продажи (шт+₽ за период), локальность (cluster покупателя = cluster
    склада через region_to_cluster), оборачиваемость (остаток / продажи-в-день).
    **LATERAL-мэтчинг имён** спасает 18% выручки: wb_sales.warehouse_name часто РАСХОДИТСЯ
    с wb_warehouses.name («Самара (Новосемейкино)» vs «Новосемейкино», «СПБ Шушары» vs
    «Склад СПБ Шушары Московское»). Точный JOIN терял ~18%, LATERAL (точное → подстрока
    с LIMIT 1, приоритет точного) поднял покрытие до 99%. Агрегаты byCluster:
    Σ остатков/продаж, средние оборачиваемость и локальность.
  - **UI** `EfficiencyView` + `ClusterKpi` + `EfficiencyTable`: KPI-плитки топ-4 кластеров,
    таблица складов (9 колонок с сортировкой), сворачиваемый блок «Рекомендации к
    перемещению» (старый `ReallocTable` с пропом `embedded`).
  - Сверка (cabinet #1, vel=14): 8 кластеров, 40 складов. Центральный лидер (170 874 ₽,
    48.7%), Невинномысск — 100% локальность, Самара/СПБ Шушары распроданы (кандидаты на
    поставку). 99% выручки классифицировано.
- ✅ **Сопутствующие фиксы давних багов** (вскрылись при сверке realloc — страница /stocks
  была сломана в проде со времени миграции SQLite→PG):
  - `current_date - ?` → `current_date - ?::int` (node-pg биндит параметр как text, PG не
    имеет оператора `date - text`) — 3 места в route.js.
  - `SELECT w.warehouse` → `SELECT s.warehouse` в `byWarehouseWB` (LATERAL `w` не возвращает
    warehouse).
  - `SUM(... MAX(p.price) ...)` → вынос MAX в подзапрос в `byWarehouseOzon` (nested aggregate
    запрещён в PG).

**Состояние:**
- `saas.service` — ✅ боевой (next start :3200, ребилд 2026-07-18 ~20:30 и 2026-07-19 ~00:15).
- Таймеры: `saas-references.timer` (weekly Mon 06:00) — ✅ enabled, проверен ручным запуском.
  Остальные таймеры (saas-worker 4×/день, saas-stocks 1×/день, saas-backfill) — боевые.
- `cabinet #1` — ✅ боевой. Остальные активные (#1008 и др.) — **боевые клиентов, не трогать**.
- Закоммичено (см. git log). Не закоммичено: НДС-работа (урок D14, не моя — перенос с прошлых
  сессий, ждёт хозяина).
- Бэкапы: `/opt/agentsDB/backups/{db_pg.py,wb_stocks.py,orchestrator.py,stocks.route.js,
  StocksPage.jsx,run_saas_collect.sh}.20260718_18*.bak` + `AGENTS.md.20260719_001233.bak`.

**Дальше:**
- (Опц.) **Ужесточить оборачиваемость** когда накопится история снимков (сейчас 3 шт —
  аппроксимация days_to_oos, не строгая). Через 2-3 недели регулярного сбора можно сделать
  оборачиваемость периода.
- (Опц.) **Расширить `region_to_cluster`** под новые субъекты/страны (если появятся продажи
  в неподсчитанном регионе — упадёт в «Прочее», карта расширяема INSERT).
- (Перенос) Валидация Ozon Api-Key в /settings (урок D12).
- (Перенос) `lib/theme.js` — мёртвый код, можно удалить.
- НДС-работа (урок D14) не закоммичена — хозяин/другой агент должен закоммитить отдельно.

---

## 📍 Точка останова (2026-07-18 — мультисвязка артикулов + Отгрузки + Склады/индексы + фикс WB-сборщика)

**Сделано в сессии (4 доработки, все на боевой, сверены на cabinet #1):**

- ✅ **1. Мультисвязка артикулов на странице «Остатки склад/ФФ».** Раньше 1 позиция склада
  = 1 артикул МП (хранение прямо в 5 колонках `ff_inventory`). Теперь — таблица-связка
  `tenant.ff_inventory_skus` (миграция **023**): одна позиция ↔ много артикулов с разных МП
  (WB nm_id + Ozon product_id + дубли карточек). Primary (имя/фото строки) = первый по
  `created_at`. Контракт 2026-07-16 сохранён: `cost_overrides` НЕ трогается (привязка =
  только имя/фото для склада).
  - **Баг идемпотентности найден и починен в той же сессии:** обычный UNIQUE-индекс не
    ловит дубликаты, когда одна из колонок NULL (в PG `NULL != NULL`) — тот же WB-артикул
    можно было привязать много раз. Заменён на **два partial unique indexes** по платформе
    (`uq_ff_inventory_skus_wb` WHERE platform='wb', `_ozon` WHERE platform='ozon`).
    `ON CONFLICT DO NOTHING` (без указания колонок) корректно срабатывает по подходящему
    индексу. Бэкпорт: существующие привязки перенесены в новую таблицу.
  - Кнопка 📦 в строке /inventory → открывает новую форму отгрузки (см. п.2) с
    предзаполненной строкой.
  - UI: список бейджей в колонке «Артикул МП» (метка «осн.» для primary, ✕ отвязать
    каждый отдельно), модалка «+ ещё артикул».

- ✅ **2. Новая страница «Отгрузки» (`/shipments`).** Отгрузка = документ (№ поставки +
  дата + склад назначения + платформа) с составом из многих товаров. Миграция **024**:
  таблицы `tenant.ff_shipment_docs` (шапка) + `tenant.ff_shipment_lines` (строки). Старая
  `ff_shipments` (плоская, 1 строка = 1 товар) НЕ дропается — остаётся архивом; бэкпорт
  идемпотентен. Склад назначения = TEXT + datalist из собранных данных WB/Ozon
  (`SELECT DISTINCT warehouse`), без справочника.
  - API `/api/cabinets/[id]/shipments`: GET (документы с развёрнутыми `lines[]`) + POST
    `create`/`delete`. **Атомарно в одной транзакции `withTenant`**: списание остатков +
    INSERT doc + INSERT lines; при нехватке на любой строке — весь документ откатывается
    (проверено: `UPDATE … WHERE qty >= $1 RETURNING` → 0 строк → throw → ROLLBACK).
  - UI: таблица документов с раскрываемым составом, форма с многострочным составом
    («+ добавить товар», выбор из остатков с qty>0), предзаполнение из строки /inventory.
    `ShipmentFormModal` переиспользуется с обеих страниц.
  - История отгрузок переехала с /inventory на /shipments (на /inventory — ссылка
    «📋 Все отгрузки»).
  - Пункт меню «Отгрузки» в группе «Товары» (`layout.js`).

- ✅ **3. Страница «Склады и индексы» (`/stocks`) — реализация с нуля** (была заглушкой
  10 строк). 4 вкладки:
    • **Склады** — распределение остатков по складам WB/Ozon (%, стоимость, цветной бар).
    • **Индексы OOS** — дни до out-of-stock, оборачиваемость, статус
      (🔴out/🟠критично/🟡мало/🟢ок/⚪нет продаж).
    • **Динамика** — линейный график (recharts), 2 линии WB/Ozon.
    • **Финансы** — себест./реализация/маржа по складам.
  - Окно velocity (7/14/30/60 дней) выбирается на странице. Формула:
    `velocity = SUM(orders за N дней) / GREATEST(число дней с продажами, 1)` (устойчиво
    к провалам; NULL-заказы = 0). `days_to_oos = qty_full / velocity`.
  - `dead_capital` = Σ себест. товаров без продаж (KPI с подсветкой).
  - WB-динамика скрыта, если истории <7 дат (`wbTooShort=true`, предупреждение в UI).

- ✅ **4. Фикс WB-сборщика `wb_stocks.py` — миграция на новый endpoint.** Старый
  `GET /api/v1/supplier/stocks` отключён WB (429 + "deprecated", release-notes #494/#431).
  Срез WB в БД замёрз на 2026-07-15. Новый: `POST /api/analytics/v1/stocks-report/
  wb-warehouses` на хосте `seller-analytics-api.wildberries.ru`, body
  `{"isSupplyWarehouse":true,"isWBWarehouse":true}`. ⚠️ НЕ отдаёт `quantityFull` →
  считаем `quantity + inWayToClient + inWayFromClient`. Сверка: записано 150 строк,
  формула верна, «в пути» теперь наполняется реальными значениями (старый endpoint в
  последние месяцы отдавал `inWay*=0`). Gotcha #11 в AGENTS.md обновлена.

- ✅ **4 записи в «Что нового»** (shared.changelog, от 18 июля):
  «Несколько артикулов на одной позиции склада» (improvement ⚡),
  «Новая страница Отгрузки» (feature ✨),
  «Новая страница Склады и индексы» (feature ✨),
  «Обновлён сборщик остатков WB» (fix 🔧).

**Состояние:**
- `saas.service` — ✅ боевой (next start :3200, ребилд 2026-07-18).
- Воркеры/таймеры — ✅ боевые. `wb_stocks` мигрирован, при следующем `saas-stocks.timer`
  (завтра 08:00) запишется свежий снимок WB в боевом режиме.
- `cabinet #1` — ✅ боевой, все сверки прошли, тестовые данные откачены. Остальные активные
  кабинеты (#1008 и новые) — **боевые клиентов, не трогать**.

**Бэкапы этой сессии** — `/opt/agentsDB/backups/*20260718*`:
- `inventory.route.js`, `purchases.route.js`, `InventoryPage.jsx` (мультисвязка)
- `layout.js`, `InventoryPage.jsx` (Отгрузки)
- `stocks.page.js` (Склады/индексы)
- `wb_stocks.py`, `AGENTS.md` (фикс WB + точка останова)
Новые файлы (миграции 023/024, shipments/, stocks/ UI, ff_inventory_skus.sql) — бэкапов не
имеют (созданы в сессии).

**Что НЕ закоммичено** (всё в working tree, решает хозяин):
- **Сделано 4 доработки уже в коммите `bf4e5aa`** (мультисвязка, Отгрузки,
  Склады/индексы, фикс wb_stocks). Сверху — только 2 свежие записи changelog
  (Склады/индексы + фикс WB-сборщика; первые 2 записи были добавлены раньше)
  и эта правка точки остановы в AGENTS.md.

**Дальше (опц., не срочно):**
- Подождать ~4 дня накопления WB-истории (`saas-stocks` 1×/день) → график динамики WB на
  `/stocks` автоматически появится (правок кода не нужно).
- Расширить мультисвязку на автоматическое предложение артикулов (сейчас ввод руками).
- На странице «Отгрузки» — фильтр по дате/№ поставки/складу, пагинация (сейчас LIMIT 200).
- Ozon-аналог `ozon_stocks.py` формально не требовал миграции (endpoint жив), но при случае
  проверить, что Ozon тоже не в процессе депрекации.
- (Переносы) Валидация Ozon Api-Key в /settings (урок D12). `lib/theme.js` — мёртвый код.
  НДС-работа (урок D14) НЕ закоммичена (из предыдущих сессий).

---

## 📍 Точка останова (2026-07-17, вечер — кабинетные расходы WB)

**Сделано в сессии:**
- ✅ **Кабинетные расходы WB видны ежедневно + в «Сводке по прибыли»** (коммит `01451bd`).
  Раньше хранение/штрафы/подписки/продвижение WB не отражались нигде: raw-данные лежали
  в `wb_finance_report`, но таблица `wb_cabinet_costs` была пуста, а `/pnl` считал прибыль без них.
  - **Новый сборщик** `worker/collectors/wb_cabinet_costs.py` — чистый SQL-агрегатор
    `wb_finance_report → wb_cabinet_costs` по дням×типам (period=daily, заявка №28: дневной
    отчёт доступен на следующий день **без недельного лага**). Маппинг по
    `supplier_oper_name + bonus_type_name`: «Удержание» разделяется на
    `promotion/subscription/reviews/deduction_other` (gotcha #148 подтверждён боем —
    за 289 тыс. ₽ «удержаний» скрывались 4 разные услуги: Продвижение ~234к, Баллы за
    отзывы −43к (сторно-возврат), Подписка Джем 11к, утилизация 152₽). Возмещения и сторно
    отзывов — отдельные типы (`transport_compensation`, `pvz_compensation`, `reviews`).
    Идёт в `WB_COLLECTORS` после `wb_order_costs`. **2026-08-07:** до этой даты в
    `MAIN_COLLECTORS` (`run_saas_collect.sh`) его не было, поэтому регулярный прогон
    `saas-worker` его НЕ звал — данные появлялись только при онбординге/backfill и
    застывали (у кабинета 1 — на 26.07). Добавлен в `MAIN_COLLECTORS` после
    `wb_order_costs`, теперь идёт 4×/день. Напоминание: `/pnl` и `/overview` считают
    те же расходы напрямую из `finance_report`, поэтому пустая таблица искажала не
    прибыль, а секцию «Кабинетные расходы» на «Сводке» — она расходилась с «Прибылью».
  - **Починка бага карты таблиц** `lib/db.js`: добавлено `cabinet_costs → wb_cabinet_costs` /
    `ozon_cabinet_costs`. Без этого route `/cabinet-costs` SQL `FROM cabinet_costs` оставался
    голым именем (нет в карте `convertSql`) → молча падал в try/catch → WB-ветка всегда пуста.
  - **`/overview` фикс бага**: плитка «Хранение» читала `SUM(ABS(additional_payment))`, но WB
    кладёт суммы хранения в `storage_fee` → всегда 0. Заменено на `storage_fee`.
  - **`/pnl` расширение**: добавлены строки Продвижение WB / Подписки / Штрафы / Удержания
    прочие — вычитаются из чистой прибыли. «в т.ч. прочие доходы WB» (возмещения + сторно
    «Баллы за отзывы») — отдельная строка под чистой прибылью (приток, не входит в P&L-каскад).
    `grossProfit` не менялся (валовая маржа по SKU, без кабинетных расходов — контракт №27).
    Источник — прямо из `wb_finance_report`, по дате операции (при разбивке по неделям подписка
    попадает в неделю списания).
  - **Сверка (cabinet #1, 77 дней):** 8 типов расходов, все 8 совпали с raw до копейки
    (storage 15934, penalty 2880, promotion 234064, reviews −43515, subscription 11495,
    transport_compensation −22212, pvz_compensation −1525, deduction_other 152). netProfit
    упал с ~480к до **242к ₽** — реальная цифра с учётом всех списаний WB.
  - Бэкапы: `/opt/agentsDB/backups/{db.js,overview.route.js,orchestrator.py}.20260717_192101.bak`
    + `{pnl.route.js,PnlPage.jsx}.20260717_200008.bak`.
  - ⚠️ **Контракт №27 сохранён:** кабинетные расходы НЕ размазываются по марже SKU.
- ✅ **Граничный нюанс коммита:** `pnl/route.js` и `overview/route.js` содержат смесь моих
  правок кабинетных расходов и параллельной НДС-работы (урок D14, calcTotalTax/vat, см.
  предыдущую точку останова) в одних функциях — разделить нельзя. В коммите `01451bd` оба
  набора правок вместе. Остальная НДС-работа (detail/products-summary/rnp-summary/unit routes,
  fin-calendar, fin-dds, lib/tax.js) и untracked (support/whats-new/voice-expense/миграции 020-022)
  остались в working tree — не моя работа, не закоммичены.

**Состояние:**
- `saas.service` — ✅ боевой (next start :3200, ребилд 2026-07-17 ~20:00).
- Воркеры/таймеры — ✅ боевые. `wb_cabinet_costs` зарегистрирован, пойдёт в следующий прогон `saas-worker`.
- `cabinet #1` — ✅ боевой. Остальные активные кабинеты (#1008 и новые) — **боевые клиентов, не трогать**.

> ⚠️ **Кабинет для экспериментов = `cabinet #1` (ИП Матвеев, он же хозяин проекта).**
> Все тесты, пробы, отладочные правки и проверки — **только на #1**. Остальные активные
> кабинеты (`#1008` и любые новые) — **боевые кабинеты клиентов**, их не трогать:
> никаких пробных записей в `tenant.*`, отладочных прогонов воркера `--cabinet N`,
> ручных upsert/DELETE в их данных. Для проверки на живых данных клиента —
> запрашивать разрешение хозяина и всегда с бэкапом.

**Дальше:**
- (Опц.) **Расширить cabinet-costs на Ozon.** Сейчас в `/pnl` и `/cabinet-costs` Ozon-часть
  кабинетных расходов = 0 (источник `order_costs` их не даёт). Нужно найти Ozon API endpoint
  для подписок/штрафов и сделать сборщик → `ozon_cabinet_costs` (таблица и функция записи
  `upsert_cabinet_costs_many` для Ozon в `db_pg.py` уже готовы — проверить).
- (Опц.) **Premium Plus / кросс-докинг / недостача** — есть лейблы в `/cabinet-costs` LABELS,
  но эти источники НЕ приходят в `reportDetailByPeriod`. Нужен probe отдельного WB endpoint'а.
- (Перенос с 2026-07-16) Валидация Ozon Api-Key в /settings (урок D12).
- (Перенос с 2026-07-16) `lib/theme.js` — мёртвый код, можно удалить.
- НДС-работа (урок D14) не закоммичена — хозяин/другой агент должен закоммитить отдельно
  (detail/products-summary/rnp-summary/unit routes, fin-calendar, fin-dds, lib/tax.js).

---

## 📍 Точка останова (2026-07-17)

**Сделано в сессии:**
- ✅ **Юнит-экономика показывает только активные товары.** Раньше `/unit/all` собирал
  список из продаж/прайса (`wb_finance_report` ∪ `wb_prices`, Ozon — `orders` ∪
  `products`) — снятые с продаж товары мусорили в юнитке. Теперь статус `active|inactive`
  берётся из `tenant.item_status` (`statusMap()` из `lib/finItems.js`, fallback `"active"`)
  и фильтруется в `computeWB`/`computeOzon` (`app/api/cabinets/[id]/unit/all/route.js`).
  Query-парам `?includeInactive=1` возвращает прежнее поведение (для сверки/отладки).
  Бэкап: `unit_all.route.js.20260717_112406.bak`. Билд + рестарт `saas` сделаны.
  **Сверка (cabinet #1):** default → 81 item (17 WB + 64 Ozon, 0 inactive внутри ✅);
  `includeInactive=1` → 187 items (81 active + 106 inactive). Поведение клиентов с пустым
  `item_status` (напр. #1008) не изменилось — все активны по fallback.
- ✅ **В `computeWB` убрано требование `discount>0`** для товаров без продаж. Раньше
  новые модели с ценой, но без скидки (WB отдаёт `wb_prices.discount=0`) не попадали в
  юнитку. Теперь WB items 17 → **27** (+10 новых: экшн-камеры/видеорегистраторы nm_id
  1179xxxxxx–1181xxxxxx). ⚠️ Они пришли **без себестоимости** (`cost_overrides` пуст) →
  прибыль/маржа завышены. Чинится привязкой артикула на `/inventory`.
  Бэкап: `unit_all.route.js.20260717_113713.bak`. Билд + рестарт сделаны.
- ✅ **Памятка в AGENTS.md**: кабинет для экспериментов = `#1` (ИП Матвеев, хозяин).
  Остальные (#1008 и новые) — боевые клиентов, не трогать без разрешения. Вверху + внизу.
- ✅ **Корректный расчёт НДС + УСН (фикс 2026-07-17, урок D14).** Реформа УСН+НДС 2025:
  выручка WB/Ozon = сумма с НДС → НДС **выделяется** из цены (`vat/(100+vat)`, для 5%: ×5/105),
  УСН считается от выручки **без НДС** (ст. 248/346.15 НК РФ), profit вычитает И УСН, И НДС.
  Раньше `lib/tax.js` считал УСН от выручки с НДС, а НДС (`calcVatTax`) вообще не применялся
  в агрегатах → profit был завышен на сумму НДС (≈4.76% выручки при vat=5). Фикс:
  - **`lib/tax.js`** — `calcVatTax` = выделение; `calcUsnTax` автоматически вычитает НДС из
    базы (backward-compatible для vat=0); новый `describeCombinedTaxMode({wb,ozon})` для лейблов.
  - **6 роутов, 13 вызовов** (`overview`, `pnl`, `detail`, `rnp-summary`, `products-summary`,
    `unit`, `unit/all`) переведены с `calcUsnTax` → `calcTotalTax(...).total` (УСН+НДС).
  - **detail per-day** (стр. 286 WB, 529 Ozon) — добавлены дневные расходы (раньше `calcUsnTax`
    без 3-го аргумента → для УСН Д−Р налог от полной выручки).
  - **`/unit/all taxRates()`** — `vatRate = vat/(100+vat)` (раньше `vat/100` ломал дефолт `5/105`).
  - **P&L Ozon `netProfit`** — теперь вычитает налог (раньше брался из БД без вычета).
  - **UI-лейблы** (6 мест): захардкоженные «УСН 6%»/«НДС 5%» → динамические `taxLabel`
    (Overview/P&L/Detail) или нейтральный текст «по режиму магазина» (Calendar/DDS).
  Бэкапы: `/opt/agentsDB/backups/vat_fix_20260717_192159/` (11 файлов). Билд + рестарт `saas`.
  **Сверка (cabinet #1, WB+Ozon, 30д):** выручка ₽1.595M → НДС ₽75 956, УСН ₽91 147 (был ₽95 704
  от выручки с НДС), налог всего ₽167 103 (был ₽95 704), profit уменьшился на ₽75 956 (НДС).
  Скрининги AGENTS.md (D14) чисты. Не закоммичено.

---

## 📍 Точка останова (2026-07-16, вечер)

**Сделано в сессии:**
- ✅ **Переключатель тёмной/светлой темы** (next-themes + CSS-переменные). Кнопка 🌙/☀️ в
  topbar кабинета (`app/ThemeToggle.jsx`), дефолт — тёмная, выбор в localStorage.
  `next-themes@0.4.6` добавлен в deps. Билд + рестарт `saas` сделаны (HTTP 200 на :3200).
- ✅ **Палитра консолидирована** — единый источник `lib/palette.js` (`C` = строки
  `var(--token)`, helper `soft(token,pct)` для alpha через `color-mix`). Раньше ~30
  страниц дублировали `const C = {...}`. Все импортируют `{ C, soft }`.
- ✅ **79 alpha-сайтов** `${C.x}NN` → `${soft("x",N)}` (бордеры/подсветки) во всех
  клиентских страницах. Токены двух тем — в `globals.css` (`:root,.dark{}` и `.light{}`,
  включая алиасы `--surface`/`--ink`/`--line`/`--pos`/`--neg`/`--warn`/`--pink`).
- ✅ **Hardcoded hex** в `app/page.js`, `app/cabinets/page.js` → `var(...)`.
- ✅ **24 inline `colorScheme:"dark"`** удалены — нативные виджеты управляются корневым
  `color-scheme` в `globals.css` (наследуется в обе темы). Добавлен `suppressHydrationWarning`
  на `<html>`, `ThemeProvider` оборачивает children.
- ✅ **Все скрининги AGENTS.md** чисты (D3/D5/D11 + новый D13-чек `var(--x)NN`).

**Дальше:**
- **Не закоммичено.** В `git status`: ~34 изменённых файла + 3 новых (`ThemeProvider.jsx`,
  `ThemeToggle.jsx`, `lib/palette.js`). Коммитить или нет — решает хозяин.
- (Опц.) **Визуальная проверка светлой темы** на представительном: `/detail` (26 alpha-сайтов,
  самый тяжёлый), `/fin-calendar` (SVG-градиент `<stop stopColor="var(--accent)">` —
  единственное рисковое место для старых браузеров, в 2026 поддерживается). Если где-то
  контраст режет — точечная правка значений в `.light{}` блока globals.css.
- (Опц.) Кнопку темы можно добавить на landing/login/register/settings-хаб (сейчас только
  в topbar кабинета; тема всё равно применяется глобально через класс на `<html>`).
- (Перенос с 2026-07-15, всё ещё актуально) Валидация Ozon Api-Key в /settings (урок D12).
- `lib/theme.js` — мёртвый код (тёмно-бирюзовая палитра, никем не импортируется). Можно
  удалить отдельной задачей, если хочется чистоты.

**Состояние:**
- `saas.service` — ✅ боевой (next start :3200, ребилд 2026-07-16 ~19:05).
- Воркеры/таймеры — ✅ боевые, правок `.py` не было.
- `cabinet #1` — ✅ боевой. `cabinet #1008` — ✅ активен. `cabinet #1001/#1002` — provisioning.

> ⚠️ **Кабинет для экспериментов = `cabinet #1` (ИП Матвеев, он же хозяин проекта).**
> Все тесты, пробы, отладочные правки и проверки — **только на #1**. Остальные активные
> кабинеты (`#1008` и любые новые) — **боевые кабинеты клиентов**, их не трогать:
> никаких пробных записей в `tenant.*`, отладочных прогонов воркера `--cabinet N`,
> ручных upsert/DELETE в их данных. Для проверки на живых данных клиента —
> запрашивать разрешение хозяина и всегда с бэкапом.
- Бэкапы этой сессии — `/opt/agentsDB/backups/*20260716_18*` (29 пейдж-файлов) +
  `*colorscheme*20260716_1902*` (11) + `globals.css.20260716_185637.bak` + `*layout.js.20260716_190312.bak`.
