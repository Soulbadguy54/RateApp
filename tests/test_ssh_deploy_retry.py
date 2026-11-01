"""No-network regression checks for the staging SSH retry guard."""
import contextlib
import io
import os
import sys
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ssh_deploy_retry as retry  # noqa: E402

SHA = "a" * 40
TOKEN = "never-print-deployment-secret"
RESET = "kex_exchange_identification: read: Connection reset by peer\n"
CLOSED = "kex_exchange_identification: Connection closed by remote host\n"


def completed(status: int, stderr: str = "", stdout: str = ""):
    return CompletedProcess(args=["ssh"], returncode=status, stderr=stderr, stdout=stdout)


class StagingSSHRetryTests(unittest.TestCase):
    def test_classification_is_strict_and_requires_exit_255(self):
        self.assertTrue(retry.is_retryable_ssh_failure(255, RESET))
        self.assertTrue(retry.is_retryable_ssh_failure(255, CLOSED))
        for code, error in [
            (1, RESET), (255, "Permission denied (publickey)."),
            (255, "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!"),
            (1, "alembic upgrade head failed"),
            (255, "Connection timed out"),
            (255, "Connection reset by peer"),
        ]:
            with self.subTest(code=code, error=error):
                self.assertFalse(retry.is_retryable_ssh_failure(code, error))

    @patch.object(retry.time, "sleep")
    @patch.object(retry, "notify_ssh_retry")
    @patch.object(retry.subprocess, "run")
    def test_retries_only_preauth_reset_and_recovers(self, run, notify, sleep):
        run.side_effect = [completed(255, RESET), completed(0, stdout="deployed\n")]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(retry.deploy(SHA, TOKEN, "/tmp/key"), 0)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(sleep.call_args.args, (90,))
        notify.assert_called_once_with(attempt=1, total=3, seconds=90)
        self.assertEqual(run.call_args.kwargs["input"], TOKEN + "\n")
        self.assertIn("StrictHostKeyChecking=yes", " ".join(run.call_args.args[0]))
        self.assertNotIn(TOKEN, out.getvalue())

    @patch.object(retry.time, "sleep")
    @patch.object(retry, "notify_ssh_retry")
    @patch.object(retry.subprocess, "run")
    def test_unrelated_failure_is_not_retried(self, run, notify, sleep):
        for failure in [completed(255, "Permission denied (publickey)."),
                        completed(1, "Remote deploy failed")]:
            run.reset_mock()
            with self.subTest(failure=failure.returncode):
                run.return_value = failure
                self.assertEqual(retry.deploy(SHA, TOKEN, "/tmp/key"), failure.returncode)
                run.assert_called_once()
        sleep.assert_not_called()
        notify.assert_not_called()

    @patch.object(retry.time, "sleep")
    @patch.object(retry, "notify_ssh_retry")
    @patch.object(retry.subprocess, "run")
    def test_all_ssh_resets_exhaust_retries_and_alert(self, run, notify, sleep):
        run.return_value = completed(255, RESET)
        self.assertEqual(retry.deploy(SHA, TOKEN, "/tmp/key"), 255)
        self.assertEqual(run.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [90, 180])
        self.assertEqual(notify.call_args_list[-1].kwargs["seconds"], None)

    @patch.object(retry.subprocess, "run")
    def test_invalid_sha_never_attempts_ssh(self, run):
        self.assertEqual(retry.deploy("develop; true", TOKEN, "/tmp/key"), 2)
        self.assertEqual(retry.deploy(SHA, "", "/tmp/key"), 2)
        run.assert_not_called()

    @patch.object(retry.time, "sleep")
    @patch.object(retry, "notify_ssh_retry")
    @patch.object(retry.subprocess, "run")
    def test_timeout_does_not_repeat_remote_deployment(self, run, notify, sleep):
        from subprocess import TimeoutExpired
        run.side_effect = TimeoutExpired(["ssh"], timeout=900)
        self.assertEqual(retry.deploy(SHA, TOKEN, "/tmp/key"), 124)
        run.assert_called_once()
        notify.assert_not_called()
        sleep.assert_not_called()

    @patch.dict(os.environ, {"TG_BOT_TOKEN": "bot-secret", "TG_CHAT_ID": "123",
                             "GITHUB_REPOSITORY": "Soulbadguy54/RateApp", "GITHUB_RUN_ID": "456"})
    @patch.object(retry, "send_telegram")
    def test_telegram_mentions_ssh_delay_without_sensitive_values(self, send):
        retry.notify_ssh_retry(attempt=1, total=3, seconds=90)
        message, _, _ = send.call_args.args
        self.assertIn("SSH", message)
        self.assertIn("MaxStartups", message)
        self.assertIn("90 сек", message)
        self.assertIn("actions/runs/456", message)
        self.assertNotIn("bot-secret", message)
        self.assertNotIn(TOKEN, message)


if __name__ == "__main__":
    unittest.main()
