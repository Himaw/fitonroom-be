import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../../db";

export async function registerPushRoutes(app: FastifyInstance): Promise<void> {
  app.post("/push-tokens", { preHandler: app.authenticate }, async (request) => {
    const body = z
      .object({
        token: z.string().min(8),
        platform: z.enum(["ios", "android", "web"]),
        deviceProfileId: z.string().uuid().optional()
      })
      .parse(request.body);

    const result = await query(
      `insert into push_tokens
        (user_id, device_profile_id, platform, token, enabled, updated_at)
       values ($1, $2, $3, $4, true, now())
       on conflict (user_id, token)
       do update set
         device_profile_id = excluded.device_profile_id,
         platform = excluded.platform,
         enabled = true,
         updated_at = now()
       returning id, platform, token, enabled, updated_at`,
      [request.auth.userId, body.deviceProfileId ?? null, body.platform, body.token]
    );

    return { pushToken: result.rows[0] };
  });

  app.delete("/push-tokens/:id", { preHandler: app.authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `update push_tokens
       set enabled = false, updated_at = now()
       where id = $1 and user_id = $2
       returning id, enabled, updated_at`,
      [params.id, request.auth.userId]
    );

    if ((result.rowCount ?? 0) === 0) throw app.httpErrors.notFound("Push token not found");
    return { pushToken: result.rows[0] };
  });
}
