import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";

import { AppConfig } from "./config.js";
import { connectMongo, MongoResources } from "./db.js";
import { HttpError } from "./errors.js";
import { connectRedis } from "./redis.js";
import { ProductCatalogRepository } from "./catalog/repository.js";
import { registerCatalogRoutes } from "./catalog/routes.js";
import { CatalogSyncWorker } from "./sync-worker.js";

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "production" ? "info" : "debug"
    }
  });

  await app.register(cors, { origin: true });

  const mongo = await connectMongo(config);
  const redis = connectRedis(config);
  await redis.connect();
  const repository = new ProductCatalogRepository(mongo.collections, config.apiPrefix);
  const syncWorker = new CatalogSyncWorker(config, repository, redis, app.log);

  app.decorate("mongo", mongo);
  app.decorate("catalogRedis", redis);
  app.decorate("catalogSyncWorker", syncWorker);

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await mongo.db.command({ ping: 1 });
    await redis.ping();
    return { status: "ready" };
  });

  registerCatalogRoutes(app, config, repository, redis);
  syncWorker.start();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        success: false,
        code: "VALIDATION_ERROR",
        message: "Invalid request payload.",
        data: { issues: error.issues }
      });
    }
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        success: false,
        code: error.code,
        message: error.message,
        data: error.details ?? {}
      });
    }
    app.log.error(error);
    return reply.status(500).send({
      success: false,
      code: "INTERNAL_ERROR",
      message: "Product catalog service failed.",
      data: {}
    });
  });

  app.addHook("onClose", async () => {
    syncWorker.stop();
    await redis.quit();
    await mongo.client.close();
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    mongo: MongoResources;
    catalogRedis: Redis;
    catalogSyncWorker: CatalogSyncWorker;
  }
}
