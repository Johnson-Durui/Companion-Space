class CodedValueError(ValueError):
    """A validation or domain error carrying a stable machine-readable code."""

    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class ResourceNotFoundError(CodedValueError):
    """A requested record does not exist within its owner scope."""

    def __init__(self, message: str, *, code: str = "not_found") -> None:
        super().__init__(code, message, status_code=404)
