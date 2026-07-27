from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import bearer_scheme, get_app_settings
from app.core.config import Settings
from app.core.database import get_db
from app.pos.auth_client import AuthContextClient
from app.pos.odoo_client import OdooPosClient
from app.pos.schemas import (
    CloseSessionOut,
    CloseSessionRequest,
    ClosingControlOut,
    HeartbeatOut,
    OpenSessionRequest,
    OpeningCashRequest,
    PosConfigListOut,
    PosConfigOut,
    PosSessionOut,
)
from app.pos.service import PosService

router = APIRouter(tags=["pos"])


def get_pos_service(settings: Annotated[Settings, Depends(get_app_settings)], request: Request) -> PosService:
    return PosService(
        AuthContextClient(settings, request.app.state.auth_http),
        OdooPosClient(request.app.state.odoo_http),
    )


def bearer_token(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)]) -> str:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token.")
    return credentials.credentials


@router.get("/pos-configs", response_model=PosConfigListOut)
async def list_pos_configs(
    db: Annotated[AsyncSession, Depends(get_db)],
    token: Annotated[str, Depends(bearer_token)],
    service: Annotated[PosService, Depends(get_pos_service)],
) -> PosConfigListOut:
    return await service.list_configs(db, token)


@router.get("/pos-configs/{odoo_config_id}", response_model=PosConfigOut)
async def get_pos_config(
    odoo_config_id: int,
    db: Annotated[AsyncSession, Depends(get_db)],
    token: Annotated[str, Depends(bearer_token)],
    service: Annotated[PosService, Depends(get_pos_service)],
) -> PosConfigOut:
    return await service.get_config(db, token, odoo_config_id)


@router.post("/pos/sessions", response_model=PosSessionOut)
async def open_pos_session(
    body: OpenSessionRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    token: Annotated[str, Depends(bearer_token)],
    service: Annotated[PosService, Depends(get_pos_service)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> PosSessionOut:
    return await service.open_session(db, token, body, idempotency_key=idempotency_key)


@router.get("/pos/sessions/current", response_model=PosSessionOut)
async def current_pos_session(
    pos_config: int,
    db: Annotated[AsyncSession, Depends(get_db)],
    token: Annotated[str, Depends(bearer_token)],
    service: Annotated[PosService, Depends(get_pos_service)],
) -> PosSessionOut:
    return await service.current_session(db, token, pos_config)


@router.get("/pos/sessions/{odoo_session_id}", response_model=PosSessionOut)
async def pos_session_detail(
    odoo_session_id: int,
    db: Annotated[AsyncSession, Depends(get_db)],
    token: Annotated[str, Depends(bearer_token)],
    service: Annotated[PosService, Depends(get_pos_service)],
) -> PosSessionOut:
    return await service.session_detail(db, token, odoo_session_id)


@router.get("/pos/sessions/{odoo_session_id}/closing-control", response_model=ClosingControlOut)
async def pos_session_closing_control(
    odoo_session_id: int,
    db: Annotated[AsyncSession, Depends(get_db)],
    token: Annotated[str, Depends(bearer_token)],
    service: Annotated[PosService, Depends(get_pos_service)],
) -> ClosingControlOut:
    return await service.closing_control(db, token, odoo_session_id)


@router.post("/pos/sessions/{odoo_session_id}/opening-cash", response_model=PosSessionOut)
async def pos_session_opening_cash(
    odoo_session_id: int,
    body: OpeningCashRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    token: Annotated[str, Depends(bearer_token)],
    service: Annotated[PosService, Depends(get_pos_service)],
) -> PosSessionOut:
    return await service.opening_cash(db, token, odoo_session_id, body)


@router.post("/pos/sessions/{odoo_session_id}/close", response_model=CloseSessionOut)
async def close_pos_session(
    odoo_session_id: int,
    body: CloseSessionRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    token: Annotated[str, Depends(bearer_token)],
    service: Annotated[PosService, Depends(get_pos_service)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> CloseSessionOut:
    return await service.close_session(db, token, odoo_session_id, body, idempotency_key=idempotency_key)


@router.post("/pos/sessions/{odoo_session_id}/heartbeat", response_model=HeartbeatOut)
async def pos_session_heartbeat(
    odoo_session_id: int,
    db: Annotated[AsyncSession, Depends(get_db)],
    token: Annotated[str, Depends(bearer_token)],
    service: Annotated[PosService, Depends(get_pos_service)],
) -> HeartbeatOut:
    await service.heartbeat(db, token, odoo_session_id)
    return HeartbeatOut()
