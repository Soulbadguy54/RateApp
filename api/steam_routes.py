"""Steam OpenID 2.0 account linking. Deliberately does not import games."""
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

from api.models import AuthSession, SteamConnection, SteamLinkState
from api.security import SESSION_COOKIE, _session, _current_user, _hash_token, _now

router = APIRouter()
STEAM_OPENID = "https://steamcommunity.com/openid/login"
CLAIMED_ID = re.compile(r"^https?://steamcommunity\.com/openid/id/(7656119\d{10})$")
NS = "http://specs.openid.net/auth/2.0"
IDENTIFIER = NS + "/identifier_select"
ALLOWED_HOSTS = {"r-app.ru", "dev.r-app.ru", "127.0.0.1", "localhost"}


def _origin(request: Request) -> str:
    # Fixed allow-list prevents Host header injection into trusted OpenID return_to.
    hostname = request.url.hostname
    if hostname not in ALLOWED_HOSTS:
        raise HTTPException(400, "Invalid application host")
    scheme = "http" if hostname in {"127.0.0.1", "localhost"} else "https"
    port = f":{request.url.port}" if hostname in {"127.0.0.1", "localhost"} and request.url.port else ""
    return f"{scheme}://{hostname}{port}"


def _existing_session(request: Request, session, user_id: int) -> AuthSession:
    cookie = request.cookies.get(SESSION_COOKIE, "")
    row = session.scalar(select(AuthSession).where(
        AuthSession.token_hash == _hash_token(cookie),
        AuthSession.user_id == user_id,
        AuthSession.expires_at > _now(),
    ))
    if row is None:
        raise HTTPException(401, "Session expired")
    return row


@router.get("/api/steam/status")
def steam_status(request: Request):
    with _session() as db:
        user = _current_user(request, db)
        link = db.get(SteamConnection, user.id)
        return {"connected": link is not None, "steamId": link.steam_id64 if link else None}


@router.get("/api/steam/connect")
def steam_connect(request: Request):
    with _session() as db:
        user = _current_user(request, db)
        auth = _existing_session(request, db, user.id)
        state = secrets.token_urlsafe(32)
        origin = _origin(request)
        db.add(SteamLinkState(
            state_hash=hashlib.sha256(state.encode()).hexdigest(),
            user_id=user.id,
            session_id=auth.id,
            expires_at=_now() + timedelta(minutes=10),
        ))
        db.commit()
    callback = origin + "/api/steam/callback?state=" + state
    params = {
        "openid.ns": NS,
        "openid.mode": "checkid_setup",
        "openid.return_to": callback,
        "openid.realm": origin + "/",
        "openid.identity": IDENTIFIER,
        "openid.claimed_id": IDENTIFIER,
    }
    return RedirectResponse(STEAM_OPENID + "?" + urlencode(params), status_code=303)


@router.get("/api/steam/callback")
def steam_callback(request: Request, state: str = ""):
    origin = _origin(request)
    failure = origin + "/?tab=profile&steam=error"
    if not 20 <= len(state) <= 100:
        return RedirectResponse(failure, status_code=303)

    values = dict(request.query_params)
    expected = origin + "/api/steam/callback?state=" + state
    if (values.get("openid.ns") != NS
        or values.get("openid.mode") != "id_res"
        or values.get("openid.op_endpoint") != STEAM_OPENID
        or values.get("openid.return_to") != expected):
        return RedirectResponse(failure, status_code=303)
    claimed = values.get("openid.claimed_id", "")
    identity = values.get("openid.identity", "")
    match = CLAIMED_ID.fullmatch(claimed)
    if not match or identity != claimed:
        return RedirectResponse(failure, status_code=303)
    required_signed = {"op_endpoint", "claimed_id", "identity", "return_to", "response_nonce", "assoc_handle"}
    if not required_signed.issubset(set(values.get("openid.signed", "").split(","))):
        return RedirectResponse(failure, status_code=303)

    # Steam verifies the OpenID assertion itself. Never trust a browser claim.
    verification = {k: v for k, v in values.items() if k.startswith("openid.")}
    verification["openid.mode"] = "check_authentication"
    try:
        with httpx.Client(timeout=9.0, follow_redirects=False) as client:
            response = client.post(STEAM_OPENID, data=verification)
            response.raise_for_status()
        if "is_valid:true" not in response.text.splitlines():
            return RedirectResponse(failure, status_code=303)
    except httpx.HTTPError:
        return RedirectResponse(failure, status_code=303)

    with _session() as db:
        try:
            user = _current_user(request, db)
            auth = _existing_session(request, db, user.id)
        except HTTPException:
            return RedirectResponse(failure, status_code=303)
        state_hash = hashlib.sha256(state.encode()).hexdigest()
        row = db.get(SteamLinkState, state_hash)
        if not row or row.expires_at <= _now() or row.user_id != user.id or row.session_id != auth.id:
            return RedirectResponse(failure, status_code=303)
        # Delete the state inside the same transaction as the binding.
        db.delete(row)
        existing = db.scalar(select(SteamConnection).where(SteamConnection.steam_id64 == match.group(1)))
        if existing and existing.user_id != user.id:
            db.commit()  # consume one-time state even on conflict
            return RedirectResponse(origin + "/?tab=profile&steam=conflict", status_code=303)
        link = db.get(SteamConnection, user.id)
        if link:
            link.steam_id64 = match.group(1)
        else:
            db.add(SteamConnection(user_id=user.id, steam_id64=match.group(1)))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return RedirectResponse(failure, status_code=303)
    return RedirectResponse(origin + "/?tab=profile&steam=connected", status_code=303)


@router.delete("/api/steam/connection")
def steam_disconnect(request: Request):
    with _session() as db:
        user = _current_user(request, db)
        db.execute(delete(SteamConnection).where(SteamConnection.user_id == user.id))
        db.commit()
    return {"connected": False}
