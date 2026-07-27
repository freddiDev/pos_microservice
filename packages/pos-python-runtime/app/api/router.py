from fastapi import FastAPI

from app.api.routes import auth, devices, health, internal, pos_configs, users
from app.pos import routes as pos_routes


def include_service_routes(app: FastAPI, api_prefix: str, service_role: str) -> None:
    app.include_router(health.router)
    if service_role == "auth":
        app.include_router(auth.router, prefix=api_prefix)
        app.include_router(users.router, prefix=api_prefix)
        app.include_router(devices.router, prefix=api_prefix)
        app.include_router(pos_configs.router, prefix=api_prefix)
        app.include_router(internal.router, prefix=api_prefix)
    elif service_role == "pos":
        app.include_router(pos_routes.router, prefix=api_prefix)
