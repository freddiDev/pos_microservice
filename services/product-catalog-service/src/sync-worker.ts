import type { Redis } from "ioredis";

import type { AppConfig } from "./config.js";
import { fetchOdooCatalog } from "./odoo-client.js";
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
    for (const posConfigId of configIds) {
      const result = await this.syncConfig(posConfigId, session.accessToken);
      if (result.locked === true) continue;
      syncedConfigs += 1;
      syncedProducts += result.synced_count;
    }

    return {
      configs_seen: configIds.length,
      configs_synced: syncedConfigs,
      products_synced: syncedProducts
    };
  }

  private async syncConfig(posConfigId: number, accessToken: string): Promise<{ locked?: boolean; synced_count: number }> {
    const lockKey = `sync:catalog:pos_config:${posConfigId}`;
    const lock = await this.redis.set(lockKey, this.workerId, "PX", this.lockTtlMs, "NX");
    if (lock !== "OK") {
      this.logger.debug({ pos_config: posConfigId }, "Catalog sync skipped because lock is held.");
      return { locked: true, synced_count: 0 };
    }

    try {
      const state = await this.repository.syncState(posConfigId);
      const updatedAfter = subtractMinutes(state?.last_odoo_write_date, this.config.syncLookbackMinutes);
      let offset = 0;
      let syncedCount = 0;
      let hasMore = true;

      while (hasMore) {
        const snapshot = await fetchOdooCatalog(this.config, accessToken, {
          pos_config: posConfigId,
          offset,
          limit: this.config.catalogMaxLimit,
          updated_after: updatedAfter
        });
        await this.repository.upsertSnapshot(posConfigId, snapshot);

        const page = pageInfo(snapshot.products);
        syncedCount += page.items.length;
        hasMore = page.hasMore && page.items.length > 0;
        offset += page.items.length;
      }

      return { synced_count: syncedCount };
    } finally {
      if ((await this.redis.get(lockKey)) === this.workerId) {
        await this.redis.del(lockKey);
      }
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
    expiresAt: dateValue(response.expires_at)
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
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
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

function pageInfo(source: unknown): { items: Record<string, unknown>[]; hasMore: boolean } {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { items: [], hasMore: false };
  }
  const page = source as Record<string, unknown>;
  const items = Array.isArray(page.items)
    ? page.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  return {
    items,
    hasMore: page.has_more === true || page.hasMore === true
  };
}

function subtractMinutes(value: string | null | undefined, minutes: number): string | undefined {
  if (!value) return undefined;
  if (minutes <= 0) return value;
  const parsed = new Date(`${value.replace(" ", "T").replace(/Z$/, "")}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  parsed.setMinutes(parsed.getMinutes() - minutes);
  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
