"""Steam OpenID link regression tests. No live Steam traffic, no game import."""
import secrets
import unittest
from urllib.parse import parse_qs, urlencode, urlsplit
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import select, func

from api.index import app
from api.database import SessionLocal
from api.models import User, UserGame, SteamConnection


STEAM_ID = "76561198012345678"
STEAM_ENDPOINT = "https://steamcommunity.com/openid/login"


class SteamLinkTests(unittest.TestCase):
    def setUp(self):
        self.origin_patch = patch("api.steam_routes._origin", return_value="https://testserver")
        self.origin_patch.start()
        self.client = TestClient(app, base_url="https://testserver", follow_redirects=False)
        self.nickname = "s" + secrets.token_hex(4)
        response = self.client.post("/api/auth/register", json={
            "email": self.nickname + "@example.test",
            "nickname": self.nickname,
            "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)

    def tearDown(self):
        self.client.close()
        self.origin_patch.stop()
        with SessionLocal() as session:
            user = session.scalar(select(User).where(User.nickname == self.nickname))
            if user:
                session.delete(user)
                session.commit()

    def _start(self):
        response = self.client.get("/api/steam/connect")
        self.assertEqual(response.status_code, 303, response.text)
        url = urlsplit(response.headers["location"])
        self.assertEqual(url.scheme + "://" + url.netloc + url.path, STEAM_ENDPOINT)
        args = parse_qs(url.query)
        self.assertEqual(args["openid.mode"], ["checkid_setup"])
        self.assertEqual(args["openid.realm"], ["https://testserver/"])
        ret = args["openid.return_to"][0]
        state = parse_qs(urlsplit(ret).query)["state"][0]
        return ret, state

    def _assertion(self, ret, state, steam_id=STEAM_ID):
        claimed = "http://steamcommunity.com/openid/id/" + steam_id
        return {
            "state": state,
            "openid.ns": "http://specs.openid.net/auth/2.0",
            "openid.mode": "id_res",
            "openid.return_to": ret,
            "openid.op_endpoint": STEAM_ENDPOINT,
            "openid.claimed_id": claimed,
            "openid.identity": claimed,
            "openid.signed": "return_to,claimed_id,identity,op_endpoint,response_nonce",
            "openid.response_nonce": "2026-11-01T00:00:00Ztestnonce",
            "openid.sig": "test-signature-verified-by-mock",
        }

    def test_full_identity_link_is_idempotent_and_does_not_touch_games(self):
        with SessionLocal() as session:
            user = session.scalar(select(User).where(User.nickname == self.nickname))
            before = session.scalar(select(func.count(UserGame.id)).where(UserGame.user_id == user.id))
        self.assertEqual(self.client.get("/api/steam/connection").json()["connected"], False)
        ret, state = self._start()
        with patch("api.steam_routes._check_steam", return_value=True) as check:
            response = self.client.get("/api/steam/callback?" + urlencode(self._assertion(ret, state)))
            check.assert_called_once()
        self.assertEqual(response.status_code, 303)
        self.assertIn("steam=connected", response.headers["location"])
        connected = self.client.get("/api/steam/connection").json()
        self.assertEqual(connected, {"connected": True, "steamId64": STEAM_ID})
        with SessionLocal() as session:
            user = session.scalar(select(User).where(User.nickname == self.nickname))
            after = session.scalar(select(func.count(UserGame.id)).where(UserGame.user_id == user.id))
        self.assertEqual(before, after)

        # Replay of already consumed OpenID assertion cannot relink.
        with patch("api.steam_routes._check_steam") as check:
            replay = self.client.get("/api/steam/callback?" + urlencode(self._assertion(ret, state)))
            check.assert_not_called()
        self.assertIn("steam=expired", replay.headers["location"])
        # The browser sends Origin on a same-origin DELETE.
        deleted = self.client.delete("/api/steam/connection", headers={"Origin": "https://testserver"})
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.client.get("/api/steam/connection").json()["connected"], False)
        with SessionLocal() as session:
            user = session.scalar(select(User).where(User.nickname == self.nickname))
            self.assertEqual(session.scalar(select(func.count(UserGame.id)).where(UserGame.user_id == user.id)), before)

    def test_missing_signature_and_wrong_return_to_fail_closed(self):
        ret, state = self._start()
        assertion = self._assertion(ret, state)
        assertion["openid.signed"] = "claimed_id,identity"
        with patch("api.steam_routes._check_steam") as check:
            bad = self.client.get("/api/steam/callback?" + urlencode(assertion))
            check.assert_not_called()
        self.assertIn("steam=invalid", bad.headers["location"])
        self.assertFalse(self.client.get("/api/steam/connection").json()["connected"])

        ret, state = self._start()
        assertion = self._assertion(ret, state)
        assertion["openid.return_to"] = "https://evil.example/api/steam/callback?state=" + state
        with patch("api.steam_routes._check_steam") as check:
            bad = self.client.get("/api/steam/callback?" + urlencode(assertion))
            check.assert_not_called()
        self.assertIn("steam=invalid", bad.headers["location"])

    def test_steam_provider_rejection_and_csrf_unlink(self):
        ret, state = self._start()
        with patch("api.steam_routes._check_steam", return_value=False):
            rejected = self.client.get("/api/steam/callback?" + urlencode(self._assertion(ret, state)))
        self.assertIn("steam=unavailable", rejected.headers["location"])
        self.assertEqual(self.client.delete("/api/steam/connection", headers={"Origin": "https://bad.example"}).status_code, 403)
        self.assertEqual(self.client.get("/api/steam/connection").json()["connected"], False)

    def test_unauthenticated_is_not_linkable(self):
        with TestClient(app, base_url="https://testserver", follow_redirects=False) as anonymous:
            self.assertEqual(anonymous.get("/api/steam/connection").status_code, 401)
            self.assertEqual(anonymous.get("/api/steam/connect").status_code, 401)
