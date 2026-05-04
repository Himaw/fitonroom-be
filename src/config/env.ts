import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1),
  DB_SSL: z.coerce.boolean().default(false),
  SUPABASE_JWT_SECRET: z.string().min(1),
  DEVICE_INSTALL_HASH_SECRET: z.string().min(16),

  AWS_REGION: z.string().default("us-east-1"),
  S3_RAW_BUCKET: z.string().min(1),
  S3_RESULTS_BUCKET: z.string().min(1),
  S3_UPLOAD_EXPIRES_SECONDS: z.coerce.number().int().positive().default(900),
  SQS_TRY_ON_QUEUE_URL: z.string().min(1),

  CLOUDFRONT_BASE_URL: z.string().optional().default(""),
  STRIPE_SECRET_KEY: z.string().optional().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(""),
  GENAI_TRY_ON_API_URL: z.string().optional().default(""),
  GENAI_TRY_ON_API_KEY: z.string().optional().default(""),
  EXPO_PUSH_ACCESS_TOKEN: z.string().optional().default("")
});

export type AppEnv = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
