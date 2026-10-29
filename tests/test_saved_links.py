"""One-table saved-link API, queue and delete-trigger regression tests."""
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


class SavedLinksTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="https://testserver")
        self.nickname = "l" + secrets.token_hex(4)
        response = self.client.post("/api/auth/register", json={
            "email": self.nickname + "@example.com",
            "nickname": self.nickname, "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.igdb_id = 300000000 + secrets.randbelow(300000000)
        with SessionLocal() as session:
            game = Game(igdb_id=self.igdb_id, title="Hollow Knight Test")
            session.add(game)
            session.commit()
            self.game_pk = game.id

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

    def save(self, suffix="one"):
        r = self.client.post("/api/saved-links", json={
            "url": f"https://example.org/games/{self.nickname}/{suffix}",
        })
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def send(self, link_id, names):
        claim = claim_jobs(only_id=link_id)["jobs"][0]
        return submit_result({
            "id": link_id, "leaseToken": claim["leaseToken"], "games": names,
        })

    def test_duplicate_url_and_no_names_yet(self):
        link = self.save()
        self.assertIsNone(link["gameNames"])
        self.assertEqual(link["gameIds"], [])
        duplicate = self.client.post("/api/saved-links", json={
            "url": f"https://example.org/games/{self.nickname}/one#fragment",
        })
        self.assertEqual(duplicate.json()["id"], link["id"])
        self.assertEqual(canonical_url("HTTPS://EXAMPLE.ORG/Page#fragment"),
                         "https://example.org/Page")
        with self.assertRaises(ValueError):
            claim_jobs(limit=2)
        self.assertEqual(TestClient(app).get("/api/saved-links").status_code, 401)

    def test_names_are_durable_and_one_url_gets_all_games(self):
        link = self.save()
        answer = self.send(link["id"], ["Hollow Knight Test", " Outer Wilds ",
                                        "hollow knight test"])
        self.assertEqual(answer["gamesCount"], 2)
        stored = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(stored["gameNames"], ["Hollow Knight Test", "Outer Wilds"])
        with patch("api.saved_links_worker._find_top_game_id",
                   side_effect=lambda name: self.igdb_id if name == "Hollow Knight Test" else None):
            result = resolve_games(only_id=link["id"])
        self.assertTrue(result["complete"])
        final = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(final["status"], "ready")
        self.assertEqual(final["gameNames"], ["Hollow Knight Test", "Outer Wilds"])
        self.assertEqual(final["gameIds"], [self.game_pk])
        self.assertEqual(final["games"][0]["igdbId"], self.igdb_id)
        self.assertEqual(claim_jobs(only_id=link["id"])["jobs"], [])

    def test_empty_processed_is_not_unprocessed(self):
        link = self.save()
        self.send(link["id"], [])
        item = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(item["gameNames"], [])
        self.assertEqual(item["status"], "ready")
        self.assertEqual(claim_jobs(only_id=link["id"])["jobs"], [])

    def test_refresh_reanalyses_changed_article_and_invalidates_old_claim(self):
        link = self.save()
        old = claim_jobs(only_id=link["id"])["jobs"][0]
        response = self.client.post(f'/api/saved-links/{link["id"]}/refresh')
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["gameNames"])
        with self.assertRaises(ValueError):
            submit_result({"id": link["id"], "leaseToken": old["leaseToken"],
                           "games": ["Old game"]})
        self.send(link["id"], ["New Game From Edited Article"])
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').json()
                         ["gameNames"], ["New Game From Edited Article"])

    def test_delete_cancels_claim_and_removes_names_ids(self):
        link = self.save()
        self.send(link["id"], ["Hades"])
        self.assertEqual(self.client.delete(f'/api/saved-links/{link["id"]}').status_code, 204)
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').status_code, 404)
        self.assertEqual(claim_jobs(only_id=link["id"])["jobs"], [])
        with SessionLocal() as session:
            self.assertIsNone(session.get(SavedLink, link["id"]))

    def test_claims_oldest_first_and_expired_token_protection(self):
        first = self.save("first")
        second = self.save("second")
        claim1 = claim_jobs()["jobs"][0]
        self.assertEqual(claim1["id"], first["id"])
        claim2 = claim_jobs()["jobs"][0]
        self.assertEqual(claim2["id"], second["id"])
        with SessionLocal() as session:
            row = session.get(SavedLink, first["id"])
            row.lease_until = _now() - timedelta(minutes=1)
            session.commit()
        new_claim = claim_jobs(only_id=first["id"])["jobs"][0]
        with self.assertRaises(ValueError):
            submit_result({"id": first["id"], "leaseToken": claim1["leaseToken"],
                           "games": ["Hades"]})
        self.assertNotEqual(new_claim["leaseToken"], claim1["leaseToken"])

    def test_deleted_catalog_game_is_pruned_from_array(self):
        link = self.save()
        self.send(link["id"], ["Hollow Knight Test"])
        with patch("api.saved_links_worker._find_top_game_id", return_value=self.igdb_id):
            self.assertTrue(resolve_games(only_id=link["id"])["complete"])
        with SessionLocal() as session:
            session.delete(session.get(Game, self.game_pk))
            session.commit()
        item = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(item["gameIds"], [])
        self.assertEqual(item["gameNames"], ["Hollow Knight Test"])

    def test_other_user_cannot_read_refresh_or_delete(self):
        item = self.save()
        other = TestClient(app, base_url="https://testserver")
        nick = "x" + secrets.token_hex(4)
        self.assertEqual(other.post("/api/auth/register", json={
            "email": nick + "@example.com", "nickname": nick, "pin": "12345678",
        }).status_code, 201)
        for method, url in (
            ("get", f'/api/saved-links/{item["id"]}'),
            ("delete", f'/api/saved-links/{item["id"]}'),
            ("post", f'/api/saved-links/{item["id"]}/refresh'),
        ):
            self.assertEqual(getattr(other, method)(url).status_code, 404)
        other.close()
        with SessionLocal() as session:
            other_user = session.scalar(select(User).where(User.nickname == nick))
            if other_user is not None:
                session.delete(other_user)
                session.commit()
