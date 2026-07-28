from fastapi import APIRouter, Request
from sqlalchemy import text

router = APIRouter(tags=["health"])


@router.get("/health/live")
async def live(request: Request) -> dict[str, str]:
    settings = request.app.state.settings
    return {"status": "ok", "service_role": settings.service_role}


@router.get("/health/ready")
async def ready(request: Request) -> dict[str, str]:
    settings = request.app.state.settings
    if settings.service_role in {"auth", "pos"}:
        async with request.app.state.db_session_factory() as db:
            await db.execute(text("SELECT 1"))
    if settings.service_role == "gateway":
        return {
            "status": "ready",
            "auth_upstream": str(settings.auth_service_url),
            "pos_upstream": str(settings.pos_service_url),
            "product_upstream": str(settings.product_service_url),
            "member_upstream": str(settings.member_service_url),
        }
    return {"status": "ready", "app": request.app.title}
