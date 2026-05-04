import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env";
import { query } from "../../db";
import { hashInstallId } from "../../services/security/hash";

const registerDeviceSchema = z.object({
  installId: z.string().min(8),
  platform: z.enum(["ios", "android", "web"]),
  appVersion: z.string().optional()
});

export async function registerDeviceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/devices/register", { preHandler: app.authenticate }, async (request) => {
    const body = registerDeviceSchema.parse(request.body);
    const installIdHash = hashInstallId(
      body.installId,
      env.DEVICE_INSTALL_HASH_SECRET
    );

    const result = await query(
      `insert into device_profiles
        (user_id, install_id_hash, platform, app_version, last_seen_at)
       values ($1, $2, $3, $4, now())
       on conflict (user_id, install_id_hash)
       do update set
         platform = excluded.platform,
         app_version = excluded.app_version,
         last_seen_at = now()
       returning id, platform, app_version, created_at, last_seen_at`,
      [request.auth.userId, installIdHash, body.platform, body.appVersion ?? null]
    );

    return { device: result.rows[0] };
  });

  app.get("/devices", { preHandler: app.authenticate }, async (request) => {
    const result = await query(
      `select id, platform, app_version, created_at, last_seen_at
       from device_profiles
       where user_id = $1
       order by last_seen_at desc`,
      [request.auth.userId]
    );
    return { devices: result.rows };
  });

  app.patch("/devices/:id", { preHandler: app.authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ appVersion: z.string().optional() }).parse(request.body);
    const result = await query(
      `update device_profiles
       set app_version = coalesce($3, app_version), last_seen_at = now()
       where id = $1 and user_id = $2
       returning id, platform, app_version, created_at, last_seen_at`,
      [params.id, request.auth.userId, body.appVersion ?? null]
    );

    if ((result.rowCount ?? 0) === 0) throw app.httpErrors.notFound("Device not found");
    return { device: result.rows[0] };
  });
}
