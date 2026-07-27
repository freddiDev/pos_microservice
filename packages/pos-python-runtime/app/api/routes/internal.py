from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, status

from app.api.dependencies import get_app_settings, get_current_context
from app.core.config import Settings
from app.domain.models import Device, User
from app.domain.schemas import InternalAuthContext
from app.services.auth_service import internal_context_out

router = APIRouter(prefix="/internal/auth", tags=["internal-auth"])


@router.get("/context", response_model=InternalAuthContext)
async def auth_context(
    context: Annotated[tuple[User, Device], Depends(get_current_context)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    internal_key: Annotated[str | None, Header(alias="X-Internal-Service-Key")] = None,
) -> InternalAuthContext:
    if not settings.internal_service_key or internal_key != settings.internal_service_key:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid internal service key.")
    user, device = context
    return internal_context_out(user, device)
