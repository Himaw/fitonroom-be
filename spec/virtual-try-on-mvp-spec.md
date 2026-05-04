# Fiton Room MVP Product and System Design Spec

Status: Updated first product version  
Document date: May 4, 2026  
Prepared for: Fiton Room MVP planning

Fiton Room is a mobile virtual try-on app that lets shoppers sign in with a simple OAuth flow, upload full-body photos, submit clothing from online stores, and receive AI-generated try-on results.

## MVP Overview

| Area | Decision |
| --- | --- |
| Version | First product version with Google and Apple OAuth login, authenticated history, and device registration for app installs |
| Primary platform | React Native mobile app with iOS-specific share extension support |
| Auth provider | Supabase Auth with Google OAuth and Sign in with Apple |
| Core backend | Node.js API, Supabase Postgres, S3, SQS, worker processing, and GenAI try-on provider |
| Monetization | Each new user receives 5 initial Fitons; paid subscriptions grant more Fitons monthly |
| MVP goal | Validate whether users find virtual try-on useful, fast enough, visually convincing, and worth paying for after the free trial |

## Contents

1. Executive Summary
2. Product Vision
3. Version 1 User Flow
4. MVP Feature Scope
5. Recommended Tech Stack
6. Initial System Design
7. Service Connections
8. Identity and Authentication Model
9. Fitons, Trial Usage, and Monetization
10. Data Model
11. API Surface
12. Caching Strategy
13. Security and Privacy
14. Development Roadmap
15. Open Questions

## 1. Executive Summary

Fiton Room is a mobile virtual try-on app. A user signs in with Google or Apple, uploads one to three full-body photos, submits a clothing item from an online store, and receives an AI-generated image showing the garment on their body.

The first version should still be low-friction, but it should not rely only on an anonymous device ID. Supabase Auth should provide user authentication from the start, while a backend-registered device profile should remain useful for push notifications, install metadata, abuse protection, and troubleshooting.

### MVP Identity

Authenticated user account through Supabase Auth using Google OAuth and Sign in with Apple. Device registration remains as a secondary install profile linked to the authenticated user.

### Trial Credits

Each newly created user receives 5 free Fitons. A standard try-on generation consumes 1 Fiton. Future premium actions can consume more than 1 Fiton if they cost more to produce.

### Monetization

Use a subscription-based Fiton plan model. Paid users receive a monthly allowance of Fitons, and the product can later add one-time Fiton top-ups if subscriptions alone are not enough.

### Image Storage

Amazon S3 and CloudFront.

### Backend

Node.js API and async worker.

### Database

Supabase Postgres for MVP, using Supabase Auth user IDs as the primary account identity.

### Recommendation

Start without Kubernetes/EKS. Use Supabase Auth, Supabase Postgres, S3, SQS, Lambda or ECS/Fargate worker, Stripe for subscription payments, and a third-party try-on API. Add Redis and heavier infrastructure after real usage proves the need.

## 2. Product Vision

Fiton Room should make online clothing discovery feel more personal. The product is not just an image generator; it is a shopping companion that turns product pages, screenshots, and shared links into personal try-on previews.

### Primary MVP Outcome

Validate that users can complete the flow from authenticated sign-in to uploaded photo to useful try-on image with minimal friction and enough visual quality to make them return and consider paying.

### Initial Target User

Everyday online shoppers who want to preview clothes on themselves before buying.

### Business Validation Goal

Learn whether 5 free Fitons are enough for users to understand the value, and whether a monthly subscription allowance is a compelling way to continue using the product.

## 3. Version 1 User Flow

1. Open app: User opens Fiton Room.
2. Authenticate: User signs in with Google or Apple through Supabase Auth.
3. Create or update profile: Backend creates an app user profile linked to the Supabase Auth user ID.
4. Register device: App creates a secure install ID, stores it locally, and registers the device profile against the authenticated user.
5. Grant trial Fitons: Backend grants 5 initial Fitons once per user account.
6. Upload photos: User uploads one to three full-body photos using S3 pre-signed URLs.
7. Submit clothing: User pastes a product URL, uploads a screenshot, or uses the iOS share extension.
8. Check Fiton balance: Backend confirms the user has enough Fitons before accepting a try-on job.
9. Create job: Backend creates a try-on job, reserves or deducts 1 Fiton, and sends the job to an async queue.
10. Generate result: Worker extracts garment data and calls the virtual try-on API.
11. Save and notify: Result is saved to S3, metadata is saved in Postgres, and a push notification may be sent.
12. View history: User sees result history tied to their account, with device metadata used only as supporting context.
13. Buy more access: When the balance is low or empty, user can subscribe to receive a monthly Fiton allowance.

## 4. MVP Feature Scope

### Must Have

- React Native mobile app with Fiton Room branding
- Supabase Auth integration
- Google OAuth login
- Sign in with Apple login
- Authenticated account-based result history
- Device registration linked to authenticated users
- Initial grant of 5 free Fitons per new user account
- Fiton balance display
- Try-on job creation that requires and consumes Fitons
- Upload one to three full-body photos
- Paste product URL
- Upload clothing screenshot
- Create try-on job and show status: pending, processing, completed, failed
- Display generated try-on result
- Delete uploaded photos and generated results from account history
- S3 storage for raw uploads and generated results
- Supabase Postgres metadata storage

### Should Have

- iOS Share Extension using Swift
- Push notification when processing completes
- CloudFront image delivery
- Basic retry for failed worker jobs
- Product URL extraction cache
- Stripe subscription checkout or native in-app purchase planning, depending on launch platform rules
- Internal admin dashboard for job review, user lookup, Fiton ledger review, and failure debugging

### Later

- Email login or phone login if users ask for more sign-in options
- Cross-device sync refinements
- Android share support
- Saved wardrobe
- Multiple try-on variations per item
- One-time Fiton top-ups
- Referral credits or promotional Fitons
- Affiliate links or ecommerce checkout integrations
- In-house ML model
- Kubernetes/EKS for mature scale

## 5. Recommended Tech Stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Mobile | React Native + TypeScript | Fast cross-platform mobile development |
| UI | HeroUI Native | Native-focused UI layer matching the app plan |
| iOS Extension | Swift / SwiftUI | Best fit for iOS share extension behavior |
| Authentication | Supabase Auth | Built-in OAuth, JWT handling, user session management, and close fit with Postgres |
| OAuth Providers | Google and Apple | Simple first auth surface; Apple is important for iOS user expectations and App Store compliance when third-party login exists |
| Backend API | Node.js with NestJS or Fastify | Good developer speed, strong ecosystem, simple API work |
| Database | Supabase Postgres | Fast MVP setup, free tier, real Postgres, and direct relationship to Supabase Auth users |
| Object Storage | Amazon S3 | Reliable storage for user uploads and generated images |
| CDN | Amazon CloudFront | Faster delivery of thumbnails and results |
| Queue | Amazon SQS | Simple async job orchestration |
| Worker | Lambda first, ECS/Fargate later | Start simple; move to containers if jobs are long-running |
| Payments | Stripe Billing first for web checkout; evaluate Apple/Google in-app purchase for mobile subscriptions | Stripe is fastest operationally, but mobile app distribution rules may require native purchase flows for digital credits |
| Cache | Redis later | Useful for rate limits, job status, and URL extraction cache after traffic grows |
| Web/Admin Hosting | AWS Amplify Hosting | Good for a web dashboard, not for hosting the mobile app itself |

## 6. Initial System Design

Initial Fiton Room architecture: mobile app, Supabase Auth, backend API, Postgres, S3, CloudFront, SQS, worker processing, GenAI try-on API, payments, Fiton ledger, admin tooling, cache later, and push notifications.

```text
Client Layer
  React Native + TypeScript mobile app
    - app screens, auth flow, uploads, job status, gallery, Fiton balance
  HeroUI Native
    - consistent app UI components and styling
  Swift / SwiftUI iOS Share Extension
    - product URL and screenshot handoff from Safari or shopping apps

Authentication and API Layer
  Supabase Auth
    - Google OAuth, Sign in with Apple, sessions, JWTs
  Node.js Backend API, NestJS or Fastify
    - verifies Supabase JWTs
    - creates app user profiles and device profiles
    - creates S3 pre-signed upload URLs
    - checks Fiton balance before job creation
    - creates try-on jobs and result history
    - handles deletion, subscriptions, and push token registration

Data and Storage Layer
  Supabase Postgres
    - app_users, device_profiles, photos, product_inputs, jobs, results
    - Fiton accounts, Fiton ledger, subscriptions, payment events, push tokens
  Amazon S3
    - private body photos, clothing screenshots, generated results, thumbnails
  Amazon CloudFront
    - fast delivery of generated results and thumbnails

Async Generation Layer
  Amazon SQS
    - queue try-on jobs after the API records the job and Fiton debit/reservation
  Lambda worker first, ECS/Fargate later
    - downloads inputs from S3
    - extracts garment/product details
    - calls the GenAI virtual try-on provider
    - writes result images to S3
    - updates Postgres job/result records
  GenAI Try-On Provider
    - external virtual try-on generation until in-house ML is justified

Payments and Fitons Layer
  Stripe Billing or native Apple/Google in-app purchase
    - subscription checkout, renewals, cancellations, payment failures
  Payment webhook handler
    - verifies event signatures and processes events idempotently
  Fiton ledger
    - initial 5-Fiton grant, monthly grants, job debits, refunds, expirations

Notifications and Operations
  Expo Push first, direct APNs/FCM later
    - notify when try-on generation completes or fails
  AWS Amplify Hosting
    - internal admin dashboard hosting
  Admin dashboard
    - job review, user lookup, provider failures, Fiton ledger review
  Redis later
    - rate limits, fast job status, URL extraction cache, temporary session state
```

### Main Request Flow

1. User uploads body photos from the React Native app; the backend returns pre-signed S3 upload URLs.
2. User shares, pastes, or uploads a product URL/screenshot through the app or iOS Share Extension.
3. App creates an authenticated try-on job through the Node.js API after the backend verifies Supabase Auth and checks Fiton balance.
4. Backend records the job, debits or reserves Fitons, stores metadata in Postgres, and queues work in SQS.
5. Worker processes the queued job, extracts garment/product data, calls the GenAI virtual try-on provider, and writes the result image to S3.
6. Result metadata is saved in Postgres and the generated image is delivered through CloudFront.
7. Push notification tells the user the job is complete.
8. If the user needs more Fitons, Stripe or native in-app purchase events update subscription state and grant Fitons through the ledger.

### Technology Responsibility Summary

| Technology | How Fiton Room Uses It | Why It Is Included |
| --- | --- | --- |
| React Native + TypeScript | Mobile app screens, auth flow, uploads, job status, gallery, Fiton balance, subscription entry points | One codebase for iOS and Android MVP speed |
| HeroUI Native | App UI components and visual consistency | Avoids rebuilding common UI primitives |
| Swift / SwiftUI Share Extension | iOS product URL and screenshot handoff | Makes clothing capture native and fast |
| Supabase Auth | Google OAuth, Sign in with Apple, sessions, JWTs | Avoids custom auth infrastructure |
| Node.js API | Business logic, authorization, upload URLs, Fiton checks, job creation, deletion, subscription state | Keeps client thin and prevents bypassing ownership or Fiton rules |
| Supabase Postgres | Users, devices, metadata, jobs, results, Fitons, subscriptions, payment events, push tokens | Fast MVP relational database with Supabase Auth integration |
| Amazon S3 | Raw photos, screenshots, generated images, thumbnails | Stores large image files outside the API and database |
| CloudFront | Result and thumbnail delivery | Improves image load time while keeping S3 private |
| Amazon SQS | Try-on job queue | Separates mobile/API responsiveness from slow generation work |
| Lambda first, ECS/Fargate later | Worker execution for extraction, provider calls, result writes, notifications | Starts simple and can move to containers if jobs are long-running |
| GenAI Try-On Provider | External try-on generation | Validates product demand before in-house ML |
| Stripe Billing or Native IAP | Subscription payment flow and renewals | Required for paid Fiton plans |
| Expo Push first | Generation completion/failure notifications | Fast MVP notification path |
| AWS Amplify Hosting | Internal admin dashboard hosting | Simple operational dashboard hosting |
| Redis later | Rate limits, fast status, URL cache, temporary session state | Add only after traffic proves the need |

## 7. Service Connections

### Mobile App to Supabase Auth

The app uses Supabase Auth for Google OAuth and Sign in with Apple. The app receives a Supabase session and sends the access token to the backend API on authenticated requests.

### Mobile App to Backend API

The app calls the Node.js API over HTTPS. The API verifies the Supabase JWT, maps the request to an internal user profile, and handles device registration, upload URL creation, job creation, Fiton balance, job status, result history, deletion requests, subscription status, and push token registration.

### Mobile App to S3

The app uploads photos and screenshots directly to S3 using pre-signed URLs from the backend. Large image files should not pass through the API server.

### Backend API to Supabase Postgres

Postgres stores app user profiles, device profiles, photo metadata, product submissions, job records, results, Fiton balances, Fiton ledger entries, subscription status, payment customer mappings, and push tokens. The database should store S3 object keys, not raw images.

### Backend API to SQS

When the app creates a try-on job, the backend stores a job row in Postgres, records the Fiton debit or reservation, and sends a compact message to SQS containing job ID and input references.

### SQS to Worker

The worker pulls jobs from SQS, fetches source assets from S3, extracts garment/product details, calls the try-on API, writes the result image to S3, and updates Postgres.

### Payment Provider to Backend

Stripe or the native app store payment system sends subscription events to a backend webhook. The backend updates subscription state and grants monthly Fitons through the Fiton ledger. Webhooks must be idempotent.

### S3 Results to CloudFront

Generated images and thumbnails are served through CloudFront for faster delivery and cleaner public access control.

### Worker to Push Notifications

When a job completes or fails, the worker can trigger Expo Push for MVP. Direct APNs/FCM can replace this later if more control is needed.

## 8. Identity and Authentication Model

V1 decision: Fiton Room will require account authentication using Supabase Auth with Google and Apple only. Device registration remains, but it is no longer the primary identity.

### How It Works

1. On first launch, the user signs in with Google or Apple.
2. Supabase Auth creates or returns an authenticated user.
3. The app sends the Supabase access token to the backend.
4. The backend verifies the JWT and creates an `app_users` row if one does not already exist.
5. The app generates a random device install UUID.
6. The UUID is stored in secure local storage such as iOS Keychain or Expo SecureStore.
7. The app registers this install ID with the backend as a device profile linked to the authenticated user.
8. Photos, product inputs, jobs, results, Fitons, and subscriptions are linked to the user account.
9. Push tokens and app install metadata are linked to the device profile.

### Important Notes

- Do not rely on hardware IDs, IDFA, serial numbers, or other sensitive tracking identifiers.
- Hash the app-generated install ID before storing it.
- A user can sign in on a new phone and recover their account-based history.
- A single user can have multiple device profiles.
- Deleting the app should not delete account history unless the user requests account or data deletion.
- Account deletion must remove or anonymize user-owned metadata and delete user-owned S3 objects according to the retention policy.

## 9. Fitons, Trial Usage, and Monetization

Fitons are the app's usage unit for try-on generation.

### Fiton Rules

- Each new user receives 5 free Fitons after account creation.
- The free grant is one-time per authenticated user, not one-time per device.
- A standard try-on generation costs 1 Fiton.
- Failed jobs caused by platform/provider errors should refund the Fiton automatically.
- Failed jobs caused by invalid user input may either refund or not refund; decide before launch and communicate it clearly.
- The backend, not the mobile client, is the source of truth for Fiton balance.
- All Fiton changes should be recorded in an append-only ledger.

### Recommended MVP Subscription Model

| Plan | Monthly Fitons | Purpose |
| --- | ---: | --- |
| Free Trial | 5 one-time Fitons | Let users test the value before paying |
| Starter | 30 Fitons per month | Casual shoppers trying a few outfits weekly |
| Plus | 100 Fitons per month | Frequent shoppers and social users |
| Pro | 250 Fitons per month | Heavy users, creators, stylists, or testing-heavy users |

Prices should be set after provider cost testing. The plan structure should be implemented as configurable database records rather than hardcoded app logic.

### Subscription Behavior

- On subscription start, grant the plan's monthly Fiton allowance.
- On renewal, grant the next monthly allowance after successful payment.
- If payment fails, keep the account usable only while the user has remaining Fitons, but do not grant new monthly Fitons until payment recovers.
- If the user cancels, keep already granted Fitons available until they expire or are used, depending on the chosen policy.
- Track subscription status separately from Fiton balance.
- Webhook processing must be idempotent to avoid duplicate monthly grants.

### Expiration Policy

Recommended MVP policy: paid monthly Fitons expire after 60 days, while the 5 free trial Fitons do not expire during MVP. This keeps paid allowances from becoming an unlimited liability while keeping the first user experience simple.

### Payment Implementation Note

If the product sells digital try-on credits inside iOS or Android apps, app store rules may require native in-app purchases. For fastest MVP learning, decide whether the first paid flow launches through web checkout, native in-app purchase, or both. The backend should abstract the payment source so the Fiton ledger works the same way either way.

## 10. Initial Data Model

| Table | Purpose | Key Fields |
| --- | --- | --- |
| `app_users` | App-level user profile mapped to Supabase Auth | `id`, `supabase_user_id`, `email`, `display_name`, `avatar_url`, `created_at`, `last_seen_at` |
| `device_profiles` | Registered app installs | `id`, `user_id`, `install_id_hash`, `platform`, `app_version`, `created_at`, `last_seen_at` |
| `user_photos` | Uploaded body photos | `id`, `user_id`, `device_profile_id`, `s3_key`, `image_type`, `status`, `created_at` |
| `product_inputs` | URL, screenshot, or share inputs | `id`, `user_id`, `device_profile_id`, `input_type`, `source_url`, `screenshot_s3_key`, `extraction_status` |
| `try_on_jobs` | Async generation jobs | `id`, `user_id`, `device_profile_id`, `user_photo_id`, `product_input_id`, `status`, `fiton_cost`, `failure_reason` |
| `try_on_results` | Generated image records | `id`, `job_id`, `user_id`, `result_s3_key`, `thumbnail_s3_key`, `provider` |
| `fiton_accounts` | Current user balance summary | `id`, `user_id`, `available_balance`, `updated_at` |
| `fiton_ledger_entries` | Append-only credit/debit history | `id`, `user_id`, `entry_type`, `amount`, `balance_after`, `source`, `reference_id`, `expires_at`, `created_at` |
| `subscription_plans` | Configurable paid plan definitions | `id`, `name`, `monthly_fitons`, `price_amount`, `currency`, `active` |
| `user_subscriptions` | User subscription state | `id`, `user_id`, `plan_id`, `provider`, `provider_subscription_id`, `status`, `current_period_start`, `current_period_end` |
| `payment_customers` | Payment provider customer mapping | `id`, `user_id`, `provider`, `provider_customer_id`, `created_at` |
| `payment_events` | Idempotent webhook processing | `id`, `provider`, `provider_event_id`, `event_type`, `processed_at` |
| `push_tokens` | Notification routing | `id`, `user_id`, `device_profile_id`, `platform`, `token`, `enabled`, `updated_at` |
| `deletion_requests` | Privacy and cleanup tracking | `id`, `user_id`, `status`, `requested_at`, `completed_at` |

## 11. Initial API Surface

All non-public API routes should require a valid Supabase access token. The backend should verify the token and derive `user_id` server-side.

### Auth and Profile

- `GET /auth/me`
- `POST /auth/session-sync`
- `PATCH /users/me`
- `DELETE /users/me`

### Devices

- `POST /devices/register`
- `PATCH /devices/:id`
- `GET /devices`

### Fitons

- `GET /fitons/balance`
- `GET /fitons/ledger`
- `POST /fitons/grant-initial-trial` internal or protected server action

### Uploads

- `POST /uploads/photo-url`
- `POST /uploads/screenshot-url`
- `POST /uploads/complete`

### Product Inputs

- `POST /product-inputs/url`
- `POST /product-inputs/screenshot`
- `GET /product-inputs/:id`

### Try-On Jobs

- `POST /try-on-jobs`
- `GET /try-on-jobs/:id`
- `GET /try-on-jobs`
- `POST /try-on-jobs/:id/cancel`

### Results

- `GET /results`
- `GET /results/:id`
- `DELETE /results/:id`

### Payments and Subscriptions

- `GET /subscription-plans`
- `GET /subscriptions/me`
- `POST /subscriptions/checkout`
- `POST /subscriptions/customer-portal`
- `POST /webhooks/stripe`
- `POST /webhooks/app-store`
- `POST /webhooks/google-play`

### Push

- `POST /push-tokens`
- `DELETE /push-tokens/:id`

### Privacy

- `POST /privacy/delete-account-data`
- `POST /privacy/delete-photo/:id`
- `POST /privacy/delete-result/:id`

## 12. Caching Strategy

### MVP Caching

- Mobile local cache for recent result thumbnails
- CloudFront cache for result images and thumbnails
- Database-backed job polling for the first version
- Database-backed Fiton balance reads for the first version

### Add Redis When Needed

- Rate limiting by user ID, device install ID, and IP
- Fast job status updates
- Duplicate product URL extraction cache
- Temporary upload/session state
- Worker progress updates
- Fiton balance read-through cache if database reads become too frequent

## 13. Security and Privacy

- Use Supabase Auth for Google and Apple login.
- Verify Supabase JWTs on the backend for every authenticated API request.
- Derive `user_id` from the verified token; do not trust user IDs sent by the client.
- Use pre-signed S3 URLs with short expiration times.
- Keep S3 buckets private; serve approved results through CloudFront.
- Hash the app install ID before storing it in Postgres.
- Never use hardware identifiers as the primary user identity.
- Allow users to delete uploaded photos and generated results.
- Provide account deletion and data deletion from the start.
- Define raw photo retention before public launch.
- Show clear consent before uploading body photos.
- Log job failures without leaking sensitive image URLs.
- Store OAuth provider IDs only through Supabase Auth unless the backend has a specific need.
- Protect payment webhooks with signature verification.
- Make Fiton ledger writes server-side only.

Privacy risk: Full-body photos are sensitive personal data. The MVP should include deletion, retention, consent, and account-level data export/deletion behavior from the start.

Abuse risk: Free Fitons can be farmed through repeated account creation. The MVP should apply lightweight abuse controls such as rate limits, provider checks, device profile signals, and payment-required continuation after the first 5 Fitons.

## 14. Development Roadmap

| Phase | Goal | Deliverables |
| --- | --- | --- |
| Phase 1 | Foundation | Mobile app shell, Supabase Auth setup, Google OAuth, Sign in with Apple, backend auth verification, Postgres schema, device registration |
| Phase 2 | Fitons and Upload Flow | Initial 5-Fiton grant, balance screen, Fiton ledger, S3 upload flow, photo upload, product URL input, screenshot upload |
| Phase 3 | Input and Job Flow | Job creation, Fiton debit/reservation, status screen, refund behavior for failed jobs, result display |
| Phase 4 | AI Integration | Worker, product extraction, garment extraction, virtual try-on API, result saving, provider failure handling |
| Phase 5 | History and Notifications | Account-based gallery, cross-device history, push notifications, deletion flow, error states |
| Phase 6 | Monetization | Subscription plan records, checkout or in-app purchase integration, webhook processing, monthly Fiton grants, cancellation/payment-failure handling |
| Phase 7 | Admin and Polish | Basic admin dashboard, job review, user review, Fiton ledger review, failure monitoring, launch hardening |

## 15. Open Questions

### Product

1. Should the first release be iOS only, or iOS and Android?
2. Should the first clothing input be product URL, screenshot upload, or iOS share extension?
3. Should each try-on job generate one image or multiple variations?
4. Should raw photos expire automatically after a set number of days?
5. Should generated results be permanent until deleted?
6. Should users be able to use the app at all before signing in, or should sign-in happen before upload?

### Technical

1. Do we use Expo or bare React Native?
2. Do we choose NestJS or Fastify for the backend?
3. Which virtual try-on API provider should be tested first?
4. Should the MVP admin dashboard be included in the first build?
5. What is the target processing time for one try-on job?
6. Should Fitons be deducted at job creation or reserved first and finalized after provider success?
7. Which payment path should launch first: Stripe web checkout, Apple in-app purchase, Google Play billing, or a hybrid?

### Business

1. Are 5 free Fitons enough for users to understand the value?
2. What should each subscription plan cost after provider costs are known?
3. Should unused paid Fitons expire, roll over, or partially roll over?
4. Should Fiton top-ups exist at launch, or should the MVP start with subscriptions only?
5. Will Fiton Room support affiliate links or checkout integrations later?
