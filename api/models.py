from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from api.database import Base


WISHLIST_SLUG = "wishlist"
WISHLIST_TITLE = "Хочу пройти"
WISHLIST_DESCRIPTION = "Игры, которые планирую пройти."
WISHLIST_MARK = "❤️"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    nickname: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    pin_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class LoginThrottle(Base):
    __tablename__ = "login_throttles"

    identifier: Mapped[str] = mapped_column(String(320), primary_key=True)
    failures: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Game(Base):
    __tablename__ = "games"

    id: Mapped[int] = mapped_column(primary_key=True)
    igdb_id: Mapped[int] = mapped_column(unique=True, index=True)
    title: Mapped[str] = mapped_column(String(255), index=True)
    cover_url: Mapped[str | None] = mapped_column(String(1000))
    release_date: Mapped[date | None] = mapped_column(Date)
    igdb_rating: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    popularity_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    hype_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    developer: Mapped[str | None] = mapped_column(String(255))
    genres_json: Mapped[str | None] = mapped_column(Text)
    platforms_json: Mapped[str | None] = mapped_column(Text)
    # Lossless IGDB games payload (all top-level fields plus expanded references).
    # Keep for future recommender signals; details_json remains UI-ready metadata.
    igdb_payload: Mapped[dict | None] = mapped_column(JSONB)
    details_json: Mapped[str | None] = mapped_column(Text)
    details_cached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cached_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Genre(Base):
    """Canonical IGDB taxonomy: IDs are stable, unlike free-form names."""
    __tablename__ = "genres"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)


class GameGenre(Base):
    __tablename__ = "game_genres"
    __table_args__ = (UniqueConstraint("game_id", "genre_id", name="uq_game_genre"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    genre_id: Mapped[int] = mapped_column(ForeignKey("genres.id", ondelete="CASCADE"), index=True)


class GenreCatalogSync(Base):
    __tablename__ = "genre_catalog_sync"
    id: Mapped[int] = mapped_column(primary_key=True)
    refreshed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class GameAlias(Base):
    __tablename__ = "game_aliases"
    __table_args__ = (UniqueConstraint("game_id", "name", name="uq_game_alias"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)


class UserGame(Base):
    __tablename__ = "user_games"
    __table_args__ = (UniqueConstraint("user_id", "game_id", name="uq_user_game"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(20), index=True)
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    platform: Mapped[str | None] = mapped_column(String(80))
    completed_at: Mapped[date | None] = mapped_column(Date, index=True)
    started_at: Mapped[date | None] = mapped_column(Date)
    score: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))
    atmosphere_score: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))
    story_score: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))
    technology_score: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))
    gameplay_score: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))
    review: Mapped[str | None] = mapped_column(Text)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    game: Mapped[Game] = relationship()


class Collection(Base):
    __tablename__ = "collections"
    __table_args__ = (UniqueConstraint("user_id", "slug", name="uq_user_collection_slug"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    slug: Mapped[str] = mapped_column(String(60), index=True)
    title: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    mark: Mapped[str | None] = mapped_column(String(8))
    color_scheme: Mapped[str] = mapped_column(String(24), nullable=False, server_default=text("'violet'"))
    emoji: Mapped[str | None] = mapped_column(String(48))
    icon_data: Mapped[str | None] = mapped_column(Text)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CollectionGame(Base):
    __tablename__ = "collection_games"
    __table_args__ = (
        UniqueConstraint("collection_id", "user_game_id", name="uq_collection_user_game"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    collection_id: Mapped[int] = mapped_column(
        ForeignKey("collections.id", ondelete="CASCADE"),
        index=True,
    )
    user_game_id: Mapped[int] = mapped_column(
        ForeignKey("user_games.id", ondelete="CASCADE"),
        index=True,
    )
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    endpoint_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    p256dh: Mapped[str] = mapped_column(String(200), nullable=False)
    auth: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_test_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ReleasePushDelivery(Base):
    __tablename__ = "release_push_deliveries"
    __table_args__ = (
        UniqueConstraint("subscription_id", "game_id", "release_date",
                         name="uq_release_push_delivery"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    subscription_id: Mapped[int] = mapped_column(
        ForeignKey("push_subscriptions.id", ondelete="CASCADE"), index=True,
    )
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"))
    release_date: Mapped[date] = mapped_column(Date, nullable=False)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DiscoveryFeedback(Base):
    """Latest intentional discovery decision; can be undone without touching ratings."""
    __tablename__ = "discovery_feedback"
    __table_args__ = (UniqueConstraint("user_id", "game_id", name="uq_discovery_feedback_user_game"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), index=True)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    wishlist_added: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
