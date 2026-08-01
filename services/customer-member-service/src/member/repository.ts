import { Collection, Filter } from "mongodb";

import { MemberCollections } from "../db.js";
import {
  loyaltyProgramToApi,
  MemberDocument,
  MemberSnapshotDocument,
  MemberSyncStateDocument,
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
  snapshotId?: string;
  updatedAfter?: string;
  query?: string;
  includeInactive?: boolean;
};

export class MemberRepository {
  constructor(private readonly collections: MemberCollections) {}

  async beginSnapshot(companyOdooId: number, snapshotId: string, startedAt = new Date()): Promise<void> {
    await this.collections.memberSnapshots.deleteMany({ snapshot_id: snapshotId, company_odoo_id: companyOdooId });
    await this.collections.syncState.updateOne(
      { company_odoo_id: companyOdooId },
      {
        $set: {
          company_odoo_id: companyOdooId,
          sync_status: "running",
          last_run_id: snapshotId,
          last_run_started_at: startedAt,
          last_error: null
        }
      },
      { upsert: true }
    );
  }

  async writeSnapshotPage(
    companyOdooId: number,
    snapshotId: string,
    snapshot: Record<string, unknown>
  ): Promise<{ members: number; latestWriteDate: string | null }> {
    const members = extractMemberItems(snapshot).map((item) => ({
      ...normalizeMember(item, companyOdooId),
      snapshot_id: snapshotId
    }));
    if (members.length) {
      await this.collections.memberSnapshots.bulkWrite(
        members.map((member) => ({
          updateOne: {
            filter: {
              snapshot_id: snapshotId,
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

    return {
      members: members.length,
      latestWriteDate: latestWriteDate(members)
    };
  }

  async replaceAuxiliaryData(
    companyOdooId: number,
    snapshot: Record<string, unknown>
  ): Promise<void> {
    const tiers = extractArray(snapshot.tiers).map((item) => normalizeTier(item, companyOdooId));
    const loyaltyPrograms = extractArray(snapshot.loyalty_programs).map((item) => normalizeLoyaltyProgram(item, companyOdooId));

    await Promise.all([
      this.collections.tiers.deleteMany({ company_odoo_id: companyOdooId }),
      this.collections.loyaltyPrograms.deleteMany({ company_odoo_id: companyOdooId })
    ]);
    await Promise.all([
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
  }

  async commitSnapshot(
    companyOdooId: number,
    snapshotId: string,
    sourceTotal: number,
    latestWriteDate: string | null,
    completedAt = new Date()
  ): Promise<MemberSyncStateDocument> {
    const memberCount = await this.collections.memberSnapshots.countDocuments({
      snapshot_id: snapshotId,
      company_odoo_id: companyOdooId
    });
    if (memberCount !== sourceTotal) {
      throw new Error(`Member snapshot validation failed: source=${sourceTotal}, staged=${memberCount}.`);
    }

    const previous = await this.syncState(companyOdooId);
    const state: MemberSyncStateDocument = {
      company_odoo_id: companyOdooId,
      member_count: memberCount,
      last_synced_at: completedAt,
      last_odoo_write_date: latestWriteDate || previous?.last_odoo_write_date || null,
      active_snapshot_id: snapshotId,
      sync_status: "complete",
      source_total: sourceTotal,
      last_run_id: snapshotId,
      last_run_started_at: previous?.last_run_started_at || null,
      last_run_completed_at: completedAt,
      last_error: null
    };
    await this.collections.syncState.updateOne(
      { company_odoo_id: companyOdooId },
      { $set: state },
      { upsert: true }
    );
    return state;
  }

  async markSnapshotFailed(companyOdooId: number, snapshotId: string, error: string): Promise<void> {
    await this.collections.syncState.updateOne(
      { company_odoo_id: companyOdooId },
      { $set: { sync_status: "failed", last_run_id: snapshotId, last_error: error } },
      { upsert: true }
    );
    await this.collections.memberSnapshots.deleteMany({ snapshot_id: snapshotId, company_odoo_id: companyOdooId });
  }

  async pruneSnapshots(companyOdooId: number, activeSnapshotId: string): Promise<void> {
    const previous = await this.collections.memberSnapshots
      .find({ company_odoo_id: companyOdooId, snapshot_id: { $ne: activeSnapshotId } })
      .sort({ snapshot_id: -1 })
      .limit(1)
      .toArray();
    const keepSnapshotIds = [activeSnapshotId, previous[0]?.snapshot_id].filter(
      (value): value is string => Boolean(value)
    );
    await this.collections.memberSnapshots.deleteMany({
      company_odoo_id: companyOdooId,
      snapshot_id: { $nin: keepSnapshotIds }
    });
  }

  async upsertSnapshot(companyOdooId: number, snapshot: Record<string, unknown>): Promise<void> {
    const members = extractMemberItems(snapshot).map((item) => normalizeMember(item, companyOdooId));
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
    const state = await this.syncState(options.companyOdooId);
    const snapshotId = options.snapshotId || state?.active_snapshot_id || null;
    if (state?.sync_status === "running" && !snapshotId) {
      return emptyMemberPage(options.offset, options.limit);
    }
    const collection = snapshotId ? this.collections.memberSnapshots : this.collections.members;
    const filter = this.memberFilter(options, snapshotId);
    const canUseSyncCount = !options.snapshotId && !options.updatedAfter &&
      !options.query &&
      !options.includeInactive &&
      typeof state?.member_count === "number";
    const totalPromise = canUseSyncCount
      ? Promise.resolve(state!.member_count)
      : collection.countDocuments(filter);
    const [items, total] = await Promise.all([
      collection
        .find(filter, { projection: { _id: 0, raw: 0 } })
        .sort({ write_date: 1, odoo_partner_id: 1 })
        .skip(options.offset)
        .limit(options.limit)
        .toArray(),
      totalPromise
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
    const state = await this.syncState(companyOdooId);
    if (state?.sync_status === "running" && !state.active_snapshot_id) return null;
    const collection = state?.active_snapshot_id ? this.collections.memberSnapshots : this.collections.members;
    const filter: Filter<MemberDocument> = {
      company_odoo_id: companyOdooId,
      odoo_partner_id: partnerId
    };
    if (state?.active_snapshot_id) {
      Object.assign(filter, { snapshot_id: state.active_snapshot_id });
    }
    const document = await collection.findOne(
      filter,
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

  private memberFilter(options: MemberListOptions, snapshotId: string | null): Filter<MemberDocument> {
    const filter: Filter<MemberDocument> = {
      company_odoo_id: options.companyOdooId,
      is_membership: true
    };
    if (snapshotId) {
      Object.assign(filter, { snapshot_id: snapshotId });
    }
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

export function extractMemberItems(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  return extractItems(snapshot.members ?? snapshot.partners);
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

function emptyMemberPage(offset: number, limit: number): Record<string, unknown> {
  return { items: [], offset, limit, total: 0, has_more: false };
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
