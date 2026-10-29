"""User-owned saved links; no fetching remote URLs on the API request path."""
import hashlib
import ipaddress
import re
from datetime import timedelta
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError

from api.models import Game, SavedLink, User
from api.security import _current_user, _now, _session

router = APIRouter()
MAX_LINKS_PER_USER = 100
MAX_NEW_LINKS_PER_DAY = 15


class LinkCreate(BaseModel):
    url: str = Field(min_length=10, max_length=2048)
    title: str | None = Field(default=None, max_length=200)


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
        )):
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
    link = session.scalar(select(SavedLink).where(
        SavedLink.id == link_id, SavedLink.user_id == user_id,
    ))
    if link is None:
        raise HTTPException(404, detail="Ссылка не найдена.")
    return link


def _game_map(session, links: list[SavedLink]) -> dict[int, Game]:
    """Single catalog query across the entire page; no N+1 or network calls."""
    ids = {item for link in links for item in (link.game_ids or [])}
    if not ids:
        return {}
    return {game.id: game for game in session.scalars(
        select(Game).where(Game.id.in_(ids))
    ).all()}


def _link_payload(link: SavedLink, games: dict[int, Game]) -> dict[str, object]:
    ids = list(link.game_ids or [])
    return {
        "id": link.id,
        "url": link.url,
        "title": link.title,
        "status": link.status,
        "gptNames": link.gpt_names,
        "createdAt": link.created_at.isoformat(),
        "updatedAt": link.updated_at.isoformat(),
        "finishedAt": link.finished_at.isoformat() if link.finished_at else None,
        "error": link.error,
        "gameIds": ids,
        "gameNames": link.game_names,
        "gamesCount": len(ids),
        "games": [{
            "id": games[game_id].id,
            "igdbId": games[game_id].igdb_id,
            "title": games[game_id].title,
            "coverUrl": games[game_id].cover_url,
        } for game_id in ids if game_id in games],
    }


@router.get("/api/saved-links")
def list_saved_links(request: Request, limit: int = Query(default=50, ge=1, le=50),
                     before: int | None = Query(default=None, ge=1)) -> dict[str, object]:
    with _session() as session:
        user = _current_user(request, session)
        stmt = (select(SavedLink).where(SavedLink.user_id == user.id)
                .order_by(SavedLink.created_at.desc(), SavedLink.id.desc())
                .limit(limit + 1))
        if before is not None:
            anchor = _get_user_link(session, user.id, before)
            stmt = stmt.where(or_(
                SavedLink.created_at < anchor.created_at,
                and_(SavedLink.created_at == anchor.created_at, SavedLink.id < before),
            ))
        rows = session.scalars(stmt).all()
        page = rows[:limit]
        games = _game_map(session, page)
        return {"items": [_link_payload(link, games) for link in page],
                "nextBefore": page[-1].id if len(rows) > limit else None}


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
            return _link_payload(existing, _game_map(session, [existing]))
        # Lock the account to serialize concurrent quota checks and dedup.
        session.execute(select(User.id).where(User.id == user.id).with_for_update()).scalar_one()
        count = session.scalar(select(func.count()).select_from(SavedLink)
                               .where(SavedLink.user_id == user.id)) or 0
        recent = session.scalar(select(func.count()).select_from(SavedLink).where(
            SavedLink.user_id == user.id,
            SavedLink.created_at >= _now() - timedelta(days=1),
        )) or 0
        if count >= MAX_LINKS_PER_USER or recent >= MAX_NEW_LINKS_PER_DAY:
            raise HTTPException(429, detail="Достигнут лимит сохранённых ссылок.")
        row = SavedLink(user_id=user.id, url=url, url_hash=digest, title=title)
        session.add(row)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            match = session.scalar(select(SavedLink).where(
                SavedLink.user_id == user.id, SavedLink.url_hash == digest,
            ))
            if match is None:
                raise
            row = match
        return _link_payload(row, _game_map(session, [row]))


@router.get("/api/saved-links/{link_id}")
def get_saved_link(link_id: int, request: Request) -> dict[str, object]:
    with _session() as session:
        user = _current_user(request, session)
        link = _get_user_link(session, user.id, link_id)
        return _link_payload(link, _game_map(session, [link]))


@router.delete("/api/saved-links/{link_id}", status_code=204)
def delete_saved_link(link_id: int, request: Request) -> None:
    with _session() as session:
        user = _current_user(request, session)
        row = _get_user_link(session, user.id, link_id)
        session.delete(row)  # removes the row, its GPT names and every associated game ID
        session.commit()


def _reset_for_recheck(link: SavedLink) -> None:
    """Explicitly re-analyze a URL after an edit; invalidate stale leases."""
    link.gpt_names = None
    link.game_ids = []
    link.status = "pending"
    link.attempts = 0
    link.match_cursor = 0
    link.match_failures = 0
    link.lease_token = None
    link.lease_until = None
    link.error = None
    link.finished_at = None
    link.updated_at = _now()


def _requeue(row: SavedLink) -> None:
    """Explicit re-analysis; invalidate any in-flight ChatGPT/IGDB result."""
    row.game_names = None
    row.game_ids = []
    row.status = "pending"
    row.error = None
    row.finished_at = None
    row.attempts = 0
    row.resolve_cursor = 0
    row.match_failures = 0
    row.lease_token = None
    row.lease_until = None
    row.updated_at = _now()


@router.post("/api/saved-links/{link_id}/retry")
def retry_saved_link(link_id: int, request: Request) -> dict[str, object]:
    with _session() as session:
        user = _current_user(request, session)
        link = _get_user_link(session, user.id, link_id)
        if link.status != "failed":
            raise HTTPException(409, detail="Повтор возможен только после ошибки.")
        _requeue(link)
        session.commit()
        return _link_payload(link, _game_map(session, [link]))


@router.post("/api/saved-links/{link_id}/refresh")
def refresh_saved_link(link_id: int, request: Request) -> dict[str, object]:
    """A source article may change: discard old snapshot and re-analyze it."""
    with _session() as session:
        user = _current_user(request, session)
        link = _get_user_link(session, user.id, link_id)
        _requeue(link)
        session.commit()
        return _link_payload(link, _game_map(session, [link]))
