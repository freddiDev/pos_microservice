from typing import Any

import httpx
from fastapi import HTTPException, status


class OdooPosClient:
    def __init__(self, client: httpx.AsyncClient):
        self._client = client

    async def list_configs(self, odoo_access_token: str) -> list[dict[str, Any]]:
        data = await self._post("/api/microservice/pos/configs", {}, odoo_access_token)
        items = data.get("items", [])
        if not isinstance(items, list):
            raise HTTPException(status_code=502, detail="Odoo returned invalid POS config list.")
        return items

    async def open_session(
        self,
        odoo_access_token: str,
        *,
        odoo_config_id: int,
        opening_cash: float | None = None,
        opening_notes: str | None = None,
    ) -> dict[str, Any]:
        return await self._post(
            "/api/microservice/pos/sessions/open",
            {
                "pos_config": odoo_config_id,
                "opening_cash": opening_cash,
                "opening_notes": opening_notes,
            },
            odoo_access_token,
        )

    async def session_detail(self, odoo_access_token: str, *, odoo_session_id: int) -> dict[str, Any]:
        return await self._post(
            "/api/microservice/pos/sessions/detail",
            {"session_id": odoo_session_id},
            odoo_access_token,
        )

    async def closing_control(self, odoo_access_token: str, *, odoo_session_id: int) -> dict[str, Any]:
        return await self._post(
            "/api/microservice/pos/sessions/closing-control",
            {"session_id": odoo_session_id},
            odoo_access_token,
        )

    async def opening_cash(
        self,
        odoo_access_token: str,
        *,
        odoo_session_id: int,
        counted_cash: float,
        opening_notes: str | None,
    ) -> dict[str, Any]:
        return await self._post(
            "/api/microservice/pos/sessions/opening-cash",
            {
                "session_id": odoo_session_id,
                "counted_cash": counted_cash,
                "opening_notes": opening_notes,
            },
            odoo_access_token,
        )

    async def close_session(
        self,
        odoo_access_token: str,
        *,
        odoo_session_id: int,
        counted_cash: float | None,
        closing_notes: str | None,
        bank_payment_method_diff_pairs: list[tuple[int, float]],
    ) -> dict[str, Any]:
        return await self._post(
            "/api/microservice/pos/sessions/close",
            {
                "session_id": odoo_session_id,
                "counted_cash": counted_cash,
                "closing_notes": closing_notes,
                "bank_payment_method_diff_pairs": bank_payment_method_diff_pairs,
            },
            odoo_access_token,
        )

    async def _post(self, path: str, payload: dict[str, Any], token: str) -> dict[str, Any]:
        try:
            response = await self._client.post(path, json=payload, headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Odoo POS request failed: {exc}") from exc

        try:
            body = response.json()
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Odoo returned non-JSON response.") from exc

        data = body.get("result") if isinstance(body, dict) else None
        if isinstance(data, dict):
            body = data
        if response.status_code >= 400 or not body.get("success", False):
            message = body.get("message") or body.get("detail") or "Odoo POS API rejected request."
            status_code = status.HTTP_401_UNAUTHORIZED if response.status_code == 401 else status.HTTP_502_BAD_GATEWAY
            raise HTTPException(status_code=status_code, detail=str(message))

        result = body.get("data", body)
        if not isinstance(result, dict):
            raise HTTPException(status_code=502, detail="Odoo POS API returned unexpected payload.")
        return result
