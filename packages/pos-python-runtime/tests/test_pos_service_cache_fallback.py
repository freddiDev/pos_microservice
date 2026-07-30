from fastapi import HTTPException
import pytest

from app.core.database import build_engine, build_session_factory, init_database
from app.pos.repositories import PosConfigRepository, PosSessionRepository
from app.pos.schemas import AuthPrincipal
from app.pos.service import PosService


class FakeAuthContextClient:
    async def resolve(self, bearer_token: str) -> AuthPrincipal:
        return AuthPrincipal(
            user_id="user-1",
            device_id="device-1",
            odoo_user_id=7,
            login="admin",
            name="Admin",
            role="cashier",
            company_odoo_id=1,
            warehouse_odoo_id=3,
            pos_config_odoo_id=12,
            device_code="device-code",
            odoo_access_token="cached-odoo-token",
        )


class OfflineOdooPosClient:
    async def list_configs(self, odoo_access_token: str) -> list[dict]:
        raise HTTPException(status_code=502, detail="Odoo POS upstream unavailable.")

    async def session_detail(self, odoo_access_token: str, *, odoo_session_id: int) -> dict:
        raise HTTPException(status_code=502, detail="Odoo POS upstream unavailable.")


@pytest.mark.asyncio
async def test_pos_service_uses_cached_config_and_session_when_odoo_is_down() -> None:
    engine = build_engine("sqlite+aiosqlite:///:memory:")
    await init_database(engine, "pos")
    session_factory = build_session_factory(engine)

    try:
        async with session_factory() as db:
            config = await PosConfigRepository().upsert_config(
                db,
                {
                    "odoo_config_id": 12,
                    "name": "Main POS",
                    "active": True,
                    "company_odoo_id": 1,
                    "warehouse_odoo_id": 3,
                    "current_session_odoo_id": 44,
                    "current_session_state": "opened",
                    "current_user_odoo_id": 7,
                    "current_user_name": "Admin",
                    "cashiers": [
                        {
                            "odoo_user_id": 7,
                            "name": "Admin",
                            "login": "admin",
                            "pos_pin": "1234",
                        }
                    ],
                    "payment_methods": [
                        {
                            "odoo_payment_method_id": 5,
                            "name": "Cash",
                            "type": "cash",
                            "is_cash_count": True,
                        }
                    ],
                },
            )
            await PosSessionRepository().upsert_session(
                db,
                {
                    "odoo_session_id": 44,
                    "odoo_config_id": 12,
                    "state": "opened",
                    "opened_by": "Admin",
                    "cash_register_balance_start": 0,
                },
                config=config,
                user_id="user-1",
                device_id="device-1",
                device_code="device-code",
                odoo_user_id=7,
            )
            await db.commit()

        service = PosService(FakeAuthContextClient(), OfflineOdooPosClient())
        async with session_factory() as db:
            configs = await service.list_configs(db, "service-token")
            session = await service.session_detail(db, "service-token", 44)

        assert len(configs.items) == 1
        cached_config = configs.items[0]
        assert cached_config.odoo_config_id == 12
        assert cached_config.session is not None
        assert cached_config.session["id"] == 44
        assert cached_config.cashiers[0].has_pos_pin is True
        assert cached_config.cashiers[0].pos_pin_hash is not None
        assert session.odoo_session_id == 44
        assert session.state == "opened"
    finally:
        await engine.dispose()
