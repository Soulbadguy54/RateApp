"""User-owned saved links; no fetching remote URLs on the API request path."""
import hashlib
import ipaddress
import re
import threading
import time
from collections import OrderedDict
from datetime import timedelta
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, StrictInt
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError

from api.models import SavedLink, User
from api.security import _current_user, _now, _session

router = APIRouter()
MAX_LINKS_PER_USER = 100
MAX_NEW_LINKS_PER_DAY = 15

# Small bounded, short-lived cache: no user HTML or unverified CDN URLs stored.
_thumbnail_lock = threading.Lock()
_thumbnail_cache: OrderedDict[str, tuple[float, bytes | None, str]] = OrderedDict()
_THUMBNAIL_TTL_SECONDS = 600
_THUMBNAIL_CACHE_MAX_ITEMS = 24


class LinkCreate(BaseModel):
    url: str = Field(min_length=10, max_length=2048)
    title: str | None = Field(default=None, max_length=200)


class LinksBulkDelete(BaseModel):
    ids: list[StrictInt] = Field(min_length=1, max_length=MAX_LINKS_PER_USER)


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


def _link_payload(link: SavedLink) -> dict[str, object]:
    """Only the saved bookmark: retired GPT/game columns are never exposed."""
    return {
        "id": link.id,
        "url": link.url,
        "title": link.title,
        "createdAt": link.created_at.isoformat(),
        "updatedAt": link.updated_at.isoformat(),
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
        return {"items": [_link_payload(link) for link in page],
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
            return _link_payload(existing)
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
        # A bookmark needs no GPT claim, resolver, or background status.
        row = SavedLink(user_id=user.id, url=url, url_hash=digest, title=title,
                        status="ready", gpt_names=[])
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
        return _link_payload(row)


@router.post("/api/saved-links/{link_id}/preview")
def saved_link_preview(link_id: int, request: Request) -> dict[str, str | None]:
    """Universal title and description from verified OG/Twitter/JSON-LD metadata.

    Saving a link does not fetch it. No HTML or remote media URLs are exposed.
    """
    from api.saved_links_safety import SourceSafetyError, preview_source

    with _session() as session:
        user = _current_user(request, session)
        link = _get_user_link(session, user.id, link_id)
        url = link.url

    try:
        preview = preview_source(url)
    except (SourceSafetyError, ValueError):
        # No page data or remote images are exposed when safety cannot be
        # demonstrated. An untrusted URL is still stored for later handling.
        return {"title": None, "description": None}
    title = preview["title"][:180].strip()
    if title:
        with _session() as session:
            user = _current_user(request, session)
            link = session.scalar(select(SavedLink).where(
                SavedLink.id == link_id, SavedLink.user_id == user.id,
            ).with_for_update())
            if link is not None and link.url == url and link.title != title:
                link.title = title
                session.commit()
    return {"title": title or None, "description": preview["description"] or None}


@router.get("/api/saved-links/{link_id}/thumbnail")
def saved_link_thumbnail(link_id: int, request: Request) -> Response:
    """Owner-scoped generic image preview; no arbitrary proxy URL parameter.

    Source and image redirects are both Google Safe Browsing + pinned-public-IP
    verified. Only successfully decoded JPEG/PNG/WebP are served, same origin.
    Cache is memory-limited and includes short-lived negative entries.
    """
    from api.saved_links_safety import SourceSafetyError, preview_thumbnail_source

    with _session() as session:
        user = _current_user(request, session)
        url = _get_user_link(session, user.id, link_id).url
    now = time.monotonic()
    with _thumbnail_lock:
        cached = _thumbnail_cache.get(url)
        if cached is not None and cached[0] >= now:
            _thumbnail_cache.move_to_end(url)
            body, mime = cached[1], cached[2]
            if body is None:
                return Response(status_code=204, headers={
                    "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff",
                })
            return Response(content=body, media_type=mime, headers={
                "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
            })
    try:
        image = preview_thumbnail_source(url)
    except (SourceSafetyError, ValueError, OSError):
        image = None
    body, mime = image if image is not None else (None, "")
    with _thumbnail_lock:
        _thumbnail_cache[url] = (
            now + (_THUMBNAIL_TTL_SECONDS if body else 60), body, mime,
        )
        _thumbnail_cache.move_to_end(url)
        while len(_thumbnail_cache) > _THUMBNAIL_CACHE_MAX_ITEMS:
            _thumbnail_cache.popitem(last=False)
    if body is None:
        return Response(status_code=204, headers={
            "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff",
        })
    return Response(content=body, media_type=mime, headers={
        "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
    })


@router.get("/api/saved-links/{link_id}")
def get_saved_link(link_id: int, request: Request) -> dict[str, object]:
    with _session() as session:
        user = _current_user(request, session)
        link = _get_user_link(session, user.id, link_id)
        return _link_payload(link)


@router.post("/api/saved-links/bulk-delete")
def bulk_delete_saved_links(payload: LinksBulkDelete, request: Request) -> dict[str, int]:
    """Atomically remove only the caller's links, or remove none.

    Deleting rows only affects the caller's saved bookmarks.
    """
    ids = payload.ids
    if any(item <= 0 for item in ids) or len(ids) != len(set(ids)):
        raise HTTPException(422, detail="Нужны уникальные положительные ID ссылок.")
    with _session() as session:
        user = _current_user(request, session)
        rows = session.scalars(
            select(SavedLink).where(
                SavedLink.user_id == user.id, SavedLink.id.in_(ids),
            ).with_for_update()
        ).all()
        if len(rows) != len(ids):
            raise HTTPException(404, detail="Одна или несколько ссылок не найдены.")
        for row in rows:
            session.delete(row)
        session.commit()
        return {"deleted": len(rows)}


@router.delete("/api/saved-links/{link_id}", status_code=204)
def delete_saved_link(link_id: int, request: Request) -> None:
    with _session() as session:
        user = _current_user(request, session)
        row = _get_user_link(session, user.id, link_id)
        session.delete(row)  # removes this bookmark; catalog and user games are untouched
        session.commit()
