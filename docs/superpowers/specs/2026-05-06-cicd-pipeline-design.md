# CI/CD Pipeline Design — Fiton Room Backend

**Date:** 2026-05-06
**Status:** Design approved, pending implementation plan
**Owner:** Backend team

## 1. Goal

Establish an end-to-end CI/CD pipeline for `fitonroom-be` that:

- Validates every pull request (typecheck, tests, Docker build, infra synth).
- Auto-deploys `main` to a `dev` AWS environment on every merge.
- Promotes a verified `dev` image to `prod` via a manually-triggered, reviewer-approved GitHub Actions workflow.
- Defines all AWS infrastructure as code so `dev` and `prod` are reproducible and drift-free.
- Runs database migrations safely as part of CD (never at app startup).
- Provides minimal observability and a fast, well-defined rollback path.

Non-goals for the initial pipeline are listed in §10.

## 2. Decisions Locked In

| #   | Decision               | Choice                                                                                                                                    |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Deployment target      | Docker images on **AWS ECS Fargate**                                                                                                      |
| 2   | CI provider            | **GitHub Actions** (OIDC to AWS, no long-lived keys)                                                                                      |
| 3   | Environments           | **`dev` + `prod`** (two ECS clusters, two Supabase projects/schemas, two S3 bucket sets, two SQS queues)                                  |
| 4   | Branching & promotion  | **Trunk-based.** PR → CI. Merge to `main` → auto-deploy `dev`. Manual workflow promotes the same image to `prod` after reviewer approval. |
| 5   | Infrastructure-as-Code | **AWS CDK (TypeScript)**, lives in `infra/` in this repo                                                                                  |
| 6   | Secrets management     | **AWS Secrets Manager**, one JSON-blob secret per env, read at task start by the Fargate task role                                        |

## 3. High-Level Architecture

**Build artifact:** one Docker image per commit, stored in **ECR**. The same image runs the API, worker, and cleanup task — different `command` per task definition.

Per-environment AWS resources (created by CDK, identical shape for `dev` and `prod`, parameterized by an env config):

| Resource                 | Purpose                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| ECS Fargate cluster      | Hosts all services for the env                                                                              |
| ALB + ACM cert           | HTTPS termination, routes to API service                                                                    |
| API service (Fargate)    | Long-running, runs `node dist/server.js` behind ALB                                                         |
| Worker service (Fargate) | Long-running, autoscales on SQS queue depth                                                                 |
| Cleanup scheduled task   | EventBridge cron → `aws ecs run-task` on Fargate                                                            |
| SQS try-on queue + DLQ   | Async job pipeline                                                                                          |
| S3 raw + results buckets | Body photos, generated try-on results                                                                       |
| Secrets Manager entry    | One per env, JSON blob of all app secrets                                                                   |
| CloudWatch log groups    | Per service, 30-day retention dev / 90-day prod                                                             |
| IAM roles                | Task execution role, app task role per service (least-privilege), CI deploy role assumed via GitHub OIDC    |
| VPC                      | Default VPC + public subnets behind ALB SG. Private subnets + NAT deferred until traffic justifies the cost |

**Per-env sizing (initial):**

| Param                     | dev                                                        | prod          |
| ------------------------- | ---------------------------------------------------------- | ------------- |
| API task count            | 1                                                          | 2             |
| API CPU / memory          | 256 / 512 MB                                               | 512 / 1024 MB |
| Worker min tasks          | 0                                                          | 1             |
| Worker max tasks          | 2                                                          | 5             |
| Worker autoscaling metric | SQS `ApproximateNumberOfMessagesVisible` (target tracking) |

**Worker on Fargate (not Lambda).** Chosen for deployment uniformity — one image, one model, one mental model. Autoscaling to `min=0` in dev keeps idle cost near zero. Lambda would be simpler operationally but creates two parallel deployment patterns.

**Single ECR repo, tag-based env separation.** Tags: `:dev-<sha>`, `:dev-latest`, `:prod-<sha>`, `:prod-latest`. Promotion to prod is a tag-copy of the exact bytes that ran in dev.

## 4. Repo Layout

Single repository, infra colocated with app code:

```text
fitonroom-be/
  src/                          existing app code (unchanged)
  infra/                        NEW — CDK app
    bin/
      app.ts                    instantiates dev + prod stacks
    lib/
      app-stack.ts              ECS, ALB, services, SQS, IAM
      secrets-stack.ts          Secrets Manager
      config.ts                 per-env knobs
    cdk.json
    package.json                separate from app package.json
    tsconfig.json
  Dockerfile                    NEW — multi-stage
  .dockerignore                 NEW
  .github/
    workflows/
      ci.yml                    runs on PRs
      deploy-dev.yml            runs on merge to main
      deploy-prod.yml           manual workflow_dispatch
  package.json                  unchanged
```

A separate `infra/package.json` keeps `@aws-cdk/*` dependencies out of the app's `node_modules` and out of the runtime image.

## 5. Dockerfile

Multi-stage so the runtime image stays small and contains no dev dependencies or source:

```dockerfile
# Stage 1: build TS to JS
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: runtime
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/server.js"]
```

Worker and cleanup task definitions override `command` to run `node dist/workers/<entry>.js` and `node dist/lambda/cleanup.js` (or wherever the cleanup entry lands when ported off Lambda).

## 6. CDK App Shape

```ts
// bin/app.ts (sketch)
const app = new cdk.App();
const imageTag = app.node.tryGetContext("imageTag"); // passed by CD workflow
new FitonStack(app, "FitonStack-dev", { env: "dev", imageTag, ...devConfig });
new FitonStack(app, "FitonStack-prod", { env: "prod", imageTag, ...prodConfig });
```

`config.ts` holds the per-env differences (task counts, CPU/memory, log retention, ACM cert ARN, hosted zone, etc.). The stack itself is environment-agnostic.

**Image SHA flows through CDK context.** Task definitions reference `<ECR>/fitonroom-be:<imageTag>` where `imageTag` is the SHA-tagged value (e.g. `dev-abc1234`) passed by the CD workflow as `--context imageTag=...`. Each deploy mutates the task definition, which causes ECS to roll new tasks automatically. `dev-latest` and `prod-latest` exist for human convenience (e.g. as the default `imageTag` input on `deploy-prod.yml`) but are not what task definitions reference at deploy time.

## 7. GitHub Actions Workflows

All workflows authenticate to AWS via **OIDC**. CDK provisions the IAM roles `fitonroom-be-deploy-dev` and `fitonroom-be-deploy-prod`, each with a trust policy that restricts to this specific repo and to the appropriate branch / GitHub Environment.

### 7a. `ci.yml` — every pull request

No AWS credentials. Steps:

1. Checkout
2. Setup Node 20
3. `npm ci`
4. `npm run typecheck`
5. `npm test`
6. `docker build -t fitonroom-be:pr-${{ github.sha }} .` (verify the image builds; do not push)
7. `cd infra && npm ci && npx cdk synth` (catch infra TypeScript and CDK errors early)

PR is blocked from merging if any step fails.

### 7b. `deploy-dev.yml` — merge to `main`

Uses GitHub Environment `dev` (no required reviewers). Steps:

1. Checkout
2. Setup Node 20, run typecheck + tests (gate)
3. Configure AWS credentials via OIDC (assume `fitonroom-be-deploy-dev`)
4. ECR login
5. `docker build -t $ECR/fitonroom-be:dev-${{ github.sha }} .`
6. `docker push` (also tag and push as `:dev-latest`)
7. `cd infra && npx cdk deploy FitonStack-dev --context imageTag=dev-${{ github.sha }} --require-approval never`
8. Run DB migration as a one-shot ECS task using the new task definition revision; block on success (see §8)
9. CDK deploy in step 7 already triggers an ECS rolling update because the task definition changed. Wait for `aws ecs wait services-stable` before continuing.
10. Smoke test: `curl https://dev.api.fitonroom.com/health` — fail the workflow if not 200

### 7c. `deploy-prod.yml` — manual `workflow_dispatch`

Uses GitHub Environment `prod` with **required reviewers**.

Inputs:

- `imageTag`: which `dev-<sha>` to promote (defaults to `dev-latest`)

Steps:

1. Wait for required-reviewer approval (GitHub Environment protection rule)
2. Checkout
3. Configure AWS credentials via OIDC (assume `fitonroom-be-deploy-prod`)
4. ECR login
5. **Re-tag** — pull `dev-<sha>` from the input, tag as `prod-<sha>` and `prod-latest`, push. **No rebuild.**
6. `cd infra && npx cdk deploy FitonStack-prod --context imageTag=prod-<sha>` (CDK diff appears in workflow log; reviewer reads before approving)
7. Run DB migration as a one-shot ECS task using the new task definition revision; block on success
8. Wait for `aws ecs wait services-stable` (CDK already mutated task defs in step 6, ECS rolls automatically)
9. Smoke test: `curl https://api.fitonroom.com/health` — fail the workflow if not 200
10. On any failure: workflow exits non-zero. Operator re-runs `deploy-prod` with the previous-known-good `imageTag` to roll back.

## 8. Database Migrations

**Run migrations in CD as a one-shot ECS task. Never at app startup.**

Why not at startup:

- N task replicas would race the same migration.
- A bad migration would crash every replica on boot, taking the full service offline with no clean recovery.
- Slow migrations would block ECS startup health checks and cause task kills.

How it works:

1. CDK defines a `fitonroom-be-migrate-<env>` task definition using the same image, with `command = ["node", "dist/db/migrate.js"]`, in the same VPC/SG as the services.
2. CD workflow runs:
   ```
   aws ecs run-task \
     --cluster <env-cluster> \
     --task-definition fitonroom-be-migrate-<env> \
     --launch-type FARGATE \
     --network-configuration ...
   ```
3. CD polls `aws ecs describe-tasks` until the task exits. Workflow fails if exit code ≠ 0.
4. **Migration runs before the API/worker redeploy.** If it fails, services keep running on the old image — no half-migrated state.

**Forward-only migrations.** No automated `down`. Bad migrations are fixed by writing a new forward migration. Standard `node-pg-migrate` or the existing `src/db/migrate.ts` runner is fine.

## 9. Observability and Rollback

### 9a. Observability (CDK-defined from day one)

- **CloudWatch Logs** — log group per service, retention 30 days dev / 90 days prod. Fastify already logs structured JSON via pino; ECS forwards stdout to CloudWatch.
- **Container Insights** enabled on the ECS cluster — CPU/memory/task-count metrics without an extra agent.
- **CloudWatch Alarms (initial set):**
  - ALB 5xx rate > 1% over 5 min
  - ECS service `RunningTaskCount` < `DesiredCount` for > 5 min
  - SQS `ApproximateNumberOfMessagesVisible` > threshold (queue backing up)
  - SQS DLQ `ApproximateNumberOfMessagesVisible` > 0 (any failed job)
- **Alarm destination:** SNS topic per env, wired to email. Slack/Chatbot integration deferred.

### 9b. Rollback

- **App rollback:** re-run `deploy-prod.yml` with the previous `imageTag`. Images in ECR are immutable per SHA, so the prior image is always available.
- **Infra rollback:** `git revert` the bad CDK commit, push, run `deploy-prod`.
- **Migration rollback:** not automated. Forward-fix only.
- **RTO target (MVP):** 5–10 min from "prod broken" to "prod restored," bound by ECS rolling redeploy + ALB target draining.

For destructive migrations, the operator should add a manual confirmation step in the deploy-prod run (commented in the PR; we do not ship a separate gate for this initially).

## 10. Out of Scope (Future Work)

- Blue/green deploys via CodeDeploy (Fargate gives rolling deploys for free)
- Canary / weighted routing
- A `staging` environment between `dev` and `prod`
- Cost dashboards and budget alarms
- Secrets Manager rotation Lambdas
- WAF on the ALB
- Tracing / APM (Datadog, OTel, Sentry)
- Multi-region

## 11. Open Questions for Implementation Plan

- DNS / domain setup: which hosted zone owns `api.fitonroom.com` and `dev.api.fitonroom.com`? Is the ACM cert already issued?
- Existing AWS resources: are S3 buckets, the SQS queue, or the ECR repo already created click-ops? If so, CDK will need to import them rather than create them.
- Supabase project layout for `dev` vs `prod`: separate Supabase projects, or one project with two schemas? This affects `DATABASE_URL` and the JWT secret.
- Which AWS account(s)? Single account with env separation by tags/IAM, or two accounts (dev and prod) under an Org? The OIDC trust policy and CDK bootstrapping differ.

These will be resolved during the implementation plan.
