"""One-shot per-LINK queue worker, launched inside the chosen API container.

Only links and resolved catalog game IDs are durable. Extracted titles,
claims, cursors and tokens live in saved_link_jobs until completion/deletion.
No resident service, video downloads, browser, or HTTP user endpoint.
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

from api.models import Game, SavedLink, SavedLinkJob
from api.security import _now, _session

MAX_CLAIM_ATTEMPTS = 3
MAX_MATCH_ATTEMPTS = 3
MAX_GAMES = 80
CLAIM_LEASE_HOURS = 2
MATCH_LEASE_MINUTES = 5
MAX_TITLES_PER_PASS = 12
MAX_PASS_SECONDS = 120


def claim_jobs(limit: int = 1, *, only_id: int | None = None) -> dict:
    """Claim ONE source link, never individual game names."""
    if limit != 1:
        raise ValueError("Each ChatGPT claim processes exactly one link")
    now = _now()
    with _session() as session:
        # Retire abandoned third attempts, retaining link for the UI.
        abandoned = session.scalars(
            select(SavedLinkJob)
            .where(SavedLinkJob.phase == "claimed",
                   SavedLinkJob.lease_until <= now,
                   SavedLinkJob.attempts >= MAX_CLAIM_ATTEMPTS)
            .with_for_update(skip_locked=True)
        ).all()
        for job in abandoned:
            link = session.get(SavedLink, job.saved_link_id)
            if link:
                link.status = "failed"
                link.error = "Истекло время обработки ссылки."
                link.finished_at = now
                link.updated_at = now
            session.delete(job)
        query = (select(SavedLinkJob)
                 .join(SavedLink, SavedLink.id == SavedLinkJob.saved_link_id)
                 .where(
                     SavedLinkJob.attempts < MAX_CLAIM_ATTEMPTS,
                     or_(SavedLinkJob.phase == "pending",
                         and_(SavedLinkJob.phase == "claimed",
                              SavedLinkJob.lease_until <= now)),
                 )
                 .order_by(SavedLinkJob.id)
                 .limit(1).with_for_update(of=SavedLinkJob, skip_locked=True))
        if only_id is not None:
            query = query.where(SavedLink.id == only_id)
        job = session.scalar(query)
        if job is None:
            session.commit()
            return {"jobs": []}
        link = session.get(SavedLink, job.saved_link_id)
        job.phase = "claimed"
        job.attempts += 1
        job.lease_token = secrets.token_urlsafe(24)
        job.lease_until = now + timedelta(hours=CLAIM_LEASE_HOURS)
        link.status = "processing"
        link.error = None
        link.updated_at = now
        result = {"id": link.id, "url": link.url, "title": link.title,
                  "leaseToken": job.lease_token, "attempt": job.attempts}
        session.commit()
        return {"jobs": [result]}


def _validated_names(payload: dict) -> list[tuple[str, str]]:
    names = payload.get("games")
    if not isinstance(names, list) or len(names) > MAX_GAMES:
        raise ValueError("Expected at most 80 game titles")
    found, seen = [], set()
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
    """Keep GPT names only in disposable per-link job until matching finishes."""
    if not isinstance(payload, dict):
        raise ValueError("Expected JSON object")
    link_id, token = payload.get("id"), payload.get("leaseToken")
    if type(link_id) is not int or link_id <= 0 or not isinstance(token, str) or not token:
        raise ValueError("id and leaseToken are required")
    error = payload.get("error")
    if error is not None and (not isinstance(error, str) or not 1 <= len(error) <= 300):
        raise ValueError("error must be 1–300 characters")
    names = _validated_names(payload) if error is None else []
    now = _now()
    with _session() as session:
        job = session.scalar(select(SavedLinkJob).where(
            SavedLinkJob.saved_link_id == link_id,
        ).with_for_update())
        if job is None or job.lease_token != token:
            # Completed or deleted links have no queue record to write into.
            raise ValueError("Unknown/deleted link or stale claim token")
        if job.phase in ("resolving", "matching"):
            return {"saved": True, "idempotent": True, "id": link_id}
        if job.phase != "claimed" or not job.lease_until or job.lease_until <= now:
            raise ValueError("Claim has expired")
        link = session.get(SavedLink, link_id)
        if link is None:
            raise ValueError("Link has been deleted")
        if error is not None:
            if job.attempts >= MAX_CLAIM_ATTEMPTS:
                link.status = "failed"
                link.finished_at = now
                session.delete(job)
            else:
                link.status = "pending"
                job.phase = "pending"
                job.lease_token = None
                job.lease_until = None
            link.error = error
        else:
            job.names = [name for name, _ in names]
            job.resolved_ids = []
            job.cursor = 0
            job.match_failures = 0
            if not names:
                link.game_ids = []
                link.status = "ready"
                link.finished_at = now
                session.delete(job)
            else:
                link.status = "processing"
                job.phase = "resolving"
                job.lease_until = None
        link.updated_at = now
        session.commit()
        return {"saved": True, "idempotent": False, "id": link_id,
                "status": link.status, "gamesCount": len(names) if error is None else 0}


def _find_top_game_id(name: str) -> int | None:
    """Same title/alias/popularity rank as interactive search, local first."""
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
    ranked, _ = _ranked_igdb_search_rows(query, priority=Priority.BACKGROUND)
    if not ranked:
        return None
    cached = _cache_igdb_games([ranked[0]])
    return int(cached[0]["id"]) if cached else None


def resolve_games(limit: int = 1, *, only_id: int | None = None) -> dict:
    """Resolve ONE source link with all its titles, resumable on long articles.

    Work done outside the DB transaction; status/cursor/temp results are
    persisted after every name. Final commit moves resolved IDs to saved_links
    and deletes the entire job (including temporary GPT names).
    """
    if limit != 1:
        raise ValueError("Resolution processes exactly one link per invocation")
    now = _now()
    with _session() as session:
        query = (select(SavedLinkJob)
                 .join(SavedLink, SavedLink.id == SavedLinkJob.saved_link_id)
                 .where(or_(
                     SavedLinkJob.phase == "resolving",
                     and_(SavedLinkJob.phase == "matching",
                          SavedLinkJob.lease_until <= now),
                 ))
                 .order_by(SavedLinkJob.id).limit(1)
                 .with_for_update(of=SavedLinkJob, skip_locked=True))
        if only_id is not None:
            query = query.where(SavedLink.id == only_id)
        job = session.scalar(query)
        if job is None:
            return {"links": 0, "processed": 0, "matched": 0,
                    "remaining": 0, "complete": True}
        link_id, job_id = job.saved_link_id, job.id
        token = secrets.token_urlsafe(24)
        job.phase = "matching"
        job.lease_token = token
        job.lease_until = now + timedelta(minutes=MATCH_LEASE_MINUTES)
        session.commit()

    processed = matched = 0
    start = time.monotonic()
    while processed < MAX_TITLES_PER_PASS and time.monotonic() - start < MAX_PASS_SECONDS:
        with _session() as session:
            job = session.get(SavedLinkJob, job_id)
            if job is None or job.phase != "matching" or job.lease_token != token:
                return {"links": 0, "processed": processed, "matched": matched,
                        "remaining": 0, "complete": False, "cancelled": True}
            cursor = job.cursor
            names = job.names or []
            if cursor >= len(names):
                break
            name = names[cursor]

        candidate_id, temporary_error = None, False
        try:
            candidate_id = _find_top_game_id(name)
        except (HTTPException, SQLAlchemyError, OSError, ValueError):
            temporary_error = True

        with _session() as session:
            job = session.scalar(select(SavedLinkJob).where(
                SavedLinkJob.id == job_id,
            ).with_for_update())
            if (job is None or job.phase != "matching"
                    or job.lease_token != token):
                return {"links": 0, "processed": processed, "matched": matched,
                        "remaining": 0, "complete": False, "cancelled": True}
            link = session.get(SavedLink, link_id)
            if link is None:
                return {"links": 0, "processed": processed, "matched": matched,
                        "remaining": 0, "complete": False, "cancelled": True}
            if temporary_error or job.lease_until <= _now():
                job.match_failures += 1
                if job.match_failures < MAX_MATCH_ATTEMPTS:
                    job.phase = "resolving"
                    job.lease_token = None
                    job.lease_until = None
                    session.commit()
                    return {"links": 1, "linkId": link_id, "processed": processed,
                            "matched": matched, "remaining": len(job.names) - job.cursor,
                            "complete": False, "retry": True}
                link.error = "Некоторые названия не удалось найти в каталоге."
            elif candidate_id is not None:
                # Public game search returns IGDB IDs; store only local game PKs.
                game = session.scalar(select(Game).where(Game.igdb_id == candidate_id))
                if game is not None and game.id not in (job.resolved_ids or []):
                    job.resolved_ids = list(job.resolved_ids or []) + [game.id]
                    matched += 1
            job.cursor += 1
            job.match_failures = 0
            processed += 1
            session.commit()

    with _session() as session:
        job = session.scalar(select(SavedLinkJob).where(
            SavedLinkJob.id == job_id,
        ).with_for_update())
        if (job is None or job.phase != "matching"
                or job.lease_token != token):
            return {"links": 0, "processed": processed, "matched": matched,
                    "remaining": 0, "complete": False, "cancelled": True}
        remaining = len(job.names or []) - job.cursor
        if remaining == 0:
            link = session.get(SavedLink, link_id)
            if link is None:
                return {"links": 0, "processed": processed, "matched": matched,
                        "remaining": 0, "complete": False, "cancelled": True}
            # Exclude games that may have been deleted during this slow batch.
            ids = list(dict.fromkeys(job.resolved_ids or []))
            live_ids = set(session.scalars(select(Game.id).where(Game.id.in_(ids))).all()) if ids else set()
            link.game_ids = [game_id for game_id in ids if game_id in live_ids]
            link.status = "ready"
            link.finished_at = _now()
            link.updated_at = _now()
            session.delete(job)
        else:
            job.phase = "resolving"
            job.lease_token = None
            job.lease_until = None
        session.commit()
        return {"links": 1, "linkId": link_id, "processed": processed,
                "matched": matched, "remaining": remaining,
                "complete": remaining == 0}



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("claim", "submit", "resolve"))
    parser.add_argument("--limit", type=int, default=1)
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
            body = sys.stdin.read(64 * 1024 + 1)
            if len(body) > 64 * 1024:
                raise ValueError("Payload too large")
            output = submit_result(json.loads(body))
    except (ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
