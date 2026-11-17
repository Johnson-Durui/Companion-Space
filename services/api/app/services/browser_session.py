from __future__ import annotations

import hmac
import secrets
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, Response, status

from app.core.config import Settings

OWNER_COOKIE_NAME = "companion_owner_session"
CSRF_COOKIE_NAME = "companion_csrf"
CSRF_HEADER_NAME = "X-CSRF-Token"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
DEFAULT_PORTS = {"http": 80, "https": 443}


def is_allowed_browser_origin(
    origin: str, request_scheme: str, request_host: str | None, request_port: int | None,
    settings: Settings,
) -> bool:
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError:
        return False
    if (
        parsed.scheme not in DEFAULT_PORTS or not parsed.hostname or parsed.username is not None
        or parsed.path or parsed.query or parsed.fragment
    ):
        return False
    if origin.lower() in settings.browser_allowed_origins:
        return True
    return (
        parsed.scheme == request_scheme
        and parsed.hostname == request_host
        and (port or DEFAULT_PORTS[parsed.scheme]) == (request_port or DEFAULT_PORTS.get(request_scheme))
    )


def set_browser_session_cookies(
    response: Response,
    *,
    settings: Settings,
    protected_token: str,
    secure: bool | None = None,
) -> None:
    if secure is None:
        secure = urlsplit(settings.app_base_url).scheme.lower() == "https"
    max_age = settings.owner_session_ttl_hours * 60 * 60
    response.set_cookie(
        OWNER_COOKIE_NAME, protected_token, max_age=max_age, httponly=True,
        secure=secure, samesite="strict", path="/",
    )
    response.set_cookie(
        CSRF_COOKIE_NAME, secrets.token_urlsafe(24), max_age=max_age, httponly=False,
        secure=secure, samesite="strict", path="/",
    )


def clear_browser_session_cookies(response: Response) -> None:
    response.delete_cookie(OWNER_COOKIE_NAME, path="/")
    response.delete_cookie(CSRF_COOKIE_NAME, path="/")


def require_cookie_csrf(request: Request, settings: Settings) -> None:
    if request.method.upper() in SAFE_METHODS:
        return
    csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)
    csrf_header = request.headers.get(CSRF_HEADER_NAME)
    if not csrf_cookie or not csrf_header or not hmac.compare_digest(
        csrf_cookie.encode(), csrf_header.encode()
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid CSRF token")

    origin = request.headers.get("origin")
    try:
        allowed = origin is not None and is_allowed_browser_origin(
            origin, request.url.scheme, request.url.hostname, request.url.port, settings,
        )
    except ValueError:
        allowed = False
    if not allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid request origin")
