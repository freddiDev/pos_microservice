from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


def build_engine(database_url: str) -> AsyncEngine:
    connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    return create_async_engine(
        database_url,
        echo=False,
        future=True,
        pool_pre_ping=not database_url.startswith("sqlite"),
        connect_args=connect_args,
    )


def build_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def init_database(engine: AsyncEngine, service_role: str) -> None:
    async with engine.begin() as conn:
        if service_role == "pos":
            from app.pos.models import PosBase

            await conn.run_sync(PosBase.metadata.create_all)
            return

        from app.domain import models  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)
        if engine.dialect.name == "postgresql":
            await conn.execute(text("ALTER TABLE devices DROP CONSTRAINT IF EXISTS uq_devices_device_code"))
            await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS local_password_hash TEXT"))
            await conn.execute(text("ALTER TABLE devices ADD COLUMN IF NOT EXISTS odoo_access_token TEXT"))
            await conn.execute(text("ALTER TABLE devices ADD COLUMN IF NOT EXISTS odoo_token_expires_at TIMESTAMP WITH TIME ZONE"))


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    factory: async_sessionmaker[AsyncSession] = request.app.state.db_session_factory
    async with factory() as session:
        yield session
