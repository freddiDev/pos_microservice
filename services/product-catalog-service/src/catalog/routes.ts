import { FastifyInstance, FastifyRequest } from "fastify";

import { resolveAuthContext } from "../auth-context.js";
import { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { ProductCatalogRepository } from "./repository.js";
import { ProductCatalogService } from "./service.js";
import { barcodeParamsSchema, catalogRequestSchema, productParamsSchema } from "./schemas.js";
import type { Redis } from "ioredis";

export function registerCatalogRoutes(
  app: FastifyInstance,
  config: AppConfig,
  repository: ProductCatalogRepository,
  redis: Redis
): void {
  const service = new ProductCatalogService(config, repository, redis);
  const prefix = `${config.apiPrefix}/catalog`;

  app.get(`${prefix}/status`, async (request) => {
    const query = request.query as Record<string, unknown>;
    const posConfig = query.pos_config ? Number(query.pos_config) : undefined;
    return ok(await service.status(posConfig));
  });

  app.get(`${prefix}/bootstrap`, async (request) => {
    const context = await auth(config, request);
    const parsed = catalogRequestSchema.parse(request.query);
    return ok(await service.bootstrap(context, parsed));
  });

  app.post(`${prefix}/bootstrap`, async (request) => {
    const context = await auth(config, request);
    const parsed = catalogRequestSchema.parse(request.body || {});
    return ok(await service.bootstrap(context, parsed));
  });

  app.get(`${prefix}/sync/status`, async (request) => {
    const query = request.query as Record<string, unknown>;
    const posConfig = query.pos_config ? Number(query.pos_config) : undefined;
    return ok(await service.status(posConfig));
  });

  app.get(`${prefix}/sync/worker/status`, async () => {
    return ok(await app.catalogSyncWorker.status());
  });

  app.post(`${prefix}/sync/ensure`, async (request) => {
    assertInternalRequest(config, request);
    return ok(await app.catalogSyncWorker.syncOnce());
  });

  app.get(`${prefix}/products`, async (request) => {
    const context = await auth(config, request);
    const parsed = catalogRequestSchema.parse(request.query);
    return ok(await service.products(context, parsed));
  });

  app.post(`${prefix}/products`, async (request) => {
    const context = await auth(config, request);
    const parsed = catalogRequestSchema.parse(request.body || {});
    return ok(await service.products(context, parsed));
  });

  app.get(`${prefix}/products/barcode/:barcode`, async (request) => {
    const context = await auth(config, request);
    const params = barcodeParamsSchema.parse(request.params);
    const parsed = catalogRequestSchema.parse(request.query);
    return ok(await service.barcode(context, parsed, params.barcode));
  });

  app.get(`${prefix}/products/:productId`, async (request) => {
    const context = await auth(config, request);
    const params = productParamsSchema.parse(request.params);
    const parsed = catalogRequestSchema.parse(request.query);
    return ok(await service.product(context, parsed, params.productId));
  });
}

async function auth(config: AppConfig, request: FastifyRequest) {
  return resolveAuthContext(config, request.headers.authorization);
}

function ok(data: Record<string, unknown>) {
  return {
    success: true,
    code: 200,
    message: "OK",
    data
  };
}

function assertInternalRequest(config: AppConfig, request: FastifyRequest): void {
  const key = request.headers["x-internal-service-key"];
  if (key !== config.internalServiceKey) {
    throw new HttpError(403, "FORBIDDEN", "Invalid internal service key.");
  }
}
