import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../../db";

const genericWebhookSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1)
  })
  .passthrough();

async function recordPaymentEvent(provider: string, payload: unknown) {
  const parsed = genericWebhookSchema.parse(payload);
  const result = await query(
    `insert into payment_events (provider, provider_event_id, event_type)
     values ($1, $2, $3)
     on conflict (provider, provider_event_id) do nothing
     returning id, provider, provider_event_id, event_type, processed_at`,
    [provider, parsed.id, parsed.type]
  );

  return {
    duplicate: (result.rowCount ?? 0) === 0,
    event: result.rows[0] ?? null
  };
}

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/stripe", async (request) => {
    // TODO: verify Stripe signature with STRIPE_WEBHOOK_SECRET before trusting payload.
    return recordPaymentEvent("stripe", request.body);
  });

  app.post("/webhooks/app-store", async (request) => {
    // TODO: verify Apple App Store Server Notification signature.
    return recordPaymentEvent("app_store", request.body);
  });

  app.post("/webhooks/google-play", async (request) => {
    // TODO: verify Google Play purchase notification.
    return recordPaymentEvent("google_play", request.body);
  });
}
