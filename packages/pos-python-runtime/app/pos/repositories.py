import hashlib
import json
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import utc_now
from app.pos import models


class PosConfigRepository:
    async def list_configs(self, session: AsyncSession) -> list[models.PosConfig]:
        result = await session.scalars(select(models.PosConfig).where(models.PosConfig.active.is_(True)).order_by(models.PosConfig.name))
        return list(result)

    async def get_by_odoo_id(self, session: AsyncSession, odoo_config_id: int) -> models.PosConfig | None:
        return await session.scalar(select(models.PosConfig).where(models.PosConfig.odoo_config_id == odoo_config_id))

    async def upsert_config(self, session: AsyncSession, payload: dict[str, Any]) -> models.PosConfig:
        payload = _sanitize_config_payload(payload)
        odoo_config_id = int(payload["odoo_config_id"])
        config = await self.get_by_odoo_id(session, odoo_config_id)
        values = {
            "odoo_uuid": _none_false(payload.get("odoo_uuid")),
            "name": payload.get("name") or f"POS {odoo_config_id}",
            "active": bool(payload.get("active", True)),
            "company_odoo_id": _int_or_none(payload.get("company_odoo_id")),
            "warehouse_odoo_id": _int_or_none(payload.get("warehouse_odoo_id")),
            "picking_type_odoo_id": _int_or_none(payload.get("picking_type_odoo_id")),
            "journal_odoo_id": _int_or_none(payload.get("journal_odoo_id")),
            "invoice_journal_odoo_id": _int_or_none(payload.get("invoice_journal_odoo_id")),
            "currency_odoo_id": _int_or_none(payload.get("currency_odoo_id")),
            "pricelist_odoo_id": _int_or_none(payload.get("pricelist_odoo_id")),
            "cash_control": bool(payload.get("cash_control")),
            "set_maximum_difference": bool(payload.get("set_maximum_difference")),
            "amount_authorized_diff": _float_or_none(payload.get("amount_authorized_diff")),
            "iface_tax_included": _none_false(payload.get("iface_tax_included")),
            "module_pos_restaurant": bool(payload.get("module_pos_restaurant")),
            "current_session_odoo_id": _int_or_none(payload.get("current_session_odoo_id")),
            "current_session_state": _none_false(payload.get("current_session_state")),
            "current_user_odoo_id": _int_or_none(payload.get("current_user_odoo_id")),
            "current_user_name": _none_false(payload.get("current_user_name")),
            "write_date": _datetime_or_none(payload.get("write_date")),
            "synced_at": utc_now(),
            "raw_odoo_payload": payload,
        }
        if config:
            for key, value in values.items():
                setattr(config, key, value)
        else:
            config = models.PosConfig(odoo_config_id=odoo_config_id, **values)
            session.add(config)
            await session.flush()
        await self._sync_payment_methods(session, config, payload.get("payment_methods") or [])
        return config

    async def _sync_payment_methods(self, session: AsyncSession, config: models.PosConfig, payment_methods: list[dict[str, Any]]) -> None:
        await session.execute(delete(models.PosConfigPaymentMethod).where(models.PosConfigPaymentMethod.pos_config_id == config.id))
        for item in payment_methods:
            method_id = _int_or_none(item.get("odoo_payment_method_id") or item.get("id"))
            if method_id is None:
                continue
            method = await session.scalar(
                select(models.PosPaymentMethod).where(models.PosPaymentMethod.odoo_payment_method_id == method_id)
            )
            values = {
                "name": item.get("name") or f"Payment {method_id}",
                "type": _none_false(item.get("type")),
                "is_cash_count": bool(item.get("is_cash_count")),
                "split_transactions": bool(item.get("split_transactions")),
                "journal_odoo_id": _int_or_none(item.get("journal_odoo_id")),
                "active": bool(item.get("active", True)),
                "raw_odoo_payload": item,
            }
            if method:
                for key, value in values.items():
                    setattr(method, key, value)
            else:
                method = models.PosPaymentMethod(odoo_payment_method_id=method_id, **values)
                session.add(method)
                await session.flush()
            session.add(
                models.PosConfigPaymentMethod(
                    pos_config_id=config.id,
                    payment_method_id=method.id,
                    odoo_config_id=config.odoo_config_id,
                    odoo_payment_method_id=method.odoo_payment_method_id,
                )
            )


class PosSessionRepository:
    async def get_by_odoo_id(self, session: AsyncSession, odoo_session_id: int) -> models.PosSession | None:
        return await session.scalar(select(models.PosSession).where(models.PosSession.odoo_session_id == odoo_session_id))

    async def current_for_config(self, session: AsyncSession, odoo_config_id: int) -> models.PosSession | None:
        return await session.scalar(
            select(models.PosSession)
            .where(
                models.PosSession.odoo_config_id == odoo_config_id,
                models.PosSession.state.in_(["opening_control", "opened", "closing_control", "post_verification"]),
                models.PosSession.rescue.is_(False),
            )
            .order_by(models.PosSession.updated_at.desc())
            .limit(1)
        )

    async def upsert_session(
        self,
        session: AsyncSession,
        payload: dict[str, Any],
        *,
        config: models.PosConfig | None,
        user_id: str | None,
        device_id: str | None,
        device_code: str | None,
        odoo_user_id: int | None,
    ) -> models.PosSession:
        odoo_session_id = int(payload["odoo_session_id"])
        row = await self.get_by_odoo_id(session, odoo_session_id)
        values = {
            "pos_config_id": config.id if config else None,
            "odoo_config_id": _int_or_none(payload.get("odoo_config_id") or payload.get("config_id")) or 0,
            "name": _none_false(payload.get("name")),
            "state": payload.get("state") or "opened",
            "service_status": _service_status(payload.get("state")),
            "user_id": user_id,
            "odoo_user_id": odoo_user_id,
            "device_id": device_id,
            "device_code": device_code,
            "company_odoo_id": _int_or_none(payload.get("company_odoo_id")),
            "warehouse_odoo_id": _int_or_none(payload.get("warehouse_odoo_id")),
            "currency_odoo_id": _int_or_none(payload.get("currency_odoo_id")),
            "start_at": _datetime_or_none(payload.get("start_at")),
            "stop_at": _datetime_or_none(payload.get("stop_at")),
            "opening_notes": _none_false(payload.get("opening_notes")),
            "closing_notes": _none_false(payload.get("closing_notes")),
            "cash_register_balance_start": _float_or_none(payload.get("cash_register_balance_start")),
            "cash_register_balance_end_real": _float_or_none(payload.get("cash_register_balance_end_real")),
            "cash_register_balance_end": _float_or_none(payload.get("cash_register_balance_end")),
            "cash_register_difference": _float_or_none(payload.get("cash_register_difference")),
            "total_payments_amount": _float_or_none(payload.get("total_payments_amount")),
            "order_count": _int_or_none(payload.get("order_count")) or 0,
            "login_number": _int_or_none(payload.get("login_number")) or 0,
            "sequence_number": _int_or_none(payload.get("sequence_number")) or 0,
            "rescue": bool(payload.get("rescue")),
            "move_odoo_id": _int_or_none(payload.get("move_odoo_id")),
            "write_date": _datetime_or_none(payload.get("write_date")),
            "synced_at": utc_now(),
            "raw_odoo_payload": payload,
        }
        if row:
            for key, value in values.items():
                setattr(row, key, value)
        else:
            row = models.PosSession(odoo_session_id=odoo_session_id, **values)
            session.add(row)
            await session.flush()
        await self.touch_device(session, row, user_id=user_id, device_id=device_id, device_code=device_code, odoo_user_id=odoo_user_id)
        return row

    async def touch_device(
        self,
        session: AsyncSession,
        pos_session: models.PosSession,
        *,
        user_id: str | None,
        device_id: str | None,
        device_code: str | None,
        odoo_user_id: int | None,
    ) -> None:
        if not device_id:
            return
        row = await session.scalar(
            select(models.PosSessionDevice)
            .where(models.PosSessionDevice.session_id == pos_session.id, models.PosSessionDevice.device_id == device_id)
            .limit(1)
        )
        values = {
            "device_code": device_code,
            "user_id": user_id,
            "odoo_user_id": odoo_user_id,
            "status": "active",
            "last_heartbeat_at": utc_now(),
        }
        if row:
            for key, value in values.items():
                setattr(row, key, value)
        else:
            session.add(models.PosSessionDevice(session_id=pos_session.id, device_id=device_id, **values))

    async def event(
        self,
        session: AsyncSession,
        *,
        event_type: str,
        pos_session: models.PosSession | None = None,
        actor_user_id: str | None = None,
        device_id: str | None = None,
        request_id: str | None = None,
        payload: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        session.add(
            models.PosSessionEvent(
                session_id=pos_session.id if pos_session else None,
                odoo_session_id=pos_session.odoo_session_id if pos_session else None,
                event_type=event_type,
                actor_user_id=actor_user_id,
                device_id=device_id,
                request_id=request_id,
                payload_json=payload or {},
                result_json=result or {},
            )
        )


class IdempotencyRepository:
    async def get_completed(self, session: AsyncSession, key: str, request_hash: str) -> models.IdempotencyKey | None:
        row = await session.scalar(select(models.IdempotencyKey).where(models.IdempotencyKey.idempotency_key == key))
        if not row or row.request_hash != request_hash or row.status != "completed":
            return None
        return row

    async def store_completed(
        self,
        session: AsyncSession,
        *,
        key: str,
        actor_user_id: str | None,
        device_id: str | None,
        method: str,
        path: str,
        request_body: dict[str, Any],
        response_status: int,
        response_body: dict[str, Any],
    ) -> None:
        request_hash = hash_request(request_body)
        row = await session.scalar(select(models.IdempotencyKey).where(models.IdempotencyKey.idempotency_key == key))
        values = {
            "actor_user_id": actor_user_id,
            "device_id": device_id,
            "method": method,
            "path": path,
            "request_hash": request_hash,
            "response_status": response_status,
            "response_body": response_body,
            "status": "completed",
            "expires_at": utc_now() + timedelta(days=1),
        }
        if row:
            for field, value in values.items():
                setattr(row, field, value)
        else:
            session.add(models.IdempotencyKey(idempotency_key=key, **values))


def hash_request(body: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")).hexdigest()


def _sanitize_config_payload(payload: dict[str, Any]) -> dict[str, Any]:
    sanitized = dict(payload)
    cashiers = sanitized.get("cashiers")
    if not isinstance(cashiers, list):
        return sanitized

    sanitized_cashiers: list[dict[str, Any]] = []
    for item in cashiers:
        if not isinstance(item, dict):
            continue
        cashier = dict(item)
        user_id = _int_or_none(cashier.get("odoo_user_id") or cashier.get("id"))
        pin = _none_false(cashier.pop("pos_pin", None))
        if user_id is not None and pin:
            cashier["pos_pin_hash"] = hashlib.sha256(f"{user_id}:{pin}".encode("utf-8")).hexdigest()
            cashier["has_pos_pin"] = True
        sanitized_cashiers.append(cashier)

    sanitized["cashiers"] = sanitized_cashiers
    return sanitized


def _none_false(value: Any) -> str | None:
    if value is None or value is False:
        return None
    return str(value)


def _int_or_none(value: Any) -> int | None:
    if value is None or value is False:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    parsed = str(value).strip()
    return int(parsed) if parsed else None


def _float_or_none(value: Any) -> float | None:
    if value is None or value is False:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    parsed = str(value).strip()
    return float(parsed) if parsed else None


def _datetime_or_none(value: Any):
    if value is None or value is False:
        return None
    if hasattr(value, "isoformat"):
        return value
    text = str(value).strip()
    if not text:
        return None
    from datetime import datetime

    return datetime.fromisoformat(text.replace("Z", "+00:00").replace(" ", "T"))


def _service_status(state: Any) -> str:
    if state == "closed":
        return "synced"
    if state == "post_verification":
        return "close_requested"
    return "active"
