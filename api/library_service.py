"""FastAPI-independent library and game serialization/query services."""
import json
import re
from decimal import Decimal, ROUND_HALF_UP
from sqlalchemy import case, func, select
from sqlalchemy.orm import selectinload
from api.models import (
    Collection, CollectionGame, Game, User, UserGame, WISHLIST_SLUG,
)

def _community_rating_map(session, game_ids: list[int]) -> dict[int, tuple[float, int]]:
    """Calculate one RateApp rating per user/game, excluding the seeded demo account."""
    if not game_ids:
        return {}

    rows = session.execute(
        select(UserGame.game_id, func.avg(UserGame.score), func.count(UserGame.id))
        .join(User, User.id == UserGame.user_id)
        .where(
            UserGame.game_id.in_(game_ids),
            UserGame.status.in_(("completed", "dropped")),
            UserGame.score.is_not(None),
            User.email != "demo@rateapp.local",
        )
        .group_by(UserGame.game_id)
    ).all()
    return {
        int(game_id): (float(Decimal(average).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)), int(count))
        for game_id, average, count in rows
    }


def _game_payload(
    game: Game, community_rating: tuple[float, int] | None = None,
) -> dict[str, object]:
    release_date = game.release_date.isoformat() if game.release_date else ""
    genres = json.loads(game.genres_json) if game.genres_json else []
    platforms = json.loads(game.platforms_json) if game.platforms_json else []
    title_parts = [part for part in re.split(r"\\s+", game.title.strip()) if part]
    glyph = "".join(part[0].upper() for part in title_parts[:2]) or "G"

    saved = json.loads(game.details_json) if game.details_json else None
    extras = saved if isinstance(saved, dict) else {}
    # Some legacy records predate the UI-ready details cache, but may already
    # have the entire raw IGDB snapshot. Use that locally without a network hop.
    raw = game.igdb_payload if isinstance(game.igdb_payload, dict) else {}
    # The IGDB prose stays untouched. A verified Russian translation is preferred
    # everywhere, but both language variants remain available to future clients.
    summary_en = str(extras.get("summary_en") or extras.get("summary") or raw.get("summary") or raw.get("storyline") or "")
    summary_ru = str(extras.get("summary_ru") or "") if extras.get("summary_ru_source") == summary_en else ""
    return {
        "storeLinks": extras.get("storeLinks", []),
        "trailerUrl": extras.get("trailerUrl"),
        "summary": summary_ru or summary_en,
        "summaryEn": summary_en,
        "summaryRu": summary_ru,
        "storyline": extras.get("storyline") or raw.get("storyline") or "",
        "storyHours": extras.get("storyHours"),
        "completionHours": extras.get("completionHours"),
        "id": game.igdb_id,
        "title": game.title,
        "genres": genres,
        "year": game.release_date.year if game.release_date else 0,
        "releaseDate": release_date,
        "developer": game.developer or "—",
        "platforms": platforms,
        "igdbRating": round(float(game.igdb_rating or 0)),
        "communityRating": community_rating[0] if community_rating else 0,
        "communityRatings": community_rating[1] if community_rating else 0,
        "accent": "#8cf27d",
        "accent2": "#2c6bff",
        "glyph": glyph,
        "coverUrl": game.cover_url,
    }

def _collection_slugs(session, user_game_id: int) -> list[str]:
    return list(
        session.scalars(
            select(Collection.slug)
            .join(CollectionGame, CollectionGame.collection_id == Collection.id)
            .where(CollectionGame.user_game_id == user_game_id)
            .order_by(Collection.id)
        ).all()
    )


def _serialize_entry(
    session,
    entry: UserGame,
    collection_ids: list[str] | None = None,
    community_rating: tuple[float, int] | None = None,
    collection_added_at: dict[str, str] | None = None,
) -> dict[str, object]:
    if collection_added_at is None:
        joined = session.execute(
            select(Collection.slug, CollectionGame.added_at)
            .join(Collection, Collection.id == CollectionGame.collection_id)
            .where(CollectionGame.user_game_id == entry.id)
        ).all()
        collection_added_at = {slug: timestamp.isoformat() for slug, timestamp in joined}
    return {
        "gameId": entry.game.igdb_id,
        "status": entry.status,
        "statusChangedAt": (
            (entry.status_changed_at or entry.added_at).isoformat()
            if entry.status in {"completed", "playing", "dropped"} else None
        ),
        "platform": entry.platform,
        "completedAt": entry.completed_at.isoformat() if entry.completed_at else None,
        "startedAt": entry.started_at.isoformat() if entry.started_at else None,
        "score": float(entry.score) if entry.score is not None else None,
        "atmosphereScore": float(entry.atmosphere_score) if entry.atmosphere_score is not None else None,
        "storyScore": float(entry.story_score) if entry.story_score is not None else None,
        "technologyScore": float(entry.technology_score) if entry.technology_score is not None else None,
        "gameplayScore": float(entry.gameplay_score) if entry.gameplay_score is not None else None,
        "review": entry.review,
        "collectionIds": collection_ids if collection_ids is not None else _collection_slugs(session, entry.id),
        "collectionAddedAt": collection_added_at,
        "addedAt": entry.added_at.date().isoformat(),
        "game": _game_payload(entry.game, community_rating),
    }


def _collections_payload(session, user: User) -> list[dict[str, object]]:
    rows = session.scalars(
        select(Collection)
        .where(Collection.user_id == user.id)
        .order_by(
            case((Collection.slug == WISHLIST_SLUG, 0), else_=1),
            func.lower(Collection.title),
            Collection.id,
        )
    ).all()
    return [
        {
            "id": row.slug,
            "title": row.title,
            "description": row.description or "",
            "mark": row.mark or "",
            "colorScheme": row.color_scheme,
            "iconData": row.icon_data,
            "emoji": row.emoji,
            "isSystem": row.is_system or row.slug == WISHLIST_SLUG,
        }
        for row in rows
    ]


def _library_payload(session, user: User) -> list[dict[str, object]]:
    rows = session.scalars(
        select(UserGame)
        .options(selectinload(UserGame.game))
        .where(UserGame.user_id == user.id)
        .order_by(UserGame.added_at.desc())
    ).all()

    memberships: dict[int, list[str]] = {row.id: [] for row in rows}
    membership_times: dict[int, dict[str, str]] = {row.id: {} for row in rows}
    if rows:
        pairs = session.execute(
            select(CollectionGame.user_game_id, Collection.slug, CollectionGame.added_at)
            .join(Collection, Collection.id == CollectionGame.collection_id)
            .where(CollectionGame.user_game_id.in_([row.id for row in rows]))
            .order_by(CollectionGame.user_game_id, Collection.id)
        ).all()
        for user_game_id, slug, timestamp in pairs:
            memberships.setdefault(user_game_id, []).append(slug)
            membership_times.setdefault(user_game_id, {})[slug] = timestamp.isoformat()

    ratings = _community_rating_map(session, [row.game_id for row in rows])
    return [
        _serialize_entry(
            session, row, memberships.get(row.id, []),
            ratings.get(row.game_id), membership_times.get(row.id, {}),
        )
        for row in rows
    ]
