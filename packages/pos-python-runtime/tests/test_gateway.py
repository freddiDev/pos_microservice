from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.gateway.router import include_gateway_routes


@pytest.mark.asyncio
async def test_gateway_maps_upstream_connection_error_to_bad_gateway() -> None:
    app = FastAPI()
    app.state.settings = SimpleNamespace(
        api_prefix="/api/v1",
        auth_service_url="http://auth-service:8000",
        pos_service_url="http://pos-service:8000",
        product_service_url="http://product-service:3000",
        member_service_url="http://member-service:3001",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("all connection attempts failed", request=request)

    app.state.gateway_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    include_gateway_routes(app)

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://gateway") as client:
            response = await client.post("/api/v1/auth/login", json={"login": "admin", "password": "secret"})
    finally:
        await app.state.gateway_http.aclose()

    assert response.status_code == 502
    assert response.json()["detail"] == (
        "Gateway upstream request failed: all connection attempts failed"
    )
