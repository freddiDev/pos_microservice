import { Collection, Filter } from "mongodb";

import { MemberCollections } from "../db.js";
import {
  loyaltyProgramToApi,
  MemberDocument,
  memberToApi,
  normalizeLoyaltyProgram,
  normalizeMember,
  normalizeSearch,
  normalizeTier,
  tierToApi,
  toNumber
} from "./normalizers.js";

export type MemberListOptions = {
  companyOdooId: number;
  offset: number;
  limit: number;
  updatedAfter?: string;
  query?: string;
  includeInactive?: boolean;
};

export class MemberRepository {
  constructor(private readonly collections: MemberCollections) {}

  async upsertSnapshot(companyOdooId: number, snapshot: Record<string, unknown>): Promise<void> {
    const members = extractItems(snapshot.members).map((item) => normalizeMember(item, companyOdooId));
    const tiers = extractArray(snapshot.tiers).map((item) => normalizeTier(item, companyOdooId));
    const loyaltyPrograms = extractArray(snapshot.loyalty_programs).map((item) => normalizeLoyaltyProgram(item, companyOdooId));

    await Promise.all([
      this.upsertMembers(members),
      this.upsertSimple(
        this.collections.tiers,
        tiers.map((tier) => ({
          filter: { company_odoo_id: tier.company_odoo_id, odoo_id: tier.odoo_id },
          document: tier
        }))
      ),
      this.upsertSimple(
        this.collections.loyaltyPrograms,
        loyaltyPrograms.map((program) => ({
          filter: { company_odoo_id: program.company_odoo_id, odoo_id: program.odoo_id },
          document: program
        }))
      )
    ]);

    const [existingState, total] = await Promise.all([
      this.syncState(companyOdooId),
      this.collections.members.countDocuments({ company_odoo_id: companyOdooId })
    ]);
    const latest = latestWriteDate(members) || existingState?.last_odoo_write_date || null;
    await this.collections.syncState.updateOne(
      { company_odoo_id: companyOdooId },
      {
        $set: {
          company_odoo_id: companyOdooId,
          member_count: total,
          last_synced_at: new Date(),
          last_odoo_write_date: latest
        }
      },
      { upsert: true }
    );
  }

  async syncState(companyOdooId: number) {
    return this.collections.syncState.findOne({ company_odoo_id: companyOdooId }, { projection: { _id: 0 } });
  }

  async listMembers(options: MemberListOptions): Promise<Record<string, unknown>> {
    const filter = this.memberFilter(options);
    const [items, total] = await Promise.all([
      this.collections.members
        .find(filter, { projection: { _id: 0, raw: 0 } })
        .sort({ write_date: 1, odoo_partner_id: 1 })
        .skip(options.offset)
        .limit(options.limit)
        .toArray(),
      this.collections.members.countDocuments(filter)
    ]);

    return {
      items: items.map(memberToApi),
      offset: options.offset,
      limit: options.limit,
      total,
      has_more: options.offset + options.limit < total
    };
  }

  async findByOdooId(companyOdooId: number, partnerId: number): Promise<Record<string, unknown> | null> {
    const document = await this.collections.members.findOne(
      { company_odoo_id: companyOdooId, odoo_partner_id: partnerId },
      { projection: { _id: 0, raw: 0 } }
    );
    return document ? memberToApi(document) : null;
  }

  async tiers(companyOdooId: number): Promise<Record<string, unknown>[]> {
    const tiers = await this.collections.tiers
      .find({ company_odoo_id: companyOdooId, active: true }, { projection: { _id: 0, raw: 0 } })
      .sort({ sequence: 1, name: 1 })
      .toArray();
    return tiers.map(tierToApi);
  }

  async loyaltyPrograms(companyOdooId: number): Promise<Record<string, unknown>[]> {
    const programs = await this.collections.loyaltyPrograms
      .find({ company_odoo_id: companyOdooId, active: true }, { projection: { _id: 0, raw: 0 } })
      .sort({ name: 1 })
      .toArray();
    return programs.map(loyaltyProgramToApi);
  }

  private memberFilter(options: MemberListOptions): Filter<MemberDocument> {
    const filter: Filter<MemberDocument> = { company_odoo_id: options.companyOdooId };
    if (!options.includeInactive) {
      filter.active = true;
    }
    if (options.updatedAfter) {
      filter.write_date = { $gt: options.updatedAfter };
    }

    const search = options.query ? normalizeSearch(options.query) : "";
    if (search) {
      const digits = options.query?.replace(/\D/g, "") || "";
      const partnerId = toNumber(search);
      const clauses: Filter<MemberDocument>[] = [
        { name_search: prefixRegex(search) },
        { email_search: prefixRegex(search) },
        { member_code_search: prefixRegex(search) },
        { barcode_search: prefixRegex(search) }
      ];
      if (partnerId) {
        clauses.push({ odoo_partner_id: partnerId });
      }
      if (digits) {
        clauses.push({ phone_digits: prefixRegex(digits) }, { mobile_digits: prefixRegex(digits) });
      }
      filter.$or = clauses;
    }
    return filter;
  }

  private async upsertMembers(members: MemberDocument[]): Promise<void> {
    if (!members.length) return;
    await this.collections.members.bulkWrite(
      members.map((member) => ({
        updateOne: {
          filter: {
            company_odoo_id: member.company_odoo_id,
            odoo_partner_id: member.odoo_partner_id
          },
          update: { $set: member },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }

  private async upsertSimple<T extends Record<string, unknown>>(
    collection: Collection<T>,
    items: { filter: Filter<T>; document: T }[]
  ): Promise<void> {
    if (!items.length) return;
    await collection.bulkWrite(
      items.map((item) => ({
        updateOne: {
          filter: item.filter,
          update: { $set: item.document },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }
}

export function extractItems(source: unknown): Record<string, unknown>[] {
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  const items = (source as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items.filter(isRecord);
}

export function extractArray(source: unknown): Record<string, unknown>[] {
  if (!Array.isArray(source)) return [];
  return source.filter(isRecord);
}

function latestWriteDate(members: MemberDocument[]): string | null {
  return (
    members
      .map((member) => member.write_date)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) || null
  );
}

function isRecord(item: unknown): item is Record<string, unknown> {
  return Boolean(item) && typeof item === "object" && !Array.isArray(item);
}

function prefixRegex(value: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
