import logging
import math
import re
import unicodedata
from abc import ABC, abstractmethod
from collections import Counter
from functools import lru_cache
from importlib.util import find_spec

from app.core.config import Settings


TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]{2,}")
logger = logging.getLogger(__name__)


def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text)
    normalized = normalized.replace("\u3000", " ")
    return re.sub(r"\s+", " ", normalized).strip().lower()


def extract_terms(text: str) -> list[str]:
    normalized = normalize_text(text)
    keyword_terms = TOKEN_PATTERN.findall(normalized)
    compact = normalized.replace(" ", "")
    bigrams = [compact[index : index + 2] for index in range(max(len(compact) - 1, 0))]
    trigrams = [compact[index : index + 3] for index in range(max(len(compact) - 2, 0)) if len(compact[index : index + 3]) == 3]
    return keyword_terms + bigrams + trigrams


class EmbeddingProvider(ABC):
    @abstractmethod
    def embed(self, text: str) -> dict[str, float] | list[float]:
        raise NotImplementedError


class LocalHybridEmbeddingProvider(EmbeddingProvider):
    def embed(self, text: str) -> dict[str, float]:
        counts = Counter(extract_terms(text))
        if not counts:
            return {}

        limit = 80
        most_common = counts.most_common(limit)
        denominator = math.sqrt(sum(value * value for _, value in most_common)) or 1.0
        return {token: round(score / denominator, 6) for token, score in most_common}


@lru_cache(maxsize=2)
def _load_bge_model(model_name: str, cache_dir: str):
    from FlagEmbedding import BGEM3FlagModel

    return BGEM3FlagModel(model_name, use_fp16=False, cache_dir=cache_dir)


class BGEM3EmbeddingProvider(EmbeddingProvider):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.fallback = LocalHybridEmbeddingProvider()

    def embed(self, text: str) -> dict[str, float] | list[float]:
        try:
            model = _load_bge_model(self.settings.embedding_model_name, str(self.settings.model_cache_dir))
            output = model.encode([text], return_dense=True, return_sparse=False, return_colbert_vecs=False)
            dense_vec = output["dense_vecs"][0]
            return [float(value) for value in dense_vec.tolist()]
        except Exception as exc:
            if self.settings.allow_ml_fallback:
                logger.warning("BGEM3 embedding failed, falling back to local hybrid", extra={"extra_payload": {"reason": str(exc)}})
                return self.fallback.embed(text)
            raise


def build_embedding_provider(settings: Settings) -> EmbeddingProvider:
    if settings.embedding_provider == "local_hybrid":
        return LocalHybridEmbeddingProvider()
    if settings.embedding_provider == "bge_m3":
        if find_spec("FlagEmbedding") is None and settings.allow_ml_fallback:
            logger.warning("FlagEmbedding not installed; falling back to LocalHybridEmbeddingProvider")
            return LocalHybridEmbeddingProvider()
        return BGEM3EmbeddingProvider(settings)
    raise RuntimeError(f"Unsupported embedding provider: {settings.embedding_provider}")


def cosine_similarity(left: dict[str, float] | list[float], right: dict[str, float] | list[float]) -> float:
    if not left or not right:
        return 0.0
    if isinstance(left, list) and isinstance(right, list):
        return round(sum(a * b for a, b in zip(left, right, strict=False)), 6)
    if isinstance(left, dict) and isinstance(right, dict):
        shared = set(left).intersection(right)
        return round(sum(left[token] * right[token] for token in shared), 6)
    return 0.0
