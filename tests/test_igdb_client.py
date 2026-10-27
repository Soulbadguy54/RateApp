"""Age-based cache and the single IGDB priority queue (no live API calls)."""
import threading
import time
import unittest
from datetime import date, timedelta
from unittest.mock import patch

from fastapi import HTTPException

from api.games_routes import _game_details_cache_days
from api.igdb_client import IGDBClient, Priority


class CacheAgePolicyTests(unittest.TestCase):
    def test_new_and_unreleased_games_refresh_more_often(self):
        today = date(2026, 10, 24)
        self.assertEqual(_game_details_cache_days(today + timedelta(days=30), today=today), 7)
        self.assertEqual(_game_details_cache_days(today - timedelta(days=10), today=today), 7)
        self.assertEqual(_game_details_cache_days(today - timedelta(days=90), today=today), 30)
        self.assertEqual(_game_details_cache_days(today - timedelta(days=365), today=today), 90)
        self.assertEqual(_game_details_cache_days(today - timedelta(days=1000), today=today), 180)
        self.assertEqual(_game_details_cache_days(today - timedelta(days=3650), today=today), 365)
        self.assertEqual(_game_details_cache_days(None, today=today), 60)


class GatewayQueueTests(unittest.TestCase):
    def test_interactive_search_overtakes_queued_background_requests(self):
        client = IGDBClient(interval=0)
        first_started = threading.Event()
        release_first = threading.Event()
        order: list[str] = []
        outputs: dict[str, object] = {}

        def fake_fetch(endpoint, body):
            if body == "first":
                first_started.set()
                self.assertTrue(release_first.wait(5))
            order.append(body)
            return [{"name": body}]

        client._fetch = fake_fetch  # type: ignore[method-assign]

        def run(name, priority):
            outputs[name] = client.request("games", name, priority=priority)

        a = threading.Thread(target=run, args=("first", Priority.BACKGROUND))
        a.start()
        self.assertTrue(first_started.wait(5))
        b = threading.Thread(target=run, args=("background", Priority.BACKGROUND))
        b.start()
        c = threading.Thread(target=run, args=("search", Priority.SEARCH))
        c.start()
        deadline = time.monotonic() + 5
        while client._queue.qsize() < 2 and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertEqual(client._queue.qsize(), 2)
        release_first.set()
        for thread in (a, b, c):
            thread.join(5)
            self.assertFalse(thread.is_alive())
        self.assertEqual(order, ["first", "search", "background"])
        self.assertEqual(outputs["search"], [{"name": "search"}])

    def test_retry_after_429_bounded_and_returns_normalized_rows(self):
        client = IGDBClient(interval=0)
        calls = []

        class Response:
            def __init__(self, status, payload):
                self.status_code = status
                self.headers = {"Retry-After": "invalid"}
                self.payload = payload
            def raise_for_status(self):
                pass
            def json(self):
                return self.payload

        def fake_post(url, *, headers, content, timeout):
            calls.append((url, content))
            if len(calls) == 1:
                return Response(429, [])
            return Response(200, [{"id": 1}, "bad", {"id": 2}])

        with (
            patch.object(client, "_access_token", return_value=("client", "token")),
            patch("api.igdb_client.httpx.post", side_effect=fake_post),
            patch("api.igdb_client.time.sleep"),
        ):
            result = client.request("games", "fields id;", priority=Priority.SEARCH)
        self.assertEqual(result, [{"id": 1}, {"id": 2}])
        self.assertEqual(len(calls), 2)

    def test_unsupported_endpoint_is_rejected(self):
        with self.assertRaises(ValueError):
            IGDBClient().request("any-url", "fields *;")

    def test_queue_errors_are_returned_to_callers(self):
        client = IGDBClient(interval=0)
        def broken(endpoint, body):
            raise HTTPException(status_code=429, detail="test")
        client._fetch = broken  # type: ignore[method-assign]
        with self.assertRaises(HTTPException) as error:
            client.request("games", "fields id;")
        self.assertEqual(error.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
