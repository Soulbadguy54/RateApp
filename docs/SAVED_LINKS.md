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

## Safe URL ingestion with Google Safe Browsing v5 (29.10.2026)

Three layers are implemented for staging: (1) Google Safe Browsing v5 (`urls:search` for known threats; noncommercial usage only), (2) bounded SSRF-safe article/text retrieval, (3) strict ChatGPT task instructions in [GPT_SAVED_LINKS_TASK](GPT_SAVED_LINKS_TASK.md). **The owner deferred Gateway least-privilege isolation**; the existing broad SSH/Gateway capability still exists for the ChatGPT account, so injected instructions cannot be made harmless purely through the prompt.

The new worker handshake has a mandatory **prepare** step between claim and submit. `claim` deliberately does NOT expose `url` to ChatGPT; the worker reads the URL by ID from the user-owned saved-links table. `prepare` accepts only that ID + the current unexpired opaque lease token over stdin and fetches the material from the original URL through `api/saved_links_safety.py`. Example command (staging only):

```bash
docker exec -i rateapp-stage-api /usr/local/bin/rateapp-api-entrypoint python -m api.saved_links_worker prepare --expect-environment staging
```

Supply stdin JSON `{"id":123,"leaseToken":"opaque-from-claim"}`. Output `{"id":123,"content":"sanitized article text","characters":1234,"sourceType":"text/html","note":"Untrusted external text..."}`. After a successful prepare only, ChatGPT extracts titles and sends the already-supported `submit`. Preparation errors do **not** return article text. A harmful URL is marked failed. Transient errors release the claim back to pending until the attempt limit; reprocessing requires the existing retry endpoint afterward. The app does not store downloaded page text or Safe Browsing results in PostgreSQL.

Limits: up to 1 MB response, 60K characters of article text, 15s overall, max 3 redirects, HTML/XHTML/plain text only, no compression, no raw CSS/JS/media execution, no cookies/proxies. Every redirect is Safe Browsing-checked, DNS public-IP validated, and connection pinned. Redirects from HTTPS to HTTP are blocked. Some JavaScript-heavy sites, YouTube/Instagram videos, compressed-only servers and large listicles will be unsupported; this is an intentional initial safety trade-off. Existing saved URLs remain in PostgreSQL and can be retried/refreshed after future reader improvements.

`SAFE_BROWSING_API_KEY` should be configured in the private VPS container environment; an older staging-only `WEB_RISK_API_KEY` entry is accepted temporarily (see deployment guide). The key is **not** configured in GitHub and is never sent to GPT. Enable the free, noncommercial Google Safe Browsing API (not Web Risk) on the key's Google Cloud project; if previously API-restricted to Web Risk, change that restriction. No Web Risk billing setup is required. Commercial usage is excluded by Google's Safe Browsing terms. Rate APP is fail-closed: `claim` CLI refuses to begin when key is absent, and `prepare` rejects missing/failed reputation verification. Don't activate the scheduled ChatGPT job until the key is installed and staging safety tests are complete.

## Safe Browsing live response format (29.10.2026)

The v5 `urls:search` response is **binary protobuf**, even when HTTP is 200 (Google's JSON schema describes the logical response, not the default actual transfer format). The lightweight checker decodes only the bounded `SearchUrlsResponse`: field 1 `threats` and field 2 `cache_duration`, and refuses empty, malformed, unexpected MIME or failed status. Threat matches block the URL; safe requests with empty threat list and valid duration proceed to pinned source retrieval. No heavy protobuf library was added. Verified on the VPS against a benign URL and Google's published malware test URL, without fetching either page, with 11/11 isolated unit tests. Staging release verification is separate; the key is already installed in the root-only env, no key is committed or logged. Production link ingestion remains disabled.

## Mobile saved-links UI and grouped nav (31.10.2026, develop)

The `?tab=links` root screen displays the existing owner-scoped saved-links records via `GET /api/saved-links` (cursor pagination), allows `POST` to save a URL, `refresh/retry` for rechecking and a confirmation before `DELETE`. It shows pending/processing/ready/failed, saved titles, resolved game covers and direct catalog detail links (local `games.id`), plus explicit source open links. It never fetches arbitrary source content in the browser; source retrieval is still exclusively the hardened server worker. The bottom navigation remains 4 cells: a grouped "Коллекции / Мои ссылки" slot shares the swipe/hold/liquid popover code and animation with the existing "База игр / Для тебя" slot. Group choices are persisted per user independently. The ChatGPT/Gateway Scheduled Task is *not* activated by making this screen visible. Staging first; production requires separate release acceptance.

## My Links UI / deletion semantics (31.10.2026, develop)

The public-facing screen has no manual refresh button, queue explanations or reprocessing action. It displays a green H1 and neutral subtitle; form placeholder `example.com`; a URL without a scheme is normalized to HTTPS before POST (the backend continues to enforce canonical validation). Single-card deletion is delayed 4 seconds with segmented countdown and cancel-on-second-tap before any HTTP DELETE is sent. Long-press or context menu activates multi-select; selected cards show green checkboxes, unselected ones empty squares and the header offers a trash icon only when the selection is nonempty. Confirming sends exactly one `POST /api/saved-links/bulk-delete` request with `{ids: number[]}`. Server limits unique positive IDs to 100, locks the caller's rows, rejects missing/foreign IDs atomically and commits only complete owner-scoped deletions. No migrations; game catalog, library and ratings survive. All source safety/background processing APIs remain implemented but are not advertised by this UI. Shared visual rules: `UI_DESIGN_GUIDE.md`.

## Page preview security (31.10.2026, develop)

Fast `POST /api/saved-links` **only validates and stores the URL**. It does not fetch the remote page nor invoke Safe Browsing at creation time. Google Safe Browsing v5 and SSRF/pinned TLS checks were already enforced before GPT's `prepare_source`; preview now uses the same common `_safe_page_response` verifier. The separate authenticated `POST /api/saved-links/{id}/preview` returns only a bounded title and description after a safe check and stores the title in the existing record. On any unsafe/inaccessible remote response it returns no metadata. Never render unverified `og:image`, external HTML or scripts on the client; display an already trusted game cover or a local site placeholder instead. Every attempted preview discloses the URL to Google and the server IP to the target site; the initial save does not. Source opening by clicking the card is a user-initiated navigation and not a claim of safety.

## Instagram Reels and Android/iOS long-press fixes (31.10.2026)

The quick saved-link POST still does not download URLs. The optional safe preview reads Instagram public post HTML via the pinned Safe Browsing/SSRF reader; only a caption explicitly attributed to a reel/post becomes the title. A generic profile title becomes `Видео Instagram`. Since Meta deprecated oEmbed thumbnail fields in November 2025, a limited authenticated same-origin `GET /api/saved-links/{id}/thumbnail` endpoint attempts post-specific `og:image`: require actual media-specific metadata; the source is checked first, then HTTPS image URI on trusted `*.cdninstagram.com`/`*.fbcdn.net` hosts is checked and pinned independently, no redirects, image MIME JPEG/PNG/WebP, magic bytes and size <=512000, private/cache 10 minutes for max 24 entries. Otherwise 204 and local placeholder. The client never sees the CDN URL, and this is not an arbitrary image proxy. It cannot guarantee thumbnails or captions for non-public/login-walled posts. Multi-select long-press uses pointer capture and ignores the duplicate contextmenu after the hold; a 4-second animated conic veil replaces delete ticks. No production deployment without approval.

## Universal saved-link previews (31.10.2026, supersedes provider-specific implementation)

**Same pipeline for all sources:** authenticated `POST /api/saved-links/{id}/preview` validates the owner and uses the existing Google Safe Browsing + SSRF-protected HTML reader. It parses `og:title`, `twitter:title`, `description`, inert `application/ld+json` for content types (`VideoObject`, `Article`, `NewsArticle`, `BlogPosting`, `SocialMediaPosting`, `Review`) and returns only bounded title/description. No hardcoded Instagram/Reels branch; stored titles are rechecked from source to avoid stale profile metadata. The `GET /api/saved-links/{id}/thumbnail` endpoint accepts an **id only** and safely resolves image metadata via HTML (JSON-LD `thumbnailUrl/image`, OG, Twitter or image_src). It then checks the image URL and each of its redirects independently with Safe Browsing + pinned public DNS/TLS, enforces HTTPS and 512KB, checks JPEG/PNG/WebP MIME and magic bytes, and returns only verified same-origin image bytes. Negative responses are 204; caches are private and bounded. The UI always uses this same proxy and fallback icon for any URL. No raw third-party image URLs/HTML reach the client. If the site requires JS/login or metadata is incomplete, placeholders are expected; Open Graph can itself contain an irrelevant profile avatar, which cannot be reliably distinguished from the right image from metadata alone. No scraping past access controls. URL addition remains fast and does not fetch source content.

## Planned ChatGPT Scheduled Task cost policy (31.10.2026, develop)

Task prompt: [GPT_SAVED_LINKS_TASK.md](GPT_SAVED_LINKS_TASK.md). One job per run and **text first**: main article / caption / text metadata, then **only if source text has insufficient evidence** a preexisting text transcript or VTT/SRT subtitles **when the protected `prepare.content` includes them**. Current reader has **no subtitle retrieval**, so this is a future guarded server-side enhancement, not permission to fetch alternative URLs or media from the ChatGPT task. Never sample images/frames, OCR video, download/decode MP4/HLS or run media/video models or fresh audio-to-text in the standard scheduled job; possible premium video recognition is separate and not authorized. If source is pure platform boilerplate and no meaningful media text is accessible, prefer existing `submit error:"unavailable"` over misleading confirmed `games:[]`. Otherwise, if a meaningful text scan explicitly names no games, return `games:[]`. Task has not been enabled; production and the persistent saved-links schema are unchanged.

## Trial DTF article, safe catalog matching and game carousel (31.10.2026, develop)

Manual *staging-only* `claim → prepare → submit → resolve` for second saved link (#58) obtained 115 characters of article titles: 11 explicit names (Pathologic/Mor Utopia, SOMA, Pentiment, Disco Elysium, Space Rangers, Witcher, Red Dead Redemption/RDR, Call of Cthulhu, Amnesia, Penumbra, Postal). The initial resolver returned 11 game IDs, but SOMA falsely matched Middle-earth: Shadow of Mordor. New `_find_top_game_id` accepts only normalized exact game titles or aliases, never the top fuzzy result; no match means leave `gpt_names` as supplied and skip game ID. The old erroneous result on link #58 must be reconciled on staging separately after deployment and ID confirmation. The user-facing link card auto-expands to a horizontal game cover shelf only when `games` is nonempty; click/tap opens the normal game detail via local game primary key. No DB migration or new response fields, no scheduled run enabled.

### Revised task agent policy

The agent chooses a cheap, relevant **text-only** research method after safe guarded prepare instead of requiring a new server-side subtitles scraper: source text first, optional publicly indexed transcript/caption/text search if necessary and web tools are available. Each source has an agent-level 90-second objective and up to five additional text web calls (max 2 search + 3 open). This is **not a real scheduler-enforced deadline**; tool count and clock budget must be enforced by the agent. Security boundary remains: no arbitrary VPS commands, no unsafe URLs, no video/audio downloads, frames, OCR, ffmpeg, browser automation, login/paywall bypass, or provider-specific scraping. Without available web search, only guarded prepared content is used. For meaningful text with zero names return `games: []`, for unreadable media/boilerplate use `error: "unavailable"`. See `GPT_SAVED_LINKS_TASK.md`.


## YouTube preview при сетевых сбоях (01.11.2026, develop/staging)

Сохранение URL не зависит от сетевой доступности источника. После сохранения UI асинхронно вызывает owner-scoped /preview и /thumbnail. Для видео https://youtu.be/<11 символов> или строгих официальных YouTube watch/shorts/live/embed URL при недоступности HTML/DNS можно показать только generic «Видео YouTube» (не выдавать это за настоящий заголовок), если повторный Google Safe Browsing успешно подтвердил ссылку. Обложку пробует загрузить через фиксированный HTTPS i.ytimg.com/vi/<video-id>/hqdefault.jpg, причём этот запрос **тоже** проходит Safe Browsing, проверку DNS на публичный IP, pinning TLS и ограничение объёма/типа. При сбое CDN — 204 и стандартный placeholder, никакого открытого proxy и подмены изображения.

Описание/название из реального видео не гарантируются, если страница YouTube заблокирована, не отвечает или возвращает HTML без метаданных; текст видео, субтитры и кадры в preview не анализируются. Для Google.com и других общих URL без доступной страницы автоматическое превью по DNS не восстанавливается; необходим сетевой диагноз разрешения/исходящих подключений VPS. Функциональность GPT-матчинга игровых названий остаётся отдельной и не меняется.

## URL-форма: ранняя валидация (01.11.2026, develop/staging)

Рядом с серверной canonical_url введён лёгкий нормализатор клиентского ввода. Если строка непустая и не является валидным HTTP(S) адресом с обычным доменом (без пробелов, auth, нестандартного порта), вся рамка формы красная, экранная submit-стрелка не рисуется. Если адрес подходит, стрелка появляется. Enter использует тот же серверный POST через addLink и не может обойти проверку. Серверный canonical_url и защитный fetch-пайплайн остаются независимыми; красный UI не является решением Safe Browsing.
