"""Discovery feed, swipe feedback, wishlist and undo against isolated CI PostgreSQL."""
import json
import secrets
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import select

from api.index import app
from api.database import SessionLocal
from api.models import Collection, CollectionGame, DiscoveryFeedback, Game, UserGame


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="https://testserver")
        token = secrets.token_hex(4)
        self.nickname = "d" + token
        response = self.client.post("/api/auth/register", json={
            "email": f"{self.nickname}@example.com",
            "nickname": self.nickname,
            "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.igdb_id = secrets.randbelow(600_000_000) + 300_000_000
        with SessionLocal() as session:
            session.add(Game(
                igdb_id=self.igdb_id,
                title="Discovery Test Game",
                cover_url="https://images.igdb.com/igdb/image/upload/t_cover_big_2x/test.jpg",
                igdb_rating=88,
                popularity_count=99999,
                details_json='{"summary": "A great story about stars."}',
                genres_json='["Action", "RPG"]',
                platforms_json='["PC"]',
            ))
            session.commit()

    def tearDown(self):
        self.client.close()

    def test_feed_only_authenticated_and_local(self):
        self.assertEqual(TestClient(app).get("/api/discover/feed").status_code, 401)
        response = self.client.get("/api/discover/feed")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn(self.igdb_id, [item["id"] for item in response.json()["items"]])

    def test_like_filters_feed_then_undo_restores(self):
        response = self.client.post("/api/discover/feedback", json={
            "gameId": self.igdb_id, "action": "like",
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn(self.igdb_id, [item["id"] for item in self.client.get("/api/discover/feed").json()["items"]])
        self.assertEqual(self.client.delete(f"/api/discover/feedback/{self.igdb_id}").status_code, 200)
        self.assertIn(self.igdb_id, [item["id"] for item in self.client.get("/api/discover/feed").json()["items"]])

    def test_wishlist_and_undo_do_not_change_ratings(self):
        response = self.client.post("/api/discover/feedback", json={
            "gameId": self.igdb_id, "action": "wishlist",
        })
        self.assertEqual(response.status_code, 200, response.text)
        with SessionLocal() as session:
            row = session.scalar(select(UserGame).join(Game, Game.id == UserGame.game_id)
                                 .where(Game.igdb_id == self.igdb_id))
            self.assertIsNotNone(row)
            self.assertEqual(row.status, "untracked")
            self.assertIsNone(row.score)
            membership = session.scalar(select(CollectionGame).where(CollectionGame.user_game_id == row.id))
            self.assertIsNotNone(membership)

        self.assertEqual(self.client.delete(f"/api/discover/feedback/{self.igdb_id}").status_code, 200)
        with SessionLocal() as session:
            self.assertIsNone(session.scalar(select(UserGame).join(Game, Game.id == UserGame.game_id)
                                  .where(Game.igdb_id == self.igdb_id)))

    def test_invalid_vote_and_repeat_are_safe(self):
        self.assertEqual(self.client.post("/api/discover/feedback", json={
            "gameId": self.igdb_id, "action": "wat",
        }).status_code, 422)
        for _ in range(2):
            self.assertEqual(self.client.post("/api/discover/feedback", json={
                "gameId": self.igdb_id, "action": "dislike",
            }).status_code, 200)
        self.assertEqual(self.client.post("/api/discover/feedback", json={
            "gameId": self.igdb_id, "action": "like",
        }).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/discover/feedback/{self.igdb_id}").status_code, 200)
        self.assertEqual(self.client.delete(f"/api/discover/feedback/{self.igdb_id}").status_code, 404)

    def test_description_localization_authorization_cache_and_fallback(self):
        route = f"/api/discover/description/{self.igdb_id}"
        self.assertEqual(TestClient(app).get(route).status_code, 401)
        self.assertEqual(self.client.get(route + "?lang=es").status_code, 422)
        self.assertEqual(self.client.get(route + "?lang=en").json()["description"], "A great story about stars.")
        self.assertEqual(self.client.get("/api/discover/description/2147483647").status_code, 404)
        with patch("api.discovery_routes._translate_english_to_russian",
                   return_value="Отличная история о звёздах.") as translator:
            first = self.client.get(route)
            second = self.client.get(route)
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json(), second.json())
            self.assertEqual(first.json()["language"], "ru")
            self.assertIn("история", first.json()["description"])
            translator.assert_called_once()
        with SessionLocal() as session:
            game = session.scalar(select(Game).where(Game.igdb_id == self.igdb_id))
            saved = json.loads(game.details_json)
            self.assertEqual(saved["summary_en"], "A great story about stars.")
            self.assertEqual(saved["summary_ru"], "Отличная история о звёздах.")
            self.assertEqual(saved["summary_ru_source"], saved["summary_en"])
        # Prove it survives a fresh request, without translating again.
        with patch("api.discovery_routes._translate_english_to_russian",
                   side_effect=AssertionError("Translation must be persisted")):
            self.assertEqual(self.client.get(route).json()["language"], "ru")
            self.assertEqual(self.client.get(route + "?lang=en").json()["description"],
                             "A great story about stars.")
            detail = self.client.get(f"/api/games/{self.igdb_id}/details").json()
            self.assertEqual(detail["summary"], "Отличная история о звёздах.")
            self.assertEqual(detail["summaryEn"], "A great story about stars.")
            self.assertEqual(detail["summaryRu"], "Отличная история о звёздах.")
        with patch("api.discovery_routes._translate_english_to_russian", return_value=None):
            with SessionLocal() as session:
                game = session.scalar(select(Game).where(Game.igdb_id == self.igdb_id))
                game.details_json = '{"summary":"An untranslated second summary."}'
                session.commit()
            failed = self.client.get(route)
            self.assertEqual(failed.json()["language"], "en")
            self.assertFalse(failed.json()["translated"])

    def test_translation_chunks_have_bounded_utf8_size(self):
        from api.discovery_routes import _text_chunks
        long_text = ("An elaborate description. " * 40).strip()
        chunks = _text_chunks(long_text)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk.encode("utf-8")) <= 450 for chunk in chunks))
