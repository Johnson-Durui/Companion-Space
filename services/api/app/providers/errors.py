from __future__ import annotations


class ProviderError(RuntimeError):
    def __init__(
        self,
        *,
        provider: str,
        public_detail: str,
        upstream_status: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        self.provider = provider
        self.public_detail = public_detail
        self.upstream_status = upstream_status
        self.retry_after = retry_after
        super().__init__(f"{provider}: {public_detail}")


class ProviderAuthenticationError(ProviderError):
    pass


class ProviderRateLimitError(ProviderError):
    pass


class ProviderTimeoutError(ProviderError):
    pass


class ProviderUnavailableError(ProviderError):
    pass


class ProviderProtocolError(ProviderError):
    pass


class ProviderConfigurationError(ProviderError):
    pass


def provider_error_code(error: ProviderError) -> str:
    if isinstance(error, ProviderAuthenticationError):
        return "provider_authentication_failed"
    if isinstance(error, ProviderRateLimitError):
        return "provider_rate_limited"
    if isinstance(error, ProviderTimeoutError):
        return "provider_timeout"
    if isinstance(error, ProviderUnavailableError):
        return "provider_unavailable"
    if isinstance(error, ProviderProtocolError):
        return "provider_protocol_error"
    if isinstance(error, ProviderConfigurationError):
        return "provider_configuration_error"
    return "provider_error"


def provider_error_status(error: ProviderError) -> int:
    if isinstance(error, ProviderAuthenticationError):
        return 424
    if isinstance(error, ProviderRateLimitError):
        return 429
    if isinstance(error, ProviderTimeoutError):
        return 504
    if isinstance(error, ProviderUnavailableError):
        return 503
    if isinstance(error, ProviderProtocolError):
        return 502
    if isinstance(error, ProviderConfigurationError):
        return 424
    return 502


def provider_error_payload(error: ProviderError) -> dict[str, object]:
    payload: dict[str, object] = {
        "detail": f"{error.provider}: {error.public_detail}",
        "code": provider_error_code(error),
        "provider": error.provider,
    }
    if error.upstream_status is not None:
        payload["upstream_status"] = error.upstream_status
    if error.retry_after is not None:
        payload["retry_after"] = error.retry_after
    return payload
