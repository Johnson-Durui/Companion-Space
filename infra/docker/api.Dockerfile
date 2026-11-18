FROM node:24.14.0-bookworm-slim AS web-build

WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/avatar-engine/package.json packages/avatar-engine/package.json
COPY packages/board/package.json packages/board/package.json
RUN npm ci --ignore-scripts
COPY apps/web apps/web
COPY packages packages
RUN npm run build --workspace web

FROM python:3.14.10-slim-bookworm AS runtime

ENV APP_ENV=production \
    APP_BASE_URL=http://127.0.0.1:8000 \
    API_BASE_URL=http://127.0.0.1:8000 \
    COMPANION_DATA_DIR=/data \
    PYTHONPATH=/app/services/api \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY services/api/requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir --only-binary=:all: -r /tmp/requirements.txt \
    && useradd --create-home --uid 10001 companion \
    && install -d -o companion -g companion /data

COPY services/api/app services/api/app
COPY libs/prompts libs/prompts
COPY libs/schemas libs/schemas
COPY content/characters content/characters
COPY content/sample-course content/sample-course
COPY content/speech content/speech
COPY assets/avatars assets/avatars
COPY assets/THIRD_PARTY_NOTICES.md assets/THIRD_PARTY_NOTICES.md
COPY --from=web-build /src/apps/web/dist apps/web/dist

# These four portraits remain blocked from release artifacts until their
# redistribution terms are independently verified.
RUN rm -f \
      assets/avatars/portraits/mira.png \
      assets/avatars/portraits/kite.png \
      assets/avatars/portraits/cael.png \
      assets/avatars/portraits/lyra.png \
      content/characters/1-mira.json \
      content/characters/2-kite.json \
      content/characters/3-cael.json \
      content/characters/4-lyra.json

USER companion
EXPOSE 8000
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=12 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).read()"]
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]
