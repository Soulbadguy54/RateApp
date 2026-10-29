"""Saved-links one-table worker: claim oldest URL, save titles, resolve one URL.

No separate queue, no cached result shared across users, no resident worker.
Run inside the intended API container using its rateapp-api-entrypoint.
"""
import argparse
import json
import os
import secrets
import sys
import time
import unicodedata
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import SQLAlchemyError

from api.models import Game, SavedLink
from api.security import _now, _session

MAX_GAMES = 80
MAX_CLAIM_ATTEMPTS = 3
MAX_MATCH_ATTEMPTS = 3
CLAIM_LEASE_HOURS = 2
MATCH_LEASE_MINUTES = 5
MAX_TITLES_PER_PASS = 12
MAX_PASS_SECONDS = 120


def claim_jobs(limit: int = 1, *, only_id: int | None = None) -> dict:
    """Oldest unprocessed URL first. NULL != [] for the extracted title array."""
    if limit != 1:
        raise ValueError("One link per ChatGPT claim")
    now = _now()
    with _session() as session:
        abandoned = session.scalars(select(SavedLink).where(
            SavedLink.game_names.is_(None),
            SavedLink.status == "processing",
            SavedLink.lease_until <= now,
            SavedLink.attempts >= MAX_CLAIM_ATTEMPTS,
        ).with_for_update(skip_locked=True)).all()
        for link in abandoned:
            link.status = "failed"
            link.error = "Превышено число попыток распознать статью."
            link.lease_token = None
            link.lease_until = None
            link.finished_at = now
            link.updated_at = now
        query = (select(SavedLink)
                 .where(SavedLink.game_names.is_(None),
                        SavedLink.attempts < MAX_CLAIM_ATTEMPTS,
                        or_(SavedLink.status == "pending",
                            and_(SavedLink.status == "processing",
                                 SavedLink.lease_until <= now)))
                 .order_by(SavedLink.created_at.asc(), SavedLink.id.asc())
                 .limit(1).with_for_update(skip_locked=True))
        if only_id is not None:
            query = query.where(SavedLink.id == only_id)
        link = session.scalar(query)
        if link is None:
            session.commit()
            return {"jobs": []}
        link.status = "processing"
        link.attempts += 1
        link.lease_token = secrets.token_urlsafe(24)
        link.lease_until = now + timedelta(hours=CLAIM_LEASE_HOURS)
        link.error = None
        link.updated_at = now
        output = {"id": link.id, "url": link.url, "title": link.title,
                  "leaseToken": link.lease_token, "attempt": link.attempts}
        session.commit()
        return {"jobs": [output]}


def _validated_names(payload: dict) -> list[str]:
    raw = payload.get("games")
    if not isinstance(raw, list) or len(raw) > MAX_GAMES:
        raise ValueError("Expected a list of up to 80 names")
    names, seen = [], set()
    for item in raw:
        if not isinstance(item, str):
            raise ValueError("Each name must be a string")
        name = " ".join(unicodedata.normalize("NFKC", item).split())
        if not 1 <= len(name) <= 255:
            raise ValueError("Game name length must be 1..255")
        key = name.casefold()
        if key not in seen:
            seen.add(key)
            names.append(name)
    return names


def submit_result(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    link_id, token = payload.get("id"), payload.get("leaseToken")
    if type(link_id) is not int or link_id <= 0 or not isinstance(token, str) or not token:
        raise ValueError("Missing id/leaseToken")
    error = payload.get("error")
    if error is not None and (not isinstance(error, str) or not 1 <= len(error) <= 300):
        raise ValueError("Invalid error string")
    names = _validated_names(payload) if error is None else None
    now = _now()
    with _session() as session:
        link = session.scalar(select(SavedLink)
                              .where(SavedLink.id == link_id).with_for_update())
        if link is None or link.lease_token != token:
            raise ValueError("Deleted link or stale token")
        if link.game_names is not None:
            # Duplicate submit while a previously accepted result is still here.
            return {"saved": True, "idempotent": True, "id": link_id}
        if link.status != "processing" or not link.lease_until or link.lease_until <= now:
            raise ValueError("Expired claim")
        if error is not None:
            link.status = "failed" if link.attempts >= MAX_CLAIM_ATTEMPTS else "pending"
            link.error = error
            link.finished_at = now if link.status == "failed" else None
        else:
            link.game_names = names
            link.game_ids = []
            link.resolve_cursor = 0
            link.match_failures = 0
            link.error = None
            link.status = "ready" if not names else "processing"
            link.finished_at = now if not names else None
        link.lease_token = None
        link.lease_until = None
        link.updated_at = now
        session.commit()
        return {"saved": True, "idempotent": False, "id": link_id,
                "status": link.status, "gamesCount": len(names) if names is not None else 0}


def _find_top_game_id(name: str) -> int | None:
    """The same local ranking, then IGDB ranking, as catalog search."""
    from api.games_routes import (
        _local_game_search, _ranked_igdb_search_rows, _cache_igdb_games,
    )
    from api.igdb_client import Priority

    query = name.strip()[:100]
    if len(query) < 3:
        return None
    with _session() as session:
        items = _local_game_search(session, query, 0)["items"]
        if items:
            return int(items[0]["id"])
    items, _ = _ranked_igdb_search_rows(query, priority=Priority.BACKGROUND)
    if not items:
        return None
    cached = _cache_igdb_games([items[0]])
    return int(cached[0]["id"]) if cached else None


def resolve_games(limit: int = 1, *, only_id: int | None = None) -> dict:
    """Resolve one article; commit progress directly to that article's row.

    A bounded pass handles at most 12 names/120 sec; subsequent passes resume
    on the same link (oldest first). No job table or global title cache exists.
    """
    if limit != 1:
        raise ValueError("Resolve one link at a time")
    now = _now()
    with _session() as session:
        query = (select(SavedLink)
                 .where(SavedLink.game_names.is_not(None),
                        SavedLink.status == "processing",
                        or_(SavedLink.lease_until.is_(None),
                            SavedLink.lease_until <= now))
                 .order_by(SavedLink.created_at.asc(), SavedLink.id.asc())
                 .limit(1).with_for_update(skip_locked=True))
        if only_id is not None:
            query = query.where(SavedLink.id == only_id)
        link = session.scalar(query)
        if link is None:
            return {"links": 0, "processed": 0, "matched": 0,
                    "remaining": 0, "complete": True}
        link_id = link.id
        token = secrets.token_urlsafe(24)
        link.lease_token = token
        link.lease_until = now + timedelta(minutes=MATCH_LEASE_MINUTES)
        session.commit()

    processed = matched = 0
    start = time.monotonic()
    while processed < MAX_TITLES_PER_PASS and time.monotonic() - start < MAX_PASS_SECONDS:
        with _session() as session:
            link = session.get(SavedLink, link_id)
            if link is None or link.lease_token != token or link.status != "processing":
                return {"links": 0, "processed": processed, "matched": matched,
                        "remaining": 0, "complete": False, "cancelled": True}
            names = link.game_names
            cursor = link.resolve_cursor
            if names is None or cursor >= len(names):
                break
            name = names[cursor]

        igdb_id, temporary_error = None, False
        try:
            igdb_id = _find_top_game_id(name)
        except (HTTPException, SQLAlchemyError, OSError, ValueError):
            temporary_error = True

        with _session() as session:
            link = session.scalar(select(SavedLink)
                                  .where(SavedLink.id == link_id).with_for_update())
            if (link is None or link.lease_token != token
                    or link.status != "processing" or link.game_names is None):
                return {"links": 0, "processed": processed, "matched": matched,
                        "remaining": 0, "complete": False, "cancelled": True}
            if temporary_error or link.lease_until is None or link.lease_until <= _now():
                link.match_failures += 1
                if link.match_failures < MAX_MATCH_ATTEMPTS:
                    link.lease_token = None
                    link.lease_until = None
                    session.commit()
                    return {"links": 1, "linkId": link_id, "processed": processed,
                            "matched": matched, "remaining": len(link.game_names) - link.resolve_cursor,
                            "complete": False, "retry": True}
                link.error = "Не все названия удалось сопоставить с каталогом."
            elif igdb_id is not None:
                game = session.scalar(select(Game).where(Game.igdb_id == igdb_id))
                if game is not None and game.id not in (link.game_ids or []):
                    link.game_ids = list(link.game_ids or []) + [game.id]
                    matched += 1
            link.resolve_cursor += 1
            link.match_failures = 0
            link.updated_at = _now()
            processed += 1
            session.commit()

    with _session() as session:
        link = session.scalar(select(SavedLink).where(
            SavedLink.id == link_id).with_for_update())
        if link is None or link.lease_token != token or link.game_names is None:
            return {"links": 0, "processed": processed, "matched": matched,
                    "remaining": 0, "complete": False, "cancelled": True}
        remaining = len(link.game_names) - link.resolve_cursor
        if remaining == 0:
            # Clean up deleted games even if they vanished during this pass.
            ids = list(dict.fromkeys(link.game_ids or []))
            live_ids = set(session.scalars(select(Game.id).where(Game.id.in_(ids))).all()) if ids else set()
            link.game_ids = [id_ for id_ in ids if id_ in live_ids]
            link.status = "ready"
            link.finished_at = _now()
        link.lease_token = None
        link.lease_until = None
        link.updated_at = _now()
        session.commit()
        return {"links": 1, "linkId": link_id, "processed": processed,
                "matched": matched, "remaining": remaining,
                "complete": remaining == 0}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("claim", "submit", "resolve"))
    parser.add_argument("--limit", type=int, default=1)
    parser.add_argument("--expect-environment", required=True,
                        choices=("staging", "production", "development"))
    args = parser.parse_args()
    current = os.getenv("VERCEL_ENV", "development")
    if current != args.expect_environment:
        parser.error(f"Environment mismatch: expected {args.expect_environment}, running {current}")
    try:
        if args.action == "claim":
            out = claim_jobs(args.limit)
        elif args.action == "resolve":
            out = resolve_games(args.limit)
        else:
            body = sys.stdin.read(64 * 1024 + 1)
            if len(body) > 64 * 1024:
                raise ValueError("Payload too large")
            out = submit_result(json.loads(body))
    except (ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
