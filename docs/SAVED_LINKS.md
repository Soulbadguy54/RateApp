# Сохранённые ссылки — единая таблица и алгоритм

**Статус:** backend в `develop`/staging; UI и реальная ChatGPT Scheduled Task для пользовательских ссылок ещё не подключены. Никакого кеширования результата анализа URL между пользователями.

## Схема

Только `saved_links`:

- `id` — PK.
- `user_id` — внешний ключ пользователя; `url` и `url_hash`, уникальность `(user_id,url_hash)`.
- `created_at` — дата сохранения для порядка выдачи; `updated_at`/`finished_at` для интерфейса.
- `gpt_names TEXT[] NULL` — массив названий, возвращённых GPT, независимо от того, нашлись ли карточки в каталоге. **NULL — не обработано; [] — обработано, ноль названий.**
- `game_ids INTEGER[] NOT NULL DEFAULT '{}'` — массив **внутренних** `games.id`. По ним читаем игровые карточки из существующего каталога.
- `status` (pending/processing/ready/failed), `error` и технические поля `lease_token`, `lease_until`, `attempts`, `resolve_cursor`, `match_failures` — минимальная защита от перекрывающихся почасовых запусков и продолжение длинных статей. **Не отдельная очередь.**

Удалена таблица `saved_link_jobs`; `saved_link_games` уже была удалена предшествующей миграцией. Поле `gpt_names` хранится только для этой конкретной пользовательской ссылки и удаляется вместе с ней. На один URL у двух пользователей могут существовать две независимые строки — ни GPT-названиями, ни результатами URL они не обмениваются.

## API (текущая сессия)

- `POST /api/saved-links` — сохранить URL (не скачивает содержимое), уникально внутри пользователя. Лимит 100 ссылок на пользователя и 15 новых/24 ч.
- `GET /api/saved-links?limit=50&before=<id>` — только ссылки авторизованного пользователя, самые свежие первыми, `gptNames`/`gptNames`/`gameNames`, `gameIds`, статус, карточки игр. Для всех ID текущей страницы — **один запрос** к `games` без IGDB.
- `GET /api/saved-links/{id}`, `DELETE /api/saved-links/{id}` — собственная ссылка. Удаление стирает ссылку, имена и ID; отложенный ответ GPT по её ID отвергается.
- `POST /api/saved-links/{id}/retry` — повтор после ошибки.
- `POST /api/saved-links/{id}/refresh` — статья могла измениться: удалить старые `gpt_names`/`game_ids`, сбросить токены и статус, начать распознавание заново. Это **явное** действие пользователя, не автоматическое обновление веб-содержимого.

## ChatGPT/Gateway

Рабочие команды должны запускаться **через** `/usr/local/bin/rateapp-api-entrypoint` внутри нужного Docker API контейнера (там подставляется DB URL). У каждой команды обязательно `--expect-environment staging` или `production`.

1. **Взять одну ссылку для GPT:**
   ```bash
   docker exec rateapp-stage-api /usr/local/bin/rateapp-api-entrypoint python -m api.saved_links_worker claim --limit 1 --expect-environment staging
   ```
   Эквивалент SQL: `SELECT ... FROM saved_links WHERE gpt_names IS NULL AND status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`. Кроме pending, берётся истёкшая аренда processing, не более трёх попыток. Выдаётся URL, ID и временный lease token.
2. **GPT распознаёт настоящие названия из доступного содержимого**, не рекламные блоки и не выдуманные игры. Запись через stdin:
   ```bash
   docker exec -i rateapp-stage-api /usr/local/bin/rateapp-api-entrypoint python -m api.saved_links_worker submit --expect-environment staging
   ```
   JSON: `{"id":1,"leaseToken":"...","games":["Hades","Outer Wilds"]}` либо `{"id":1,"leaseToken":"...","error":"Контент недоступен"}`. До 80 названий; пустой массив допустим и **считается завершённой работой GPT**.
3. **Обработать все названия одной ссылки** в локальном каталоге (алиасы, `pg_trgm`, популярность), затем в IGDB через общий поиск по первому результату:
   ```bash
   docker exec rateapp-stage-api /usr/local/bin/rateapp-api-entrypoint python -m api.saved_links_worker resolve --limit 1 --expect-environment staging
   ```
   До 12 имён или 120 секунд за запуск, чтобы не перегружать VPS/IGDB; курсор и подтверждённые `games.id` сохраняются **прямо в saved_links**. На следующем запуске продолжает старую статью. `Priority.BACKGROUND` и кеширование только выбранной IGDB карточки в общем игровом каталоге. Полное отсутствие совпадения не создаёт ложный ID. Максимум три попытки при временных сбоях IGDB на имя.

**Изоляция:** staging — контейнер `rateapp-stage-api`, база `rateapp_stage`; production — `rateapp-api-1`, база `rateapp`. Реальные ChatGPT задачи для них ещё не запускали. Тестовое Gateway расписание из PR #102 использует `--limit 1` и ожидает подтверждения пользователя; его статус проверять отдельно. Production включать только после явной приёмки.

## Миграция `20261029_07`

Перед внедрением на staging штатный деплой сохраняет резервную копию БД. Миграция добавляет `gpt_names` и технические поля в `saved_links`, переносит прогресс, имена и ID из прежней `saved_link_jobs`, **затем** удаляет её. Частичный индекс по `(created_at,id)` только для необработанных pending сокращает поиск очереди. Существующие `saved_links.game_ids`, GIN индекс и PostgreSQL триггер удаления `games.id` сохраняются.

**Ограничение исторических данных:** из уже завершённых ссылок в старой реализации сырые GPT-названия были стёрты. Миграция не придумывает их заново: `gpt_names=NULL` при `status=ready` сохраняет прежние ID, такие строки не будут случайно выбраны для GPT; пользователь может нажать refresh.

После деплоя проверить revision `20261029_07`, отсутствие `saved_link_jobs`, `gpt_names`, пустую очередь, затем тест `claim→submit→resolve→refresh→delete`. Production не трогать. Перед ним обязательно полный CI.
