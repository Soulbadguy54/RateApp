"""Explicit, preview-first Steam library sync. No scheduled imports.

Steam identity belongs to steam_connections. Only after a verified preview and a
second, same-origin confirmation do new games enter user_games. Never modify
existing playthroughs, ratings, dates, or collections.
"""
import hashlib
import json
import os
import re
import secrets
from collections import defaultdict
from datetime import timedelta
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from api.collections_service import _ensure_wishlist_collection
from api.games_routes import IGDB_GAME_FIELDS, _cache_igdb_games
from api.igdb_client import Priority, igdb_client
from api.models import (
    CollectionGame, Game, GameExternalId, SteamConnection, SteamSyncPreview,
    UserGame,
)
from api.security import SESSION_COOKIE, _current_user, _hash_token, _now, _session
from api.steam_routes import _origin

router = APIRouter()
STEAM_API = "https://api.steampowered.com"
APPID_RE = re.compile(r"^[1-9][0-9]{0,9}$")
STORE_APP_RE = re.compile(r"^/app/([1-9][0-9]{0,9})(?:/|$)")
MAX_OWNED = 3000
PREVIEW_TTL_MINUTES = 15


class CommitPayload(BaseModel):
    token: str = Field(min_length=24, max_length=128)


class ManualMatchPayload(BaseModel):
    appid: int = Field(gt=0, le=4294967295)
    igdbId: int = Field(gt=0)


def _require_origin(request: Request):
    if request.headers.get("origin") != _origin():
        raise HTTPException(403, "Same-origin request required")


def _steam_key() -> str:
    key = os.getenv("STEAM_WEB_API_KEY", "").strip()
    if not key:
        raise HTTPException(503, "Не настроен серверный Steam Web API key.")
    return key


def _steam_api(method: str, params: dict[str, object]) -> dict:
    # Never log the request parameters, URL (includes secret), or returned
    # personal Steam data. No redirects to untrusted hosts.
    try:
        with httpx.Client(timeout=12, trust_env=False, follow_redirects=False) as client:
            response = client.get(
                STEAM_API + method, params={"key": _steam_key(), **params},
            )
            response.raise_for_status()
            data = response.json()
        if not isinstance(data, dict) or not isinstance(data.get("response"), dict):
            raise ValueError("Missing response")
        return data["response"]
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, "Steam сейчас не отвечает. Повторите попытку.") from exc


def _connection(session, request: Request):
    user = _current_user(request, session)
    linked = session.scalar(
        select(SteamConnection).where(SteamConnection.user_id == user.id)
    )
    if linked is None:
        raise HTTPException(409, "Сначала войдите в Steam.")
    return user, linked


def _owned_games(steam_id: str) -> tuple[list[dict], str | None]:
    data = _steam_api("/IPlayerService/GetOwnedGames/v1/", {
        "steamid": steam_id,
        "include_appinfo": 1,
        "include_played_free_games": 1,
        "format": "json",
    })
    # Empty response {} typically indicates hidden game details. A legitimate
    # empty library can produce game_count=0; neither permits importing.
    if "games" not in data:
        return [], "Список игр Steam пуст или скрыт настройками приватности «Сведения об играх»."
    raw = data["games"]
    if not isinstance(raw, list) or len(raw) > MAX_OWNED:
        raise HTTPException(422, "Steam вернул слишком большую или некорректную библиотеку.")
    cleaned = []
    seen = set()
    for row in raw:
        if not isinstance(row, dict):
            continue
        appid = row.get("appid")
        if type(appid) is not int or not (0 < appid <= 4294967295) or appid in seen:
            continue
        seen.add(appid)
        minutes = row.get("playtime_forever")
        cleaned.append({
            "appid": appid,
            "name": str(row.get("name") or ("Steam App " + str(appid)))[:180],
            "minutes": minutes if type(minutes) is int and minutes >= 0 else None,
        })
    if not cleaned:
        return [], "Список игр Steam пуст или недоступен. Проверьте приватность."
    # This is a *warning heuristic*, not a claim about the actual Steam switch.
    if all(g["minutes"] is None or g["minutes"] == 0 for g in cleaned):
        return cleaned, ("Steam не сообщил наигранные часы ни для одной игры. "
                         "Возможно, время скрыто в настройках приватности; "
                         "все игры без запуска также дадут такой результат.")
    return cleaned, None


def _profile(steam_id: str) -> dict:
    response = _steam_api("/ISteamUser/GetPlayerSummaries/v2/", {"steamids": steam_id})
    players = response.get("players", [])
    player = next((p for p in players if isinstance(p, dict)
                   and p.get("steamid") == steam_id), {}) if isinstance(players, list) else {}
    profile_url = str(player.get("profileurl") or "")
    if not profile_url.startswith(("https://steamcommunity.com/id/", "https://steamcommunity.com/profiles/")):
        profile_url = "https://steamcommunity.com/profiles/" + steam_id + "/"
    avatar_url = str(player.get("avatarfull") or "")
    if not (avatar_url.startswith("https://avatars.steamstatic.com/")
            or avatar_url.startswith("https://steamcdn-a.akamaihd.net/")):
        avatar_url = None
    return {
        "name": str(player.get("personaname") or "Steam")[:100],
        "profileUrl": profile_url,
        "avatarUrl": avatar_url,
        "profilePublic": player.get("communityvisibilitystate") == 3,
    }


def _steam_appid(url: str) -> str | None:
    try:
        u = urlsplit(url)
    except ValueError:
        return None
    if u.scheme != "https" or u.hostname not in {"store.steampowered.com", "store.steampowered.com."}:
        return None
    match = STORE_APP_RE.match(u.path)
    return match.group(1) if match else None


def _source_id() -> int:
    rows = igdb_client.request(
        "external_game_sources", "fields id,name; limit 500;", priority=Priority.BACKGROUND
    )
    exact = [int(row["id"]) for row in rows
             if str(row.get("name") or "").strip().casefold() in {"steam", "steam store"}
             and type(row.get("id")) is int]
    if len(exact) != 1:
        raise HTTPException(503, "IGDB не подтвердил уникальный источник Steam.")
    return exact[0]


def _resolve_mappings(appids: list[int]) -> dict[int, int]:
    """One shared ID cache. Unresolved entries are retried after 14 days."""
    if not appids:
        return {}
    ids = [str(a) for a in appids]
    now = _now()
    with _session() as session:
        cached = {
            row.external_id: row for row in session.scalars(
                select(GameExternalId).where(
                    GameExternalId.provider == "steam",
                    GameExternalId.external_id.in_(ids),
                )
            )
        }
        matched = {int(k): row.igdb_id for k, row in cached.items()
                   if row.igdb_id and row.status == "matched"}
        unknown = [i for i in ids if i not in cached or (
            cached[i].status != "matched"
            and (cached[i].checked_at is None or cached[i].checked_at < now - timedelta(days=14))
        )]
    if not unknown:
        return matched

    source = _source_id()
    for begin in range(0, len(unknown), 100):
        block = unknown[begin:begin+100]
        quoted = ",".join('"' + a + '"' for a in block)
        rows = igdb_client.request(
            "external_games",
            f"fields uid,game,external_game_source; where external_game_source = {source} & uid = ({quoted}); limit 500;",
            priority=Priority.BACKGROUND,
        )
        candidates: dict[str, set[int]] = defaultdict(set)
        for row in rows:
            key = str(row.get("uid") or "")
            if key in block and type(row.get("game")) is int and row.get("external_game_source") == source:
                candidates[key].add(row["game"])
        now = _now()
        with _session() as session:
            for key in block:
                games = candidates.get(key, set())
                status = "matched" if len(games) == 1 else "ambiguous" if games else "not_found"
                igdb_id = next(iter(games)) if len(games) == 1 else None
                session.execute(pg_insert(GameExternalId).values(
                    provider="steam", external_id=key, igdb_id=igdb_id,
                    status=status, source="igdb", checked_at=now,
                ).on_conflict_do_update(
                    index_elements=["provider", "external_id"],
                    set_={"igdb_id": igdb_id, "status": status, "source": "igdb", "checked_at": now},
                    where=(GameExternalId.source != "manual"),
                ))
                if igdb_id:
                    matched[int(key)] = igdb_id
            session.commit()
    return matched


def _ensure_games(igdb_ids: set[int]) -> dict[int, Game]:
    with _session() as session:
        existing = {g.igdb_id: g for g in session.scalars(
            select(Game).where(Game.igdb_id.in_(igdb_ids))
        )}
    missing = sorted(igdb_ids - set(existing))
    for n in range(0, len(missing), 100):
        block = missing[n:n+100]
        rows = igdb_client.request(
            "games",
            f"fields {IGDB_GAME_FIELDS}; where id = ({','.join(str(i) for i in block)}); limit 100;",
            priority=Priority.BACKGROUND,
        )
        if rows:
            _cache_igdb_games(rows)
    with _session() as session:
        return {g.igdb_id: g for g in session.scalars(
            select(Game).where(Game.igdb_id.in_(igdb_ids))
        )}


def _prepare(user_id: int, steam_id: str, games: list[dict]) -> tuple[list[dict], list[dict]]:
    appids = [g["appid"] for g in games]
    matches = _resolve_mappings(appids)
    loaded = _ensure_games(set(matches.values()))
    with _session() as session:
        # Never present an already-saved user_game, even if added manually.
        already = {g.igdb_id for g in session.scalars(
            select(Game).join(UserGame, UserGame.game_id == Game.id).where(UserGame.user_id == user_id)
        )}
        user_matched_apps = set()
        for data, in session.execute(select(UserGame.steam_data).where(
            UserGame.user_id == user_id, UserGame.steam_data.is_not(None)
        )):
            for app in (data or {}).get("apps", []):
                if type(app) is dict and type(app.get("appid")) is int and (data or {}).get("steam_id64") == steam_id:
                    user_matched_apps.add(app["appid"])
    incoming: dict[int, dict] = {}
    unresolved = []
    for row in games:
        appid = row["appid"]
        if appid in user_matched_apps:
            continue
        if row["minutes"] is None:
            unresolved.append({"appid": appid, "name": row["name"], "reason": "playtime_unavailable"})
            continue
        igdb_id = matches.get(appid)
        if not igdb_id or igdb_id not in loaded:
            unresolved.append({"appid": appid, "name": row["name"]})
            continue
        if igdb_id in already:
            continue
        if igdb_id not in incoming:
            incoming[igdb_id] = {
                "igdbId": igdb_id, "title": loaded[igdb_id].title,
                "coverUrl": loaded[igdb_id].cover_url,
                "status": "playing" if (row["minutes"] or 0) > 0 else "wishlist",
                "apps": [],
            }
        entry = incoming[igdb_id]
        entry["apps"].append({"appid": appid, "minutes": row["minutes"]})
        if (row["minutes"] or 0) > 0:
            entry["status"] = "playing"
    return list(incoming.values()), unresolved


@router.get("/api/steam/overview")
def steam_overview(request: Request) -> dict:
    with _session() as session:
        user, linked = _connection(session, request)
        steam_id = linked.steam_id64
        last = linked.last_synced_at.isoformat() if linked.last_synced_at else None
    profile = None
    red_flags = []
    game_count = 0
    configured = bool(os.getenv("STEAM_WEB_API_KEY", "").strip())
    if configured:
        try:
            profile = _profile(steam_id)
        except HTTPException:
            red_flags.append("Не удалось загрузить публичный профиль Steam.")
        try:
            games, problem = _owned_games(steam_id)
            game_count = len(games)
            if problem:
                red_flags.append(problem)
            if profile and not profile["profilePublic"]:
                red_flags.append("Профиль Steam не общедоступен.")
        except HTTPException:
            red_flags.append("Не удалось проверить библиотеку Steam.")
    else:
        red_flags.append("Администратору нужно настроить STEAM_WEB_API_KEY на сервере.")
    return {
        "profile": profile or {
            "name": "Steam", "profileUrl": "https://steamcommunity.com/profiles/" + steam_id + "/",
            "avatarUrl": None, "profilePublic": None,
        },
        "steamId64": steam_id, "configured": configured, "gameCount": game_count,
        "canSync": configured and not red_flags,
        "redFlags": red_flags, "lastSyncedAt": last,
    }


@router.post("/api/steam/preview")
def steam_preview(request: Request) -> dict:
    _require_origin(request)
    with _session() as session:
        user, linked = _connection(session, request)
        user_id, steam_id = user.id, linked.steam_id64
        session_hash = _hash_token(request.cookies.get(SESSION_COOKIE, ""))
    games, problem = _owned_games(steam_id)
    if problem:
        raise HTTPException(409, problem)
    items, unresolved = _prepare(user_id, steam_id, games)
    token = secrets.token_urlsafe(32)
    with _session() as session:
        user, linked = _connection(session, request)
        if user.id != user_id or linked.steam_id64 != steam_id or (
            _hash_token(request.cookies.get(SESSION_COOKIE, "")) != session_hash
        ):
            raise HTTPException(409, "Сессия или Steam-аккаунт изменились.")
        current = session.scalar(select(SteamSyncPreview).where(SteamSyncPreview.user_id == user_id))
        if current:
            session.delete(current)
            session.flush()
        session.add(SteamSyncPreview(
            user_id=user_id, steam_id64=steam_id, session_hash=session_hash,
            token_hash=hashlib.sha256(token.encode()).hexdigest(),
            items=items, unresolved=unresolved,
            expires_at=_now() + timedelta(minutes=PREVIEW_TTL_MINUTES),
        ))
        session.commit()
    return {"token": token, "items": items, "unresolved": unresolved}


@router.post("/api/steam/commit")
def steam_commit(payload: CommitPayload, request: Request) -> dict:
    _require_origin(request)
    token_hash = hashlib.sha256(payload.token.encode()).hexdigest()
    with _session() as session:
        user, linked = _connection(session, request)
        # Serialize same-user writes so a double click or concurrent request is safe.
        preview = session.scalar(
            select(SteamSyncPreview).where(SteamSyncPreview.user_id == user.id).with_for_update()
        )
        if (preview is None or preview.token_hash != token_hash
            or preview.steam_id64 != linked.steam_id64
            or preview.session_hash != _hash_token(request.cookies.get(SESSION_COOKIE, ""))
            or preview.expires_at <= _now()):
            raise HTTPException(409, "Предпросмотр устарел. Запустите синхронизацию заново.")
        wishlist = _ensure_wishlist_collection(session, user.id)
        created = []
        for item in preview.items:
            game = session.scalar(select(Game).where(Game.igdb_id == int(item["igdbId"])))
            if game is None:
                continue
            # Unique constraint and per-user preview lock protect against duplicates.
            entry = session.scalar(select(UserGame).where(
                UserGame.user_id == user.id, UserGame.game_id == game.id
            ))
            if entry is not None:
                continue
            status = "playing" if item["status"] == "playing" else "wishlist"
            entry = UserGame(
                user_id=user.id, game_id=game.id, status=status,
                steam_data={"imported": True, "apps": item["apps"],
                            "last_synced_at": _now().isoformat(),
                            "steam_id64": linked.steam_id64},
            )
            session.add(entry)
            session.flush()
            if status == "wishlist":
                session.add(CollectionGame(collection_id=wishlist.id, user_game_id=entry.id))
            created.append({"igdbId": game.igdb_id, "title": game.title, "status": status})
        linked.last_synced_at = _now()
        unresolved = preview.unresolved
        session.delete(preview)
        session.commit()
    return {"created": created, "unresolved": unresolved}


@router.post("/api/steam/manual-match")
def steam_manual_match(payload: ManualMatchPayload, request: Request) -> dict:
    """User-selected link. Never pollute the global verified AppID index."""
    _require_origin(request)
    with _session() as session:
        user, linked = _connection(session, request)
        # This link is only for a real owned app of the currently linked
        # Steam account. A numeric AppID supplied by the browser is not proof.
        steam_id = linked.steam_id64
    owned, problem = _owned_games(steam_id)
    if not any(a["appid"] == payload.appid for a in owned):
        raise HTTPException(409, problem or "Игра отсутствует в доступной библиотеке Steam.")
    with _session() as session:
        user, linked = _connection(session, request)
        if linked.steam_id64 != steam_id:
            raise HTTPException(409, "Steam-аккаунт изменился.")
        game = session.scalar(select(Game).where(Game.igdb_id == payload.igdbId))
        if game is None:
            raise HTTPException(404, "Игра не найдена.")
        entry = session.scalar(select(UserGame).where(
            UserGame.user_id == user.id, UserGame.game_id == game.id
        ))
        if entry is None:
            raise HTTPException(409, "Сначала добавьте игру в Rate APP.")
        # Avoid claiming the same Steam app for multiple library games.
        for row in session.scalars(select(UserGame).where(
            UserGame.user_id == user.id, UserGame.steam_data.is_not(None)
        )):
            if row.id != entry.id and any(
                a.get("appid") == payload.appid for a in (row.steam_data or {}).get("apps", [])
                if isinstance(a, dict)
            ):
                raise HTTPException(409, "Это Steam-приложение уже связано с другой игрой.")
        data = dict(entry.steam_data or {})
        apps = [a for a in data.get("apps", []) if a.get("appid") != payload.appid]
        apps.append({"appid": payload.appid, "minutes": None})
        data.update({"imported": bool(data.get("imported", False)), "apps": apps,
                     "steam_id64": steam_id,
                     "last_synced_at": _now().isoformat()})
        entry.steam_data = data
        session.commit()
    return {"linked": True}
