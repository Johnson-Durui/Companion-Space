from __future__ import annotations

import asyncio
from collections import deque
import socket
import threading
from time import monotonic
from typing import Any

import httpcore
import httpx
import pytest

from app.providers import pinned_http
from app.providers.errors import (
    ProviderConfigurationError,
    ProviderUnavailableError,
)
from app.providers.pinned_http import (
    PinnedAsyncHTTPTransport,
    ResolvedProviderBaseUrl,
    build_pinned_http_transport,
    resolve_provider_base_url,
)


class _RecordingStream(httpcore.AsyncNetworkStream):
    def __init__(self) -> None:
        self._reads = deque(
            [
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Length: 2\r\n"
                b"Connection: close\r\n\r\nOK"
            ]
        )
        self.writes = bytearray()
        self.server_names: list[str | None] = []
        self.close_count = 0

    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        _ = max_bytes, timeout
        return self._reads.popleft() if self._reads else b""

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        _ = timeout
        self.writes.extend(buffer)

    async def aclose(self) -> None:
        self.close_count += 1

    async def start_tls(
        self,
        ssl_context: Any,
        server_hostname: str | None = None,
        timeout: float | None = None,
    ) -> httpcore.AsyncNetworkStream:
        _ = ssl_context, timeout
        self.server_names.append(server_hostname)
        return self

    def get_extra_info(self, info: str) -> Any:
        _ = info
        return None


class _RecordingBackend(httpcore.AsyncNetworkBackend):
    def __init__(
        self,
        plan: dict[str, _RecordingStream | BaseException],
    ) -> None:
        self._plan = plan
        self.attempts: list[tuple[str, int]] = []
        self.timeouts: list[float | None] = []

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        _ = local_address, socket_options
        normalized_host = host.decode("ascii") if isinstance(host, bytes) else host
        self.attempts.append((normalized_host, port))
        self.timeouts.append(timeout)
        result = self._plan[normalized_host]
        if isinstance(result, BaseException):
            raise result
        return result

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        _ = path, timeout, socket_options
        raise AssertionError("Pinned provider transport must not use a Unix socket")

    async def sleep(self, seconds: float) -> None:
        _ = seconds


class _BlackHoleFirstBackend(_RecordingBackend):
    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        normalized_host = host.decode("ascii") if isinstance(host, bytes) else host
        self.attempts.append((normalized_host, port))
        self.timeouts.append(timeout)
        if normalized_host == "8.8.8.8":
            await asyncio.Event().wait()
            raise AssertionError("The black-holed address must be cancelled")
        result = self._plan[normalized_host]
        if isinstance(result, BaseException):
            raise result
        return result


class _SimultaneousSuccessBackend(_RecordingBackend):
    def __init__(self, plan: dict[str, _RecordingStream]) -> None:
        super().__init__(plan)
        self._all_started = asyncio.Event()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        _ = local_address, socket_options
        normalized_host = host.decode("ascii") if isinstance(host, bytes) else host
        self.attempts.append((normalized_host, port))
        self.timeouts.append(timeout)
        if len(self.attempts) == len(self._plan):
            self._all_started.set()
        await self._all_started.wait()
        result = self._plan[normalized_host]
        assert not isinstance(result, BaseException)
        return result


class _TrailingSuccessBackend(_RecordingBackend):
    def __init__(self, successful_host: str, stream: _RecordingStream) -> None:
        super().__init__({successful_host: stream})
        self._successful_host = successful_host
        self.started_at: list[float] = []

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        _ = local_address, socket_options
        normalized_host = host.decode("ascii") if isinstance(host, bytes) else host
        self.attempts.append((normalized_host, port))
        self.timeouts.append(timeout)
        self.started_at.append(monotonic())
        if normalized_host != self._successful_host:
            await asyncio.Event().wait()
            raise AssertionError("Black-holed attempts must be cancelled")
        result = self._plan[normalized_host]
        assert not isinstance(result, BaseException)
        return result


def _resolved(
    base_url: str,
    *addresses: str,
    provider: str = "openai-compatible",
) -> ResolvedProviderBaseUrl:
    return resolve_provider_base_url(
        base_url,
        provider=provider,
        resolver=lambda hostname: addresses,
    )


def test_https_request_pins_tcp_without_rewriting_origin_identity() -> None:
    resolver_calls: list[str] = []

    def resolver(hostname: str) -> tuple[str, ...]:
        resolver_calls.append(hostname)
        return ("8.8.8.8",)

    resolved = resolve_provider_base_url(
        "https://provider.test:8443/v1",
        provider="openai-compatible",
        resolver=resolver,
    )
    stream = _RecordingStream()
    backend = _RecordingBackend({"8.8.8.8": stream})

    async def request() -> tuple[int, str]:
        transport = PinnedAsyncHTTPTransport(resolved, network_backend=backend)
        async with httpx.AsyncClient(
            transport=transport,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            response = await client.get("https://provider.test:8443/v1/models")
            return response.status_code, response.request.url.host

    status_code, request_host = asyncio.run(request())

    assert status_code == 200
    assert request_host == "provider.test"
    assert resolver_calls == ["provider.test"]
    assert backend.attempts == [("8.8.8.8", 8443)]
    assert stream.server_names == ["provider.test"]
    assert b"host: provider.test:8443\r\n" in bytes(stream.writes).lower()
    assert all(host != "provider.test" for host, _ in backend.attempts)
    assert stream.close_count == 1


def test_internationalized_hostname_uses_the_same_idna_identity_everywhere() -> None:
    resolved = _resolved("https://例子.测试/v1", "8.8.8.8")
    stream = _RecordingStream()
    backend = _RecordingBackend({"8.8.8.8": stream})

    async def request() -> int:
        transport = PinnedAsyncHTTPTransport(resolved, network_backend=backend)
        async with httpx.AsyncClient(
            transport=transport,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            response = await client.get("https://例子.测试/v1/models")
            return response.status_code

    assert asyncio.run(request()) == 200
    assert resolved.hostname == "xn--fsqu00a.xn--0zwm56d"
    assert stream.server_names == ["xn--fsqu00a.xn--0zwm56d"]
    assert b"host: xn--fsqu00a.xn--0zwm56d\r\n" in bytes(stream.writes).lower()


@pytest.mark.parametrize(
    ("url", "host_header", "sni_hostname"),
    [
        ("https://other.test:8443/v1", None, None),
        ("https://provider.test:9443/v1", None, None),
        ("https://provider.test:8443/v1", "attacker.test", None),
        ("https://provider.test:8443/v1", None, "attacker.test"),
    ],
)
def test_origin_override_fails_closed_before_connect(
    url: str,
    host_header: str | None,
    sni_hostname: str | None,
) -> None:
    resolved = _resolved("https://provider.test:8443/v1", "8.8.8.8")
    backend = _RecordingBackend({"8.8.8.8": _RecordingStream()})

    async def request() -> None:
        transport = PinnedAsyncHTTPTransport(resolved, network_backend=backend)
        async with httpx.AsyncClient(
            transport=transport,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            headers = {"host": host_header} if host_header is not None else None
            outgoing = client.build_request("GET", url, headers=headers)
            if sni_hostname is not None:
                outgoing.extensions["sni_hostname"] = sni_hostname
            await client.send(outgoing)

    with pytest.raises(httpx.ConnectError):
        asyncio.run(request())

    assert backend.attempts == []


def test_connect_retries_only_addresses_from_validated_snapshot() -> None:
    resolved = _resolved(
        "https://provider.test/v1",
        "8.8.8.8",
        "8.8.4.4",
    )
    stream = _RecordingStream()
    backend = _RecordingBackend(
        {
            "8.8.8.8": httpcore.ConnectError("first address unavailable"),
            "8.8.4.4": stream,
        }
    )

    async def request() -> int:
        transport = PinnedAsyncHTTPTransport(resolved, network_backend=backend)
        async with httpx.AsyncClient(
            transport=transport,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            response = await client.get("https://provider.test/v1/models")
            return response.status_code

    assert asyncio.run(request()) == 200
    assert backend.attempts == [("8.8.8.8", 443), ("8.8.4.4", 443)]
    assert all(host != "provider.test" for host, _ in backend.attempts)
    assert backend.timeouts[0] is not None
    assert backend.timeouts[1] is not None
    assert backend.timeouts[1] <= backend.timeouts[0]


def test_black_holed_first_address_does_not_starve_later_validated_address() -> None:
    resolved = _resolved(
        "https://provider.test/v1",
        "8.8.8.8",
        "8.8.4.4",
    )
    stream = _RecordingStream()
    backend = _BlackHoleFirstBackend({"8.8.4.4": stream})

    async def request() -> int:
        transport = PinnedAsyncHTTPTransport(resolved, network_backend=backend)
        async with httpx.AsyncClient(
            transport=transport,
            timeout=1.0,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            response = await client.get("https://provider.test/v1/models")
            return response.status_code

    assert asyncio.run(request()) == 200
    assert backend.attempts == [("8.8.8.8", 443), ("8.8.4.4", 443)]
    assert all(host != "provider.test" for host, _ in backend.attempts)


def test_immediate_failure_accelerates_interleaved_address_families(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(pinned_http, "_HAPPY_EYEBALLS_DELAY_SECONDS", 60.0)
    addresses = (
        "2001:4860:4860::8888",
        "2001:4860:4860::8844",
        "8.8.8.8",
        "8.8.4.4",
    )
    resolved = _resolved("https://provider.test/v1", *addresses)
    stream = _RecordingStream()
    backend = _RecordingBackend(
        {
            addresses[0]: httpcore.ConnectError("first IPv6 unavailable"),
            addresses[1]: httpcore.ConnectError("second IPv6 unavailable"),
            addresses[2]: httpcore.ConnectError("first IPv4 unavailable"),
            addresses[3]: stream,
        }
    )

    async def request() -> int:
        transport = PinnedAsyncHTTPTransport(resolved, network_backend=backend)
        async with httpx.AsyncClient(
            transport=transport,
            timeout=1.0,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            response = await client.get("https://provider.test/v1/models")
            return response.status_code

    assert asyncio.run(request()) == 200
    assert backend.attempts == [
        (addresses[0], 443),
        (addresses[2], 443),
        (addresses[1], 443),
        (addresses[3], 443),
    ]


def test_simultaneous_success_closes_winner_and_loser_once() -> None:
    resolved = _resolved(
        "https://provider.test/v1",
        "8.8.8.8",
        "8.8.4.4",
    )
    streams = {
        "8.8.8.8": _RecordingStream(),
        "8.8.4.4": _RecordingStream(),
    }
    backend = _SimultaneousSuccessBackend(streams)

    async def request() -> int:
        transport = PinnedAsyncHTTPTransport(resolved, network_backend=backend)
        async with httpx.AsyncClient(
            transport=transport,
            timeout=2.0,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            response = await client.get("https://provider.test/v1/models")
            return response.status_code

    assert asyncio.run(request()) == 200
    assert backend.attempts == [("8.8.8.8", 443), ("8.8.4.4", 443)]
    assert [stream.close_count for stream in streams.values()] == [1, 1]


def test_black_holed_candidates_are_incrementally_staggered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delay = 0.04
    monkeypatch.setattr(pinned_http, "_HAPPY_EYEBALLS_DELAY_SECONDS", delay)
    addresses = (
        "2001:4860:4860::8888",
        "2001:4860:4860::8844",
        "8.8.8.8",
        "8.8.4.4",
    )
    resolved = _resolved("https://provider.test/v1", *addresses)
    stream = _RecordingStream()
    backend = _TrailingSuccessBackend(addresses[3], stream)

    async def request() -> int:
        transport = PinnedAsyncHTTPTransport(resolved, network_backend=backend)
        async with httpx.AsyncClient(
            transport=transport,
            timeout=1.0,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            response = await client.get("https://provider.test/v1/models")
            return response.status_code

    assert asyncio.run(request()) == 200
    assert backend.attempts == [
        (addresses[0], 443),
        (addresses[2], 443),
        (addresses[1], 443),
        (addresses[3], 443),
    ]
    gaps = [
        later - earlier
        for earlier, later in zip(backend.started_at, backend.started_at[1:])
    ]
    assert all(gap >= delay * 0.75 for gap in gaps)


@pytest.mark.parametrize(
    ("core_error", "expected_error"),
    [
        (httpcore.ConnectError("network down"), httpx.ConnectError),
        (httpcore.ConnectTimeout("connection timed out"), httpx.ConnectTimeout),
    ],
)
def test_httpcore_connection_errors_are_exposed_as_httpx_errors(
    core_error: Exception,
    expected_error: type[httpx.HTTPError],
) -> None:
    resolved = _resolved("https://provider.test/v1", "8.8.8.8")
    backend = _RecordingBackend({"8.8.8.8": core_error})

    async def request() -> None:
        transport = PinnedAsyncHTTPTransport(resolved, network_backend=backend)
        async with httpx.AsyncClient(
            transport=transport,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            await client.get("https://provider.test/v1/models")

    with pytest.raises(expected_error):
        asyncio.run(request())

    assert backend.attempts == [("8.8.8.8", 443)]


def test_ollama_requires_a_resolved_address_before_use() -> None:
    with pytest.raises(ValueError, match="could not be resolved"):
        resolve_provider_base_url(
            "http://ollama.test:11434/v1",
            provider="ollama",
            resolver=lambda hostname: (),
        )


def test_transport_enforces_dns_policy_at_request_time() -> None:
    backend = _RecordingBackend({})

    async def request() -> None:
        transport = build_pinned_http_transport(
            "https://provider.test/v1",
            provider="openai-compatible",
            resolver=lambda hostname: ("127.0.0.1",),
            network_backend=backend,
        )
        async with httpx.AsyncClient(
            transport=transport,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            await client.get("https://provider.test/v1/models")

    with pytest.raises(ProviderConfigurationError, match="blocked network address"):
        asyncio.run(request())

    assert backend.attempts == []


def test_temporary_dns_failure_is_provider_unavailable() -> None:
    backend = _RecordingBackend({})

    def fail_resolution(hostname: str) -> tuple[str, ...]:
        raise socket.gaierror(f"temporary failure for {hostname}")

    async def request() -> None:
        transport = build_pinned_http_transport(
            "https://provider.test/v1",
            provider="openai-compatible",
            resolver=fail_resolution,
            network_backend=backend,
        )
        async with httpx.AsyncClient(
            transport=transport,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            await client.get("https://provider.test/v1/models")

    with pytest.raises(ProviderUnavailableError, match="could not be resolved"):
        asyncio.run(request())

    assert backend.attempts == []


def test_dns_resolution_is_deadline_limited_without_blocking_event_loop() -> None:
    started = threading.Event()
    release = threading.Event()
    backend = _RecordingBackend({})

    def block_resolution(hostname: str) -> tuple[str, ...]:
        _ = hostname
        started.set()
        release.wait(timeout=2)
        return ("8.8.8.8",)

    async def request() -> None:
        transport = build_pinned_http_transport(
            "https://provider.test/v1",
            provider="openai-compatible",
            resolver=block_resolution,
            network_backend=backend,
        )
        async with httpx.AsyncClient(
            transport=transport,
            timeout=httpx.Timeout(0.05),
            trust_env=False,
            follow_redirects=False,
        ) as client:
            await client.get("https://provider.test/v1/models")

    began = monotonic()
    try:
        with pytest.raises(httpx.ConnectTimeout):
            asyncio.run(request())
    finally:
        release.set()

    assert started.is_set()
    assert monotonic() - began < 1
    assert backend.attempts == []


@pytest.mark.parametrize("address", ["100.64.0.1", "fec0::1"])
def test_remote_provider_rejects_non_global_or_site_local_address_space(
    address: str,
) -> None:
    with pytest.raises(ValueError, match="blocked network address"):
        resolve_provider_base_url(
            "https://provider.test/v1",
            provider="openai-compatible",
            resolver=lambda hostname: (address,),
        )


def test_provider_base_url_rejects_explicit_zero_port() -> None:
    with pytest.raises(ValueError, match="port must be between"):
        resolve_provider_base_url(
            "https://provider.test:0/v1",
            provider="openai-compatible",
            resolver=lambda hostname: ("8.8.8.8",),
        )
