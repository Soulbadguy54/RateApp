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
        self.assertIn("полный CI пройден", message)
        self.assertIn("Мобильные E2E", message)
        self.assertIn("5 мин 10 сек", message)
        self.assertIn("<a href=", message)

    def test_release_pr_metadata_can_disappear_after_merge(self):
        event = notification("Frontend CI", "success", "pull_request", "develop")
        msg = make_message(event, [
            {"name": "build", "conclusion": "success"},
            {"name": "backend-tests", "conclusion": "success"},
            {"name": "mobile-e2e", "conclusion": "success"},
            {"name": "promote-approved-release", "conclusion": "success"},
        ])
        self.assertIn("Production · релизные тесты пройдены", msg)
        self.assertIn("автоматически слит", msg)
        self.assertIn("main CI", msg)
        self.assertIn("Слияние одобренного PR в main", msg)
        self.assertNotIn("цель PR уточняется", msg)

    def test_main_dispatch_success_only_deploy_reports_published(self):
        self.assertIsNone(make_message(notification("Frontend CI", "success", "workflow_dispatch", "main")))
        msg = make_message(notification("Frontend CI", "failure", "workflow_dispatch", "main"))
        self.assertIn("main CI не прошёл", msg)
        self.assertIn("заблокирован", msg)

    def test_fast_preview_is_not_claimed_as_full_green(self):
        self.assertIsNone(make_message(notification("Frontend CI", "success")))

    def test_main_ci_success_waits_for_deploy(self):
        self.assertIsNone(make_message(notification("Frontend CI", "success", branch="main")))

    def test_ci_failure_is_prominent(self):
        # Actual failed release #70: tests run on develop, but the target is main.
        event = notification("Frontend CI", "failure", "pull_request", "develop")
        event["workflow_run"]["pull_requests"] = [
            {"number": 70, "head": {"ref": "develop"}, "base": {"ref": "main"}},
        ]
        text = make_message(event, [{"name": "mobile-e2e", "conclusion": "failure"}])
        self.assertIn("Production · релизные тесты НЕ пройдены", text)
        self.assertIn("develop → main", text)
        self.assertIn("Цель PR: <b>main · production</b>", text)
        self.assertIn("❌ Мобильные E2E", text)
        self.assertIn("заблокирован", text)

    def test_staging_deployment_good(self):
        text = make_message(
            notification("VPS staging deployment", "success"),
            revision="1234567890abcdef1234567890abcdef12345678",
            changes=["Discovery: жесты свайпов", "Навигация: закрытие капли"],
        )
        self.assertIn("Staging обновлён", text)
        self.assertIn("dev.r-app.ru", text)
        self.assertIn("production на r-app.ru не обновлялся", text)
        self.assertIn("Что вошло в обновление", text)
        self.assertIn("1234567890ab", text)
        self.assertIn("Discovery: жесты свайпов", text)
        self.assertIn("Навигация: закрытие капли", text)
        self.assertNotIn("Production обновлён", text)

    def test_production_deployment_bad(self):
        text = make_message(notification("VPS production deployment", "failure", branch="main"))
        self.assertIn("Production-деплой не удался", text)
        # A failed deploy must not claim that a changelog was published.
        self.assertNotIn("Что вошло в обновление", text)
        published = make_message(
            notification("VPS production deployment", "success", branch="main"),
            revision="fedcba9876543210fedcba9876543210fedcba98",
            changes=["fix: только оформление Telegram (#76)"],
        )
        self.assertIn("Production обновлён", published)
        self.assertIn("Что вошло в обновление", published)
        self.assertIn("fedcba987654", published)
        self.assertIn("только оформление Telegram", published)
        self.assertNotIn("Discovery: жесты свайпов", published)

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
