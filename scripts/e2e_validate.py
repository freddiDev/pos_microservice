import os
import socket
import tempfile
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
import sys

import httpx
import uvicorn
from fastapi import FastAPI, Request


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class ServerHandle:
    def __init__(self, app: FastAPI, port: int):
        self.port = port
        self.server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on")
        )
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self) -> None:
        self.thread.start()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                with httpx.Client(timeout=1) as client:
                    response = client.get(f"http://127.0.0.1:{self.port}/health/live")
                    if response.status_code == 200:
                        return
            except httpx.HTTPError:
                time.sleep(0.1)
        raise RuntimeError(f"Server on port {self.port} did not become ready.")

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=5)


def fake_odoo_app() -> FastAPI:
    app = FastAPI()
    session_state = {"state": "opened", "stop_at": None}

    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/microservice/auth/login")
    async def login(request: Request) -> dict:
        body = await request.json()
        if body.get("login") != "cashier@example.com" or body.get("password") != "secret":
            return {"success": False, "message": "Invalid login or password"}
        expires_at = (datetime.now(UTC) + timedelta(days=7)).isoformat()
        return {
            "success": True,
            "data": {
                "odoo_access_token": "fake-odoo-token",
                "expires_at": expires_at,
                "user": {
                    "odoo_user_id": 7,
                    "login": "cashier@example.com",
                    "name": "Cashier Example",
                    "role": "cashier",
                    "company_odoo_id": 1,
                    "warehouse_odoo_id": 3,
                    "partner_odoo_id": 9,
                    "active": True,
                },
                "allowed_pos_configs": [
                    {
                        "odoo_config_id": 12,
                        "name": "Main Store POS",
                        "company_odoo_id": 1,
                        "warehouse_odoo_id": 3,
                        "currency_odoo_id": 1,
                        "pricelist_odoo_id": 1,
                        "cash_control": True,
                    }
                ],
            },
        }

    @app.post("/api/microservice/auth/logout")
    async def logout() -> dict[str, bool]:
        return {"success": True}

    def session_payload() -> dict:
        return {
            "odoo_session_id": 44,
            "odoo_config_id": 12,
            "name": "POS/00044",
            "state": session_state["state"],
            "company_odoo_id": 1,
            "warehouse_odoo_id": 3,
            "currency_odoo_id": 1,
            "start_at": datetime.now(UTC).isoformat(),
            "stop_at": session_state["stop_at"],
            "cash_register_balance_start": 1000,
            "cash_register_balance_end_real": 1500,
            "cash_register_balance_end": 1500,
            "cash_register_difference": 0,
            "total_payments_amount": 500,
            "order_count": 1,
            "login_number": 1,
            "sequence_number": 1,
            "rescue": False,
            "move_odoo_id": None,
        }

    @app.post("/api/microservice/pos/configs")
    async def pos_configs() -> dict:
        return {
            "success": True,
            "data": {
                "items": [
                    {
                        "odoo_config_id": 12,
                        "odoo_uuid": "config-uuid-12",
                        "name": "Main Store POS",
                        "active": True,
                        "company_odoo_id": 1,
                        "warehouse_odoo_id": 3,
                        "picking_type_odoo_id": 5,
                        "journal_odoo_id": 6,
                        "invoice_journal_odoo_id": 7,
                        "currency_odoo_id": 1,
                        "pricelist_odoo_id": 1,
                        "cash_control": True,
                        "set_maximum_difference": True,
                        "amount_authorized_diff": 100,
                        "iface_tax_included": "total",
                        "module_pos_restaurant": False,
                        "current_session_odoo_id": 44 if session_state["state"] != "closed" else False,
                        "current_session_state": session_state["state"] if session_state["state"] != "closed" else False,
                        "payment_methods": [
                            {
                                "odoo_payment_method_id": 1,
                                "name": "Cash",
                                "type": "cash",
                                "is_cash_count": True,
                                "split_transactions": False,
                                "journal_odoo_id": 6,
                                "active": True,
                            }
                        ],
                    }
                ]
            },
        }

    @app.post("/api/microservice/pos/sessions/open")
    async def open_session(request: Request) -> dict:
        body = await request.json()
        if body.get("pos_config") != 12:
            return {"success": False, "message": "POS config is not allowed or not found."}
        session_state["state"] = "opened"
        session_state["stop_at"] = None
        return {"success": True, "data": {"session": session_payload()}}

    @app.post("/api/microservice/pos/sessions/detail")
    async def session_detail() -> dict:
        return {"success": True, "data": {"session": session_payload()}}

    @app.post("/api/microservice/pos/sessions/closing-control")
    async def closing_control() -> dict:
        return {
            "success": True,
            "data": {
                "orders_details": {"quantity": 1, "amount": 500},
                "default_cash_details": {
                    "id": 1,
                    "amount": 1500,
                    "opening": 1000,
                    "payment_amount": 500,
                    "moves": [],
                },
                "other_payment_methods": [],
                "is_manager": True,
                "amount_authorized_diff": 100,
            },
        }

    @app.post("/api/microservice/pos/sessions/opening-cash")
    async def opening_cash() -> dict:
        session_state["state"] = "opened"
        return {"success": True, "data": {"session": session_payload()}}

    @app.post("/api/microservice/pos/sessions/close")
    async def close_session() -> dict:
        session_state["state"] = "post_verification"
        session_state["stop_at"] = datetime.now(UTC).isoformat()
        return {"success": True, "data": {"successful": True, "session": session_payload()}}

    return app


def build_service_app(role: str, env: dict[str, str]) -> FastAPI:
    runtime_dir = Path(__file__).resolve().parents[1] / "packages" / "pos-python-runtime"
    if runtime_dir.exists() and str(runtime_dir) not in sys.path:
        sys.path.insert(0, str(runtime_dir))

    from app.core.config import get_settings
    from app.main import create_app

    os.environ.update(env)
    os.environ["SERVICE_ROLE"] = role
    get_settings.cache_clear()
    return create_app()


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)

    odoo_port = free_port()
    auth_port = free_port()
    pos_port = free_port()
    gateway_port = free_port()
    auth_db_file = tempfile.NamedTemporaryFile(prefix="pos-auth-e2e-", suffix=".db", delete=False)
    pos_db_file = tempfile.NamedTemporaryFile(prefix="pos-core-e2e-", suffix=".db", delete=False)
    auth_db_file.close()
    pos_db_file.close()

    common_env = {
        "APP_NAME": "POS E2E Service",
        "ENVIRONMENT": "e2e",
        "API_PREFIX": "/api/v1",
        "JWT_SECRET_KEY": "e2e-secret-key-with-at-least-32-bytes",
        "JWT_ALGORITHM": "HS256",
        "ODOO_BASE_URL": f"http://127.0.0.1:{odoo_port}",
        "AUTH_SERVICE_URL": f"http://127.0.0.1:{auth_port}",
        "POS_SERVICE_URL": f"http://127.0.0.1:{pos_port}",
        "PRODUCT_SERVICE_URL": "http://127.0.0.1:9",
        "MEMBER_SERVICE_URL": "http://127.0.0.1:9",
        "INTERNAL_SERVICE_KEY": "e2e-internal-service-key",
        "ACCESS_TOKEN_EXPIRE_MINUTES": "15",
        "REFRESH_TOKEN_EXPIRE_DAYS": "14",
        "REQUEST_TIMEOUT_SECONDS": "10",
    }
    auth_env = {**common_env, "DATABASE_URL": f"sqlite+aiosqlite:///{auth_db_file.name}"}
    pos_env = {**common_env, "DATABASE_URL": f"sqlite+aiosqlite:///{pos_db_file.name}"}

    servers = [
        ServerHandle(fake_odoo_app(), odoo_port),
        ServerHandle(build_service_app("auth", auth_env), auth_port),
        ServerHandle(build_service_app("pos", pos_env), pos_port),
        ServerHandle(build_service_app("gateway", common_env), gateway_port),
    ]

    try:
        for server in servers:
            server.start()

        base_url = f"http://127.0.0.1:{gateway_port}"
        with httpx.Client(base_url=base_url, timeout=5) as client:
            ready = client.get("/health/ready")
            ready.raise_for_status()

            login = client.post(
                "/api/v1/auth/login",
                json={
                    "login": "cashier@example.com",
                    "password": "secret",
                    "device_code": "android-pos-001",
                    "device_name": "Android POS 001",
                    "platform": "android",
                    "app_version": "1.0.0",
                    "pos_config_odoo_id": 12,
                },
            )
            login.raise_for_status()
            token_payload = login.json()
            access_token = token_payload["access_token"]
            refresh_token = token_payload["refresh_token"]
            first_device_id = token_payload["device"]["id"]
            assert token_payload["user"]["odoo_user_id"] == 7
            assert token_payload["device"]["device_code"] == "android-pos-001"

            headers = {"Authorization": f"Bearer {access_token}"}
            me = client.get("/api/v1/users/me", headers=headers)
            me.raise_for_status()
            assert me.json()["login"] == "cashier@example.com"

            device = client.get("/api/v1/devices/me", headers=headers)
            device.raise_for_status()
            assert device.json()["pos_config_odoo_id"] == 12

            heartbeat = client.post("/api/v1/devices/heartbeat", headers=headers)
            heartbeat.raise_for_status()

            configs = client.get("/api/v1/pos-configs", headers=headers)
            configs.raise_for_status()
            assert configs.json()["items"][0]["odoo_config_id"] == 12
            assert configs.json()["items"][0]["payment_methods"][0]["odoo_payment_method_id"] == 1

            session_open = client.post(
                "/api/v1/pos/sessions",
                headers={**headers, "Idempotency-Key": "open-session-1"},
                json={"pos_config": 12, "opening_cash": 1000, "opening_notes": "Start cash"},
            )
            session_open.raise_for_status()
            session_payload = session_open.json()
            assert session_payload["odoo_session_id"] == 44
            assert session_payload["state"] == "opened"

            duplicate_open = client.post(
                "/api/v1/pos/sessions",
                headers={**headers, "Idempotency-Key": "open-session-1"},
                json={"pos_config": 12, "opening_cash": 1000, "opening_notes": "Start cash"},
            )
            duplicate_open.raise_for_status()
            assert duplicate_open.json()["odoo_session_id"] == 44

            current = client.get("/api/v1/pos/sessions/current?pos_config=12", headers=headers)
            current.raise_for_status()
            assert current.json()["odoo_session_id"] == 44

            closing = client.get("/api/v1/pos/sessions/44/closing-control", headers=headers)
            closing.raise_for_status()
            assert closing.json()["expected_cash"] == 1500

            close = client.post(
                "/api/v1/pos/sessions/44/close",
                headers={**headers, "Idempotency-Key": "close-session-1"},
                json={"counted_cash": 1500, "closing_notes": "OK", "bank_payment_method_diff_pairs": []},
            )
            close.raise_for_status()
            assert close.json()["successful"] is True
            assert close.json()["session"]["state"] == "post_verification"

            refreshed = client.post("/api/v1/auth/refresh", json={"refresh_token": refresh_token})
            refreshed.raise_for_status()
            assert refreshed.json()["access_token"] != access_token

            logout = client.post("/api/v1/auth/logout", json={"refresh_token": refreshed.json()["refresh_token"]})
            logout.raise_for_status()

            second_login = client.post(
                "/api/v1/auth/login",
                json={
                    "login": "cashier@example.com",
                    "password": "secret",
                    "device_code": "android-pos-001",
                    "device_name": "Android POS 001",
                    "platform": "android",
                    "app_version": "1.0.0",
                    "pos_config_odoo_id": 12,
                },
            )
            second_login.raise_for_status()
            assert second_login.json()["device"]["id"] != first_device_id

        print("E2E OK: gateway -> auth service + POS service -> fake Odoo login/config/session/refresh/logout/new-device-row flow passed.")
    finally:
        for server in reversed(servers):
            server.stop()
        Path(auth_db_file.name).unlink(missing_ok=True)
        Path(pos_db_file.name).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
