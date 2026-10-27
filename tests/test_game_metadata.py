"""IGDB metadata is saved at ingestion and read locally without per-card calls."""
import json
import secrets
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import select

from api import index
from api.database import SessionLocal
from api.games_routes import IGDB_GAME_FIELDS, _igdb_search_body
from api.models import Game


class GameMetadataCacheTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(index.app, base_url="https://testserver")
        suffix = secrets.token_hex(3)
        response = self.client.post("/api/auth/register", json={
            "email": f"metadata_{suffix}@example.com",
            "nickname": f"metadata_{suffix}",
            "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.game_id = secrets.randbelow(200_000_000) + 600_000_000

    def tearDown(self):
        self.client.close()

    def _cache_igdb_result(self):
        return index._cache_igdb_games([{
            "id": self.game_id,
            "name": "Starfall Horizon",
            "summary": "A journey across the stars.",
            "storyline": "The colony must survive.",
            "category": 0,
            "themes": [{"id": 17, "name": "Sci-Fi"}],
            "keywords": [8, 15, 26],
            "screenshots": [{"id": 77, "image_id": "sce8"}],
            "cover": {"image_id": "co123"},
            "websites": [
                {"url": "https://store.steampowered.com/app/1234"},
                {"url": "https://www.epicgames.com/store/en-US/p/starfall"},
                {"url": "https://not-steam.example/unsafe"},
            ],
            "videos": [{"name": "Trailer", "video_id": "abcdefghijk"}],
        }])

    def test_complete_snapshot_description_stores_immediately_and_offline(self):
        items = self._cache_igdb_result()
        self.assertEqual(items[0]["summary"], "A journey across the stars.")
        self.assertEqual(items[0]["storyline"], "The colony must survive.")
        self.assertEqual([s["provider"] for s in items[0]["storeLinks"]], ["steam", "epic"])
        self.assertEqual(items[0]["trailerUrl"], "https://www.youtube.com/watch?v=abcdefghijk")
        with SessionLocal() as session:
            game = session.scalar(select(Game).where(Game.igdb_id == self.game_id))
            self.assertEqual(game.igdb_payload["keywords"], [8, 15, 26])
            self.assertEqual(game.igdb_payload["themes"][0]["name"], "Sci-Fi")
            self.assertEqual(game.igdb_payload["screenshots"][0]["image_id"], "sce8")
            details = json.loads(game.details_json)
            self.assertEqual(details["summary"], "A journey across the stars.")
            self.assertNotIn("_linksOnly", details)
            self.assertIsNotNone(game.details_cached_at)

        with patch("api.igdb_client.igdb_client.request",
                   side_effect=AssertionError("Details must be fetched only from PostgreSQL")):
            response = self.client.get(f"/api/games/{self.game_id}/details")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["summary"], "A journey across the stars.")
        self.assertEqual(response.json()["storeLinks"][0]["provider"], "steam")

    def test_bootstrap_embeds_existing_cached_store_links(self):
        self._cache_igdb_result()
        self.assertEqual(self.client.put(f"/api/library/{self.game_id}/wishlist").status_code, 200)
        bootstrap = self.client.get("/api/bootstrap")
        self.assertEqual(bootstrap.status_code, 200, bootstrap.text)
        game = next(item["game"] for item in bootstrap.json()["library"] if item["gameId"] == self.game_id)
        self.assertEqual(game["storeLinks"][0]["provider"], "steam")
        self.assertEqual(game["summary"], "A journey across the stars.")
        self.assertIn("youtube.com", game["trailerUrl"])

    def test_existing_cache_preserved_on_partial_refresh(self):
        self._cache_igdb_result()
        with SessionLocal() as session:
            game = session.scalar(select(Game).where(Game.igdb_id == self.game_id))
            existing = json.loads(game.details_json)
            existing["storyHours"] = 18
            game.details_json = json.dumps(existing)
            session.commit()

        result = index._cache_igdb_games([{"id": self.game_id, "name": "Starfall Horizon"}])
        self.assertEqual(result[0]["summary"], "A journey across the stars.")
        with SessionLocal() as session:
            game = session.scalar(select(Game).where(Game.igdb_id == self.game_id))
            self.assertEqual(game.igdb_payload["keywords"], [8, 15, 26])
            self.assertEqual(json.loads(game.details_json)["storyHours"], 18)

    def test_new_igdb_prose_invalidates_outdated_russian_translation(self):
        self._cache_igdb_result()
        with SessionLocal() as session:
            game = session.scalar(select(Game).where(Game.igdb_id == self.game_id))
            details = json.loads(game.details_json)
            details["summary_en"] = details["summary"]
            details["summary_ru"] = "Путешествие среди звёзд."
            details["summary_ru_source"] = details["summary_en"]
            game.details_json = json.dumps(details, ensure_ascii=False)
            session.commit()
        same = index._cache_igdb_games([{
            "id": self.game_id, "name": "Starfall Horizon",
            "summary": "A journey across the stars.",
        }])
        self.assertEqual(same[0]["summary"], "Путешествие среди звёзд.")
        changed = index._cache_igdb_games([{
            "id": self.game_id, "name": "Starfall Horizon",
            "summary": "A completely new journey.",
        }])
        self.assertEqual(changed[0]["summary"], "A completely new journey.")
        self.assertEqual(changed[0]["summaryRu"], "")
        with SessionLocal() as session:
            game = session.scalar(select(Game).where(Game.igdb_id == self.game_id))
            self.assertNotIn("summary_ru", json.loads(game.details_json))

    def test_igdb_search_requests_all_game_fields(self):
        self.assertTrue(IGDB_GAME_FIELDS.startswith("*,"))
        query = _igdb_search_body("Starfall", 0)
        self.assertIn("fields *,", query)
        self.assertIn("cover.image_id", query)
        self.assertIn("websites.url", query)
        self.assertIn("videos.video_id", query)

    def test_legacy_game_details_return_cached_subset_without_fetch(self):
        with SessionLocal() as session:
            session.add(Game(
                igdb_id=self.game_id, title="Old Legacy Game",
                details_json='{"storeLinks":[],"_linksOnly":true}',
            ))
            session.commit()
        with patch("api.igdb_client.igdb_client.request",
                   side_effect=AssertionError("Legacy details must never call IGDB")):
            result = self.client.get(f"/api/games/{self.game_id}/details")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["storeLinks"], [])


if __name__ == "__main__":
    unittest.main()
