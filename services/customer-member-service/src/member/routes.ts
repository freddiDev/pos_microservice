import { FastifyInstance, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

import { resolveAuthContext } from "../auth-context.js";
import { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { MemberRepository } from "./repository.js";
import { CustomerMemberService } from "./service.js";
import { memberRequestSchema, partnerParamsSchema } from "./schemas.js";

export function registerMemberRoutes(
  app: FastifyInstance,
  config: AppConfig,
  repository: MemberRepository,
  redis: Redis
): void {
  const service = new CustomerMemberService(config, repository, redis);
  const prefix = `${config.apiPrefix}/members`;

  app.get(`${prefix}/status`, async (request) => {
    const query = request.query as Record<string, unknown>;
    const companyId = query.company_id ? Number(query.company_id) : undefined;
    return ok(await service.status(companyId));
  });

  app.get(`${prefix}/bootstrap`, async (request) => {
    const context = await auth(config, request);
    const parsed = memberRequestSchema.parse(request.query);
    return ok(await service.bootstrap(context, parsed));
  });

  app.post(`${prefix}/bootstrap`, async (request) => {
    const context = await auth(config, request);
    const parsed = memberRequestSchema.parse(request.body || {});
    return ok(await service.bootstrap(context, parsed));
  });

  app.get(`${prefix}/sync/status`, async (request) => {
    const query = request.query as Record<string, unknown>;
    const companyId = query.company_id ? Number(query.company_id) : undefined;
    return ok(await service.status(companyId));
  });

  app.get(`${prefix}/sync/worker/status`, async () => {
    return ok(await app.memberSyncWorker.status());
  });

  app.post(`${prefix}/sync/ensure`, async (request) => {
    assertInternalRequest(config, request);
    return ok(await app.memberSyncWorker.syncOnce());
  });

  app.get(prefix, async (request) => {
    const context = await auth(config, request);
    const parsed = memberRequestSchema.parse(request.query);
    return ok(await service.members(context, parsed));
  });

  app.post(prefix, async (request) => {
    const context = await auth(config, request);
    const parsed = memberRequestSchema.parse(request.body || {});
    return ok(await service.members(context, parsed));
  });

  app.get(`${prefix}/search`, async (request) => {
    const context = await auth(config, request);
    const parsed = memberRequestSchema.parse(request.query);
    return ok(await service.search(context, parsed));
  });

  app.get(`${prefix}/tiers`, async (request) => {
    const context = await auth(config, request);
    const parsed = memberRequestSchema.parse(request.query);
    return ok(await service.tiers(context, parsed));
  });

  app.get(`${prefix}/:partnerId/loyalty`, async (request) => {
    const context = await auth(config, request);
    const params = partnerParamsSchema.parse(request.params);
    const parsed = memberRequestSchema.parse(request.query);
    return ok(await service.loyalty(context, params.partnerId, parsed));
  });

  app.get(`${prefix}/:partnerId`, async (request) => {
    const context = await auth(config, request);
    const params = partnerParamsSchema.parse(request.params);
    const parsed = memberRequestSchema.parse(request.query);
    return ok(await service.member(context, params.partnerId, parsed));
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
