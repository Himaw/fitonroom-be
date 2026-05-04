import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../../db";
import { getAppUser } from "./userRepo";

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.patch("/users/me", { preHandler: app.authenticate }, async (request) => {
    const body = z
      .object({
        displayName: z.string().min(1).max(120).optional(),
        avatarUrl: z.string().url().optional()
      })
      .parse(request.body);

    const result = await query(
      `update app_users
       set display_name = coalesce($2, display_name),
           avatar_url = coalesce($3, avatar_url),
           last_seen_at = now()
       where id = $1
       returning id, supabase_user_id, email, display_name, avatar_url`,
      [request.auth.userId, body.displayName ?? null, body.avatarUrl ?? null]
    );

    return { user: result.rows[0] };
  });

  app.delete("/users/me", { preHandler: app.authenticate }, async (request, reply) => {
    await query(
      `insert into deletion_requests (user_id, status)
       values ($1, 'requested')`,
      [request.auth.userId]
    );

    const user = await getAppUser(request.auth.userId);
    reply.code(202);
    return {
      deletionRequest: {
        status: "requested",
        user
      }
    };
  });
}
