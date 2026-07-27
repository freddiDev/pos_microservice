from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class DeviceLogin(BaseModel):
    device_code: str = Field(..., min_length=3, max_length=128)
    device_name: str | None = Field(default=None, max_length=255)
    platform: str | None = Field(default=None, max_length=64)
    app_version: str | None = Field(default=None, max_length=64)
    pos_config_odoo_id: int | None = None
    public_key: str | None = None


class LoginRequest(DeviceLogin):
    login: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=1, max_length=255)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(..., min_length=20)


class LogoutRequest(BaseModel):
    refresh_token: str | None = None


class UserOut(BaseModel):
    id: str
    odoo_user_id: int
    login: str
    name: str
    role: str
    company_odoo_id: int | None
    warehouse_odoo_id: int | None
    partner_odoo_id: int | None
    allowed_pos_configs: list[dict[str, Any]]


class DeviceOut(BaseModel):
    id: str
    device_code: str
    device_name: str | None
    platform: str | None
    app_version: str | None
    pos_config_odoo_id: int | None
    warehouse_odoo_id: int | None
    status: str
    last_seen_at: datetime | None


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserOut
    device: DeviceOut


class MessageResponse(BaseModel):
    success: bool = True
    message: str


class InternalAuthContext(BaseModel):
    user_id: str
    device_id: str
    odoo_user_id: int
    login: str
    name: str
    role: str
    company_odoo_id: int | None
    warehouse_odoo_id: int | None
    pos_config_odoo_id: int | None
    device_code: str
    odoo_access_token: str
