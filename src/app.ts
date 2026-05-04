import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { env } from "./config/env";
import authPlugin from "./plugins/auth";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerDeviceRoutes } from "./modules/devices/routes";
import { registerFitonRoutes } from "./modules/fitons/routes";
import { registerHealthRoutes } from "./modules/health/routes";
import { registerProductInputRoutes } from "./modules/product-inputs/routes";
import { registerPushRoutes } from "./modules/push/routes";
import { registerPrivacyRoutes } from "./modules/privacy/routes";
import { registerResultRoutes } from "./modules/results/routes";
import { registerSubscriptionRoutes } from "./modules/subscriptions/routes";
import { registerTryOnJobRoutes } from "./modules/try-on-jobs/routes";
import { registerUploadRoutes } from "./modules/uploads/routes";
import { registerUserRoutes } from "./modules/users/routes";
import { registerWebhookRoutes } from "./modules/webhooks/routes";

export async function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: env.LOG_LEVEL }
  });

  await app.register(sensible);
  await app.register(helmet);
  await app.register(cors, {
    origin: true,
    credentials: true
  });
  await app.register(authPlugin);

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerUserRoutes(app);
  await registerDeviceRoutes(app);
  await registerFitonRoutes(app);
  await registerUploadRoutes(app);
  await registerProductInputRoutes(app);
  await registerTryOnJobRoutes(app);
  await registerResultRoutes(app);
  await registerSubscriptionRoutes(app);
  await registerPushRoutes(app);
  await registerPrivacyRoutes(app);
  await registerWebhookRoutes(app);

  return app;
}
