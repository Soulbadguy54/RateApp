# Saved links: one table, no persistent queue

**Current develop/staging design (29.10.2026).** Backend groundwork only. No live ChatGPT Scheduled Task reading the real queue, no social video analyser or saved-links UI. Production remains unchanged until authorized release.

## Persistent table

`saved_links` owns all source-local results: `id` PK, `user_id` FK (CASCADE), normalized `url`, SHA-256 `url_hash`, optional `title`, `gpt_names TEXT[] NULL`, `game_ids INTEGER[] NOT NULL DEFAULT '{}'`, `created_at`, `updated_at`, `status`, `finished_at`, and short-lived lease/cursor/error counters. Unique (`user_id`, `url_hash`) prevents the same user saving the same canonical URL twice. Maximum 100 links/user and 15 newly saved links/user per 24h.

`gpt_names IS NULL` means GPT **has not** returned a list, including a failed/abandoned claim. `gpt_names = '{}'` means GPT scanned the source and found **zero** game names. Non-empty names remain alongside game IDs for this link **until deleted or refreshed**. No separate `saved_link_jobs`, `saved_link_games` or name→ID join table. The `20261029_07` migration copies in-flight names/partial IDs from the former `saved_link_jobs` before dropping it. For older completed links, names were already discarded by previous code and cannot be recovered: migration marks them empty to prevent false requeue; users can explicitly refresh. Existing resolved IDs are preserved.

`game_ids` contains local `games.id` (not IGDB IDs); selected IGDB records are cached in the shared game table before their local PK is added. A PostgreSQL AFTER DELETE trigger prunes deleted `games.id` from arrays; a GIN index accelerates that cleanup. The UI loads saved links newest-first and hydrates their game cards with **one** PostgreSQL SELECT over the entire page's ID set, without IGDB requests.

## HTTP API (cookie-authenticated)

- `POST /api/saved-links` adds URL with `gpt_names=NULL`; duplicate owner/URL returns existing.
- `GET /api/saved-links?limit=50&before=123`, `GET /api/saved-links/{id}`: owner-only records, returning `gptNames`, `gameIds`, status, and local catalog summaries. Sorted by `created_at DESC, id DESC`.
- `DELETE /api/saved-links/{id}`: removes the entire record, its two arrays and any in-flight claim. Later submit cannot recreate it.
- `POST /api/saved-links/{id}/refresh`: explicit recheck if article/video was edited; sets `gpt_names=NULL`, `game_ids=[]`, clears cursor/lease, and restarts from pending. A previous worker result is invalidated. `POST /api/saved-links/{id}/retry` works for failed links only and applies the same reset.
- No scraping, downloading HTML or video in the API request path.

## One URL at a time through Gateway

Commands run with the correct entrypoint (it supplies private DB credentials), never arbitrary production access:

```bash
docker exec rateapp-stage-api /usr/local/bin/rateapp-api-entrypoint python -m api.saved_links_worker claim --limit 1 --expect-environment staging
docker exec -i rateapp-stage-api /usr/local/bin/rateapp-api-entrypoint python -m api.saved_links_worker submit --expect-environment staging
docker exec rateapp-stage-api /usr/local/bin/rateapp-api-entrypoint python -m api.saved_links_worker resolve --limit 1 --expect-environment staging
```

`claim` selects **the oldest** pending/expired `saved_links` record with `gpt_names IS NULL` (FOR UPDATE SKIP LOCKED), returns a single `{"jobs":[{"id":1,"url":"https://...","leaseToken":"opaque","attempt":1}]}` or `{"jobs":[]}`. It has a two-hour claim lease and at most three claim attempts. A late/stale result is rejected. `submit` takes stdin JSON `{"id":1,"leaseToken":"opaque","games":["Hollow Knight","Outer Wilds"]}` or `{"id":1,"leaseToken":"opaque","error":"unavailable"}`, max 80 unique titles. Names write directly to `saved_links.gpt_names`, not a queue table. `[]` means completed empty scan and sets status ready.

`resolve` processes all games associated with **one link**, searching local PostgreSQL title/alias/pg_trgm/popularity first, then ranked IGDB and caching only the first candidate. It stores local game IDs into `saved_links.game_ids`; a pass is limited to 12 titles or 120 seconds, then resumes at `match_cursor` on a later pass. A matching lease lasts five minutes, and temporary provider errors retry up to three times per title. Existing game ratings, reviews and collection membership are untouched.

This is a **last successful scan**, not a guarantee that URL contents are unchanged. The user can refresh any link; there is no indefinite content-cache contract. For actual fetching, use a separately reviewed SSRF-safe source parser. Empty-GPT results must not be confused with never-processed rows.

## Staging and rollout

Gateway's old scheduled command `--limit 4` was replaced by `--limit 1`; the newly created hourly staging-only Gateway schedule `gsc_01M621B35V00EHJ896JJMPVMHN` was pending owner confirmation at last verification. Do not enable production jobs without approval; staging is `rateapp-stage-api` → `rateapp_stage` and production is `rateapp-api-1` → `rateapp`. The old ChatGPT experiment only processed a synthetic fixture, not the real queue.

Migration `20261029_07` is one-way schema refactor, and `20261029_08` reconciles the already-deployed legacy column naming (`game_names` → `gpt_names`, `resolve_cursor` → `match_cursor`) and indexes: pre-deploy stage backup is required, and rollback restores DB snapshot rather than downgrading. Smoke should verify actual revision, `gpt_names`, `game_ids`, no `saved_link_jobs`, deletion/refresh races, a two-name full pass and no production changes. Full backend/mobile CI is required before a future main release.

## Safe URL ingestion with Google Web Risk (29.10.2026)

Three layers are implemented for staging: (1) Google Web Risk Lookup (`uris.search` for malware/social engineering/unwanted software), (2) bounded SSRF-safe article/text retrieval, (3) strict ChatGPT task instructions in [GPT_SAVED_LINKS_TASK](GPT_SAVED_LINKS_TASK.md). **The owner deferred Gateway least-privilege isolation**; the existing broad SSH/Gateway capability still exists for the ChatGPT account, so injected instructions cannot be made harmless purely through the prompt.

The new worker handshake has a mandatory **prepare** step between claim and submit. `claim` deliberately does NOT expose `url` to ChatGPT; the worker reads the URL by ID from the user-owned saved-links table. `prepare` accepts only that ID + the current unexpired opaque lease token over stdin and fetches the material from the original URL through `api/saved_links_safety.py`. Example command (staging only):

```bash
docker exec -i rateapp-stage-api /usr/local/bin/rateapp-api-entrypoint python -m api.saved_links_worker prepare --expect-environment staging
```

Supply stdin JSON `{"id":123,"leaseToken":"opaque-from-claim"}`. Output `{"id":123,"content":"sanitized article text","characters":1234,"sourceType":"text/html","note":"Untrusted external text..."}`. After a successful prepare only, ChatGPT extracts titles and sends the already-supported `submit`. Preparation errors do **not** return article text. A harmful URL is marked failed. Transient errors release the claim back to pending until the attempt limit; reprocessing requires the existing retry endpoint afterward. The app does not store downloaded page text or Web Risk results in PostgreSQL.

Limits: up to 1 MB response, 60K characters of article text, 15s overall, max 3 redirects, HTML/XHTML/plain text only, no compression, no raw CSS/JS/media execution, no cookies/proxies. Every redirect is Web Risk-checked, DNS public-IP validated, and connection pinned. Redirects from HTTPS to HTTP are blocked. Some JavaScript-heavy sites, YouTube/Instagram videos, compressed-only servers and large listicles will be unsupported; this is an intentional initial safety trade-off. Existing saved URLs remain in PostgreSQL and can be retried/refreshed after future reader improvements.

`WEB_RISK_API_KEY` must be configured in the private VPS container environment (see deployment guide). It is **not** configured in GitHub and is never sent to GPT. Google Cloud Web Risk Lookup requires enabling the API and billing on the Google Cloud project; pricing currently includes 100000 free requests/month. Rate APP is fail-closed: `claim` CLI refuses to begin when key is absent, and `prepare` rejects missing/failed reputation verification. Don't activate the scheduled ChatGPT job until the key is installed and staging safety tests are complete.
