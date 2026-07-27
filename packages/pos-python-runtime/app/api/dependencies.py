from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.database import get_db
from app.core.security import decode_access_token
from app.domain.models import Device, User
from app.services.auth_service import AuthService
from app.services.odoo_client import OdooClient

bearer_scheme = HTTPBearer(auto_error=False)


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_odoo_client(request: Request) -> OdooClient:
    return OdooClient(request.app.state.odoo_http)


def get_auth_service(settings: Annotated[Settings, Depends(get_app_settings)], odoo: Annotated[OdooClient, Depends(get_odoo_client)]) -> AuthService:
    return AuthService(settings, odoo)


async def get_current_context(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> tuple[User, Device]:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token.")
    try:
        payload = decode_access_token(settings, credentials.credentials)
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token.") from exc

    user = await db.get(User, payload.get("sub"))
    device = await db.get(Device, payload.get("device_id"))
    if not user or not user.active or not device or device.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Inactive user or device.")
    return user, device
