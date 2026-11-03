from fastapi import Request


async def _read_limited_body(request: Request, *, max_bytes: int) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_size = int(content_length)
        except ValueError as exc:
            raise ValueError("Invalid Content-Length header") from exc
        if declared_size < 0:
            raise ValueError("Invalid Content-Length header")
        if declared_size > max_bytes:
            raise ValueError("Document exceeds 50 MiB limit")

    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > max_bytes:
            raise ValueError("Document exceeds 50 MiB limit")
        body.extend(chunk)
    return bytes(body)
