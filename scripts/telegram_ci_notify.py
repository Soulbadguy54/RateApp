#!/usr/bin/env python3
"""A single formatted Telegram notification per meaningful CI/CD result.

Triggered by workflow_run from trusted main code. No secrets in workflow inputs
or logs; never check out code from the triggering PR or execute its artifacts.
"""
from __future__ import annotations

import html
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any


def clean(value: object) -> str:
    return html.escape(str(value or ""), quote=True)


def fmt_link(url: object, title: object) -> str:
    value = str(url or "")
    if not value.startswith("https://github.com/"):
        return clean(title)
    return f'<a href="{clean(value)}">{clean(title)}</a>'


def duration(run: dict[str, Any]) -> str:
    try:
        start = datetime.fromisoformat(run["run_started_at"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00"))
        seconds = max(0, int((end - start).total_seconds()))
        return f"{seconds // 60} мин {seconds % 60} сек" if seconds >= 60 else f"{seconds} сек"
    except (KeyError, AttributeError, TypeError, ValueError):
        return ""


def get_jobs(run: dict[str, Any], token: str) -> list[dict[str, Any]]:
    repo = run.get("repository", {}).get("full_name") or os.getenv("GITHUB_REPOSITORY", "")
    run_id = run.get("id")
    if not token or not run_id or "/" not in repo:
        return []
    endpoint = f"https://api.github.com/repos/{repo}/actions/runs/{run_id}/jobs?per_page=100"
    req = urllib.request.Request(endpoint, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "rateapp-telegram-ci",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response).get("jobs", [])
    except (urllib.error.URLError, TimeoutError, ValueError):
        # A GitHub API hiccup must not suppress the overall CI result.
        return []


def job_lines(jobs: list[dict[str, Any]]) -> list[str]:
    names = {
        "build": "Сборка",
        "backend-tests": "Backend",
        "mobile-e2e": "Мобильные E2E",
        "production-smoke": "Production smoke",
    }
    markers = {
        "success": "✅", "failure": "❌", "timed_out": "⏰",
        "cancelled": "⚪", "skipped": "➖",
    }
    result = []
    for job in jobs:
        name = job.get("name", "")
        if name not in names:
            continue
        conclusion = job.get("conclusion", "")
        if conclusion in markers:
            result.append(f'{markers[conclusion]} {clean(names[name])}')
    return result


def make_message(event: dict[str, Any], jobs: list[dict[str, Any]] | None = None) -> str | None:
    if "workflow_run" not in event:
        return (
            "🔔 <b>Rate APP · Telegram подключён!</b>\n\n"
            "✅ Тестовое уведомление доставлено.\n"
            "🤖 Бот готов присылать результаты сборок, тестов и деплоев.\n\n"
            "🔗 " + fmt_link("https://github.com/Soulbadguy54/RateApp/actions",
                               "Открыть GitHub Actions")
        )

    run = event["workflow_run"]
    workflow = event.get("workflow", {}).get("name") or run.get("name", "")
    result = run.get("conclusion", "")
    source = run.get("event", "")
    branch = run.get("head_branch", "")
    url = run.get("html_url", "")
    if result in ("skipped", "cancelled", None, ""):
        return None

    passed = result == "success"
    fail = result in ("failure", "timed_out", "action_required", "startup_failure")
    if not passed and not fail:
        return None

    details = []
    if workflow == "Frontend CI":
        if source == "push" and branch == "develop":
            if passed:
                return None  # A fast preview is NOT a complete test pass.
            heading = "❌ <b>Staging · подготовка не удалась</b>"
            description = "Быстрая проверка ветки develop завершилась с ошибкой."
        elif source == "push" and branch == "main":
            if passed:
                return None  # The real release verdict comes from VPS deployment.
            heading = "❌ <b>Production · релиз заблокирован</b>"
            description = "Полный CI не прошёл. На production ничего не выпускаем."
        else:
            heading = (
                "✅ <b>Полный CI пройден</b>" if passed
                else "❌ <b>Полный CI не пройден</b>"
            )
            description = (
                "Можно переходить к следующему этапу релиза."
                if passed else "Обнаружены ошибки, выпуск нужно остановить."
            )
        details = job_lines(jobs or [])
    elif workflow == "VPS staging deployment":
        heading = (
            "🧪✅ <b>Staging обновлён</b>" if passed
            else "🧪❌ <b>Ошибка staging-деплоя</b>"
        )
        description = (
            "Тестовая версия опубликована на dev.r-app.ru."
            if passed else "Тестовую версию не удалось полностью развернуть."
        )
    elif workflow == "VPS production deployment":
        heading = (
            "🚀✅ <b>Production обновлён</b>" if passed
            else "🚨❌ <b>Production-деплой не удался</b>"
        )
        description = (
            "Релиз успешно доставлен на r-app.ru."
            if passed else "Нужна проверка деплоя. Успешный выпуск не подтверждён."
        )
    elif workflow == "RateApp daily production health":
        if passed:
            return None  # Keep daily success silent.
        heading = "🚨 <b>Проверка production не прошла</b>"
        description = "Автоматическая проверка доступности обнаружила проблему."
    else:
        return None

    pieces = [heading, "", clean(description)]
    if workflow == "Frontend CI" and source in ("pull_request", "workflow_dispatch"):
        pieces.extend(["", "🧩 <b>Результаты проверок</b>"])
        pieces.extend(details if details else ["Подробности — в GitHub Actions."])
    if branch and workflow == "Frontend CI":
        pieces.append(f"🌿 Ветка: <code>{clean(branch)}</code>")
    elapsed = duration(run)
    if elapsed:
        pieces.append(f"⏱ Длительность: {clean(elapsed)}")
    pieces.extend(["", "🔗 " + fmt_link(url, "Открыть запуск и логи")])
    return "\n".join(pieces)


def send_telegram(message: str, token: str, chat_id: str) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    body = json.dumps({
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "rateapp-github-actions",
    }, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            data = json.load(response)
            if not data.get("ok"):
                raise RuntimeError("Telegram rejected the message")
    except urllib.error.HTTPError as exc:
        # Never log the exception URL: it contains TG_BOT_TOKEN.
        raise RuntimeError(f"Telegram API error: HTTP {exc.code}") from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("Telegram network request failed") from None


def main() -> int:
    try:
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as handle:
            payload = json.load(handle)
    except (KeyError, OSError, ValueError):
        print("Could not load GitHub event data.", file=sys.stderr)
        return 1

    token = os.getenv("TG_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TG_CHAT_ID", "").strip()
    if not token or not chat_id:
        print("Telegram not configured: set repository secret TG_BOT_TOKEN "
              "and repository variable TG_CHAT_ID.", file=sys.stderr)
        return 1

    workflow = payload.get("workflow", {}).get("name", "")
    run = payload.get("workflow_run", {})
    jobs = get_jobs(run, os.getenv("GH_READ_TOKEN", "")) if workflow == "Frontend CI" else []
    message = make_message(payload, jobs)
    if message is None:
        print("No notification required for this event.")
        return 0
    try:
        send_telegram(message, token, chat_id)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("Telegram notification delivered.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
