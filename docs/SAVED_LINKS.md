# Saved links — lightweight bookmarks (01.11.2026, develop/staging)

## Active behavior

“My Links” is a **plain owner-scoped collection of URLs**. Add, list, delete one
or several, show safe preview metadata / thumbnail when available. There is **no
GPT processing, game matching, game carousel, status polling, retry or scheduled
background job**. Saving a link does not fetch it or request any game provider.

- `POST /api/saved-links`: canonicalize and store a URL; duplicates return the
  existing record for the authenticated owner.
- `GET /api/saved-links` and `GET /api/saved-links/{id}`: bookmarks ordered
  newest first; only `id,url,title,createdAt,updatedAt` are exposed.
- `DELETE /api/saved-links/{id}` and `POST /api/saved-links/bulk-delete`:
  delete only the owner's records; protected by existing ownership/quota checks.
- `POST /api/saved-links/{id}/preview` and
  `GET /api/saved-links/{id}/thumbnail`: optional metadata / thumbnail fetch
  guarded by Google Safe Browsing, public-IP checks, TLS pinning, strict MIME
  and byte limits. Inaccessible sources still remain saved as URLs.
- `/retry` and `/refresh` worker-related endpoints were removed.

## Receiving Android Share intent

The installed PWA declares `share_target` in `vite.config.ts`:

```json
{
  "action": "/?tab=links",
  "method": "GET",
  "params": { "title": "share_title", "text": "share_text", "url": "share_url" }
}
```

An Android Chromium-based browser can register the **installed** PWA in the
system share chooser. Android commonly supplies a shared link via `text`.
On activation, `SavedLinksView` extracts an explicit http(s) address,
validates the canonical candidate, immediately scrubs the share parameters
from browser history, uses the authenticated `POST /api/saved-links` endpoint
and shows “Ссылка сохранена.” The user stays in “Мои ссылки”. A duplicate
is deduplicated on the server, even after a repeated share. Failure retains
the URL in the editable input field. Non-URL shares are rejected without
sending a POST. Share intent is handled only after the user is signed in;
the query survives the sign-in screen until links view opens.

**iOS limitation:** Safari on iOS does not support the web manifest
`share_target` member as of 01.11.2026. Web-only RateApp cannot appear as a
native iOS Share Sheet recipient. The manual Add Link field remains supported
on iPhone. Native iOS Share Extension is out of scope.

## Compatibility and rollout

The old `saved_links` PostgreSQL columns `gpt_names`, `game_ids`,
`status`, `lease_token`, `match_cursor` etc. are intentionally **retained
only as inert legacy data** to avoid a destructive migration or loss of
historical references. New records get `status=ready, gpt_names=[]`, but
these fields are never included in API responses and cannot trigger work.
No background worker executable or match/claim route remains in this version.
Preserve the records and catalog; do not mutate existing user links during QA.

Operational actions performed on staging: ChatGPT Automation
`6ae2cbbcf4c08191b9ced3f263be088e` was disabled, and Gateway schedule
`gsc_01M621B35V00EHJ896JJMPVMHN` was removed. Production is not approved
for release by this PR. Legacy production behavior remains unchanged until
an authorized normal release.
