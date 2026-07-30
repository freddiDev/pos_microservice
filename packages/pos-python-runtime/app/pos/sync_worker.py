import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.pos.odoo_client import OdooPosClient
from app.pos.repositories import PosConfigRepository, PosSessionRepository
from app.pos.service import _config_session_payload, _has_complete_session_payload, _int_or_none, _session_payload
from app.services.odoo_client import OdooClient, OdooClientError

_logger = logging.getLogger(__name__)


class PosSyncWorker:
    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
        odoo_http: httpx.AsyncClient,
    ) -> None:
        self._settings = settings
        self._session_factory = session_factory
        self._auth_client = OdooClient(odoo_http)
        self._pos_client = OdooPosClient(odoo_http)
        self._configs = PosConfigRepository()
        self._sessions = PosSessionRepository()
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._retry_delay = settings.sync_worker_retry_min_seconds
        self._status: dict[str, Any] = {
            "domain": "pos",
            "enabled": settings.sync_worker_enabled,
            "running": False,
            "last_started_at": None,
            "last_success_at": None,
            "last_failure_at": None,
            "last_error": None,
            "last_result": None,
            "next_run_at": None,
        }

    def start(self) -> None:
        if not self._settings.sync_worker_enabled:
            _logger.info("POS sync worker disabled.")
            self._set_status(enabled=False, running=False, next_run_at=None)
            return
        if not self._settings.odoo_sync_username or not self._settings.odoo_sync_password:
            _logger.warning("POS sync worker enabled but ODOO_SYNC_USERNAME/ODOO_SYNC_PASSWORD is missing.")
            self._set_status(
                enabled=True,
                running=False,
                last_error="ODOO_SYNC_USERNAME/ODOO_SYNC_PASSWORD is missing.",
                next_run_at=None,
            )
            return
        if self._task is not None:
            return
        self._set_status(enabled=True, running=False, last_error=None)
        self._task = asyncio.create_task(self._run(), name="pos-sync-worker")
        _logger.info("POS sync worker started.")

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        self._set_status(running=False, next_run_at=None)

    def status(self) -> dict[str, Any]:
        return dict(self._status)

    async def sync_once(self) -> dict[str, Any]:
        login_data = await self._auth_client.login(
            self._settings.odoo_sync_username or "",
            self._settings.odoo_sync_password or "",
            self._settings.odoo_sync_device_code,
        )
        access_token = login_data.get("odoo_access_token")
        if not isinstance(access_token, str) or not access_token.strip():
            raise OdooClientError("Odoo sync login did not return odoo_access_token.")

        items = login_data.get("allowed_pos_configs")
        if not isinstance(items, list):
            items = await self._pos_client.list_configs(access_token)

        synced_configs = 0
        synced_sessions = 0
        async with self._session_factory() as db:
            for item in items:
                if not isinstance(item, dict):
                    continue
                config = await self._configs.upsert_config(db, item)
                if await self._sync_config_session(db, access_token, config, item):
                    synced_sessions += 1
                synced_configs += 1
            await db.commit()

        return {"configs_synced": synced_configs, "sessions_synced": synced_sessions}

    async def _run(self) -> None:
        await self._sleep_or_stop(self._settings.sync_worker_initial_delay_seconds)
        while not self._stop_event.is_set():
            try:
                self._set_status(
                    running=True,
                    last_started_at=_now_iso(),
                    last_error=None,
                    next_run_at=None,
                )
                result = await self.sync_once()
                self._retry_delay = self._settings.sync_worker_retry_min_seconds
                self._set_status(
                    running=False,
                    last_success_at=_now_iso(),
                    last_error=None,
                    last_result=result,
                )
                _logger.info("POS sync worker completed: %s", result)
                await self._sleep_or_stop(self._settings.sync_worker_interval_seconds)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._set_status(
                    running=False,
                    last_failure_at=_now_iso(),
                    last_error=str(exc),
                )
                _logger.exception("POS sync worker failed. Retrying in %.1fs.", self._retry_delay)
                await self._sleep_or_stop(self._retry_delay)
                self._retry_delay = min(
                    self._retry_delay * 2,
                    self._settings.sync_worker_retry_max_seconds,
                )

    async def _sleep_or_stop(self, delay_seconds: float) -> None:
        if delay_seconds <= 0:
            self._set_status(next_run_at=None)
            return
        self._set_status(next_run_at=_future_iso(delay_seconds))
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=delay_seconds)
        except TimeoutError:
            return

    async def _sync_config_session(
        self,
        db: AsyncSession,
        access_token: str,
        config: Any,
        item: dict[str, Any],
    ) -> bool:
        payload = _config_session_payload(item)
        if payload is None:
            return False

        session_id = _int_or_none(payload.get("odoo_session_id") or payload.get("id"))
        if session_id is None:
            return False

        payload["odoo_session_id"] = session_id
        payload["odoo_config_id"] = _int_or_none(payload.get("odoo_config_id") or payload.get("config_id")) or config.odoo_config_id
        payload["state"] = payload.get("state") or config.current_session_state or "opened"

        if not _has_complete_session_payload(payload):
            try:
                detail = _session_payload(
                    await self._pos_client.session_detail(access_token, odoo_session_id=session_id)
                )
                payload.update(detail)
                payload["odoo_session_id"] = _int_or_none(payload.get("odoo_session_id") or payload.get("id")) or session_id
                payload["odoo_config_id"] = _int_or_none(payload.get("odoo_config_id") or payload.get("config_id")) or config.odoo_config_id
                payload["state"] = payload.get("state") or config.current_session_state or "opened"
            except Exception:
                _logger.warning("Failed to hydrate POS session %s during sync.", session_id, exc_info=True)

        await self._sessions.upsert_session(
            db,
            payload,
            config=config,
            user_id=None,
            device_id=None,
            device_code=None,
            odoo_user_id=_int_or_none(payload.get("odoo_user_id")) or config.current_user_odoo_id,
        )
        return True

    def _set_status(self, **values: Any) -> None:
        self._status.update(values)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _future_iso(seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()
