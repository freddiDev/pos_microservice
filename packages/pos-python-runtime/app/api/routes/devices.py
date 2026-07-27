from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import get_current_context
from app.core.database import get_db
from app.core.security import utc_now
from app.domain.models import Device, User
from app.domain.schemas import DeviceOut, MessageResponse
from app.services.auth_service import device_out

router = APIRouter(prefix="/devices", tags=["devices"])


@router.get("/me", response_model=DeviceOut)
async def me(context: Annotated[tuple[User, Device], Depends(get_current_context)]) -> DeviceOut:
    _user, device = context
    return device_out(device)


@router.post("/heartbeat", response_model=MessageResponse)
async def heartbeat(
    context: Annotated[tuple[User, Device], Depends(get_current_context)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> MessageResponse:
    _user, device = context
    device.last_seen_at = utc_now()
    await db.commit()
    return MessageResponse(message="Device heartbeat accepted.")
