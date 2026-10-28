"""User-owned saved links; no fetching remote URLs on the API request path."""
import hashlib
import ipaddress
import re
from datetime import timedelta
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from api.models import Game, SavedLink, SavedLinkGame, User
from api.security import _current_user, _now, _session

router = APIRouter()
MAX_LINKS_PER_USER = 100
MAX_NEW_LINKS_PER_DAY = 15


class LinkCreate(BaseModel):
    url: str = Field(min_length=10, max_length=2048)
    title: str | None = Field(default=None, max_length=200)


class LinkGameMatch(BaseModel):
    igdbId: int = Field(gt=0)


def canonical_url(raw: str) -> str:
    """Normalize for duplicate detection, not as a network/SSRF clearance."""
    raw = raw.strip()
    if any(ord(ch) < 32 for ch in raw) or chr(92) in raw:
        raise ValueError("В ссылке есть недопустимые символы.")
    if len(raw) > 2048:
        raise ValueError("Слишком длинная ссылка.")
    try:
        parts = urlsplit(raw)
        if parts.scheme.lower() not in ("https", "http") or not parts.hostname:
            raise ValueError("Нужна ссылка http:// или https://.")
        if parts.username is not None or parts.password is not None:
            raise ValueError("Ссылка не должна содержать логин или пароль.")
        port = parts.port
        if port is not None and port != (443 if parts.scheme.lower() == "https" else 80):
            raise ValueError("Порты, отличные от стандартных, не поддерживаются.")
        host = parts.hostname.encode("idna").decode("ascii").lower().rstrip(".")
        if (not re.fullmatch(r"[a-z0-9.-]+", host) or "." not in host
                or any(not part or part.startswith("-") or part.endswith("-")
                       for part in host.split(".")) or host.endswith(
            (".local", ".localhost", ".internal", ".test", ".invalid", ".onion")
        ):
            raise ValueError("Не поддерживается локальный или служебный адрес.")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            if not address.is_global:
                raise ValueError("Не поддерживается локальный IP-адрес.")
        origin = host if ":" not in host else f"[{host}]"
        # Remove canonical default port and URL fragment, retain meaningful query.
        result = urlunsplit((parts.scheme.lower(), origin, parts.path or "/", parts.query, ""))
        if len(result) > 2048:
            raise ValueError("Слишком длинная ссылка.")
        return result
    except (UnicodeError, ValueError) as exc:
        raise ValueError(str(exc) or "Некорректная ссылка.") from exc


def _get_user_link(session, user_id: int, link_id: int) -> SavedLink:
    link = session.scalar(
        select(SavedLink)
        .options(selectinload(SavedLink.games).selectinload(SavedLinkGame.game))
        .where(SavedLink.id == link_id, SavedLink.user_id == user_id)
    )
    if link is None:
        raise HTTPException(404, detail="Ссылка не найдена.")
    return link


def _link_payload(link: SavedLink) -> dict[str, object]:
    games = sorted(link.games, key=lambda item: item.id)
    return {
        "id": link.id,
        "url": link.url,
        "title": link.title,
        "status": link.status,
        "attempts": link.attempts,
        "createdAt": link.created_at.isoformat(),
        "updatedAt": link.updated_at.isoformat(),
        "finishedAt": link.finished_at.isoformat() if link.finished_at else None,
        "error": link.error,
        "gamesCount": len(games),
        "games": [{
            "id": entry.id,
            "name": entry.name,
            "igdbId": entry.game.igdb_id if entry.game else None,
            "gameTitle": entry.game.title if entry.game else None,
            "coverUrl": entry.game.cover_url if entry.game else None,
        } for entry in games],
    }


@router.get("/api/saved-links")
def list_saved_links(request: Request, limit: int = Query(default=50, ge=1, le=50),
                     before: int | None = Query(default=None, ge=1)) -> dict[str, object]:
    with _session() as session:
        user = _current_user(request, session)
        stmt = (select(SavedLink)
                .options(selectinload(SavedLink.games).selectinload(SavedLinkGame.game))
                .where(SavedLink.user_id == user.id)
                .order_by(SavedLink.id.desc()).limit(limit + 1))
        if before is not None:
            stmt = stmt.where(SavedLink.id < before)
        rows = session.scalars(stmt).all()
        more = len(rows) > limit
        return {"items": [_link_payload(row) for row in rows[:limit]],
                "nextBefore": rows[limit - 1].id if more else None}


@router.post("/api/saved-links", status_code=201)
def save_link(payload: LinkCreate, request: Request) -> dict[str, object]:
    try:
        url = canonical_url(payload.url)
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    title = (payload.title or "").strip() or None
    with _session() as session:
        user = _current_user(request, session)
        existing = session.scalar(select(SavedLink).where(
            SavedLink.user_id == user.id, SavedLink.url_hash == digest,
        ))
        if existing:
            return _link_payload(_get_user_link(session, user.id, existing.id))
        # Serialize quota checks for simultaneous saves from the same account.
        session.execute(select(User.id).where(User.id == user.id).with_for_update()).scalar_one()
        count = session.scalar(select(func.count()).select_from(SavedLink)
                               .where(SavedLink.user_id == user.id)) or 0
        recent = session.scalar(select(func.count()).select_from(SavedLink).where(
            SavedLink.user_id == user.id, SavedLink.created_at >= _now() - timedelta(days=1),
        )) or 0
        if count >= MAX_LINKS_PER_USER or recent >= MAX_NEW_LINKS_PER_DAY:
            raise HTTPException(429, detail="Достигнут лимит сохранённых ссылок.")
        row = SavedLink(user_id=user.id, url=url, url_hash=digest, title=title)
        session.add(row)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            # Concurrent duplicate inserts are harmless and return the same ID.
            match = session.scalar(select(SavedLink).where(
                SavedLink.user_id == user.id, SavedLink.url_hash == digest,
            ))
            if match is None:
                raise
            row = match
        return _link_payload(_get_user_link(session, user.id, row.id))


@router.get("/api/saved-links/{link_id}")
def get_saved_link(link_id: int, request: Request) -> dict[str, object]:
    with _session() as session:
        user = _current_user(request, session)
        return _link_payload(_get_user_link(session, user.id, link_id))


@router.delete("/api/saved-links/{link_id}", status_code=204)
def delete_saved_link(link_id: int, request: Request) -> None:
    with _session() as session:
        user = _current_user(request, session)
        row = _get_user_link(session, user.id, link_id)
        session.delete(row)
        session.commit()


@router.put("/api/saved-links/{link_id}/games/{entry_id}")
def match_saved_link_game(link_id: int, entry_id: int, payload: LinkGameMatch,
                          request: Request) -> dict[str, object]:
    """Only verified existing catalog games can become associations."""
    with _session() as session:
        user = _current_user(request, session)
        link = _get_user_link(session, user.id, link_id)
        entry = next((item for item in link.games if item.id == entry_id), None)
        if entry is None:
            raise HTTPException(404, detail="Название не найдено в этой ссылке.")
        game = session.scalar(select(Game).where(Game.igdb_id == payload.igdbId))
        if game is None:
            raise HTTPException(404, detail="Сначала найдите игру в каталоге IGDB.")
        entry.game_id = game.id
        link.updated_at = _now()
        session.commit()
        return _link_payload(_get_user_link(session, user.id, link_id))


@router.post("/api/saved-links/{link_id}/retry")
def retry_saved_link(link_id: int, request: Request) -> dict[str, object]:
    """User-controlled retry; never enqueues background work from web requests."""
    with _session() as session:
        user = _current_user(request, session)
        row = _get_user_link(session, user.id, link_id)
        if row.status != "failed":
            raise HTTPException(409, detail="Повтор возможен только для неудачной обработки.")
        row.status = "pending"
        row.attempts = 0
        row.lease_token = None
        row.lease_until = None
        row.error = None
        row.finished_at = None
        row.updated_at = _now()
        session.commit()
        return _link_payload(row)
