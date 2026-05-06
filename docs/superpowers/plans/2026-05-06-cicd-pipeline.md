# CI/CD Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the end-to-end CI/CD pipeline described in `docs/superpowers/specs/2026-05-06-cicd-pipeline-design.md` — Docker image on ECS Fargate, AWS CDK for infra, GitHub Actions with OIDC for CI/CD, dev → prod image promotion.

**Architecture:** Multi-stage Dockerfile builds one image used by all services. AWS CDK (TypeScript) lives in `infra/` and defines two stacks — `FitonStack-dev` and `FitonStack-prod` — sharing one stack class, parameterized by env config. GitHub Actions runs CI on PRs (no AWS access), auto-deploys `main` to `dev`, and promotes the same image to `prod` on manual workflow dispatch with reviewer approval. Migrations run as one-shot ECS tasks during CD before service redeploy.

**Tech Stack:** Node 20, TypeScript, Fastify, Docker, AWS ECS Fargate, AWS CDK v2, AWS Secrets Manager, Amazon ECR, GitHub Actions, GitHub OIDC.

**Decisions locked in (from spec §2):**

- Single AWS account (`dev` / `prod` separated by tags + IAM + resource naming).
- One Supabase project, two Postgres schemas (`app_dev`, `app`). Risk: shared auth.users pool — revisit before public launch.
- Greenfield assumed; Phase 0 verifies. Domain deferred — serve over the raw ALB DNS until decided.

---

## Phase 0 — Pre-flight

### Task 0.1: Verify local prerequisites and AWS access

**Files:** none (one-time setup)

- [ ] **Step 1: Verify required tools**

Run:

```bash
node --version          # expect v20.x
docker --version        # expect any modern Docker
aws --version           # expect aws-cli/2.x
aws sts get-caller-identity   # expect a non-error JSON response with the AWS account ID and IAM principal
```

Expected: all four commands print versions / a JSON identity. If `aws sts` fails, configure credentials (`aws configure` or `aws sso login`) before continuing.

- [ ] **Step 2: Note the AWS account ID and region**

Capture the output of `aws sts get-caller-identity --query Account --output text` — call this `$AWS_ACCOUNT_ID`.
Default region for this project: `us-east-1` (matches `src/config/env.ts:15`).

- [ ] **Step 3: Verify the account has no conflicting resources**

Run each command and visually scan for any resources whose names look like they could collide:

```bash
aws ecr describe-repositories --query 'repositories[].repositoryName' --output table
aws s3 ls
aws sqs list-queues
aws ecs list-clusters
aws elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName' --output table
aws iam list-open-id-connect-providers
```

Expected: either empty results, or names that clearly belong to other projects. Anything matching `fitonroom*` or `try-on*` needs to be flagged: decide per-resource whether to delete (greenfield) or have CDK import it (out of scope for this plan — file a follow-up).

- [ ] **Step 4: Document findings**

If anything was found in step 3, write a short note in your PR description listing what existed and how it was handled. If everything was clean, note "Verified greenfield AWS account."

No commit for this task — pure verification.

---

## Phase 1 — Dockerization

### Task 1.1: Add `.dockerignore`

**Files:**

- Create: `.dockerignore`

- [ ] **Step 1: Create .dockerignore**

Create `.dockerignore` at the repo root:

```text
node_modules
dist
.git
.github
.env
.env.*
*.log
coverage
test
spec
docs
.vscode
.idea
README.md
infra
```

- [ ] **Step 2: Commit**

```bash
git add .dockerignore
git commit -m "chore: add .dockerignore for container builds"
```

### Task 1.2: Add multi-stage Dockerfile

**Files:**

- Create: `Dockerfile`

- [ ] **Step 1: Create Dockerfile**

Create `Dockerfile` at the repo root:

```dockerfile
# syntax=docker/dockerfile:1.6

# Stage 1: build TS to JS
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: install prod deps only
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 3: runtime
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./

USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Build the image locally and verify it starts**

Run:

```bash
docker build -t fitonroom-be:local .
docker run --rm \
  -e DATABASE_URL='postgresql://invalid:invalid@localhost:5432/x' \
  -e SUPABASE_JWT_SECRET='dummy-must-be-long-enough-for-testing' \
  -e DEVICE_INSTALL_HASH_SECRET='dummy-secret-at-least-16-chars' \
  -e S3_RAW_BUCKET=raw \
  -e S3_RESULTS_BUCKET=results \
  -e SQS_TRY_ON_QUEUE_URL='https://sqs.us-east-1.amazonaws.com/0/x' \
  -p 4000:4000 \
  fitonroom-be:local &
sleep 3
curl -sf http://localhost:4000/health
docker ps -q --filter "ancestor=fitonroom-be:local" | xargs -r docker stop
```

Expected: `curl` returns `{"ok":true,"service":"fitonroom-be"}`. Container exits cleanly. (DB-touching routes will fail with the dummy DATABASE_URL — that's fine, we're only smoke-testing boot + `/health`.)

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat: add multi-stage Dockerfile for ECS Fargate runtime"
```

---

## Phase 2 — Worker entrypoint for Fargate

The existing `src/lambda/worker.ts` is event-driven (SQS → Lambda hands batches to a handler). On Fargate, the worker is a long-running process that polls SQS itself. We add a thin polling loop that reuses the existing handler logic from `src/workers/tryOnWorker.ts`.

### Task 2.1: Add SQS polling entrypoint

**Files:**

- Create: `src/workers/runWorker.ts`
- Test: `test/runWorker.test.ts`

- [ ] **Step 1: Read the existing worker logic**

Read `src/workers/tryOnWorker.ts` and `src/lambda/worker.ts` to understand the current handler signature. Confirm there is an exported function that processes one SQS message body (call it `processMessage` for the steps below — adjust the import name to whatever exists).

- [ ] **Step 2: Write the failing test**

Create `test/runWorker.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/client-sqs", () => {
  const send = vi.fn();
  return {
    SQSClient: vi.fn(() => ({ send })),
    ReceiveMessageCommand: vi.fn((input) => ({ __cmd: "Receive", input })),
    DeleteMessageCommand: vi.fn((input) => ({ __cmd: "Delete", input })),
    __send: send
  };
});

vi.mock("../src/workers/tryOnWorker", () => ({
  processMessage: vi.fn().mockResolvedValue(undefined)
}));

import { __send } from "@aws-sdk/client-sqs" as any;
import { runOnce } from "../src/workers/runWorker";
import { processMessage } from "../src/workers/tryOnWorker";

describe("runWorker.runOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes each received message and deletes it on success", async () => {
    (__send as any)
      .mockResolvedValueOnce({
        Messages: [
          { MessageId: "m1", ReceiptHandle: "r1", Body: '{"jobId":"j1"}' },
          { MessageId: "m2", ReceiptHandle: "r2", Body: '{"jobId":"j2"}' }
        ]
      });

    await runOnce({ queueUrl: "https://sqs/x" });

    expect(processMessage).toHaveBeenCalledTimes(2);
    // 1 ReceiveMessageCommand + 2 DeleteMessageCommand
    expect((__send as any)).toHaveBeenCalledTimes(3);
  });

  it("does NOT delete a message when processing throws", async () => {
    (__send as any).mockResolvedValueOnce({
      Messages: [{ MessageId: "m1", ReceiptHandle: "r1", Body: '{"jobId":"j1"}' }]
    });
    (processMessage as any).mockRejectedValueOnce(new Error("boom"));

    await runOnce({ queueUrl: "https://sqs/x" });

    // 1 ReceiveMessageCommand only — no DeleteMessageCommand
    expect((__send as any)).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `npm test -- test/runWorker.test.ts`
Expected: FAIL with module not found for `../src/workers/runWorker`.

- [ ] **Step 4: Implement the polling entrypoint**

Create `src/workers/runWorker.ts`:

```ts
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { processMessage } from "./tryOnWorker";
import { env } from "../config/env";

interface RunOptions {
  queueUrl: string;
  client?: SQSClient;
  waitTimeSeconds?: number;
  maxMessages?: number;
}

export async function runOnce(opts: RunOptions): Promise<void> {
  const client = opts.client ?? new SQSClient({ region: env.AWS_REGION });

  const received = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: opts.queueUrl,
      MaxNumberOfMessages: opts.maxMessages ?? 10,
      WaitTimeSeconds: opts.waitTimeSeconds ?? 20,
      VisibilityTimeout: 300
    })
  );

  const messages = received.Messages ?? [];
  for (const msg of messages) {
    if (!msg.Body || !msg.ReceiptHandle) continue;
    try {
      await processMessage({ body: msg.Body, messageId: msg.MessageId ?? "unknown" });
      await client.send(
        new DeleteMessageCommand({
          QueueUrl: opts.queueUrl,
          ReceiptHandle: msg.ReceiptHandle
        })
      );
    } catch (err) {
      console.error("worker.process_failed", { messageId: msg.MessageId, err });
      // Do NOT delete — let SQS visibility timeout return the message,
      // and the queue's redrive policy will eventually move it to the DLQ.
    }
  }
}

async function loop(): Promise<void> {
  const queueUrl = env.SQS_TRY_ON_QUEUE_URL;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runOnce({ queueUrl });
  }
}

if (require.main === module) {
  loop().catch((err) => {
    console.error("worker.fatal", err);
    process.exit(1);
  });
}
```

If the existing handler in `src/workers/tryOnWorker.ts` has a different signature than `processMessage({ body, messageId })`, adjust this file to match. Do not change `tryOnWorker.ts` itself in this task.

- [ ] **Step 5: Run test, verify it passes**

Run: `npm test -- test/runWorker.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 6: Verify the worker entry compiles in the production build**

Run: `npm run build && ls dist/workers/runWorker.js`
Expected: file exists.

- [ ] **Step 7: Commit**

```bash
git add src/workers/runWorker.ts test/runWorker.test.ts
git commit -m "feat(worker): add SQS polling entrypoint for Fargate runtime"
```

---

## Phase 3 — CDK app scaffolding

### Task 3.1: Initialize CDK project under `infra/`

**Files:**

- Create: `infra/package.json`, `infra/tsconfig.json`, `infra/cdk.json`, `infra/.gitignore`, `infra/bin/app.ts`, `infra/lib/config.ts`, `infra/lib/app-stack.ts`

- [ ] **Step 1: Create directory and package.json**

```bash
mkdir -p infra/bin infra/lib infra/test
```

Create `infra/package.json`:

```json
{
  "name": "fitonroom-infra",
  "version": "0.1.0",
  "private": true,
  "bin": {
    "infra": "bin/app.js"
  },
  "scripts": {
    "build": "tsc",
    "watch": "tsc -w",
    "test": "vitest run",
    "synth": "cdk synth",
    "diff": "cdk diff",
    "deploy": "cdk deploy"
  },
  "devDependencies": {
    "@types/node": "^22.10.6",
    "aws-cdk": "^2.170.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.7.3",
    "vitest": "^2.1.8"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.170.0",
    "constructs": "^10.4.2"
  }
}
```

- [ ] **Step 2: Create infra/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": false,
    "inlineSourceMap": true,
    "inlineSources": true,
    "experimentalDecorators": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["bin/**/*.ts", "lib/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist", "cdk.out"]
}
```

- [ ] **Step 3: Create infra/cdk.json**

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/app.ts",
  "watch": {
    "include": ["**"],
    "exclude": [
      "README.md",
      "cdk*.json",
      "**/*.d.ts",
      "**/*.js",
      "tsconfig.json",
      "package*.json",
      "yarn.lock",
      "node_modules"
    ]
  },
  "context": {
    "@aws-cdk/aws-iam:minimizePolicies": true,
    "@aws-cdk/core:enableStackNameDuplicates": "true",
    "aws-cdk:enableDiffNoFail": "true",
    "@aws-cdk/aws-lambda:recognizeVersionProps": true,
    "@aws-cdk/aws-ecs:arnFormatIncludesClusterName": true
  }
}
```

- [ ] **Step 4: Create infra/.gitignore**

```text
node_modules
dist
cdk.out
*.d.ts
*.js
!jest.config.js
.cdk.staging
```

- [ ] **Step 5: Install CDK deps**

Run:

```bash
cd infra && npm install && cd ..
```

Expected: install succeeds, `infra/node_modules` exists.

- [ ] **Step 6: Create stub bin/app.ts**

Create `infra/bin/app.ts`:

```ts
#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack";
import { devConfig, prodConfig } from "../lib/config";

const app = new cdk.App();

const imageTag = (app.node.tryGetContext("imageTag") as string | undefined) ?? "bootstrap";
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? "us-east-1";

new AppStack(app, "FitonStack-dev", {
  env: { account, region },
  config: devConfig,
  imageTag
});

new AppStack(app, "FitonStack-prod", {
  env: { account, region },
  config: prodConfig,
  imageTag
});
```

- [ ] **Step 7: Create stub lib/config.ts**

Create `infra/lib/config.ts`:

```ts
export interface EnvConfig {
  envName: "dev" | "prod";
  apiTaskCount: number;
  apiCpu: number;
  apiMemory: number;
  workerMin: number;
  workerMax: number;
  logRetentionDays: number;
  searchPath: string; // Postgres schema name for this env
  alarmEmail: string; // SNS subscription target
}

export const devConfig: EnvConfig = {
  envName: "dev",
  apiTaskCount: 1,
  apiCpu: 256,
  apiMemory: 512,
  workerMin: 0,
  workerMax: 2,
  logRetentionDays: 30,
  searchPath: "app_dev",
  alarmEmail: "REPLACE_WITH_DEV_ALARM_EMAIL@example.com"
};

export const prodConfig: EnvConfig = {
  envName: "prod",
  apiTaskCount: 2,
  apiCpu: 512,
  apiMemory: 1024,
  workerMin: 1,
  workerMax: 5,
  logRetentionDays: 90,
  searchPath: "app",
  alarmEmail: "REPLACE_WITH_PROD_ALARM_EMAIL@example.com"
};
```

The two `REPLACE_WITH_*` strings are environment configuration values the operator must set before first deploy — not placeholders in the implementation sense. Replace with real email addresses (or a shared inbox alias) before Phase 7.

- [ ] **Step 8: Create stub lib/app-stack.ts**

Create `infra/lib/app-stack.ts`:

```ts
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { EnvConfig } from "./config";

export interface AppStackProps extends cdk.StackProps {
  config: EnvConfig;
  imageTag: string;
}

export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add("Project", "fitonroom-be");
    cdk.Tags.of(this).add("Environment", props.config.envName);

    // Resources added in subsequent tasks.
  }
}
```

- [ ] **Step 9: Verify cdk synth runs (with empty stacks)**

Run:

```bash
cd infra && npx cdk synth FitonStack-dev > /dev/null && cd ..
```

Expected: command exits 0 with no errors. (You'll see a "Stack does not have any resources" message — fine.)

- [ ] **Step 10: Commit**

```bash
git add infra/
git commit -m "feat(infra): scaffold CDK app with dev/prod stack skeletons"
```

### Task 3.2: Add ECR repo to the stack

**Files:**

- Modify: `infra/lib/app-stack.ts`
- Test: `infra/test/app-stack.test.ts`

- [ ] **Step 1: Write failing CDK assertion test**

Create `infra/test/app-stack.test.ts`:

```ts
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, it, expect } from "vitest";
import { AppStack } from "../lib/app-stack";
import { devConfig } from "../lib/config";

function synth(): Template {
  const app = new cdk.App();
  const stack = new AppStack(app, "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
    config: devConfig,
    imageTag: "test-sha"
  });
  return Template.fromStack(stack);
}

describe("AppStack", () => {
  it("creates an ECR repository", () => {
    const t = synth();
    t.resourceCountIs("AWS::ECR::Repository", 1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL with "Expected 1 resources of type AWS::ECR::Repository, found 0."

- [ ] **Step 3: Add ECR repo to stack**

Edit `infra/lib/app-stack.ts`. After the tags, add:

```ts
import * as ecr from "aws-cdk-lib/aws-ecr";

// inside the constructor, after Tags.of(...).add(...):
this.ecrRepo = new ecr.Repository(this, "EcrRepo", {
  repositoryName: `fitonroom-be-${props.config.envName}`,
  imageScanOnPush: true,
  imageTagMutability: ecr.TagMutability.MUTABLE, // we move :*-latest tags
  lifecycleRules: [
    {
      description: "Expire untagged images after 7 days",
      maxImageAge: cdk.Duration.days(7),
      tagStatus: ecr.TagStatus.UNTAGGED
    },
    {
      description: "Keep last 30 tagged images",
      maxImageCount: 30,
      tagStatus: ecr.TagStatus.ANY
    }
  ],
  removalPolicy: cdk.RemovalPolicy.RETAIN
});

new cdk.CfnOutput(this, "EcrRepoUri", { value: this.ecrRepo.repositoryUri });
```

Also add `public readonly ecrRepo: ecr.Repository;` to the class body above the constructor.

- [ ] **Step 4: Run test, verify it passes**

Run: `cd infra && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/app-stack.ts infra/test/app-stack.test.ts
git commit -m "feat(infra): add per-env ECR repo with lifecycle policy"
```

### Task 3.3: Add Secrets Manager entry to the stack

**Files:**

- Modify: `infra/lib/app-stack.ts`, `infra/test/app-stack.test.ts`

- [ ] **Step 1: Add failing assertion**

Append to `infra/test/app-stack.test.ts`:

```ts
it("creates a Secrets Manager secret named fitonroom-be/<env>", () => {
  const t = synth();
  t.resourceCountIs("AWS::SecretsManager::Secret", 1);
  t.hasResourceProperties("AWS::SecretsManager::Secret", {
    Name: "fitonroom-be/dev"
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL with "Expected 1 resources of type AWS::SecretsManager::Secret".

- [ ] **Step 3: Add Secrets Manager construct**

In `infra/lib/app-stack.ts`, add the import and resource:

```ts
import * as sm from "aws-cdk-lib/aws-secretsmanager";

// add field
public readonly appSecret: sm.Secret;

// in constructor, after ecrRepo:
this.appSecret = new sm.Secret(this, "AppSecret", {
  secretName: `fitonroom-be/${props.config.envName}`,
  description: `App secrets for fitonroom-be ${props.config.envName}`,
  // Operator populates the value manually (or via AWS CLI) before first deploy.
  removalPolicy: cdk.RemovalPolicy.RETAIN
});

new cdk.CfnOutput(this, "AppSecretArn", { value: this.appSecret.secretArn });
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd infra && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/app-stack.ts infra/test/app-stack.test.ts
git commit -m "feat(infra): add Secrets Manager entry per env"
```

---

## Phase 4 — CDK networking + ECS cluster + queues

### Task 4.1: Look up default VPC and create security groups

**Files:**

- Modify: `infra/lib/app-stack.ts`, `infra/test/app-stack.test.ts`

- [ ] **Step 1: Add failing assertions**

Append to `infra/test/app-stack.test.ts`:

```ts
it("creates an ALB and 3 security groups (alb, service, migrate)", () => {
  const t = synth();
  t.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
  t.resourceCountIs("AWS::EC2::SecurityGroup", 3);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL.

- [ ] **Step 3: Add VPC lookup, ALB, and security groups**

In `infra/lib/app-stack.ts` add:

```ts
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";

// fields
public readonly vpc: ec2.IVpc;
public readonly alb: elbv2.ApplicationLoadBalancer;
public readonly serviceSG: ec2.SecurityGroup;
public readonly migrateSG: ec2.SecurityGroup;

// in constructor:
this.vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

const albSG = new ec2.SecurityGroup(this, "AlbSG", {
  vpc: this.vpc,
  description: "ALB ingress: HTTP only for MVP (no domain, no cert yet)",
  allowAllOutbound: true
});
albSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP from anywhere");

this.serviceSG = new ec2.SecurityGroup(this, "ServiceSG", {
  vpc: this.vpc,
  description: "Fargate services (api + worker)",
  allowAllOutbound: true
});
this.serviceSG.addIngressRule(albSG, ec2.Port.tcp(4000), "ALB to API container port");

this.migrateSG = new ec2.SecurityGroup(this, "MigrateSG", {
  vpc: this.vpc,
  description: "One-shot migration task",
  allowAllOutbound: true
});

this.alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
  vpc: this.vpc,
  internetFacing: true,
  securityGroup: albSG,
  loadBalancerName: `fitonroom-${props.config.envName}`
});

new cdk.CfnOutput(this, "AlbDnsName", { value: this.alb.loadBalancerDnsName });
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd infra && npx vitest run`
Expected: PASS.

CDK `Vpc.fromLookup` requires AWS credentials at synth time when called outside of unit tests. The test passes because we pass an explicit `env: { account, region }` and CDK uses dummy values during the test. Deploy will perform the real lookup.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/app-stack.ts infra/test/app-stack.test.ts
git commit -m "feat(infra): add default VPC lookup, ALB, and service security groups"
```

### Task 4.2: Add SQS try-on queue and DLQ

**Files:**

- Modify: `infra/lib/app-stack.ts`, `infra/test/app-stack.test.ts`

- [ ] **Step 1: Add failing assertion**

At the top of `infra/test/app-stack.test.ts`, ensure `Match` is imported from CDK:

```ts
import { Template, Match } from "aws-cdk-lib/assertions";
```

(replace the existing `import { Template }` line)

Append to test file:

```ts
it("creates 2 SQS queues (main + DLQ) with redrive", () => {
  const t = synth();
  t.resourceCountIs("AWS::SQS::Queue", 2);
  t.hasResourceProperties("AWS::SQS::Queue", {
    QueueName: "fitonroom-try-on-dev",
    RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 })
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL.

- [ ] **Step 3: Add SQS queues**

In `infra/lib/app-stack.ts`:

```ts
import * as sqs from "aws-cdk-lib/aws-sqs";

// fields
public readonly tryOnQueue: sqs.Queue;
public readonly tryOnDlq: sqs.Queue;

// in constructor:
this.tryOnDlq = new sqs.Queue(this, "TryOnDlq", {
  queueName: `fitonroom-try-on-dlq-${props.config.envName}`,
  retentionPeriod: cdk.Duration.days(14)
});

this.tryOnQueue = new sqs.Queue(this, "TryOnQueue", {
  queueName: `fitonroom-try-on-${props.config.envName}`,
  visibilityTimeout: cdk.Duration.minutes(15),
  deadLetterQueue: { queue: this.tryOnDlq, maxReceiveCount: 5 }
});

new cdk.CfnOutput(this, "TryOnQueueUrl", { value: this.tryOnQueue.queueUrl });
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd infra && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/app-stack.ts infra/test/app-stack.test.ts
git commit -m "feat(infra): add SQS try-on queue with DLQ redrive"
```

### Task 4.3: Add S3 buckets

**Files:**

- Modify: `infra/lib/app-stack.ts`, `infra/test/app-stack.test.ts`

- [ ] **Step 1: Add failing assertion**

```ts
it("creates 2 S3 buckets (raw + results)", () => {
  const t = synth();
  t.resourceCountIs("AWS::S3::Bucket", 2);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL.

- [ ] **Step 3: Add S3 buckets**

```ts
import * as s3 from "aws-cdk-lib/aws-s3";

public readonly rawBucket: s3.Bucket;
public readonly resultsBucket: s3.Bucket;

// in constructor:
this.rawBucket = new s3.Bucket(this, "RawBucket", {
  bucketName: `fitonroom-raw-${props.config.envName}-${this.account}`,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  versioned: false,
  lifecycleRules: [{
    id: "expire-raw-uploads",
    expiration: cdk.Duration.days(30)
  }],
  removalPolicy: cdk.RemovalPolicy.RETAIN
});

this.resultsBucket = new s3.Bucket(this, "ResultsBucket", {
  bucketName: `fitonroom-results-${props.config.envName}-${this.account}`,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  versioned: false,
  removalPolicy: cdk.RemovalPolicy.RETAIN
});

new cdk.CfnOutput(this, "RawBucketName", { value: this.rawBucket.bucketName });
new cdk.CfnOutput(this, "ResultsBucketName", { value: this.resultsBucket.bucketName });
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd infra && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/app-stack.ts infra/test/app-stack.test.ts
git commit -m "feat(infra): add raw + results S3 buckets"
```

### Task 4.4: Add ECS cluster + log groups

**Files:**

- Modify: `infra/lib/app-stack.ts`, `infra/test/app-stack.test.ts`

- [ ] **Step 1: Add failing assertion**

```ts
it("creates an ECS cluster with container insights enabled", () => {
  const t = synth();
  t.resourceCountIs("AWS::ECS::Cluster", 1);
  t.hasResourceProperties("AWS::ECS::Cluster", {
    ClusterSettings: [{ Name: "containerInsights", Value: "enabled" }]
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL.

- [ ] **Step 3: Add ECS cluster**

```ts
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from "aws-cdk-lib/aws-logs";

public readonly cluster: ecs.Cluster;
public readonly apiLogGroup: logs.LogGroup;
public readonly workerLogGroup: logs.LogGroup;
public readonly migrateLogGroup: logs.LogGroup;
public readonly cleanupLogGroup: logs.LogGroup;

// in constructor:
this.cluster = new ecs.Cluster(this, "Cluster", {
  clusterName: `fitonroom-${props.config.envName}`,
  vpc: this.vpc,
  containerInsights: true
});

const retention = props.config.logRetentionDays === 30
  ? logs.RetentionDays.ONE_MONTH
  : logs.RetentionDays.THREE_MONTHS;

this.apiLogGroup = new logs.LogGroup(this, "ApiLogs", {
  logGroupName: `/ecs/fitonroom-be/${props.config.envName}/api`,
  retention,
  removalPolicy: cdk.RemovalPolicy.DESTROY
});
this.workerLogGroup = new logs.LogGroup(this, "WorkerLogs", {
  logGroupName: `/ecs/fitonroom-be/${props.config.envName}/worker`,
  retention,
  removalPolicy: cdk.RemovalPolicy.DESTROY
});
this.migrateLogGroup = new logs.LogGroup(this, "MigrateLogs", {
  logGroupName: `/ecs/fitonroom-be/${props.config.envName}/migrate`,
  retention,
  removalPolicy: cdk.RemovalPolicy.DESTROY
});
this.cleanupLogGroup = new logs.LogGroup(this, "CleanupLogs", {
  logGroupName: `/ecs/fitonroom-be/${props.config.envName}/cleanup`,
  retention,
  removalPolicy: cdk.RemovalPolicy.DESTROY
});
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd infra && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/app-stack.ts infra/test/app-stack.test.ts
git commit -m "feat(infra): add ECS cluster with container insights and log groups"
```

---

## Phase 5 — CDK ECS services

### Task 5.1: Helper to build the shared task role and env mapping

**Files:**

- Modify: `infra/lib/app-stack.ts`

This task adds private methods that subsequent service tasks call. No assertion test needed; subsequent tests cover the resulting task definitions.

- [ ] **Step 1: Add the helper methods to the stack**

Add to `infra/lib/app-stack.ts` (inside the class, below the constructor):

```ts
import * as iam from "aws-cdk-lib/aws-iam";

private buildTaskRole(props: AppStackProps, suffix: string): iam.Role {
  const role = new iam.Role(this, `TaskRole${suffix}`, {
    assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com")
  });
  this.appSecret.grantRead(role);
  this.rawBucket.grantReadWrite(role);
  this.resultsBucket.grantReadWrite(role);
  this.tryOnQueue.grantSendMessages(role);
  this.tryOnQueue.grantConsumeMessages(role);
  return role;
}

private commonEnvironment(config: EnvConfig): Record<string, string> {
  return {
    NODE_ENV: "production",
    AWS_REGION: this.region,
    PORT: "4000",
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    S3_RAW_BUCKET: this.rawBucket.bucketName,
    S3_RESULTS_BUCKET: this.resultsBucket.bucketName,
    SQS_TRY_ON_QUEUE_URL: this.tryOnQueue.queueUrl,
    DB_SSL: "true",
    APP_DB_SCHEMA: config.searchPath
  };
}

private commonSecrets(): Record<string, ecs.Secret> {
  return {
    DATABASE_URL: ecs.Secret.fromSecretsManager(this.appSecret, "DATABASE_URL"),
    SUPABASE_JWT_SECRET: ecs.Secret.fromSecretsManager(this.appSecret, "SUPABASE_JWT_SECRET"),
    DEVICE_INSTALL_HASH_SECRET: ecs.Secret.fromSecretsManager(this.appSecret, "DEVICE_INSTALL_HASH_SECRET"),
    STRIPE_SECRET_KEY: ecs.Secret.fromSecretsManager(this.appSecret, "STRIPE_SECRET_KEY"),
    STRIPE_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(this.appSecret, "STRIPE_WEBHOOK_SECRET"),
    GENAI_TRY_ON_API_KEY: ecs.Secret.fromSecretsManager(this.appSecret, "GENAI_TRY_ON_API_KEY"),
    EXPO_PUSH_ACCESS_TOKEN: ecs.Secret.fromSecretsManager(this.appSecret, "EXPO_PUSH_ACCESS_TOKEN")
  };
}
```

The `APP_DB_SCHEMA` env var is read by the app to set Postgres `search_path` — see Task 5.2. Add `EXPO_PUSH_ACCESS_TOKEN` and other optional secrets only if their JSON keys actually exist in the secret value; if a key is missing, ECS task start will fail. The operator populates the secret in Phase 7, Task 7.2.

- [ ] **Step 2: Verify it still compiles**

Run: `cd infra && npx tsc --noEmit`
Expected: no TypeScript errors. (No test added; helpers are exercised in later tasks.)

- [ ] **Step 3: Commit**

```bash
git add infra/lib/app-stack.ts
git commit -m "feat(infra): add task role + env/secret helper methods"
```

### Task 5.2: Wire `APP_DB_SCHEMA` into the runtime

**Files:**

- Modify: `src/config/env.ts`, `src/db/index.ts`
- Test: `test/db-schema.test.ts`

The shared-Supabase-project + per-schema choice (spec §2 Q2) requires the app to set `search_path` on every connection.

- [ ] **Step 1: Write failing test**

Create `test/db-schema.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pg", () => {
  const onConnect = vi.fn();
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const Pool = vi.fn(() => ({
    on: (event: string, cb: any) => {
      if (event === "connect") onConnect(cb);
    },
    query,
    end: vi.fn()
  }));
  return { Pool, __onConnect: onConnect, __query: query };
});

describe("db pool sets search_path on each new connection", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.APP_DB_SCHEMA = "app_dev";
    process.env.DATABASE_URL = "postgresql://x:y@localhost:5432/z";
    process.env.SUPABASE_JWT_SECRET = "x".repeat(32);
    process.env.DEVICE_INSTALL_HASH_SECRET = "x".repeat(32);
    process.env.S3_RAW_BUCKET = "raw";
    process.env.S3_RESULTS_BUCKET = "results";
    process.env.SQS_TRY_ON_QUEUE_URL = "https://sqs/x";
  });

  it("registers a connect handler that issues SET search_path", async () => {
    const pg = await import("pg");
    await import("../src/db/index");
    expect((pg as any).__onConnect).toHaveBeenCalled();
    const cb = (pg as any).__onConnect.mock.calls[0][0];
    const fakeClient = { query: vi.fn() };
    await cb(fakeClient);
    expect(fakeClient.query).toHaveBeenCalledWith('SET search_path TO "app_dev", public');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- test/db-schema.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `APP_DB_SCHEMA` to env schema**

Edit `src/config/env.ts`. After line 20 (`SQS_TRY_ON_QUEUE_URL`), add:

```ts
  APP_DB_SCHEMA: z.string().default("public"),
```

- [ ] **Step 4: Update `src/db/index.ts` to set search_path on each connection**

Read `src/db/index.ts` first. Add a `pool.on("connect", ...)` handler that runs `SET search_path TO "<schema>", public` on every new client. The exact edit depends on how the pool is currently constructed; the handler form is:

```ts
import { env } from "../config/env";

// after `const pool = new Pool({ ... })`:
pool.on("connect", async (client) => {
  await client.query(`SET search_path TO "${env.APP_DB_SCHEMA}", public`);
});
```

If the schema name is interpolated, sanitize it: only allow `[A-Za-z_][A-Za-z0-9_]*`. Reject anything else with a thrown Error at module load. (Identifiers can't be parameterized in `SET search_path`.)

- [ ] **Step 5: Run test, verify it passes**

Run: `npm test -- test/db-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full test suite**

Run: `npm test && npm run typecheck`
Expected: all tests pass, typecheck clean. If existing tests break because `APP_DB_SCHEMA` is now expected, set it in `vitest` setup (or in the test that loads env).

- [ ] **Step 7: Commit**

```bash
git add src/config/env.ts src/db/index.ts test/db-schema.test.ts
git commit -m "feat(db): set Postgres search_path per env via APP_DB_SCHEMA"
```

### Task 5.3: Add API Fargate service behind ALB

**Files:**

- Modify: `infra/lib/app-stack.ts`, `infra/test/app-stack.test.ts`

- [ ] **Step 1: Add failing assertions**

```ts
it("creates an API Fargate service with target group on port 4000", () => {
  const t = synth();
  t.resourceCountIs("AWS::ECS::Service", 1); // worker added in 5.4 will bump this
  t.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
    Port: 4000,
    Protocol: "HTTP",
    HealthCheckPath: "/health"
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL.

- [ ] **Step 3: Add API service**

```ts
// in constructor, after helpers are usable:
const apiTaskDef = new ecs.FargateTaskDefinition(this, "ApiTaskDef", {
  cpu: props.config.apiCpu,
  memoryLimitMiB: props.config.apiMemory,
  taskRole: this.buildTaskRole(props, "Api")
});

apiTaskDef.addContainer("api", {
  containerName: "api",
  image: ecs.ContainerImage.fromEcrRepository(this.ecrRepo, props.imageTag),
  command: ["node", "dist/server.js"],
  environment: this.commonEnvironment(props.config),
  secrets: this.commonSecrets(),
  logging: ecs.LogDrivers.awsLogs({
    streamPrefix: "api",
    logGroup: this.apiLogGroup
  }),
  portMappings: [{ containerPort: 4000 }],
  essential: true
});

const apiService = new ecs.FargateService(this, "ApiService", {
  cluster: this.cluster,
  taskDefinition: apiTaskDef,
  desiredCount: props.config.apiTaskCount,
  securityGroups: [this.serviceSG],
  assignPublicIp: true, // default VPC public subnets, no NAT
  circuitBreaker: { rollback: true },
  minHealthyPercent: 50,
  maxHealthyPercent: 200
});

const listener = this.alb.addListener("HttpListener", {
  port: 80,
  protocol: elbv2.ApplicationProtocol.HTTP,
  open: true
});

listener.addTargets("ApiTargets", {
  port: 4000,
  protocol: elbv2.ApplicationProtocol.HTTP,
  targets: [apiService.loadBalancerTarget({ containerName: "api", containerPort: 4000 })],
  healthCheck: {
    path: "/health",
    healthyHttpCodes: "200",
    interval: cdk.Duration.seconds(15),
    timeout: cdk.Duration.seconds(5)
  },
  deregistrationDelay: cdk.Duration.seconds(15)
});
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd infra && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/app-stack.ts infra/test/app-stack.test.ts
git commit -m "feat(infra): add API Fargate service behind ALB"
```

### Task 5.4: Add worker Fargate service with SQS-based autoscaling

**Files:**

- Modify: `infra/lib/app-stack.ts`, `infra/test/app-stack.test.ts`

- [ ] **Step 1: Update the assertion to expect 2 services**

Change the API service assertion in `app-stack.test.ts` from `t.resourceCountIs("AWS::ECS::Service", 1)` to `t.resourceCountIs("AWS::ECS::Service", 2)`.

Add new assertion:

```ts
it("creates a worker service with target tracking on SQS queue depth", () => {
  const t = synth();
  t.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 1);
  t.resourceCountIs("AWS::ApplicationAutoScaling::ScalingPolicy", 1);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL.

- [ ] **Step 3: Add worker service**

```ts
const workerTaskDef = new ecs.FargateTaskDefinition(this, "WorkerTaskDef", {
  cpu: 512,
  memoryLimitMiB: 1024,
  taskRole: this.buildTaskRole(props, "Worker")
});

workerTaskDef.addContainer("worker", {
  containerName: "worker",
  image: ecs.ContainerImage.fromEcrRepository(this.ecrRepo, props.imageTag),
  command: ["node", "dist/workers/runWorker.js"],
  environment: this.commonEnvironment(props.config),
  secrets: this.commonSecrets(),
  logging: ecs.LogDrivers.awsLogs({
    streamPrefix: "worker",
    logGroup: this.workerLogGroup
  }),
  essential: true
});

const workerService = new ecs.FargateService(this, "WorkerService", {
  cluster: this.cluster,
  taskDefinition: workerTaskDef,
  desiredCount: props.config.workerMin,
  securityGroups: [this.serviceSG],
  assignPublicIp: true,
  circuitBreaker: { rollback: true }
});

const scaling = workerService.autoScaleTaskCount({
  minCapacity: props.config.workerMin,
  maxCapacity: props.config.workerMax
});

// Scale based on backlog per task. CloudWatch math: messages_visible / running_task_count.
// Simpler approach for MVP: target a fixed messages-visible threshold.
import * as cw from "aws-cdk-lib/aws-cloudwatch"; // ensure import is added at top of file
scaling.scaleOnMetric("ScaleOnQueueDepth", {
  metric: this.tryOnQueue.metricApproximateNumberOfMessagesVisible({
    period: cdk.Duration.minutes(1),
    statistic: "Average"
  }),
  scalingSteps: [
    { upper: 0, change: -1 }, // queue empty: scale in
    { lower: 5, change: +1 }, // 5+ messages: add a task
    { lower: 20, change: +2 } // 20+: add two
  ],
  cooldown: cdk.Duration.seconds(60),
  adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY
});
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd infra && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/app-stack.ts infra/test/app-stack.test.ts
git commit -m "feat(infra): add worker Fargate service with SQS-depth autoscaling"
```

### Task 5.5: Add migration task definition

**Files:**

- Modify: `infra/lib/app-stack.ts`, `infra/test/app-stack.test.ts`

- [ ] **Step 1: Add failing assertion**

```ts
it("creates a one-shot migration task definition", () => {
  const t = synth();
  // 3 task definitions: api, worker, migrate
  t.resourceCountIs("AWS::ECS::TaskDefinition", 3);
  t.hasResourceProperties("AWS::ECS::TaskDefinition", {
    Family: "fitonroom-be-migrate-dev"
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL.

- [ ] **Step 3: Add migration task definition**

```ts
const migrateTaskDef = new ecs.FargateTaskDefinition(this, "MigrateTaskDef", {
  family: `fitonroom-be-migrate-${props.config.envName}`,
  cpu: 256,
  memoryLimitMiB: 512,
  taskRole: this.buildTaskRole(props, "Migrate")
});

migrateTaskDef.addContainer("migrate", {
  containerName: "migrate",
  image: ecs.ContainerImage.fromEcrRepository(this.ecrRepo, props.imageTag),
  command: ["node", "dist/db/migrate.js"],
  environment: this.commonEnvironment(props.config),
  secrets: this.commonSecrets(),
  logging: ecs.LogDrivers.awsLogs({
    streamPrefix: "migrate",
    logGroup: this.migrateLogGroup
  }),
  essential: true
});

new cdk.CfnOutput(this, "MigrateTaskDefArn", { value: migrateTaskDef.taskDefinitionArn });
new cdk.CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
new cdk.CfnOutput(this, "ServiceSGId", { value: this.serviceSG.securityGroupId });
new cdk.CfnOutput(this, "VpcSubnets", {
  value: cdk.Fn.join(
    ",",
    this.vpc.publicSubnets.map((s) => s.subnetId)
  )
});
```

These outputs are needed by the GitHub Actions workflow to invoke `aws ecs run-task`.

- [ ] **Step 4: Run test, verify it passes**

Run: `cd infra && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/app-stack.ts infra/test/app-stack.test.ts
git commit -m "feat(infra): add one-shot migration task definition"
```

### Task 5.6: Add cleanup scheduled task

**Files:**

- Modify: `infra/lib/app-stack.ts`, `infra/test/app-stack.test.ts`

- [ ] **Step 1: Add failing assertion**

```ts
it("creates an EventBridge schedule for cleanup", () => {
  const t = synth();
  t.resourceCountIs("AWS::Events::Rule", 1);
  t.resourceCountIs("AWS::ECS::TaskDefinition", 4); // api, worker, migrate, cleanup
});
```

Update earlier assertion `AWS::ECS::TaskDefinition` count from 3 to 4 if it appears elsewhere.

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL.

- [ ] **Step 3: Add cleanup task and schedule**

```ts
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";

const cleanupTaskDef = new ecs.FargateTaskDefinition(this, "CleanupTaskDef", {
  family: `fitonroom-be-cleanup-${props.config.envName}`,
  cpu: 256,
  memoryLimitMiB: 512,
  taskRole: this.buildTaskRole(props, "Cleanup")
});

cleanupTaskDef.addContainer("cleanup", {
  containerName: "cleanup",
  image: ecs.ContainerImage.fromEcrRepository(this.ecrRepo, props.imageTag),
  command: ["node", "dist/lambda/cleanup.js"],
  environment: this.commonEnvironment(props.config),
  secrets: this.commonSecrets(),
  logging: ecs.LogDrivers.awsLogs({
    streamPrefix: "cleanup",
    logGroup: this.cleanupLogGroup
  }),
  essential: true
});

new events.Rule(this, "CleanupSchedule", {
  ruleName: `fitonroom-cleanup-${props.config.envName}`,
  description: "Daily cleanup task for fitonroom-be",
  schedule: events.Schedule.cron({ minute: "0", hour: "8" }), // 08:00 UTC daily
  targets: [
    new targets.EcsTask({
      cluster: this.cluster,
      taskDefinition: cleanupTaskDef,
      subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      securityGroups: [this.serviceSG]
    })
  ]
});
```

The cleanup entry currently lives in `src/lambda/cleanup.ts` and is shaped for Lambda. If it needs adaptation to run as a one-shot Node process, that adaptation goes here as a small refactor (similar to what Task 2.1 did for the worker). If `src/lambda/cleanup.ts` is already a self-contained `if (require.main === module)` script that runs and exits, no changes needed.

Verify by reading `src/lambda/cleanup.ts`. If it exports a Lambda handler only, add at the bottom:

```ts
if (require.main === module) {
  handler({} as any, {} as any)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("cleanup.fatal", e);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd infra && npx vitest run && npm run build` (root, to verify cleanup.ts compiles)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/app-stack.ts infra/test/app-stack.test.ts src/lambda/cleanup.ts
git commit -m "feat(infra): add daily cleanup ECS scheduled task"
```

---

## Phase 6 — Observability + GitHub OIDC deploy role

### Task 6.1: Add CloudWatch alarms and SNS topic

**Files:**

- Modify: `infra/lib/app-stack.ts`, `infra/test/app-stack.test.ts`

- [ ] **Step 1: Add failing assertions**

```ts
it("creates SNS alarm topic and 4 alarms", () => {
  const t = synth();
  t.resourceCountIs("AWS::SNS::Topic", 1);
  t.resourceCountIs("AWS::CloudWatch::Alarm", 4);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL.

- [ ] **Step 3: Add alarms**

```ts
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";

const alarmTopic = new sns.Topic(this, "AlarmTopic", {
  topicName: `fitonroom-alarms-${props.config.envName}`,
  displayName: `Fiton Room ${props.config.envName} alarms`
});
alarmTopic.addSubscription(new snsSubs.EmailSubscription(props.config.alarmEmail));
const alarmAction = new cwActions.SnsAction(alarmTopic);

new cw.Alarm(this, "Alb5xxAlarm", {
  alarmName: `fitonroom-${props.config.envName}-alb-5xx`,
  metric: this.alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
    period: cdk.Duration.minutes(5),
    statistic: "Sum"
  }),
  threshold: 5,
  evaluationPeriods: 1,
  treatMissingData: cw.TreatMissingData.NOT_BREACHING
}).addAlarmAction(alarmAction);

new cw.Alarm(this, "ApiTaskCountAlarm", {
  alarmName: `fitonroom-${props.config.envName}-api-tasks-low`,
  metric: apiService.metric("RunningTaskCount", { statistic: "Average" }),
  threshold: props.config.apiTaskCount,
  comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
  evaluationPeriods: 5,
  treatMissingData: cw.TreatMissingData.BREACHING
}).addAlarmAction(alarmAction);

new cw.Alarm(this, "QueueDepthAlarm", {
  alarmName: `fitonroom-${props.config.envName}-queue-deep`,
  metric: this.tryOnQueue.metricApproximateNumberOfMessagesVisible({
    period: cdk.Duration.minutes(5),
    statistic: "Average"
  }),
  threshold: 100,
  evaluationPeriods: 3
}).addAlarmAction(alarmAction);

new cw.Alarm(this, "DlqAlarm", {
  alarmName: `fitonroom-${props.config.envName}-dlq-nonzero`,
  metric: this.tryOnDlq.metricApproximateNumberOfMessagesVisible({
    period: cdk.Duration.minutes(1),
    statistic: "Maximum"
  }),
  threshold: 0,
  comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
  evaluationPeriods: 1,
  treatMissingData: cw.TreatMissingData.NOT_BREACHING
}).addAlarmAction(alarmAction);
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd infra && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/app-stack.ts infra/test/app-stack.test.ts
git commit -m "feat(infra): add SNS alarm topic and 4 baseline alarms"
```

### Task 6.2: Add GitHub OIDC provider and deploy role

**Files:**

- Create: `infra/lib/oidc-stack.ts`
- Modify: `infra/bin/app.ts`
- Test: `infra/test/oidc-stack.test.ts`

We put the OIDC provider + deploy roles in a separate stack because the OIDC provider is account-wide (one resource regardless of env) and the deploy roles need to exist _before_ the first CD run that itself deploys the app stack.

- [ ] **Step 1: Write failing test**

Create `infra/test/oidc-stack.test.ts`:

```ts
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import { OidcStack } from "../lib/oidc-stack";

describe("OidcStack", () => {
  it("creates 1 OIDC provider and 2 deploy roles", () => {
    const app = new cdk.App();
    const stack = new OidcStack(app, "OidcStack", {
      env: { account: "123456789012", region: "us-east-1" },
      githubOrg: "Himaw",
      githubRepo: "fitonroom-be"
    });
    const t = Template.fromStack(stack);
    t.resourceCountIs("AWS::IAM::OIDCProvider", 1);
    t.resourceCountIs("AWS::IAM::Role", 2);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd infra && npx vitest run`
Expected: FAIL.

- [ ] **Step 3: Create OidcStack**

Create `infra/lib/oidc-stack.ts`:

```ts
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface OidcStackProps extends cdk.StackProps {
  githubOrg: string;
  githubRepo: string;
}

export class OidcStack extends cdk.Stack {
  public readonly devRole: iam.Role;
  public readonly prodRole: iam.Role;

  constructor(scope: Construct, id: string, props: OidcStackProps) {
    super(scope, id, props);

    const provider = new iam.OpenIdConnectProvider(this, "GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"]
    });

    const repoRef = `repo:${props.githubOrg}/${props.githubRepo}`;

    this.devRole = this.makeDeployRole("DeployDevRole", "fitonroom-be-deploy-dev", provider, [
      `${repoRef}:ref:refs/heads/main`,
      `${repoRef}:pull_request`
    ]);

    this.prodRole = this.makeDeployRole("DeployProdRole", "fitonroom-be-deploy-prod", provider, [
      `${repoRef}:environment:prod`
    ]);

    new cdk.CfnOutput(this, "DeployDevRoleArn", { value: this.devRole.roleArn });
    new cdk.CfnOutput(this, "DeployProdRoleArn", { value: this.prodRole.roleArn });
  }

  private makeDeployRole(
    id: string,
    name: string,
    provider: iam.IOpenIdConnectProvider,
    subjectAllowList: string[]
  ): iam.Role {
    const role = new iam.Role(this, id, {
      roleName: name,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        StringLike: { "token.actions.githubusercontent.com:sub": subjectAllowList }
      }),
      maxSessionDuration: cdk.Duration.hours(1)
    });

    // CDK deploy needs broad permissions; lock down further once the deploy works.
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("PowerUserAccess"));
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:*"],
        resources: ["*"]
      })
    );

    return role;
  }
}
```

The PowerUserAccess + iam:\* combo is intentionally permissive for the first deploy. Phase 7 includes a tightening step.

- [ ] **Step 4: Wire it into bin/app.ts**

Edit `infra/bin/app.ts`. After the existing AppStack instantiations:

```ts
import { OidcStack } from "../lib/oidc-stack";

new OidcStack(app, "FitonOidc", {
  env: { account, region },
  githubOrg: "Himaw",
  githubRepo: "fitonroom-be"
});
```

- [ ] **Step 5: Run tests**

Run: `cd infra && npx vitest run`
Expected: all tests pass, including new OidcStack test.

- [ ] **Step 6: Commit**

```bash
git add infra/lib/oidc-stack.ts infra/bin/app.ts infra/test/oidc-stack.test.ts
git commit -m "feat(infra): add GitHub OIDC provider and dev/prod deploy roles"
```

---

## Phase 7 — First manual deploy to dev

This phase is one-time bootstrap. Done by an operator with AWS admin access from their laptop, not from CI.

### Task 7.1: Bootstrap CDK in the AWS account

- [ ] **Step 1: Install CDK CLI globally if needed**

Run: `npx aws-cdk --version`
Expected: prints version.

- [ ] **Step 2: Run cdk bootstrap**

Run:

```bash
cd infra
npx cdk bootstrap aws://$AWS_ACCOUNT_ID/us-east-1
cd ..
```

Expected: creates the `CDKToolkit` stack in CloudFormation (S3 staging bucket + ECR repo for assets + roles). Takes ~2 minutes.

### Task 7.2: Create and populate the Secrets Manager entry for dev

This must happen _before_ deploying the app stack, because Fargate task starts read these secrets.

- [ ] **Step 1: Deploy only the OIDC stack first (it has no secret dependency)**

Run:

```bash
cd infra
npx cdk deploy FitonOidc --require-approval never
cd ..
```

Expected: OIDC provider + 2 deploy roles created. Note the `DeployDevRoleArn` and `DeployProdRoleArn` outputs.

- [ ] **Step 2: Deploy the dev stack to create the Secret resource (it will be empty)**

Run:

```bash
cd infra
npx cdk deploy FitonStack-dev --context imageTag=bootstrap --require-approval never
cd ..
```

This will fail ECS service stabilization because the image tag `bootstrap` doesn't exist in ECR yet, but Secrets Manager and the network resources will be created. **That's expected**. Wait for the failure, capture the secret ARN from the `AppSecretArn` output (or look it up via console), and proceed to step 3.

- [ ] **Step 3: Populate the secret value**

Run (replace placeholders with real values, then run; do not commit the values):

```bash
aws secretsmanager put-secret-value \
  --secret-id fitonroom-be/dev \
  --secret-string '{
    "DATABASE_URL": "postgresql://user:pass@host:5432/db?sslmode=require",
    "SUPABASE_JWT_SECRET": "...",
    "DEVICE_INSTALL_HASH_SECRET": "...",
    "STRIPE_SECRET_KEY": "",
    "STRIPE_WEBHOOK_SECRET": "",
    "GENAI_TRY_ON_API_KEY": "",
    "EXPO_PUSH_ACCESS_TOKEN": ""
  }'
```

Expected: returns `VersionId`. The empty strings for not-yet-used secrets are fine because `src/config/env.ts` declares them optional.

### Task 7.3: Build and push the first image, then re-deploy

- [ ] **Step 1: Log in to ECR**

```bash
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com
```

- [ ] **Step 2: Build and push image**

```bash
SHA=$(git rev-parse --short HEAD)
ECR_URI=$AWS_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/fitonroom-be-dev
docker build -t $ECR_URI:dev-$SHA .
docker push $ECR_URI:dev-$SHA
docker tag $ECR_URI:dev-$SHA $ECR_URI:dev-latest
docker push $ECR_URI:dev-latest
```

- [ ] **Step 3: Deploy with the real image tag**

```bash
cd infra
npx cdk deploy FitonStack-dev --context imageTag=dev-$SHA --require-approval never
cd ..
```

Expected: full stack deploys. ECS services start. ALB health check goes green within ~5 minutes.

- [ ] **Step 4: Run migration manually**

Capture outputs:

```bash
CLUSTER=$(aws cloudformation describe-stacks --stack-name FitonStack-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`ClusterName`].OutputValue' --output text)
SUBNETS=$(aws cloudformation describe-stacks --stack-name FitonStack-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`VpcSubnets`].OutputValue' --output text)
SG=$(aws cloudformation describe-stacks --stack-name FitonStack-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`ServiceSGId`].OutputValue' --output text)

aws ecs run-task \
  --cluster $CLUSTER \
  --task-definition fitonroom-be-migrate-dev \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$(echo $SUBNETS | tr ',' ' ' | awk '{print "\""$1"\",\""$2"\""}')],securityGroups=[\"$SG\"],assignPublicIp=ENABLED}"
```

Watch the task in the ECS console or via `aws ecs describe-tasks` until it exits 0. Tail logs in CloudWatch under `/ecs/fitonroom-be/dev/migrate`.

- [ ] **Step 5: Smoke test**

```bash
ALB=$(aws cloudformation describe-stacks --stack-name FitonStack-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`AlbDnsName`].OutputValue' --output text)
curl -v http://$ALB/health
```

Expected: `HTTP/1.1 200 OK` and body `{"ok":true,"service":"fitonroom-be"}`.

- [ ] **Step 6: Commit (only if any code changed during this phase)**

If nothing changed in code (most likely outcome), no commit. If you adjusted CDK to fix a deploy error, commit those fixes:

```bash
git add -p
git commit -m "fix(infra): adjust X for first deploy"
```

---

## Phase 8 — GitHub Actions workflows

### Task 8.1: Configure GitHub Environments

Manual step in the GitHub UI. No commit.

- [ ] **Step 1: Create the `dev` Environment**

In GitHub → Settings → Environments → New environment → name `dev`. No protection rules.

- [ ] **Step 2: Create the `prod` Environment**

In GitHub → Settings → Environments → New environment → name `prod`. Add protection rule: required reviewers (yourself + at least one other person).

- [ ] **Step 3: Add repository variables**

In GitHub → Settings → Secrets and variables → Actions → Variables tab:

- `AWS_REGION` = `us-east-1`
- `AWS_ACCOUNT_ID` = (the account ID from Phase 0)
- `DEPLOY_DEV_ROLE_ARN` = the `DeployDevRoleArn` output from Task 7.2
- `DEPLOY_PROD_ROLE_ARN` = the `DeployProdRoleArn` output from Task 7.2
- `ECR_REPO_DEV` = `fitonroom-be-dev`
- `ECR_REPO_PROD` = `fitonroom-be-prod`

### Task 8.2: Add CI workflow

**Files:**

- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create ci.yml**

```yaml
name: CI

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  app-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - name: Verify Docker build
        run: docker build -t fitonroom-be:ci-${{ github.sha }} .

  infra-checks:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: infra/package-lock.json
      - run: npm ci
      - run: npx vitest run
      - name: cdk synth
        run: npx cdk synth --quiet
        env:
          # cdk synth needs an account ID for VPC lookups; use a dummy.
          # Real lookups happen at deploy time using OIDC creds.
          CDK_DEFAULT_ACCOUNT: "000000000000"
          CDK_DEFAULT_REGION: us-east-1
```

The `infra-checks` job runs `cdk synth` against a dummy account ID. `Vpc.fromLookup` returns a stub at synth time when no real account is configured — that's fine for syntactic validation.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add PR validation workflow (typecheck, test, docker build, cdk synth)"
```

### Task 8.3: Add deploy-dev workflow

**Files:**

- Create: `.github/workflows/deploy-dev.yml`

- [ ] **Step 1: Create deploy-dev.yml**

```yaml
name: Deploy dev

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write # required for OIDC

env:
  AWS_REGION: ${{ vars.AWS_REGION }}
  AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
  ECR_REPO: ${{ vars.ECR_REPO_DEV }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: dev
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - run: npm ci
      - run: npm run typecheck
      - run: npm test

      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.DEPLOY_DEV_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        run: |
          aws ecr get-login-password --region $AWS_REGION | \
            docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

      - name: Build and push image
        run: |
          IMAGE_TAG=dev-${{ github.sha }}
          ECR_URI=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO
          docker build -t $ECR_URI:$IMAGE_TAG .
          docker push $ECR_URI:$IMAGE_TAG
          docker tag $ECR_URI:$IMAGE_TAG $ECR_URI:dev-latest
          docker push $ECR_URI:dev-latest
          echo "IMAGE_TAG=$IMAGE_TAG" >> $GITHUB_ENV

      - name: Install infra deps
        working-directory: infra
        run: npm ci

      - name: CDK deploy
        working-directory: infra
        run: npx cdk deploy FitonStack-dev --context imageTag=$IMAGE_TAG --require-approval never

      - name: Run migration as one-shot ECS task
        run: |
          CLUSTER=$(aws cloudformation describe-stacks --stack-name FitonStack-dev \
            --query 'Stacks[0].Outputs[?OutputKey==`ClusterName`].OutputValue' --output text)
          SUBNETS=$(aws cloudformation describe-stacks --stack-name FitonStack-dev \
            --query 'Stacks[0].Outputs[?OutputKey==`VpcSubnets`].OutputValue' --output text)
          SG=$(aws cloudformation describe-stacks --stack-name FitonStack-dev \
            --query 'Stacks[0].Outputs[?OutputKey==`ServiceSGId`].OutputValue' --output text)

          SUBNET_ARGS=$(echo $SUBNETS | awk -F, '{ for (i=1;i<=NF;i++) printf "\"%s\",", $i }' | sed 's/,$//')

          TASK_ARN=$(aws ecs run-task \
            --cluster $CLUSTER \
            --task-definition fitonroom-be-migrate-dev \
            --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ARGS],securityGroups=[\"$SG\"],assignPublicIp=ENABLED}" \
            --query 'tasks[0].taskArn' --output text)

          echo "Migration task: $TASK_ARN"
          aws ecs wait tasks-stopped --cluster $CLUSTER --tasks $TASK_ARN

          EXIT_CODE=$(aws ecs describe-tasks --cluster $CLUSTER --tasks $TASK_ARN \
            --query 'tasks[0].containers[0].exitCode' --output text)

          if [ "$EXIT_CODE" != "0" ]; then
            echo "Migration failed with exit code $EXIT_CODE"
            exit 1
          fi
          echo "Migration succeeded"

      - name: Wait for ECS services to stabilize
        run: |
          CLUSTER=$(aws cloudformation describe-stacks --stack-name FitonStack-dev \
            --query 'Stacks[0].Outputs[?OutputKey==`ClusterName`].OutputValue' --output text)
          aws ecs wait services-stable \
            --cluster $CLUSTER \
            --services $(aws ecs list-services --cluster $CLUSTER --query 'serviceArns' --output text)

      - name: Smoke test
        run: |
          ALB=$(aws cloudformation describe-stacks --stack-name FitonStack-dev \
            --query 'Stacks[0].Outputs[?OutputKey==`AlbDnsName`].OutputValue' --output text)
          curl --fail --max-time 10 --retry 5 --retry-delay 5 http://$ALB/health
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy-dev.yml
git commit -m "ci: add auto-deploy to dev on merge to main"
```

### Task 8.4: Add deploy-prod workflow

**Files:**

- Create: `.github/workflows/deploy-prod.yml`

- [ ] **Step 1: Create deploy-prod.yml**

```yaml
name: Deploy prod

on:
  workflow_dispatch:
    inputs:
      imageTag:
        description: "Dev image tag to promote (e.g. dev-abc1234)"
        required: true
        default: "dev-latest"

permissions:
  contents: read
  id-token: write

env:
  AWS_REGION: ${{ vars.AWS_REGION }}
  AWS_ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
  DEV_REPO: ${{ vars.ECR_REPO_DEV }}
  PROD_REPO: ${{ vars.ECR_REPO_PROD }}

jobs:
  promote:
    runs-on: ubuntu-latest
    environment: prod # required reviewers gate
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.DEPLOY_PROD_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        run: |
          aws ecr get-login-password --region $AWS_REGION | \
            docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

      - name: Re-tag dev image as prod
        run: |
          INPUT_TAG="${{ github.event.inputs.imageTag }}"
          # Convert dev-<sha> to prod-<sha> if the input starts with "dev-"
          if [[ "$INPUT_TAG" == dev-* ]]; then
            PROD_TAG="prod-${INPUT_TAG#dev-}"
          else
            PROD_TAG="prod-${INPUT_TAG}"
          fi

          DEV_URI=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$DEV_REPO
          PROD_URI=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$PROD_REPO

          docker pull $DEV_URI:$INPUT_TAG
          docker tag $DEV_URI:$INPUT_TAG $PROD_URI:$PROD_TAG
          docker tag $DEV_URI:$INPUT_TAG $PROD_URI:prod-latest
          docker push $PROD_URI:$PROD_TAG
          docker push $PROD_URI:prod-latest
          echo "IMAGE_TAG=$PROD_TAG" >> $GITHUB_ENV

      - name: Install infra deps
        working-directory: infra
        run: npm ci

      - name: CDK deploy
        working-directory: infra
        run: npx cdk deploy FitonStack-prod --context imageTag=$IMAGE_TAG --require-approval never

      - name: Run migration as one-shot ECS task
        run: |
          CLUSTER=$(aws cloudformation describe-stacks --stack-name FitonStack-prod \
            --query 'Stacks[0].Outputs[?OutputKey==`ClusterName`].OutputValue' --output text)
          SUBNETS=$(aws cloudformation describe-stacks --stack-name FitonStack-prod \
            --query 'Stacks[0].Outputs[?OutputKey==`VpcSubnets`].OutputValue' --output text)
          SG=$(aws cloudformation describe-stacks --stack-name FitonStack-prod \
            --query 'Stacks[0].Outputs[?OutputKey==`ServiceSGId`].OutputValue' --output text)

          SUBNET_ARGS=$(echo $SUBNETS | awk -F, '{ for (i=1;i<=NF;i++) printf "\"%s\",", $i }' | sed 's/,$//')

          TASK_ARN=$(aws ecs run-task \
            --cluster $CLUSTER \
            --task-definition fitonroom-be-migrate-prod \
            --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ARGS],securityGroups=[\"$SG\"],assignPublicIp=ENABLED}" \
            --query 'tasks[0].taskArn' --output text)

          aws ecs wait tasks-stopped --cluster $CLUSTER --tasks $TASK_ARN
          EXIT_CODE=$(aws ecs describe-tasks --cluster $CLUSTER --tasks $TASK_ARN \
            --query 'tasks[0].containers[0].exitCode' --output text)
          if [ "$EXIT_CODE" != "0" ]; then
            echo "Migration failed with exit code $EXIT_CODE"
            exit 1
          fi

      - name: Wait for ECS services to stabilize
        run: |
          CLUSTER=$(aws cloudformation describe-stacks --stack-name FitonStack-prod \
            --query 'Stacks[0].Outputs[?OutputKey==`ClusterName`].OutputValue' --output text)
          aws ecs wait services-stable \
            --cluster $CLUSTER \
            --services $(aws ecs list-services --cluster $CLUSTER --query 'serviceArns' --output text)

      - name: Smoke test
        run: |
          ALB=$(aws cloudformation describe-stacks --stack-name FitonStack-prod \
            --query 'Stacks[0].Outputs[?OutputKey==`AlbDnsName`].OutputValue' --output text)
          curl --fail --max-time 10 --retry 5 --retry-delay 5 http://$ALB/health
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy-prod.yml
git commit -m "ci: add manual prod promotion workflow with reviewer approval"
```

---

## Phase 9 — End-to-end validation

### Task 9.1: Validate CI runs on a no-op PR

- [ ] **Step 1: Open a trivial PR**

```bash
git checkout -b ci-validation
echo "" >> README.md
git add README.md
git commit -m "test: trigger CI"
git push -u origin ci-validation
```

Open the PR in GitHub.

- [ ] **Step 2: Verify CI**

Expected: both `app-checks` and `infra-checks` jobs run and pass.

- [ ] **Step 3: Close the PR (do not merge)**

Use the GitHub UI. Delete the branch.

### Task 9.2: Validate dev CD on merge to main

- [ ] **Step 1: Open a real PR with prior commits**

The earlier commits in this plan (Dockerfile, infra, etc.) form your real first PR. Open it against `main`.

- [ ] **Step 2: Verify CI passes, merge**

Squash-merge to main.

- [ ] **Step 3: Watch deploy-dev workflow run**

Expected: workflow runs to completion. ECS services on dev cluster updated. Smoke test passes. The change is live in dev.

- [ ] **Step 4: Verify the live API**

```bash
ALB=<dev ALB DNS from CloudFormation outputs>
curl http://$ALB/health
# expect 200 OK
```

### Task 9.3: Validate prod promotion

- [ ] **Step 1: Bootstrap prod stack manually first**

Same procedure as Task 7.2 but for prod:

```bash
# Create + populate prod secret
aws secretsmanager create-secret --name fitonroom-be/prod \
  --secret-string '{ ... real prod values ... }'
# (the CDK stack also defines the secret; if create-secret fails because CDK already created it, use put-secret-value instead)

# Re-tag the dev image as the first prod image (manually, this once)
SHA=$(git rev-parse --short HEAD)
docker pull $AWS_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/fitonroom-be-dev:dev-$SHA
docker tag ...:dev-$SHA ...:fitonroom-be-prod:prod-$SHA
docker push ...:fitonroom-be-prod:prod-$SHA

cd infra && npx cdk deploy FitonStack-prod --context imageTag=prod-$SHA --require-approval never
```

- [ ] **Step 2: Trigger prod deploy via the workflow**

GitHub UI → Actions → "Deploy prod" → Run workflow → input `imageTag=dev-<sha>` from a known-good dev deploy.

- [ ] **Step 3: Approve as the required reviewer**

A second reviewer approves in the GitHub Environments UI.

- [ ] **Step 4: Verify**

Expected: workflow completes. Prod ALB returns 200 on `/health`. CloudWatch shows api/worker tasks running.

---

## Phase 10 — Documentation

### Task 10.1: Update README with CI/CD section

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add a CI/CD section**

After the "Lambda Deployment Shape" section in `README.md`, add:

```markdown
## CI/CD

This repo uses GitHub Actions to deploy a Docker image to AWS ECS Fargate.

- **Pull requests** run typechecks, tests, a Docker build, and `cdk synth` (`.github/workflows/ci.yml`).
- **Merges to `main`** auto-deploy to the `dev` environment (`.github/workflows/deploy-dev.yml`).
- **Production promotion** is manual via Actions → "Deploy prod" → Run workflow, with required-reviewer approval. The same image bytes that ran in `dev` are re-tagged and deployed to `prod` — no rebuild.

Infrastructure is defined in `infra/` (AWS CDK). See `docs/superpowers/specs/2026-05-06-cicd-pipeline-design.md` for the full design rationale.

### Rolling back prod

Re-run the "Deploy prod" workflow with `imageTag` set to the previous-known-good `dev-<sha>`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document CI/CD pipeline and rollback procedure"
```

---

## Self-Review Checklist (already performed; no action for executor)

- Spec coverage: every section of the spec maps to one or more tasks above. Migrations (§8), observability (§9a), rollback (§9b) all have explicit tasks.
- Placeholder scan: no "TBD" / "implement later" / vague directives. Two `REPLACE_WITH_*_EMAIL` strings in `infra/lib/config.ts` are flagged in Task 3.1 Step 7 as required operator inputs.
- Type consistency: `processMessage`, `runOnce`, `EnvConfig`, `AppStackProps`, `OidcStackProps` are defined in their respective tasks and used consistently downstream.
- Risks called out: shared Supabase auth.users pool (spec §2 Q2), permissive PowerUserAccess on deploy roles (Task 6.2), schema-name SQL injection mitigated by validation in Task 5.2 Step 4.
