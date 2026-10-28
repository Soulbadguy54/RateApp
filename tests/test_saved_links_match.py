"""One-link matching, resumable progress, existing search rank and cleanup."""
import secrets
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select

from api.index import app
from api.database import SessionLocal
from api.models import Game, SavedLinkJob, User
from api.saved_links_worker import claim_jobs, submit_result, resolve_games, _find_top_game_id
from api.games_routes import _ranked_igdb_search_rows
from api.igdb_client import Priority


class SavedLinkMatchTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="https://testserver")
        self.nick = "m" + secrets.token_hex(4)
        response = self.client.post("/api/auth/register", json={
            "email": self.nick + "@example.com",
            "nickname": self.nick,
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
            user = session.scalar(select(User).where(User.nickname == self.nick))
            if user is not None:
                session.delete(user)
            game = session.scalar(select(Game).where(Game.igdb_id == self.igdb_id))
            if game is not None:
                session.delete(game)
            session.commit()

    def submit_link(self, names, suffix="one"):
        response = self.client.post("/api/saved-links", json={
            "url": f"https://example.org/games/{self.nick}/{suffix}",
        })
        self.assertEqual(response.status_code, 201, response.text)
        link = response.json()
        job = claim_jobs(only_id=link["id"])["jobs"][0]
        saved = submit_result({"id": job["id"], "leaseToken": job["leaseToken"],
                               "games": names})
        return link, saved

    def test_local_first_does_not_call_igdb(self):
        link, _ = self.submit_link(["Hollow Knight Test"])
        with patch("api.games_routes._ranked_igdb_search_rows",
                   side_effect=AssertionError("IGDB should not be called")):
            result = resolve_games(only_id=link["id"])
        self.assertEqual(result["matched"], 1)
        page = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(page["gameIds"], [self.local_id])
        self.assertEqual(page["games"][0]["igdbId"], self.igdb_id)

    def test_igdb_first_result_and_cache_only_one(self):
        link, _ = self.submit_link(["Never Cached Series 98"])
        with patch("api.games_routes._local_game_search",
                   return_value={"items":[]}), patch(
                "api.games_routes._ranked_igdb_search_rows",
                return_value=([{"id":self.igdb_id, "name":"Never Cached Series 98"},
                               {"id":11, "name":"Never Cached Series 98 Deluxe"}], False)
            ) as search, patch(
                "api.games_routes._cache_igdb_games",
                return_value=[{"id":self.igdb_id}]
            ) as cache:
            result = resolve_games(only_id=link["id"])
        self.assertTrue(result["complete"])
        self.assertEqual(result["matched"], 1)
        self.assertEqual(search.call_args.kwargs["priority"], Priority.BACKGROUND)
        self.assertEqual(len(cache.call_args.args[0]), 1)
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').json()
                         ["gameIds"], [self.local_id])

    def test_relevance_alias_then_popularity_shared_with_search(self):
        rows = [
            {"id":2, "name":"Outer Wilds Extra", "total_rating_count":99999},
            {"id":3, "name":"Different Name", "alternative_names":[{"name":"Outer Wilds"}],
             "total_rating_count":3},
            {"id":4, "name":"Outer Wilds", "total_rating_count":100},
        ]
        with patch("api.games_routes.igdb_client.request", return_value=rows):
            result, _ = _ranked_igdb_search_rows("Outer Wilds")
        self.assertEqual([r["id"] for r in result], [4,3,2])

    def test_long_article_stays_one_link_and_resumes_next_pass(self):
        titles = [f"Random Unmatched Title {idx}" for idx in range(14)]
        link, _ = self.submit_link(titles)
        with patch("api.saved_links_worker._find_top_game_id",
                   side_effect=lambda name: self.igdb_id if name == titles[0] else None):
            first = resolve_games(only_id=link["id"])
            self.assertEqual(first["links"], 1)
            self.assertEqual(first["processed"], 12)
            self.assertEqual(first["remaining"], 2)
            self.assertFalse(first["complete"])
            with SessionLocal() as session:
                job = session.scalar(select(SavedLinkJob).where(
                    SavedLinkJob.saved_link_id == link["id"]))
                self.assertEqual(job.cursor, 12)
                self.assertEqual(len(job.names), 14)
            second = resolve_games(only_id=link["id"])
        self.assertTrue(second["complete"])
        self.assertEqual(second["processed"], 2)
        result = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["gameIds"], [self.local_id])
        with SessionLocal() as session:
            self.assertIsNone(session.scalar(select(SavedLinkJob).where(
                SavedLinkJob.saved_link_id == link["id"])))

    def test_no_match_finishes_and_retry_is_bounded(self):
        link, _ = self.submit_link(["Random Unmatched Title"])
        with patch("api.saved_links_worker._find_top_game_id", return_value=None):
            self.assertTrue(resolve_games(only_id=link["id"])["complete"])
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').json()
                         ["gameIds"], [])
        other, _ = self.submit_link(["Temporary Provider Error"], suffix="error")
        with patch("api.saved_links_worker._find_top_game_id",
                   side_effect=HTTPException(status_code=429)):
            self.assertTrue(resolve_games(only_id=other["id"])["retry"])
            self.assertTrue(resolve_games(only_id=other["id"])["retry"])
            self.assertTrue(resolve_games(only_id=other["id"])["complete"])
        result = self.client.get(f'/api/saved-links/{other["id"]}').json()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["gameIds"], [])
        self.assertIsNotNone(result["error"])

    def test_delete_while_matching_does_not_recreate_queue(self):
        link, _ = self.submit_link(["Hollow Knight Test"])
        def delete_in_flight(name):
            response = self.client.delete(f'/api/saved-links/{link["id"]}')
            self.assertEqual(response.status_code, 204)
            return self.igdb_id
        with patch("api.saved_links_worker._find_top_game_id",
                   side_effect=delete_in_flight):
            result = resolve_games(only_id=link["id"])
        self.assertTrue(result["cancelled"])
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').status_code, 404)
        with SessionLocal() as session:
            self.assertIsNone(session.scalar(select(SavedLinkJob).where(
                SavedLinkJob.saved_link_id == link["id"])))
