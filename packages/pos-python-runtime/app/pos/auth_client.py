from typing import Any

import httpx
from fastapi import HTTPException, status

from app.core.config import Settings
from app.pos.schemas import AuthPrincipal


class AuthContextClient:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self._settings = settings
        self._client = client

    async def resolve(self, bearer_token: str) -> AuthPrincipal:
        if not self._settings.internal_service_key:
            raise HTTPException(status_code=500, detail="INTERNAL_SERVICE_KEY is not configured.")
        try:
            response = await self._client.get(
                f"{self._settings.api_prefix}/internal/auth/context",
                headers={
                    "Authorization": f"Bearer {bearer_token}",
                    "X-Internal-Service-Key": self._settings.internal_service_key,
                },
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Auth context request failed: {exc}") from exc

        if response.status_code == 401:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token.")
        if response.status_code >= 400:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=_error_message(response))
        return AuthPrincipal.model_validate(response.json())


def _error_message(response: httpx.Response) -> str:
    try:
        data: Any = response.json()
    except ValueError:
        return response.text[:300]
    if isinstance(data, dict):
        return str(data.get("detail") or data.get("message") or data)
    return str(data)
