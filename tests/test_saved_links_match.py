"""Automatic saved-link catalog matching; isolated CI PostgreSQL with fake IGDB."""
import secrets
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from api.index import app
from api.database import SessionLocal
from api.models import Game
from api.saved_links_worker import claim_jobs, submit_result, resolve_games
from api.games_routes import _ranked_igdb_search_rows
from api.igdb_client import Priority


class SavedLinkMatchTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="https://testserver")
        nick = "m" + secrets.token_hex(4)
        response = self.client.post("/api/auth/register", json={
            "email": nick + "@example.com", "nickname": nick, "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.nick = nick
        self.igdb_id = secrets.randbelow(600_000_000) + 300_000_000
        with SessionLocal() as session:
            session.add(Game(igdb_id=self.igdb_id, title="Hollow Knight Test"))
            session.commit()

    def tearDown(self):
        self.client.close()

    def submit_link(self, game_name, suffix="one"):
        result = self.client.post("/api/saved-links", json={
            "url": f"https://example.org/{self.nick}/{suffix}",
        })
        self.assertEqual(result.status_code, 201, result.text)
        link = result.json()
        job = claim_jobs(only_id=link["id"])["jobs"][0]
        submit_result({"id": job["id"], "leaseToken": job["leaseToken"],
                       "games": [game_name]})
        return self.client.get(f'/api/saved-links/{link["id"]}').json()

    def test_local_wins_without_network_and_does_not_rerun(self):
        link = self.submit_link("Hollow Knight Test")
        entry = link["games"][0]
        with patch("api.games_routes._ranked_igdb_search_rows",
                   side_effect=AssertionError("IGDB should not be used")):
            result = resolve_games(only_id=entry["id"])
        self.assertEqual(result["matched"], 1)
        matched = self.client.get(f'/api/saved-links/{link["id"]}').json()["games"][0]
        self.assertEqual(matched["igdbId"], self.igdb_id)
        self.assertEqual(matched["matchStatus"], "matched")
        self.assertEqual(resolve_games(only_id=entry["id"])["claimed"], 0)

    def test_igdb_first_ranked_and_cache_only_top(self):
        link = self.submit_link("Never Cached Series 98")
        entry = link["games"][0]
        with patch("api.games_routes._local_game_search", return_value={"items":[]}), patch(
                "api.games_routes._ranked_igdb_search_rows",
                return_value=([{"id":self.igdb_id, "name":"Never Cached Series 98"},
                               {"id":11, "name":"Never Cached Series Bonus"}], False)
            ) as search, patch("api.games_routes._cache_igdb_games",
                               return_value=[{"id":self.igdb_id}]) as cache:
            result = resolve_games(only_id=entry["id"])
        self.assertEqual(result["matched"], 1)
        self.assertEqual(search.call_args.kwargs["priority"], Priority.BACKGROUND)
        self.assertEqual(len(cache.call_args.args[0]), 1)
        matched = self.client.get(f'/api/saved-links/{link["id"]}').json()["games"][0]
        self.assertEqual(matched["igdbId"], self.igdb_id)

    def test_igdb_rank_exact_over_popularity_and_uses_alias(self):
        rows = [
            {"id":2, "name":"Outer Wilds Extra", "total_rating_count":99999},
            {"id":3, "name":"Different Name", "alternative_names":[{"name":"Outer Wilds"}],
             "total_rating_count":3},
            {"id":4, "name":"Outer Wilds", "total_rating_count":100},
        ]
        with patch("api.games_routes.igdb_client.request", return_value=rows):
            result, _ = _ranked_igdb_search_rows("Outer Wilds")
        self.assertEqual([r["id"] for r in result], [4,3,2])

    def test_no_match_terminal_and_network_error_retried_at_most_three_times(self):
        link = self.submit_link("Unavailable Unique Title")
        entry = link["games"][0]
        with patch("api.saved_links_worker._find_top_game_id", return_value=None):
            self.assertEqual(resolve_games(only_id=entry["id"])["noMatch"], 1)
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').json()
                         ["games"][0]["matchStatus"], "no_match")
        self.assertEqual(resolve_games(only_id=entry["id"])["claimed"], 0)

        other = self.submit_link("Temporary Error Title", "error")
        entry2 = other["games"][0]
        with patch("api.saved_links_worker._find_top_game_id",
                   side_effect=HTTPException(status_code=429)):
            self.assertEqual(resolve_games(only_id=entry2["id"])["retry"], 1)
            self.assertEqual(resolve_games(only_id=entry2["id"])["retry"], 1)
            self.assertEqual(resolve_games(only_id=entry2["id"])["failed"], 1)
        self.assertEqual(resolve_games(only_id=entry2["id"])["claimed"], 0)

    def test_manual_link_has_precedence(self):
        link = self.submit_link("Hollow Knight Test")
        entry = link["games"][0]
        response = self.client.put(
            f'/api/saved-links/{link["id"]}/games/{entry["id"]}',
            json={"igdbId":self.igdb_id},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["games"][0]["matchStatus"], "matched")
        self.assertEqual(resolve_games(only_id=entry["id"])["claimed"], 0)
