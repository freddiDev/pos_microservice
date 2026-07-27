from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.dependencies import get_current_context
from app.domain.models import Device, User
from app.domain.schemas import UserOut
from app.services.auth_service import user_out

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me", response_model=UserOut)
async def me(context: Annotated[tuple[User, Device], Depends(get_current_context)]) -> UserOut:
    user, _device = context
    return user_out(user)
