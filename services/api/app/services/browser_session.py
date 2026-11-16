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


def set_browser_session_cookies(
    response: Response,
    *,
    settings: Settings,
    protected_token: str,
) -> None:
    secure = urlsplit(settings.app_base_url).scheme.lower() == "https"
    max_age = settings.owner_session_ttl_hours * 60 * 60
    response.set_cookie(
        OWNER_COOKIE_NAME,
        protected_token,
        max_age=max_age,
        httponly=True,
        secure=secure,
        samesite="strict",
        path="/api/v1",
    )
    response.set_cookie(
        CSRF_COOKIE_NAME,
        secrets.token_urlsafe(24),
        max_age=max_age,
        httponly=False,
        secure=secure,
        samesite="strict",
        path="/",
    )


def clear_browser_session_cookies(response: Response) -> None:
    response.delete_cookie(OWNER_COOKIE_NAME, path="/api/v1")
    response.delete_cookie(CSRF_COOKIE_NAME, path="/")


def require_cookie_csrf(request: Request, settings: Settings) -> None:
    if request.method.upper() in SAFE_METHODS:
        return

    csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)
    csrf_header = request.headers.get(CSRF_HEADER_NAME)
    if not csrf_cookie or not csrf_header or not hmac.compare_digest(
        csrf_cookie, csrf_header
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid CSRF token",
        )

    origin = request.headers.get("origin")
    if not origin or origin.lower() not in settings.browser_allowed_origins:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid request origin",
        )
