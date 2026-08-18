FROM python:3.12-slim

ARG TORCH_VERSION=2.8.0

WORKDIR /app

ENV HF_HUB_DISABLE_TELEMETRY=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TTS_MODEL_CACHE=/models

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY services/tts/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir \
      torch==${TORCH_VERSION} torchaudio==${TORCH_VERSION} \
      --index-url https://download.pytorch.org/whl/cu128 \
    && pip install --no-cache-dir -r /tmp/requirements.txt

RUN apt-get update \
    && apt-get install -y --no-install-recommends sox \
    && rm -rf /var/lib/apt/lists/*

COPY services/tts /app

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001", "--no-access-log"]
