from ipaddress import ip_address
from urllib.parse import urlsplit

from app.providers.errors import ProviderConfigurationError


def validate(url: str, *, provider: str = "connection") -> str:
    candidate = url.strip().rstrip("/")
    try:
        parsed = urlsplit(candidate)
        # Parsing the port also rejects malformed ports before opening a transport.
        _ = parsed.port
        valid = (
            parsed.scheme in {"http", "https"}
            and bool(parsed.hostname)
            and not any(character.isspace() or ord(character) < 32 for character in candidate)
            and "\\" not in candidate
            and parsed.username is None
            and parsed.password is None
            and "?" not in candidate
            and "#" not in candidate
        )
    except ValueError:
        valid = False
    if not valid:
        raise ProviderConfigurationError(
            provider=provider,
            public_detail="Enter an HTTP(S) base URL without credentials, query parameters, or fragments.",
        )
    return candidate



def is_local_endpoint(url: str | None) -> bool:
    if url is None:
        return False
    host = (urlsplit(validate(url)).hostname or "").rstrip(".").lower()
    try:
        address = ip_address(host)
    except ValueError:
        # Single-label DNS names and these local suffixes need no DNS lookups.
        return "." not in host or host.endswith((".localhost", ".local", ".lan", ".internal"))
    return address.is_loopback or address.is_private or address.is_link_local
