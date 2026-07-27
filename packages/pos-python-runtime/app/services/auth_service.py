from datetime import datetime, timedelta
import logging
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.security import create_access_token, ensure_utc, hash_token, new_refresh_token, utc_now
from app.domain.models import Device, RefreshToken, User
from app.domain.schemas import DeviceOut, InternalAuthContext, LoginRequest, TokenResponse, UserOut
from app.services.odoo_client import OdooAuthError, OdooClient, OdooClientError

_logger = logging.getLogger(__name__)


def _configs_from_user(user: User) -> list[dict[str, Any]]:
    data = user.allowed_pos_configs or {}
    configs = data.get("items", data if isinstance(data, list) else [])
    return configs if isinstance(configs, list) else []


def user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        odoo_user_id=user.odoo_user_id,
        login=user.login,
        name=user.name,
        role=user.role,
        company_odoo_id=user.company_odoo_id,
        warehouse_odoo_id=user.warehouse_odoo_id,
        partner_odoo_id=user.partner_odoo_id,
        allowed_pos_configs=_configs_from_user(user),
    )


def device_out(device: Device) -> DeviceOut:
    return DeviceOut(
        id=device.id,
        device_code=device.device_code,
        device_name=device.device_name,
        platform=device.platform,
        app_version=device.app_version,
        pos_config_odoo_id=device.pos_config_odoo_id,
        warehouse_odoo_id=device.warehouse_odoo_id,
        status=device.status,
        last_seen_at=device.last_seen_at,
    )


class AuthService:
    def __init__(self, settings: Settings, odoo_client: OdooClient):
        self._settings = settings
        self._odoo_client = odoo_client

    async def login(self, session: AsyncSession, request: LoginRequest) -> TokenResponse:
        try:
            odoo_data = await self._odoo_client.login(request.login, request.password, request.device_code)
        except OdooAuthError as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
        except OdooClientError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

        odoo_user = odoo_data.get("user") or {}
        if not odoo_user.get("odoo_user_id"):
            raise HTTPException(status_code=502, detail="Odoo login response is missing user identity.")

        user = await self._upsert_user(session, odoo_user, odoo_data)
        device = await self._upsert_device(session, request, user, odoo_data)
        await session.commit()
        await session.refresh(user)
        await session.refresh(device)
        return await self._issue_tokens(session, user, device)

    async def refresh(self, session: AsyncSession, refresh_token: str) -> TokenResponse:
        token_hash = hash_token(refresh_token)
        token = await session.scalar(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
        if not token or token.revoked_at or ensure_utc(token.expires_at) <= utc_now():
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token.")

        user = await session.get(User, token.user_id)
        device = await session.get(Device, token.device_id)
        if not user or not user.active or not device or device.status != "active":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Inactive user or device.")

        token.revoked_at = utc_now()
        await session.commit()
        return await self._issue_tokens(session, user, device)

    async def logout(self, session: AsyncSession, refresh_token: str | None) -> None:
        if not refresh_token:
            return
        token = await session.scalar(select(RefreshToken).where(RefreshToken.token_hash == hash_token(refresh_token)))
        if token and not token.revoked_at:
            device = await session.get(Device, token.device_id)
            odoo_access_token = device.odoo_access_token if device else None
            if odoo_access_token:
                try:
                    await self._odoo_client.logout(odoo_access_token)
                except OdooClientError:
                    _logger.warning("Failed to revoke Odoo POS token during logout.", exc_info=True)
            token.revoked_at = utc_now()
            await session.execute(
                update(RefreshToken)
                .where(RefreshToken.device_id == token.device_id, RefreshToken.revoked_at.is_(None))
                .values(revoked_at=utc_now())
            )
            if device and device.status == "active":
                device.status = "logged_out"
                device.last_seen_at = utc_now()
                device.odoo_access_token = None
                device.odoo_token_expires_at = None
            await session.commit()

    async def _upsert_user(self, session: AsyncSession, odoo_user: dict[str, Any], raw: dict[str, Any]) -> User:
        user = await session.scalar(select(User).where(User.odoo_user_id == int(odoo_user["odoo_user_id"])))
        allowed_configs = {"items": raw.get("allowed_pos_configs") or []}
        values = {
            "login": odoo_user.get("login") or "",
            "name": odoo_user.get("name") or odoo_user.get("login") or "",
            "role": odoo_user.get("role") or "cashier",
            "company_odoo_id": odoo_user.get("company_odoo_id"),
            "warehouse_odoo_id": odoo_user.get("warehouse_odoo_id"),
            "partner_odoo_id": odoo_user.get("partner_odoo_id"),
            "active": bool(odoo_user.get("active", True)),
            "allowed_pos_configs": allowed_configs,
            "raw_odoo_payload": raw,
        }
        if user:
            for key, value in values.items():
                setattr(user, key, value)
            return user

        user = User(odoo_user_id=int(odoo_user["odoo_user_id"]), **values)
        session.add(user)
        await session.flush()
        return user

    async def _upsert_device(self, session: AsyncSession, request: LoginRequest, user: User, odoo_data: dict[str, Any]) -> Device:
        device = await session.scalar(
            select(Device)
            .where(Device.device_code == request.device_code, Device.status == "active")
            .order_by(Device.created_at.desc())
            .limit(1)
        )
        values = {
            "device_name": request.device_name,
            "platform": request.platform,
            "app_version": request.app_version,
            "pos_config_odoo_id": request.pos_config_odoo_id,
            "warehouse_odoo_id": user.warehouse_odoo_id,
            "status": "active",
            "public_key": request.public_key,
            "odoo_access_token": odoo_data.get("odoo_access_token"),
            "odoo_token_expires_at": _parse_datetime(odoo_data.get("expires_at")),
            "last_user_id": user.id,
            "last_seen_at": utc_now(),
        }
        if device:
            for key, value in values.items():
                setattr(device, key, value)
            return device

        device = Device(device_code=request.device_code, **values)
        session.add(device)
        await session.flush()
        return device

    async def _issue_tokens(self, session: AsyncSession, user: User, device: Device) -> TokenResponse:
        refresh_token = new_refresh_token()
        expires_at = utc_now() + timedelta(days=self._settings.refresh_token_expire_days)
        session.add(
            RefreshToken(
                user_id=user.id,
                device_id=device.id,
                token_hash=hash_token(refresh_token),
                expires_at=expires_at,
            )
        )
        device.last_seen_at = utc_now()
        await session.commit()

        access_token = create_access_token(
            self._settings,
            subject=user.id,
            claims={
                "odoo_user_id": user.odoo_user_id,
                "device_id": device.id,
                "role": user.role,
            },
        )
        return TokenResponse(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in=self._settings.access_token_expire_minutes * 60,
            user=user_out(user),
            device=device_out(device),
        )


def internal_context_out(user: User, device: Device) -> InternalAuthContext:
    if not device.odoo_access_token:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Device has no active Odoo token.")
    return InternalAuthContext(
        user_id=user.id,
        device_id=device.id,
        odoo_user_id=user.odoo_user_id,
        login=user.login,
        name=user.name,
        role=user.role,
        company_odoo_id=user.company_odoo_id,
        warehouse_odoo_id=user.warehouse_odoo_id,
        pos_config_odoo_id=device.pos_config_odoo_id,
        device_code=device.device_code,
        odoo_access_token=device.odoo_access_token,
    )


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00").replace(" ", "T"))
    return None
