import { Redis } from "ioredis";

import { AppConfig } from "./config.js";

export function connectRedis(config: AppConfig): Redis {
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true
  });
}
