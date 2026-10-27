"""Single IGDB gateway for all API routes.

One bounded priority queue per FastAPI process. Production and staging each use
one Uvicorn worker and reserve 0.75s per outbound IGDB request (combined
~2.67/s, below IGDB's 4/s). Additional replicas require a distributed limiter.
No scheduled bulk traffic is started by importing this module.
"""
from __future__ import annotations

import itertools
import os
import queue
import threading
import time
from dataclasses import dataclass, field
from enum import IntEnum

import httpx
from fastapi import HTTPException


class Priority(IntEnum):
    SEARCH = 0
    DETAILS = 1
    BACKGROUND = 2


# IGDB: four requests per second globally per credentials. Two known processes
# (production + staging) share these credentials; reserve headroom for bursts.
MIN_REQUEST_INTERVAL = 0.75
QUEUE_LIMIT = 48
QUEUE_WAIT_SECONDS = 48.0
IGDB_TIMEOUT_SECONDS = 12.0


@dataclass
class _Pending:
    endpoint: str
    body: str
    deadline: float
    ready: threading.Event = field(default_factory=threading.Event)
    result: list[dict[str, object]] | None = None
    error: Exception | None = None


class IGDBClient:
    def __init__(self, *, interval: float = MIN_REQUEST_INTERVAL, limit: int = QUEUE_LIMIT):
        self._interval = interval
        self._queue: queue.PriorityQueue[tuple[int, int, _Pending]] = queue.PriorityQueue(limit)
        self._counter = itertools.count()
        self._lock = threading.Lock()
        self._worker: threading.Thread | None = None
        self._next_request_at = 0.0
        self._token: str | None = None
        self._token_expires = 0.0

    def request(
        self, endpoint: str, body: str, *, priority: Priority = Priority.DETAILS,
    ) -> list[dict[str, object]]:
        if endpoint not in {"games", "genres", "search", "game_time_to_beats", "multiquery"}:
            raise ValueError("Unsupported IGDB endpoint")
        pending = _Pending(endpoint=endpoint, body=body, deadline=time.monotonic() + QUEUE_WAIT_SECONDS)
        with self._lock:
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(
                    target=self._run, name="rateapp-igdb-queue", daemon=True,
                )
                self._worker.start()
        try:
            self._queue.put_nowait((int(priority), next(self._counter), pending))
        except queue.Full as exc:
            raise HTTPException(status_code=503, detail="Очередь IGDB переполнена. Попробуйте позже.") from exc
        if not pending.ready.wait(QUEUE_WAIT_SECONDS):
            raise HTTPException(status_code=503, detail="IGDB слишком долго отвечает. Попробуйте позже.")
        if pending.error is not None:
            if isinstance(pending.error, HTTPException):
                raise pending.error
            raise HTTPException(status_code=502, detail="Не удалось получить данные из IGDB.") from pending.error
        return pending.result if pending.result is not None else []

    def _run(self) -> None:
        while True:
            _, _, pending = self._queue.get()
            try:
                if time.monotonic() > pending.deadline:
                    raise HTTPException(status_code=503, detail="Время ожидания IGDB истекло.")
                pending.result = self._fetch(pending.endpoint, pending.body)
            except Exception as exc:
                pending.error = exc
            finally:
                pending.ready.set()
                self._queue.task_done()

    def _credentials(self) -> tuple[str, str]:
        client_id = os.getenv("IGDB_CLIENT_ID", "").strip()
        client_secret = os.getenv("IGDB_CLIENT_SECRET", "").strip()
        if not client_id or not client_secret:
            raise HTTPException(status_code=503, detail="IGDB ещё не настроен.")
        return client_id, client_secret

    def _access_token(self) -> tuple[str, str]:
        client_id, secret = self._credentials()
        if self._token and time.monotonic() < self._token_expires - 60:
            return client_id, self._token
        try:
            response = httpx.post(
                "https://id.twitch.tv/oauth2/token",
                data={"client_id": client_id, "client_secret": secret, "grant_type": "client_credentials"},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=10.0,
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(status_code=502, detail="Не удалось получить токен Twitch OAuth.") from exc
        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise HTTPException(status_code=502, detail="Twitch не вернул токен IGDB.")
        self._token = token
        self._token_expires = time.monotonic() + int(payload.get("expires_in") or 3600)
        return client_id, token

    def _fetch(self, endpoint: str, body: str) -> list[dict[str, object]]:
        for attempt in range(3):
            client_id, token = self._access_token()
            delay = self._next_request_at - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            self._next_request_at = time.monotonic() + self._interval
            try:
                response = httpx.post(
                    f"https://api.igdb.com/v4/{endpoint}",
                    headers={
                        "Client-ID": client_id,
                        "Authorization": f"Bearer {token}",
                        "Accept": "application/json",
                    },
                    content=body,
                    timeout=IGDB_TIMEOUT_SECONDS,
                )
                if response.status_code == 429:
                    if attempt == 2:
                        raise HTTPException(status_code=429, detail="IGDB занят. Повторите запрос позже.")
                    retry_after = response.headers.get("Retry-After", "1")
                    try:
                        wait = max(1.0, min(3.0, float(retry_after)))
                    except ValueError:
                        wait = 1.0
                    self._next_request_at = max(self._next_request_at, time.monotonic() + wait)
                    continue
                if response.status_code == 401 and attempt == 0:
                    self._token = None
                    continue
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, list):
                    raise HTTPException(status_code=502, detail="IGDB вернул некорректные данные.")
                return [item for item in payload if isinstance(item, dict)]
            except (httpx.HTTPError, ValueError) as exc:
                raise HTTPException(status_code=502, detail="IGDB временно недоступен.") from exc
        raise HTTPException(status_code=502, detail="Не удалось получить данные из IGDB.")


igdb_client = IGDBClient()
