# Backend dev deployment (AWS SAM → real AWS)

Lambda functions are deployed to a real AWS `dev` stack for development and
integration testing. No local simulation, no LocalStack — every test hits actual
AWS SQS, DynamoDB, and API Gateway.

The same stack strategy applies to production; only the config-env changes.

---

## Prerequisites

- AWS SAM CLI installed (`sam --version`)
- AWS credentials configured (`aws configure` or env vars)
- Run all commands from the `backend/` directory

---

## 1 – Set up secrets

Copy the example file and fill in real values:

```powershell
Copy-Item secrets.dev.json.example secrets.dev.json
```

Edit `secrets.dev.json` (git-ignored — never commit it):

| Key | Description |
|-----|-------------|
| `NotionIntegrationToken` | Notion integration secret token |
| `NotionTopicsDatabaseId` | UUID of the Notion Topics database |
| `OpenAIApiKey` | OpenAI API key |
| `PersonalApiToken` | Your chosen secret (≥ 16 chars) — stored in SSM, used to unlock the web app |

---

## 2 – Deploy to dev

```powershell
.\deploy-dev.ps1
```

This script:
1. Writes `PersonalApiToken` to SSM Parameter Store (`/nexus/dev/personal-api-token`) as a SecureString
2. Runs `sam build --config-env dev`
3. Runs `sam deploy --config-env dev` with the Notion/OpenAI secrets injected as parameter overrides
4. Prints the CloudFormation stack outputs (including `ApiEndpoint`)

On subsequent code-only changes, skip the build step with:

```powershell
.\deploy-dev.ps1 -NoBuild
```

> **First deploy:** SAM will create an S3 bucket for artefacts automatically
> (`resolve_s3 = true` in `samconfig.toml`).

---

## 3 – Note the API endpoint

After deployment, the script prints:

```
ApiEndpoint  |  https://<id>.execute-api.us-east-1.amazonaws.com/dev
```

Copy this URL — you will need it for the frontend.

---

## 4 – Test the API

All requests require your personal token in the `Authorization` header:

```powershell
$token = "<your-PersonalApiToken-from-secrets.dev.json>"
$base  = "https://<id>.execute-api.us-east-1.amazonaws.com/dev"
$headers = @{ Authorization = "Bearer $token" }

# List topics
Invoke-RestMethod "$base/notion-review/topics" -Headers $headers

# Trigger a review job
$resp = Invoke-RestMethod "$base/notion-review/trigger" `
  -Method POST -Headers $headers `
  -ContentType "application/json" `
  -Body (@{ topicId = "your-topic-id" } | ConvertTo-Json)

# Poll the result (worker fires automatically via SQS event source mapping)
Invoke-RestMethod "$base/notion-review/results/$($resp.requestId)" -Headers $headers

# Log completed reviews (updates Notion + S3 tracker)
# Replace notionPageId, topicId, topicName, subject, and questions with real values
$logBody = @{
  reviewedAt = (Get-Date -Format "2026-03-09")
  topics = @(
    @{
      notionPageId = "31bf2b9a8a5780eeb2e2c2b9e59d5e3d"
      topicId      = "TOP2"
      topicName    = "CI-CD for gen-AI and systems engineering"
      subject      = "DevOps Concepts"
      questions    = @("Test Question", "Second Test Question")
    }
  )
} | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/notion-review/log-review" `
  -Method POST -Headers $headers `
  -ContentType "application/json" `
  -Body $logBody

# Fetch monthly tracker (defaults to current month; add ?year=2026&month=3 to override)
Invoke-RestMethod "$base/notion-review/tracker" -Headers $headers
Invoke-RestMethod "$base/notion-review/tracker?year=2026&month=3" -Headers $headers
```

---

## 5 – Point the frontend at the dev stack

In `frontend/.env.local` (copy from `frontend/.env.local.example`):

```
NEXT_PUBLIC_API_BASE_URL=https://<id>.execute-api.us-east-1.amazonaws.com/dev
```

Run the Next.js dev server as usual:

```powershell
npm run dev   # from frontend/
```

The UI will now call the real deployed dev stack.

---

## Dev stack resources

| AWS Resource | Name |
|---|---|
| CloudFormation stack | `nexus-workspace-dev` |
| API Gateway stage | `dev` |
| Lambda – token authorizer | `nexus-token-authorizer-dev` |
| Lambda – trigger | `nexus-notion-review-dev` |
| Lambda – worker | `nexus-notion-review-worker-dev` |
| SSM parameter | `/nexus/dev/personal-api-token` (SecureString) |
| SQS queue | `nexus-review-queue-dev` |
| SQS DLQ | `nexus-review-dlq-dev` |
| DynamoDB table | `nexus-review-jobs-dev` |
| S3 bucket (tracker) | `nexus-review-tracking-<account-id>-dev` |

---

## Tearing down the dev stack

```powershell
sam delete --stack-name nexus-workspace-dev --region us-east-1
```

---

## Local function testing (no deployment required)

`invoke_local.py` lets you call any Lambda handler directly — no containers, no SAM, no LocalStack.
It reads env vars from `env.json`, sets up `sys.path` to include the function source and the common layer, then calls `lambda_handler` directly.

### Basic usage

```powershell
# From backend/ with the venv active:
python invoke_local.py <FunctionName> [events/<event-file>.json] [--mock-aws]
```

| Flag | Effect |
|------|--------|
| _(no flag)_ | boto3 calls go to real AWS using your current credentials |
| `--mock-aws` | DynamoDB, SQS, and SSM are replaced by in-memory stubs — **no AWS needed** |

### Available event files

| Event file | Function | What it tests |
|---|---|---|
| `events/trigger_get_topics.json` | `NotionReviewFunctionLocal` | `GET /notion-review/topics` |
| `events/trigger_post_trigger.json` | `NotionReviewFunctionLocal` | `POST /notion-review/trigger` |
| `events/trigger_get_result.json` | `NotionReviewFunctionLocal` | `GET /notion-review/results/{requestId}` |
| `events/trigger_log_review.json` | `NotionReviewFunctionLocal` | `POST /notion-review/log-review` |
| `events/trigger_get_tracker.json` | `NotionReviewFunctionLocal` | `GET /notion-review/tracker` |
| `events/worker_process_job.json` | `NotionReviewWorkerFunction` | SQS-triggered job processing |
| `events/authorizer_valid_token.json` | `TokenAuthorizerFunction` | Token authorizer — expect `Allow` |

### Example invocations

```powershell
# Fetch topics — hits real Notion API, mocks AWS (no DynamoDB/SQS needed)
python invoke_local.py NotionReviewFunctionLocal events/trigger_get_topics.json --mock-aws

# Queue a review job — edit topicId/notionPageId in the event file first
python invoke_local.py NotionReviewFunctionLocal events/trigger_post_trigger.json --mock-aws

# Log completed reviews — updates Notion pages + writes to the S3 tracker file
# Edit notionPageId/topicId in events/trigger_log_review.json before running
python invoke_local.py NotionReviewFunctionLocal events/trigger_log_review.json --mock-aws

# Fetch the monthly tracker (calendar data) — reads the S3 tracker file
# Edit year/month in events/trigger_get_tracker.json if needed
python invoke_local.py NotionReviewFunctionLocal events/trigger_get_tracker.json --mock-aws

# Round-trip: log first, then immediately read back the tracker (same in-memory S3 store)
python invoke_local.py NotionReviewFunctionLocal events/trigger_log_review.json --mock-aws
python invoke_local.py NotionReviewFunctionLocal events/trigger_get_tracker.json --mock-aws

# Process a worker job — hits real Notion + OpenAI, mocks DynamoDB
python invoke_local.py NotionReviewWorkerFunction events/worker_process_job.json --mock-aws

# Test the token authorizer
python invoke_local.py TokenAuthorizerFunction events/authorizer_valid_token.json --mock-aws
```

`--mock-aws` stubs print exactly what would be written to / read from AWS, so you can verify the data shapes without touching any deployed resources.

---

## Adding a new Lambda function

Follow these steps to keep the local testing setup in sync:

**1. Add env vars to `env.json`**

Add a new top-level key matching the SAM logical function name, with all environment variables the handler reads:

```json
"MyNewFunction": {
  "SOME_ENV_VAR": "value",
  "TABLE_NAME": "nexus-sometable-development"
}
```

**2. Register the function in `invoke_local.py`**

Add an entry to the `FUNCTION_DIRS` dict near the top of the file:

```python
FUNCTION_DIRS: dict[str, str] = {
    ...
    "MyNewFunction": "functions/my_new_function",
}
```

**3. Add any new boto3 service mocks if needed**

If the function uses an AWS service not already mocked (currently: DynamoDB, SQS, SSM), add a mock class inside `_apply_boto3_mocks()` in `invoke_local.py` and register it in `_resource_map` or `_client_map`.

**4. Create a sample event file**

Add a JSON file under `events/` matching the shape the handler expects and document it in the table above.

**5. Verify locally before deploying**

```powershell
python invoke_local.py MyNewFunction events/my_new_function_event.json --mock-aws
```
