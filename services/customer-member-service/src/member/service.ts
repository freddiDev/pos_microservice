import type { Redis } from "ioredis";

import { AuthContext } from "../auth-context.js";
import { AppConfig } from "../config.js";
import { badRequest } from "../errors.js";
import { fetchOdooMembers } from "../odoo-client.js";
import { MemberRepository } from "./repository.js";
import { MemberRequest } from "./schemas.js";

type MemberFetcher = typeof fetchOdooMembers;

export class CustomerMemberService {
  private readonly syncLocks = new Map<number, Promise<Record<string, unknown>>>();

  constructor(
    private readonly config: AppConfig,
    private readonly repository: MemberRepository,
    private readonly redis: Redis,
    private readonly memberFetcher: MemberFetcher = fetchOdooMembers
  ) {}

  async bootstrap(context: AuthContext, request: MemberRequest): Promise<Record<string, unknown>> {
    const companyId = this.resolveCompanyId(context);
    await this.syncFromOdoo(context, companyId, request, await this.repository.syncState(companyId));
    return this.payloadFromCache(companyId, request);
  }

  async ensureSync(context: AuthContext, request: MemberRequest): Promise<Record<string, unknown>> {
    const companyId = this.resolveCompanyId(context);
    const state = await this.repository.syncState(companyId);
    if (state && !request.refresh) {
      return { ready: true, refreshed: false, sync_state: state };
    }

    const existingTask = this.syncLocks.get(companyId);
    if (existingTask) {
      return existingTask;
    }

    const task = this.syncFromOdoo(context, companyId, request, state)
      .catch((error) => {
        if (state) {
          return {
            ready: true,
            refreshed: false,
            stale: true,
            sync_state: state,
            error: error instanceof Error ? error.message : String(error)
          };
        }
        throw error;
      })
      .finally(() => {
        this.syncLocks.delete(companyId);
      });
    this.syncLocks.set(companyId, task);
    return task;
  }

  async members(context: AuthContext, request: MemberRequest): Promise<Record<string, unknown>> {
    const companyId = this.resolveCompanyId(context);
    return this.payloadFromCache(companyId, request);
  }

  async search(context: AuthContext, request: MemberRequest): Promise<Record<string, unknown>> {
    return this.members(context, { ...request, query: request.query || request.q });
  }

  async member(context: AuthContext, partnerId: number, request: MemberRequest): Promise<Record<string, unknown>> {
    const companyId = this.resolveCompanyId(context);
    return { item: await this.repository.findByOdooId(companyId, partnerId) };
  }

  async loyalty(context: AuthContext, partnerId: number, request: MemberRequest): Promise<Record<string, unknown>> {
    const companyId = this.resolveCompanyId(context);
    const memberPayload = await this.member(context, partnerId, request);
    return {
      ...memberPayload,
      loyalty_programs: await this.repository.loyaltyPrograms(companyId)
    };
  }

  async tiers(context: AuthContext, request: MemberRequest): Promise<Record<string, unknown>> {
    const companyId = this.resolveCompanyId(context);
    return { items: await this.repository.tiers(companyId) };
  }

  async status(companyId?: number): Promise<Record<string, unknown>> {
    if (!companyId) {
      return { ready: true };
    }
    return { sync_state: await this.repository.syncState(companyId) };
  }

  private async payloadFromCache(companyId: number, request: MemberRequest): Promise<Record<string, unknown>> {
    const query = request.query || request.q;
    const updatedAfter = request.updated_after || request.last_update;
    const [members, tiers, loyaltyPrograms, state] = await Promise.all([
      this.repository.listMembers({
        companyOdooId: companyId,
        offset: request.offset,
        limit: this.clampLimit(request.limit),
        snapshotId: request.snapshot_id,
        updatedAfter,
        query,
        includeInactive: request.include_inactive
      }),
      this.repository.tiers(companyId),
      this.repository.loyaltyPrograms(companyId),
      this.repository.syncState(companyId)
    ]);

    const snapshotId = request.snapshot_id || state?.active_snapshot_id || null;
    const syncStatus = state?.sync_status || (state?.last_synced_at ? "complete" : "running");
    const page = {
      ...members,
      snapshot_id: snapshotId,
      sync_status: syncStatus
    };

    return {
      partners: page,
      members: page,
      tiers,
      loyalty_programs: loyaltyPrograms,
      company_id: companyId,
      last_synced_at: state?.last_synced_at?.toISOString?.() || null,
      last_odoo_write_date: state?.last_odoo_write_date || null,
      sync_state: state,
      snapshot_id: snapshotId,
      sync_status: syncStatus
    };
  }

  private async fetchAndStore(
    context: AuthContext,
    companyId: number,
    request: MemberRequest,
    partnerId?: number
  ): Promise<Record<string, unknown>> {
    const snapshot = await this.memberFetcher(this.config, context.odoo_access_token, {
      offset: request.offset,
      limit: this.clampLimit(request.limit),
      updated_after: request.updated_after || request.last_update,
      query: request.query || request.q,
      partner_id: partnerId,
      include_inactive: request.include_inactive
    });
    await this.repository.upsertSnapshot(companyId, snapshot);
    await this.redis.del(cacheKey(companyId));
    return snapshot;
  }

  private async syncFromOdoo(
    context: AuthContext,
    companyId: number,
    request: MemberRequest,
    existingState: Awaited<ReturnType<MemberRepository["syncState"]>>
  ): Promise<Record<string, unknown>> {
    const limit = this.clampLimit(request.limit || this.config.memberMaxLimit);
    const updatedAfter = request.updated_after || request.last_update || (request.refresh ? existingState?.last_odoo_write_date || undefined : undefined);
    let offset = 0;
    let syncedCount = 0;
    let total = 0;
    let pages = 0;
    let hasMore = true;

    while (hasMore) {
      const snapshot = await this.fetchAndStore(context, companyId, {
        ...request,
        offset,
        limit,
        updated_after: updatedAfter
      });
      pages += 1;
      const page = pageInfo(snapshot.members ?? snapshot.partners);
      syncedCount += page.items.length;
      total = page.total || total;
      if (syncedCount < total && page.items.length === 0) {
        throw new Error("Odoo returned an empty member page before total was reached.");
      }
      hasMore = syncedCount < total;
      offset += page.items.length;
    }

    const state = await this.repository.syncState(companyId);
    return {
      ready: true,
      refreshed: true,
      sync_state: state,
      pages,
      synced_count: syncedCount,
      total
    };
  }

  private resolveCompanyId(context: AuthContext): number {
    const companyId = context.company_odoo_id;
    if (!companyId) {
      throw badRequest("COMPANY_REQUIRED", "Authenticated user does not have an Odoo company.");
    }
    return companyId;
  }

  private clampLimit(value: number): number {
    return Math.min(Math.max(value, 1), this.config.memberMaxLimit);
  }
}

function cacheKey(companyId: number): string {
  return `members:company:${companyId}:state`;
}

function pageInfo(source: unknown): { items: Record<string, unknown>[]; total: number; hasMore: boolean } {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Odoo member response did not contain a pagination page.");
  }
  const page = source as Record<string, unknown>;
  const items = Array.isArray(page.items)
    ? page.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const total = toNumber(page.total);
  if (total === null || total < 0) {
    throw new Error("Odoo member response did not contain a valid total.");
  }
  return {
    items,
    total,
    hasMore: page.has_more === true || page.hasMore === true
  };
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}
