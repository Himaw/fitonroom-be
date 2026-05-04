import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../../db";

export async function registerProductInputRoutes(app: FastifyInstance): Promise<void> {
  app.post("/product-inputs/url", { preHandler: app.authenticate }, async (request) => {
    const body = z
      .object({
        sourceUrl: z.string().url(),
        deviceProfileId: z.string().uuid().optional()
      })
      .parse(request.body);

    const result = await query(
      `insert into product_inputs
        (user_id, device_profile_id, input_type, source_url, extraction_status)
       values ($1, $2, 'url', $3, 'pending')
       returning id, input_type, source_url, extraction_status, created_at`,
      [request.auth.userId, body.deviceProfileId ?? null, body.sourceUrl]
    );

    return { productInput: result.rows[0] };
  });

  app.post("/product-inputs/screenshot", { preHandler: app.authenticate }, async (request) => {
    const body = z
      .object({
        screenshotS3Key: z.string().min(1),
        deviceProfileId: z.string().uuid().optional()
      })
      .parse(request.body);

    const result = await query(
      `insert into product_inputs
        (user_id, device_profile_id, input_type, screenshot_s3_key, extraction_status)
       values ($1, $2, 'screenshot', $3, 'pending')
       returning id, input_type, screenshot_s3_key, extraction_status, created_at`,
      [request.auth.userId, body.deviceProfileId ?? null, body.screenshotS3Key]
    );

    return { productInput: result.rows[0] };
  });

  app.get("/product-inputs/:id", { preHandler: app.authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `select id, input_type, source_url, screenshot_s3_key, extraction_status, created_at
       from product_inputs
       where id = $1 and user_id = $2`,
      [params.id, request.auth.userId]
    );

    if ((result.rowCount ?? 0) === 0) throw app.httpErrors.notFound("Product input not found");
    return { productInput: result.rows[0] };
  });
}
