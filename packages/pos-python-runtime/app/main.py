from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI

from app.api.router import include_service_routes
from app.core.config import Settings, get_settings
from app.core.database import build_engine, build_session_factory, init_database
from app.gateway.router import include_gateway_routes
from app.pos.sync_worker import PosSyncWorker


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    if settings.service_role in {"auth", "pos"}:
        if not settings.database_url:
            raise RuntimeError("DATABASE_URL is required for database-backed services.")
        engine = build_engine(settings.database_url)
        app.state.db_engine = engine
        app.state.db_session_factory = build_session_factory(engine)
        await init_database(engine, settings.service_role)
    if settings.service_role in {"auth", "pos"}:
        if not settings.odoo_base_url:
            raise RuntimeError("ODOO_BASE_URL is required for Odoo-backed services.")
        app.state.odoo_http = httpx.AsyncClient(
            base_url=str(settings.odoo_base_url).rstrip("/"),
            timeout=settings.request_timeout_seconds,
        )
    if settings.service_role == "pos":
        if not settings.auth_service_url:
            raise RuntimeError("AUTH_SERVICE_URL is required for POS service.")
        app.state.auth_http = httpx.AsyncClient(
            base_url=str(settings.auth_service_url).rstrip("/"),
            timeout=settings.request_timeout_seconds,
        )
        worker = PosSyncWorker(settings, app.state.db_session_factory, app.state.odoo_http)
        app.state.pos_sync_worker = worker
        worker.start()
    elif settings.service_role == "gateway":
        app.state.gateway_http = httpx.AsyncClient(timeout=settings.request_timeout_seconds)

    try:
        yield
    finally:
        if hasattr(app.state, "pos_sync_worker"):
            await app.state.pos_sync_worker.stop()
        if hasattr(app.state, "odoo_http"):
            await app.state.odoo_http.aclose()
        if hasattr(app.state, "gateway_http"):
            await app.state.gateway_http.aclose()
        if hasattr(app.state, "auth_http"):
            await app.state.auth_http.aclose()
        if hasattr(app.state, "db_engine"):
            await app.state.db_engine.dispose()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = settings

    if settings.service_role == "gateway":
        include_gateway_routes(app)
    else:
        include_service_routes(app, settings.api_prefix, settings.service_role)

    return app
