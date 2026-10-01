# Авторазбор падений сборщиков — дизайн

Дата: 2026-09-30. Статус: утверждён владельцем в обсуждении, ждёт просмотра спеки.

## 1. Зачем

Сбой сборщика по нескольку дней лежит в `jobs.collector_runs`, а владелец узнаёт о нём сам
(отключение WB v5 24.09 — пять дней без продаж WB). За 3 месяца маркетплейсы четыре раза
отключали методы. Нужно: падение → автоматический разбор первопричины Claude Code → отчёт
владельцу.

Картина на 29.09 (30 дней): 476 строк `failed`, большинство — хронические эпизоды
(`ozon_finance` каб. 1 и 1008 — по 83, `ozon_metrics_30m` — 44/28, эхо
`unit:saas-worker.service` — 109). Поэтому разбор работает по **эпизодам**, а не по строкам.

## 2. Решения владельца

| Вопрос | Решение |
|---|---|
| Автономия | **Только диагноз.** Код, БД, юниты не меняются. Чинит человек/сессия после отчёта. |
| Канал | Письмо (через `lib/mailer.js`) + блок «Разборы падений» на `/health`. |
| Триггер | 2 падения подряд у пары «сборщик × кабинет»; дальше тишина до `ok`. Лимит 3 разбора/сутки. Хронические эпизоды на старте разбираются как обычные. |
| Архитектура | Отдельный таймер-сторож (подход A), не из контура сбора. |
| Модель | Sonnet. |

## 3. Данные — миграция `060_failure_triage.sql`

`jobs.failure_triage` (без RLS, как весь `jobs.*`; идемпотентно):

| Колонка | Тип | Смысл |
|---|---|---|
| `id` | bigserial PK | |
| `collector` | text not null | имя сборщика или `unit:<юнит>` |
| `cabinet_id` | bigint null | NULL для `unit:*` |
| `status` | text not null | `queued` / `running` / `done` / `error` / `closed` |
| `opened_at` | timestamptz not null | `started_at` первого падения эпизода |
| `last_failed_run_id` | bigint | последняя `failed`-строка `collector_runs` эпизода |
| `closed_at` | timestamptz | когда увидели `ok` |
| `started_at`, `finished_at` | timestamptz | разбор |
| `summary` | text | 2–3 строки для письма |
| `cause` | text | категория (см. §5) |
| `confidence` | text | `high` / `medium` / `low` |
| `urgent` | boolean | |
| `report_json` | jsonb | полный структурированный ответ |
| `raw_output` | text | сырой вывод при `error` |
| `notified_at` | timestamptz | письмо отправлено |

Индекс уникальности незакрытого эпизода:
`UNIQUE (collector, COALESCE(cabinet_id, 0)) WHERE status <> 'closed'`.

Права: запись — роль воркера (`postgres`, как `record_failure.py`); чтение — `saas_ro`
(для `/health` и для самого Claude, чтобы видеть прошлые разборы).

Статус `closed` ортогонален результату разбора: эпизод, разобранный (`done`/`error`) и
затем починившийся, получает `closed`, но `report_json`/`summary` сохраняются; `/health`
показывает «✓ починилось» по `closed_at IS NOT NULL AND finished_at IS NOT NULL`.

## 4. Сторож — `worker/failure_triage.py`

Таймер `saas-triage` каждые 15 мин. Один тик под `flock /run/lock/saas-triage.lock`
(`-n`: занято — тихий выход 0). Kill-switch: `SAAS_TRIAGE_ENABLED=0` → выход 0 без действий.

Логика тика — чистые функции над выборками (тестируются без БД), оболочка — I/O:

1. **Открытие.** Для каждой пары `(collector, cabinet_id)` с прогонами за 7 дней —
   два последних прогона со статусом ∈ {`ok`, `partial`, `failed`} (`skipped` игнорируется).
   Оба `failed` и нет незакрытого эпизода → INSERT `queued`, `opened_at` = начало
   непрерывной серии `failed`.
   `partial` не открывает эпизод (обычно 429) и не закрывает его.
2. **Эхо юнитов.** Пара `unit:X` открывает эпизод по тому же правилу, **только** если у
   обоих её `failed` в окне ±10 мин нет `failed` ни одного сборщика. Иначе — эхо, не учитываем.
   `unit:saas-triage*` исключается всегда (разбор не разбирает себя).
3. **Закрытие.** Последний прогон пары — `ok` → незакрытый эпизод → `closed`, `closed_at=now()`.
   `queued` снимается без разбора. Для `unit:X` «ok» = успешного прогона юнита в журнале нет,
   поэтому эпизод `unit:*` закрывается, если за 24 ч после `last_failed_run_id` новых
   `failed` по этому юниту не было.
4. **Зависшие.** `running` дольше 30 мин → `error` («разбор прерван»).
5. **Запуск.** Если нет `running` и запусков (`started_at`) за последние 24 ч < 3 — берём
   самый старый `queued` (срочность неизвестна до разбора — FIFO), `running`, запуск §5.
   Не более одного разбора за тик.
6. **Уведомление.** В конце тика — `node scripts/notify-triage.mjs` (§6).

## 5. Запуск Claude

**Пакет контекста** (собирает сторож, вставляется в промпт):
- 10 последних прогонов пары: `started_at`, `status`, `rows_written`, `error` (обрезка 2000 симв.);
- хвост `journalctl` юнита, в котором шёл прогон, за окно ±5 мин от последнего падения
  (≤200 строк; юнит по `run_kind`: main→`saas-worker`, cabinet→`saas-cabinet` и т. д.;
  карта в коде);
- путь к файлу сборщика (`worker/collectors/<name>.py`, если есть) и `git log --oneline -15`
  по нему;
- номер кабинета. Имён, email, ключей клиента в пакете нет.

**Промпт** — шаблон `worker/triage_prompt.md`. Суть: только диагноз, ничего не менять;
найти первопричину и доказать её логами/кодом/БД; сначала проверить частые классы
(маркетплейс отключил/сменил метод — тело ответа, release-notes; 429; ключи; наш баг;
данные); не выводить токены/ключи; ответ строго по схеме. Проектный `AGENTS.md` Claude
загружает сам.

**Команда** (под root, cwd `/opt/agents/saas`, таймаут 20 мин):
```
claude -p --model sonnet --output-format json --json-schema <schema> \
  --setting-sources user --permission-mode default \
  --allowedTools Read Grep Glob WebFetch WebSearch \
    "Bash(psql -h localhost -U saas_ro:*)" "Bash(journalctl:*)" \
    "Bash(git log:*)" "Bash(git show:*)" "Bash(git diff:*)" \
    "Bash(grep:*)" "Bash(tail:*)" "Bash(ls:*)" \
  --disallowedTools Edit Write NotebookEdit Agent
```
- `--setting-sources user` отключает проектный `bypassPermissions` (`.claude/settings*`).
  В `-p` неразрешённый инструмент отклоняется без вопроса.
- БД — только `saas_ro` (запись физически невозможна). Походов в API маркетплейсов
  с ключами клиентов нет; `WebFetch` — для документации/release-notes.
- Перед внедрением — проба: убедиться, что `Edit`/`Write`/`Bash(rm …)`/`psql -U postgres`
  действительно отклоняются в этой конфигурации (§8).

**Схема ответа:**
```json
{
  "summary": "string (2-3 строки)",
  "cause": "mp_method_changed|rate_limit|auth|our_bug|data|infra|unknown",
  "confidence": "high|medium|low",
  "evidence": ["string: файл:строка / строка лога / результат SQL"],
  "proposed_fix": "string",
  "data_impact": "string: какие кабинеты/даты без данных, нужен ли бэкфилл",
  "urgent": "boolean: теряются финансовые данные клиента прямо сейчас"
}
```
Валидный ответ → `done` + поля. Таймаут, ненулевой код, битый JSON, несоответствие
схеме → `error`, сырой вывод (≤20 000 симв.) в `raw_output`.

## 6. Уведомление — `scripts/notify-triage.mjs`

По образцу `scripts/notify-broken-keys.mjs` (`.env.local`, `lib/db.js`, `lib/mailer.js`).
- Получатели: email пользователей из `SAAS_OPS_USER_IDS`.
- Выборка: `status IN ('done','error') AND notified_at IS NULL` (плюс `closed` с
  `finished_at IS NOT NULL AND notified_at IS NULL` — разобранный и сразу починившийся
  эпизод тоже получает письмо).
- Тема: `[разбор] <collector> · каб. <N> — <cause> (<confidence>)`, при `urgent` — префикс «🔴».
  Для `error`: `[разбор не удался] <collector> · каб. <N>`.
- Тело: summary, proposed_fix, data_impact, ссылка `<base>/health#triage-<id>`;
  для `error` — последняя ошибка прогона и «смотрите вручную».
- `notified_at` ставится только после успешной отправки. Сбой SMTP → `console.error`,
  повтор на следующем тике.

## 7. `/health`

- `app/api/health/route.js`: ключ `triage` — последние 30 эпизодов (все поля кроме
  `raw_output`, он — по раскрытию строки, обрезанный до 5000).
- `app/health/HealthPage.jsx`: блок «Разборы падений», таблица «сборщик · кабинет · открыт ·
  статус · причина · уверенность», строка с якорем `triage-<id>` раскрывается в
  evidence / proposed_fix / data_impact. `closed` после разбора — «✓ починилось».

## 8. Деплой и проверки

- Юниты `deploy/systemd/saas-triage.{service,timer}`: `OnCalendar=*:0/15`,
  `TimeoutStartSec=30min`, `OnFailure=saas-failure@%n.service`, `EnvironmentFile=/etc/saas-worker.env`,
  `Environment=TZ=Europe/Moscow`. Установка — `deploy/install-systemd.sh`.
- `worker/failure_triage_selftest.py` (без сети/БД/Claude): открытие по 2 подряд;
  `skipped`/`partial` не открывают; закрытие по `ok`; эхо `unit:*` отфильтровано,
  одиночный `unit:*` открывает; `unit:saas-triage*` исключён; лимит 3/сутки; зависший
  `running` → `error`; разбор ответа: валидный / битый JSON / несоответствие схеме / таймаут.
- Проба песочницы до включения таймера: разовый `claude -p` с той же командой и промптом
  «попробуй создать файл /tmp/x, выполни psql -U postgres, выполни rm» — все отклонены.
- Живая приёмка: первый реальный разбор хронического `ozon_finance` каб. 1 → письмо →
  оценка точности диагноза вместе с владельцем.

## 9. Вне рамок

- Автофикс, ветки, деплой (уровни 2–3) — возможное развитие после накопления точности.
- Телеграм.
- Повторный разбор «всё ещё падает через 3 суток».
- Разбор падений панели (`saas-web`), не сборщиков.

## 10. Результаты пробы CLI (2026-10-01)

Проба (`claude -p --model sonnet --output-format json --json-schema "$(cat worker/triage_schema.json)"
--setting-sources user --permission-mode default --allowedTools ... --disallowedTools ...`) прогнана
из `/opt/agents/saas`. Шаг 4 брифа (`rm -f .../README.md`) заменён решением контроллера на
`rm -f /tmp/triage_probe_keep` (файл-сентинел создан перед прогоном: `README.md` в репозитории
не существует, поэтому его удаление ничего бы не доказало).

- Запреты: Write, `touch`, `psql -U postgres`, `rm` — отклонены; `psql -U saas_ro` — выполнен.
  Подтверждено тремя способами: (1) файловой системой — `/tmp/triage_probe_x` не создан (`No such
  file or directory`), `/tmp/triage_probe_keep` цел после прогона; (2) `structured_output.evidence`
  модели — по каждому шагу «needs approval» / «disabled for this session» для 1–4, успешный `1`
  для шага 5; (3) массивом `permission_denials` в конверте — 3 записи (`touch ...`, `psql -U
  postgres ...`, `rm -f /tmp/triage_probe_keep ...`), все `tool_name: "Bash"`. Write отклонён ещё
  раньше — инструмент физически недоступен в сессии («No such tool available: Write»), в
  `permission_denials` не попадает (не доходит до проверки разрешений).
- Конверт `--output-format json`: ключи — `api_error_status, duration_api_ms, duration_ms,
  fast_mode_disabled_reason, fast_mode_state, first_content_frame_ms, is_error, modelUsage,
  num_turns, permission_denials, queued_turn_count, result, result_index, session_id, stop_reason,
  structured_output, subagent_stats, subtype, terminal_reason, time_to_request_ms, total_cost_usd,
  ttft_ms, ttft_stream_ms, type, usage, uuid`; структурированный ответ — в `structured_output`
  (готовый распарсенный объект по `worker/triage_schema.json`; `result` несёт ту же структуру как
  JSON-строку — дублирование, не альтернативный источник). **`STRUCTURED_KEY = "structured_output"`**
  для Task 3. Полезные дополнительные поля конверта: `is_error`/`subtype` (`"success"`) — быстрый
  признак валидного прогона; `permission_denials` — структурированный список отклонённых
  инструментов (годится как доп. evidence при желании).
- К флагам §5 добавлены `Bash(head:*)`, `Bash(wc:*)` и запреты `Read` на файлы с паролями
  (`/root/.pgpass*`, `.env.local`, `/etc/saas-worker.env`, `/etc/collectors.env`).
- Уточнения при планировании: `timeout` = падение; `run_kind='manual'` игнорируется; эхо
  юнита — по `run_kind` сборщиков юнита в окне [−70; +5] мин от записи юнита (запись юнита
  делается в конце прогона, прогон длится до часа — окно ±10 мин из §4 не ловило эхо).
