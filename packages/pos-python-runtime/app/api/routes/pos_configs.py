from typing import Annotated, Any

from fastapi import APIRouter, Depends

from app.api.dependencies import get_current_context
from app.domain.models import Device, User
from app.services.auth_service import _configs_from_user

router = APIRouter(prefix="/pos-configs", tags=["pos-configs"])


@router.get("")
async def list_pos_configs(context: Annotated[tuple[User, Device], Depends(get_current_context)]) -> dict[str, list[dict[str, Any]]]:
    user, _device = context
    return {"items": _configs_from_user(user)}
