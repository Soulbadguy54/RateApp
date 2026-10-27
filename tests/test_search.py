"""PostgreSQL fuzzy search, IGDB alternative names, and future releases."""
import secrets
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import select

from api import index
from api.database import SessionLocal
from api.models import Game, GameAlias, Genre, GameGenre


class SearchApiTests(unittest.TestCase):
    def setUp(self):
        suffix = secrets.token_hex(4)
        self.client = TestClient(index.app, base_url="https://testserver")
        response = self.client.post("/api/auth/register", json={
            "email": f"search_{suffix}@example.com",
            "nickname": f"search_{suffix}",
            "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.game_id = secrets.randbelow(400_000_000) + 100_000_000

    def tearDown(self):
        self.client.close()

    def search(self, query, source="local"):
        response = self.client.get("/api/games/search", params={"q": query, "source": source})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["items"]

    def insert_game(self, title, *, alt=None, popularity=0, hype=0, offset=0):
        with SessionLocal() as session:
            game = Game(
                igdb_id=self.game_id + offset, title=title,
                popularity_count=popularity, hype_count=hype,
            )
            session.add(game)
            session.flush()
            for name in alt or []:
                session.add(GameAlias(game_id=game.id, name=name))
            session.commit()

    def test_fuzzy_typo_matching_happens_in_postgresql(self):
        self.insert_game("The Witcher IV")
        self.assertIn(self.game_id, [item["id"] for item in self.search("The Witcer IV")])

    def test_witcher_number_is_not_hardcoded(self):
        self.insert_game("The Witcher IV", alt=["Witcher 4"])
        self.assertIn(self.game_id, [item["id"] for item in self.search("Witcher 4")])
        self.assertFalse(hasattr(index, "_search_query_variants"))

    def test_source_alternative_names_match_acronyms(self):
        self.insert_game("Grand Theft Auto VI", alt=["GTA 6"])
        self.assertIn(self.game_id, [item["id"] for item in self.search("GTA 6")])

    def test_popularity_breaks_equally_relevant_titles(self):
        self.insert_game("Starfall Orbit", popularity=2)
        self.insert_game("Starfall Orbits", popularity=1000, offset=1)
        hits = self.search("Starfall Orbit")
        self.assertEqual(hits[0]["id"], self.game_id)  # exact title always wins
        # Equal-quality matches use the cached IGDB popularity.
        self.insert_game("Orbit Starfall", popularity=1500, offset=2)
        fuzzy = self.search("Starfall Orb")
        self.assertEqual(fuzzy[0]["id"], self.game_id + 1)

    def test_future_igdb_game_is_cached_with_real_alternatives(self):
        release_epoch = int(datetime(2031, 5, 26, tzinfo=timezone.utc).timestamp())
        captured = []

        def fake_igdb(url, *, headers, content, timeout):
            captured.append(content)
            self.assertEqual(url, "https://api.igdb.com/v4/games")
            self.assertIn('search "GTA 6"', content)
            self.assertIn("alternative_names.name", content)
            self.assertNotIn('name ~ *"grand"*', content)

            class Response:
                status_code = 200
                def raise_for_status(self):
                    pass
                def json(inner_self):
                    return [{
                        "id": self.game_id,
                        "name": "Grand Theft Auto VI",
                        "first_release_date": release_epoch,
                        "total_rating_count": 100,
                        "alternative_names": [{"name": "GTA 6"}, {"name": "GTA VI"}],
                        "cover": {"image_id": "testcover"},
                    }]
            return Response()

        with patch("api.igdb_client.igdb_client._access_token", return_value=("client", "token")):
            with patch.object(index.httpx, "post", side_effect=fake_igdb):
                results = self.search("GTA 6", "igdb")
        self.assertEqual(results[0]["title"], "Grand Theft Auto VI")
        self.assertEqual(results[0]["releaseDate"], "2031-05-26")
        self.assertEqual(len(captured), 1)
        self.assertIn(self.game_id, [game["id"] for game in self.search("GTA 6")])
        with SessionLocal() as session:
            game = session.scalar(select(Game).where(Game.igdb_id == self.game_id))
            self.assertEqual(game.popularity_count, 100)
            self.assertEqual(
                set(session.scalars(select(GameAlias.name).where(GameAlias.game_id == game.id)).all()),
                {"GTA 6", "GTA VI"},
            )

    def test_igdb_alternative_search_fallback_when_title_search_empty(self):
        calls = []

        class Response:
            status_code = 200
            def __init__(self, result):
                self.result = result
            def raise_for_status(self):
                pass
            def json(self):
                return self.result

        def fake_igdb(url, *, headers, content, timeout):
            calls.append((url, content))
            if url.endswith("/search"):
                self.assertIn('search "LocalAlias"', content)
                return Response([{"game": self.game_id, "alternative_name": "LocalAlias"}])
            if "where id =" in content:
                return Response([{
                    "id": self.game_id,
                    "name": "Another Official Name",
                    "alternative_names": [{"name": "LocalAlias"}],
                }])
            return Response([])

        with patch("api.igdb_client.igdb_client._access_token", return_value=("client", "token")):
            with patch.object(index.httpx, "post", side_effect=fake_igdb):
                results = self.search("LocalAlias", "igdb")

        self.assertEqual(results[0]["id"], self.game_id)
        self.assertEqual(len(calls), 3)
        self.assertIn(self.game_id, [game["id"] for game in self.search("LocalAlias")])

    def test_search_without_matching_titles(self):
        self.insert_game("Elephant Kingdom")
        self.assertEqual(self.search("xxveryunlikelyname"), [])

    def test_igdb_game_genres_are_normalized_and_preserve_ids(self):
        name = "Genre integration QA " + secrets.token_hex(3)
        genre_id = secrets.randbelow(500_000_000) + 500_000_000
        game_id = self.game_id
        class Response:
            status_code = 200
            def raise_for_status(self):
                pass
            def json(self):
                return [{
                    "id": game_id, "name": name,
                    "genres": [{"id": genre_id, "name": "QA unique genre"}],
                }]
        with patch("api.igdb_client.igdb_client._access_token", return_value=("client", "token")):
            with patch.object(index.httpx, "post", return_value=Response()):
                result = self.search(name, "igdb")
        self.assertEqual(result[0]["genres"], ["QA unique genre"])
        with SessionLocal() as session:
            game = session.scalar(select(Game).where(Game.igdb_id == self.game_id))
            genre = session.get(Genre, genre_id)
            self.assertEqual(genre.name, "QA unique genre")
            self.assertIsNotNone(session.scalar(
                select(GameGenre.id).where(
                    GameGenre.game_id == game.id,
                    GameGenre.genre_id == genre_id,
                )
            ))


if __name__ == "__main__":
    unittest.main()
