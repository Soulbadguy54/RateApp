"""Owner-only profile appearance and tiny pre-cropped PNG avatar.

Image bytes are private, never shared through external links or the bootstrap
JSON. The PWA crops on-device; backend validates PNG IHDR dimensions and size.
"""
import base64
import binascii
import struct

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from typing import Literal

from api.security import _current_user, _session, _user_payload

router = APIRouter()
ALLOWED_TINTS = ("default", "violet", "rose", "blue", "teal", "amber")
MAX_AVATAR_BYTES = 240_000


class AppearancePayload(BaseModel):
    tint: Literal["default", "violet", "rose", "blue", "teal", "amber"]
    # Omitted keeps current avatar; null removes it; value replaces it.
    avatarData: str | None = Field(default=None, max_length=350_000)
    updateAvatar: bool = False


def _avatar_bytes(encoded: str) -> bytes:
    try:
        image = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail="Некорректное изображение.") from exc
    if not 80 <= len(image) <= MAX_AVATAR_BYTES:
        raise HTTPException(status_code=422, detail="Аватар слишком большой или пустой.")
    if not image.startswith(b"\x89PNG\r\n\x1a\n") or image[12:16] != b"IHDR":
        raise HTTPException(status_code=422, detail="Нужен PNG-аватар.")
    if len(image) < 33 or image[16:24] != struct.pack(">II", 256, 256):
        raise HTTPException(status_code=422, detail="Аватар должен быть 256 × 256.")
    if image[24] != 8 or image[25] not in (2, 6):
        raise HTTPException(status_code=422, detail="Неверный цветовой формат PNG.")
    return image


@router.post("/api/profile/appearance")
def save_appearance(payload: AppearancePayload, request: Request) -> dict[str, object]:
    if payload.avatarData is not None and not payload.updateAvatar:
        raise HTTPException(status_code=422, detail="Неожиданное изображение.")
    avatar = _avatar_bytes(payload.avatarData) if payload.updateAvatar and payload.avatarData else None
    with _session() as session:
        user = _current_user(request, session)
        user.profile_tint = payload.tint
        if payload.updateAvatar:
            user.avatar_data = avatar
            user.avatar_version += 1
        session.commit()
        session.refresh(user)
        return _user_payload(user)


@router.get("/api/profile/avatar")
def read_avatar(request: Request) -> Response:
    with _session() as session:
        user = _current_user(request, session)
        if user.avatar_data is None:
            raise HTTPException(status_code=404, detail="Аватар не задан.")
        image = user.avatar_data
    return Response(image, media_type="image/png",
                    headers={"Cache-Control": "private, max-age=3600",
                             "X-Content-Type-Options": "nosniff"})
