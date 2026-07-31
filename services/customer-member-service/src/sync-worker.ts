import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "./config.js";
import { fetchOdooMembers } from "./odoo-client.js";
import type { MemberRepository } from "./member/repository.js";

type Logger = {
  debug: (value: unknown, message?: string) => void;
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
  error: (value: unknown, message?: string) => void;
};

type OdooSyncSession = {
  accessToken: string;
  companyOdooId: number;
  expiresAt: Date | null;
};

export class MemberSyncWorker {
  private readonly workerId = `member-sync-${process.pid}-${Math.random().toString(16).slice(2)}`;
  private readonly statusKey = "sync:members:worker:status";
  private readonly lockTtlMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private retryDelayMs: number;
  private session: OdooSyncSession | null = null;
  private statusState: Record<string, unknown> = {
    domain: "members",
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
    private readonly repository: MemberRepository,
    private readonly redis: Redis,
    private readonly logger: Logger
  ) {
    this.lockTtlMs = Math.max(config.syncWorkerIntervalMs * 2, 120_000);
    this.retryDelayMs = config.syncWorkerRetryMinMs;
  }

  start(): void {
    if (!this.config.syncWorkerEnabled) {
      this.logger.info("Member sync worker disabled.");
      this.setStatus({ enabled: false, running: false, next_run_at: null });
      return;
    }
    if (!this.config.odooSyncUsername || !this.config.odooSyncPassword) {
      this.logger.warn("Member sync worker enabled but ODOO_SYNC_USERNAME/ODOO_SYNC_PASSWORD is missing.");
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
    this.logger.info("Member sync worker started.");
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
      this.logger.info(result, "Member sync worker completed.");
      this.schedule(this.config.syncWorkerIntervalMs);
    } catch (error) {
      const message = errorMessage(error);
      this.setStatus({
        running: false,
        last_failure_at: new Date().toISOString(),
        last_error: message
      });
      this.logger.error({ error: message, retry_ms: this.retryDelayMs }, "Member sync worker failed.");
      this.schedule(this.retryDelayMs);
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.config.syncWorkerRetryMaxMs);
    } finally {
      this.running = false;
    }
  }

  async syncOnce(): Promise<Record<string, unknown>> {
    const session = await this.getSession();
    const lockKey = `sync:members:company:${session.companyOdooId}`;
    const lock = await this.redis.set(lockKey, this.workerId, "PX", this.lockTtlMs, "NX");
    if (lock !== "OK") {
      this.logger.debug({ company_id: session.companyOdooId }, "Member sync skipped because lock is held.");
      return { locked: true, members_synced: 0 };
    }

    const snapshotId = `${new Date().toISOString()}-${randomUUID()}`;
    try {
      await this.repository.beginSnapshot(session.companyOdooId, snapshotId);
      let offset = 0;
      let syncedCount = 0;
      let sourceTotal = 0;
      let latestWriteDate: string | null = null;
      let firstSnapshot: Record<string, unknown> | null = null;
      let hasMore = true;

      while (hasMore) {
        const snapshot = await fetchOdooMembers(this.config, session.accessToken, {
          offset,
          limit: this.config.memberMaxLimit,
          include_inactive: false
        });
        firstSnapshot ??= snapshot;

        const page = pageInfo(snapshot.members ?? snapshot.partners);
        if (sourceTotal === 0) sourceTotal = page.total;
        if (page.total !== sourceTotal) {
          throw new Error(`Member source total changed during sync: ${sourceTotal} -> ${page.total}.`);
        }
        const written = await this.repository.writeSnapshotPage(session.companyOdooId, snapshotId, snapshot);
        latestWriteDate = maxWriteDate(latestWriteDate, written.latestWriteDate);
        syncedCount += page.items.length;
        if (page.hasMore && page.items.length === 0) {
          throw new Error("Odoo returned an empty member page while has_more=true.");
        }
        hasMore = page.hasMore && page.items.length > 0;
        offset += page.items.length;
      }

      await this.repository.replaceAuxiliaryData(session.companyOdooId, firstSnapshot ?? {});
      const state = await this.repository.commitSnapshot(
        session.companyOdooId,
        snapshotId,
        sourceTotal,
        latestWriteDate
      );
      void this.repository.pruneSnapshots(session.companyOdooId, snapshotId);

      return {
        company_id: session.companyOdooId,
        snapshot_id: snapshotId,
        members_synced: syncedCount,
        source_total: sourceTotal,
        service_total: state.member_count,
        source_scope: "res.partner:is_membership=true,active=true,company=current_or_shared",
        snapshot_replaced: true
      };
    } catch (error) {
      await this.repository.markSnapshotFailed(session.companyOdooId, snapshotId, errorMessage(error));
      throw error;
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
      this.logger.warn({ error: errorMessage(error) }, "Failed to persist member sync worker status.");
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
  const user = response.user;
  const companyOdooId = user && typeof user === "object" && !Array.isArray(user)
    ? toNumber((user as Record<string, unknown>).company_odoo_id)
    : null;
  if (!accessToken) {
    throw new Error("Odoo sync login did not return odoo_access_token.");
  }
  if (!companyOdooId) {
    throw new Error("Odoo sync login did not return user company_odoo_id.");
  }
  return {
    accessToken,
    companyOdooId,
    expiresAt: dateValue(response.expires_at)
  };
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

function maxWriteDate(current: string | null, candidate: string | null): string | null {
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate > current ? candidate : current;
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
