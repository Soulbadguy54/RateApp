"""Credential validation, session tokens and login throttling.

All authentication primitives live here; no import of api.index and no database
schema changes. Session token hashes are irreversible and cookies are HttpOnly.
"""
import hashlib
import os
import re
import secrets
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from fastapi import HTTPException, Request, Response
from sqlalchemy import select

from api.database import SessionLocal
from api.models import AuthSession, LoginThrottle, User

PIN_RE = re.compile(r"^\d{4,8}$")
NICK_RE = re.compile(r"^[a-z0-9_]{3,16}$")
SESSION_COOKIE = "rateapp_session"
SESSION_DAYS = 30
MAX_LOGIN_FAILURES = 5
LOCK_MINUTES = 15
password_hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
def _session():
    if SessionLocal is None:
        raise HTTPException(status_code=503, detail="Database is not configured")
    return SessionLocal()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_DAYS * 24 * 60 * 60,
        httponly=True,
        secure=os.getenv("VERCEL_ENV") != "development",
        samesite="lax",
        path="/",
    )


def _user_payload(user: User) -> dict[str, object]:
    return {
        "id": user.id,
        "email": user.email,
        "nickname": user.nickname,
        "profileTint": user.profile_tint,
        "avatarVersion": user.avatar_version,
        "createdAt": user.created_at.isoformat(),
        "public": True,
    }


def _create_session(session, user: User, response: Response) -> None:
    token = secrets.token_urlsafe(32)
    session.add(
        AuthSession(
            user_id=user.id,
            token_hash=_hash_token(token),
            expires_at=_now() + timedelta(days=SESSION_DAYS),
        )
    )
    session.commit()
    _set_session_cookie(response, token)


def _current_user(request: Request, session) -> User:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")

    row = session.scalar(
        select(AuthSession).where(
            AuthSession.token_hash == _hash_token(token),
            AuthSession.expires_at > _now(),
        )
    )
    if row is None:
        raise HTTPException(status_code=401, detail="Session expired")

    user = session.get(User, row.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


def _check_throttle(session, identifier: str) -> None:
    row = session.get(LoginThrottle, identifier)
    if row is None or row.locked_until is None:
        return
    if row.locked_until > _now():
        raise HTTPException(status_code=429, detail="Слишком много попыток. Попробуйте через 15 минут.")
    session.delete(row)
    session.commit()


def _record_login_failure(session, identifier: str) -> None:
    row = session.get(LoginThrottle, identifier)
    if row is None:
        row = LoginThrottle(identifier=identifier, failures=0)
        session.add(row)

    row.failures += 1
    if row.failures >= MAX_LOGIN_FAILURES:
        row.failures = 0
        row.locked_until = _now() + timedelta(minutes=LOCK_MINUTES)
    session.commit()


def _clear_throttle(session, identifier: str) -> None:
    row = session.get(LoginThrottle, identifier)
    if row is not None:
        session.delete(row)
        session.commit()


