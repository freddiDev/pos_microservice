FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ARG PYTHONDONTWRITEBYTECODE
ARG PYTHONUNBUFFERED
ARG UV_COMPILE_BYTECODE
ARG UV_LINK_MODE
ARG APP_HOST
ARG APP_PORT

ENV PYTHONDONTWRITEBYTECODE=${PYTHONDONTWRITEBYTECODE} \
    PYTHONUNBUFFERED=${PYTHONUNBUFFERED} \
    UV_COMPILE_BYTECODE=${UV_COMPILE_BYTECODE} \
    UV_LINK_MODE=${UV_LINK_MODE} \
    APP_HOST=${APP_HOST} \
    APP_PORT=${APP_PORT}

WORKDIR /app

COPY packages/pos-python-runtime/pyproject.toml packages/pos-python-runtime/README.md ./
COPY packages/pos-python-runtime/app ./app
COPY packages/pos-python-runtime/tests ./tests
COPY scripts ./scripts

RUN uv pip install --system -e ".[dev]" \
    && useradd --create-home --shell /usr/sbin/nologin appuser

USER appuser

EXPOSE ${APP_PORT}

CMD ["sh", "-c", "uvicorn app.main:create_app --factory --host ${APP_HOST} --port ${APP_PORT}"]
