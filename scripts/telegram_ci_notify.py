#!/usr/bin/env python3
"""A single formatted Telegram notification per meaningful CI/CD result.

Triggered by workflow_run from trusted main code. No secrets in workflow inputs
or logs; never check out code from the triggering PR or execute its artifacts.
"""
from __future__ import annotations

import html
import io
import json
import os
import re
import sys
import zipfile
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



# Upload-artifact holds the SHA selected by the deploy workflow, not the SHA of
# the trusted main workflow definition. Those SHAs differ for staging.
REVISION_ARTIFACT = "rateapp-deploy-revision"
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def github_json(repo: str, path: str, token: str) -> dict[str, Any]:
    """Read public GitHub metadata. Fail closed on missing/invalid data."""
    if not token or "/" not in repo:
        return {}
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "rateapp-telegram-ci",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            return json.load(response)
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return {}


def deployed_revision(run: dict[str, Any], token: str) -> str | None:
    """Resolve the actual container tag, never infer staging from main's SHA."""
    repo = run.get("repository", {}).get("full_name") or os.getenv("GITHUB_REPOSITORY", "")
    run_id = run.get("id")
    if not isinstance(run_id, int) or not token or "/" not in repo:
        return None
    data = github_json(repo, f"actions/runs/{run_id}/artifacts?per_page=50", token)
    for artifact in data.get("artifacts") or []:
        if artifact.get("name") != REVISION_ARTIFACT or artifact.get("expired"):
            continue
        download = artifact.get("archive_download_url", "")
        if not download.startswith(f"https://api.github.com/repos/{repo}/actions/artifacts/"):
            continue
        req = urllib.request.Request(download, headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "rateapp-telegram-ci",
        })
        try:
            with urllib.request.urlopen(req, timeout=9) as response:
                data_bytes = response.read(131073)
            if len(data_bytes) > 131072:
                return None
            with zipfile.ZipFile(io.BytesIO(data_bytes)) as archive:
                value = archive.read("deployed-sha.txt").decode("ascii").strip()
            return value if SHA_PATTERN.fullmatch(value) else None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError,
                zipfile.BadZipFile, UnicodeError):
            return None
    return None


def previous_deployed_revision(run: dict[str, Any], token: str) -> str | None:
    repo = run.get("repository", {}).get("full_name") or os.getenv("GITHUB_REPOSITORY", "")
    workflow_name = run.get("name")
    workflow_file = (
        "vps-deploy.yml" if workflow_name == "VPS production deployment"
        else "vps-stage.yml" if workflow_name == "VPS staging deployment"
        else None
    )
    if not workflow_file:
        return None
    data = github_json(repo, f"actions/workflows/{workflow_file}/runs?status=success&per_page=12", token)
    for earlier in data.get("workflow_runs") or []:
        if earlier.get("id") == run.get("id"):
            continue
        if str(earlier.get("created_at", "")) >= str(run.get("created_at", "")):
            continue
        revision = deployed_revision(earlier, token)
        if revision:
            return revision
        # Older production runs had no revision artifact. Their source SHA is
        # correct because the production job checks out the tested main head.
        # NEVER make that assumption for staging: its outer run uses main.
        if workflow_name == "VPS production deployment":
            old_sha = earlier.get("head_sha", "")
            if SHA_PATTERN.fullmatch(old_sha):
                return old_sha
    return None


def concise_release_details(repo: str, commit_title: str, token: str) -> list[str]:
    """Use existing PR notes when a release squash summarizes many changes."""
    match = re.search(r"\(#(\d+)\)", commit_title)
    if not match or not commit_title.lower().startswith(("release:", "release ", "релиз")):
        return []
    pr = github_json(repo, f"pulls/{match.group(1)}", token)
    if not pr:
        return []
    body = (pr.get("body") or "").strip()
    # Prefer author-maintained Markdown bullets, if present.
    bullets = [
        re.sub(r"\s+", " ", entry).strip(" -*")
        for entry in re.findall(r"^\s*[-*]\s+(.+)$", body, flags=re.MULTILINE)
    ]
    if bullets:
        return [entry[:120] for entry in bullets[:3]]
    # Free-text release descriptions often enumerate features after a colon.
    features = re.search(r"(?:Включает|Изменения|Состав)[^:]{0,120}:\s*([^\n.]+)", body, flags=re.IGNORECASE)
    if features:
        parts = [part.strip() for part in features.group(1).split(",") if part.strip()]
        return [", ".join(parts[i:i + 2])[:120] for i in range(0, min(len(parts), 6), 2)]
    return []


def deployment_changes(run: dict[str, Any], token: str) -> tuple[str | None, list[str]]:
    """Return a brief *deployed* change list; never claim unknown commits shipped.

    Compare two actually successful deploys. GitHub queries are optional:
    notification delivery must still succeed when metadata is unavailable.
    """
    repo = run.get("repository", {}).get("full_name") or os.getenv("GITHUB_REPOSITORY", "")
    is_prod = run.get("name") == "VPS production deployment"
    head = deployed_revision(run, token)
    if not head and is_prod:
        # Legacy production workflow already pins its tested main SHA.
        head = run.get("head_sha", "")
    if not head or not SHA_PATTERN.fullmatch(head):
        return None, []
    previous = previous_deployed_revision(run, token)
    if previous == head:
        return head, ["Повторная выкладка той же версии: изменений кода нет"]
    subjects: list[str] = []
    if previous and previous != head:
        compared = github_json(repo, f"compare/{previous}...{head}", token)
        if compared.get("status") in ("ahead", "identical"):
            for commit in (compared.get("commits") or [])[-4:]:
                subject = ((commit.get("commit") or {}).get("message") or "").split("\n", 1)[0].strip()
                if subject:
                    subjects.append(subject[:135])
    if not subjects and not previous:
        # First observable deployment: show only its subject, not an invented diff.
        commit = github_json(repo, f"commits/{head}", token)
        subject = ((commit.get("commit") or {}).get("message") or "").split("\n", 1)[0].strip()
        if subject:
            subjects = [subject[:135]]
    subjects.reverse()
    if len(subjects) == 1:
        expanded = concise_release_details(repo, subjects[0], token)
        if expanded:
            subjects = [subjects[0]] + expanded
    return head, subjects[:4]


def job_lines(jobs: list[dict[str, Any]]) -> list[str]:
    names = {
        "build": "Сборка",
        "backend-tests": "Backend",
        "mobile-e2e": "Мобильные E2E",
        "production-smoke": "Production smoke",
        "promote-approved-release": "Слияние одобренного PR в main",
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



def pr_target(run: dict[str, Any]) -> tuple[str, str] | None:
    """Identify the PR target from GitHub metadata, never from the head branch.

    A production release PR is develop -> main, so looking only at
    head_branch misleadingly makes a release verification look like staging.
    """
    for pr in run.get("pull_requests") or []:
        if not isinstance(pr, dict):
            continue
        base = (pr.get("base") or {}).get("ref", "")
        number = pr.get("number")
        if base not in ("main", "develop") or not isinstance(number, int):
            continue
        return base, str(number)
    return None


def make_message(event: dict[str, Any], jobs: list[dict[str, Any]] | None = None,
                 revision: str | None = None, changes: list[str] | None = None) -> str | None:
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
    target = pr_target(run) if source == "pull_request" else None
    # GitHub sometimes drops workflow_run.pull_requests after the release PR
    # has already merged. A successful trusted auto-promotion job identifies
    # the main-bound release unequivocally, unlike head_branch='develop'.
    promotion_succeeded = source == "pull_request" and any(
        job.get("name") == "promote-approved-release"
        and job.get("conclusion") == "success" for job in (jobs or [])
    )
    if workflow == "Frontend CI":
        if source == "push" and branch == "develop":
            if passed:
                return None  # A fast preview is NOT a complete test pass.
            heading = "🧪❌ <b>Staging · подготовка не удалась</b>"
            description = "Быстрая проверка develop завершилась с ошибкой; полный CI не запускался."
        elif source == "push" and branch == "main":
            if passed:
                return None  # The real release verdict comes from VPS deployment.
            heading = "🚀❌ <b>Production · релиз заблокирован</b>"
            description = "Полный CI в main не прошёл; production-деплой не подтверждён."
        elif source == "pull_request" and (target and target[0] == "main" or promotion_succeeded):
            heading = (
                "🚀✅ <b>Production · релизные тесты пройдены</b>" if passed
                else "🚀❌ <b>Production · релизные тесты НЕ пройдены</b>"
            )
            description = (
                (f"PR #{target[1]}: " if target else "Одобренный релизный PR: ")
                + f"{clean(branch)} → main. "
                + ("Тесты прошли и PR автоматически слит. Запускается отдельный main CI; "
                   "production будет обновлён только после его успешного завершения и VPS-деплоя."
                   if passed and promotion_succeeded
                   else "Тесты прошли, но сам production ещё не обновлён." if passed
                   else "Перенос в production заблокирован ошибками проверок.")
            )
        elif source == "pull_request" and target and target[0] == "develop":
            heading = (
                "🧪✅ <b>Staging · PR-проверки пройдены</b>" if passed
                else "🧪❌ <b>Staging · PR-проверки не пройдены</b>"
            )
            description = f"PR #{target[1]}: {clean(branch)} → develop. Это не проверка production."
        elif source == "workflow_dispatch" and branch == "main":
            if passed:
                return None  # Real success is the subsequent VPS deployment.
            heading = "🚨❌ <b>Production · main CI не прошёл</b>"
            description = "Повторная проверка main не прошла. VPS production-деплой заблокирован."
        elif source == "workflow_dispatch":
            heading = (
                "🔬✅ <b>Ручной полный CI пройден</b>" if passed
                else "🔬❌ <b>Ручной полный CI не пройден</b>"
            )
            description = "Проверка ветки по запросу; не означает выкладку на staging или production."
        else:
            heading = (
                "✅ <b>Полный CI пройден</b>" if passed
                else "❌ <b>Полный CI не пройден</b>"
            )
            description = (
                "Проверки PR завершены; цель PR уточняется по ссылке."
                if passed else "Проверки PR не прошли; цель PR уточняется по ссылке."
            )
        details = job_lines(jobs or [])
    elif workflow == "VPS staging deployment":
        heading = (
            "🧪✅ <b>Staging обновлён</b>" if passed
            else "🧪❌ <b>Ошибка staging-деплоя</b>"
        )
        description = (
            "Тестовая версия опубликована на dev.r-app.ru. "
            "Это независимый staging-деплой, production на r-app.ru не обновлялся."
            if passed else "Тестовую версию не удалось полностью развернуть. Production не затронут."
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
    if workflow in ("VPS staging deployment", "VPS production deployment") and passed:
        if revision:
            pieces.append(f"🔖 Версия: <code>{clean(revision[:12])}</code>")
        if changes:
            pieces.extend(["", "📦 <b>Что вошло в обновление</b>"])
            pieces.extend(f"• {clean(change)}" for change in changes[:4])
        else:
            pieces.extend(["", "📦 Список изменений недоступен; см. коммит и журнал GitHub."])
    if workflow == "Frontend CI" and source in ("pull_request", "workflow_dispatch"):
        pieces.extend(["", "🧩 <b>Результаты проверок</b>"])
        pieces.extend(details if details else ["Подробности — в GitHub Actions."])
    if branch and workflow == "Frontend CI":
        pieces.append(f"🌿 Исходная ветка: <code>{clean(branch)}</code>")
        if target:
            destination = "main · production" if target[0] == "main" else "develop · staging"
            pieces.append(f"🎯 Цель PR: <b>{clean(destination)}</b>")
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
    revision, changes = (None, [])
    if workflow in ("VPS staging deployment", "VPS production deployment") and run.get("conclusion") == "success":
        revision, changes = deployment_changes(run, os.getenv("GH_READ_TOKEN", ""))
    message = make_message(payload, jobs, revision=revision, changes=changes)
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
