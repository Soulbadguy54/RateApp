"""Saved link durable arrays, disposable jobs, deletion and auth checks."""
import secrets
import unittest
from datetime import timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import select

from api.index import app
from api.database import SessionLocal
from api.models import Game, SavedLink, SavedLinkJob, User
from api.saved_links_routes import canonical_url
from api.saved_links_worker import claim_jobs, submit_result, resolve_games
from api.security import _now


class SavedLinkTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="https://testserver")
        self.nickname = "l" + secrets.token_hex(4)
        response = self.client.post("/api/auth/register", json={
            "email": self.nickname + "@example.com",
            "nickname": self.nickname,
            "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.igdb_id = secrets.randbelow(500_000_000) + 300_000_000
        with SessionLocal() as session:
            game = Game(igdb_id=self.igdb_id, title="Hollow Knight Test")
            session.add(game)
            session.commit()
            self.local_id = game.id

    def tearDown(self):
        self.client.close()
        with SessionLocal() as session:
            user = session.scalar(select(User).where(User.nickname == self.nickname))
            if user is not None:
                session.delete(user)
            game = session.scalar(select(Game).where(Game.igdb_id == self.igdb_id))
            if game is not None:
                session.delete(game)
            session.commit()

    def _save(self, url=None):
        return self.client.post("/api/saved-links", json={
            "url": url or f"https://example.org/games/{self.nickname}",
            "title": "  Игровая подборка  ",
        })

    def test_validate_and_deduplicate_link(self):
        for url in ("file:///etc/passwd", "http://127.0.0.1/",
                    "http://192.168.1.1/", "https://localhost/",
                    "https://user:pw@example.org/", "https://foo.test/"):
            with self.subTest(url=url):
                self.assertEqual(self.client.post("/api/saved-links", json={"url": url}).status_code, 422)
        self.assertEqual(canonical_url("HTTPS://EXAMPLE.ORG/Page#fragment"),
                         "https://example.org/Page")
        self.assertEqual(TestClient(app).get("/api/saved-links").status_code, 401)
        first = self._save().json()
        self.assertEqual(first["status"], "pending")
        self.assertEqual(first["gameIds"], [])
        self.assertEqual(first["title"], "Игровая подборка")
        self.assertEqual(first["id"], self._save().json()["id"])
        with SessionLocal() as session:
            self.assertEqual(len(session.scalars(select(SavedLinkJob).where(
                SavedLinkJob.saved_link_id == first["id"])).all()), 1)

    def test_one_source_all_titles_names_temporary_and_results_persist(self):
        link = self._save().json()
        job = claim_jobs(only_id=link["id"])["jobs"][0]
        self.assertEqual(claim_jobs(only_id=link["id"])["jobs"], [])
        with self.assertRaises(ValueError):
            claim_jobs(limit=2)
        payload = {"id": link["id"], "leaseToken": job["leaseToken"],
                   "games": ["Hollow Knight Test", "  hollow   KNIGHT Test ",
                             "Outer Wilds"]}
        saved = submit_result(payload)
        self.assertEqual(saved["gamesCount"], 2)
        self.assertEqual(saved["status"], "processing")
        self.assertTrue(submit_result(payload)["idempotent"])
        with SessionLocal() as session:
            queue = session.scalar(select(SavedLinkJob).where(
                SavedLinkJob.saved_link_id == link["id"]))
            self.assertEqual(queue.names, ["Hollow Knight Test", "Outer Wilds"])
            self.assertEqual(session.get(SavedLink, link["id"]).game_ids, [])
        with patch("api.saved_links_worker._find_top_game_id",
                   side_effect=lambda name: self.igdb_id if name == "Hollow Knight Test" else None):
            outcome = resolve_games(only_id=link["id"])
        self.assertTrue(outcome["complete"])
        self.assertEqual(outcome["processed"], 2)
        final = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(final["status"], "ready")
        self.assertEqual(final["gameIds"], [self.local_id])
        self.assertEqual(final["games"][0]["igdbId"], self.igdb_id)
        with SessionLocal() as session:
            self.assertIsNone(session.scalar(select(SavedLinkJob).where(
                SavedLinkJob.saved_link_id == link["id"])))
        self.assertEqual(claim_jobs(only_id=link["id"])["jobs"], [])

    def test_delete_active_link_cascades_job_and_rejects_late_submit(self):
        link = self._save().json()
        job = claim_jobs(only_id=link["id"])["jobs"][0]
        self.assertEqual(self.client.delete(f'/api/saved-links/{link["id"]}').status_code, 204)
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').status_code, 404)
        with self.assertRaises(ValueError):
            submit_result({"id": link["id"], "leaseToken": job["leaseToken"],
                           "games": ["Hades"]})
        with SessionLocal() as session:
            self.assertIsNone(session.scalar(select(SavedLinkJob).where(
                SavedLinkJob.saved_link_id == link["id"])))
        self.assertEqual(claim_jobs(only_id=link["id"])["jobs"], [])

    def test_expired_claim_retry_and_terminal_cleanup(self):
        link = self._save().json()
        first = claim_jobs(only_id=link["id"])["jobs"][0]
        with SessionLocal() as session:
            job = session.scalar(select(SavedLinkJob).where(
                SavedLinkJob.saved_link_id == link["id"]))
            job.lease_until = _now() - timedelta(minutes=1)
            session.commit()
        second = claim_jobs(only_id=link["id"])["jobs"][0]
        self.assertNotEqual(first["leaseToken"], second["leaseToken"])
        with self.assertRaises(ValueError):
            submit_result({"id": first["id"], "leaseToken": first["leaseToken"],
                           "games": ["Hades"]})
        self.assertEqual(submit_result({
            "id": second["id"], "leaseToken": second["leaseToken"],
            "error": "Недоступна статья",
        })["status"], "pending")
        third = claim_jobs(only_id=link["id"])["jobs"][0]
        self.assertEqual(submit_result({
            "id": third["id"], "leaseToken": third["leaseToken"],
            "error": "Недоступна статья",
        })["status"], "failed")
        with SessionLocal() as session:
            self.assertIsNone(session.scalar(select(SavedLinkJob).where(
                SavedLinkJob.saved_link_id == link["id"])))
        self.assertEqual(self.client.post(f'/api/saved-links/{link["id"]}/retry').json()["status"], "pending")
        self.assertEqual(claim_jobs(only_id=link["id"])["jobs"][0]["attempt"], 1)

    def test_catalog_deletion_trigger_cleans_game_array(self):
        link = self._save().json()
        claim = claim_jobs(only_id=link["id"])["jobs"][0]
        submit_result({"id": link["id"], "leaseToken": claim["leaseToken"],
                       "games": ["Hollow Knight Test"]})
        with patch("api.saved_links_worker._find_top_game_id", return_value=self.igdb_id):
            self.assertTrue(resolve_games(only_id=link["id"])["complete"])
        with SessionLocal() as session:
            self.assertEqual(session.get(SavedLink, link["id"]).game_ids, [self.local_id])
            session.delete(session.get(Game, self.local_id))
            session.commit()
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').json()["gameIds"], [])

    def test_other_user_cannot_get_or_delete_link(self):
        link = self._save().json()
        other = TestClient(app, base_url="https://testserver")
        nick = "x" + secrets.token_hex(4)
        response = other.post("/api/auth/register", json={
            "email": nick + "@example.com", "nickname": nick, "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(other.get(f'/api/saved-links/{link["id"]}').status_code, 404)
        self.assertEqual(other.delete(f'/api/saved-links/{link["id"]}').status_code, 404)
        self.assertEqual(other.get("/api/saved-links").json()["items"], [])
        other.close()
        with SessionLocal() as session:
            user = session.scalar(select(User).where(User.nickname == nick))
            if user is not None:
                session.delete(user)
                session.commit()
