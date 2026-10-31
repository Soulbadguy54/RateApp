"""Profile avatar/tint tests. Run against migrated isolated PostgreSQL."""
import base64
import secrets
import struct
import unittest
import zlib

from fastapi.testclient import TestClient
from sqlalchemy import select
from api.index import app
from api.database import SessionLocal
from api.models import User, Game, UserGame


def tiny_png() -> bytes:
    def chunk(kind: bytes, data: bytes):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    ihdr = struct.pack(">IIBBBBB", 256, 256, 8, 2, 0, 0, 0)
    scanline = b"\x00" + b"\x80\x70\x90" * 256
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
            chunk(b"IDAT", zlib.compress(scanline * 256)) + chunk(b"IEND", b""))


class ProfileAppearanceTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="https://testserver")
        self.nickname = "a" + secrets.token_hex(4)
        response = self.client.post("/api/auth/register", json={
            "email": self.nickname + "@example.com",
            "nickname": self.nickname,
            "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)

    def tearDown(self):
        self.client.close()
        with SessionLocal() as session:
            user = session.scalar(select(User).where(User.nickname == self.nickname))
            if user:
                session.delete(user)
                session.commit()

    def test_tint_then_avatar_persists_and_owner_can_read(self):
        response = self.client.post("/api/profile/appearance", json={"tint": "teal"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["profileTint"], "teal")
        self.assertEqual(response.json()["avatarVersion"], 0)
        png = tiny_png()
        response = self.client.post("/api/profile/appearance", json={
            "tint": "blue", "updateAvatar": True,
            "avatarData": base64.b64encode(png).decode("ascii"),
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["avatarVersion"], 1)
        self.assertEqual(response.json()["profileTint"], "blue")
        self.assertEqual(self.client.get("/api/profile/avatar").content, png)
        self.assertEqual(self.client.get("/api/profile").json()["profileTint"], "blue")
        self.assertNotIn("avatarData", self.client.get("/api/profile").json())
        response = self.client.post("/api/profile/appearance", json={"tint": "coral"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["profileTint"], "coral")
        self.assertEqual(response.json()["avatarVersion"], 1)
        self.assertEqual(self.client.get("/api/profile/avatar").content, png)
        response = self.client.post("/api/profile/appearance", json={
            "tint": "default", "updateAvatar": True, "avatarData": None,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["avatarVersion"], 2)
        self.assertEqual(self.client.get("/api/profile/avatar").status_code, 404)

    def test_cloud_choices_use_public_igdb_ids_and_support_playing_and_rated(self):
        """Regression: bootstrap.gameId == Game.igdb_id, NOT UserGame.game_id.

        Previously the API compared public IDs to local FKs and rejected both
        a playing Control and a rated RDR2, despite them being in My Games.
        """
        with SessionLocal() as session:
            owner = session.scalar(select(User).where(User.nickname == self.nickname))
            base_igdb_id = 1_500_000_000 + secrets.randbelow(200_000_000)
            first = Game(igdb_id=base_igdb_id, title="Control (playing)")
            second = Game(igdb_id=base_igdb_id + 1, title="Red Dead Redemption 2 (rated)")
            session.add_all([first, second])
            session.flush()
            local_ids = [first.id, second.id]
            public_ids = [first.igdb_id, second.igdb_id]
            self.assertNotEqual(local_ids, public_ids)
            session.add_all([
                UserGame(user_id=owner.id, game_id=first.id, status="playing"),
                UserGame(user_id=owner.id, game_id=second.id, status="completed", score=9.5),
            ])
            session.commit()

        try:
            slots = [public_ids[0], public_ids[1], None]
            response = self.client.post("/api/profile/appearance", json={
                "tint": "coral", "cloudGameIds": slots,
            })
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["profileCloudGameIds"], slots)
            self.assertEqual(self.client.get("/api/profile").json()["profileCloudGameIds"], slots)

            # A local database ID is not a valid public game ID. Nor may a
            # client pass a foreign/non-library ID or pin the same game twice.
            for bad in ([local_ids[0], None, None],
                        [public_ids[0], public_ids[0], None],
                        [public_ids[0], None],
                        [None, None, None, None],
                        [public_ids[1] + 10, None, None]):
                response = self.client.post("/api/profile/appearance", json={
                    "tint": "blue", "cloudGameIds": bad,
                })
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(self.client.get("/api/profile").json()["profileTint"], "coral")
                self.assertEqual(self.client.get("/api/profile").json()["profileCloudGameIds"], slots)

            # Omission keeps pins, and clearing them returns to auto ranking.
            response = self.client.post("/api/profile/appearance", json={"tint": "rose"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["profileCloudGameIds"], slots)
            response = self.client.post("/api/profile/appearance", json={
                "tint": "default", "cloudGameIds": [None, None, None],
            })
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["profileCloudGameIds"], [None, None, None])
        finally:
            with SessionLocal() as session:
                owner = session.scalar(select(User).where(User.nickname == self.nickname))
                if owner:
                    session.query(UserGame).filter(
                        UserGame.user_id == owner.id,
                        UserGame.game_id.in_(local_ids),
                    ).delete(synchronize_session=False)
                for game_id in local_ids:
                    game = session.get(Game, game_id)
                    if game:
                        session.delete(game)
                session.commit()

    def test_avatar_rejects_invalid_payload_and_auth(self):
        self.assertEqual(self.client.get("/api/profile/avatar").status_code, 404)
        self.assertEqual(self.client.post("/api/profile/appearance", json={
            "tint": "injected",
        }).status_code, 422)
        self.assertEqual(self.client.post("/api/profile/appearance", json={
            "tint": "violet", "updateAvatar": True,
            "avatarData": base64.b64encode(b"not a PNG").decode(),
        }).status_code, 422)
        self.assertEqual(self.client.post("/api/profile/appearance", json={
            "tint": "teal", "avatarData": base64.b64encode(tiny_png()).decode(),
        }).status_code, 422)
        self.client.post("/api/auth/logout")
        self.assertEqual(self.client.get("/api/profile/avatar").status_code, 401)
        self.assertEqual(self.client.post("/api/profile/appearance", json={
            "tint": "violet",
        }).status_code, 401)
