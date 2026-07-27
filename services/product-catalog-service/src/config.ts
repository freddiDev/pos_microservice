import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  API_PREFIX: z.string().default("/api/v1"),
  PRODUCT_SERVICE_HOST: z.string().default("0.0.0.0"),
  PRODUCT_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  REQUEST_TIMEOUT_SECONDS: z.coerce.number().positive().default(10),
  AUTH_SERVICE_URL: z.string().url(),
  ODOO_BASE_URL: z.string().url(),
  INTERNAL_SERVICE_KEY: z.string().min(1),
  CATALOG_MONGO_URL: z.string().min(1),
  CATALOG_MONGO_DB: z.string().min(1).default("pos_catalog_db"),
  REDIS_URL: z.string().min(1).default("redis://redis:6379"),
  CATALOG_CACHE_TTL_SECONDS: z.coerce.number().int().min(30).default(300),
  CATALOG_MAX_LIMIT: z.coerce.number().int().min(1).max(5000).default(1000)
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
    catalogMaxLimit: parsed.CATALOG_MAX_LIMIT
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}
