import base64
import binascii
import hashlib
import json
import math
import os
import re
import secrets
import time
from urllib.parse import urlsplit
from datetime import date, datetime, timedelta, timezone
from typing import Literal

import httpx
import sentry_sdk
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field, model_validator
from sqlalchemy import case, delete, func, or_, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import selectinload

from api.auth_routes import router as auth_router, RegisterPayload, LoginPayload
from api.library_routes import router as library_router
from api.collection_routes import router as collection_router
from api.push_routes import router as push_router
from api.games_routes import router as games_router, _cache_igdb_games
from api.discovery_routes import router as discovery_router
from api.library_service import (
    _community_rating_map, _game_payload, _collection_slugs,
    _serialize_entry, _collections_payload, _library_payload,
)
from api.collections_service import _ensure_wishlist_collection
from api.security import (
    PIN_RE, NICK_RE, SESSION_COOKIE, password_hasher,
    _session, _now, _hash_token, _current_user, _create_session,
    _check_throttle, _record_login_failure, _clear_throttle, _user_payload,
)
from api.data_integrity import playthrough_integrity_summary
from api.push import push_ready, send_push, valid_push_endpoint
from api.database import SessionLocal, engine
from api.models import (
    AuthSession,
    Collection,
    CollectionGame,
    Game,
    GameAlias,
    Genre,
    GameGenre,
    GenreCatalogSync,
    LoginThrottle,
    PushSubscription,
    ReleasePushDelivery,
    User,
    UserGame,
    WISHLIST_SLUG, WISHLIST_TITLE, WISHLIST_DESCRIPTION, WISHLIST_MARK,
)

# Reporting is opt-in. Disable automatic request-body and PII collection.
if os.getenv("SENTRY_DSN"):
    sentry_sdk.init(
        dsn=os.environ["SENTRY_DSN"],
        environment=os.getenv("VERCEL_ENV", "development"),
        send_default_pii=False,
        max_request_body_size="never",
        traces_sample_rate=0,
    )

app = FastAPI(
    title="RateApp API",
    version="0.3.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.include_router(auth_router)
app.include_router(library_router)
app.include_router(collection_router)
app.include_router(push_router)
app.include_router(games_router)
app.include_router(discovery_router)

# Database schema is upgraded by `alembic upgrade head` outside the request path.
# Never run schema changes at cold start: one malformed historic row can break login.

class LibraryPayload(BaseModel):
    gameId: int | None = None
    status: Literal["completed", "playing", "wishlist", "dropped"]
    platform: str | None = Field(default=None, max_length=80)
    completedAt: date | None = None
    startedAt: date | None = None
    score: float | None = Field(default=None, ge=1, le=10)
    atmosphereScore: float | None = Field(default=None, ge=1, le=10)
    storyScore: float | None = Field(default=None, ge=1, le=10)
    technologyScore: float | None = Field(default=None, ge=1, le=10)
    gameplayScore: float | None = Field(default=None, ge=1, le=10)
    review: str | None = Field(default=None, max_length=5000)
    collectionIds: list[str] = Field(default_factory=list, max_length=100)
    addedAt: date | None = None

    @model_validator(mode="after")
    def validate_playthrough(self):
        rated = self.status in {"completed", "dropped"}
        self.platform = (self.platform or "").strip() or None
        criteria = (self.atmosphereScore, self.storyScore, self.technologyScore, self.gameplayScore)

        if rated and self.platform is None:
            raise ValueError("Выберите платформу для прохождения.")
        if rated:
            if self.completedAt is None:
                raise ValueError("Для пройденной или дропнутой игры обязательна дата.")
            if any(value is None for value in criteria):
                raise ValueError("Для статуса «Пройдено» или «Дропнуто» обязательны все четыре оценки.")
            if self.startedAt is not None:
                raise ValueError("Дата начала допустима только для статуса «Прохожу».")
        else:
            if any(value is not None for value in criteria) or self.score is not None:
                raise ValueError("Оценки допустимы только для «Пройдено» и «Дропнуто».")
            if self.completedAt is not None:
                raise ValueError("Дата окончания допустима только для «Пройдено» и «Дропнуто».")
            if self.status != "playing" and (self.startedAt is not None or self.platform is not None):
                raise ValueError("У списка желаемого не может быть даты или платформы прохождения.")
            if self.review:
                raise ValueError("Отзыв допустим только для оценённых прохождений.")
        return self


@app.get("/api/health")
def health(response: Response) -> dict[str, object]:
    database_configured = engine is not None
    database_ok = False
    integrity_report = None

    if engine is not None:
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1"))
                if os.getenv("VERCEL_ENV") == "production":
                    integrity_report = playthrough_integrity_summary(connection)
            database_ok = True
        except SQLAlchemyError:
            database_ok = False

    if not database_ok:
        response.status_code = 503
    return {
        "ok": database_ok,
        "service": "rateapp-api",
        "database": {"configured": database_configured, "reachable": database_ok},
        "igdb": {
            "configured": bool(
                os.getenv("IGDB_CLIENT_ID", "").strip()
                and os.getenv("IGDB_CLIENT_SECRET", "").strip()
            )
        },
        "environment": os.getenv("VERCEL_ENV", "local"),
        "playthroughIntegrity": integrity_report,
    }


@app.get("/api")
def api_root() -> dict[str, str]:
    return {"name": "RateApp API", "status": "ok", "docs": "/api/docs"}


@app.get("/api/bootstrap")
def bootstrap(request: Request) -> dict[str, object]:
    with _session() as session:
        user = _current_user(request, session)
        _ensure_wishlist_collection(session, user.id)
        session.commit()
        return {
            "user": _user_payload(user),
            "library": _library_payload(session, user),
            "collections": _collections_payload(session, user),
        }


@app.get("/api/games/{game_id}/community-rating")
def get_community_rating(game_id: int, request: Request, response: Response) -> dict[str, object]:
    """Fresh, inexpensive aggregate for the game detail page.

    This query is independent from IGDB enrichment and browser search caches.
    The user's just-committed rating and other recent ratings both count.
    """
    response.headers["Cache-Control"] = "no-store"
    with _session() as session:
        _current_user(request, session)
        game = session.scalar(select(Game).where(Game.igdb_id == game_id))
        if game is None:
            raise HTTPException(status_code=404, detail="Игра не найдена.")
        rating, voters = _community_rating_map(session, [game.id]).get(game.id, (0.0, 0))
        return {"gameId": game_id, "communityRating": rating, "communityRatings": voters}


@app.get("/api/users/{nickname}")
def public_profile(nickname: str) -> dict[str, object]:
    with _session() as session:
        user = session.scalar(select(User).where(User.nickname == nickname.strip().lower()))
        if user is None or user.email == "demo@rateapp.local":
            raise HTTPException(status_code=404, detail="Профиль не найден.")

        total = session.scalar(select(func.count(UserGame.id)).where(
            UserGame.user_id == user.id,
            UserGame.status.in_(["completed", "playing", "dropped"]),
        )) or 0
        completed = session.scalar(
            select(func.count(UserGame.id)).where(
                UserGame.user_id == user.id,
                UserGame.status == "completed",
            )
        ) or 0
        playing = session.scalar(
            select(func.count(UserGame.id)).where(
                UserGame.user_id == user.id,
                UserGame.status == "playing",
            )
        ) or 0
        wishlist = session.scalar(
            select(func.count(UserGame.id))
            .join(CollectionGame, CollectionGame.user_game_id == UserGame.id)
            .join(Collection, Collection.id == CollectionGame.collection_id)
            .where(
                UserGame.user_id == user.id,
                Collection.user_id == user.id,
                Collection.slug == WISHLIST_SLUG,
            )
        ) or 0
        dropped = session.scalar(
            select(func.count(UserGame.id)).where(
                UserGame.user_id == user.id,
                UserGame.status == "dropped",
            )
        ) or 0

        return {
            "nickname": user.nickname,
            "public": True,
            "stats": {
                "total": total,
                "completed": completed,
                "playing": playing,
                "wishlist": wishlist,
                "dropped": dropped,
            },
        }


@app.put("/api/library/{game_id}")
def upsert_library_game(
    game_id: int,
    payload: LibraryPayload,
    request: Request,
) -> dict[str, object]:
    with _session() as session:
        user = _current_user(request, session)
        game = session.scalar(select(Game).where(Game.igdb_id == game_id))
        if game is None:
            raise HTTPException(status_code=404, detail="Игра пока недоступна в каталоге.")

        entry = session.scalar(
            select(UserGame).where(
                UserGame.user_id == user.id,
                UserGame.game_id == game.id,
            )
        )

        # Only assigning a playthrough status, or switching it to another
        # playthrough status, counts as activity. Rating edits, dates, and
        # collection updates must never bump this timestamp.
        previous_status = entry.status if entry is not None else None
        if entry is None:
            entry = UserGame(user_id=user.id, game_id=game.id, status=payload.status)
            session.add(entry)

        if payload.status in {"completed", "playing", "dropped"}:
            if previous_status != payload.status:
                entry.status_changed_at = _now()
        else:
            entry.status_changed_at = None

        entry.status = payload.status
        entry.platform = None if payload.status == "wishlist" else payload.platform
        entry.completed_at = payload.completedAt if payload.status in {"completed", "dropped"} else None
        entry.started_at = payload.startedAt if payload.status == "playing" else None
        if payload.status in {"completed", "dropped"}:
            criteria = [
                payload.atmosphereScore,
                payload.storyScore,
                payload.technologyScore,
                payload.gameplayScore,
            ]
            rounded_criteria = [
                round(value, 1) if value is not None else None
                for value in criteria
            ]
            (
                entry.atmosphere_score,
                entry.story_score,
                entry.technology_score,
                entry.gameplay_score,
            ) = rounded_criteria

            # PostgreSQL ROUND(numeric, 1) uses half-up; keep the API identical.
            from decimal import Decimal, ROUND_HALF_UP
            entry.score = sum(
                Decimal(str(value)) for value in rounded_criteria if value is not None
            ).__truediv__(Decimal("4")).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
        else:
            entry.score = None
            entry.atmosphere_score = None
            entry.story_score = None
            entry.technology_score = None
            entry.gameplay_score = None

        entry.review = payload.review if payload.status in {"completed", "dropped"} else None

        session.flush()
        existing_membership_dates = dict(session.execute(
            select(CollectionGame.collection_id, CollectionGame.added_at)
            .where(CollectionGame.user_game_id == entry.id)
        ).all())
        selected_slugs = set(payload.collectionIds)
        if payload.status == "wishlist":
            _ensure_wishlist_collection(session, user.id)
            selected_slugs.add(WISHLIST_SLUG)

        selected_collections = session.scalars(
            select(Collection).where(
                Collection.user_id == user.id,
                Collection.slug.in_(selected_slugs),
            )
        ).all() if selected_slugs else []
        selected_ids = {collection.id for collection in selected_collections}
        existing_ids = set(existing_membership_dates)
        to_remove = existing_ids - selected_ids
        to_add = selected_ids - existing_ids
        # Leave unchanged rows (including their original added_at) untouched.
        # Recreating the entire membership set on every rating edit causes
        # unnecessary DELETE/INSERT churn and can race with other updates.
        if to_remove:
            session.execute(delete(CollectionGame).where(
                CollectionGame.user_game_id == entry.id,
                CollectionGame.collection_id.in_(to_remove),
            ))
        if to_add:
            session.add_all(
                CollectionGame(collection_id=collection_id, user_game_id=entry.id)
                for collection_id in to_add
            )

        session.commit()
        session.refresh(entry)
        return _serialize_entry(
            session, entry,
            community_rating=_community_rating_map(session, [game.id]).get(game.id),
        )


def _set_collection_membership(game_id: int, collection_id: str, request: Request, enabled: bool) -> dict[str, object]:
    """Idempotent membership update; never delete an existing playthrough."""
    with _session() as session:
        user = _current_user(request, session)
        collection = session.scalar(
            select(Collection).where(
                Collection.user_id == user.id,
                Collection.slug == collection_id,
            )
        )
        if collection is None:
            raise HTTPException(status_code=404, detail="Коллекция не найдена.")

        game = session.scalar(select(Game).where(Game.igdb_id == game_id))
        if game is None:
            raise HTTPException(status_code=404, detail="Игра пока недоступна в каталоге.")

        entry = session.scalar(
            select(UserGame).where(
                UserGame.user_id == user.id,
                UserGame.game_id == game.id,
            )
        )
        if enabled:
            if entry is None:
                entry = UserGame(user_id=user.id, game_id=game.id, status="untracked")
                session.add(entry)
                session.flush()

            already_added = session.scalar(
                select(CollectionGame.id).where(
                    CollectionGame.collection_id == collection.id,
                    CollectionGame.user_game_id == entry.id,
                )
            )
            if already_added is None:
                session.add(CollectionGame(
                    collection_id=collection.id,
                    user_game_id=entry.id,
                ))
        elif entry is not None:
            session.execute(
                delete(CollectionGame).where(
                    CollectionGame.collection_id == collection.id,
                    CollectionGame.user_game_id == entry.id,
                )
            )
            session.flush()
            if entry.status in {"wishlist", "untracked"}:
                remaining = session.scalar(
                    select(CollectionGame.id)
                    .where(CollectionGame.user_game_id == entry.id)
                    .limit(1)
                )
                if remaining is None:
                    session.delete(entry)
                    entry = None
                else:
                    entry.status = "untracked"

        session.commit()
        if entry is None:
            return {"inCollection": enabled, "entry": None}
        session.refresh(entry)
        return {
            "inCollection": enabled,
            "entry": _serialize_entry(
                session, entry,
                community_rating=_community_rating_map(session, [game.id]).get(game.id),
            ),
        }


@app.put("/api/library/{game_id}/collections/{collection_id}")
def add_game_to_collection(game_id: int, collection_id: str, request: Request) -> dict[str, object]:
    return _set_collection_membership(game_id, collection_id, request, True)


@app.delete("/api/library/{game_id}/collections/{collection_id}")
def remove_game_from_collection(game_id: int, collection_id: str, request: Request) -> dict[str, object]:
    return _set_collection_membership(game_id, collection_id, request, False)


@app.put("/api/library/{game_id}/wishlist")
def add_game_to_wishlist(game_id: int, request: Request) -> dict[str, object]:
    with _session() as session:
        user = _current_user(request, session)
        game = session.scalar(select(Game).where(Game.igdb_id == game_id))
        if game is None:
            raise HTTPException(status_code=404, detail="Игра пока недоступна в каталоге.")

        collection = _ensure_wishlist_collection(session, user.id)
        entry = session.scalar(
            select(UserGame).where(
                UserGame.user_id == user.id,
                UserGame.game_id == game.id,
            )
        )
        if entry is None:
            entry = UserGame(user_id=user.id, game_id=game.id, status="untracked")
            session.add(entry)
            session.flush()

        already_added = session.scalar(
            select(CollectionGame.id).where(
                CollectionGame.collection_id == collection.id,
                CollectionGame.user_game_id == entry.id,
            )
        )
        if already_added is None:
            session.add(CollectionGame(
                collection_id=collection.id,
                user_game_id=entry.id,
            ))
        session.commit()
        session.refresh(entry)
        return {
            "inWishlist": True,
            "entry": _serialize_entry(
                session, entry,
                community_rating=_community_rating_map(session, [game.id]).get(game.id),
            ),
        }



@app.delete("/api/library/{game_id}/wishlist")
def remove_game_from_wishlist(game_id: int, request: Request) -> dict[str, object]:
    with _session() as session:
        user = _current_user(request, session)
        game = session.scalar(select(Game).where(Game.igdb_id == game_id))
        if game is None:
            raise HTTPException(status_code=404, detail="Игра пока недоступна в каталоге.")
        collection = _ensure_wishlist_collection(session, user.id)
        entry = session.scalar(
            select(UserGame).where(
                UserGame.user_id == user.id,
                UserGame.game_id == game.id,
            )
        )
        if entry is None:
            session.commit()
            return {"inWishlist": False, "entry": None}

        session.execute(
            delete(CollectionGame).where(
                CollectionGame.collection_id == collection.id,
                CollectionGame.user_game_id == entry.id,
            )
        )
        other_memberships = session.scalar(
            select(CollectionGame.id).where(CollectionGame.user_game_id == entry.id).limit(1)
        )

        # A collection-only record can be removed when it has no memberships.
        if entry.status in {"wishlist", "untracked"}:
            if other_memberships is None:
                session.delete(entry)
                session.commit()
                return {"inWishlist": False, "entry": None}
            # Old wishlist placeholders that remain in other collections are not wishes.
            entry.status = "untracked"

        session.commit()
        session.refresh(entry)
        return {
            "inWishlist": False,
            "entry": _serialize_entry(
                session, entry,
                community_rating=_community_rating_map(session, [game.id]).get(game.id),
            ),
        }


@app.delete("/api/library/{game_id}", status_code=204)
def delete_library_game(game_id: int, request: Request) -> Response:
    with _session() as session:
        user = _current_user(request, session)
        game = session.scalar(select(Game).where(Game.igdb_id == game_id))
        if game is None:
            return Response(status_code=204)

        entry = session.scalar(
            select(UserGame).where(
                UserGame.user_id == user.id,
                UserGame.game_id == game.id,
            )
        )
        if entry is not None and entry.status in {"completed", "playing", "dropped"}:
            has_collections = session.scalar(
                select(CollectionGame.id)
                .where(CollectionGame.user_game_id == entry.id)
                .limit(1)
            ) is not None
            if has_collections:
                # Delete the playthrough only, never its collection memberships.
                entry.status = "untracked"
                entry.status_changed_at = None
                entry.platform = None
                entry.completed_at = None
                entry.started_at = None
                entry.score = None
                entry.atmosphere_score = None
                entry.story_score = None
                entry.technology_score = None
                entry.gameplay_score = None
                entry.review = None
            else:
                session.delete(entry)
            session.commit()

    return Response(status_code=204)


