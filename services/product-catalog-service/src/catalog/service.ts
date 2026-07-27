import type { Redis } from "ioredis";

import { AuthContext } from "../auth-context.js";
import { AppConfig } from "../config.js";
import { badRequest } from "../errors.js";
import { fetchOdooCatalog } from "../odoo-client.js";
import { CatalogRequest } from "./schemas.js";
import { ProductCatalogRepository } from "./repository.js";

export class ProductCatalogService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: ProductCatalogRepository,
    private readonly redis: Redis
  ) {}

  async bootstrap(context: AuthContext, request: CatalogRequest): Promise<Record<string, unknown>> {
    const posConfigId = this.resolvePosConfigId(context, request);
    const snapshot = await this.fetchAndStore(context, posConfigId, request);
    return snapshot;
  }

  async products(context: AuthContext, request: CatalogRequest): Promise<Record<string, unknown>> {
    const posConfigId = this.resolvePosConfigId(context, request);
    let state = await this.repository.syncState(posConfigId);
    if (!state || request.refresh) {
      await this.fetchAndStore(context, posConfigId, request);
      state = await this.repository.syncState(posConfigId);
      if (!state) {
        throw badRequest("CATALOG_SYNC_EMPTY", "Catalog sync did not produce warehouse state.");
      }
    }

    return {
      products: await this.repository.listProducts({
        warehouseId: state.warehouse_odoo_id,
        offset: request.offset,
        limit: this.clampLimit(request.limit),
        updatedAfter: request.updated_after || request.last_update
      }),
      config: {
        pos_config_id: posConfigId,
        warehouse_id: state.warehouse_odoo_id,
        warehouse_name: state.warehouse_name,
        last_synced_at: state.last_synced_at.toISOString()
      }
    };
  }

  async barcode(context: AuthContext, request: CatalogRequest, barcode: string): Promise<Record<string, unknown>> {
    const posConfigId = this.resolvePosConfigId(context, request);
    const state = await this.ensureState(context, posConfigId, request);
    const cacheKey = `catalog:barcode:${state.warehouse_odoo_id}:${barcode}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { item: JSON.parse(cached), cache: "hit" };
    }

    let product = await this.repository.findByBarcode(state.warehouse_odoo_id, barcode);
    if (!product) {
      await this.fetchAndStore(context, posConfigId, { ...request, barcode, limit: 1, offset: 0 });
      product = await this.repository.findByBarcode(state.warehouse_odoo_id, barcode);
    }
    if (product) {
      await this.redis.set(cacheKey, JSON.stringify(product), "EX", this.config.cacheTtlSeconds);
    }
    return { item: product, cache: "miss" };
  }

  async product(context: AuthContext, request: CatalogRequest, productId: number): Promise<Record<string, unknown>> {
    const posConfigId = this.resolvePosConfigId(context, request);
    const state = await this.ensureState(context, posConfigId, request);
    let product = await this.repository.findByOdooId(state.warehouse_odoo_id, productId);
    if (!product) {
      await this.fetchAndStore(context, posConfigId, { ...request, product_id: productId, limit: 1, offset: 0 } as CatalogRequest & { product_id: number });
      product = await this.repository.findByOdooId(state.warehouse_odoo_id, productId);
    }
    return { item: product };
  }

  async status(posConfigId?: number): Promise<Record<string, unknown>> {
    if (!posConfigId) {
      return { ready: true };
    }
    return { sync_state: await this.repository.syncState(posConfigId) };
  }

  private async ensureState(context: AuthContext, posConfigId: number, request: CatalogRequest) {
    const state = await this.repository.syncState(posConfigId);
    if (state) return state;
    return this.repository.upsertSnapshot(posConfigId, await this.fetchAndStore(context, posConfigId, request));
  }

  private async fetchAndStore(
    context: AuthContext,
    posConfigId: number,
    request: CatalogRequest & { barcode?: string; product_id?: number }
  ): Promise<Record<string, unknown>> {
    const snapshot = await fetchOdooCatalog(this.config, context.odoo_access_token, {
      pos_config: posConfigId,
      offset: request.offset,
      limit: this.clampLimit(request.limit),
      updated_after: request.updated_after || request.last_update,
      barcode: request.barcode,
      product_id: request.product_id
    });
    await this.repository.upsertSnapshot(posConfigId, snapshot);
    return snapshot;
  }

  private resolvePosConfigId(context: AuthContext, request: CatalogRequest): number {
    const value = request.pos_config || request.pos_config_odoo_id || context.pos_config_odoo_id;
    if (!value) {
      throw badRequest("POS_CONFIG_REQUIRED", "pos_config is required for catalog requests.");
    }
    return value;
  }

  private clampLimit(value: number): number {
    return Math.min(Math.max(value, 1), this.config.catalogMaxLimit);
  }
}
