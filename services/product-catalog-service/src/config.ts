import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  API_PREFIX: z.string().default("/api/v1"),
  PRODUCT_SERVICE_HOST: z.string().default("0.0.0.0"),
  PRODUCT_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  REQUEST_TIMEOUT_SECONDS: z.coerce.number().positive().default(10),
  AUTH_SERVICE_URL: z.string().trim().url(),
  ODOO_BASE_URL: z.string().trim().url(),
  INTERNAL_SERVICE_KEY: z.string().min(1),
  CATALOG_MONGO_URL: z.string().min(1),
  CATALOG_MONGO_DB: z.string().min(1).default("pos_catalog_db"),
  REDIS_URL: z.string().min(1).default("redis://redis:6379"),
  CATALOG_CACHE_TTL_SECONDS: z.coerce.number().int().min(30).default(300),
  CATALOG_MAX_LIMIT: z.coerce.number().int().min(1).max(5000).default(1000),
  CATALOG_IMAGE_SYNC_ENABLED: booleanEnv(true),
  CATALOG_IMAGE_FIELD: z.string().trim().min(1).default("image_128"),
  CATALOG_IMAGE_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  CATALOG_IMAGE_EAGER_COUNT: z.coerce.number().int().min(0).max(500).default(60),
  CATALOG_IMAGE_MAX_BYTES: z.coerce.number().int().min(1024).default(262144),
  SYNC_WORKER_ENABLED: booleanEnv(false),
  SYNC_WORKER_INTERVAL_SECONDS: z.coerce.number().positive().default(60),
  SYNC_WORKER_INITIAL_DELAY_SECONDS: z.coerce.number().min(0).default(5),
  SYNC_WORKER_RETRY_MIN_SECONDS: z.coerce.number().positive().default(30),
  SYNC_WORKER_RETRY_MAX_SECONDS: z.coerce.number().positive().default(300),
  SYNC_LOOKBACK_MINUTES: z.coerce.number().int().min(0).default(5),
  ODOO_SYNC_USERNAME: optionalNonEmptyString(),
  ODOO_SYNC_PASSWORD: optionalNonEmptyString(),
  ODOO_SYNC_DEVICE_CODE: z.string().trim().min(1).default("product-catalog-sync-worker"),
  CATALOG_SYNC_POS_CONFIG_IDS: z.string().default("")
});

export type AppConfig = {
  nodeEnv: string;
  apiPrefix: string;
  host: string;
  port: number;
  requestTimeoutMs: number;
  authServiceUrl: string;
  odooBaseUrl: string;
  internalServiceKey: string;
  mongoUrl: string;
  mongoDbName: string;
  redisUrl: string;
  cacheTtlSeconds: number;
  catalogMaxLimit: number;
  catalogImageSyncEnabled: boolean;
  catalogImageField: string;
  catalogImageSyncConcurrency: number;
  catalogImageEagerCount: number;
  catalogImageMaxBytes: number;
  syncWorkerEnabled: boolean;
  syncWorkerIntervalMs: number;
  syncWorkerInitialDelayMs: number;
  syncWorkerRetryMinMs: number;
  syncWorkerRetryMaxMs: number;
  syncLookbackMinutes: number;
  odooSyncUsername?: string;
  odooSyncPassword?: string;
  odooSyncDeviceCode: string;
  catalogSyncPosConfigIds: number[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV,
    apiPrefix: normalizePrefix(parsed.API_PREFIX),
    host: parsed.PRODUCT_SERVICE_HOST,
    port: parsed.PRODUCT_SERVICE_PORT,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_SECONDS * 1000,
    authServiceUrl: trimTrailingSlash(parsed.AUTH_SERVICE_URL),
    odooBaseUrl: trimTrailingSlash(parsed.ODOO_BASE_URL),
    internalServiceKey: parsed.INTERNAL_SERVICE_KEY,
    mongoUrl: parsed.CATALOG_MONGO_URL,
    mongoDbName: parsed.CATALOG_MONGO_DB,
    redisUrl: parsed.REDIS_URL,
    cacheTtlSeconds: parsed.CATALOG_CACHE_TTL_SECONDS,
    catalogMaxLimit: parsed.CATALOG_MAX_LIMIT,
    catalogImageSyncEnabled: parsed.CATALOG_IMAGE_SYNC_ENABLED,
    catalogImageField: parsed.CATALOG_IMAGE_FIELD,
    catalogImageSyncConcurrency: parsed.CATALOG_IMAGE_SYNC_CONCURRENCY,
    catalogImageEagerCount: parsed.CATALOG_IMAGE_EAGER_COUNT,
    catalogImageMaxBytes: parsed.CATALOG_IMAGE_MAX_BYTES,
    syncWorkerEnabled: parsed.SYNC_WORKER_ENABLED,
    syncWorkerIntervalMs: parsed.SYNC_WORKER_INTERVAL_SECONDS * 1000,
    syncWorkerInitialDelayMs: parsed.SYNC_WORKER_INITIAL_DELAY_SECONDS * 1000,
    syncWorkerRetryMinMs: parsed.SYNC_WORKER_RETRY_MIN_SECONDS * 1000,
    syncWorkerRetryMaxMs: parsed.SYNC_WORKER_RETRY_MAX_SECONDS * 1000,
    syncLookbackMinutes: parsed.SYNC_LOOKBACK_MINUTES,
    odooSyncUsername: parsed.ODOO_SYNC_USERNAME,
    odooSyncPassword: parsed.ODOO_SYNC_PASSWORD,
    odooSyncDeviceCode: parsed.ODOO_SYNC_DEVICE_CODE,
    catalogSyncPosConfigIds: parseNumberList(parsed.CATALOG_SYNC_POS_CONFIG_IDS)
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

function parseNumberList(value: string): number[] {
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
}
