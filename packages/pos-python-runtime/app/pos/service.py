from decimal import Decimal
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import utc_now
from app.pos import models
from app.pos.auth_client import AuthContextClient
from app.pos.odoo_client import OdooPosClient
from app.pos.repositories import IdempotencyRepository, PosConfigRepository, PosSessionRepository, hash_request
from app.pos.schemas import (
    AuthPrincipal,
    CloseSessionOut,
    CloseSessionRequest,
    ClosingControlOut,
    OpenSessionRequest,
    OpeningCashRequest,
    PosCashierOut,
    PosConfigListOut,
    PosConfigOut,
    PosPaymentMethodOut,
    PosSessionOut,
)


class PosService:
    def __init__(self, auth_client: AuthContextClient, odoo_client: OdooPosClient):
        self._auth_client = auth_client
        self._odoo_client = odoo_client
        self._configs = PosConfigRepository()
        self._sessions = PosSessionRepository()
        self._idempotency = IdempotencyRepository()

    async def list_configs(self, db: AsyncSession, bearer_token: str) -> PosConfigListOut:
        principal = await self._auth_client.resolve(bearer_token)
        items = await self._odoo_client.list_configs(principal.odoo_access_token)
        configs = []
        for item in items:
            config = await self._configs.upsert_config(db, item)
            session_payload = await self._sync_config_session(db, principal, config, item)
            configs.append(_config_out(config, item.get("payment_methods") or [], session=session_payload))
        await db.commit()
        return PosConfigListOut(items=configs)

    async def get_config(self, db: AsyncSession, bearer_token: str, odoo_config_id: int) -> PosConfigOut:
        principal = await self._auth_client.resolve(bearer_token)
        items = await self._odoo_client.list_configs(principal.odoo_access_token)
        selected = next((item for item in items if int(item.get("odoo_config_id") or 0) == odoo_config_id), None)
        if not selected:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="POS config not found.")
        config = await self._configs.upsert_config(db, selected)
        session_payload = await self._sync_config_session(db, principal, config, selected)
        await db.commit()
        return _config_out(config, selected.get("payment_methods") or [], session=session_payload)

    async def open_session(
        self,
        db: AsyncSession,
        bearer_token: str,
        request: OpenSessionRequest,
        *,
        idempotency_key: str | None = None,
    ) -> PosSessionOut:
        principal = await self._auth_client.resolve(bearer_token)
        request_body = request.model_dump()
        request_hash = hash_request(request_body)
        if idempotency_key:
            completed = await self._idempotency.get_completed(db, idempotency_key, request_hash)
            if completed and completed.response_body:
                return PosSessionOut.model_validate(completed.response_body["session"])

        config = await self._sync_single_config(db, principal, request.pos_config)
        odoo_session = await self._odoo_client.open_session(
            principal.odoo_access_token,
            odoo_config_id=request.pos_config,
            opening_cash=request.opening_cash,
            opening_notes=request.opening_notes,
        )
        session_row = await self._sessions.upsert_session(
            db,
            _session_payload(odoo_session),
            config=config,
            user_id=principal.user_id,
            device_id=principal.device_id,
            device_code=principal.device_code,
            odoo_user_id=principal.odoo_user_id,
        )
        await self._sessions.event(
            db,
            event_type="session_opened_or_reused",
            pos_session=session_row,
            actor_user_id=principal.user_id,
            device_id=principal.device_id,
            payload=request_body,
            result=odoo_session,
        )
        output = _session_out(session_row)
        if idempotency_key:
            await self._idempotency.store_completed(
                db,
                key=idempotency_key,
                actor_user_id=principal.user_id,
                device_id=principal.device_id,
                method="POST",
                path="/api/v1/pos/sessions",
                request_body=request_body,
                response_status=200,
                response_body={"session": output.model_dump(mode="json")},
            )
        await db.commit()
        return output

    async def current_session(self, db: AsyncSession, bearer_token: str, odoo_config_id: int) -> PosSessionOut:
        principal = await self._auth_client.resolve(bearer_token)
        config = await self._sync_single_config(db, principal, odoo_config_id)
        row = await self._sessions.current_for_config(db, config.odoo_config_id)
        if not row:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active POS session for config.")
        detail = _session_payload(await self._odoo_client.session_detail(principal.odoo_access_token, odoo_session_id=row.odoo_session_id))
        row = await self._sessions.upsert_session(
            db,
            detail,
            config=config,
            user_id=principal.user_id,
            device_id=principal.device_id,
            device_code=principal.device_code,
            odoo_user_id=principal.odoo_user_id,
        )
        await db.commit()
        return _session_out(row)

    async def session_detail(self, db: AsyncSession, bearer_token: str, odoo_session_id: int) -> PosSessionOut:
        principal = await self._auth_client.resolve(bearer_token)
        detail = _session_payload(await self._odoo_client.session_detail(principal.odoo_access_token, odoo_session_id=odoo_session_id))
        config = await self._sync_single_config(db, principal, int(detail.get("odoo_config_id") or detail.get("config_id")))
        row = await self._sessions.upsert_session(
            db,
            detail,
            config=config,
            user_id=principal.user_id,
            device_id=principal.device_id,
            device_code=principal.device_code,
            odoo_user_id=principal.odoo_user_id,
        )
        await db.commit()
        return _session_out(row)

    async def opening_cash(self, db: AsyncSession, bearer_token: str, odoo_session_id: int, request: OpeningCashRequest) -> PosSessionOut:
        principal = await self._auth_client.resolve(bearer_token)
        detail = _session_payload(await self._odoo_client.opening_cash(
            principal.odoo_access_token,
            odoo_session_id=odoo_session_id,
            counted_cash=request.counted_cash,
            opening_notes=request.opening_notes,
        ))
        config = await self._sync_single_config(db, principal, int(detail.get("odoo_config_id") or detail.get("config_id")))
        row = await self._sessions.upsert_session(
            db,
            detail,
            config=config,
            user_id=principal.user_id,
            device_id=principal.device_id,
            device_code=principal.device_code,
            odoo_user_id=principal.odoo_user_id,
        )
        await self._sessions.event(db, event_type="opening_cash_set", pos_session=row, actor_user_id=principal.user_id, device_id=principal.device_id, payload=request.model_dump(), result=detail)
        await db.commit()
        return _session_out(row)

    async def closing_control(self, db: AsyncSession, bearer_token: str, odoo_session_id: int) -> ClosingControlOut:
        principal = await self._auth_client.resolve(bearer_token)
        data = await self._odoo_client.closing_control(principal.odoo_access_token, odoo_session_id=odoo_session_id)
        row = await self._sessions.get_by_odoo_id(db, odoo_session_id)
        if row:
            await self._sessions.event(db, event_type="closing_control_loaded", pos_session=row, actor_user_id=principal.user_id, device_id=principal.device_id, result=data)
            await db.commit()
        return _closing_out(odoo_session_id, data)

    async def close_session(
        self,
        db: AsyncSession,
        bearer_token: str,
        odoo_session_id: int,
        request: CloseSessionRequest,
        *,
        idempotency_key: str | None = None,
    ) -> CloseSessionOut:
        principal = await self._auth_client.resolve(bearer_token)
        request_body = request.model_dump()
        request_hash = hash_request(request_body)
        if idempotency_key:
            completed = await self._idempotency.get_completed(db, idempotency_key, request_hash)
            if completed and completed.response_body:
                return CloseSessionOut.model_validate(completed.response_body)

        close_result = await self._odoo_client.close_session(
            principal.odoo_access_token,
            odoo_session_id=odoo_session_id,
            counted_cash=request.counted_cash,
            closing_notes=request.closing_notes,
            bank_payment_method_diff_pairs=request.bank_payment_method_diff_pairs,
        )
        detail = _session_payload(close_result.get("session") or await self._odoo_client.session_detail(principal.odoo_access_token, odoo_session_id=odoo_session_id))
        config = await self._sync_single_config(db, principal, int(detail.get("odoo_config_id") or detail.get("config_id")))
        row = await self._sessions.upsert_session(
            db,
            detail,
            config=config,
            user_id=principal.user_id,
            device_id=principal.device_id,
            device_code=principal.device_code,
            odoo_user_id=principal.odoo_user_id,
        )
        await self._sessions.event(db, event_type="close_requested", pos_session=row, actor_user_id=principal.user_id, device_id=principal.device_id, payload=request_body, result=close_result)
        output = CloseSessionOut(
            successful=bool(close_result.get("successful", True)),
            message=close_result.get("message"),
            redirect=bool(close_result.get("redirect", False)),
            session=_session_out(row),
        )
        if idempotency_key:
            await self._idempotency.store_completed(
                db,
                key=idempotency_key,
                actor_user_id=principal.user_id,
                device_id=principal.device_id,
                method="POST",
                path=f"/api/v1/pos/sessions/{odoo_session_id}/close",
                request_body=request_body,
                response_status=200,
                response_body=output.model_dump(mode="json"),
            )
        await db.commit()
        return output

    async def heartbeat(self, db: AsyncSession, bearer_token: str, odoo_session_id: int) -> None:
        principal = await self._auth_client.resolve(bearer_token)
        row = await self._sessions.get_by_odoo_id(db, odoo_session_id)
        if not row:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="POS session not found.")
        await self._sessions.touch_device(db, row, user_id=principal.user_id, device_id=principal.device_id, device_code=principal.device_code, odoo_user_id=principal.odoo_user_id)
        await db.commit()

    async def _sync_single_config(self, db: AsyncSession, principal: AuthPrincipal, odoo_config_id: int) -> models.PosConfig:
        items = await self._odoo_client.list_configs(principal.odoo_access_token)
        selected = next((item for item in items if int(item.get("odoo_config_id") or 0) == odoo_config_id), None)
        if not selected:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="POS config not allowed or not found.")
        return await self._configs.upsert_config(db, selected)

    async def _sync_config_session(
        self,
        db: AsyncSession,
        principal: AuthPrincipal,
        config: models.PosConfig,
        item: dict[str, Any],
    ) -> dict[str, Any] | None:
        payload = _config_session_payload(item)
        if payload is None:
            return None

        session_id = _int_or_none(payload.get("odoo_session_id") or payload.get("id"))
        if session_id is not None and "odoo_session_id" not in payload:
            payload["odoo_session_id"] = session_id
        payload["odoo_config_id"] = _int_or_none(payload.get("odoo_config_id") or payload.get("config_id")) or config.odoo_config_id
        payload["state"] = _none_false(payload.get("state")) or config.current_session_state or "opened"

        if session_id is not None and not _has_complete_session_payload(payload):
            try:
                detail = _session_payload(
                    await self._odoo_client.session_detail(
                        principal.odoo_access_token,
                        odoo_session_id=session_id,
                    )
                )
                payload.update(detail)
                payload["odoo_session_id"] = _int_or_none(payload.get("odoo_session_id") or payload.get("id")) or session_id
                payload["odoo_config_id"] = _int_or_none(payload.get("odoo_config_id") or payload.get("config_id")) or config.odoo_config_id
                payload["state"] = _none_false(payload.get("state")) or config.current_session_state or "opened"
            except HTTPException:
                payload.setdefault("opened_by", config.current_user_name)
                payload.setdefault("odoo_user_id", config.current_user_odoo_id)

        if _int_or_none(payload.get("odoo_session_id")) is not None:
            await self._sessions.upsert_session(
                db,
                payload,
                config=config,
                user_id=None,
                device_id=None,
                device_code=None,
                odoo_user_id=_int_or_none(payload.get("odoo_user_id")) or config.current_user_odoo_id,
            )

        return _mobile_session_dict(payload, config)


def _config_out(
    config: models.PosConfig,
    payment_methods: list[dict[str, Any]] | None = None,
    *,
    session: dict[str, Any] | None = None,
) -> PosConfigOut:
    raw = config.raw_odoo_payload or {}
    return PosConfigOut(
        id=config.id,
        odoo_config_id=config.odoo_config_id,
        odoo_uuid=config.odoo_uuid,
        name=config.name,
        active=config.active,
        company_odoo_id=config.company_odoo_id,
        company_name=_none_false(raw.get("company_name")),
        warehouse_odoo_id=config.warehouse_odoo_id,
        warehouse_name=_none_false(raw.get("warehouse_name") or raw.get("warehouse")),
        picking_type_odoo_id=config.picking_type_odoo_id,
        journal_odoo_id=config.journal_odoo_id,
        invoice_journal_odoo_id=config.invoice_journal_odoo_id,
        currency_odoo_id=config.currency_odoo_id,
        pricelist_odoo_id=config.pricelist_odoo_id,
        cash_control=config.cash_control,
        set_maximum_difference=config.set_maximum_difference,
        amount_authorized_diff=_float(config.amount_authorized_diff),
        iface_tax_included=config.iface_tax_included,
        module_pos_restaurant=config.module_pos_restaurant,
        current_session_odoo_id=config.current_session_odoo_id,
        current_session_state=config.current_session_state,
        current_user_odoo_id=config.current_user_odoo_id,
        current_user_name=config.current_user_name,
        session=session,
        payment_methods=[_payment_out(item) for item in (payment_methods or [])],
        cashiers=[_cashier_out(item) for item in (raw.get("cashiers") or [])],
        write_date=config.write_date,
        synced_at=config.synced_at,
    )


def _payment_out(item: dict[str, Any]) -> PosPaymentMethodOut:
    return PosPaymentMethodOut(
        odoo_payment_method_id=int(item.get("odoo_payment_method_id") or item.get("id")),
        name=item.get("name") or "",
        type=item.get("type"),
        is_cash_count=bool(item.get("is_cash_count")),
        split_transactions=bool(item.get("split_transactions")),
        active=bool(item.get("active", True)),
    )


def _cashier_out(item: dict[str, Any]) -> PosCashierOut:
    user_id = int(item.get("odoo_user_id") or item.get("id"))
    return PosCashierOut(
        id=user_id,
        odoo_user_id=user_id,
        name=item.get("name") or f"Cashier {user_id}",
        login=_none_false(item.get("login")),
        avatar=_none_false(item.get("avatar")),
        has_pos_pin=bool(item.get("has_pos_pin")),
    )


def _session_out(row: models.PosSession) -> PosSessionOut:
    raw = row.raw_odoo_payload or {}
    return PosSessionOut(
        id=row.id,
        odoo_session_id=row.odoo_session_id,
        odoo_config_id=row.odoo_config_id,
        name=row.name,
        state=row.state,
        service_status=row.service_status,
        user_id=row.user_id,
        opened_by=_none_false(raw.get("opened_by") or raw.get("user_name")),
        odoo_user_id=row.odoo_user_id,
        device_id=row.device_id,
        device_code=row.device_code,
        company_odoo_id=row.company_odoo_id,
        warehouse_odoo_id=row.warehouse_odoo_id,
        currency_odoo_id=row.currency_odoo_id,
        start_at=row.start_at,
        stop_at=row.stop_at,
        opening_notes=row.opening_notes,
        closing_notes=row.closing_notes,
        cash_register_balance_start=_float(row.cash_register_balance_start),
        cash_register_balance_end_real=_float(row.cash_register_balance_end_real),
        cash_register_balance_end=_float(row.cash_register_balance_end),
        cash_register_difference=_float(row.cash_register_difference),
        total_payments_amount=_float(row.total_payments_amount),
        total_sales_cash=_float(raw.get("total_sales_cash")),
        total_sales_bank=_float(raw.get("total_sales_bank")),
        order_count=row.order_count,
        login_number=row.login_number,
        sequence_number=row.sequence_number,
        rescue=row.rescue,
        move_odoo_id=row.move_odoo_id,
        write_date=row.write_date,
        synced_at=row.synced_at,
    )


def _session_payload(data: dict[str, Any]) -> dict[str, Any]:
    if "session" in data and isinstance(data["session"], dict):
        return data["session"]
    return data


def _config_session_payload(item: dict[str, Any]) -> dict[str, Any] | None:
    raw = item.get("session")
    if isinstance(raw, dict) and raw:
        return dict(raw)

    session_id = _int_or_none(item.get("current_session_odoo_id"))
    state = _none_false(item.get("current_session_state"))
    if session_id is None or state is None:
        return None

    return {
        "odoo_session_id": session_id,
        "odoo_config_id": _int_or_none(item.get("odoo_config_id")),
        "state": state,
        "odoo_user_id": _int_or_none(item.get("current_user_odoo_id")),
        "opened_by": _none_false(item.get("current_user_name")),
    }


def _has_complete_session_payload(payload: dict[str, Any]) -> bool:
    return any(
        _none_false(payload.get(key)) is not None
        for key in (
            "start_at",
            "stop_at",
            "closed_at",
            "cash_register_balance_start",
            "total_sales_cash",
            "total_payments_amount",
        )
    )


def _mobile_session_dict(payload: dict[str, Any], config: models.PosConfig) -> dict[str, Any]:
    session_id = _int_or_none(payload.get("odoo_session_id") or payload.get("id"))
    config_id = _int_or_none(payload.get("odoo_config_id") or payload.get("config_id")) or config.odoo_config_id
    stop_at = _none_false(payload.get("stop_at") or payload.get("closed_at"))
    total_sales_cash = _float(payload.get("total_sales_cash"))
    if total_sales_cash is None:
        total_sales_cash = _float(payload.get("total_payments_amount"))

    return {
        "id": session_id,
        "odoo_session_id": session_id,
        "config_id": config_id,
        "odoo_config_id": config_id,
        "opened_by": _none_false(payload.get("opened_by") or payload.get("user_name")) or config.current_user_name or "-",
        "move_id": payload.get("move_odoo_id") or payload.get("move_id"),
        "start_at": _none_false(payload.get("start_at")),
        "closed_at": stop_at,
        "stop_at": stop_at,
        "cash_register_balance_start": _float(payload.get("cash_register_balance_start")) or 0,
        "total_sales_cash": total_sales_cash or 0,
        "total_sales_bank": _float(payload.get("total_sales_bank")) or 0,
        "state": _none_false(payload.get("state")) or config.current_session_state or "not_open",
    }


def _closing_out(odoo_session_id: int, data: dict[str, Any]) -> ClosingControlOut:
    cash = data.get("default_cash_details") or {}
    orders = data.get("orders_details") or {}
    return ClosingControlOut(
        odoo_session_id=odoo_session_id,
        default_cash_payment_method_odoo_id=cash.get("id"),
        expected_cash=_float(cash.get("amount")),
        opening_cash=_float(cash.get("opening")),
        payment_amount=_float(cash.get("payment_amount")),
        orders_count=int(orders.get("quantity") or 0),
        orders_amount=_float(orders.get("amount")),
        other_payment_methods=data.get("other_payment_methods") or [],
        raw_closing_data=data,
    )


def _float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if value is False:
        return None
    return float(value)


def _int_or_none(value: Any) -> int | None:
    if value is None or value is False:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _none_false(value: Any) -> str | None:
    if value is None or value is False:
        return None
    text = str(value).strip()
    return text or None
