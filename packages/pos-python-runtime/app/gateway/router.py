import httpx
from fastapi import FastAPI, HTTPException, Request
from starlette.responses import Response

from app.api.routes.health import router as health_router

AUTH_PREFIXES = (
    "auth/",
    "users/",
    "devices/",
)

POS_PREFIXES = (
    "pos-configs",
    "pos/sync",
    "pos/sessions",
)

PRODUCT_PREFIXES = (
    "catalog",
)

MEMBER_PREFIXES = (
    "members",
)

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}


def include_gateway_routes(app: FastAPI) -> None:
    app.include_router(health_router)

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    async def proxy(path: str, request: Request) -> Response:
        settings = request.app.state.settings
        prefix = settings.api_prefix.strip("/")
        if not path.startswith(f"{prefix}/"):
            raise HTTPException(status_code=404, detail="Gateway route not found.")

        route = path[len(prefix) + 1 :]
        if route.startswith(AUTH_PREFIXES):
            upstream = str(settings.auth_service_url).rstrip("/")
        elif route.startswith(POS_PREFIXES):
            upstream = str(settings.pos_service_url).rstrip("/")
        elif route.startswith(PRODUCT_PREFIXES):
            upstream = str(settings.product_service_url).rstrip("/")
        elif route.startswith(MEMBER_PREFIXES):
            upstream = str(settings.member_service_url).rstrip("/")
        else:
            raise HTTPException(status_code=404, detail="No upstream configured for route.")

        target = f"{upstream}/{path}"
        if request.url.query:
            target = f"{target}?{request.url.query}"

        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in HOP_BY_HOP_HEADERS
        }
        headers["x-forwarded-host"] = request.headers.get("host", "")
        headers["x-forwarded-proto"] = request.url.scheme

        try:
            upstream_response = await request.app.state.gateway_http.request(
                request.method,
                target,
                content=await request.body(),
                headers=headers,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Gateway upstream request failed: {exc}",
            ) from exc
        response_headers = {
            key: value
            for key, value in upstream_response.headers.items()
            if key.lower() not in HOP_BY_HOP_HEADERS
        }
        return Response(
            content=upstream_response.content,
            status_code=upstream_response.status_code,
            headers=response_headers,
            media_type=upstream_response.headers.get("content-type"),
        )
