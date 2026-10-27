"""Regression guards for the two protected release handoffs.

These are intentionally small static checks: GitHub Actions tests the actual
workflow, while these prevent reintroducing the broken event-only chain.
"""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
CI = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
VPS = (ROOT / ".github/workflows/vps-deploy.yml").read_text(encoding="utf-8")


class ReleaseHandoffTests(unittest.TestCase):
    def test_main_to_vps_handoff_waits_for_full_green_ci_and_smoke(self):
        job = CI.split("  dispatch-production-after-green-ci:", 1)[1].split(
            "\n  # The production release", 1
        )[0]
        self.assertIn(
            "needs: [build, backend-tests, mobile-e2e, production-smoke]", job
        )
        self.assertIn("github.ref == 'refs/heads/main'", job)
        self.assertIn("actions: write", job)
        self.assertIn("vps-deploy.yml/dispatches", job)
        self.assertIn("inputs[tested_sha]=$TESTED_SHA", job)
        self.assertIn("inputs[ci_run_id]=$CI_RUN_ID", job)

    def test_vps_dispatch_cannot_skip_main_ci_verification(self):
        self.assertNotIn("  workflow_run:", VPS.split("\npermissions:", 1)[0])
        self.assertIn("      tested_sha:", VPS)
        self.assertIn("      ci_run_id:", VPS)
        self.assertIn("actions: read", VPS)
        self.assertIn("test \"$current_main\" = \"$TESTED_SHA\"", VPS)
        self.assertIn('.conclusion == "success"', VPS)
        for job in ("build", "backend-tests", "mobile-e2e", "production-smoke"):
            self.assertIn(job, VPS)

    def test_release_to_main_handoff_retains_sha_and_approval_gate(self):
        self.assertIn("  promote-approved-release:", CI)
        self.assertIn("contains(github.event.pull_request.labels.*.name, 'release-approved')", CI)
        self.assertIn('test "$actual_main" = "$merged_sha"', CI)
        self.assertIn("actions/workflows/ci.yml/dispatches", CI)


if __name__ == "__main__":
    unittest.main()
