import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../src/auth-context.js";
import type { AppConfig } from "../src/config.js";
import { CustomerMemberService } from "../src/member/service.js";

const config: AppConfig = {
  nodeEnv: "test",
  apiPrefix: "/api/v1",
  host: "127.0.0.1",
  port: 3001,
  requestTimeoutMs: 1000,
  authServiceUrl: "http://auth.local",
  odooBaseUrl: "http://odoo.local",
  internalServiceKey: "internal",
  mongoUrl: "mongodb://mongo",
  mongoDbName: "members",
  redisUrl: "redis://redis",
  cacheTtlSeconds: 300,
  memberMaxLimit: 1000,
  syncWorkerEnabled: false,
  syncWorkerIntervalMs: 60_000,
  syncWorkerInitialDelayMs: 5_000,
  syncWorkerRetryMinMs: 30_000,
  syncWorkerRetryMaxMs: 300_000,
  syncLookbackMinutes: 5,
  odooSyncDeviceCode: "test-member-worker"
};

const context: AuthContext = {
  user_id: "user-1",
  device_id: "device-1",
  odoo_user_id: 7,
  login: "admin",
  name: "Admin",
  role: "cashier",
  company_odoo_id: 1,
  warehouse_odoo_id: 3,
  pos_config_odoo_id: 12,
  device_code: "device-code",
  odoo_access_token: "odoo-token"
};

test("member runtime reads service cache without fetching Odoo when sync state exists", async () => {
  let odooFetchCalled = false;
  let memberListCalled = false;
  const state = {
    company_odoo_id: 1,
    member_count: 1,
    last_synced_at: new Date("2026-07-30T00:00:00Z"),
    last_odoo_write_date: "2026-07-29 12:00:00"
  };

  const repository = {
    syncState: async (companyId: number) => {
      assert.equal(companyId, 1);
      return state;
    },
    listMembers: async (options: Record<string, unknown>) => {
      memberListCalled = true;
      assert.equal(options.companyOdooId, 1);
      return {
        items: [{ id: 230, name: "Ricky", loyalty_points: 12 }],
        offset: 0,
        limit: 100,
        total: 1,
        has_more: false
      };
    },
    tiers: async () => [{ id: 1, name: "Gold" }],
    loyaltyPrograms: async () => [{ id: 5, name: "Points" }],
    upsertSnapshot: async () => {
      throw new Error("upsertSnapshot should not be called by runtime reads.");
    }
  };
  const redis = {
    del: async () => undefined
  };

  const service = new CustomerMemberService(
    config,
    repository as never,
    redis as never,
    async () => {
      odooFetchCalled = true;
      throw new Error("Odoo fetch should not be called.");
    }
  );

  const ensure = await service.ensureSync(context, {
    offset: 0,
    limit: 100,
    refresh: false,
    include_inactive: false
  });
  const members = await service.members(context, {
    offset: 0,
    limit: 100,
    refresh: false,
    include_inactive: false
  });

  assert.equal(ensure.refreshed, false);
  assert.equal((members.members as Record<string, unknown>).total, 1);
  assert.equal(memberListCalled, true);
  assert.equal(odooFetchCalled, false);
});
