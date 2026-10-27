"""The public production domain must never resolve the staging API via Docker DNS.

Both Compose projects use an 'api' service on the shared rateapp_internal
network, so resolving the short service alias 'api' is nondeterministic.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CaddyEnvironmentIsolationTests(unittest.TestCase):
    def test_public_production_uses_unambiguous_api_container(self):
        caddy = (ROOT / "deploy" / "Caddyfile").read_text(encoding="utf-8")
        production = (ROOT / "deploy" / "compose.yaml").read_text(encoding="utf-8")
        stage = (ROOT / "deploy" / "compose.stage.yaml").read_text(encoding="utf-8")

        self.assertIn("name: rateapp\n", production)
        self.assertIn("  api:\n", production)
        self.assertIn("container_name: rateapp-stage-api", stage)
        self.assertRegex(caddy, r"reverse_proxy\s+rateapp-api-1:8000\b")
        self.assertNotRegex(caddy, r"reverse_proxy\s+api:8000\b")

    def test_staging_host_uses_explicit_staging_upstreams(self):
        caddy = (ROOT / "deploy" / "Caddyfile").read_text(encoding="utf-8")
        self.assertRegex(caddy, r"dev\.r-app\.ru\s*\{")
        self.assertIn("reverse_proxy rateapp-stage-api:8000", caddy)
        self.assertIn("reverse_proxy rateapp-stage-web:8080", caddy)


if __name__ == "__main__":
    unittest.main()
