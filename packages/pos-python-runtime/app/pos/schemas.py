from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class AuthPrincipal(BaseModel):
    user_id: str
    device_id: str
    odoo_user_id: int
    login: str
    name: str
    role: str
    company_odoo_id: int | None
    warehouse_odoo_id: int | None
    pos_config_odoo_id: int | None
    device_code: str
    odoo_access_token: str


class PosPaymentMethodOut(BaseModel):
    odoo_payment_method_id: int
    name: str
    type: str | None = None
    is_cash_count: bool = False
    split_transactions: bool = False
    active: bool = True


class PosCashierOut(BaseModel):
    id: int
    odoo_user_id: int
    name: str
    login: str | None = None
    avatar: str | None = None
    has_pos_pin: bool = False


class PosConfigOut(BaseModel):
    id: str | None = None
    odoo_config_id: int
    odoo_uuid: str | None = None
    name: str
    active: bool = True
    company_odoo_id: int | None = None
    company_name: str | None = None
    warehouse_odoo_id: int | None = None
    warehouse_name: str | None = None
    picking_type_odoo_id: int | None = None
    journal_odoo_id: int | None = None
    invoice_journal_odoo_id: int | None = None
    currency_odoo_id: int | None = None
    pricelist_odoo_id: int | None = None
    cash_control: bool = False
    set_maximum_difference: bool = False
    amount_authorized_diff: float | None = None
    iface_tax_included: str | None = None
    module_pos_restaurant: bool = False
    current_session_odoo_id: int | None = None
    current_session_state: str | None = None
    current_user_odoo_id: int | None = None
    current_user_name: str | None = None
    session: dict[str, Any] | None = None
    payment_methods: list[PosPaymentMethodOut] = Field(default_factory=list)
    cashiers: list[PosCashierOut] = Field(default_factory=list)
    write_date: datetime | None = None
    synced_at: datetime | None = None


class PosConfigListOut(BaseModel):
    items: list[PosConfigOut]


class PosSessionOut(BaseModel):
    id: str | None = None
    odoo_session_id: int
    odoo_config_id: int
    name: str | None = None
    state: str
    service_status: str = "active"
    user_id: str | None = None
    opened_by: str | None = None
    odoo_user_id: int | None = None
    device_id: str | None = None
    device_code: str | None = None
    company_odoo_id: int | None = None
    warehouse_odoo_id: int | None = None
    currency_odoo_id: int | None = None
    start_at: datetime | None = None
    stop_at: datetime | None = None
    opening_notes: str | None = None
    closing_notes: str | None = None
    cash_register_balance_start: float | None = None
    cash_register_balance_end_real: float | None = None
    cash_register_balance_end: float | None = None
    cash_register_difference: float | None = None
    total_payments_amount: float | None = None
    total_sales_cash: float | None = None
    total_sales_bank: float | None = None
    order_count: int = 0
    login_number: int = 0
    sequence_number: int = 0
    rescue: bool = False
    move_odoo_id: int | None = None
    write_date: datetime | None = None
    synced_at: datetime | None = None

    @property
    def id_for_mobile(self) -> int:
        return self.odoo_session_id

    def mobile_dict(self) -> dict[str, Any]:
        return {
            "id": self.odoo_session_id,
            "config_id": self.odoo_config_id,
            "opened_by": self.opened_by or self.user_id or "-",
            "move_id": self.move_odoo_id,
            "start_at": self.start_at.isoformat() if self.start_at else None,
            "closed_at": self.stop_at.isoformat() if self.stop_at else None,
            "cash_register_balance_start": self.cash_register_balance_start,
            "total_sales_cash": self.total_sales_cash,
            "total_sales_bank": self.total_sales_bank,
            "state": self.state,
        }


class OpenSessionRequest(BaseModel):
    pos_config: int = Field(..., gt=0)
    opening_cash: float | None = None
    opening_notes: str | None = None


class OpeningCashRequest(BaseModel):
    counted_cash: float = Field(..., ge=0)
    opening_notes: str | None = None


class ClosingControlOut(BaseModel):
    odoo_session_id: int
    default_cash_payment_method_odoo_id: int | None = None
    expected_cash: float | None = None
    opening_cash: float | None = None
    payment_amount: float | None = None
    counted_cash: float | None = None
    cash_difference: float | None = None
    orders_count: int = 0
    orders_amount: float | None = None
    other_payment_methods: list[dict[str, Any]] = Field(default_factory=list)
    raw_closing_data: dict[str, Any] = Field(default_factory=dict)


class CloseSessionRequest(BaseModel):
    counted_cash: float | None = Field(default=None, ge=0)
    closing_notes: str | None = None
    bank_payment_method_diff_pairs: list[tuple[int, float]] = Field(default_factory=list)


class CloseSessionOut(BaseModel):
    successful: bool
    message: str | None = None
    redirect: bool = False
    session: PosSessionOut | None = None


class HeartbeatOut(BaseModel):
    success: bool = True
    message: str = "Session heartbeat accepted."
