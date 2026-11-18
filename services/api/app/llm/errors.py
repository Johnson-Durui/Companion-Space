from app.providers.errors import ProviderProtocolError


class LLMOutputError(ProviderProtocolError):
    def __init__(self, *, public_detail: str, finish_reason: str | None = None) -> None:
        super().__init__(provider="gateway", public_detail=public_detail)
        self.finish_reason = finish_reason
        if finish_reason == "length":
            self.public_code = "provider_output_truncated"
        else:
            self.public_code = "provider_output_invalid"
