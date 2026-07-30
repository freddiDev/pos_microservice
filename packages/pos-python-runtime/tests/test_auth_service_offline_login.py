import pytest

from app.core.config import Settings
from app.core.database import build_engine, build_session_factory, init_database
from app.core.security import hash_password
from app.domain.models import User
from app.domain.schemas import LoginRequest
from app.services.auth_service import AuthService
from app.services.odoo_client import OdooClientError


class OfflineOdooClient:
    async def login(self, login: str, password: str, device_code: str | None = None) -> dict:
        raise OdooClientError("Odoo request failed: All connection attempts failed")


def settings() -> Settings:
    return Settings(
        app_name="Test Auth",
        environment="test",
        service_role="auth",
        api_prefix="/api/v1",
        database_url="sqlite+aiosqlite:///:memory:",
        jwt_secret_key="test-secret-value-with-at-least-32-bytes",
        jwt_algorithm="HS256",
        access_token_expire_minutes=5,
        refresh_token_expire_days=14,
        odoo_base_url="http://127.0.0.1:7073",
        auth_service_url="http://127.0.0.1:8011",
        pos_service_url="http://127.0.0.1:8012",
        internal_service_key="test-internal-key",
        request_timeout_seconds=10,
    )


@pytest.mark.asyncio
async def test_login_falls_back_to_local_password_hash_when_odoo_is_unreachable() -> None:
    engine = build_engine("sqlite+aiosqlite:///:memory:")
    await init_database(engine, "auth")
    session_factory = build_session_factory(engine)

    try:
        async with session_factory() as db:
            db.add(
                User(
                    odoo_user_id=7,
                    login="admin",
                    name="Admin",
                    role="cashier",
                    company_odoo_id=1,
                    warehouse_odoo_id=3,
                    active=True,
                    local_password_hash=hash_password("secret"),
                    allowed_pos_configs={"items": [{"odoo_config_id": 12, "name": "Main POS"}]},
                    raw_odoo_payload={},
                )
            )
            await db.commit()

        async with session_factory() as db:
            response = await AuthService(settings(), OfflineOdooClient()).login(
                db,
                LoginRequest(
                    login="admin",
                    password="secret",
                    device_code="device-1",
                    device_name="Tablet",
                    platform="android",
                    app_version="1.0.0",
                ),
            )

        assert response.access_token
        assert response.user.login == "admin"
        assert response.device.device_code == "device-1"
        assert response.device.warehouse_odoo_id == 3
    finally:
        await engine.dispose()
