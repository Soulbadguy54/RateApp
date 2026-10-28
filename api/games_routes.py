"""IGDB integration, search, metadata caching and genre endpoints.

IGDB owns the canonical external game ID; cached PostgreSQL records avoid
repeating external requests. All external calls have network timeouts.
"""
import json
import math
import os
import re
import threading
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request
from sqlalchemy import case, delete, func, or_, select, text
from sqlalchemy.exc import SQLAlchemyError

from api.security import _session, _current_user, _now
from api.library_service import _community_rating_map, _game_payload
from api.models import Game, GameAlias, GameGenre, Genre, GenreCatalogSync
from api.igdb_client import igdb_client, Priority

router = APIRouter()
_catalog_refresh_lock = threading.Lock()
_catalog_refresh_inflight: set[int] = set()

def _game_details_cache_days(release_date, *, today=None) -> int:
    """Refresh recently released/unreleased games more often than older titles.

    Details, stores and video links are refreshed lazily on a details request.
    Ratings/catalog metadata update only when explicitly fetched via IGDB search.
    """
    today = today or _now().date()
    if release_date is None:
        return 60
    age_days = (today - release_date).days
    if age_days < 30:
        return 7
    if age_days < 180:
        return 30
    if age_days < 730:
        return 90
    if age_days < 1825:
        return 180
    return 365


# Wildcard persists the complete returned IGDB Game object; expanded fields give
# human-readable values for fields our current UI needs. Other references stay
# in the raw JSONB payload for future batch enrichment, without lossy mapping.
IGDB_GAME_FIELDS = (
    "*,cover.image_id,alternative_names.name,genres.id,genres.name,"
    "platforms.name,involved_companies.developer,involved_companies.company.name,"
    "websites.url,videos.name,videos.video_id,artworks.image_id,screenshots.image_id,"
    "themes.name,keywords.name,game_modes.name,player_perspectives.name"
)


def _igdb_cover(image_id: str | None) -> str | None:
    if not image_id:
        return None
    return f"https://images.igdb.com/igdb/image/upload/t_cover_big_2x/{image_id}.jpg"


def _cache_igdb_games(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    with _session() as session:
        ids = [int(row["id"]) for row in rows]
        existing = {
            game.igdb_id: game
            for game in session.scalars(select(Game).where(Game.igdb_id.in_(ids))).all()
        }
        cached_games: list[Game] = []
        incoming_genres: dict[int, str] = {}
        incoming_game_genres: dict[int, list[int]] = {}

        for row in rows:
            igdb_id = int(row["id"])
            game = existing.get(igdb_id)
            if game is None:
                game = Game(igdb_id=igdb_id, title=str(row.get("name") or "Unknown"))
                session.add(game)
                existing[igdb_id] = game

            first_release = row.get("first_release_date")
            release_date = (
                datetime.fromtimestamp(int(first_release), tz=timezone.utc).date()
                if first_release
                else None
            )
            genres = [
                str(item.get("name"))
                for item in (row.get("genres") or [])
                if isinstance(item, dict) and item.get("name")
            ]
            platforms = [
                str(item.get("name"))
                for item in (row.get("platforms") or [])
                if isinstance(item, dict) and item.get("name")
            ]
            developers = []
            for item in row.get("involved_companies") or []:
                if not isinstance(item, dict) or not item.get("developer"):
                    continue
                company = item.get("company")
                if isinstance(company, dict) and company.get("name"):
                    developers.append(str(company["name"]))

            cover = row.get("cover")
            image_id = cover.get("image_id") if isinstance(cover, dict) else None

            game.title = str(row.get("name") or game.title)
            game.release_date = release_date
            game.igdb_rating = row.get("rating")
            game.popularity_count = max(
                int(row.get("total_rating_count") or 0),
                int(row.get("rating_count") or 0),
            )
            game.hype_count = int(row.get("hypes") or 0)
            game.cover_url = _igdb_cover(str(image_id)) if image_id else None
            game.developer = developers[0] if developers else None
            game.genres_json = json.dumps(genres, ensure_ascii=False)
            if "genres" in row:
                genre_ids: list[int] = []
                for genre_row in row.get("genres") or []:
                    if not isinstance(genre_row, dict):
                        continue
                    gid, name = genre_row.get("id"), genre_row.get("name")
                    if isinstance(gid, int) and isinstance(name, str) and name.strip():
                        incoming_genres[gid] = name.strip()
                        genre_ids.append(gid)
                incoming_game_genres[igdb_id] = list(dict.fromkeys(genre_ids))
            game.platforms_json = json.dumps(platforms, ensure_ascii=False)
            game.cached_at = _now()

            # Retain every field returned by IGDB verbatim. Incremental/legacy
            # lookups are merged rather than deleting previously cached fields.
            game.igdb_payload = {**(game.igdb_payload or {}), **row}

            # Details belong in PostgreSQL at SEARCH/IMPORT time, not at the
            # moment a user expands a card. Keep existing playtime on refresh.
            previous = json.loads(game.details_json) if game.details_json else None
            previous = previous if isinstance(previous, dict) else {}
            details = dict(previous)
            if "websites" in row:
                details["storeLinks"] = _safe_store_links(row.get("websites"))
            if "videos" in row:
                details["trailerUrl"] = _safe_trailer_url(row.get("videos"))
            if "summary" in row or "storyline" in row:
                source_en = str(row.get("summary") or row.get("storyline") or "")
                if details.get("summary_ru_source") != source_en:
                    details.pop("summary_ru", None)
                    details.pop("summary_ru_source", None)
                details["summary"] = source_en  # Legacy raw IGDB field.
                details["summary_en"] = source_en
                details["storyline"] = str(row.get("storyline") or "")
                details.pop("_linksOnly", None)
            if "game_time_to_beats" in row and isinstance(row["game_time_to_beats"], dict):
                details["storyHours"] = _hours_from_igdb(row["game_time_to_beats"].get("hastily"))
                details["completionHours"] = _hours_from_igdb(row["game_time_to_beats"].get("completely"))
            game.details_json = json.dumps(details, ensure_ascii=False)
            game.details_cached_at = _now()

            cached_games.append(game)

        session.flush()
        if incoming_genres:
            session.execute(text("""
                INSERT INTO genres (id, name) VALUES (:id, :name)
                ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
            """), [{"id":gid, "name":name} for gid, name in incoming_genres.items()])
        if incoming_game_genres:
            affected = [existing[igdb_id].id for igdb_id in incoming_game_genres]
            session.execute(delete(GameGenre).where(GameGenre.game_id.in_(affected)))
            session.add_all(
                GameGenre(game_id=existing[igdb_id].id, genre_id=gid)
                for igdb_id, ids in incoming_game_genres.items()
                for gid in ids
            )
            session.flush()

        for row in rows:
            # Persist publisher/IGDB-provided alternative names, not handcrafted
            # abbreviations or special cases for individual games.
            if "alternative_names" not in row:
                continue
            game = existing[int(row["id"])]
            session.execute(delete(GameAlias).where(GameAlias.game_id == game.id))
            seen = {game.title.casefold()}
            for alternative in row.get("alternative_names") or []:
                name = alternative.get("name", "").strip() if isinstance(alternative, dict) else ""
                if not name or len(name) > 255 or name.casefold() in seen:
                    continue
                seen.add(name.casefold())
                session.add(GameAlias(game_id=game.id, name=name))

        ratings = _community_rating_map(session, [game.id for game in cached_games])
        cached = [_game_payload(game, ratings.get(game.id)) for game in cached_games]
        session.commit()
        return cached


def _normalized_search_text(value: str) -> str:
    return re.sub(r"[^\w]+", " ", value.casefold(), flags=re.UNICODE).strip()


def _local_game_search(session, query: str, offset: int) -> dict[str, object]:
    """Rank cached games in PostgreSQL using indexed trigram similarity.

    Both game titles and their IGDB-provided alternative names participate.
    Title relevance wins; popularity breaks near ties. No franchise-specific
    mappings are involved.
    """
    search_text = _normalized_search_text(query)
    if not search_text:
        return {"items": [], "hasMore": False, "nextOffset": None}

    title = func.lower(Game.title)
    alias = func.lower(GameAlias.name)

    def relevance(name):
        return func.greatest(
            func.similarity(name, search_text),
            func.word_similarity(search_text, name),
        )

    alias_best = (
        select(func.max(relevance(alias)))
        .where(GameAlias.game_id == Game.id)
        .correlate(Game)
        .scalar_subquery()
    )
    score = func.greatest(relevance(title), func.coalesce(alias_best, 0.0))
    exact_alias = (
        select(GameAlias.id)
        .where(GameAlias.game_id == Game.id, alias == search_text)
        .correlate(Game)
        .exists()
    )
    popularity = (
        func.ln(1 + Game.popularity_count)
        + func.ln(1 + Game.hype_count) * 0.65
    )
    # PostgreSQL can use our GIN pg_trgm indexes to shortlist candidates,
    # instead of scoring every game and every alias on a full table scan.
    alias_candidate = (
        select(GameAlias.id)
        .where(
            GameAlias.game_id == Game.id,
            or_(alias.op("%")(search_text), alias.op("%>")(search_text)),
        )
        .correlate(Game)
        .exists()
    )
    title_candidate = or_(
        title.op("%")(search_text), title.op("%>")(search_text),
    )
    rows = session.scalars(
        select(Game)
        .where(or_(title_candidate, alias_candidate), score >= 0.32)
        .order_by(
            case(
                (title == search_text, 0),
                (exact_alias, 0),
                (title.startswith(search_text), 1),
                else_=2,
            ),
            (score + popularity * 0.012).desc(),
            popularity.desc(),
            Game.id,
        )
        .offset(offset)
        .limit(GAME_SEARCH_PAGE_SIZE + 1)
    ).all()
    has_more = len(rows) > GAME_SEARCH_PAGE_SIZE
    games = rows[:GAME_SEARCH_PAGE_SIZE]
    ratings = _community_rating_map(session, [game.id for game in games])
    return {
        "items": [_game_payload(game, ratings.get(game.id)) for game in games],
        "hasMore": has_more,
        "nextOffset": offset + GAME_SEARCH_PAGE_SIZE if has_more else None,
    }


def _igdb_search_body(query: str, offset: int) -> str:
    # The IGDB search command is documented as similarity-ranked by IGDB.
    # It is not advertised as typo-tolerant, unlike our PostgreSQL search.
    safe_query = json.dumps(query.replace(";", " "), ensure_ascii=False)[1:-1]
    return (
        f"fields {IGDB_GAME_FIELDS}; "
        f'search "{safe_query}"; '
        "where version_parent = null; "
        f"limit {GAME_SEARCH_PAGE_SIZE + 1}; offset {offset};"
    )


def _sync_genre_catalog() -> int:
    rows = _igdb_details_request(
        "genres", "fields id,name; sort id asc; limit 500;", priority=Priority.BACKGROUND,
    )
    valid = [
        {"id": item["id"], "name": item["name"].strip()}
        for item in rows
        if isinstance(item.get("id"), int)
        and isinstance(item.get("name"), str)
        and item["name"].strip()
    ]
    if not valid:
        raise HTTPException(status_code=502, detail="IGDB не вернул список жанров.")
    with _session() as session:
        session.execute(text("""
            INSERT INTO genres (id, name) VALUES (:id, :name)
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
        """), valid)
        session.execute(text("""
            INSERT INTO game_genres (game_id, genre_id)
            SELECT g.id, t.id
            FROM games AS g
            CROSS JOIN LATERAL jsonb_array_elements_text(
                COALESCE(NULLIF(g.genres_json, ''), '[]')::jsonb
            ) AS legacy(name)
            JOIN genres AS t ON lower(t.name) = lower(legacy.name)
            ON CONFLICT (game_id, genre_id) DO NOTHING
        """))
        session.execute(text("""
            INSERT INTO genre_catalog_sync (id, refreshed_at)
            VALUES (1, now())
            ON CONFLICT (id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at
        """))
        session.commit()
    return len(valid)


@router.get("/api/genres")
def list_genres(request: Request) -> list[dict[str, object]]:
    with _session() as session:
        _current_user(request, session)
        stamp = session.get(GenreCatalogSync, 1)
        outdated = stamp is None or (
            _now() - stamp.refreshed_at.replace(
                tzinfo=stamp.refreshed_at.tzinfo or timezone.utc
            ) > timedelta(days=30)
        )
    if outdated:
        try:
            _sync_genre_catalog()
        except (HTTPException, SQLAlchemyError):
            # Offline fallback: existing genres remain filterable.
            pass
    with _session() as session:
        _current_user(request, session)
        rows = session.scalars(select(Genre).order_by(Genre.name, Genre.id)).all()
        return [{"id": row.id, "name": row.name} for row in rows]


@router.get("/api/games/igdb-status")
def igdb_status(request: Request) -> dict[str, bool]:
    with _session() as session:
        _current_user(request, session)
    return {
        "configured": bool(
            os.getenv("IGDB_CLIENT_ID", "").strip()
            and os.getenv("IGDB_CLIENT_SECRET", "").strip()
        )
    }


GAME_SEARCH_PAGE_SIZE = 20



STORE_DOMAINS = (
    ("steampowered.com", "steam", "Steam"),
    ("epicgames.com", "epic", "Epic Games"),
    ("gog.com", "gog", "GOG"),
    ("itch.io", "itch", "itch.io"),
    ("playstation.com", "playstation", "PlayStation Store"),
    ("xbox.com", "xbox", "Xbox"),
    ("microsoft.com", "xbox", "Microsoft Store"),
    ("nintendo.com", "nintendo", "Nintendo eShop"),
)


def _igdb_details_request(
    endpoint: str, body: str, *, priority: Priority = Priority.DETAILS,
) -> list[dict[str, object]]:
    return igdb_client.request(endpoint, body, priority=priority)


def _refresh_game_catalog_entry(game_id: int) -> None:
    """Best-effort, low-priority, on-demand refresh of stale game metadata.

    Never blocks the rendered details response and never changes user ratings.
    Dedupe concurrent detail views; the recheck prevents redundant fetches.
    """
    with _catalog_refresh_lock:
        if game_id in _catalog_refresh_inflight:
            return
        _catalog_refresh_inflight.add(game_id)
    try:
        with _session() as session:
            game = session.scalar(select(Game).where(Game.igdb_id == game_id))
            if game is None:
                return
            stamp = game.cached_at
            if stamp and stamp.replace(tzinfo=stamp.tzinfo or timezone.utc) > (
                _now() - timedelta(days=_game_details_cache_days(game.release_date))
            ):
                return
        rows = _igdb_details_request(
            "games",
            f"fields {IGDB_GAME_FIELDS}; "
            f"where id = {game_id} & version_parent = null; limit 1;",
            priority=Priority.BACKGROUND,
        )
        if rows:
            _cache_igdb_games(rows)
    except (HTTPException, SQLAlchemyError):
        # Cached catalog metadata remains usable even when IGDB is unavailable.
        pass
    finally:
        with _catalog_refresh_lock:
            _catalog_refresh_inflight.discard(game_id)


def _safe_store_links(websites: object) -> list[dict[str, str]]:
    if not isinstance(websites, list):
        return []

    stores: dict[str, dict[str, str]] = {}
    for website in websites:
        if not isinstance(website, dict):
            continue
        raw_url = website.get("url")
        if not isinstance(raw_url, str):
            continue
        try:
            parsed = urlsplit(raw_url)
        except ValueError:
            continue
        if parsed.scheme != "https" or parsed.username or parsed.password:
            continue
        host = (parsed.hostname or "").lower()
        for domain, provider, label in STORE_DOMAINS:
            if host == domain or host.endswith(f".{domain}"):
                stores.setdefault(provider, {
                    "provider": provider, "label": label, "url": raw_url,
                })
                break

    return list(stores.values())[:6]


def _safe_trailer_url(videos: object) -> str | None:
    if not isinstance(videos, list):
        return None
    candidates = [video for video in videos if isinstance(video, dict)]
    candidates.sort(
        key=lambda item: 0 if "trailer" in str(item.get("name") or "").casefold() else 1,
    )
    for candidate in candidates:
        video_id = candidate.get("video_id")
        if isinstance(video_id, str) and re.fullmatch(r"[a-zA-Z0-9_-]{11}", video_id):
            return f"https://www.youtube.com/watch?v={video_id}"
    return None


def _hours_from_igdb(value: object) -> int | None:
    # game_time_to_beats values are in seconds, not minutes.
    try:
        seconds = float(value) if value is not None else 0
    except (TypeError, ValueError):
        return None
    if not math.isfinite(seconds) or seconds <= 0:
        return None
    return max(1, round(seconds / 3600))


def _detail_response(session, game: Game, details: dict[str, object]) -> dict[str, object]:
    ratings = _community_rating_map(session, [game.id])
    payload = _game_payload(game, ratings.get(game.id))
    return {
        **details, "summary": payload["summary"],
        "summaryEn": payload["summaryEn"], "summaryRu": payload["summaryRu"],
        "game": payload,
    }


@router.get("/api/games/{game_id}/details")
def game_details(game_id: int, request: Request) -> dict[str, object]:
    """Read only local PostgreSQL. Never wait for IGDB when a sheet is opened.

    Older catalog rows without complete metadata return the saved subset until
    explicitly enriched by the catalog backfill/import workflow.
    """
    with _session() as session:
        _current_user(request, session)
        game = session.scalar(select(Game).where(Game.igdb_id == game_id))
        if game is None:
            raise HTTPException(status_code=404, detail="Игра не найдена в нашей базе.")
        cached = json.loads(game.details_json) if game.details_json else None
        details = cached if isinstance(cached, dict) else {}
        return _detail_response(session, game, details)


def _ranked_igdb_search_rows(
    query: str, offset: int = 0, *, priority: Priority = Priority.SEARCH,
) -> tuple[list[dict[str, object]], bool]:
    """Same IGDB candidates and popularity/relevance order as /api/games/search.

    Return raw rows so background matching only caches the winning game,
    instead of writing 20 candidates into the shared catalog per title.
    """
    # Shared search behavior; caller chooses which returned games to cache.
    body = _igdb_search_body(query, offset)
    rows = igdb_client.request("games", body, priority=priority)

    # If IGDB's title search misses, its /search index also includes
    # alternative-name records pointing back to the parent game.
    if not rows and offset == 0:
        escaped = json.dumps(query.replace(";", " "), ensure_ascii=False)[1:-1]
        try:
            matches = igdb_client.request(
                "search",
                f'fields game,alternative_name,name; search "{escaped}"; where game != null; limit 20;',
                priority=priority,
            )
            ids = list(dict.fromkeys(
                int(item["game"]) for item in matches
                if isinstance(item, dict) and isinstance(item.get("game"), int)
            ))[:20]
            if ids:
                rows = igdb_client.request(
                    "games",
                    f"fields {IGDB_GAME_FIELDS}; "
                    f"where id = ({','.join(map(str, ids))}) & version_parent = null; limit 20;",
                    priority=priority,
                )
        except HTTPException:
            # Interactive search keeps the established best-effort fallback.
            # The background resolver must retry transient IGDB failures, not
            # permanently label a title "no match" on a provider outage.
            if priority == Priority.BACKGROUND:
                raise
            pass

    has_more = len(rows) > GAME_SEARCH_PAGE_SIZE and offset + GAME_SEARCH_PAGE_SIZE < 10000
    # IGDB first selects textually similar candidates. Within the returned
    # page, prioritize exact titles/aliases and use popularity to break ties.
    # Pagination remains tied to IGDB's offset, not our database.
    normalized = _normalized_search_text(query)

    def page_rank(row: dict[str, object]) -> tuple[int, float]:
        names = [str(row.get("name") or "")]
        names.extend(
            str(alt.get("name") or "") for alt in row.get("alternative_names") or []
            if isinstance(alt, dict)
        )
        names = [_normalized_search_text(name) for name in names]
        exact = int(normalized in names)
        prefix = int(any(name.startswith(normalized) for name in names))
        popularity = math.log1p(max(
            int(row.get("total_rating_count") or 0),
            int(row.get("rating_count") or 0),
        )) + math.log1p(int(row.get("hypes") or 0)) * 0.65
        return (exact * 2 + prefix, popularity)

    page_rows = sorted(rows[:GAME_SEARCH_PAGE_SIZE], key=page_rank, reverse=True)
    return page_rows, has_more


@router.get("/api/games/search")
def search_games(
    request: Request,
    q: str = Query(max_length=100),
    source: Literal["local", "igdb"] = "local",
    offset: int = Query(default=0, ge=0, le=10000),
) -> dict[str, object]:
    query = q.strip()
    if len(query) < 3:
        return {"items": [], "hasMore": False, "nextOffset": None}

    with _session() as session:
        _current_user(request, session)
        if source == "local":
            return _local_game_search(session, query, offset)

    if offset >= 10000:
        return {"items": [], "hasMore": False, "nextOffset": None}

    # External search runs after an empty local search or a manual deep search.
    # Cache all first-page candidates for the interactive search UI as before.
    page_rows, has_more = _ranked_igdb_search_rows(query, offset)
    cached = _cache_igdb_games(page_rows) if page_rows else []
    return {
        "items": cached,
        "hasMore": has_more,
        "nextOffset": offset + GAME_SEARCH_PAGE_SIZE if has_more else None,
    }


