export type MemberDocument = {
  odoo_partner_id: number;
  company_odoo_id: number;
  name: string;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  member_code: string | null;
  barcode: string | null;
  member_type: string | null;
  member_type_id: number | null;
  membership_date: string | null;
  pos_loyal_point: number;
  active: boolean;
  is_membership: boolean;
  write_date: string | null;
  name_search: string;
  phone_digits: string | null;
  mobile_digits: string | null;
  email_search: string | null;
  member_code_search: string | null;
  barcode_search: string | null;
  raw: Record<string, unknown>;
};

export type MemberSnapshotDocument = MemberDocument & {
  snapshot_id: string;
};

export type MemberTierDocument = {
  odoo_id: number;
  company_odoo_id: number;
  name: string;
  code: string | null;
  color: string | null;
  point_from: number | null;
  point_to: number | null;
  sequence: number | null;
  active: boolean;
  write_date: string | null;
  raw: Record<string, unknown>;
};

export type LoyaltyProgramDocument = {
  odoo_id: number;
  company_odoo_id: number;
  name: string;
  pos_loyalty_type: string | null;
  expired_days: number | null;
  warehouse_ids: number[];
  active: boolean;
  write_date: string | null;
  raw: Record<string, unknown>;
};

export type MemberSyncStateDocument = {
  company_odoo_id: number;
  member_count: number;
  last_synced_at: Date;
  last_odoo_write_date: string | null;
  active_snapshot_id?: string | null;
  sync_status?: "running" | "complete" | "failed";
  source_total?: number;
  last_run_id?: string | null;
  last_run_started_at?: Date | null;
  last_run_completed_at?: Date | null;
  last_error?: string | null;
};

export function normalizeMember(input: Record<string, unknown>, companyOdooId: number): MemberDocument {
  const id = toNumber(input.id);
  if (!id) {
    throw new Error("Member requires id.");
  }

  const memberTypePair = many2One(input.member_type_id);
  const memberType = toStringOrNull(input.member_type) || memberTypePair?.name || null;
  const memberCode = toStringOrNull(input.member_code) || toStringOrNull(input.ref);
  const phone = toStringOrNull(input.phone);
  const mobile = toStringOrNull(input.mobile);
  const email = toStringOrNull(input.email);
  const barcode = toStringOrNull(input.barcode);
  const name = toStringOrNull(input.name) || `Member ${id}`;

  return {
    odoo_partner_id: id,
    company_odoo_id: toNumber(input.company_id) || companyOdooId,
    name,
    phone,
    mobile,
    email,
    member_code: memberCode,
    barcode,
    member_type: memberType,
    member_type_id: memberTypePair?.id || toNumber(input.member_type_id),
    membership_date: toStringOrNull(input.membership_date),
    pos_loyal_point: toFiniteNumber(input.pos_loyal_point ?? input.loyalty_points) || 0,
    active: toBoolean(input.active, true),
    is_membership: toBoolean(input.is_membership, true),
    write_date: toStringOrNull(input.write_date),
    name_search: normalizeSearch(name),
    phone_digits: digitsOnly(phone),
    mobile_digits: digitsOnly(mobile),
    email_search: email ? normalizeSearch(email) : null,
    member_code_search: memberCode ? normalizeSearch(memberCode) : null,
    barcode_search: barcode ? normalizeSearch(barcode) : null,
    raw: input
  };
}

export function memberToApi(document: MemberDocument): Record<string, unknown> {
  return {
    id: document.odoo_partner_id,
    name: document.name,
    phone: document.phone,
    mobile: document.mobile,
    email: document.email,
    member_code: document.member_code,
    barcode: document.barcode,
    member_type: document.member_type,
    member_type_id: document.member_type_id,
    membership_date: document.membership_date,
    pos_loyal_point: document.pos_loyal_point,
    loyalty_points: document.pos_loyal_point,
    active: document.active,
    is_membership: document.is_membership,
    company_id: document.company_odoo_id,
    write_date: document.write_date
  };
}

export function normalizeTier(input: Record<string, unknown>, companyOdooId: number): MemberTierDocument {
  const id = toNumber(input.id);
  if (!id) {
    throw new Error("Member tier requires id.");
  }
  return {
    odoo_id: id,
    company_odoo_id: toNumber(input.company_id) || companyOdooId,
    name: toStringOrNull(input.name) || `Tier ${id}`,
    code: toStringOrNull(input.code) || toStringOrNull(input.member_type),
    color: toStringOrNull(input.color),
    point_from: toNumber(input.point_from),
    point_to: toNumber(input.point_to),
    sequence: toNumber(input.sequence),
    active: toBoolean(input.active, true),
    write_date: toStringOrNull(input.write_date),
    raw: input
  };
}

export function tierToApi(document: MemberTierDocument): Record<string, unknown> {
  return {
    id: document.odoo_id,
    name: document.name,
    code: document.code,
    color: document.color,
    point_from: document.point_from,
    point_to: document.point_to,
    sequence: document.sequence,
    active: document.active,
    company_id: document.company_odoo_id,
    write_date: document.write_date
  };
}

export function normalizeLoyaltyProgram(input: Record<string, unknown>, companyOdooId: number): LoyaltyProgramDocument {
  const id = toNumber(input.id);
  if (!id) {
    throw new Error("Loyalty program requires id.");
  }
  return {
    odoo_id: id,
    company_odoo_id: toNumber(input.company_id) || companyOdooId,
    name: toStringOrNull(input.name) || `Loyalty Program ${id}`,
    pos_loyalty_type: toStringOrNull(input.pos_loyalty_type),
    expired_days: toNumber(input.expired_days),
    warehouse_ids: toNumberArray(input.warehouse_ids),
    active: toBoolean(input.active, true),
    write_date: toStringOrNull(input.write_date),
    raw: input
  };
}

export function loyaltyProgramToApi(document: LoyaltyProgramDocument): Record<string, unknown> {
  return {
    id: document.odoo_id,
    name: document.name,
    pos_loyalty_type: document.pos_loyalty_type,
    expired_days: document.expired_days,
    warehouse_ids: document.warehouse_ids,
    active: document.active,
    company_id: document.company_odoo_id,
    write_date: document.write_date
  };
}

export function toNumber(value: unknown): number | null {
  const pair = many2One(value);
  if (pair) return pair.id;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toStringOrNull(value: unknown): string | null {
  if (value === false || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return toStringOrNull(value[1]);
  }
  const text = String(value).trim();
  return text && text.toLowerCase() !== "false" ? text : null;
}

export function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
  }
  return fallback;
}

export function normalizeSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function digitsOnly(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits || null;
}

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toNumber(item))
    .filter((item): item is number => item !== null);
}

function many2One(value: unknown): { id: number; name: string | null } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const id = typeof value[0] === "number" ? Math.trunc(value[0]) : Number(value[0]);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { id, name: toStringOrNull(value[1]) };
}
