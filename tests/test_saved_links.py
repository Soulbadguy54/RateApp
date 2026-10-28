"""Saved-links storage/queue security and idempotence on isolated PostgreSQL."""
import secrets
import unittest
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from api.index import app
from api.database import SessionLocal
from api.models import Game, SavedLink, SavedLinkGame
from api.saved_links_routes import canonical_url
from api.saved_links_worker import claim_jobs, submit_result
from api.security import _now


class SavedLinkTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="https://testserver")
        suffix = secrets.token_hex(4)
        self.nickname = "l" + suffix
        reply = self.client.post("/api/auth/register", json={
            "email": self.nickname + "@example.com",
            "nickname": self.nickname,
            "pin": "12345678",
        })
        self.assertEqual(reply.status_code, 201, reply.text)
        self.igdb_id = secrets.randbelow(600_000_000) + 300_000_000
        with SessionLocal() as session:
            session.add(Game(igdb_id=self.igdb_id, title="Hollow Knight Test"))
            session.commit()

    def tearDown(self):
        self.client.close()

    def _save(self, url=None):
        return self.client.post("/api/saved-links", json={
            "url": url or f"https://example.org/games/{self.nickname}",
            "title": "  Игровая подборка  ",
        })

    def test_url_validation_rejects_local_credentials_and_bad_schemes(self):
        for value in (
            "file:///etc/passwd",
            "http://127.0.0.1/info",
            "http://192.168.1.2/path",
            "https://localhost/test",
            "http://metadata.google.internal/",
            "https://foo.test/test",
            "https://user:pw@example.org/",
            "https://example.org:8080/",
        ):
            with self.subTest(value=value):
                self.assertEqual(self.client.post("/api/saved-links",
                    json={"url": value}).status_code, 422)
        self.assertEqual(canonical_url("HTTPS://EXAMPLE.ORG/Page#fragment"),
                         "https://example.org/Page")

    def test_create_deduplicate_and_delete_without_library_writes(self):
        self.assertEqual(TestClient(app).get("/api/saved-links").status_code, 401)
        first = self._save()
        self.assertEqual(first.status_code, 201, first.text)
        item = first.json()
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["games"], [])
        self.assertEqual(item["title"], "Игровая подборка")
        again = self._save()
        self.assertEqual(again.json()["id"], item["id"])
        listing = self.client.get("/api/saved-links").json()
        self.assertEqual(len(listing["items"]), 1)
        self.assertEqual(self.client.delete(f'/api/saved-links/{item["id"]}').status_code, 204)
        self.assertEqual(self.client.get(f'/api/saved-links/{item["id"]}').status_code, 404)

    def test_worker_atomic_claim_dedupe_and_link_to_existing_igdb(self):
        entry = self._save().json()
        job = claim_jobs(only_id=entry["id"])["jobs"][0]
        self.assertEqual(job["attempt"], 1)
        self.assertEqual(claim_jobs(only_id=entry["id"])["jobs"], [])
        submitted = submit_result({
            "id": job["id"], "leaseToken": job["leaseToken"],
            "games": ["Hollow Knight", "  hollow   KNIGHT ", "Outer Wilds"],
        })
        self.assertEqual(submitted["gamesCount"], 2)
        repeated = submit_result({"id": job["id"], "leaseToken": job["leaseToken"], "games": []})
        self.assertTrue(repeated["idempotent"])
        self.assertEqual(claim_jobs(only_id=entry["id"])["jobs"], [])
        response = self.client.get(f'/api/saved-links/{entry["id"]}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["gamesCount"], 2)
        name_entry = response.json()["games"][0]["id"]
        self.assertIsNone(response.json()["games"][0]["igdbId"])
        self.assertEqual(self.client.put(
            f'/api/saved-links/{entry["id"]}/games/{name_entry}',
            json={"igdbId": self.igdb_id + 600_000_000},
        ).status_code, 404)
        match = self.client.put(
            f'/api/saved-links/{entry["id"]}/games/{name_entry}',
            json={"igdbId": self.igdb_id},
        )
        self.assertEqual(match.status_code, 200, match.text)
        self.assertEqual(match.json()["games"][0]["igdbId"], self.igdb_id)
        with SessionLocal() as session:
            self.assertEqual(len(session.scalars(select(SavedLinkGame)
                            .where(SavedLinkGame.saved_link_id == entry["id"])).all()), 2)

    def test_stale_claim_is_rejected_and_failed_job_can_retry(self):
        entry = self._save().json()
        first = claim_jobs(only_id=entry["id"])["jobs"][0]
        with SessionLocal() as session:
            link = session.get(SavedLink, entry["id"])
            link.lease_until = _now() - timedelta(minutes=1)
            session.commit()
        second = claim_jobs(only_id=entry["id"])["jobs"][0]
        self.assertNotEqual(first["leaseToken"], second["leaseToken"])
        with self.assertRaises(ValueError):
            submit_result({"id": first["id"], "leaseToken": first["leaseToken"], "games": ["Hades"]})
        failed = submit_result({"id": second["id"], "leaseToken": second["leaseToken"],
                                "error": "Страница закрыта"})
        self.assertEqual(failed["status"], "pending")
        third = claim_jobs(only_id=entry["id"])["jobs"][0]
        failed = submit_result({"id": third["id"], "leaseToken": third["leaseToken"],
                                "error": "Страница закрыта"})
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(claim_jobs(only_id=entry["id"])["jobs"], [])
        retry = self.client.post(f'/api/saved-links/{entry["id"]}/retry')
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json()["status"], "pending")
        self.assertEqual(retry.json()["attempts"], 0)

    def test_other_user_cannot_access_or_attach_to_link(self):
        entry = self._save().json()
        other = TestClient(app, base_url="https://testserver")
        suffix = secrets.token_hex(4)
        nick = "x" + suffix
        self.assertEqual(other.post("/api/auth/register", json={
            "email": nick + "@example.com", "nickname": nick, "pin": "12345678",
        }).status_code, 201)
        for method, url, params in (
            ("get", f'/api/saved-links/{entry["id"]}', {}),
            ("delete", f'/api/saved-links/{entry["id"]}', {}),
            ("post", f'/api/saved-links/{entry["id"]}/retry', {}),
            ("put", f'/api/saved-links/{entry["id"]}/games/1',
             {"json": {"igdbId": self.igdb_id}}),
        ):
            with self.subTest(method=method):
                self.assertEqual(getattr(other, method)(url, **params).status_code, 404)
        self.assertEqual(other.get("/api/saved-links").json()["items"], [])
        other.close()
