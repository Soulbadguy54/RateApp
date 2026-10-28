"""One-shot Gateway-compatible queue CLI, executed inside API container.

No long-running background process. Matching makes only bounded IGDB calls. Connect to a particular
database by choosing that environment's container; --expect-environment prevents
accidental cross-environment queue consumption.
"""
import argparse
import json
import os
import secrets
import sys
import unicodedata
from datetime import timedelta

from sqlalchemy import and_, or_, select, update
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError

from api.models import Game, SavedLink, SavedLinkGame
from api.security import _now, _session

MAX_ATTEMPTS = 3
MAX_BATCH = 3
MAX_GAMES = 80
LEASE_HOURS = 2
MAX_RESOLVE_BATCH = 4
MAX_MATCH_ATTEMPTS = 3
MATCH_LEASE_MINUTES = 15


def claim_jobs(limit: int = MAX_BATCH, *, only_id: int | None = None) -> dict:
    if not 1 <= limit <= MAX_BATCH:
        raise ValueError("Batch must contain 1–3 links")
    now = _now()
    with _session() as session:
        # Expired third attempt must not remain processing forever.
        session.execute(update(SavedLink).where(
            SavedLink.status == "processing",
            SavedLink.lease_until <= now,
            SavedLink.attempts >= MAX_ATTEMPTS,
        ).values(status="failed", error="Превышено число попыток обработки.",
                 lease_token=None, lease_until=None, updated_at=now, finished_at=now))
        query = (select(SavedLink)
                 .where(SavedLink.attempts < MAX_ATTEMPTS,
                        or_(SavedLink.status == "pending",
                            and_(SavedLink.status == "processing", SavedLink.lease_until <= now)))
                 .order_by(SavedLink.id)
                 .limit(limit)
                 .with_for_update(skip_locked=True))
        if only_id is not None:
            query = query.where(SavedLink.id == only_id)
        rows = session.scalars(query).all()
        items = []
        for row in rows:
            row.status = "processing"
            row.attempts += 1
            row.lease_token = secrets.token_urlsafe(24)
            row.lease_until = now + timedelta(hours=LEASE_HOURS)
            row.updated_at = now
            row.error = None
            items.append({"id": row.id, "url": row.url, "title": row.title,
                          "leaseToken": row.lease_token, "attempt": row.attempts})
        session.commit()
        return {"jobs": items}


def _validated_names(payload: dict) -> list[tuple[str, str]]:
    names = payload.get("games")
    if not isinstance(names, list) or len(names) > MAX_GAMES:
        raise ValueError("Expected a list of at most 80 game titles")
    found = []
    seen = set()
    for value in names:
        if not isinstance(value, str):
            raise ValueError("Game title must be a string")
        name = " ".join(unicodedata.normalize("NFKC", value).split())
        if not 1 <= len(name) <= 255:
            raise ValueError("Game title length must be 1–255 characters")
        normalized = name.casefold()
        if normalized not in seen:
            seen.add(normalized)
            found.append((name, normalized))
    return found


def submit_result(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    link_id = payload.get("id")
    token = payload.get("leaseToken")
    if type(link_id) is not int or link_id <= 0 or not isinstance(token, str) or not token:
        raise ValueError("id and leaseToken are required")
    error = payload.get("error")
    if error is not None and (not isinstance(error, str) or not 1 <= len(error) <= 300):
        raise ValueError("error must be 1–300 characters")
    games = _validated_names(payload) if error is None else []
    now = _now()
    with _session() as session:
        link = session.scalar(select(SavedLink).where(SavedLink.id == link_id).with_for_update())
        if link is None or link.lease_token != token:
            raise ValueError("Unknown link ID or lease token")
        if link.status == "ready":
            return {"saved": True, "idempotent": True, "id": link.id}
        if link.status != "processing" or link.lease_until is None or link.lease_until <= now:
            raise ValueError("Lease expired or job not processing")
        if error is not None:
            link.status = "failed" if link.attempts >= MAX_ATTEMPTS else "pending"
            link.error = error
            link.finished_at = now if link.status == "failed" else None
            link.lease_token = None
            link.lease_until = None
        else:
            for old in list(link.games):
                session.delete(old)
            session.flush()
            for name, normalized in games:
                session.add(SavedLinkGame(saved_link_id=link.id, name=name,
                                          normalized_name=normalized))
            link.status = "ready"
            link.finished_at = now
            link.error = None
            link.lease_until = None
            # Retain token only for safe idempotent replay; never expose via HTTP.
        link.updated_at = now
        session.commit()
        return {"saved": True, "idempotent": False, "id": link.id,
                "status": link.status, "gamesCount": len(games) if error is None else 0}


def _find_top_game_id(name: str) -> int | None:
    """The search box's local-first strategy and identical ranking.

    Use local trigram/title/alias/popularity order. On a miss, use the same
    IGDB first-page ranking/fallback; cache ONLY the winner to save resources.
    """
    from api.games_routes import (
        _local_game_search, _ranked_igdb_search_rows, _cache_igdb_games,
    )
    from api.igdb_client import Priority

    query = name.strip()[:100]
    if len(query) < 3:
        return None
    with _session() as session:
        local = _local_game_search(session, query, 0)["items"]
        if local:
            return int(local[0]["id"])
    rows, _ = _ranked_igdb_search_rows(query, priority=Priority.BACKGROUND)
    if not rows:
        return None
    cached = _cache_igdb_games([rows[0]])
    return int(cached[0]["id"]) if cached else None


def resolve_games(limit: int = MAX_RESOLVE_BATCH, *, only_id: int | None = None) -> dict:
    """Bounded matching pass: short leases, no DB locks held during IGDB I/O."""
    if not 1 <= limit <= MAX_RESOLVE_BATCH:
        raise ValueError("Resolution batch must contain 1–4 titles")
    now = _now()
    with _session() as session:
        session.execute(update(SavedLinkGame).where(
            SavedLinkGame.game_id.is_(None),
            SavedLinkGame.match_status == "resolving",
            SavedLinkGame.match_lease_until <= now,
            SavedLinkGame.match_attempts >= MAX_MATCH_ATTEMPTS,
        ).values(match_status="failed", match_lease_token=None,
                 match_lease_until=None, match_error="Превышен лимит попыток поиска."))
        stmt = (select(SavedLinkGame)
                .join(SavedLink, SavedLink.id == SavedLinkGame.saved_link_id)
                .where(
                    SavedLink.status == "ready",
                    SavedLinkGame.game_id.is_(None),
                    SavedLinkGame.match_attempts < MAX_MATCH_ATTEMPTS,
                    or_(
                        SavedLinkGame.match_status == "pending",
                        and_(SavedLinkGame.match_status == "resolving",
                             SavedLinkGame.match_lease_until <= now),
                    ),
                )
                .order_by(SavedLinkGame.id)
                .limit(limit)
                .with_for_update(of=SavedLinkGame, skip_locked=True))
        if only_id is not None:
            stmt = stmt.where(SavedLinkGame.id == only_id)
        entries = session.scalars(stmt).all()
        jobs = []
        for entry in entries:
            entry.match_status = "resolving"
            entry.match_attempts += 1
            entry.match_lease_token = secrets.token_urlsafe(24)
            entry.match_lease_until = now + timedelta(minutes=MATCH_LEASE_MINUTES)
            entry.match_error = None
            jobs.append((entry.id, entry.name, entry.match_lease_token))
        session.commit()

    output = {"claimed": len(jobs), "matched": 0, "noMatch": 0, "retry": 0, "failed": 0}
    for entry_id, name, token in jobs:
        matched_id = None
        temporary_error = False
        try:
            matched_id = _find_top_game_id(name)
        except (HTTPException, SQLAlchemyError, OSError, ValueError):
            temporary_error = True
        with _session() as session:
            entry = session.scalar(
                select(SavedLinkGame).where(SavedLinkGame.id == entry_id).with_for_update()
            )
            if (entry is None or entry.match_status != "resolving"
                    or entry.match_lease_token != token):
                continue
            if entry.game_id is not None:
                entry.match_status = "matched"
                state = "matched"
            elif temporary_error or entry.match_lease_until <= _now():
                if entry.match_attempts >= MAX_MATCH_ATTEMPTS:
                    entry.match_status = "failed"
                    state = "failed"
                else:
                    entry.match_status = "pending"
                    state = "retry"
                entry.match_error = "Временная ошибка поиска в каталоге."
            elif matched_id is None:
                entry.match_status = "no_match"
                state = "noMatch"
            else:
                game = session.scalar(select(Game).where(Game.igdb_id == matched_id))
                if game is None:
                    entry.match_status = ("failed" if entry.match_attempts >= MAX_MATCH_ATTEMPTS
                                          else "pending")
                    entry.match_error = "Игра отсутствует в локальном каталоге."
                    state = "failed" if entry.match_status == "failed" else "retry"
                else:
                    entry.game_id = game.id
                    entry.match_status = "matched"
                    state = "matched"
            entry.match_lease_token = None
            entry.match_lease_until = None
            session.commit()
            output[state] += 1
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("claim", "submit", "resolve"))
    parser.add_argument("--limit", type=int, default=MAX_BATCH)
    parser.add_argument("--expect-environment", required=True,
                        choices=("staging", "production", "development"))
    args = parser.parse_args()
    current_env = os.getenv("VERCEL_ENV", "development")
    if current_env != args.expect_environment:
        parser.error(f"Environment mismatch: expected {args.expect_environment}, running {current_env}")
    try:
        if args.action == "claim":
            output = claim_jobs(args.limit)
        elif args.action == "resolve":
            output = resolve_games(args.limit)
        else:
            # Limit the size of Gateway-submitted JSON; no arbitrary commands.
            body = sys.stdin.read(64 * 1024 + 1)
            if len(body) > 64 * 1024:
                raise ValueError("Payload too large")
            output = submit_result(json.loads(body))
    except (ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
