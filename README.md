# Nexus Workspace

A scalable productivity suite built on a **Next.js** frontend (statically
exported to S3 / CloudFront) and an **AWS SAM** backend (API Gateway + Lambda).
Users authenticate against an AWS Cognito User Pool before accessing the
dashboard.

---

## Repository Structure

```
/
├── /frontend                          # Next.js static-export app
│   ├── /src
│   │   ├── /app                       # App Router pages
│   │   │   ├── page.tsx               # Dashboard home
│   │   │   └── /notion-review
│   │   │       └── page.tsx           # Notion Review app
│   │   ├── /components
│   │   │   ├── AuthGuard.tsx          # Cognito authentication wrapper
│   │   │   └── ProgressCalendar.tsx   # Month-view progress calendar
│   │   └── /lib
│   │       ├── amplify-config.ts      # Amplify / Cognito configuration
│   │       ├── auth.ts                # Auth helpers (sign-in, token)
│   │       └── api.ts                 # Backend API client
│   ├── next.config.js                 # output: 'export'
│   └── package.json
├── /backend                           # AWS SAM application
│   ├── /functions
│   │   └── /notion_review_trigger     # Lambda: topics & LLM trigger
│   ├── /layers/common/python          # Shared Lambda utilities
│   ├── template.yaml                  # SAM infrastructure definition
│   └── requirements.txt
└── /.github/workflows
    └── deploy.yml                     # Combined CI/CD pipeline
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

## Local Development

### Backend

```bash
cd backend
pip install -r requirements.txt
sam build
sam local start-api
```

### Frontend

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_AWS_REGION=us-east-1
NEXT_PUBLIC_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
NEXT_PUBLIC_COGNITO_CLIENT_ID=<app-client-id>
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3001
```

Then:

```bash
cd frontend
npm install
npm run dev
```

---

## Deployment

### 1 – IAM / OIDC setup

Create an IAM role that trusts the GitHub OIDC provider for your repository and
grants the permissions needed to deploy CloudFormation, Lambda, S3, and
CloudFront.  Save the role ARN as the `AWS_DEPLOY_ROLE_ARN` repository secret.

### 2 – Repository Secrets / Variables

| Name | Type | Description |
|------|------|-------------|
| `AWS_DEPLOY_ROLE_ARN` | Secret | IAM role ARN assumed via OIDC |
| `COGNITO_USER_POOL_ARN` | Secret | ARN of the existing User Pool |
| `COGNITO_USER_POOL_ID` | Secret | ID of the existing User Pool |
| `COGNITO_CLIENT_ID` | Secret | Cognito App Client ID (no secret) |
| `AWS_REGION` | Variable | AWS region (default: `us-east-1`) |
| `SAM_STACK_NAME` | Variable | CloudFormation stack name (default: `nexus-workspace`) |

### 3 – Push to `main`

The `deploy.yml` workflow will:

1. **Job 1 (Backend)** – `sam build && sam deploy` the SAM template.
2. **Job 2 (Frontend)** – `npm ci && npm run build`, then sync `frontend/out/`
   to the S3 bucket and invalidate the CloudFront distribution.

---

## Architecture

```
Browser → CloudFront → S3 (static Next.js export)
Browser → API Gateway (Cognito JWT authorizer) → Lambda (Python 3.12)
```

All API requests from the frontend include the Cognito `id_token` as a
`Bearer` token in the `Authorization` header.  API Gateway validates the token
against the configured Cognito User Pool before invoking the Lambda function.

---

## Adding New Apps

1. Create a new Lambda in `backend/functions/<app_name>/`.
2. Register it in `backend/template.yaml` with the appropriate API events.
3. Add a new Next.js page under `frontend/src/app/<app-name>/page.tsx`.
4. Add the corresponding API helper functions in `frontend/src/lib/api.ts`.
