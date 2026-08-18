from __future__ import annotations

from collections.abc import AsyncIterable, Iterable
from contextlib import contextmanager
from dataclasses import dataclass
from functools import partial
from ipaddress import ip_address
import socket
from time import monotonic
from typing import Any, AsyncIterator, Callable, Iterator
from urllib.parse import urlsplit

import anyio
import httpcore
import httpx

from app.providers.errors import (
    ProviderConfigurationError,
    ProviderUnavailableError,
)


HostResolver = Callable[[str], Iterable[str]]
_HAPPY_EYEBALLS_DELAY_SECONDS = 0.25


@dataclass(frozen=True)
class ParsedProviderBaseUrl:
    base_url: str
    scheme: str
    hostname: str
    port: int


@dataclass(frozen=True)
class ResolvedProviderBaseUrl(ParsedProviderBaseUrl):
    addresses: tuple[str, ...]


class ProviderHostResolutionError(OSError):
    pass


def resolve_provider_base_url(
    base_url: str,
    *,
    provider: str,
    resolver: HostResolver | None = None,
) -> ResolvedProviderBaseUrl:
    parsed = _parse_provider_base_url(base_url)
    addresses = _resolve_host_addresses(parsed.hostname, resolver=resolver)
    if not addresses:
        raise ValueError("Provider Base URL hostname could not be resolved")
    normalized_addresses = _validate_resolved_addresses(
        addresses,
        provider=provider,
    )
    return ResolvedProviderBaseUrl(
        base_url=parsed.base_url,
        scheme=parsed.scheme,
        hostname=parsed.hostname,
        port=parsed.port,
        addresses=normalized_addresses,
    )


def _parse_provider_base_url(base_url: str) -> ParsedProviderBaseUrl:
    candidate = base_url.strip()
    if not candidate or len(candidate) > 2048:
        raise ValueError(
            "Provider Base URL is too long"
            if candidate
            else "Provider Base URL must be a valid http(s) URL"
        )
    parsed = urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Provider Base URL must be a valid http(s) URL")
    if parsed.username or parsed.password:
        raise ValueError("Provider Base URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise ValueError(
            "Provider Base URL must not contain a query string or fragment"
        )

    try:
        parsed_port = parsed.port
        url = httpx.URL(candidate)
        hostname = url.raw_host.decode("ascii").lower()
    except (UnicodeError, ValueError, httpx.InvalidURL) as exc:
        raise ValueError("Provider Base URL must contain a valid host and port") from exc
    if hostname.rstrip(".") in {
        "metadata",
        "metadata.google.internal",
        "metadata.azure.internal",
    }:
        raise ValueError("Provider Base URL cannot target a metadata service")
    if parsed_port == 0:
        raise ValueError("Provider Base URL port must be between 1 and 65535")
    port = (
        parsed_port
        if parsed_port is not None
        else (443 if url.scheme == "https" else 80)
    )

    return ParsedProviderBaseUrl(
        base_url=candidate.rstrip("/"),
        scheme=url.scheme,
        hostname=hostname,
        port=port,
    )


def _validate_resolved_addresses(
    addresses: Iterable[str],
    *,
    provider: str,
) -> tuple[str, ...]:
    allow_private_networks = provider.lower() == "ollama"
    normalized: list[str] = []
    for raw_address in addresses:
        try:
            address = ip_address(raw_address)
        except ValueError as exc:
            raise ValueError(
                "Provider Base URL hostname returned an invalid address"
            ) from exc
        if _is_blocked_network_address(
            address,
            allow_private_networks=allow_private_networks,
        ):
            raise ValueError("Provider Base URL targets a blocked network address")
        normalized.append(address.compressed)
    return tuple(dict.fromkeys(normalized))


def build_pinned_http_transport(
    base_url: str,
    *,
    provider: str,
    resolver: HostResolver | None = None,
    network_backend: httpcore.AsyncNetworkBackend | None = None,
) -> PinnedAsyncHTTPTransport:
    try:
        parsed = _parse_provider_base_url(base_url)
    except ValueError as exc:
        raise ProviderConfigurationError(
            provider=provider,
            public_detail=str(exc),
        ) from exc
    return PinnedAsyncHTTPTransport(
        parsed,
        provider=provider,
        resolver=resolver,
        network_backend=network_backend,
    )


class PinnedAsyncHTTPTransport(httpx.AsyncBaseTransport):
    def __init__(
        self,
        origin: ParsedProviderBaseUrl,
        *,
        provider: str | None = None,
        resolver: HostResolver | None = None,
        network_backend: httpcore.AsyncNetworkBackend | None = None,
    ) -> None:
        if not isinstance(origin, ResolvedProviderBaseUrl) and provider is None:
            raise ValueError("A provider is required for deferred DNS validation")
        self._origin = origin
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpx.create_ssl_context(verify=True, trust_env=False),
            network_backend=_PinnedNetworkBackend(
                origin,
                network_backend or httpcore.AnyIOBackend(),
                provider=provider,
                resolver=resolver,
            ),
            retries=0,
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self._validate_request_origin(request)
        core_request = httpcore.Request(
            method=request.method,
            url=httpcore.URL(
                scheme=request.url.raw_scheme,
                host=request.url.raw_host,
                port=request.url.port,
                target=request.url.raw_path,
            ),
            headers=request.headers.raw,
            content=request.stream,
            extensions=request.extensions,
        )
        with _map_httpcore_exceptions():
            response = await self._pool.handle_async_request(core_request)
        return httpx.Response(
            status_code=response.status,
            headers=response.headers,
            stream=_PinnedResponseStream(response.stream),
            extensions=response.extensions,
        )

    async def aclose(self) -> None:
        await self._pool.aclose()

    def _validate_request_origin(self, request: httpx.Request) -> None:
        scheme = request.url.scheme.lower()
        hostname = request.url.raw_host.decode("ascii").lower()
        port = request.url.port or (443 if scheme == "https" else 80)
        expected_host = self._origin.hostname
        if ":" in expected_host:
            expected_host = f"[{expected_host}]"
        if self._origin.port != (443 if scheme == "https" else 80):
            expected_host = f"{expected_host}:{self._origin.port}"
        if (
            scheme != self._origin.scheme
            or hostname != self._origin.hostname
            or port != self._origin.port
            or request.headers.get("host", "").lower() != expected_host
            or "sni_hostname" in request.extensions
        ):
            raise httpx.ConnectError(
                "Provider request origin does not match the pinned URL"
            )


class _PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    def __init__(
        self,
        origin: ParsedProviderBaseUrl,
        backend: httpcore.AsyncNetworkBackend,
        *,
        provider: str | None,
        resolver: HostResolver | None,
    ) -> None:
        self._origin = origin
        self._backend = backend
        self._provider = provider
        self._resolver = resolver

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        requested_host = host.decode("ascii") if isinstance(host, bytes) else host
        if (
            requested_host.lower() != self._origin.hostname
            or port != self._origin.port
        ):
            raise httpcore.ConnectError("Provider connection origin is not pinned")

        deadline = monotonic() + timeout if timeout is not None else None
        addresses = await self._validated_addresses(deadline)
        return await self._connect_validated_addresses(
            addresses,
            port=port,
            deadline=deadline,
            local_address=local_address,
            socket_options=socket_options,
        )

    async def _validated_addresses(self, deadline: float | None) -> tuple[str, ...]:
        if isinstance(self._origin, ResolvedProviderBaseUrl):
            return self._origin.addresses
        assert self._provider is not None
        remaining = _remaining_timeout(deadline)
        if remaining is not None and remaining <= 0:
            raise httpcore.ConnectTimeout("Provider hostname resolution timed out")
        resolve = partial(
            resolve_provider_base_url,
            self._origin.base_url,
            provider=self._provider,
            resolver=self._resolver or default_host_resolver,
        )
        try:
            if remaining is None:
                resolved = await anyio.to_thread.run_sync(
                    resolve,
                    abandon_on_cancel=True,
                )
            else:
                with anyio.fail_after(remaining):
                    resolved = await anyio.to_thread.run_sync(
                        resolve,
                        abandon_on_cancel=True,
                    )
        except TimeoutError as exc:
            raise httpcore.ConnectTimeout(
                "Provider hostname resolution timed out"
            ) from exc
        except ProviderHostResolutionError as exc:
            raise ProviderUnavailableError(
                provider=self._provider,
                public_detail="Provider hostname could not be resolved. Please retry.",
            ) from exc
        except ValueError as exc:
            raise ProviderConfigurationError(
                provider=self._provider,
                public_detail=str(exc),
            ) from exc
        return resolved.addresses

    async def _connect_validated_addresses(
        self,
        addresses: tuple[str, ...],
        *,
        port: int,
        deadline: float | None,
        local_address: str | None,
        socket_options: Any,
    ) -> httpcore.AsyncNetworkStream:
        async def race() -> httpcore.AsyncNetworkStream:
            send_stream, receive_stream = anyio.create_memory_object_stream(0)
            errors: list[httpcore.ConnectError | httpcore.ConnectTimeout] = []
            winner: httpcore.AsyncNetworkStream | None = None
            ordered_addresses = _interleave_address_families(addresses)
            started_events = [anyio.Event() for _ in ordered_addresses]
            failed_events = [anyio.Event() for _ in ordered_addresses]

            async def attempt(
                index: int,
                address: str,
                sender: Any,
            ) -> None:
                stream: httpcore.AsyncNetworkStream | None = None
                transferred = False
                try:
                    if index:
                        await started_events[index - 1].wait()
                        with anyio.move_on_after(_HAPPY_EYEBALLS_DELAY_SECONDS):
                            await failed_events[index - 1].wait()
                    remaining = _remaining_timeout(deadline)
                    if remaining is not None and remaining <= 0:
                        raise httpcore.ConnectTimeout("Provider connection timed out")
                    started_events[index].set()
                    stream = await self._backend.connect_tcp(
                        address,
                        port,
                        timeout=remaining,
                        local_address=local_address,
                        socket_options=socket_options,
                    )
                    await sender.send((stream, None))
                    transferred = True
                except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                    failed_events[index].set()
                    await sender.send((None, exc))
                finally:
                    with anyio.CancelScope(shield=True):
                        await sender.aclose()
                        if stream is not None and not transferred:
                            await stream.aclose()

            async with send_stream, receive_stream:
                async with anyio.create_task_group() as task_group:
                    for index, address in enumerate(ordered_addresses):
                        task_group.start_soon(
                            attempt,
                            index,
                            address,
                            send_stream.clone(),
                        )
                    await send_stream.aclose()
                    for _ in addresses:
                        stream, error = await receive_stream.receive()
                        if stream is not None:
                            winner = stream
                            task_group.cancel_scope.cancel()
                            break
                        assert error is not None
                        errors.append(error)

            if winner is not None:
                return winner
            assert errors
            raise errors[-1]

        remaining = _remaining_timeout(deadline)
        try:
            if remaining is None:
                return await race()
            if remaining <= 0:
                raise httpcore.ConnectTimeout("Provider connection timed out")
            with anyio.fail_after(remaining):
                return await race()
        except TimeoutError as exc:
            raise httpcore.ConnectTimeout("Provider connection timed out") from exc

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("Provider transport does not support Unix sockets")

    async def sleep(self, seconds: float) -> None:
        await self._backend.sleep(seconds)


class _PinnedResponseStream(httpx.AsyncByteStream):
    def __init__(self, stream: AsyncIterable[bytes]) -> None:
        self._stream = stream

    async def __aiter__(self) -> AsyncIterator[bytes]:
        with _map_httpcore_exceptions():
            async for part in self._stream:
                yield part

    async def aclose(self) -> None:
        if hasattr(self._stream, "aclose"):
            await self._stream.aclose()  # type: ignore[attr-defined]


_HTTPCORE_EXCEPTIONS: dict[type[Exception], type[httpx.HTTPError]] = {
    httpcore.TimeoutException: httpx.TimeoutException,
    httpcore.ConnectTimeout: httpx.ConnectTimeout,
    httpcore.ReadTimeout: httpx.ReadTimeout,
    httpcore.WriteTimeout: httpx.WriteTimeout,
    httpcore.PoolTimeout: httpx.PoolTimeout,
    httpcore.NetworkError: httpx.NetworkError,
    httpcore.ConnectError: httpx.ConnectError,
    httpcore.ReadError: httpx.ReadError,
    httpcore.WriteError: httpx.WriteError,
    httpcore.ProxyError: httpx.ProxyError,
    httpcore.UnsupportedProtocol: httpx.UnsupportedProtocol,
    httpcore.ProtocolError: httpx.ProtocolError,
    httpcore.LocalProtocolError: httpx.LocalProtocolError,
    httpcore.RemoteProtocolError: httpx.RemoteProtocolError,
}


@contextmanager
def _map_httpcore_exceptions() -> Iterator[None]:
    try:
        yield
    except Exception as exc:
        mapped: type[httpx.HTTPError] | None = None
        for source, target in _HTTPCORE_EXCEPTIONS.items():
            if isinstance(exc, source) and (
                mapped is None or issubclass(target, mapped)
            ):
                mapped = target
        if mapped is None:
            raise
        raise mapped(str(exc)) from exc


def _resolve_host_addresses(
    hostname: str,
    *,
    resolver: HostResolver | None,
) -> tuple[str, ...]:
    try:
        return (ip_address(hostname).compressed,)
    except ValueError:
        pass
    try:
        return tuple((resolver or default_host_resolver)(hostname))
    except OSError as exc:
        raise ProviderHostResolutionError(
            "Provider Base URL hostname could not be resolved"
        ) from exc


def default_host_resolver(hostname: str) -> tuple[str, ...]:
    resolved: list[str] = []
    for family, *_rest, sockaddr in socket.getaddrinfo(
        hostname,
        None,
        type=socket.SOCK_STREAM,
    ):
        if family in {socket.AF_INET, socket.AF_INET6}:
            resolved.append(sockaddr[0])
    return tuple(dict.fromkeys(resolved))


def _is_blocked_network_address(address: Any, *, allow_private_networks: bool) -> bool:
    if (
        address.is_link_local
        or address.is_multicast
        or address.is_unspecified
        or getattr(address, "is_site_local", False)
    ):
        return True
    if address.is_reserved:
        return True
    if not allow_private_networks and not address.is_global:
        return True
    return False


def _remaining_timeout(deadline: float | None) -> float | None:
    return None if deadline is None else deadline - monotonic()


def _interleave_address_families(addresses: tuple[str, ...]) -> tuple[str, ...]:
    if len(addresses) < 2:
        return addresses
    first_version = ip_address(addresses[0]).version
    other_version = 4 if first_version == 6 else 6
    by_version = {
        first_version: [
            address for address in addresses if ip_address(address).version == first_version
        ],
        other_version: [
            address for address in addresses if ip_address(address).version == other_version
        ],
    }
    ordered: list[str] = []
    for index in range(max(len(group) for group in by_version.values())):
        for version in (first_version, other_version):
            if index < len(by_version[version]):
                ordered.append(by_version[version][index])
    return tuple(ordered)
