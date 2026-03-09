<#
.SYNOPSIS
    Build and deploy the Nexus backend to the AWS dev stack.

.DESCRIPTION
    Reads sensitive values from secrets.dev.json (git-ignored), stores the
    personal API token in SSM Parameter Store, then runs `sam build` +
    `sam deploy`.

.EXAMPLE
    .\deploy-dev.ps1           # build + deploy
    .\deploy-dev.ps1 -NoBuild  # skip build, deploy existing .aws-sam/ artefacts
#>
param(
    [switch]$NoBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SecretsFile = Join-Path $PSScriptRoot "secrets.dev.json"
if (-not (Test-Path $SecretsFile)) {
    Write-Error @"
secrets.dev.json not found at: $SecretsFile
Copy secrets.dev.json.example to secrets.dev.json and fill in the real values.
"@
    exit 1
}

$s = Get-Content $SecretsFile -Raw | ConvertFrom-Json

# Validate that the token placeholder has been replaced.
if ($s.PersonalApiToken -like "*REPLACE*" -or $s.PersonalApiToken.Length -lt 16) {
    Write-Error "Set a strong PersonalApiToken (>= 16 chars) in secrets.dev.json before deploying."
    exit 1
}

# Store the personal API token in SSM (SecureString) so the Lambda authorizer
# can read it without the value ever appearing in CloudFormation parameters.
Write-Host "`n==> Storing personal API token in SSM..." -ForegroundColor Cyan
aws ssm put-parameter `
    --name "/nexus/dev/personal-api-token" `
    --value $s.PersonalApiToken `
    --type SecureString `
    --overwrite | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to write SSM parameter. Ensure AWS CLI is installed and credentials are configured ('aws sts get-caller-identity')."
    exit $LASTEXITCODE
}
Write-Host "    SSM parameter /nexus/dev/personal-api-token updated."

# Build (unless skipped).
if (-not $NoBuild) {
    Write-Host "`n==> sam build --config-env dev" -ForegroundColor Cyan
    sam build --config-env dev
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# Deploy – secrets are in SSM, not in parameter overrides.
Write-Host "`n==> sam deploy --config-env dev" -ForegroundColor Cyan
sam deploy --config-env dev `
    --parameter-overrides `
        "NotionIntegrationToken=$($s.NotionIntegrationToken)" `
        "NotionTopicsDatabaseId=$($s.NotionTopicsDatabaseId)" `
        "OpenAIApiKey=$($s.OpenAIApiKey)"

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`n==> Fetching stack outputs..." -ForegroundColor Cyan
aws cloudformation describe-stacks `
    --stack-name nexus-workspace-dev `
    --query "Stacks[0].Outputs" `
    --output table

