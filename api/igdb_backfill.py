"""Explicit, bounded IGDB backfill for legacy cached games.

Never runs at API startup or from a Discovery request. Requires a migrated
PostgreSQL database and IGDB credentials; stage/prod must be targeted explicitly.
Example: python -m api.igdb_backfill --limit 120 --batch 8
"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import select

from api.games_routes import IGDB_GAME_FIELDS, _cache_igdb_games
from api.igdb_client import Priority, igdb_client
from api.models import Game
from api.security import _session


def backfill(*, limit: int, batch: int) -> tuple[int, int]:
    if not 1 <= limit <= 1000 or not 1 <= batch <= 20:
        raise ValueError("limit must be 1..1000, batch must be 1..20")
    with _session() as session:
        ids = list(session.scalars(
            select(Game.igdb_id)
            .where(Game.igdb_payload.is_(None))
            .order_by(Game.popularity_count.desc(), Game.id.desc())
            .limit(limit)
        ).all())

    updated = 0
    missing = 0
    for offset in range(0, len(ids), batch):
        chunk = ids[offset:offset + batch]
        # One IGDB request handles a bounded batch, then the existing search
        # cache pipeline updates normalized fields + complete JSONB payloads.
        rows = igdb_client.request(
            "games",
            f"fields {IGDB_GAME_FIELDS}; where id = ({','.join(map(str, chunk))}); limit {len(chunk)};",
            priority=Priority.BACKGROUND,
        )
        matching = [row for row in rows if isinstance(row.get("id"), int) and row["id"] in chunk]
        if matching:
            _cache_igdb_games(matching)
        updated += len(matching)
        missing += len(chunk) - len(matching)
        print(f"IGDB legacy backfill: {offset + len(chunk)}/{len(ids)} checked, {updated} stored", flush=True)
    return updated, missing


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill IGDB snapshots for legacy cached games")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--batch", type=int, default=8)
    args = parser.parse_args()
    try:
        updated, missing = backfill(limit=args.limit, batch=args.batch)
    except Exception as exc:
        print(f"IGDB backfill stopped: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(f"IGDB backfill completed: {updated} stored, {missing} missing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
