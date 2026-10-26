# RateApp: safe schema changes and deploys

## Required order

1. Back up the production PostgreSQL database (and verify restore).
2. Review migration SQL on a copied/staging database containing historical rows.
3. Apply migrations with production DATABASE_URL: `python -m alembic upgrade head`.
4. Run `GET /api/health`; require HTTP 200 and `database.reachable=true`.
5. Deploy the application, check startup/login/library/collections with smoke tests.

**Never** invoke migration code inside the FastAPI app import/startup path.
Run migrations from a protected CI job with an authorized secret, or a trusted
DB admin machine. Keep secrets out of commits and logs. The Vercel Git integration builds code changes on main; documentation-only
commits are skipped by `vercel.json` → `scripts/ignore-docs-build.sh` (the
Vercel Ignored Build Step still creates a canceled/skipped deployment record
and can count against quota). Coordinate migrations *before* commits that
require new columns. Enable branch protection/deployment checks to enforce
this order before future migrations. This first baseline records the existing
production schema; it is compatible with the already-initialized database.

To initialize CI/test database: `python -m alembic upgrade head`.
Do not use `Base.metadata.create_all` as an application startup migration.

## Legacy migration limitation

The first versioned migration delegates to the existing idempotent bootstrap
as an **one-time baseline**. Historical user rows are left unchanged unless
already covered by the audited legacy repair. Further migrations must be
incremental, explicit and independently testable. The database must be
backed up before the initial baseline is marked as applied.

## Production smoke checks
`python scripts/smoke_production.py` checks that the public health endpoint,
auth bootstrapping (unauthenticated 401), deliberately invalid login (401, **not
500**) and private export (401) work. CI runs it after the backend, build and
mobile browser jobs on main. It never sends real user credentials.

## Recovery and backups
- Account users can download their own portable JSON backup under Profile.
- The JSON export is not a database disaster-recovery backup and does not
  contain session credentials.
- Before destructive migrations: take an encrypted provider-managed PostgreSQL
  snapshot; restore the snapshot into a separate staging database and verify
  row counts for users, library, collections, memberships, and scores.
- Enable automated daily snapshots, retention, and point-in-time recovery in
  the PostgreSQL provider. These provider settings cannot be enforced from
  the RateApp source repository alone; verify them in the DB administration
  console and set up failure notifications.
- Do not log auth PINs, raw cookie tokens, personal emails, or exported JSON.
- Optional Sentry: configure `SENTRY_DSN` for server errors and
  `VITE_SENTRY_DSN` for browser errors in Vercel's environment settings.
  Default personal information and request-body uploads are disabled.
- Release gating: protect main and configure Vercel Deployment Checks on
  the CI jobs; Vercel Git integration can otherwise deploy before CI finishes.

## VPS environment and rollback — active production (2026-10-21)

The VPS migration and cutover are described in [VPS_MIGRATION.md](VPS_MIGRATION.md). Active production is https://r-app.ru on local PostgreSQL 18. GitHub Actions deploy is gated on successful main CI and uses the pinned SSH host key + restricted deploy account. Release runs pre-migration local pg_dump, Alembic, containers update and health check; app-image rollback does not downgrade database schema. Daily server-side pg_dump uploads to owner-managed Google Drive at 03:40 UTC, with separate restore validation. Vercel is paused and Neon retained temporarily as an archive/rollback source; neither is on the request path. Never treat a local dump as the sole disaster-recovery copy, drop the persistent PostgreSQL volume, or automatically downgrade a DB schema during image rollback.

## Выпуск без ожидания в чате: release PR → полный CI → main → VPS → Telegram (27.10.2026)

Для одобренного production release открыть `develop` → `main` PR и пометить `release-approved` только по явной воле владельца. `pull_request` должен запустить обязательные `build`, `backend-tests`, `mobile-e2e`. Сразу после подтверждения запуска дать в чат ссылку на **конкретный Actions run** и release PR, указать `head SHA` и честно отметить «в процессе, в production ещё не опубликовано». **Не дожидаться** 5–10-минутных тестов в чате и не опрашивать статусы через GPT; итоговый источник — Telegram и GitHub Actions.

В `ci.yml` зависимый `promote-approved-release` исполняется только после зелёных тестов, с повторной проверкой exact SHA, approved-label и пары веток. При проблеме merge/review или красном тесте workflow не может выпустить новую версию, Telegram сообщает о сбое. После успешного merge `main` сам запускает полный CI, Docker GHCR publish и ограниченный VPS deploy со штатными backup/migrate/smoke. Финальный статус production также отправляется в Telegram. **Никакой преждевременной формулировки «готово»**: до подтверждённого сервером SHA и smoke статус только «запущено». Не обходить protective branch checks; ручные/опасные операции остаются исключением.

## Staging release flow (`dev.r-app.ru`)

1. Merge reviewed, green PR #44 into `main`, wait for main CI and normal VPS production deployment and smoke. The main deploy installs the audited staging dispatcher only after production health passes.
2. A distinct post-deploy `bootstrap-stage` command runs **once**. It validates the exact deployed `main` SHA, dumps production without modifying it, backs up any existing `rateapp_stage`, creates a limited `rateapp_stage` DB user, restores the snapshot into `rateapp_stage`, removes other users/sessions/push subscriptions *inside stage only*, and writes the initialization marker. Abnormal exit stops the staging rollout; it must never fall back to production DB credentials.
3. Create `develop` based on deployed main and trigger a commit/push. Its full CI runs frontend, backend PostgreSQL and mobile E2E. Successful runs build two new stage-only GHCR images tagged with the exact tested SHA; no stage image is used by production.
4. The restricted SSH command `deploy-stage <40-hex-sha>` accepts only the *current* `develop` HEAD. It deploys via the reviewed Compose file from `main`, makes a stage-only pre-migration dump, migrates only `rateapp_stage`, and verifies API health.
5. Smoke `https://dev.r-app.ru`: valid HTTPS; SPA/mobile; test banner; `/api/health` 200 + DB reachable; anonymous `/api/auth/me` 401; POST `/api/auth/register` 404; login with known owner PIN (requires owner device, do not collect PIN); library/collections; no stage push or cron traffic. Reconfirm `https://r-app.ru` and its API, compare production release SHA with `main`.
6. Further changes: PR into `develop` → fast staging deploy → acceptance → approved release PR into `main`. After label `release-approved`, full tests gate an automatic squash merge, followed by main CI, backup, migration/deploy and smoke. The agent sends an Actions run link immediately and does not await CI in chat. Never auto-promote a staging feature without explicit acceptance.

### Cautions

- Same VPS/postgres service but **separate databases and roles**. Do not point stage API at the production superuser credentials. Never run stage migrations against `rateapp`.
- Stage data are a *snapshot*, not live-synced. A reset is a destructive operation and requires a fresh approval and stage backup.
- Staging login sessions are new, scoped to `dev.r-app.ru`; no real cookies/tokens move from production. UI/JS can be fetched without login, but private API requires authorization.
- If stage migrations fail, rolling back images cannot revert the schema. Restore the staging backup only after diagnosis and explicit approval.
- DNS A `dev.r-app.ru → 111.88.215.215`, TLS managed by existing Caddy. Staging does not start merely because DNS exists.
