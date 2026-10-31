"""Small fail-closed external URL reader for saved-link ChatGPT jobs.

Only a deliberately claimed URL is read here. No browser, JS, cookies, proxy,
file downloads, or arbitrary tool calls; Safe Browsing lookup precedes every hop.
"""
import html
import json
import ipaddress
import re
import os
import socket
import ssl
import subprocess
import time
from html.parser import HTMLParser
from http.client import HTTPConnection, HTTPSConnection, HTTPException
from urllib.parse import parse_qs, quote, urljoin, urlsplit

import httpx

from api.saved_links_routes import canonical_url

MAX_RESPONSE_BYTES = 1_000_000
MAX_TEXT_CHARS = 60_000
MAX_REDIRECTS = 3
MAX_SECONDS = 15
MAX_HOST_LOOKUP_SECONDS = 5
SAFE_BROWSING_ENDPOINT = "https://safebrowsing.googleapis.com/v5/urls:search"
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


def safe_browsing_key() -> str:
    """Accept the legacy staging secret name until it is rotated."""
    return (os.environ.get("SAFE_BROWSING_API_KEY", "").strip()
            or os.environ.get("WEB_RISK_API_KEY", "").strip())


def _proto_fields(payload: bytes):
    """Decode bounded protobuf fields, rejecting truncated or invalid wire data."""
    if not payload or len(payload) > 32_768:
        raise ValueError("Invalid Safe Browsing response size")

    def varint(offset):
        number = 0
        for i in range(10):
            if offset >= len(payload):
                raise ValueError("Truncated protobuf varint")
            octet = payload[offset]
            offset += 1
            if i == 9 and octet > 1:
                raise ValueError("Oversized protobuf varint")
            number |= (octet & 127) << (7 * i)
            if not octet & 128:
                return number, offset
        raise ValueError("Unterminated protobuf varint")

    cursor = 0
    while cursor < len(payload):
        tag, cursor = varint(cursor)
        field, wire = tag >> 3, tag & 7
        if not field:
            raise ValueError("Invalid protobuf field number")
        if wire == 0:
            value, cursor = varint(cursor)
        elif wire == 2:
            length, cursor = varint(cursor)
            if length > len(payload) - cursor:
                raise ValueError("Truncated protobuf field")
            value = payload[cursor:cursor + length]
            cursor += length
        elif wire in (1, 5):
            length = 8 if wire == 1 else 4
            if length > len(payload) - cursor:
                raise ValueError("Truncated protobuf fixed-width field")
            value = payload[cursor:cursor + length]
            cursor += length
        else:
            raise ValueError("Unsupported protobuf wire type")
        yield field, wire, value


def _safe_browsing_v5_has_threats(payload: bytes) -> bool:
    """Read SearchUrlsResponse: threats=1, cache_duration=2 (Duration).

    Google Safe Browsing v5 REST sends protobuf even for HTTP 200.
    A clean response still includes cache_duration; absent, malformed and
    incorrectly framed responses must never authorize a download.
    """
    found_duration = False
    found_threat = False
    for field, wire, value in _proto_fields(payload):
        if field == 1:
            if wire != 2 or not value:
                raise ValueError("Malformed Safe Browsing threat")
            nested = list(_proto_fields(value))
            if not any(tag == 1 and kind == 2 and url for tag, kind, url in nested):
                raise ValueError("Malformed Safe Browsing threat URL")
            found_threat = True
        elif field == 2:
            if wire != 2 or found_duration:
                raise ValueError("Malformed Safe Browsing cache duration")
            duration_fields = list(_proto_fields(value))
            if not any(tag == 1 and kind == 0 for tag, kind, _ in duration_fields):
                raise ValueError("Missing Safe Browsing duration seconds")
            if any(tag not in (1, 2) or kind != 0 for tag, kind, _ in duration_fields):
                raise ValueError("Malformed Safe Browsing duration data")
            found_duration = True
    if not found_duration:
        raise ValueError("Missing Safe Browsing cache duration")
    return found_threat


def check_safe_browsing(url: str, *, timeout: float = 5.0) -> None:
    """Require a valid Google Safe Browsing v5 protobuf lookup before HTTP."""
    api_key = safe_browsing_key()
    if not api_key:
        raise SourceSafetyError("Safe Browsing не настроен: чтение ссылок отключено.")
    try:
        with httpx.Client(timeout=min(timeout, 5.0), follow_redirects=False, trust_env=False) as client:
            response = client.get(SAFE_BROWSING_ENDPOINT, params=[
                ("urls", url), ("key", api_key),
            ])
            response.raise_for_status()
            if response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/x-protobuf":
                raise ValueError("Unexpected Safe Browsing response format")
            threats = _safe_browsing_v5_has_threats(response.content)
    except (httpx.HTTPError, ValueError) as exc:
        raise SourceSafetyError("Проверка безопасности Safe Browsing временно недоступна.") from exc
    if threats:
        raise SourceSafetyError(
            "Ссылка отмечена Google Safe Browsing как потенциально опасная "
            "(проверка может быть неточной).", terminal=True,
        )


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


def _fetch_once(url: str, deadline: float, *,
                accepted_types: tuple[str, ...] = ACCEPTED_TYPES,
                max_bytes: int = MAX_RESPONSE_BYTES) -> tuple[int, dict[str, str], bytes]:
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
            "Accept": ", ".join(accepted_types),
            "Accept-Encoding": "identity",
            "Connection": "close",
        })
        response = connection.getresponse()
        headers = {key.lower(): value for key, value in response.getheaders()}
        if int(headers.get("content-length", "0")) > max_bytes:
            raise SourceSafetyError("Размер страницы превышает лимит.", terminal=True)
        if response.status in (301, 302, 303, 307, 308):
            return response.status, headers, b""
        if response.status != 200:
            raise SourceSafetyError("Сайт не предоставил доступный материал.")
        content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in accepted_types:
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
            chunk = response.read(min(16_384, max_bytes + 1 - byte_count))
            if not chunk:
                break
            byte_count += len(chunk)
            if byte_count > max_bytes:
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


class _PagePreview(HTMLParser):
    """Universal Open Graph, Twitter, title and JSON-LD metadata extractor.

    Parse bounded inert text only: no JavaScript, HTML rendering or image fetch.
    The selected image address stays server-side and is never sent to clients.
    """
    STRUCTURED_TYPES = {"videoobject", "article", "newsarticle",
                        "blogposting", "socialmediaposting", "review"}
    MAX_JSONLD_CHARS = 32_768

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_title = False
        self.in_jsonld = False
        self.title_parts: list[str] = []
        self.jsonld_parts: list[str] = []
        self.jsonld_characters = 0
        self.fields: dict[str, str] = {}
        self.structured: dict[str, str] = {}
        self.video_marker = False

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "title":
            self.in_title = True
        elif tag == "script" and str(attributes.get("type") or "").split(";", 1)[0].strip().lower() == "application/ld+json":
            self.in_jsonld = True
            self.jsonld_parts = []
            self.jsonld_characters = 0
        elif tag == "meta":
            name = str(attributes.get("property") or attributes.get("name") or "").strip().lower()
            if name in ("og:title", "twitter:title", "og:description",
                        "twitter:description", "description", "og:image:secure_url",
                        "og:image", "twitter:image", "og:type", "twitter:card"):
                value = " ".join(str(attributes.get("content") or "").split())
                if value and name not in self.fields:
                    self.fields[name] = value[:2048]
            if name in ("og:video", "og:video:url", "og:video:secure_url"):
                self.video_marker = True
        elif tag == "link":
            rel = str(attributes.get("rel") or "").strip().lower()
            if rel == "image_src" and "image_src" not in self.fields:
                self.fields["image_src"] = str(attributes.get("href") or "")[:2048]

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        elif tag == "script" and self.in_jsonld:
            self.in_jsonld = False
            try:
                if self.jsonld_characters <= self.MAX_JSONLD_CHARS:
                    self._read_jsonld(json.loads("".join(self.jsonld_parts)))
            except (ValueError, TypeError, RecursionError):
                pass
            self.jsonld_parts = []
            self.jsonld_characters = 0

    def handle_data(self, data):
        if self.in_title and sum(map(len, self.title_parts)) < 200:
            self.title_parts.append(data[:200])
        if self.in_jsonld:
            self.jsonld_characters += len(data)
            if self.jsonld_characters <= self.MAX_JSONLD_CHARS:
                self.jsonld_parts.append(data)

    def _read_jsonld(self, value):
        # A JSON-LD @graph often lists site, profile, then actual article.
        # Only content-specific types qualify; Organization/Person/WebSite do not.
        if isinstance(value, list):
            for item in value[:20]:
                self._read_jsonld(item)
        elif isinstance(value, dict):
            types = value.get("@type", ())
            if isinstance(types, str):
                types = [types]
            if isinstance(types, list) and any(
                str(item).rsplit("/", 1)[-1].lower() in self.STRUCTURED_TYPES
                for item in types[:8]
            ):
                for key, candidates in (
                    ("title", (value.get("headline"), value.get("name"))),
                    ("description", (value.get("description"),)),
                    ("image", (value.get("thumbnailUrl"), value.get("image"))),
                ):
                    if key not in self.structured:
                        for candidate in candidates:
                            if isinstance(candidate, list):
                                candidate = candidate[0] if candidate else None
                            if isinstance(candidate, dict):
                                candidate = candidate.get("url") or candidate.get("contentUrl")
                            if isinstance(candidate, str) and candidate.strip():
                                self.structured[key] = candidate.strip()[:2048]
                                break
            for key in ("@graph", "mainEntity"):
                if key in value:
                    self._read_jsonld(value[key])

    def result(self):
        def clean(value, limit):
            return html.unescape(" ".join(str(value or "").split()))[:limit]

        title = clean(
            self.structured.get("title") or self.fields.get("og:title")
            or self.fields.get("twitter:title") or "".join(self.title_parts),
            180,
        )
        description = clean(
            self.structured.get("description") or self.fields.get("og:description")
            or self.fields.get("twitter:description") or self.fields.get("description"),
            200,
        )
        # General social-media fallback: when no content-specific title exists,
        # a quoted caption after a colon can be more useful than the user profile.
        if not self.structured.get("title") and description and (
            self.video_marker or "video" in self.fields.get("og:type", "").lower()
            or "player" in self.fields.get("twitter:card", "").lower()
        ):
            caption = re.search(r':\s*["“«](.{8,180}?)["”»]', description)
            if caption and ("@" in title or not title or bool(re.search(r"\\bon [A-Za-z ]{3,30}$", title, re.I))):
                title = caption.group(1).strip()
        image_url = (
            self.structured.get("image") or self.fields.get("og:image:secure_url")
            or self.fields.get("og:image") or self.fields.get("twitter:image")
            or self.fields.get("image_src") or ""
        )
        return {"title": title, "description": description, "image_url": image_url}


def _parse_page_preview(body: bytes, headers: dict[str, str]) -> dict[str, str]:
    content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in ("text/html", "application/xhtml+xml"):
        return {"title": "", "description": "", "image_url": ""}
    charset = "utf-8"
    if "charset=" in headers.get("content-type", "").lower():
        candidate = headers["content-type"].lower().split("charset=", 1)[1].split(";", 1)[0].strip(' "\'')
        if candidate in ("utf-8", "windows-1251", "iso-8859-1"):
            charset = candidate
    parser = _PagePreview()
    parser.feed(body.decode(charset, errors="replace")[:MAX_RESPONSE_BYTES])
    return parser.result()


_YOUTUBE_ID_PATTERN = re.compile(r"[a-zA-Z0-9_-]{11}\Z")


def _youtube_video_id(url: str) -> str | None:
    """Recognize only official YouTube URL shapes; never fetch query hosts."""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower().rstrip(".")
        if parts.scheme not in ("http", "https") or parts.username or parts.password:
            return None
        segments = [part for part in parts.path.split("/") if part]
        if host in ("youtu.be", "www.youtu.be"):
            candidate = segments[0] if len(segments) == 1 else ""
        elif host in ("youtube.com", "www.youtube.com", "m.youtube.com",
                      "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"):
            if parts.path == "/watch":
                candidate = parse_qs(parts.query).get("v", [""])[0]
            elif len(segments) == 2 and segments[0] in ("shorts", "live", "embed"):
                candidate = segments[1]
            else:
                candidate = ""
        else:
            return None
        return candidate if _YOUTUBE_ID_PATTERN.fullmatch(candidate) else None
    except ValueError:
        return None


def preview_source(url: str) -> dict[str, str]:
    """Safe HTML preview, with explicitly labelled fallback on YouTube DNS loss."""
    try:
        body, headers = _safe_page_response(url)
    except SourceSafetyError as exc:
        # YouTube and youtu.be occasionally fail DNS from the VPS. A generic
        # label is better than an empty title, but never claim video metadata
        # was retrieved, nor bypass Safe Browsing to produce the fallback.
        if exc.terminal or _youtube_video_id(url) is None:
            raise
        check_safe_browsing(canonical_url(url))
        return {"title": "Видео YouTube", "description": ""}
    metadata = _parse_page_preview(body, headers)
    return {"title": metadata["title"], "description": metadata["description"]}


def _verified_thumbnail(media_url: str) -> tuple[bytes, str] | None:
    mime_types = ("image/jpeg", "image/png", "image/webp")
    image, image_headers = _safe_page_response(
        media_url, accepted_types=mime_types, max_bytes=512_000, require_https=True,
    )
    mime = image_headers.get("content-type", "").split(";", 1)[0].strip().lower()
    valid = (
        mime == "image/jpeg" and image.startswith(b"\xff\xd8\xff")
        or mime == "image/png" and image.startswith(b"\x89PNG\r\n\x1a\n")
        or mime == "image/webp" and image.startswith(b"RIFF") and image[8:12] == b"WEBP"
    )
    if not valid or len(image) < 20:
        return None
    return image, mime


def _youtube_thumbnail(video_id: str) -> tuple[bytes, str] | None:
    # Video ID is strictly validated, the CDN hostname is fixed and HTTPS,
    # and the normal pinned-public-IP / Safe Browsing checks remain enabled.
    return _verified_thumbnail(f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")


def preview_thumbnail_source(url: str) -> tuple[bytes, str] | None:
    """Verified article OG image, or safe YouTube CDN image if page DNS fails."""
    video_id = _youtube_video_id(url)
    try:
        body, headers = _safe_page_response(url)
    except SourceSafetyError as exc:
        if exc.terminal or video_id is None:
            raise
        check_safe_browsing(canonical_url(url))
        return _youtube_thumbnail(video_id)

    metadata = _parse_page_preview(body, headers)
    if metadata["image_url"]:
        try:
            media_url = canonical_url(urljoin(headers.get("__verified_final_url", url), metadata["image_url"]))
        except ValueError:
            media_url = ""
        if media_url and urlsplit(media_url).scheme == "https":
            try:
                image = _verified_thumbnail(media_url)
            except SourceSafetyError:
                if not video_id:
                    raise
            else:
                if image is not None:
                    return image

    return _youtube_thumbnail(video_id) if video_id else None


def _safe_page_response(url: str, *,
                        accepted_types: tuple[str, ...] = ACCEPTED_TYPES,
                        max_bytes: int = MAX_RESPONSE_BYTES,
                        require_https: bool = False) -> tuple[bytes, dict[str, str]]:
    """Shared fail-closed reputation and pinned fetch for preview, images and GPT."""

    try:
        current = canonical_url(url)
    except ValueError as exc:
        raise SourceSafetyError("Недопустимый URL.", terminal=True) from exc
    if require_https and not current.startswith("https://"):
        raise SourceSafetyError("Для изображения необходим HTTPS.", terminal=True)
    seen: set[str] = set()
    deadline = time.monotonic() + MAX_SECONDS
    for hop in range(MAX_REDIRECTS + 1):
        if current in seen:
            raise SourceSafetyError("Циклический редирект.", terminal=True)
        seen.add(current)
        if deadline - time.monotonic() <= 0:
            raise SourceSafetyError("Истекло время чтения ссылки.")
        check_safe_browsing(current, timeout=min(5.0, deadline - time.monotonic()))
        status, headers, body = _fetch_once(
            current, deadline, accepted_types=accepted_types, max_bytes=max_bytes,
        )
        if status == 200:
            headers["__verified_final_url"] = current
            return body, headers
        if hop == MAX_REDIRECTS:
            raise SourceSafetyError("Слишком много перенаправлений.", terminal=True)
        destination = headers.get("location")
        if not destination:
            raise SourceSafetyError("Редирект без адреса.", terminal=True)
        try:
            next_url = canonical_url(urljoin(current, destination))
        except ValueError as exc:
            raise SourceSafetyError("Опасный адрес перенаправления.", terminal=True) from exc
        if (require_https or current.startswith("https://")) and not next_url.startswith("https://"):
            raise SourceSafetyError("HTTPS не может перенаправлять на HTTP.", terminal=True)
        current = next_url
    raise SourceSafetyError("Ссылка не может быть обработана.")


def prepare_source(url: str) -> dict[str, str | int]:
    """Reputation-check each redirect hop before opening a pinned connection."""
    body, headers = _safe_page_response(url)
    text = _read_text(body, headers)
    return {"text": text, "characters": len(text),
            "contentType": headers["content-type"].split(";", 1)[0]}

