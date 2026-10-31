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

    def test_cloud_choices_are_owner_scoped_atomic_and_strictly_three(self):
        with SessionLocal() as session:
            owner = session.scalar(select(User).where(User.nickname == self.nickname))
            game = Game(igdb_id=1_500_000_000 + secrets.randbelow(300_000_000),
                        title="Own cloud pick")
            session.add(game)
            session.flush()
            session.add(UserGame(user_id=owner.id, game_id=game.id, status="playing"))
            session.commit()
            game_id = game.id
        try:
            response = self.client.post("/api/profile/appearance", json={
                "tint": "coral", "cloudGameIds": [None, game_id, None],
            })
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["profileCloudGameIds"], [None, game_id, None])
            self.assertEqual(self.client.get("/api/profile").json()["profileCloudGameIds"],
                             [None, game_id, None])
            for slots in ([game_id, game_id, None], [game_id, None],
                          [None, None, None, None], [game_id + 1, None, None]):
                response = self.client.post("/api/profile/appearance", json={
                    "tint": "blue", "cloudGameIds": slots,
                })
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(self.client.get("/api/profile").json()["profileTint"], "coral")
                self.assertEqual(self.client.get("/api/profile").json()["profileCloudGameIds"],
                                 [None, game_id, None])
            # Omission never resets the user's pinned clouds.
            response = self.client.post("/api/profile/appearance", json={"tint": "rose"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["profileCloudGameIds"], [None, game_id, None])
        finally:
            with SessionLocal() as session:
                owner = session.scalar(select(User).where(User.nickname == self.nickname))
                if owner:
                    session.query(UserGame).filter(UserGame.user_id == owner.id,
                                                   UserGame.game_id == game_id).delete()
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
