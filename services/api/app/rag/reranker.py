import logging
from functools import lru_cache
from importlib.util import find_spec

from app.core.config import Settings
from app.models.domain import RetrievalHit

logger = logging.getLogger(__name__)


class RerankerProvider:
    def rerank(self, query: str, hits: list[RetrievalHit]) -> list[RetrievalHit]:
        raise NotImplementedError


class LocalScoreReranker(RerankerProvider):
    def rerank(self, query: str, hits: list[RetrievalHit]) -> list[RetrievalHit]:
        _ = query
        return hits


@lru_cache(maxsize=2)
def _load_reranker(model_name: str, cache_dir: str):
    from FlagEmbedding import FlagReranker

    return FlagReranker(model_name, use_fp16=False, cache_dir=cache_dir)


class BGERerankerProvider(RerankerProvider):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.fallback = LocalScoreReranker()

    def rerank(self, query: str, hits: list[RetrievalHit]) -> list[RetrievalHit]:
        if not hits:
            return hits
        try:
            reranker = _load_reranker(self.settings.reranker_model_name, str(self.settings.model_cache_dir))
            scores = reranker.compute_score([[query, hit.chunk.content] for hit in hits], normalize=True)
            rescored = [
                hit.model_copy(update={"final_score": round(hit.final_score * 0.45 + float(score) * 0.55, 6)})
                for hit, score in zip(hits, scores, strict=False)
            ]
            rescored.sort(key=lambda item: item.final_score, reverse=True)
            return rescored
        except Exception as exc:
            if self.settings.allow_ml_fallback:
                logger.warning("BGE reranker failed, falling back to local score ordering", extra={"extra_payload": {"reason": str(exc)}})
                return self.fallback.rerank(query, hits)
            raise


def build_reranker_provider(settings: Settings) -> RerankerProvider:
    if settings.reranker_provider == "local":
        return LocalScoreReranker()
    if settings.reranker_provider == "bge_reranker_v2_m3":
        if find_spec("FlagEmbedding") is None and settings.allow_ml_fallback:
            logger.warning("FlagEmbedding not installed; falling back to LocalScoreReranker")
            return LocalScoreReranker()
        return BGERerankerProvider(settings)
    raise RuntimeError(f"Unsupported reranker provider: {settings.reranker_provider}")
