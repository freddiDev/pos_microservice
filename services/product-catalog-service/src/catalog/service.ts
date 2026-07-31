import type { Redis } from "ioredis";

import { AuthContext } from "../auth-context.js";
import { AppConfig } from "../config.js";
import { badRequest } from "../errors.js";
import { fetchOdooCatalog } from "../odoo-client.js";
import { CatalogRequest } from "./schemas.js";
import { ProductCatalogRepository } from "./repository.js";

type CatalogFetcher = typeof fetchOdooCatalog;

export type ProductImagePayload = {
  contentType: string;
  data: Buffer;
  etag: string;
  size: number;
};

export class ProductCatalogService {
  private readonly syncLocks = new Map<number, Promise<Record<string, unknown>>>();

  constructor(
    private readonly config: AppConfig,
    private readonly repository: ProductCatalogRepository,
    private readonly redis: Redis,
    private readonly catalogFetcher: CatalogFetcher = fetchOdooCatalog
  ) {}

  async bootstrap(context: AuthContext, request: CatalogRequest): Promise<Record<string, unknown>> {
    const posConfigId = this.resolvePosConfigId(context, request);
    return this.fetchAndStore(context, posConfigId, request);
  }

  async ensureSync(context: AuthContext, request: CatalogRequest): Promise<Record<string, unknown>> {
    const posConfigId = this.resolvePosConfigId(context, request);
    const state = await this.repository.syncState(posConfigId);
    if (state && !request.refresh) {
      return { ready: true, refreshed: false, sync_state: state };
    }

    const existingTask = this.syncLocks.get(posConfigId);
    if (existingTask) {
      return existingTask;
    }

    const task = this.syncFromOdoo(context, posConfigId, request, state)
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
        this.syncLocks.delete(posConfigId);
      });
    this.syncLocks.set(posConfigId, task);
    return task;
  }

  async products(context: AuthContext, request: CatalogRequest): Promise<Record<string, unknown>> {
    const posConfigId = this.resolvePosConfigId(context, request);
    const state = await this.repository.syncState(posConfigId);
    const limit = this.clampLimit(request.limit);
    if (!state) {
      const products = emptyPage(request.offset, limit, null, "running");
      return {
        products,
        config: {
          pos_config_id: posConfigId,
          warehouse_id: null,
          warehouse_name: null,
          last_synced_at: null
        },
        sync_state: null,
        snapshot_id: null,
        sync_status: "running",
        cache: "empty"
      };
    }

    const snapshotId = state.active_snapshot_id || null;
    const syncStatus = state.sync_status || (state.last_synced_at ? "complete" : "running");
    const page = await this.repository.listProducts({
      posConfigId,
      warehouseId: state.warehouse_odoo_id,
      offset: request.offset,
      limit,
      updatedAfter: request.updated_after || request.last_update
    });
    return {
      products: {
        ...page,
        snapshot_id: snapshotId,
        sync_status: syncStatus
      },
      config: {
        pos_config_id: posConfigId,
        warehouse_id: state.warehouse_odoo_id,
        warehouse_name: state.warehouse_name,
        last_synced_at: state.last_synced_at?.toISOString?.() || null
      },
      sync_state: state,
      snapshot_id: snapshotId,
      sync_status: syncStatus
    };
  }

  async barcode(context: AuthContext, request: CatalogRequest, barcode: string): Promise<Record<string, unknown>> {
    const posConfigId = this.resolvePosConfigId(context, request);
    const state = await this.repository.syncState(posConfigId);
    if (!state) {
      return { item: null, cache: "empty" };
    }

    const cacheKey = `catalog:barcode:${posConfigId}:${state.active_snapshot_id || "legacy"}:${barcode}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { item: JSON.parse(cached), cache: "hit" };
    }

    const product = await this.repository.findByBarcode(posConfigId, state.warehouse_odoo_id, barcode);
    if (product) {
      await this.redis.set(cacheKey, JSON.stringify(product), "EX", this.config.cacheTtlSeconds);
    }
    return { item: product, cache: product ? "miss" : "not_found" };
  }

  async product(context: AuthContext, request: CatalogRequest, productId: number): Promise<Record<string, unknown>> {
    const posConfigId = this.resolvePosConfigId(context, request);
    const state = await this.repository.syncState(posConfigId);
    if (!state) {
      return { item: null, cache: "empty" };
    }
    return {
      item: await this.repository.findByOdooId(posConfigId, state.warehouse_odoo_id, productId)
    };
  }

  async productImage(context: AuthContext, request: CatalogRequest, productId: number): Promise<ProductImagePayload | null> {
    const warehouseId = await this.resolveWarehouseId(context, request);
    const image = await this.repository.findImage(warehouseId, productId);
    if (!image) return null;
    return {
      contentType: image.content_type,
      data: imageDataBuffer(image.data),
      etag: image.checksum,
      size: image.size
    };
  }

  async status(posConfigId?: number): Promise<Record<string, unknown>> {
    if (!posConfigId) {
      return { ready: true };
    }
    return { sync_state: await this.repository.syncState(posConfigId) };
  }

  private async fetchAndStore(
    context: AuthContext,
    posConfigId: number,
    request: CatalogRequest & { barcode?: string; product_id?: number }
  ): Promise<Record<string, unknown>> {
    const snapshot = await this.catalogFetcher(this.config, context.odoo_access_token, {
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

  private async syncFromOdoo(
    context: AuthContext,
    posConfigId: number,
    request: CatalogRequest,
    existingState: Awaited<ReturnType<ProductCatalogRepository["syncState"]>>
  ): Promise<Record<string, unknown>> {
    const limit = this.clampLimit(request.limit || this.config.catalogMaxLimit);
    const updatedAfter = request.updated_after || request.last_update || (request.refresh ? existingState?.last_odoo_write_date || undefined : undefined);
    let offset = 0;
    let syncedCount = 0;
    let total = 0;
    let pages = 0;
    let hasMore = true;

    while (hasMore) {
      const snapshot = await this.fetchAndStore(context, posConfigId, {
        ...request,
        offset,
        limit,
        updated_after: updatedAfter
      });
      pages += 1;
      const page = pageInfo(snapshot.products);
      syncedCount += page.items.length;
      total = page.total || total;
      hasMore = page.hasMore && page.items.length > 0;
      offset += page.items.length;
    }

    const state = await this.repository.syncState(posConfigId);
    if (!state) {
      throw badRequest("CATALOG_SYNC_EMPTY", "Catalog sync did not produce warehouse state.");
    }

    return {
      ready: true,
      refreshed: true,
      sync_state: state,
      pages,
      synced_count: syncedCount,
      total
    };
  }

  private resolvePosConfigId(context: AuthContext, request: CatalogRequest): number {
    const value = request.pos_config || request.pos_config_odoo_id || context.pos_config_odoo_id;
    if (!value) {
      throw badRequest("POS_CONFIG_REQUIRED", "pos_config is required for catalog requests.");
    }
    return value;
  }

  private async resolveWarehouseId(context: AuthContext, request: CatalogRequest): Promise<number> {
    const explicitWarehouse = request.warehouse_id || context.warehouse_odoo_id;
    const posConfigId = request.pos_config || request.pos_config_odoo_id || context.pos_config_odoo_id;
    if (posConfigId) {
      const state = await this.repository.syncState(posConfigId);
      if (state?.warehouse_odoo_id) return state.warehouse_odoo_id;
    }
    if (explicitWarehouse) return explicitWarehouse;
    throw badRequest("WAREHOUSE_REQUIRED", "pos_config or warehouse_id is required for product image requests.");
  }

  private clampLimit(value: number): number {
    return Math.min(Math.max(value, 1), this.config.catalogMaxLimit);
  }
}

function imageDataBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === "object" && "buffer" in value) {
    const buffer = (value as { buffer?: Buffer | Uint8Array }).buffer;
    if (buffer) return Buffer.from(buffer);
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.alloc(0);
}

function emptyPage(
  offset: number,
  limit: number,
  snapshotId: string | null = null,
  syncStatus: string | null = null
): Record<string, unknown> {
  return {
    items: [],
    offset,
    limit,
    total: 0,
    has_more: false,
    snapshot_id: snapshotId,
    sync_status: syncStatus
  };
}

function pageInfo(source: unknown): { items: Record<string, unknown>[]; total: number; hasMore: boolean } {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { items: [], total: 0, hasMore: false };
  }
  const page = source as Record<string, unknown>;
  const items = Array.isArray(page.items)
    ? page.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  return {
    items,
    total: toNumber(page.total) || items.length,
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
