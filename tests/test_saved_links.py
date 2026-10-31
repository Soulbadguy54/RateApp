"""One-table URL ownership, GPT result persistence and date-based queue."""
import secrets
import unittest
from datetime import timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import select

from api.database import SessionLocal
from api.index import app
from api.models import Game, SavedLink, User
from api.saved_links_routes import canonical_url
from api.saved_links_worker import claim_jobs, resolve_games, submit_result
from api.security import _now


class SavedLinkTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="https://testserver")
        self.nick = "s" + secrets.token_hex(4)
        response = self.client.post("/api/auth/register", json={
            "email": self.nick + "@example.com", "nickname": self.nick,
            "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.igdb_id = 1200000000 + secrets.randbelow(300000000)
        with SessionLocal() as session:
            game = Game(igdb_id=self.igdb_id, title="Hollow Knight Test")
            session.add(game)
            session.commit()
            self.game_pk = game.id

    def tearDown(self):
        self.client.close()
        with SessionLocal() as session:
            user = session.scalar(select(User).where(User.nickname == self.nick))
            if user: session.delete(user)
            game = session.scalar(select(Game).where(Game.igdb_id == self.igdb_id))
            if game: session.delete(game)
            session.commit()

    def save(self, suffix="a"):
        result = self.client.post("/api/saved-links", json={
            "url": f"https://example.org/{self.nick}/{suffix}",
        })
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()

    def test_url_and_owner_unique_and_null_distinct_from_empty(self):
        for url in ("file:///etc/passwd", "http://127.0.0.1/",
                    "https://localhost/", "https://foo.test/",
                    "https://user:password@example.org/"):
            self.assertEqual(self.client.post("/api/saved-links",
                             json={"url":url}).status_code, 422)
        self.assertEqual(canonical_url("HTTPS://EXAMPLE.ORG/Page#fragment"),
                         "https://example.org/Page")
        self.assertEqual(TestClient(app).get("/api/saved-links").status_code, 401)
        first = self.save()
        self.assertIsNone(first["gptNames"])
        self.assertEqual(first["gameIds"], [])
        self.assertEqual(self.save()["id"], first["id"])
        claim = claim_jobs(only_id=first["id"])["jobs"][0]
        result = submit_result({"id": first["id"], "leaseToken": claim["leaseToken"],
                                "games": []})
        self.assertEqual(result["status"], "ready")
        finished = self.client.get(f'/api/saved-links/{first["id"]}').json()
        self.assertEqual(finished["gptNames"], [])
        self.assertEqual(claim_jobs(only_id=first["id"])["jobs"], [])

    def test_oldest_url_first_and_list_newest_first(self):
        first = self.save("old")
        second = self.save("new")
        got = claim_jobs()["jobs"][0]
        self.assertEqual(got["id"], first["id"])
        links = self.client.get("/api/saved-links").json()["items"]
        self.assertEqual([x["id"] for x in links[:2]],
                         [second["id"], first["id"]])
        with self.assertRaises(ValueError):
            claim_jobs(limit=2)

    def test_names_and_local_ids_remain_until_link_is_deleted(self):
        link = self.save()
        claim = claim_jobs(only_id=link["id"])["jobs"][0]
        submitted = submit_result({"id":link["id"], "leaseToken":claim["leaseToken"],
                                   "games":["Hollow Knight Test","Outer Wilds"]})
        self.assertEqual(submitted["gamesCount"], 2)
        self.assertTrue(submit_result({"id":link["id"], "leaseToken":claim["leaseToken"],
                                       "games":["Hollow Knight Test"]})["idempotent"])
        with patch("api.saved_links_worker._find_top_game_id",
                   side_effect=lambda n: self.igdb_id if n == "Hollow Knight Test" else None):
            result = resolve_games(only_id=link["id"])
        self.assertTrue(result["complete"])
        fetched = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(fetched["status"], "ready")
        self.assertEqual(fetched["gptNames"], ["Hollow Knight Test", "Outer Wilds"])
        self.assertEqual(fetched["gameIds"], [self.game_pk])
        self.assertEqual(fetched["games"][0]["igdbId"], self.igdb_id)
        self.assertEqual(self.client.delete(f'/api/saved-links/{link["id"]}').status_code, 204)
        with SessionLocal() as session:
            self.assertIsNone(session.get(SavedLink, link["id"]))
        with self.assertRaises(ValueError):
            submit_result({"id":link["id"], "leaseToken":claim["leaseToken"],
                           "games":["Hollow Knight Test"]})

    def test_preview_only_after_save_and_reputation_checked(self):
        link = self.save("preview")
        self.assertIsNone(link["title"])
        # A fast save does not read the source or update its metadata.
        with patch("api.saved_links_safety.preview_source", return_value={
            "title": "Verified article title", "description": "Verified metadata",
        }) as preview:
            result = self.client.post(f'/api/saved-links/{link["id"]}/preview')
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["title"], "Verified article title")
            self.assertEqual(result.json()["description"], "Verified metadata")
            preview.assert_called_once_with(link["url"])
        saved = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(saved["title"], "Verified article title")
        with patch("api.saved_links_safety.preview_source", side_effect=AssertionError("cache missed")):
            cached = self.client.post(f'/api/saved-links/{link["id"]}/preview')
        self.assertEqual(cached.json()["title"], "Verified article title")

    def test_failed_preview_never_fetches_untrusted_remote_images(self):
        from api.saved_links_safety import SourceSafetyError
        link = self.save("blocked-preview")
        with patch("api.saved_links_safety.preview_source",
                   side_effect=SourceSafetyError("Unsafe URL", terminal=True)):
            response = self.client.post(f'/api/saved-links/{link["id"]}/preview')
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["title"])
        self.assertIsNone(response.json()["description"])
        self.assertIsNone(self.client.get(f'/api/saved-links/{link["id"]}').json()["title"])

    def test_bulk_delete_is_atomic_scoped_and_preserves_catalog(self):
        first = self.save("bulk-a")
        second = self.save("bulk-b")
        keeper = self.save("bulk-kept")
        endpoint = "/api/saved-links/bulk-delete"

        # A missing/foreign row makes the entire operation fail: no partial delete.
        self.assertEqual(self.client.post(endpoint, json={
            "ids": [first["id"], 2147483647],
        }).status_code, 404)
        self.assertEqual(self.client.get(f'/api/saved-links/{first["id"]}').status_code, 200)
        for ids in ([], [first["id"], first["id"]], [-1], [True], ["1"]):
            self.assertEqual(self.client.post(endpoint, json={"ids": ids}).status_code, 422)
        self.assertEqual(TestClient(app).post(endpoint, json={
            "ids": [first["id"]],
        }).status_code, 401)

        response = self.client.post(endpoint, json={"ids": [first["id"], second["id"]]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"deleted": 2})
        self.assertEqual(self.client.get(f'/api/saved-links/{first["id"]}').status_code, 404)
        self.assertEqual(self.client.get(f'/api/saved-links/{second["id"]}').status_code, 404)
        self.assertEqual(self.client.get(f'/api/saved-links/{keeper["id"]}').status_code, 200)
        with SessionLocal() as session:
            self.assertIsNotNone(session.get(Game, self.game_pk))

    def test_expired_claim_retry_failed_and_explicit_refresh(self):
        link = self.save()
        first = claim_jobs(only_id=link["id"])["jobs"][0]
        with SessionLocal() as session:
            row = session.get(SavedLink, link["id"])
            row.lease_until = _now() - timedelta(minutes=1)
            session.commit()
        second = claim_jobs(only_id=link["id"])["jobs"][0]
        self.assertNotEqual(first["leaseToken"], second["leaseToken"])
        with self.assertRaises(ValueError):
            submit_result({"id":link["id"], "leaseToken":first["leaseToken"],
                           "games":["Hades"]})
        self.assertEqual(submit_result({
            "id":link["id"], "leaseToken":second["leaseToken"],
            "error":"Источник недоступен",
        })["status"], "pending")
        third = claim_jobs(only_id=link["id"])["jobs"][0]
        self.assertEqual(submit_result({
            "id":link["id"], "leaseToken":third["leaseToken"],
            "error":"Источник недоступен",
        })["status"], "failed")
        self.assertEqual(claim_jobs(only_id=link["id"])["jobs"], [])
        retry = self.client.post(f'/api/saved-links/{link["id"]}/retry')
        self.assertEqual(retry.json()["status"], "pending")
        fourth = claim_jobs(only_id=link["id"])["jobs"][0]
        submit_result({"id":link["id"], "leaseToken":fourth["leaseToken"], "games":[]})
        refreshed = self.client.post(f'/api/saved-links/{link["id"]}/refresh')
        self.assertEqual(refreshed.json()["status"], "pending")
        self.assertIsNone(refreshed.json()["gptNames"])
        self.assertEqual(refreshed.json()["gameIds"], [])
        self.assertEqual(claim_jobs(only_id=link["id"])["jobs"][0]["attempt"], 1)

    def test_catalog_delete_trigger_removes_ids_not_url_or_names(self):
        link = self.save()
        claim = claim_jobs(only_id=link["id"])["jobs"][0]
        submit_result({"id":link["id"], "leaseToken":claim["leaseToken"],
                       "games":["Hollow Knight Test"]})
        with patch("api.saved_links_worker._find_top_game_id", return_value=self.igdb_id):
            self.assertTrue(resolve_games(only_id=link["id"])["complete"])
        with SessionLocal() as session:
            session.delete(session.get(Game, self.game_pk))
            session.commit()
        fetched = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(fetched["gameIds"], [])
        self.assertEqual(fetched["gptNames"], ["Hollow Knight Test"])

    def test_another_user_cannot_read_or_modify(self):
        link = self.save()
        other = TestClient(app, base_url="https://testserver")
        nick = "z" + secrets.token_hex(4)
        self.assertEqual(other.post("/api/auth/register", json={
            "email": nick + "@example.com", "nickname": nick,
            "pin": "12345678",
        }).status_code, 201)
        for method, path in [("get",""),("delete",""),("post","/refresh"),("post","/retry")]:
            self.assertEqual(getattr(other,method)(
                f'/api/saved-links/{link["id"]}{path}').status_code,404)
        self.assertEqual(other.post(f'/api/saved-links/{link["id"]}/preview').status_code, 404)
        self.assertEqual(other.post("/api/saved-links/bulk-delete", json={
            "ids": [link["id"]],
        }).status_code, 404)
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').status_code, 200)
        other.close()
        with SessionLocal() as session:
            user = session.scalar(select(User).where(User.nickname == nick))
            if user: session.delete(user)
            session.commit()
