import type { Redis } from "ioredis";

import { AuthContext } from "../auth-context.js";
import { AppConfig } from "../config.js";
import { badRequest } from "../errors.js";
import { fetchOdooMembers } from "../odoo-client.js";
import { MemberRepository } from "./repository.js";
import { MemberRequest } from "./schemas.js";

export class CustomerMemberService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: MemberRepository,
    private readonly redis: Redis
  ) {}

  async bootstrap(context: AuthContext, request: MemberRequest): Promise<Record<string, unknown>> {
    const companyId = this.resolveCompanyId(context);
    await this.fetchAndStore(context, companyId, request);
    return this.payloadFromCache(companyId, request);
  }

  async members(context: AuthContext, request: MemberRequest): Promise<Record<string, unknown>> {
    const companyId = this.resolveCompanyId(context);
    const state = await this.repository.syncState(companyId);
    if (!state || request.refresh || request.updated_after || request.last_update) {
      await this.fetchAndStore(context, companyId, request);
    }
    return this.payloadFromCache(companyId, request);
  }

  async search(context: AuthContext, request: MemberRequest): Promise<Record<string, unknown>> {
    return this.members(context, { ...request, query: request.query || request.q });
  }

  async member(context: AuthContext, partnerId: number, request: MemberRequest): Promise<Record<string, unknown>> {
    const companyId = this.resolveCompanyId(context);
    let member = await this.repository.findByOdooId(companyId, partnerId);
    if (!member || request.refresh) {
      await this.fetchAndStore(context, companyId, { ...request, offset: 0, limit: 1 }, partnerId);
      member = await this.repository.findByOdooId(companyId, partnerId);
    }
    return { item: member };
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
    const state = await this.repository.syncState(companyId);
    if (!state || request.refresh) {
      await this.fetchAndStore(context, companyId, { ...request, offset: 0, limit: 1 });
    }
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
        updatedAfter,
        query,
        includeInactive: request.include_inactive
      }),
      this.repository.tiers(companyId),
      this.repository.loyaltyPrograms(companyId),
      this.repository.syncState(companyId)
    ]);

    return {
      partners: members,
      members,
      tiers,
      loyalty_programs: loyaltyPrograms,
      company_id: companyId,
      last_synced_at: state?.last_synced_at?.toISOString?.() || null,
      last_odoo_write_date: state?.last_odoo_write_date || null
    };
  }

  private async fetchAndStore(
    context: AuthContext,
    companyId: number,
    request: MemberRequest,
    partnerId?: number
  ): Promise<void> {
    const snapshot = await fetchOdooMembers(this.config, context.odoo_access_token, {
      offset: request.offset,
      limit: this.clampLimit(request.limit),
      updated_after: request.updated_after || request.last_update,
      query: request.query || request.q,
      partner_id: partnerId,
      include_inactive: request.include_inactive
    });
    await this.repository.upsertSnapshot(companyId, snapshot);
    await this.redis.del(cacheKey(companyId));
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
