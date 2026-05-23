import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../../db";

export async function registerPrivacyRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/privacy/delete-account-data",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const result = await query(
        `insert into deletion_requests (user_id, status)
       values ($1, 'requested')
       returning id, status, requested_at`,
        [request.auth.userId]
      );
      reply.code(202);
      return { deletionRequest: result.rows[0] };
    }
  );

  app.post("/privacy/delete-photo/:id", { preHandler: app.authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `update user_photos
       set status = 'deleted'
       where id = $1 and user_id = $2
       returning id, status`,
      [params.id, request.auth.userId]
    );
    if ((result.rowCount ?? 0) === 0) throw app.httpErrors.notFound("Photo not found");
    return { photo: result.rows[0] };
  });

  app.post("/privacy/delete-result/:id", { preHandler: app.authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `update try_on_results
       set deleted_at = now()
       where id = $1 and user_id = $2 and deleted_at is null
       returning id, deleted_at`,
      [params.id, request.auth.userId]
    );
    if ((result.rowCount ?? 0) === 0) throw app.httpErrors.notFound("Result not found");
    return { result: result.rows[0] };
  });
}
