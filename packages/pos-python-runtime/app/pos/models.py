import uuid

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

JsonType = JSON().with_variant(JSONB, "postgresql")


def uuid_str() -> str:
    return str(uuid.uuid4())


class PosBase(DeclarativeBase):
    pass


class PosConfig(PosBase):
    __tablename__ = "pos_configs"
    __table_args__ = (
        Index("idx_pos_configs_company_warehouse", "company_odoo_id", "warehouse_odoo_id"),
        Index("idx_pos_configs_current_session", "current_session_odoo_id", "current_session_state"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    odoo_config_id: Mapped[int] = mapped_column(Integer, unique=True, nullable=False, index=True)
    odoo_uuid: Mapped[str | None] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    company_odoo_id: Mapped[int | None] = mapped_column(Integer, index=True)
    warehouse_odoo_id: Mapped[int | None] = mapped_column(Integer, index=True)
    picking_type_odoo_id: Mapped[int | None] = mapped_column(Integer)
    journal_odoo_id: Mapped[int | None] = mapped_column(Integer)
    invoice_journal_odoo_id: Mapped[int | None] = mapped_column(Integer)
    currency_odoo_id: Mapped[int | None] = mapped_column(Integer)
    pricelist_odoo_id: Mapped[int | None] = mapped_column(Integer)
    cash_control: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    set_maximum_difference: Mapped[bool] = mapped_column(Boolean, default=False)
    amount_authorized_diff: Mapped[float | None] = mapped_column(Numeric(16, 2))
    iface_tax_included: Mapped[str | None] = mapped_column(String(32))
    module_pos_restaurant: Mapped[bool] = mapped_column(Boolean, default=False)
    current_session_odoo_id: Mapped[int | None] = mapped_column(Integer, index=True)
    current_session_state: Mapped[str | None] = mapped_column(String(32), index=True)
    current_user_odoo_id: Mapped[int | None] = mapped_column(Integer)
    current_user_name: Mapped[str | None] = mapped_column(String(255))
    write_date: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    synced_at: Mapped[str | None] = mapped_column(DateTime(timezone=True), index=True)
    raw_odoo_payload: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    sessions: Mapped[list["PosSession"]] = relationship(back_populates="config")
    payment_methods: Mapped[list["PosConfigPaymentMethod"]] = relationship(back_populates="config")


class PosPaymentMethod(PosBase):
    __tablename__ = "pos_payment_methods"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    odoo_payment_method_id: Mapped[int] = mapped_column(Integer, unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[str | None] = mapped_column(String(32), index=True)
    is_cash_count: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    split_transactions: Mapped[bool] = mapped_column(Boolean, default=False)
    journal_odoo_id: Mapped[int | None] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    raw_odoo_payload: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    configs: Mapped[list["PosConfigPaymentMethod"]] = relationship(back_populates="payment_method")


class PosConfigPaymentMethod(PosBase):
    __tablename__ = "pos_config_payment_methods"
    __table_args__ = (
        UniqueConstraint("pos_config_id", "payment_method_id", name="uq_pos_config_payment_method"),
        Index("idx_pos_config_payment_odoo", "odoo_config_id", "odoo_payment_method_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    pos_config_id: Mapped[str] = mapped_column(ForeignKey("pos_configs.id", ondelete="CASCADE"), index=True)
    payment_method_id: Mapped[str] = mapped_column(ForeignKey("pos_payment_methods.id", ondelete="CASCADE"), index=True)
    odoo_config_id: Mapped[int] = mapped_column(Integer, index=True)
    odoo_payment_method_id: Mapped[int] = mapped_column(Integer, index=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())

    config: Mapped[PosConfig] = relationship(back_populates="payment_methods")
    payment_method: Mapped[PosPaymentMethod] = relationship(back_populates="configs")


class PosSession(PosBase):
    __tablename__ = "pos_sessions"
    __table_args__ = (
        Index("idx_pos_sessions_config_state", "odoo_config_id", "state"),
        Index("idx_pos_sessions_device_state", "device_id", "state"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    odoo_session_id: Mapped[int] = mapped_column(Integer, unique=True, nullable=False, index=True)
    pos_config_id: Mapped[str | None] = mapped_column(ForeignKey("pos_configs.id", ondelete="SET NULL"), index=True)
    odoo_config_id: Mapped[int] = mapped_column(Integer, index=True)
    name: Mapped[str | None] = mapped_column(String(255))
    state: Mapped[str] = mapped_column(String(32), index=True)
    service_status: Mapped[str] = mapped_column(String(32), default="active", index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    odoo_user_id: Mapped[int | None] = mapped_column(Integer, index=True)
    device_id: Mapped[str | None] = mapped_column(String(36), index=True)
    device_code: Mapped[str | None] = mapped_column(String(128), index=True)
    company_odoo_id: Mapped[int | None] = mapped_column(Integer, index=True)
    warehouse_odoo_id: Mapped[int | None] = mapped_column(Integer, index=True)
    currency_odoo_id: Mapped[int | None] = mapped_column(Integer)
    start_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    stop_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    opening_notes: Mapped[str | None] = mapped_column(Text)
    closing_notes: Mapped[str | None] = mapped_column(Text)
    cash_register_balance_start: Mapped[float | None] = mapped_column(Numeric(16, 2))
    cash_register_balance_end_real: Mapped[float | None] = mapped_column(Numeric(16, 2))
    cash_register_balance_end: Mapped[float | None] = mapped_column(Numeric(16, 2))
    cash_register_difference: Mapped[float | None] = mapped_column(Numeric(16, 2))
    total_payments_amount: Mapped[float | None] = mapped_column(Numeric(16, 2))
    order_count: Mapped[int] = mapped_column(Integer, default=0)
    login_number: Mapped[int] = mapped_column(Integer, default=0)
    sequence_number: Mapped[int] = mapped_column(Integer, default=0)
    rescue: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    move_odoo_id: Mapped[int | None] = mapped_column(Integer)
    write_date: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    synced_at: Mapped[str | None] = mapped_column(DateTime(timezone=True), index=True)
    raw_odoo_payload: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    config: Mapped[PosConfig | None] = relationship(back_populates="sessions")
    devices: Mapped[list["PosSessionDevice"]] = relationship(back_populates="session")
    closing_control: Mapped["PosSessionClosingControl | None"] = relationship(back_populates="session")


class PosSessionDevice(PosBase):
    __tablename__ = "pos_session_devices"
    __table_args__ = (Index("idx_pos_session_devices_device_status", "device_id", "status"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    session_id: Mapped[str] = mapped_column(ForeignKey("pos_sessions.id", ondelete="CASCADE"), index=True)
    device_id: Mapped[str] = mapped_column(String(36), index=True)
    device_code: Mapped[str | None] = mapped_column(String(128), index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    odoo_user_id: Mapped[int | None] = mapped_column(Integer, index=True)
    status: Mapped[str] = mapped_column(String(32), default="active", index=True)
    joined_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
    left_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    last_heartbeat_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    session: Mapped[PosSession] = relationship(back_populates="devices")


class PosSessionClosingControl(PosBase):
    __tablename__ = "pos_session_closing_controls"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    session_id: Mapped[str] = mapped_column(ForeignKey("pos_sessions.id", ondelete="CASCADE"), unique=True, index=True)
    odoo_session_id: Mapped[int] = mapped_column(Integer, index=True)
    default_cash_payment_method_odoo_id: Mapped[int | None] = mapped_column(Integer)
    expected_cash: Mapped[float | None] = mapped_column(Numeric(16, 2))
    opening_cash: Mapped[float | None] = mapped_column(Numeric(16, 2))
    payment_amount: Mapped[float | None] = mapped_column(Numeric(16, 2))
    counted_cash: Mapped[float | None] = mapped_column(Numeric(16, 2))
    cash_difference: Mapped[float | None] = mapped_column(Numeric(16, 2))
    orders_count: Mapped[int] = mapped_column(Integer, default=0)
    orders_amount: Mapped[float | None] = mapped_column(Numeric(16, 2))
    other_payment_methods: Mapped[list] = mapped_column(JsonType, default=list)
    bank_payment_method_diff_pairs: Mapped[list] = mapped_column(JsonType, default=list)
    closing_notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="draft", index=True)
    raw_closing_data: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    submitted_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))

    session: Mapped[PosSession] = relationship(back_populates="closing_control")


class IdempotencyKey(PosBase):
    __tablename__ = "idempotency_keys"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    idempotency_key: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    actor_user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    device_id: Mapped[str | None] = mapped_column(String(36), index=True)
    method: Mapped[str] = mapped_column(String(16))
    path: Mapped[str] = mapped_column(String(255))
    request_hash: Mapped[str] = mapped_column(String(64))
    response_status: Mapped[int | None] = mapped_column(Integer)
    response_body: Mapped[dict | None] = mapped_column(JsonType)
    status: Mapped[str] = mapped_column(String(32), default="processing", index=True)
    locked_until: Mapped[str | None] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[str | None] = mapped_column(DateTime(timezone=True), index=True)


class PosSessionEvent(PosBase):
    __tablename__ = "pos_session_events"
    __table_args__ = (Index("idx_pos_session_events_type_created", "event_type", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    session_id: Mapped[str | None] = mapped_column(ForeignKey("pos_sessions.id", ondelete="SET NULL"), index=True)
    odoo_session_id: Mapped[int | None] = mapped_column(Integer, index=True)
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    actor_user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    device_id: Mapped[str | None] = mapped_column(String(36), index=True)
    request_id: Mapped[str | None] = mapped_column(String(128), index=True)
    payload_json: Mapped[dict] = mapped_column(JsonType, default=dict)
    result_json: Mapped[dict] = mapped_column(JsonType, default=dict)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
