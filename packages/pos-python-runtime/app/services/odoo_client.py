from typing import Any

import httpx


class OdooClientError(RuntimeError):
    pass


class OdooAuthError(OdooClientError):
    pass


class OdooClient:
    def __init__(self, client: httpx.AsyncClient):
        self._client = client

    async def login(self, login: str, password: str, device_code: str | None = None) -> dict[str, Any]:
        payload = {"login": login, "password": password, "device_code": device_code}
        return await self._post("/api/microservice/auth/login", payload)

    async def logout(self, odoo_access_token: str) -> dict[str, Any]:
        return await self._post(
            "/api/microservice/auth/logout",
            {},
            headers={"Authorization": f"Bearer {odoo_access_token}"},
        )

    async def _post(
        self,
        path: str,
        payload: dict[str, Any],
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        try:
            response = await self._client.post(path, json=payload, headers=headers)
        except httpx.HTTPError as exc:
            raise OdooClientError(f"Odoo request failed: {exc}") from exc

        if response.status_code >= 500:
            raise OdooClientError(f"Odoo HTTP {response.status_code}: {response.text[:300]}")

        try:
            data = response.json()
        except ValueError as exc:
            raise OdooClientError("Odoo returned non-JSON response.") from exc

        if isinstance(data, dict) and "result" in data and isinstance(data["result"], dict):
            data = data["result"]

        if response.status_code >= 400 or not data.get("success", False):
            message = data.get("message") or data.get("error") or "Odoo API rejected request."
            raise OdooAuthError(str(message))

        result = data.get("data", data)
        if not isinstance(result, dict):
            raise OdooClientError("Odoo API returned unexpected payload.")
        return result
