# Fiton Room Backend

Initial TypeScript backend for the Fiton Room MVP.

The backend follows the product/system spec:

- Supabase Auth with Google and Apple login.
- Supabase Postgres as the MVP relational database.
- Account-based history, with device registration linked to authenticated users.
- 5 initial free Fitons per new user account.
- S3 pre-signed upload URLs for body photos and clothing screenshots.
- SQS-backed async try-on job creation.
- Lambda-friendly API, worker, webhook, and cleanup entry points.
- Stripe/native-IAP-ready subscription and Fiton ledger foundations.

## Tech Stack

- Runtime: Node.js + TypeScript
- API framework: Fastify
- Auth verification: Supabase JWT verification with `jose`
- Database: Supabase Postgres via `pg`
- Object storage: Amazon S3 pre-signed uploads
- Queue: Amazon SQS
- Payments: Stripe webhook foundation
- Tests: Vitest

## Project Structure

```text
src/
  app.ts                         Fastify app factory
  server.ts                      local HTTP server entry
  config/env.ts                  typed environment configuration
  db/
    index.ts                     pg pool and transaction helpers
    migrate.ts                   simple local migration runner
    migrations/001_initial_schema.sql
  plugins/auth.ts                Supabase JWT auth middleware
  modules/
    auth/                        profile/session routes
    devices/                     device registration routes
    fitons/                      balance and ledger routes/service
    uploads/                     S3 pre-signed upload routes
    product-inputs/              URL/screenshot input routes
    try-on-jobs/                 Fiton-gated job creation and status
    results/                     result gallery and deletion
    subscriptions/               plans and checkout placeholders
    push/                        push token registration
    privacy/                     account/data deletion requests
    webhooks/                    Stripe/app-store/google-play webhook shell
  services/
    aws/                         S3 and SQS clients
    security/                    hashing and auth helpers
  lambda/
    api.ts                       API Gateway Lambda adapter
    worker.ts                    SQS worker Lambda handler
    cleanup.ts                   scheduled cleanup Lambda handler
```

## Prerequisites

1. Node.js 20 or newer.
2. A Supabase project with Auth enabled.
3. A Postgres connection string. Supabase's pooled or direct connection string both work for local development.
4. AWS credentials with access to:
   - S3 raw upload bucket
   - S3 result bucket
   - SQS try-on queue
5. Optional for payment testing: Stripe CLI and a Stripe test secret key.

## Setup

Install dependencies:

```bash
npm install
```

Create your local environment file:

```bash
cp .env.example .env
```

Fill in the required values:

```bash
DATABASE_URL=...
SUPABASE_URL=...
SUPABASE_JWT_SECRET=...
DEVICE_INSTALL_HASH_SECRET=...
AWS_REGION=...
S3_RAW_BUCKET=...
S3_RESULTS_BUCKET=...
SQS_TRY_ON_QUEUE_URL=...
```

Important auth note:

- The mobile app authenticates with Supabase.
- The app sends the Supabase access token as `Authorization: Bearer <token>`.
- The backend verifies that token using `SUPABASE_JWT_SECRET`.
- The backend derives the app user from the verified JWT `sub`; clients never send or choose `user_id`.

## Database Setup

Run migrations against your configured `DATABASE_URL`:

```bash
npm run db:migrate
```

The initial migration creates:

- `app_users`
- `device_profiles`
- `user_photos`
- `product_inputs`
- `try_on_jobs`
- `try_on_results`
- `fiton_accounts`
- `fiton_ledger_entries`
- `subscription_plans`
- `user_subscriptions`
- `payment_customers`
- `payment_events`
- `push_tokens`
- `deletion_requests`

It also seeds the starter subscription plans from the spec:

- Starter: 30 Fitons/month
- Plus: 100 Fitons/month
- Pro: 250 Fitons/month

## Run Locally

Start the API in watch mode:

```bash
npm run dev
```

The API starts on:

```text
http://localhost:4000
```

Health check:

```bash
curl http://localhost:4000/health
```

Expected response:

```json
{
  "ok": true,
  "service": "fitonroom-be"
}
```

## Authenticated API Testing

Get a Supabase user access token from the mobile app, Supabase dashboard, or Supabase Auth test flow, then call:

```bash
curl http://localhost:4000/auth/me \
  -H "Authorization: Bearer <SUPABASE_ACCESS_TOKEN>"
```

The first authenticated call creates or updates the `app_users` row, creates a Fiton account if needed, and grants the initial 5 free Fitons once.

## Useful Endpoint Examples

Get the Settings/Profile summary:

```bash
curl http://localhost:4000/me/profile-summary \
  -H "Authorization: Bearer <SUPABASE_ACCESS_TOKEN>"
```

Expected response:

```json
{
  "displayName": "Himasara",
  "email": "user@example.com",
  "avatarUrl": null,
  "tokensRemaining": 5,
  "completedFitons": 0
}
```

The backend derives the user from the verified Supabase JWT and reads the summary from `app_users`, `fiton_accounts`, and `try_on_results`. The client should not send a user id for this endpoint.

Register a device:

```bash
curl -X POST http://localhost:4000/devices/register \
  -H "Authorization: Bearer <SUPABASE_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "installId": "client-generated-random-uuid",
    "platform": "ios",
    "appVersion": "0.1.0"
  }'
```

Check Fiton balance:

```bash
curl http://localhost:4000/fitons/balance \
  -H "Authorization: Bearer <SUPABASE_ACCESS_TOKEN>"
```

Create a pre-signed body-photo upload URL:

```bash
curl -X POST http://localhost:4000/uploads/photo-url \
  -H "Authorization: Bearer <SUPABASE_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "contentType": "image/jpeg",
    "deviceProfileId": "<optional-device-profile-id>"
  }'
```

Create a product URL input:

```bash
curl -X POST http://localhost:4000/product-inputs/url \
  -H "Authorization: Bearer <SUPABASE_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "sourceUrl": "https://example.com/product"
  }'
```

Create a try-on job:

```bash
curl -X POST http://localhost:4000/try-on-jobs \
  -H "Authorization: Bearer <SUPABASE_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "userPhotoId": "<uploaded-photo-id>",
    "productInputId": "<product-input-id>"
  }'
```

Job creation:

1. checks the user's Fiton balance,
2. debits 1 Fiton,
3. creates a `try_on_jobs` row,
4. sends a compact message to SQS.

## Tests and Type Checking

Run type checking:

```bash
npm run typecheck
```

Run tests:

```bash
npm test
```

Build production JavaScript:

```bash
npm run build
```

## Lambda Deployment Shape

The codebase has Lambda-oriented entry points:

- `src/lambda/api.ts`: API Gateway -> Fastify API Lambda.
- `src/lambda/worker.ts`: SQS -> Worker Lambda.
- `src/lambda/cleanup.ts`: EventBridge schedule -> Cleanup Lambda.

Recommended MVP deployment:

```text
React Native App
  -> API Gateway
  -> API Lambda
  -> Supabase Auth verification
  -> Supabase Postgres
  -> S3 pre-signed uploads
  -> SQS try_on_jobs
  -> Worker Lambda
  -> GenAI Try-On Provider
  -> S3 Results
  -> CloudFront
  -> Push Adapter
```

Stripe or native IAP webhooks can use the same API Lambda at first. If payment volume or isolation needs grow, split payment handling into a separate Webhook Lambda.

## Current Implementation Status

Implemented:

- Typed Fastify API shell.
- Supabase JWT verification middleware.
- App user sync and initial 5-Fiton grant.
- Authenticated Settings/Profile summary endpoint.
- Device registration with hashed install ID.
- Fiton balance and ledger read endpoints.
- S3 pre-signed upload URL endpoints.
- Product URL/screenshot input endpoints.
- Fiton-gated try-on job creation and SQS enqueue.
- Result list/detail/delete endpoints.
- Push token registration.
- Privacy deletion request.
- Subscription plan read endpoints and checkout placeholders.
- Stripe/app-store/google-play webhook placeholder routes.
- Lambda worker and cleanup placeholders.

Still intentionally stubbed:

- Actual GenAI provider integration.
- Stripe checkout/customer portal creation.
- Native in-app purchase validation.
- Push provider network call.
- Admin dashboard frontend.

These stubs are isolated so the implementation can grow without changing the mobile-facing API shape.
