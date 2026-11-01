#!/usr/bin/env python3
"""Retry staging deployment only for SSH pre-authentication connection resets.

The deploy command itself is NOT idempotent by assumption: never retry a
remote failure, authentication rejection, host-key failure or timeout.
"""
from __future__ import annotations

import html
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from telegram_ci_notify import send_telegram

RETRY_DELAYS = (90, 180)  # At most three connection attempts.
# OpenSSH drops excess unauthenticated connections before checking our key.
# Other exit 255 failures (including host-key/auth failures) must NOT retry.
PREAUTH_RESET = re.compile(
    r"(?:kex_exchange_identification|ssh_exchange_identification): "
    r"(?:read: Connection reset by peer|Connection closed by remote host)"
)


def is_retryable_ssh_failure(exit_code: int, stderr: str) -> bool:
    return exit_code == 255 and bool(PREAUTH_RESET.search(stderr))


def actions_url() -> str:
    repository = os.getenv("GITHUB_REPOSITORY", "")
    run_id = os.getenv("GITHUB_RUN_ID", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        return "https://github.com/Soulbadguy54/RateApp/actions"
    if not re.fullmatch(r"[1-9]\d*", run_id):
        return f"https://github.com/{repository}/actions"
    return f"https://github.com/{repository}/actions/runs/{run_id}"


def notify_ssh_retry(*, attempt: int, total: int, seconds: int | None) -> None:
    token = os.getenv("TG_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TG_CHAT_ID", "").strip()
    if not token or not chat_id:
        print("Telegram: credentials unavailable; deploy retry continues.", file=sys.stderr)
        return
    if seconds is None:
        description = (
            f"После {total} попыток SSH-соединение не установлено. "
            "Staging не обновлен; нужен разбор серверных SSH-логов."
        )
        heading = "❌ <b>Rate APP · staging: SSH не восстановился</b>"
    else:
        heading = "⚠️ <b>Rate APP · staging: сброс SSH до авторизации</b>"
        description = (
            f"Попытка {attempt}/{total}: сервер оборвал SSH при установлении соединения "
            f"(возможен лимит MaxStartups). Повторим через {seconds} сек. "
            "Это не ошибка тестов или миграции."
        )
    message = (
        f"{heading}\n\n{html.escape(description)}\n"
        "Production не затронут.\n\n"
        f'<a href="{html.escape(actions_url(), quote=True)}">GitHub Actions · деплой</a>'
    )
    try:
        send_telegram(message, token, chat_id)
    except (OSError, RuntimeError, ValueError) as error:
        # Telegram is an optional notification, not a reason to rerun a deploy.
        # Never print the URL or token-bearing exception.
        print(f"Telegram notification unavailable: {type(error).__name__}", file=sys.stderr)


def deploy(sha: str, github_token: str, key_path: str) -> int:
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        print("Refusing invalid staging commit SHA.", file=sys.stderr)
        return 2
    if not github_token:
        print("Missing GitHub deployment credential.", file=sys.stderr)
        return 2

    args = [
        "ssh", "-T", "-i", key_path,
        "-o", "StrictHostKeyChecking=yes",
        "-o", "BatchMode=yes",
        "-o", "ConnectionAttempts=1",
        "-o", "ConnectTimeout=20",
        "rateapp-deploy@111.88.215.215",
        f"deploy-stage {sha}",
    ]
    total = len(RETRY_DELAYS) + 1
    for attempt in range(1, total + 1):
        print(f"Staging SSH connection attempt {attempt}/{total}", flush=True)
        try:
            completed = subprocess.run(
                args, input=github_token + "\n", text=True,
                capture_output=True, check=False, timeout=900,
            )
        except subprocess.TimeoutExpired:
            # A timeout could occur *after* the remote script started;
            # retrying could duplicate a migration or deployment.
            print("SSH/deploy timed out; not retrying an ambiguous remote operation.", file=sys.stderr)
            return 124

        if completed.stdout:
            print(completed.stdout, end="" if completed.stdout.endswith("\n") else "\n", flush=True)
        if completed.stderr:
            print(completed.stderr, end="" if completed.stderr.endswith("\n") else "\n", file=sys.stderr)
        if completed.returncode == 0:
            print(f"Staging SSH/deploy succeeded on attempt {attempt}/{total}", flush=True)
            return 0
        if not is_retryable_ssh_failure(completed.returncode, completed.stderr):
            print("Failure is not a recognized SSH pre-auth reset. No retry.", file=sys.stderr)
            return completed.returncode or 1

        if attempt == total:
            notify_ssh_retry(attempt=attempt, total=total, seconds=None)
            print(f"SSH pre-auth reset persisted after {total} attempts.", file=sys.stderr)
            return completed.returncode

        delay = RETRY_DELAYS[attempt - 1]
        notify_ssh_retry(attempt=attempt, total=total, seconds=delay)
        print(f"SSH pre-auth reset; retrying in {delay} seconds.", flush=True)
        time.sleep(delay)
    return 1


if __name__ == "__main__":
    raise SystemExit(deploy(
        os.getenv("DEPLOY_SHA", ""),
        os.getenv("GH_TOKEN", ""),
        str(Path.home() / ".ssh" / "id_ed25519"),
    ))
