import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env";

export const s3Client = new S3Client({ region: env.AWS_REGION });

export async function createPutObjectUrl(input: {
  bucket: string;
  key: string;
  contentType: string;
}): Promise<string> {
  return getSignedUrl(
    s3Client,
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: input.contentType
    }),
    { expiresIn: env.S3_UPLOAD_EXPIRES_SECONDS }
  );
}

export function resultPublicUrl(s3Key: string): string | null {
  if (!env.CLOUDFRONT_BASE_URL) return null;
  return `${env.CLOUDFRONT_BASE_URL.replace(/\/$/, "")}/${s3Key}`;
}
