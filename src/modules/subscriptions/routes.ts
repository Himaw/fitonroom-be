import type { FastifyInstance } from "fastify";
import { query } from "../../db";

export async function registerSubscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/subscription-plans", async () => {
    const result = await query(
      `select id, name, monthly_fitons, price_amount, currency, active
       from subscription_plans
       where active = true
       order by monthly_fitons asc`
    );
    return { plans: result.rows };
  });

  app.get("/subscriptions/me", { preHandler: app.authenticate }, async (request) => {
    const result = await query(
      `select us.id, us.provider, us.provider_subscription_id, us.status,
              us.current_period_start, us.current_period_end,
              sp.name as plan_name, sp.monthly_fitons
       from user_subscriptions us
       left join subscription_plans sp on sp.id = us.plan_id
       where us.user_id = $1
       order by us.created_at desc
       limit 1`,
      [request.auth.userId]
    );
    return { subscription: result.rows[0] ?? null };
  });

  app.post("/subscriptions/checkout", { preHandler: app.authenticate }, async () => {
    throw app.httpErrors.notImplemented(
      "Checkout creation is not wired yet. Add Stripe or native IAP integration here."
    );
  });

  app.post("/subscriptions/customer-portal", { preHandler: app.authenticate }, async () => {
    throw app.httpErrors.notImplemented(
      "Customer portal creation is not wired yet. Add Stripe integration here."
    );
  });
}
