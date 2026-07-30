import assert from "node:assert/strict";
import test from "node:test";

import type { AuthContext } from "../src/auth-context.js";
import { ProductCatalogService } from "../src/catalog/service.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  nodeEnv: "test",
  apiPrefix: "/api/v1",
  host: "127.0.0.1",
  port: 3000,
  requestTimeoutMs: 1000,
  authServiceUrl: "http://auth.local",
  odooBaseUrl: "http://odoo.local",
  internalServiceKey: "internal",
  mongoUrl: "mongodb://mongo",
  mongoDbName: "catalog",
  redisUrl: "redis://redis",
  cacheTtlSeconds: 300,
  catalogMaxLimit: 1000,
  syncWorkerEnabled: false,
  syncWorkerIntervalMs: 60_000,
  syncWorkerInitialDelayMs: 5_000,
  syncWorkerRetryMinMs: 30_000,
  syncWorkerRetryMaxMs: 300_000,
  syncLookbackMinutes: 5,
  odooSyncDeviceCode: "test-catalog-worker",
  catalogSyncPosConfigIds: []
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

test("catalog runtime reads service cache without fetching Odoo when sync state exists", async () => {
  let odooFetchCalled = false;
  let productListCalled = false;
  const state = {
    pos_config_odoo_id: 12,
    warehouse_odoo_id: 3,
    warehouse_name: "Main Warehouse",
    product_count: 2,
    last_synced_at: new Date("2026-07-30T00:00:00Z"),
    last_odoo_write_date: "2026-07-29 12:00:00"
  };

  const repository = {
    syncState: async (posConfigId: number) => {
      assert.equal(posConfigId, 12);
      return state;
    },
    listProducts: async (options: Record<string, unknown>) => {
      productListCalled = true;
      assert.equal(options.warehouseId, 3);
      return {
        items: [{ id: 1, name: "Batik", warehouse_id: 3 }],
        offset: 0,
        limit: 100,
        total: 1,
        has_more: false
      };
    },
    upsertSnapshot: async () => {
      throw new Error("upsertSnapshot should not be called by runtime reads.");
    }
  };
  const redis = {
    get: async () => null,
    set: async () => undefined
  };

  const service = new ProductCatalogService(
    config,
    repository as never,
    redis as never,
    async () => {
      odooFetchCalled = true;
      throw new Error("Odoo fetch should not be called.");
    }
  );

  const ensure = await service.ensureSync(context, {
    pos_config: 12,
    offset: 0,
    limit: 100,
    refresh: false
  });
  const products = await service.products(context, {
    pos_config: 12,
    offset: 0,
    limit: 100,
    refresh: false
  });

  assert.equal(ensure.refreshed, false);
  assert.equal((products.products as Record<string, unknown>).total, 1);
  assert.equal(productListCalled, true);
  assert.equal(odooFetchCalled, false);
});
