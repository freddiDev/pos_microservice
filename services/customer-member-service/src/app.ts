import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";

import { AppConfig } from "./config.js";
import { connectMongo, MongoResources } from "./db.js";
import { HttpError } from "./errors.js";
import { connectRedis } from "./redis.js";
import { MemberRepository } from "./member/repository.js";
import { registerMemberRoutes } from "./member/routes.js";

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
  const repository = new MemberRepository(mongo.collections);

  app.decorate("mongo", mongo);
  app.decorate("memberRedis", redis);

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await mongo.db.command({ ping: 1 });
    await redis.ping();
    return { status: "ready" };
  });

  registerMemberRoutes(app, config, repository, redis);

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
      message: "Customer member service failed.",
      data: {}
    });
  });

  app.addHook("onClose", async () => {
    await redis.quit();
    await mongo.client.close();
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    mongo: MongoResources;
    memberRedis: Redis;
  }
}
