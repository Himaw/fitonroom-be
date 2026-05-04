import { describe, expect, it, vi } from "vitest";

function stubRequiredEnv(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://fitonroom:fitonroom@localhost:5432/fitonroom_test");
  vi.stubEnv("SUPABASE_JWT_SECRET", "test-supabase-jwt-secret");
  vi.stubEnv("DEVICE_INSTALL_HASH_SECRET", "test-device-install-hash-secret");
  vi.stubEnv("S3_RAW_BUCKET", "fitonroom-raw-test");
  vi.stubEnv("S3_RESULTS_BUCKET", "fitonroom-results-test");
  vi.stubEnv("SQS_TRY_ON_QUEUE_URL", "https://sqs.us-east-1.amazonaws.com/000000000000/fitonroom-test");
}

describe("health", () => {
  it("returns service health", async () => {
    stubRequiredEnv();
    const { buildApp } = await import("../src/app");
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      service: "fitonroom-be"
    });
  });
});
