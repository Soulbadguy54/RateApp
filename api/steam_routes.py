"""Steam OpenID 2.0 identity linking (no game import or Steam Web API key).

Important: OpenID verifies a SteamID64 identity, NOT access to private games.
The initiating Rate APP user+session and one-time return_to state are verified
before updating the connection. Nothing changes in user_games / collections.
"""
import hashlib
import os
import re
import secrets
from datetime import timedelta
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from api.models import SteamConnection, SteamLinkChallenge, SteamSyncPreview
from api.security import SESSION_COOKIE, _current_user, _hash_token, _now, _session

router = APIRouter()
STEAM_ENDPOINT = "https://steamcommunity.com/openid/login"
STEAM_ID_PATTERN = re.compile(r"^https?://steamcommunity\.com/openid/id/(7656119\d{10})$")
STATE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,96}$")
CHALLENGE_MINUTES = 10


def _origin() -> str:
    """Pinned per environment; Host/X-Forwarded-Host cannot redirect OpenID."""
    env = os.getenv("VERCEL_ENV", "").lower()
    if env == "staging":
        return "https://dev.r-app.ru"
    if env == "production":
        return "https://r-app.ru"
    # Local developer environment. No untrusted Host header is interpolated.
    return "http://127.0.0.1:5173"


def _return_url(state: str) -> str:
    return _origin() + "/api/steam/callback?" + urlencode({"state": state})


def _back(status: str) -> RedirectResponse:
    return RedirectResponse(_origin() + "/?tab=profile&steam=" + status, status_code=303)


def _current_auth(request: Request, session):
    user = _current_user(request, session)
    cookie = request.cookies.get(SESSION_COOKIE, "")
    return user, _hash_token(cookie)


def _verify_query(params: dict[str, str], expected: str) -> str:
    """Verify local claims first; Steam then revalidates every signed field."""
    if params.get("openid.mode") != "id_res":
        raise ValueError("OpenID response is not authenticated")
    if params.get("openid.ns") != "http://specs.openid.net/auth/2.0":
        raise ValueError("Wrong OpenID namespace")
    if params.get("openid.return_to") != expected:
        raise ValueError("Wrong return_to")
    if params.get("openid.op_endpoint") != STEAM_ENDPOINT:
        raise ValueError("Wrong provider")
    claimed = params.get("openid.claimed_id", "")
    identity = params.get("openid.identity", "")
    match = STEAM_ID_PATTERN.fullmatch(claimed)
    if match is None or identity != claimed:
        raise ValueError("Untrusted Steam claimed ID")
    signed = set(params.get("openid.signed", "").split(","))
    if not {"return_to", "claimed_id", "identity", "op_endpoint", "response_nonce"}.issubset(signed):
        raise ValueError("Required claims were not signed")
    if not params.get("openid.response_nonce") or not params.get("openid.sig"):
        raise ValueError("Missing provider assertion")
    return match.group(1)


def _check_steam(params: dict[str, str]) -> bool:
    payload = {k: v for k, v in params.items() if k.startswith("openid.")}
    payload["openid.mode"] = "check_authentication"
    try:
        with httpx.Client(timeout=9.0, follow_redirects=False, trust_env=False) as client:
            response = client.post(STEAM_ENDPOINT, data=payload)
        response.raise_for_status()
        return re.search(r"(?m)^is_valid:true\s*$", response.text) is not None
    except (httpx.HTTPError, ValueError):
        return False


@router.get("/api/steam/connection")
def steam_connection(request: Request) -> dict[str, object]:
    with _session() as session:
        user = _current_user(request, session)
        row = session.scalar(select(SteamConnection).where(SteamConnection.user_id == user.id))
        return {
            "connected": row is not None,
            "steamId64": row.steam_id64 if row is not None else None,
        }


@router.get("/api/steam/connect")
def start_steam_link(request: Request):
    """SameSite=Lax cookie survives Steam's top-level GET callback."""
    with _session() as session:
        user, session_hash = _current_auth(request, session)
        state = secrets.token_urlsafe(32)
        session.execute(delete(SteamLinkChallenge).where(
            SteamLinkChallenge.user_id == user.id,
        ))
        session.add(SteamLinkChallenge(
            user_id=user.id, session_hash=session_hash,
            state_hash=hashlib.sha256(state.encode("ascii")).hexdigest(),
            expires_at=_now() + timedelta(minutes=CHALLENGE_MINUTES),
        ))
        session.commit()
    callback = _return_url(state)
    query = {
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "checkid_setup",
        "openid.return_to": callback,
        "openid.realm": _origin() + "/",
        "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    }
    return RedirectResponse(STEAM_ENDPOINT + "?" + urlencode(query), status_code=303)


@router.get("/api/steam/callback")
def finish_steam_link(request: Request):
    # Never use the incoming Host header to construct the Steam assertion.
    if request.url.hostname != urlsplit(_origin()).hostname:
        raise HTTPException(400, "Invalid callback host")
    pairs = request.query_params.multi_items()
    if len(pairs) > 30 or sum(len(k) + len(v) for k, v in pairs) > 15000:
        return _back("invalid")
    params = dict(pairs)
    if len(params) != len(pairs):
        return _back("invalid")
    state = params.pop("state", "")
    if STATE_PATTERN.fullmatch(state) is None:
        return _back("invalid")
    with _session() as session:
        try:
            user, session_hash = _current_auth(request, session)
        except HTTPException:
            return _back("session")
        digest = hashlib.sha256(state.encode("ascii")).hexdigest()
        # Atomic single-use consume BEFORE network verification, including
        # on a failed assertion. No other session can replay this state.
        consumed = session.execute(delete(SteamLinkChallenge).where(
            SteamLinkChallenge.state_hash == digest,
            SteamLinkChallenge.user_id == user.id,
            SteamLinkChallenge.session_hash == session_hash,
            SteamLinkChallenge.expires_at > _now(),
        ))
        session.commit()
        if consumed.rowcount != 1:
            return _back("expired")

    try:
        steam_id = _verify_query(params, _return_url(state))
    except ValueError:
        return _back("invalid")
    if not _check_steam(params):
        return _back("unavailable")

    with _session() as session:
        # The external provider check happens outside the DB transaction.
        # Revalidate the *same* Rate APP identity/session after that request;
        # an expired/revoked or switched account must never receive the link.
        try:
            final_user, final_session_hash = _current_auth(request, session)
        except HTTPException:
            return _back("session")
        if final_user.id != user.id or final_session_hash != session_hash:
            return _back("session")
        existing = session.scalar(select(SteamConnection).where(
            SteamConnection.user_id == final_user.id,
        ))
        if existing is None:
            session.add(SteamConnection(user_id=user.id, steam_id64=steam_id))
        else:
            if existing.steam_id64 != steam_id:
                existing.last_synced_at = None
                existing.last_preview_at = None
                session.execute(delete(SteamSyncPreview).where(SteamSyncPreview.user_id == final_user.id))
            existing.steam_id64 = steam_id
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            return _back("taken")
    return _back("connected")


@router.delete("/api/steam/connection")
def unlink_steam(request: Request) -> dict[str, bool]:
    # Fetch/XHR only; same-origin header required to avoid CSRF unlink requests.
    if request.headers.get("origin") != _origin():
        raise HTTPException(status_code=403, detail="Same-origin request required")
    with _session() as session:
        user = _current_user(request, session)
        session.execute(delete(SteamConnection).where(SteamConnection.user_id == user.id))
        session.execute(delete(SteamLinkChallenge).where(SteamLinkChallenge.user_id == user.id))
        session.execute(delete(SteamSyncPreview).where(SteamSyncPreview.user_id == user.id))
        session.commit()
    # No game data is touched. Provenance/cleanup will be a separately reviewed
    # decision after the future import model exists.
    return {"connected": False}
