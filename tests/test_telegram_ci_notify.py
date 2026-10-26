"""Pure rendering tests: run on CI without Telegram secrets/network."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from telegram_ci_notify import make_message, job_lines  # noqa: E402


def notification(workflow: str, result: str, source="push", branch="develop"):
    return {
        "workflow": {"name": workflow},
        "workflow_run": {
            "name": workflow, "conclusion": result,
            "event": source, "head_branch": branch,
            "html_url": "https://github.com/Soulbadguy54/RateApp/actions/runs/123",
            "run_started_at": "2026-10-27T08:00:00Z",
            "updated_at": "2026-10-27T08:05:10Z",
        },
    }


class TelegramCIMessageTests(unittest.TestCase):
    def test_manual_full_ci_pass_and_job_breakdown(self):
        event = notification("Frontend CI", "success", "workflow_dispatch")
        message = make_message(event, [
            {"name": "build", "conclusion": "success"},
            {"name": "backend-tests", "conclusion": "success"},
            {"name": "mobile-e2e", "conclusion": "success"},
        ])
        self.assertIn("Полный CI пройден", message)
        self.assertIn("Мобильные E2E", message)
        self.assertIn("5 мин 10 сек", message)
        self.assertIn("<a href=", message)

    def test_fast_preview_is_not_claimed_as_full_green(self):
        self.assertIsNone(make_message(notification("Frontend CI", "success")))

    def test_main_ci_success_waits_for_deploy(self):
        self.assertIsNone(make_message(notification("Frontend CI", "success", branch="main")))

    def test_ci_failure_is_prominent(self):
        text = make_message(notification("Frontend CI", "failure", "pull_request", "feature/test"))
        self.assertIn("не пройден", text)
        self.assertIn("❌", text)

    def test_staging_deployment_good(self):
        text = make_message(notification("VPS staging deployment", "success"))
        self.assertIn("Staging обновлён", text)
        self.assertIn("dev.r-app.ru", text)

    def test_production_deployment_bad(self):
        text = make_message(notification("VPS production deployment", "failure", branch="main"))
        self.assertIn("Production-деплой не удался", text)

    def test_health_only_notifies_failure(self):
        self.assertIsNone(make_message(notification("RateApp daily production health", "success")))
        self.assertIn("Проверка production", make_message(notification("RateApp daily production health", "failure")))

    def test_cancelled_and_skipped_silent(self):
        self.assertIsNone(make_message(notification("Frontend CI", "cancelled")))
        self.assertIsNone(make_message(notification("Frontend CI", "skipped")))

    def test_user_controlled_strings_html_escaped(self):
        event = notification("Frontend CI", "failure", "pull_request", '<evil>')
        text = make_message(event, [])
        self.assertIn("&lt;evil&gt;", text)
        self.assertNotIn("<evil>", text)

    def test_manual_test_notification(self):
        self.assertIn("Telegram подключён", make_message({}))

    def test_job_details_distinguish_failure(self):
        self.assertEqual(job_lines([{"name": "mobile-e2e", "conclusion": "failure"}]),
                         ["❌ Мобильные E2E"])


if __name__ == "__main__":
    unittest.main()
