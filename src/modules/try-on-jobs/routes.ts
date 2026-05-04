import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, withTransaction } from "../../db";
import { enqueueTryOnJob } from "../../services/aws/sqs";
import { debitFitonsForJob } from "../fitons/fitonService";

const createJobSchema = z.object({
  userPhotoId: z.string().uuid(),
  productInputId: z.string().uuid(),
  deviceProfileId: z.string().uuid().optional()
});

export async function registerTryOnJobRoutes(app: FastifyInstance): Promise<void> {
  app.post("/try-on-jobs", { preHandler: app.authenticate }, async (request, reply) => {
    const body = createJobSchema.parse(request.body);
    const jobId = randomUUID();
    const fitonCost = 1;

    try {
      const job = await withTransaction(async (client) => {
        const photo = await client.query(
          `select id from user_photos
           where id = $1 and user_id = $2 and status = 'uploaded'`,
          [body.userPhotoId, request.auth.userId]
        );
        if ((photo.rowCount ?? 0) === 0) throw new Error("PHOTO_NOT_FOUND");

        const productInput = await client.query(
          `select id from product_inputs
           where id = $1 and user_id = $2`,
          [body.productInputId, request.auth.userId]
        );
        if ((productInput.rowCount ?? 0) === 0) throw new Error("PRODUCT_INPUT_NOT_FOUND");

        await debitFitonsForJob({
          userId: request.auth.userId,
          amount: fitonCost,
          jobId,
          client
        });

        const result = await client.query(
          `insert into try_on_jobs
            (id, user_id, device_profile_id, user_photo_id, product_input_id, status, fiton_cost)
           values ($1, $2, $3, $4, $5, 'pending', $6)
           returning id, status, fiton_cost, created_at`,
          [
            jobId,
            request.auth.userId,
            body.deviceProfileId ?? null,
            body.userPhotoId,
            body.productInputId,
            fitonCost
          ]
        );

        return result.rows[0];
      });

      await enqueueTryOnJob({
        jobId,
        userId: request.auth.userId,
        userPhotoId: body.userPhotoId,
        productInputId: body.productInputId
      });

      reply.code(201);
      return { job };
    } catch (error) {
      if (error instanceof Error && error.message === "INSUFFICIENT_FITONS") {
        throw app.httpErrors.createError(402, "Not enough Fitons");
      }
      if (error instanceof Error && error.message === "PHOTO_NOT_FOUND") {
        throw app.httpErrors.notFound("Uploaded photo not found");
      }
      if (error instanceof Error && error.message === "PRODUCT_INPUT_NOT_FOUND") {
        throw app.httpErrors.notFound("Product input not found");
      }
      throw error;
    }
  });

  app.get("/try-on-jobs", { preHandler: app.authenticate }, async (request) => {
    const result = await query(
      `select id, user_photo_id, product_input_id, status, fiton_cost,
              failure_reason, created_at, updated_at
       from try_on_jobs
       where user_id = $1
       order by created_at desc
       limit 100`,
      [request.auth.userId]
    );
    return { jobs: result.rows };
  });

  app.get("/try-on-jobs/:id", { preHandler: app.authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `select id, user_photo_id, product_input_id, status, fiton_cost,
              failure_reason, created_at, updated_at
       from try_on_jobs
       where id = $1 and user_id = $2`,
      [params.id, request.auth.userId]
    );
    if ((result.rowCount ?? 0) === 0) throw app.httpErrors.notFound("Job not found");
    return { job: result.rows[0] };
  });

  app.post("/try-on-jobs/:id/cancel", { preHandler: app.authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `update try_on_jobs
       set status = 'cancelled', updated_at = now()
       where id = $1 and user_id = $2 and status = 'pending'
       returning id, status, updated_at`,
      [params.id, request.auth.userId]
    );
    if ((result.rowCount ?? 0) === 0) {
      throw app.httpErrors.conflict("Only pending jobs can be cancelled");
    }
    return { job: result.rows[0] };
  });
}
