# Saved Links: current backend contract (develop / staging)

**Scope:** persistent user-owned URL + resolved game IDs; transient ChatGPT titles and per-link queue. Backend-only. No saved-links UI, HTTP scraper or video/transcript extractor, production ingestion task or live ChatGPT queue currently connected.

## Data and ownership

- `saved_links` is durable: `id`, `user_id` (FK to `users` with cascade), canonical `url`, `url_hash` (unique per owner), optional `title`, `status` (pending/processing/ready/failed), `game_ids INTEGER[]` (only **local** `games.id` values), error, created/updated/finished timestamps. Index `ix_saved_links_game_ids_gin` supports cleanup. Limit 100 stored links and 15 new links per rolling 24h per user; duplicate URL returns the existing record.
- `saved_link_jobs` is **disposable**: one row per in-progress link (`saved_link_id` unique FK ON DELETE CASCADE); phase, short-lived claim token/lease, source retry count, temporary `names TEXT[]` extracted by ChatGPT, temporary `resolved_ids INTEGER[]`, cursor, matching error counter. This table is the **only queue**; do not create another persistent queue or indefinitely retain raw article/video/caption content.
- **No `saved_link_games` table in the current schema.** Historical migrations `20261029_04`/`05` introduced it; `20261029_06` migrates non-null game associations into `saved_links.game_ids`, moves unresolved names to the transient job where needed, drops the old table. Existing saved URLs and confirmed associations must be preserved.
- No per-element PostgreSQL FK exists inside `INTEGER[]`. All appended IDs are looked up via `games.igdb_id` → `games.id` and validated before final save. PostgreSQL `AFTER DELETE ON games` trigger `trg_saved_links_game_deleted` removes the deleted internal ID with `array_remove`. The game remains untouched otherwise; no new game-delete API is added.
- User deletion of `saved_links` removes its queue row immediately (ORM cascade and database FK cascade). A later ChatGPT `submit` using the deleted link ID/token is rejected. Work already in-flight checks that its job still exists and cannot recreate a deleted link.

## Authenticated API

- `POST /api/saved-links` body `{"url":"https://example.org/article","title":"Optional"}`: canonical URL, no fetching, store link, create one pending transient job.
- `GET /api/saved-links?limit=50&before=<id>` and `GET /api/saved-links/{id}`: only this user's links, `gameIds`, `gamesCount`, and hydrated game summaries (`id`=internal ID, `igdbId`, `title`, `coverUrl`). List hydration uses **one** PostgreSQL query for all needed `games.id` in the page; no N+1 or IGDB calls while opening the registry.
- `DELETE /api/saved-links/{id}`: delete link + queue; does not delete catalog games, user library, reviews or collections.
- `POST /api/saved-links/{id}/retry`: only when status `failed` and no active job; enqueues one new transient job.
- Previously implemented `PUT /api/saved-links/{id}/games/{entry_id}` no longer applies: title/ID pairs and permanent extracted-title IDs are intentionally removed. Manual correction UI, if needed later, should operate on the final game ID array, not resurrect an old join table.

## ChatGPT and matching: one link per cycle

All commands run **only inside the intended API container through `/usr/local/bin/rateapp-api-entrypoint`**, which supplies the database URL from its mounted secret. A plain `docker exec ... python` does **not** receive DB access. Each command demands `--expect-environment staging|production`.

1. **ChatGPT claim** (staging only): `docker exec rateapp-stage-api /usr/local/bin/rateapp-api-entrypoint python -m api.saved_links_worker claim --limit 1 --expect-environment staging`. Claims **one URL**, returns `{"jobs":[{"id":1,"url":"...","leaseToken":"opaque","attempt":1}]}` or `{"jobs":[]}`. Two-hour claim lease and up to three attempts; one GPT run must not claim both staging and production.
2. ChatGPT analyzes only actually accessible article/video/caption material, excluding ads/navigation; it must not invent games from an inaccessible video. If no usable material, report an error.
3. **ChatGPT submit**: `docker exec -i rateapp-stage-api /usr/local/bin/rateapp-api-entrypoint python -m api.saved_links_worker submit --expect-environment staging`, JSON on stdin `{"id":1,"leaseToken":"opaque","games":["Hollow Knight","Outer Wilds"]}` or `{"id":1,"leaseToken":"opaque","error":"Источник недоступен"}`. Up to 80 unique title strings, 255 chars/title, 64KB JSON. Names stored only in `saved_link_jobs.names` until matched; result is idempotent while matching is pending.
4. **Local/IGDB resolve**, separate from ChatGPT and without LLM tokens: `docker exec rateapp-stage-api /usr/local/bin/rateapp-api-entrypoint python -m api.saved_links_worker resolve --limit 1 --expect-environment staging`. Processes **one source link with its entire title list**, checking local `_local_game_search` first and `_ranked_igdb_search_rows` second (same first-result relevance/alias/popularity as interactive catalog search). IGDB uses `Priority.BACKGROUND` and only the top IGDB candidate is cached; its **local PK** is appended to temporary IDs.
5. To limit VPS/IGDB usage, one resolve invocation handles up to **12 names or 120 seconds**, whichever comes first. A longer link resumes the **same job cursor** on the next pass; it never begins another article midway. Retries temporary IGDB failures up to three times per name, then records a compact warning and skips that name. Duplicate resolved IDs are removed. True misses are simply omitted.
6. **Atomic completion:** after the last name, validate all resolved local `games.id`, store `saved_links.game_ids` and `status=ready`, then delete the `saved_link_jobs` row **in the same SQL transaction**. This permanently removes raw GPT titles, cursors and tokens. An empty GPT list finishes immediately with `game_ids=[]` and deletes the job. On terminal source failure, the job is deleted while the URL remains with `status=failed`.

## Environment isolation and scheduling

- Staging uses `rateapp-stage-api`, `rateapp_stage`, and `--expect-environment staging`. Production uses separate `rateapp-api-1`, `rateapp`, and `--expect-environment production` **only after owner approval and full release QA**. Never copy staging URLs or queue rows to production.
- The original experimental **ChatGPT Scheduled Task** only used a standalone fake file, not these tables. No real URL ingestion schedule has been enabled.
- Connected Gateway Free permits a minimum **60-minute** schedule interval. The incompatible old hourly schedule `gsc_01M61ZA6VQ00CJF3Z4JJZBSRGX` was removed. The replacement staging-only hourly schedule `gsc_01M621B35V00EHJ896JJMPVMHN` uses `resolve --limit 1 --expect-environment staging` but is **pending user confirmation** at [Gateway Schedules](https://trygateway.sh/schedules). It is not running until confirmed.
- No models, long-lived background processes, Chromium, archived media or external HTTP fetching in the API request path. External content acquisition remains a separate security-reviewed feature (HTTP SSRF/DNS/redirect protection, provider terms).

## Migration and tests

`20261029_06` is the next revision after `20261029_05`. Staging deploy succeeded (Actions run #40758199173): `rateapp_stage` migrated to `20261029_06`, `saved_links.game_ids` is an array, `saved_link_jobs` exists, the historical `saved_link_games` is gone and `trg_saved_links_game_deleted` exists. An isolated on-staging smoke created a synthetic URL/game, completed a 2-name job, verified the queue was deleted, deleted that game, verified its ID was pruned from the saved link, then cleaned all test records. On a fresh CI DB, baseline creates current tables; the historical intermediate `saved_link_games` created by earlier revisions is dropped by `06`. Do not downgrade the destructive schema transformation; restore from the pre-deploy snapshot if needed.

Targeted regression scenarios in `tests/test_saved_links.py` and `tests/test_saved_links_match.py`: one-link queue, dedup, simultaneous user isolation, deleted link/stale results, source retry, 14-name continuation, local/IGDB ranking, terminal temporary cleanup and deleted-game trigger. Full release CI is mandatory before moving to `main`.
