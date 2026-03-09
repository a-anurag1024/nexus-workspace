# Nexus Workspace

A productivity suite built on a **Next.js** frontend (statically exported, served via S3 + CloudFront) and an **AWS SAM** backend (API Gateway, Lambda, SQS, DynamoDB, and S3 — all defined in a single CloudFormation stack and deployed via `deploy-dev.ps1`).

---

## Repository Structure

```
/
├── frontend/                              # Next.js static-export app
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx                   # Dashboard home
│   │   │   └── notion-review/
│   │   │       └── page.tsx               # Notion Review sub-app
│   │   ├── components/
│   │   │   ├── AuthGuard.tsx              # Bearer-token auth wrapper
│   │   │   └── ProgressCalendar.tsx       # GitHub-style activity heatmap
│   │   └── lib/
│   │       ├── amplify-config.ts          # API base URL config
│   │       ├── auth.ts                    # Token helpers (localStorage)
│   │       └── api.ts                     # Backend API client
│   ├── next.config.js                     # output: 'export', trailingSlash: true
│   └── package.json
├── backend/                               # AWS SAM application
│   ├── functions/
│   │   ├── notion_review_trigger/         # HTTP handler: topics, trigger, results, log, tracker
│   │   ├── notion_review_worker/          # SQS-driven async job: Notion fetch + OpenAI questions
│   │   └── token_authorizer/              # Bearer-token Lambda authorizer
│   ├── layers/common/python/              # Shared Lambda utilities
│   ├── events/                            # JSON event fixtures for invoke_local.py
│   ├── template.yaml                      # SAM/CloudFormation stack definition
│   ├── samconfig.toml                     # SAM environment configs (dev / prod)
│   ├── deploy-dev.ps1                     # One-command deploy script (SSM + sam build + sam deploy)
│   ├── invoke_local.py                    # Direct Lambda invocation for local testing
│   ├── env.json                           # Env vars used by invoke_local.py
│   ├── secrets.dev.json                   # Git-ignored — real secret values for dev deployment
│   ├── secrets.dev.json.example           # Template — copy and fill in before first deploy
│   └── LOCAL_DEV.md                       # Full backend dev and testing guide
└── .github/workflows/
    └── deploy.yml                         # CI/CD — frontend only (backend deployed manually)
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 20 |
| Python | 3.12 |
| AWS SAM CLI | ≥ 1.113 |
| AWS CLI | ≥ 2 |

---

## Architecture

```
Browser ──▶ CloudFront ──▶ S3 (static Next.js export)
Browser ──▶ API Gateway ──▶ Token Authorizer Lambda
                         └─▶ Notion Review Lambda (sync endpoints)
                               └─▶ SQS ──▶ Review Worker Lambda
                                              └─▶ DynamoDB  (job state)
                                              └─▶ Notion API (page content)
                                              └─▶ OpenAI    (question generation)
```

All AWS resources (API Gateway, Lambdas, SQS, DynamoDB, S3 buckets, CloudFront + OAC) are defined in `backend/template.yaml` and deployed as a single CloudFormation stack.

---

## Backend

### Stack resources

| Resource | Name (dev) |
|---|---|
| CloudFormation stack | `nexus-workspace-dev` |
| API Gateway | `NexusWorkspaceApi` (stage `dev`) |
| Lambda – token authorizer | `nexus-token-authorizer-dev` |
| Lambda – trigger / HTTP | `nexus-notion-review-dev` |
| Lambda – async worker | `nexus-notion-review-worker-dev` |
| SSM parameter | `/nexus/dev/personal-api-token` (SecureString) |
| SQS queue | `nexus-review-queue-dev` |
| SQS DLQ | `nexus-review-dlq-dev` |
| DynamoDB table | `nexus-review-jobs-dev` |
| S3 – review tracker | `nexus-review-tracking-<account-id>-dev` |
| S3 – frontend | `nexus-frontend-<account-id>-dev` |
| CloudFront distribution | (managed by stack, see outputs) |

### API endpoints

All requests require `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/notion-review/topics` | Returns the 5 least-recently reviewed topics from Notion |
| `POST` | `/notion-review/trigger` | Queues a review job; returns `{ requestId }` |
| `GET` | `/notion-review/results/{requestId}` | Polls job status and questions once complete |
| `POST` | `/notion-review/log-review` | Marks topics reviewed in Notion and writes to S3 tracker |
| `GET` | `/notion-review/tracker` | Returns monthly review calendar data |

### Setup: secrets

Copy the example file and fill in your values (this file is git-ignored):

```powershell
Copy-Item backend/secrets.dev.json.example backend/secrets.dev.json
```

| Key | Description |
|-----|-------------|
| `NotionIntegrationToken` | Notion integration secret token |
| `NotionTopicsDatabaseId` | UUID of the Notion Topics database |
| `OpenAIApiKey` | OpenAI API key |
| `PersonalApiToken` | Your chosen secret (≥ 16 chars) — stored in SSM, used to authenticate the web app |

### Deploy

```powershell
cd backend
.\deploy-dev.ps1          # SSM write + sam build + sam deploy
.\deploy-dev.ps1 -NoBuild # skip build — deploy existing .aws-sam/ artefacts
```

After deployment the script prints the CloudFormation stack outputs, including `ApiEndpoint`. Copy that URL for the frontend.

### Local testing (no containers, no LocalStack)

`invoke_local.py` invokes any Lambda handler directly in the current Python process. It reads env vars from `env.json`, adds the function source and common layer to `sys.path`, and calls `lambda_handler`.

```powershell
# From backend/ with the venv active:
python invoke_local.py <FunctionName> [events/<event-file>.json] [--mock-aws]
```

| Flag | Effect |
|------|--------|
| _(none)_ | `boto3` calls go to real AWS using your current credentials |
| `--mock-aws` | DynamoDB, SQS, and SSM replaced by in-memory stubs — no AWS calls made |

Available event files:

| Event file | Function | Tests |
|---|---|---|
| `events/trigger_get_topics.json` | `NotionReviewFunctionLocal` | `GET /notion-review/topics` |
| `events/trigger_post_trigger.json` | `NotionReviewFunctionLocal` | `POST /notion-review/trigger` |
| `events/trigger_get_result.json` | `NotionReviewFunctionLocal` | `GET /notion-review/results/{requestId}` |
| `events/trigger_log_review.json` | `NotionReviewFunctionLocal` | `POST /notion-review/log-review` |
| `events/trigger_get_tracker.json` | `NotionReviewFunctionLocal` | `GET /notion-review/tracker` |
| `events/worker_process_job.json` | `NotionReviewWorkerFunction` | SQS job processing |
| `events/authorizer_valid_token.json` | `TokenAuthorizerFunction` | Token authorizer |

Example invocations:

```powershell
# Fetch topics — real Notion API, mocked AWS
python invoke_local.py NotionReviewFunctionLocal events/trigger_get_topics.json --mock-aws

# Queue a job — edit topicId/notionPageId in the event file first
python invoke_local.py NotionReviewFunctionLocal events/trigger_post_trigger.json --mock-aws

# Process a worker job — real Notion + OpenAI, mocked DynamoDB
python invoke_local.py NotionReviewWorkerFunction events/worker_process_job.json --mock-aws
```

See `backend/LOCAL_DEV.md` for the full testing guide and PowerShell snippets for hitting the deployed dev API.

### Tear down

```powershell
sam delete --stack-name nexus-workspace-dev --region <your-region>
```

---

## Frontend

### Local development

Create `frontend/.env.local` (copy from `frontend/.env.local.example`):

```env
NEXT_PUBLIC_API_BASE_URL=https://<id>.execute-api.<region>.amazonaws.com/dev
```

```powershell
cd frontend
npm install
npm run dev
```

On first visit the app prompts for a Bearer token — enter the value you set as `PersonalApiToken` in `secrets.dev.json`.

### CI/CD

Every push to `main` that touches `frontend/**` automatically builds and deploys the static site.

```
push to main (frontend/**)
  └── npm ci
  └── npm run build  (Next.js static export → frontend/out/)
  └── aws s3 sync    (immutable cache for JS/CSS; no-cache for HTML/JSON)
  └── CloudFront invalidation "/*"
```

The workflow uses GitHub OIDC — no long-lived AWS credentials stored in GitHub.

#### Required GitHub repository secrets

Go to **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Description |
|--------|-------------|
| `AWS_DEPLOY_ROLE_ARN` | ARN of the IAM role GitHub Actions assumes via OIDC |

#### Required GitHub repository variables

Go to **Settings → Secrets and variables → Actions → Variables**:

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `AWS_REGION` | AWS region the stack is deployed in | e.g. `us-east-1` |
| `NEXT_PUBLIC_API_BASE_URL` | API Gateway invoke URL | `ApiEndpoint` output from `deploy-dev.ps1` |
| `FRONTEND_BUCKET_NAME` | S3 bucket for the static site | `FrontendBucketName` output from the stack |
| `CLOUDFRONT_DISTRIBUTION_ID` | CloudFront distribution ID | `CloudFrontDistributionId` output from the stack |

Retrieve all outputs at any time with:

```powershell
aws cloudformation describe-stacks `
  --stack-name nexus-workspace-dev `
  --query "Stacks[0].Outputs" `
  --output table
```

#### IAM role permissions for GitHub Actions

The role must trust `token.actions.githubusercontent.com` and have at minimum:

| Permission | Resource |
|---|---|
| `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` | `arn:aws:s3:::FRONTEND_BUCKET` and `arn:aws:s3:::FRONTEND_BUCKET/*` |
| `cloudfront:CreateInvalidation` | `arn:aws:cloudfront::<account>:distribution/<dist-id>` |

Trust condition (replace `ORG/REPO`):

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:ORG/REPO:ref:refs/heads/main"
  }
}
```

> `package-lock.json` must be committed — `npm ci` requires it.

---

## Adding a new sub-app

1. Add a Lambda handler under `backend/functions/<app_name>/`.
2. Register it in `backend/template.yaml` (function + API events).
3. Add its env vars to `backend/env.json` and register it in `backend/invoke_local.py`.
4. Create test event files under `backend/events/`.
5. Add API helpers to `frontend/src/lib/api.ts`.
6. Add a new page at `frontend/src/app/<app-name>/page.tsx`.
7. Deploy the backend: `.\deploy-dev.ps1`
8. Push frontend changes to `main` — GitHub Actions deploys automatically.
