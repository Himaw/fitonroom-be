import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../../db";
import { resultPublicUrl } from "../../services/aws/s3";

function withUrl<T extends { result_s3_key?: string; thumbnail_s3_key?: string | null }>(
  row: T
) {
  return {
    ...row,
    resultUrl: row.result_s3_key ? resultPublicUrl(row.result_s3_key) : null,
    thumbnailUrl: row.thumbnail_s3_key ? resultPublicUrl(row.thumbnail_s3_key) : null
  };
}

export async function registerResultRoutes(app: FastifyInstance): Promise<void> {
  app.get("/results", { preHandler: app.authenticate }, async (request) => {
    const result = await query(
      `select id, job_id, result_s3_key, thumbnail_s3_key, provider, created_at
       from try_on_results
       where user_id = $1 and deleted_at is null
       order by created_at desc
       limit 100`,
      [request.auth.userId]
    );
    return { results: result.rows.map(withUrl) };
  });

  app.get("/results/:id", { preHandler: app.authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `select id, job_id, result_s3_key, thumbnail_s3_key, provider, created_at
       from try_on_results
       where id = $1 and user_id = $2 and deleted_at is null`,
      [params.id, request.auth.userId]
    );
    if ((result.rowCount ?? 0) === 0) throw app.httpErrors.notFound("Result not found");
    return { result: withUrl(result.rows[0]) };
  });

  app.delete("/results/:id", { preHandler: app.authenticate }, async (request) => {
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
