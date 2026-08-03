import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  API_PREFIX: z.string().default("/api/v1"),
  MEMBER_SERVICE_HOST: z.string().default("0.0.0.0"),
  MEMBER_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  REQUEST_TIMEOUT_SECONDS: z.coerce.number().positive().default(10),
  ODOO_REQUEST_TIMEOUT_SECONDS: z.coerce.number().positive().default(120),
  AUTH_SERVICE_URL: z.string().trim().url(),
  ODOO_BASE_URL: z.string().trim().url(),
  INTERNAL_SERVICE_KEY: z.string().min(1),
  MEMBER_MONGO_URL: z.string().min(1),
  MEMBER_MONGO_DB: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://redis:6379"),
  MEMBER_CACHE_TTL_SECONDS: z.coerce.number().int().min(30).default(300),
  MEMBER_MAX_LIMIT: z.coerce.number().int().min(1).max(5000).default(1000),
  SYNC_WORKER_ENABLED: booleanEnv(false),
  SYNC_WORKER_INTERVAL_SECONDS: z.coerce.number().positive().default(60),
  SYNC_WORKER_INITIAL_DELAY_SECONDS: z.coerce.number().min(0).default(5),
  SYNC_WORKER_RETRY_MIN_SECONDS: z.coerce.number().positive().default(30),
  SYNC_WORKER_RETRY_MAX_SECONDS: z.coerce.number().positive().default(300),
  SYNC_LOOKBACK_MINUTES: z.coerce.number().int().min(0).default(5),
  ODOO_SYNC_USERNAME: optionalNonEmptyString(),
  ODOO_SYNC_PASSWORD: optionalNonEmptyString(),
  ODOO_SYNC_DEVICE_CODE: z.string().trim().min(1).default("customer-member-sync-worker")
});

export type AppConfig = {
  nodeEnv: string;
  apiPrefix: string;
  host: string;
  port: number;
  requestTimeoutMs: number;
  odooRequestTimeoutMs: number;
  authServiceUrl: string;
  odooBaseUrl: string;
  internalServiceKey: string;
  mongoUrl: string;
  mongoDbName: string;
  redisUrl: string;
  cacheTtlSeconds: number;
  memberMaxLimit: number;
  syncWorkerEnabled: boolean;
  syncWorkerIntervalMs: number;
  syncWorkerInitialDelayMs: number;
  syncWorkerRetryMinMs: number;
  syncWorkerRetryMaxMs: number;
  syncLookbackMinutes: number;
  odooSyncUsername?: string;
  odooSyncPassword?: string;
  odooSyncDeviceCode: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  return {
    nodeEnv: parsed.NODE_ENV,
    apiPrefix: normalizePrefix(parsed.API_PREFIX),
    host: parsed.MEMBER_SERVICE_HOST,
    port: parsed.MEMBER_SERVICE_PORT,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_SECONDS * 1000,
    odooRequestTimeoutMs: parsed.ODOO_REQUEST_TIMEOUT_SECONDS * 1000,
    authServiceUrl: trimTrailingSlash(parsed.AUTH_SERVICE_URL),
    odooBaseUrl: trimTrailingSlash(parsed.ODOO_BASE_URL),
    internalServiceKey: parsed.INTERNAL_SERVICE_KEY,
    mongoUrl: parsed.MEMBER_MONGO_URL,
    mongoDbName: parsed.MEMBER_MONGO_DB,
    redisUrl: parsed.REDIS_URL,
    cacheTtlSeconds: parsed.MEMBER_CACHE_TTL_SECONDS,
    memberMaxLimit: parsed.MEMBER_MAX_LIMIT,
    syncWorkerEnabled: parsed.SYNC_WORKER_ENABLED,
    syncWorkerIntervalMs: parsed.SYNC_WORKER_INTERVAL_SECONDS * 1000,
    syncWorkerInitialDelayMs: parsed.SYNC_WORKER_INITIAL_DELAY_SECONDS * 1000,
    syncWorkerRetryMinMs: parsed.SYNC_WORKER_RETRY_MIN_SECONDS * 1000,
    syncWorkerRetryMaxMs: parsed.SYNC_WORKER_RETRY_MAX_SECONDS * 1000,
    syncLookbackMinutes: parsed.SYNC_LOOKBACK_MINUTES,
    odooSyncUsername: parsed.ODOO_SYNC_USERNAME,
    odooSyncPassword: parsed.ODOO_SYNC_PASSWORD,
    odooSyncDeviceCode: parsed.ODOO_SYNC_DEVICE_CODE
  };
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizePrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function optionalNonEmptyString() {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }, z.string().optional());
}

function booleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
    return value;
  }, z.boolean().default(defaultValue));
}
