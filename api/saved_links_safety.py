"""Small fail-closed external URL reader for saved-link ChatGPT jobs.

Only a deliberately claimed URL is read here. No browser, JS, cookies, proxy,
file downloads, or arbitrary tool calls; Web Risk lookup precedes every hop.
"""
import html
import ipaddress
import os
import socket
import ssl
import subprocess
import time
from html.parser import HTMLParser
from http.client import HTTPConnection, HTTPSConnection, HTTPException
from urllib.parse import quote, urljoin, urlsplit

import httpx

from api.saved_links_routes import canonical_url

MAX_RESPONSE_BYTES = 1_000_000
MAX_TEXT_CHARS = 60_000
MAX_REDIRECTS = 3
MAX_SECONDS = 15
MAX_HOST_LOOKUP_SECONDS = 5
WEB_RISK_ENDPOINT = "https://webrisk.googleapis.com/v1/uris:search"
THREAT_TYPES = ("MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE")
ACCEPTED_TYPES = ("text/html", "application/xhtml+xml", "text/plain")
BLOCKED_TAGS = {"script", "style", "noscript", "iframe", "object", "embed",
                "svg", "form", "nav", "aside", "footer", "header", "template"}
VOID_ELEMENTS = {"area", "base", "br", "col", "embed", "hr", "img", "input",
                 "link", "meta", "param", "source", "track", "wbr"}
BLOCKED_HINTS = ("sidebar", "advert", "promo", "related", "recommend",
                 "cookie", "newsletter", "sponsor", "widget", "share-",
                 "navigation")


class SourceSafetyError(ValueError):
    """Unsafe or inaccessible source. Do not expose URLs/keys to GPT or logs."""

    def __init__(self, message: str, *, terminal: bool = False):
        super().__init__(message)
        self.terminal = terminal


def check_web_risk(url: str, *, timeout: float = 5.0) -> None:
    """Lookup API, one URL per request. Missing key/errors = no access."""
    api_key = os.environ.get("WEB_RISK_API_KEY", "").strip()
    if not api_key:
        raise SourceSafetyError("Web Risk не настроен: чтение ссылок отключено.")
    params = [("uri", url), ("key", api_key)]
    params += [("threatTypes", threat) for threat in THREAT_TYPES]
    try:
        with httpx.Client(timeout=min(timeout, 5.0), follow_redirects=False, trust_env=False) as client:
            response = client.get(WEB_RISK_ENDPOINT, params=params)
            response.raise_for_status()
            result = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise SourceSafetyError("Проверка безопасности ссылки временно недоступна.") from exc
    if not isinstance(result, dict):
        raise SourceSafetyError("Некорректный ответ Web Risk.")
    threat = result.get("threat")
    if threat:
        raise SourceSafetyError("Ссылка отмечена как опасная Google Web Risk.", terminal=True)


def _public_address(host: str, port: int) -> str:
    """Bounded system DNS lookup, then pin one validated public IP.

    getent ahosts uses the container's normal resolver, but runs in a short
    subprocess so a stalled DNS server cannot hang the worker indefinitely.
    Connection never resolves the hostname again after this verification.
    """
    del port  # HTTP transport already restricts this to 80/443.
    try:
        lookup = subprocess.run(
            ["getent", "ahosts", host],
            capture_output=True, text=True, timeout=MAX_HOST_LOOKUP_SECONDS,
            check=True,
        )
        if len(lookup.stdout) > 65_536:
            raise SourceSafetyError("Слишком большой DNS-ответ.", terminal=True)
        addresses = {line.split()[0] for line in lookup.stdout.splitlines() if line.split()}
        if not addresses or any(not ipaddress.ip_address(value).is_global
                                for value in addresses):
            raise SourceSafetyError("Недопустимый сетевой адрес ссылки.", terminal=True)
        return sorted(addresses)[0]
    except SourceSafetyError:
        raise
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError,
            FileNotFoundError, ValueError, OSError) as exc:
        raise SourceSafetyError("Не удалось безопасно проверить адрес ссылки.") from exc


class _PinnedHTTPS(HTTPSConnection):
    def __init__(self, host: str, address: str, port: int, timeout: float):
        super().__init__(host, port=port, timeout=timeout, context=ssl.create_default_context())
        self._pinned_address = address

    def connect(self):
        sock = socket.create_connection((self._pinned_address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _PinnedHTTP(HTTPConnection):
    def __init__(self, host: str, address: str, port: int, timeout: float):
        super().__init__(host, port=port, timeout=timeout)
        self._pinned_address = address

    def connect(self):
        self.sock = socket.create_connection((self._pinned_address, self.port), self.timeout)


def _fetch_once(url: str, deadline: float) -> tuple[int, dict[str, str], bytes]:
    parts = urlsplit(url)
    port = 443 if parts.scheme == "https" else 80
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SourceSafetyError("Истекло время чтения ссылки.")
    address = _public_address(parts.hostname, port)
    connection_class = _PinnedHTTPS if parts.scheme == "https" else _PinnedHTTP
    connection = connection_class(parts.hostname, address, port, min(remaining, 5.0))
    # Exact pinned public address is used; TLS certificate/SNI and Host stay
    # the original hostname. HTTP(S)_Connection never consults proxy env.
    path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
    if parts.query:
        path += "?" + quote(parts.query, safe="/?%:@!$&'()*+,;=-._~")
    try:
        connection.request("GET", path, headers={
            "Host": parts.netloc,
            "User-Agent": "RateAPP-SavedLinks/1.0",
            "Accept": "text/html, application/xhtml+xml, text/plain",
            "Accept-Encoding": "identity",
            "Connection": "close",
        })
        response = connection.getresponse()
        headers = {key.lower(): value for key, value in response.getheaders()}
        if int(headers.get("content-length", "0")) > MAX_RESPONSE_BYTES:
            raise SourceSafetyError("Размер страницы превышает лимит.", terminal=True)
        if response.status in (301, 302, 303, 307, 308):
            return response.status, headers, b""
        if response.status != 200:
            raise SourceSafetyError("Сайт не предоставил доступный материал.")
        content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in ACCEPTED_TYPES:
            raise SourceSafetyError("Неподдерживаемый тип содержимого.", terminal=True)
        if headers.get("content-encoding", "identity").lower() != "identity":
            raise SourceSafetyError("Сжатое содержимое не поддерживается.", terminal=True)
        chunks = []
        byte_count = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SourceSafetyError("Истекло время чтения ссылки.")
            if connection.sock is not None:
                connection.sock.settimeout(min(remaining, 3.0))
            chunk = response.read(min(16_384, MAX_RESPONSE_BYTES + 1 - byte_count))
            if not chunk:
                break
            byte_count += len(chunk)
            if byte_count > MAX_RESPONSE_BYTES:
                raise SourceSafetyError("Размер страницы превышает лимит.", terminal=True)
            chunks.append(chunk)
        return response.status, headers, b"".join(chunks)
    except SourceSafetyError:
        raise
    except (OSError, HTTPException, ssl.SSLError, TimeoutError, ValueError) as exc:
        raise SourceSafetyError("Не удалось безопасно загрузить содержимое.") from exc
    finally:
        connection.close()


class _ArticleText(HTMLParser):
    """Text only: strip scripts, ads, navigation and hidden DOM nodes."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool, bool]] = []
        self.parts: list[str] = []
        self.article_parts: list[str] = []
        self.used_chars = 0

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        hint = " ".join(str(attributes.get(key, "")) for key in ("id", "class", "role")).lower()
        style = str(attributes.get("style", "")).replace(" ", "").lower()
        hidden = (tag in BLOCKED_TAGS or "hidden" in attributes
                  or attributes.get("aria-hidden") == "true"
                  or "display:none" in style or "visibility:hidden" in style
                  or any(item in hint for item in BLOCKED_HINTS))
        parent_blocked = self.stack[-1][1] if self.stack else False
        is_article = (tag in ("main", "article") or
                      any(x in hint for x in ("article-body", "post-content", "entry-content")))
        parent_article = self.stack[-1][2] if self.stack else False
        if tag not in VOID_ELEMENTS:
            self.stack.append((tag, hidden or parent_blocked, is_article or parent_article))

    def handle_startendtag(self, tag, attrs):
        # Self-closing tags never change ancestor visibility/article context.
        return

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if self.stack and self.stack[-1][1]:
            return
        content = " ".join(data.split())
        if content and self.used_chars < MAX_TEXT_CHARS * 2:
            content = content[:MAX_TEXT_CHARS * 2 - self.used_chars]
            self.parts.append(content)
            if self.stack and self.stack[-1][2]:
                self.article_parts.append(content)
            self.used_chars += len(content)


def _read_text(body: bytes, headers: dict[str, str]) -> str:
    content_type = headers.get("content-type", "").split(";", 1)[0].lower()
    charset = "utf-8"
    if "charset=" in headers.get("content-type", "").lower():
        candidate = headers["content-type"].lower().split("charset=", 1)[1].split(";", 1)[0].strip(' "\'')
        if candidate in ("utf-8", "windows-1251", "iso-8859-1"):
            charset = candidate
    decoded = body.decode(charset, errors="replace")
    if content_type == "text/plain":
        text = " ".join(decoded.split())
    else:
        parser = _ArticleText()
        parser.feed(decoded)
        text = " ".join(parser.article_parts or parser.parts)
    if not text:
        raise SourceSafetyError("В материале отсутствует доступный текст.")
    return html.unescape(text[:MAX_TEXT_CHARS])


def prepare_source(url: str) -> dict[str, str | int]:
    """Reputation-check each redirect hop before opening a pinned connection."""
    try:
        current = canonical_url(url)
    except ValueError as exc:
        raise SourceSafetyError("Недопустимый URL.", terminal=True) from exc
    seen: set[str] = set()
    deadline = time.monotonic() + MAX_SECONDS
    for hop in range(MAX_REDIRECTS + 1):
        if current in seen:
            raise SourceSafetyError("Циклический редирект.", terminal=True)
        seen.add(current)
        if deadline - time.monotonic() <= 0:
            raise SourceSafetyError("Истекло время чтения ссылки.")
        check_web_risk(current, timeout=min(5.0, deadline - time.monotonic()))
        status, headers, body = _fetch_once(current, deadline)
        if status == 200:
            text = _read_text(body, headers)
            return {"text": text, "characters": len(text), "contentType": headers["content-type"].split(";",1)[0]}
        if hop == MAX_REDIRECTS:
            raise SourceSafetyError("Слишком много перенаправлений.", terminal=True)
        destination = headers.get("location")
        if not destination:
            raise SourceSafetyError("Редирект без адреса.", terminal=True)
        try:
            next_url = canonical_url(urljoin(current, destination))
        except ValueError as exc:
            raise SourceSafetyError("Опасный адрес перенаправления.", terminal=True) from exc
        if current.startswith("https://") and not next_url.startswith("https://"):
            raise SourceSafetyError("HTTPS не может перенаправлять на HTTP.", terminal=True)
        current = next_url
    raise SourceSafetyError("Ссылка не может быть обработана.")
