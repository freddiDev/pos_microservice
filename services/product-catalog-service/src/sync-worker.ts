import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "./config.js";
import { ProductDocument, ProductImageDocument } from "./catalog/normalizers.js";
import { fetchOdooCatalog, fetchOdooProductImage } from "./odoo-client.js";
import type { ProductCatalogRepository } from "./catalog/repository.js";

type Logger = {
  debug: (value: unknown, message?: string) => void;
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
  error: (value: unknown, message?: string) => void;
};

type OdooSyncSession = {
  accessToken: string;
  expiresAt: Date | null;
};

export class CatalogSyncWorker {
  private readonly workerId = `catalog-sync-${process.pid}-${Math.random().toString(16).slice(2)}`;
  private readonly statusKey = "sync:catalog:worker:status";
  private readonly lockTtlMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private retryDelayMs: number;
  private session: OdooSyncSession | null = null;
  private readonly imageJobs = new Map<number, Promise<void>>();
  private statusState: Record<string, unknown> = {
    domain: "catalog",
    enabled: false,
    running: false,
    last_started_at: null,
    last_success_at: null,
    last_failure_at: null,
    last_error: null,
    last_result: null,
    next_run_at: null
  };

  constructor(
    private readonly config: AppConfig,
    private readonly repository: ProductCatalogRepository,
    private readonly redis: Redis,
    private readonly logger: Logger
  ) {
    this.lockTtlMs = Math.max(config.syncWorkerIntervalMs * 2, 120_000);
    this.retryDelayMs = config.syncWorkerRetryMinMs;
  }

  start(): void {
    if (!this.config.syncWorkerEnabled) {
      this.logger.info("Catalog sync worker disabled.");
      this.setStatus({ enabled: false, running: false, next_run_at: null });
      return;
    }
    if (!this.config.odooSyncUsername || !this.config.odooSyncPassword) {
      this.logger.warn("Catalog sync worker enabled but ODOO_SYNC_USERNAME/ODOO_SYNC_PASSWORD is missing.");
      this.setStatus({
        enabled: true,
        running: false,
        last_error: "ODOO_SYNC_USERNAME/ODOO_SYNC_PASSWORD is missing.",
        next_run_at: null
      });
      return;
    }
    if (!this.stopped) return;
    this.stopped = false;
    this.setStatus({ enabled: true, running: false, last_error: null });
    this.schedule(this.config.syncWorkerInitialDelayMs);
    this.logger.info("Catalog sync worker started.");
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.setStatus({ running: false, next_run_at: null });
  }

  async status(): Promise<Record<string, unknown>> {
    const raw = await this.redis.get(this.statusKey);
    if (!raw) {
      return { ...this.statusState, enabled: this.config.syncWorkerEnabled, running: this.running };
    }
    try {
      return { ...JSON.parse(raw), enabled: this.config.syncWorkerEnabled, running: this.running };
    } catch {
      return { ...this.statusState, enabled: this.config.syncWorkerEnabled, running: this.running };
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.setStatus({ next_run_at: new Date(Date.now() + delayMs).toISOString() });
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.setStatus({
      running: true,
      last_started_at: new Date().toISOString(),
      last_error: null,
      next_run_at: null
    });
    try {
      const result = await this.syncOnce();
      this.retryDelayMs = this.config.syncWorkerRetryMinMs;
      this.setStatus({
        running: false,
        last_success_at: new Date().toISOString(),
        last_error: null,
        last_result: result
      });
      this.logger.info(result, "Catalog sync worker completed.");
      this.schedule(this.config.syncWorkerIntervalMs);
    } catch (error) {
      this.session = null;
      const message = errorMessage(error);
      this.setStatus({
        running: false,
        last_failure_at: new Date().toISOString(),
        last_error: message
      });
      this.logger.error({ error: message, retry_ms: this.retryDelayMs }, "Catalog sync worker failed.");
      this.schedule(this.retryDelayMs);
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.config.syncWorkerRetryMaxMs);
    } finally {
      this.running = false;
    }
  }

  async syncOnce(): Promise<Record<string, unknown>> {
    const session = await this.getSession();
    const allConfigs = await fetchOdooPosConfigs(this.config, session.accessToken);
    const configuredIds = new Set(this.config.catalogSyncPosConfigIds);
    const configIds = allConfigs
      .map((item) => toNumber(item.odoo_config_id ?? item.id))
      .filter((id): id is number => id !== null)
      .filter((id) => configuredIds.size === 0 || configuredIds.has(id));

    let syncedConfigs = 0;
    let syncedProducts = 0;
    let syncedImages = 0;
    let failedImages = 0;
    const configResults: Record<string, unknown>[] = [];
    for (const posConfigId of configIds) {
      const result = await this.syncConfig(posConfigId, session.accessToken);
      if (result.locked === true) continue;
      syncedConfigs += 1;
      syncedProducts += result.synced_count;
      syncedImages += result.images_synced;
      failedImages += result.images_failed;
      configResults.push({ pos_config_id: posConfigId, ...result });
    }

    return {
      configs_seen: configIds.length,
      configs_synced: syncedConfigs,
      products_synced: syncedProducts,
      images_synced: syncedImages,
      images_failed: failedImages,
      configs: configResults
    };
  }

  private async syncConfig(
    posConfigId: number,
    accessToken: string
  ): Promise<{
    locked?: boolean;
    synced_count: number;
    images_synced: number;
    images_failed: number;
    images_pending?: boolean;
    snapshot_id?: string;
    source_total?: number;
    service_total?: number;
    source_scope?: string;
    snapshot_replaced?: boolean;
  }> {
    const lockKey = `sync:catalog:pos_config:${posConfigId}`;
    const lock = await this.redis.set(lockKey, this.workerId, "PX", this.lockTtlMs, "NX");
    if (lock !== "OK") {
      this.logger.debug({ pos_config: posConfigId }, "Catalog sync skipped because lock is held.");
      return { locked: true, synced_count: 0, images_synced: 0, images_failed: 0 };
    }
    const lockRenewal = this.startLockRenewal(lockKey);

    const snapshotId = `${new Date().toISOString()}-${randomUUID()}`;
    try {
      const previousState = await this.repository.syncState(posConfigId);
      await this.repository.beginSnapshot(posConfigId, snapshotId);
      let offset = 0;
      let syncedCount = 0;
      let sourceTotal = 0;
      let latestWriteDate: string | null = null;
      let firstSnapshot: Record<string, unknown> | null = null;
      let hasMore = true;

      while (hasMore) {
        const snapshot = await fetchOdooCatalog(this.config, accessToken, {
          pos_config: posConfigId,
          offset,
          limit: this.config.catalogMaxLimit
        });
        firstSnapshot ??= snapshot;

        const page = pageInfo(snapshot.products);
        if (sourceTotal === 0) sourceTotal = page.total;
        if (page.total !== sourceTotal) {
          throw new Error(`Product source total changed during sync: ${sourceTotal} -> ${page.total}.`);
        }
        const written = await this.repository.writeSnapshotPage(posConfigId, snapshotId, snapshot);
        latestWriteDate = maxWriteDate(latestWriteDate, written.latestWriteDate);
        syncedCount += page.items.length;
        if (syncedCount < sourceTotal && page.items.length === 0) {
          throw new Error("Odoo returned an empty product page before source_total was reached.");
        }
        hasMore = syncedCount < sourceTotal;
        offset += page.items.length;
      }

      const previousTotal = previousState?.source_total ?? previousState?.product_count;
      const previousSnapshotId = previousState?.active_snapshot_id;
      const unchanged = Boolean(
        previousSnapshotId &&
          previousTotal === sourceTotal &&
          previousState.last_odoo_write_date &&
          latestWriteDate &&
          previousState.last_odoo_write_date === latestWriteDate
      );
      if (unchanged && previousSnapshotId) {
        await this.repository.discardUnchangedSnapshot(posConfigId, snapshotId);
        if (this.config.catalogImageSyncEnabled) {
          this.scheduleImageSync(accessToken, previousSnapshotId!, posConfigId);
        }
        return {
          synced_count: 0,
          images_synced: 0,
          images_failed: 0,
          snapshot_id: previousSnapshotId,
          source_total: sourceTotal,
          service_total: previousState!.product_count,
          source_scope: "product.product:active=true,available_in_pos=true,sale_ok=true,warehouse_cv_assignment",
          snapshot_replaced: false,
          images_pending: this.config.catalogImageSyncEnabled
        };
      }

      const state = await this.repository.commitSnapshot(
        posConfigId,
        snapshotId,
        firstSnapshot ?? {},
        sourceTotal,
        latestWriteDate
      );
      void this.repository.pruneSnapshots(posConfigId, snapshotId);

      // A full product snapshot is the sync contract. Image blobs are
      // optional enrichment and must not keep the catalog worker in running
      // state or delay the next product sync.
      if (this.config.catalogImageSyncEnabled) {
        this.scheduleImageSync(accessToken, snapshotId, posConfigId);
      }

      return {
        synced_count: syncedCount,
        // Image enrichment starts after the product snapshot is available.
        // It must never extend the product sync critical path.
        images_synced: 0,
        images_failed: 0,
        snapshot_id: snapshotId,
        source_total: sourceTotal,
        service_total: state.product_count,
        source_scope: "product.product:active=true,available_in_pos=true,sale_ok=true,warehouse_cv_assignment",
        snapshot_replaced: true,
        images_pending: this.config.catalogImageSyncEnabled
      };
    } catch (error) {
      await this.repository.markSnapshotFailed(posConfigId, snapshotId, errorMessage(error));
      throw error;
    } finally {
      clearInterval(lockRenewal);
      if ((await this.redis.get(lockKey)) === this.workerId) {
        await this.redis.del(lockKey);
      }
    }
  }

  private startLockRenewal(lockKey: string): NodeJS.Timeout {
    const renewal = setInterval(() => {
      void this.redis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
          1,
          lockKey,
          this.workerId,
          String(this.lockTtlMs)
        )
        .catch((error) => {
          this.logger.warn(
            { lock_key: lockKey, error: errorMessage(error) },
            "Failed to renew catalog sync lock."
          );
        });
    }, Math.max(Math.floor(this.lockTtlMs / 3), 5_000));
    renewal.unref?.();
    return renewal;
  }

  private scheduleImageSync(
    accessToken: string,
    snapshotId: string,
    posConfigId: number
  ): void {
    const previous = this.imageJobs.get(posConfigId) ?? Promise.resolve();
    const job = previous
      .catch(() => undefined)
      .then(async () => {
        const result = await this.syncImagesForSnapshot(
          accessToken,
          snapshotId,
          posConfigId
        );
        this.logger.info(
          { pos_config_id: posConfigId, snapshot_id: snapshotId, ...result },
          "Catalog image sync completed."
        );
      })
      .catch((error) => {
        this.logger.error(
          { pos_config_id: posConfigId, snapshot_id: snapshotId, error: errorMessage(error) },
          "Catalog image sync failed; product snapshot remains usable."
        );
      });
    const tracked = job.finally(() => {
      if (this.imageJobs.get(posConfigId) === tracked) {
        this.imageJobs.delete(posConfigId);
      }
    });
    this.imageJobs.set(posConfigId, tracked);
  }

  private async syncImagesForSnapshot(
    accessToken: string,
    snapshotId: string,
    posConfigId: number
  ): Promise<{ synced: number; failed: number }> {
    let offset = 0;
    let synced = 0;
    let failed = 0;
    const batchSize = Math.max(this.config.catalogMaxLimit, 1000);
    let firstBatch = true;

    while (true) {
      const limit = firstBatch
        ? Math.min(batchSize, Math.max(this.config.catalogImageEagerCount, 1))
        : batchSize;
      const products = await this.repository.listSnapshotProductsForImages(
        posConfigId,
        snapshotId,
        offset,
        limit
      );
      if (!products.length) break;

      const result = await this.syncImagesForProducts(
        accessToken,
        products,
        snapshotId,
        posConfigId
      );
      synced += result.synced;
      failed += result.failed;
      offset += products.length;
      firstBatch = false;
    }

    return { synced, failed };
  }

  private async syncImagesForProducts(
    accessToken: string,
    products: ProductDocument[],
    snapshotId: string,
    posConfigId: number
  ): Promise<{ synced: number; failed: number }> {
    if (!products.length) return { synced: 0, failed: 0 };
    const linked = await this.repository.linkExistingImagesToSnapshot(
      products,
      snapshotId,
      posConfigId
    );
    const needingSync = await this.repository.imagesNeedingSync(products);
    if (!needingSync.length) {
      return { synced: linked, failed: 0 };
    }

    const results = await mapWithConcurrency(
      needingSync,
      this.config.catalogImageSyncConcurrency,
      async (product) => this.fetchProductImage(accessToken, product)
    );
    const images = results.flatMap((item) => (item.image && item.error === null ? [item.image] : []));
    if (images.length) {
      await this.repository.upsertProductImages(images, snapshotId, posConfigId);
    }

    const failed = results.filter((item) => item.error !== null).length;
    return { synced: linked + images.length, failed };
  }

  private async fetchProductImage(
    accessToken: string,
    product: ProductDocument
  ): Promise<{ image: ProductImageDocument | null; error: string | null }> {
    try {
      const image = await fetchOdooProductImage(this.config, accessToken, product.odoo_product_id, product.image_url);
      if (!image) {
        return { image: null, error: null };
      }
      return {
        image: {
          odoo_product_id: product.odoo_product_id,
          warehouse_odoo_id: product.warehouse_odoo_id,
          content_type: image.contentType,
          data: image.data,
          checksum: image.checksum,
          size: image.size,
          source_url: image.sourceUrl,
          source_write_date: product.write_date,
          synced_at: new Date()
        },
        error: null
      };
    } catch (error) {
      this.logger.warn(
        {
          product_id: product.odoo_product_id,
          warehouse_id: product.warehouse_odoo_id,
          error: errorMessage(error)
        },
        "Failed to sync product image."
      );
      return { image: null, error: errorMessage(error) };
    }
  }

  private async getSession(): Promise<OdooSyncSession> {
    if (this.session && (!this.session.expiresAt || this.session.expiresAt.getTime() - Date.now() > 60_000)) {
      return this.session;
    }
    const data = await loginToOdoo(this.config);
    this.session = data;
    return data;
  }

  private setStatus(patch: Record<string, unknown>): void {
    this.statusState = { ...this.statusState, ...patch };
    void this.persistStatus();
  }

  private async persistStatus(): Promise<void> {
    try {
      await this.redis.set(this.statusKey, JSON.stringify(this.statusState));
    } catch (error) {
      this.logger.warn({ error: errorMessage(error) }, "Failed to persist catalog sync worker status.");
    }
  }
}

async function loginToOdoo(config: AppConfig): Promise<OdooSyncSession> {
  const response = await postOdoo(config, "/api/microservice/auth/login", {
    login: config.odooSyncUsername,
    password: config.odooSyncPassword,
    device_code: config.odooSyncDeviceCode
  });
  const accessToken = stringValue(response.odoo_access_token);
  if (!accessToken) {
    throw new Error("Odoo sync login did not return odoo_access_token.");
  }
  return {
    accessToken,
    expiresAt: expiryFromResponse(response)
  };
}

async function fetchOdooPosConfigs(config: AppConfig, accessToken: string): Promise<Record<string, unknown>[]> {
  const response = await postOdoo(config, "/api/microservice/pos/configs", {}, accessToken);
  const items = response.items;
  return Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

async function postOdoo(
  config: AppConfig,
  path: string,
  payload: Record<string, unknown>,
  accessToken?: string
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.odooRequestTimeoutMs);
  try {
    const response = await fetch(`${config.odooBaseUrl}${path}`, {
      method: "POST",
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const body = await safeJson(response);
    const envelope = unwrapEnvelope(body);
    if (!response.ok || envelope?.success !== true) {
      throw new Error(String(envelope?.message || envelope?.error || `Odoo HTTP ${response.status}`));
    }
    const data = envelope.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Odoo returned invalid data payload.");
    }
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Odoo request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}

function unwrapEnvelope(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const result = record.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return record;
}

function pageInfo(source: unknown): { items: Record<string, unknown>[]; total: number; hasMore: boolean } {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Odoo catalog response did not contain a pagination page.");
  }
  const page = source as Record<string, unknown>;
  const items = Array.isArray(page.items)
    ? page.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const total = toNumber(page.total);
  if (total === null || total < 0) {
    throw new Error("Odoo catalog response did not contain a valid total.");
  }
  return {
    items,
    total,
    hasMore: page.has_more === true || page.hasMore === true
  };
}

function maxWriteDate(current: string | null, candidate: string | null): string | null {
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate > current ? candidate : current;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]);
      }
    })
  );

  return results;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function dateValue(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text) return null;
  const parsed = new Date(text.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function expiryFromResponse(response: Record<string, unknown>): Date | null {
  const explicit = dateValue(response.expires_at);
  if (explicit) return explicit;
  const expiresIn = toNumber(response.expires_in);
  return expiresIn === null || expiresIn <= 0
    ? null
    : new Date(Date.now() + expiresIn * 1000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
