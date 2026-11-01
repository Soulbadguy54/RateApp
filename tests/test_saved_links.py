"""Owner-scoped saved bookmarks, deduplication, safe previews and deletion."""
import secrets
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import select

from api.database import SessionLocal
from api.index import app
from api.models import Game, SavedLink, User
from api.saved_links_routes import canonical_url


class SavedLinkTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="https://testserver")
        self.nick = "s" + secrets.token_hex(4)
        response = self.client.post("/api/auth/register", json={
            "email": self.nick + "@example.com", "nickname": self.nick,
            "pin": "12345678",
        })
        self.assertEqual(response.status_code, 201, response.text)
        self.igdb_id = 1200000000 + secrets.randbelow(300000000)
        with SessionLocal() as session:
            game = Game(igdb_id=self.igdb_id, title="Hollow Knight Test")
            session.add(game)
            session.commit()
            self.game_pk = game.id

    def tearDown(self):
        self.client.close()
        with SessionLocal() as session:
            user = session.scalar(select(User).where(User.nickname == self.nick))
            if user: session.delete(user)
            game = session.scalar(select(Game).where(Game.igdb_id == self.igdb_id))
            if game: session.delete(game)
            session.commit()

    def save(self, suffix="a"):
        result = self.client.post("/api/saved-links", json={
            "url": f"https://example.org/{self.nick}/{suffix}",
        })
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()

    def test_saving_is_immediate_deduplicated_and_no_worker_metadata(self):
        for url in ("file:///etc/passwd", "http://127.0.0.1/",
                    "https://localhost/", "https://foo.test/",
                    "https://user:password@example.org/"):
            self.assertEqual(self.client.post("/api/saved-links",
                             json={"url": url}).status_code, 422)
        self.assertEqual(canonical_url("HTTPS://EXAMPLE.ORG/Page#fragment"),
                         "https://example.org/Page")
        self.assertEqual(TestClient(app).get("/api/saved-links").status_code, 401)
        first = self.save()
        self.assertEqual(set(first), {"id", "url", "title", "createdAt", "updatedAt"})
        self.assertEqual(self.save()["id"], first["id"])
        with SessionLocal() as session:
            record = session.get(SavedLink, first["id"])
            self.assertEqual(record.status, "ready")
            self.assertEqual(record.gpt_names, [])
        self.assertEqual(self.client.post(f'/api/saved-links/{first["id"]}/retry').status_code, 404)
        self.assertEqual(self.client.post(f'/api/saved-links/{first["id"]}/refresh').status_code, 404)

    def test_bookmarks_list_newest_first_no_games_or_gpt_status(self):
        first = self.save("older")
        second = self.save("newer")
        page = self.client.get("/api/saved-links")
        self.assertEqual(page.status_code, 200)
        ids = [item["id"] for item in page.json()["items"]]
        self.assertLess(ids.index(second["id"]), ids.index(first["id"]))
        for item in page.json()["items"]:
            self.assertNotIn("games", item)
            self.assertNotIn("status", item)
            self.assertNotIn("gptNames", item)

    def test_similar_games_uses_existing_igdb_payload_without_network(self):
        target_id = self.igdb_id + 1
        with SessionLocal() as session:
            original = session.scalar(select(Game).where(Game.igdb_id == self.igdb_id))
            original.igdb_payload = {"similar_games": [target_id, target_id, self.igdb_id]}
            related = Game(igdb_id=target_id, title="Related test game",
                           cover_url="https://images.igdb.com/test.jpg")
            session.add(related)
            session.commit()
        try:
            with patch("api.games_routes.igdb_client.request",
                       side_effect=AssertionError("must use local DB")):
                response = self.client.get(f"/api/games/{self.igdb_id}/similar")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(len(response.json()["items"]), 1)
            self.assertEqual(response.json()["items"][0]["id"], target_id)
            self.assertEqual(response.json()["items"][0]["title"], "Related test game")
            self.assertEqual(TestClient(app).get(
                f"/api/games/{self.igdb_id}/similar").status_code, 401)
        finally:
            with SessionLocal() as session:
                related = session.scalar(select(Game).where(Game.igdb_id == target_id))
                if related: session.delete(related)
                session.commit()

    def test_preview_only_after_save_and_reputation_checked(self):
        link = self.save("preview")
        self.assertIsNone(link["title"])
        # A fast save does not read the source or update its metadata.
        with patch("api.saved_links_safety.preview_source", return_value={
            "title": "Verified article title", "description": "Verified metadata",
        }) as preview:
            result = self.client.post(f'/api/saved-links/{link["id"]}/preview')
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["title"], "Verified article title")
            self.assertEqual(result.json()["description"], "Verified metadata")
            preview.assert_called_once_with(link["url"])
        saved = self.client.get(f'/api/saved-links/{link["id"]}').json()
        self.assertEqual(saved["title"], "Verified article title")
        # Metadata is re-verified instead of serving an untrusted title from
        # the DB forever; source contents may have been edited.
        with patch("api.saved_links_safety.preview_source", return_value={
            "title": "Updated article title", "description": "New summary",
        }) as refresh:
            latest = self.client.post(f'/api/saved-links/{link["id"]}/preview')
        self.assertEqual(latest.json()["title"], "Updated article title")
        refresh.assert_called_once_with(link["url"])
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').json()["title"],
                         "Updated article title")

    def test_failed_preview_never_fetches_untrusted_remote_images(self):
        from api.saved_links_safety import SourceSafetyError
        link = self.save("blocked-preview")
        with patch("api.saved_links_safety.preview_source",
                   side_effect=SourceSafetyError("Unsafe URL", terminal=True)):
            response = self.client.post(f'/api/saved-links/{link["id"]}/preview')
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["title"])
        self.assertIsNone(response.json()["description"])
        self.assertIsNone(self.client.get(f'/api/saved-links/{link["id"]}').json()["title"])

    def test_generic_thumbnail_requires_owner_and_caches_verified_binary(self):
        from api.saved_links_routes import _thumbnail_cache, _thumbnail_lock
        link = self.client.post("/api/saved-links", json={
            "url": "https://news.example.net/articles/first"
        }).json()
        with _thumbnail_lock:
            _thumbnail_cache.clear()
        image = b"\xff\xd8\xff" + b"x" * 200
        with patch("api.saved_links_safety.preview_thumbnail_source",
                   return_value=(image, "image/jpeg")) as fetch:
            response = self.client.get(f'/api/saved-links/{link["id"]}/thumbnail')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, image)
            self.assertEqual(response.headers["content-type"], "image/jpeg")
            self.assertEqual(response.headers["x-content-type-options"], "nosniff")
            again = self.client.get(f'/api/saved-links/{link["id"]}/thumbnail')
            self.assertEqual(again.status_code, 200)
            fetch.assert_called_once_with(link["url"])
        with _thumbnail_lock:
            _thumbnail_cache.clear()

    def test_any_domain_missing_and_unsafe_thumbnail_fail_closed_with_negative_cache(self):
        from api.saved_links_safety import SourceSafetyError
        from api.saved_links_routes import _thumbnail_cache, _thumbnail_lock
        link = self.save("no-image")
        with _thumbnail_lock:
            _thumbnail_cache.clear()
        with patch("api.saved_links_safety.preview_thumbnail_source",
                   return_value=None) as fetch:
            for _ in range(2):
                response = self.client.get(f'/api/saved-links/{link["id"]}/thumbnail')
                self.assertEqual(response.status_code, 204)
                self.assertEqual(response.content, b"")
            fetch.assert_called_once_with(link["url"])
        with _thumbnail_lock:
            _thumbnail_cache.clear()
        with patch("api.saved_links_safety.preview_thumbnail_source",
                   side_effect=SourceSafetyError("blocked")):
            response = self.client.get(f'/api/saved-links/{link["id"]}/thumbnail')
            self.assertEqual(response.status_code, 204)

    def test_bulk_delete_is_atomic_scoped_and_preserves_catalog(self):
        first = self.save("bulk-a")
        second = self.save("bulk-b")
        keeper = self.save("bulk-kept")
        endpoint = "/api/saved-links/bulk-delete"

        # A missing/foreign row makes the entire operation fail: no partial delete.
        self.assertEqual(self.client.post(endpoint, json={
            "ids": [first["id"], 2147483647],
        }).status_code, 404)
        self.assertEqual(self.client.get(f'/api/saved-links/{first["id"]}').status_code, 200)
        for ids in ([], [first["id"], first["id"]], [-1], [True], ["1"]):
            self.assertEqual(self.client.post(endpoint, json={"ids": ids}).status_code, 422)
        self.assertEqual(TestClient(app).post(endpoint, json={
            "ids": [first["id"]],
        }).status_code, 401)

        response = self.client.post(endpoint, json={"ids": [first["id"], second["id"]]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"deleted": 2})
        self.assertEqual(self.client.get(f'/api/saved-links/{first["id"]}').status_code, 404)
        self.assertEqual(self.client.get(f'/api/saved-links/{second["id"]}').status_code, 404)
        self.assertEqual(self.client.get(f'/api/saved-links/{keeper["id"]}').status_code, 200)
        with SessionLocal() as session:
            self.assertIsNotNone(session.get(Game, self.game_pk))

    def test_another_user_cannot_read_or_modify(self):
        link = self.save()
        other = TestClient(app, base_url="https://testserver")
        nick = "z" + secrets.token_hex(4)
        self.assertEqual(other.post("/api/auth/register", json={
            "email": nick + "@example.com", "nickname": nick,
            "pin": "12345678",
        }).status_code, 201)
        for method, path in [("get",""),("delete",""),("post","/refresh"),("post","/retry")]:
            self.assertEqual(getattr(other,method)(
                f'/api/saved-links/{link["id"]}{path}').status_code,404)
        self.assertEqual(other.post(f'/api/saved-links/{link["id"]}/preview').status_code, 404)
        self.assertEqual(other.get(f'/api/saved-links/{link["id"]}/thumbnail').status_code, 404)
        self.assertEqual(other.post("/api/saved-links/bulk-delete", json={
            "ids": [link["id"]],
        }).status_code, 404)
        self.assertEqual(self.client.get(f'/api/saved-links/{link["id"]}').status_code, 200)
        other.close()
        with SessionLocal() as session:
            user = session.scalar(select(User).where(User.nickname == nick))
            if user: session.delete(user)
            session.commit()
