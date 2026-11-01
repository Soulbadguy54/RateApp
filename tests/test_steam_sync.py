"""Pure boundary tests; no production DB or external HTTP required."""
import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from api import steam_sync


class SteamSyncTests(unittest.TestCase):
    def test_empty_owned_games_are_red_flag_not_zero_wishlist(self):
        with patch.object(steam_sync, "_steam_api", return_value={}):
            games, warning = steam_sync._owned_games("76561198012345678")
        self.assertEqual(games, [])
        self.assertIn("приватности", warning)

    def test_all_zero_playtime_is_suspect_not_verified(self):
        with patch.object(steam_sync, "_steam_api", return_value={
            "game_count": 2, "games": [
                {"appid": 620, "name": "Portal 2", "playtime_forever": 0},
                {"appid": 570, "name": "Dota 2", "playtime_forever": 0},
            ],
        }):
            games, warning = steam_sync._owned_games("76561198012345678")
        self.assertEqual(len(games), 2)
        self.assertIn("не сообщил наигранные часы", warning)

    def test_mixed_playtime_and_missing_minutes(self):
        with patch.object(steam_sync, "_steam_api", return_value={
            "game_count": 3, "games": [
                {"appid": 620, "name": "Portal 2", "playtime_forever": 22},
                {"appid": 570, "name": "Dota 2", "playtime_forever": 0},
                {"appid": 570, "name": "duplicate", "playtime_forever": 99},
                {"appid": 999, "name": "Unknown"},
            ],
        }):
            games, warning = steam_sync._owned_games("76561198012345678")
        self.assertIsNone(warning)
        self.assertEqual([g["appid"] for g in games], [620, 570, 999])
        self.assertEqual([g["minutes"] for g in games], [22, 0, None])

    def test_steam_url_parser_requires_exact_secure_store(self):
        self.assertEqual(
            steam_sync._steam_appid("https://store.steampowered.com/app/1091500/Cyberpunk_2077/"), "1091500"
        )
        self.assertIsNone(steam_sync._steam_appid("https://evilstore.steampowered.com/app/620"))
        self.assertIsNone(steam_sync._steam_appid("http://store.steampowered.com/app/620"))
        self.assertIsNone(steam_sync._steam_appid("https://store.steampowered.com/sub/620/"))

    def test_key_not_configured(self):
        with patch.dict(os.environ, {"STEAM_WEB_API_KEY": ""}):
            with self.assertRaises(HTTPException) as raised:
                steam_sync._steam_key()
        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()

class SteamDatabaseSyncTests(unittest.TestCase):
    """Integration against an isolated CI PostgreSQL; never a production database."""
    def setUp(self):
        from fastapi.testclient import TestClient
        from api.index import app
        from api.database import SessionLocal
        from api.models import User, Game, UserGame, SteamConnection
        from sqlalchemy import select
        import secrets
        self.db = SessionLocal
        self.client = TestClient(app, base_url="https://testserver")
        self.patch_origin = patch("api.steam_sync._origin", return_value="https://testserver")
        self.patch_origin.start()
        self.nickname = "stsync" + secrets.token_hex(4)
        response = self.client.post("/api/auth/register", json={
            "email": self.nickname + "@example.com",
            "nickname": self.nickname, "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.user_id = None
        with self.db() as db:
            user = db.scalar(select(User).where(User.nickname == self.nickname))
            self.user_id = user.id
            db.add(SteamConnection(user_id=user.id, steam_id64="76561198012345678"))
            for external in [700001, 700002, 700003, 700004]:
                db.add(Game(igdb_id=external, title="Steam QA " + str(external)))
            db.flush()
            existing = db.scalar(select(Game).where(Game.igdb_id == 700001))
            entry = UserGame(user_id=user.id, game_id=existing.id, status="completed",
                             platform="PC", completed_at=__import__("datetime").date(2026, 1, 1),
                             atmosphere_score=9, story_score=8, technology_score=7,
                             gameplay_score=8, score=8)
            db.add(entry)
            db.commit()

    def tearDown(self):
        from api.database import SessionLocal
        from api.models import User
        self.client.close()
        self.patch_origin.stop()
        with SessionLocal() as db:
            user = db.get(User, self.user_id)
            if user:
                db.delete(user)
                db.commit()

    def _mock_owned(self, _steam_id):
        return [
            {"appid": 101, "name": "Already rated", "minutes": 100},
            {"appid": 102, "name": "New played", "minutes": 60},
            {"appid": 103, "name": "New wishlist", "minutes": 0},
            {"appid": 104, "name": "Unknown", "minutes": 30},
        ], None

    def test_preview_commit_replay_and_old_playthrough_untouched(self):
        from sqlalchemy import select
        from api.database import SessionLocal
        from api.models import Game, UserGame, Collection, CollectionGame
        with patch.object(steam_sync, "_owned_games", side_effect=self._mock_owned), \
             patch.object(steam_sync, "_resolve_mappings", return_value={101: 700001, 102: 700002, 103: 700003}), \
             patch.object(steam_sync, "_ensure_games", side_effect=lambda ids: self._games(ids)):
            headers = {"Origin": "https://testserver"}
            before = self.client.post("/api/steam/preview", headers=headers)
            self.assertEqual(before.status_code, 200, before.text)
            data = before.json()
            self.assertEqual({r["igdbId"] for r in data["items"]}, {700002, 700003})
            self.assertEqual([u["appid"] for u in data["unresolved"]], [104])
            with SessionLocal() as db:
                self.assertEqual(len(db.scalars(select(UserGame).where(UserGame.user_id == self.user_id)).all()), 1)
            bad_origin = self.client.post("/api/steam/commit", json={"token": data["token"]},
                                          headers={"Origin": "https://evil.example"})
            self.assertEqual(bad_origin.status_code, 403)
            committed = self.client.post("/api/steam/commit", json={"token": data["token"]}, headers=headers)
            self.assertEqual(committed.status_code, 200, committed.text)
            self.assertEqual(len(committed.json()["created"]), 2)
            replay = self.client.post("/api/steam/commit", json={"token": data["token"]}, headers=headers)
            self.assertEqual(replay.status_code, 409)
            with SessionLocal() as db:
                rows = db.scalars(select(UserGame).where(UserGame.user_id == self.user_id)).all()
                self.assertEqual(len(rows), 3)
                indexed = {row.game.igdb_id: row for row in rows}
                old = indexed[700001]
                self.assertEqual(old.status, "completed")
                self.assertEqual(float(old.score), 8)
                self.assertIsNone(old.steam_data)
                playing = indexed[700002]
                self.assertEqual(playing.status, "playing")
                self.assertTrue(playing.steam_data["imported"])
                self.assertEqual(playing.steam_data["apps"][0]["minutes"], 60)
                wishlist = indexed[700003]
                self.assertEqual(wishlist.status, "wishlist")
                self.assertTrue(db.scalar(select(CollectionGame).join(Collection)
                    .where(Collection.user_id == self.user_id, Collection.slug == "wishlist",
                           CollectionGame.user_game_id == wishlist.id)))
            again = self.client.post("/api/steam/preview", headers=headers)
            self.assertEqual(again.status_code, 200, again.text)
            self.assertEqual(again.json()["items"], [])
            self.assertEqual(len(again.json()["unresolved"]), 1)

    def _games(self, ids):
        from api.database import SessionLocal
        from api.models import Game
        from sqlalchemy import select
        with SessionLocal() as db:
            return {g.igdb_id: g for g in db.scalars(select(Game).where(Game.igdb_id.in_(ids)))}
