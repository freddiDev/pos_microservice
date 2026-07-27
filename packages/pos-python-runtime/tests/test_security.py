from app.core.config import Settings
from app.core.security import create_access_token, decode_access_token, hash_token


def test_access_token_roundtrip() -> None:
    settings = Settings(
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
    token = create_access_token(settings, "user-id", {"device_id": "device-id", "role": "cashier"})
    payload = decode_access_token(settings, token)
    assert payload["sub"] == "user-id"
    assert payload["device_id"] == "device-id"
    assert payload["role"] == "cashier"


def test_hash_token_is_stable_and_not_plaintext() -> None:
    value = hash_token("secret-token")
    assert value == hash_token("secret-token")
    assert value != "secret-token"
    assert len(value) == 64
