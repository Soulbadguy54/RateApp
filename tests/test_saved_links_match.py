"""One-table saved links: local/IGDB ranking, long-article cursor and races."""
import secrets
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select

from api.database import SessionLocal
from api.index import app
from api.models import Game, SavedLink, User
from api.saved_links_worker import claim_jobs, submit_result, resolve_games
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
        self.igdb_id = 300000000 + secrets.randbelow(300000000)
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
        saved = submit_result({"id": link["id"], "leaseToken": job["leaseToken"],
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
        self.assertEqual(page["gptNames"], ["Hollow Knight Test"])

    def test_igdb_first_result_caches_only_one(self):
        link, _ = self.submit_link(["Never Cached Series 98"])
        with patch("api.games_routes._local_game_search",
                   return_value={"items":[]}), patch(
                "api.games_routes._ranked_igdb_search_rows",
                return_value=([{"id":self.igdb_id, "name":"Never Cached Series 98"},
                               {"id":11, "name":"Never Cached Series Deluxe"}], False)
            ) as search, patch("api.games_routes._cache_igdb_games",
                               return_value=[{"id":self.igdb_id}]) as cache:
            result = resolve_games(only_id=link["id"])
        self.assertTrue(result["complete"])
        self.assertEqual(result["matched"], 1)
        self.assertEqual(search.call_args.kwargs["priority"], Priority.BACKGROUND)
        self.assertEqual(len(cache.call_args.args[0]), 1)
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').json()
                         ["gameIds"], [self.local_id])

    def test_search_ranking_identical_to_catalog(self):
        rows = [
            {"id":2, "name":"Outer Wilds Extra", "total_rating_count":99999},
            {"id":3, "name":"Different Name",
             "alternative_names":[{"name":"Outer Wilds"}], "total_rating_count":3},
            {"id":4, "name":"Outer Wilds", "total_rating_count":100},
        ]
        with patch("api.games_routes.igdb_client.request", return_value=rows):
            ranked, _ = _ranked_igdb_search_rows("Outer Wilds")
        self.assertEqual([r["id"] for r in ranked], [4,3,2])

    def test_long_article_resumes_and_names_stay_in_same_row(self):
        titles = [f"Random Unmatched Title {i}" for i in range(14)]
        link, _ = self.submit_link(titles)
        with patch("api.saved_links_worker._find_top_game_id",
                   side_effect=lambda name: self.igdb_id if name == titles[0] else None):
            first = resolve_games(only_id=link["id"])
            self.assertEqual(first["processed"], 12)
            self.assertEqual(first["remaining"], 2)
            self.assertFalse(first["complete"])
            with SessionLocal() as session:
                source = session.get(SavedLink, link["id"])
                self.assertEqual(source.match_cursor, 12)
                self.assertEqual(source.game_ids, [self.local_id])
                self.assertEqual(len(source.gpt_names), 14)
            second = resolve_games(only_id=link["id"])
        self.assertTrue(second["complete"])
        self.assertEqual(second["processed"], 2)
        final = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(final["status"], "ready")
        self.assertEqual(final["gameIds"], [self.local_id])
        self.assertEqual(final["gptNames"], titles)

    def test_network_errors_are_retried_only_three_times(self):
        link, _ = self.submit_link(["Temporary Provider Error"])
        with patch("api.saved_links_worker._find_top_game_id",
                   side_effect=HTTPException(status_code=429)):
            self.assertTrue(resolve_games(only_id=link["id"])["retry"])
            self.assertTrue(resolve_games(only_id=link["id"])["retry"])
            self.assertTrue(resolve_games(only_id=link["id"])["complete"])
        page = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(page["status"], "ready")
        self.assertEqual(page["gameIds"], [])
        self.assertEqual(page["gptNames"], ["Temporary Provider Error"])
        self.assertIsNotNone(page["error"])

    def test_delete_during_igdb_lookup_cannot_restore_link(self):
        link, _ = self.submit_link(["Hollow Knight Test"])
        def delete_in_flight(name):
            self.assertEqual(self.client.delete(f'/api/saved-links/{link["id"]}').status_code, 204)
            return self.igdb_id
        with patch("api.saved_links_worker._find_top_game_id",
                   side_effect=delete_in_flight):
            result = resolve_games(only_id=link["id"])
        self.assertTrue(result["cancelled"])
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').status_code, 404)

    def test_refresh_during_igdb_lookup_disallows_old_result(self):
        link, _ = self.submit_link(["Hollow Knight Test"])
        def refresh_in_flight(name):
            self.assertEqual(self.client.post(f'/api/saved-links/{link["id"]}/refresh').status_code, 200)
            return self.igdb_id
        with patch("api.saved_links_worker._find_top_game_id",
                   side_effect=refresh_in_flight):
            outcome = resolve_games(only_id=link["id"])
        self.assertTrue(outcome["cancelled"])
        changed = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertIsNone(changed["gptNames"])
        self.assertEqual(changed["gameIds"], [])
