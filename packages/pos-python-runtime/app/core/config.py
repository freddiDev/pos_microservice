from functools import lru_cache

from pydantic import AnyHttpUrl, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = Field(...)
    environment: str = Field(...)
    service_role: str = Field(..., pattern="^(auth|gateway|pos)$")
    api_prefix: str = Field(...)

    database_url: str | None = None

    jwt_secret_key: str = Field(...)
    jwt_algorithm: str = Field(...)
    access_token_expire_minutes: int = Field(...)
    refresh_token_expire_days: int = Field(...)

    odoo_base_url: AnyHttpUrl | None = None
    auth_service_url: AnyHttpUrl | None = None
    pos_service_url: AnyHttpUrl | None = None
    product_service_url: AnyHttpUrl | None = None
    member_service_url: AnyHttpUrl | None = None
    internal_service_key: str | None = None
    request_timeout_seconds: float = Field(...)

    @model_validator(mode="after")
    def validate_role_environment(self) -> "Settings":
        if self.service_role == "auth":
            missing = [
                name
                for name, value in {
                    "DATABASE_URL": self.database_url,
                    "ODOO_BASE_URL": self.odoo_base_url,
                    "INTERNAL_SERVICE_KEY": self.internal_service_key,
                }.items()
                if value is None
            ]
        elif self.service_role == "pos":
            missing = [
                name
                for name, value in {
                    "DATABASE_URL": self.database_url,
                    "ODOO_BASE_URL": self.odoo_base_url,
                    "AUTH_SERVICE_URL": self.auth_service_url,
                    "INTERNAL_SERVICE_KEY": self.internal_service_key,
                }.items()
                if value is None
            ]
        else:
            missing = [
                name
                for name, value in {
                    "AUTH_SERVICE_URL": self.auth_service_url,
                    "POS_SERVICE_URL": self.pos_service_url,
                    "PRODUCT_SERVICE_URL": self.product_service_url,
                    "MEMBER_SERVICE_URL": self.member_service_url,
                }.items()
                if value is None
            ]

        if missing:
            joined = ", ".join(missing)
            raise ValueError(f"{joined} must be set for SERVICE_ROLE={self.service_role}")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
