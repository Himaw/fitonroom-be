import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env";
import { query } from "../../db";
import { createPutObjectUrl } from "../../services/aws/s3";

const uploadBodySchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  deviceProfileId: z.string().uuid().optional()
});

function extensionFor(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  app.post("/uploads/photo-url", { preHandler: app.authenticate }, async (request) => {
    const body = uploadBodySchema.parse(request.body);
    const photoId = randomUUID();
    const s3Key = path.posix.join(
      "users",
      request.auth.userId,
      "body-photos",
      `${photoId}.${extensionFor(body.contentType)}`
    );

    await query(
      `insert into user_photos
        (id, user_id, device_profile_id, s3_key, image_type, content_type, status)
       values ($1, $2, $3, $4, 'body_photo', $5, 'pending_upload')`,
      [photoId, request.auth.userId, body.deviceProfileId ?? null, s3Key, body.contentType]
    );

    const uploadUrl = await createPutObjectUrl({
      bucket: env.S3_RAW_BUCKET,
      key: s3Key,
      contentType: body.contentType
    });

    return {
      uploadId: photoId,
      s3Key,
      uploadUrl,
      expiresIn: env.S3_UPLOAD_EXPIRES_SECONDS
    };
  });

  app.post("/uploads/screenshot-url", { preHandler: app.authenticate }, async (request) => {
    const body = uploadBodySchema.parse(request.body);
    const screenshotId = randomUUID();
    const s3Key = path.posix.join(
      "users",
      request.auth.userId,
      "product-screenshots",
      `${screenshotId}.${extensionFor(body.contentType)}`
    );

    const uploadUrl = await createPutObjectUrl({
      bucket: env.S3_RAW_BUCKET,
      key: s3Key,
      contentType: body.contentType
    });

    return {
      uploadId: screenshotId,
      s3Key,
      uploadUrl,
      expiresIn: env.S3_UPLOAD_EXPIRES_SECONDS
    };
  });

  app.post("/uploads/complete", { preHandler: app.authenticate }, async (request) => {
    const body = z.object({ uploadId: z.string().uuid() }).parse(request.body);
    const result = await query(
      `update user_photos
       set status = 'uploaded'
       where id = $1 and user_id = $2
       returning id, s3_key, status`,
      [body.uploadId, request.auth.userId]
    );

    if ((result.rowCount ?? 0) === 0) {
      throw app.httpErrors.notFound("Upload not found");
    }

    return { upload: result.rows[0] };
  });
}
