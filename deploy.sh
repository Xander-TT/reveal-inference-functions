#!/usr/bin/env bash
# deploy.sh — Deploy reveal-inference-functions to Azure
#
# Usage:
#   ./deploy.sh              # deploy to the default app below
#   FUNCTION_APP=my-app ./deploy.sh   # override app name
#
# Prerequisites:
#   - Azure CLI installed and logged in (az login)
#   - Azure Functions Core Tools installed (func)
#   - node_modules installed (npm install)

set -euo pipefail

FUNCTION_APP="${FUNCTION_APP:-reveal-inference-function}"
RESOURCE_GROUP="${RESOURCE_GROUP:-ttdevopsuksdevrg-reveal}"

echo "=== Reveal Inference Function App Deployment ==="
echo "  App:            $FUNCTION_APP"
echo "  Resource group: $RESOURCE_GROUP"
echo ""

# ── 1. Preflight checks ──────────────────────────────────────────────────────

if ! command -v az &>/dev/null; then
  echo "ERROR: Azure CLI (az) not found. Install from https://aka.ms/installazurecli" >&2
  exit 1
fi

if ! command -v func &>/dev/null; then
  echo "ERROR: Azure Functions Core Tools (func) not found." >&2
  echo "       Install: npm install -g azure-functions-core-tools@4" >&2
  exit 1
fi

if ! az account show &>/dev/null; then
  echo "ERROR: Not logged in to Azure. Run: az login" >&2
  exit 1
fi

SUBSCRIPTION=$(az account show --query "name" -o tsv)
echo "Deploying as: $(az account show --query "user.name" -o tsv)"
echo "Subscription: $SUBSCRIPTION"
echo ""

# Confirm the target app exists
if ! az functionapp show --name "$FUNCTION_APP" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  echo "ERROR: Function App '$FUNCTION_APP' not found in resource group '$RESOURCE_GROUP'." >&2
  exit 1
fi

# ── 2. Install production dependencies ───────────────────────────────────────

echo ">>> Installing production dependencies..."
npm install --omit=dev
echo ""

# ── 3. Deploy via func CLI (zip deploy) ──────────────────────────────────────

echo ">>> Deploying to Azure..."
func azure functionapp publish "$FUNCTION_APP" \
  --javascript \
  --force

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Verify the deployment:"
echo "  az functionapp show --name $FUNCTION_APP --resource-group $RESOURCE_GROUP --query 'state' -o tsv"
echo ""
echo "Stream live logs:"
echo "  func azure functionapp logstream $FUNCTION_APP"
echo ""
echo "IMPORTANT — ensure these app settings are configured in Azure:"
echo "  COSMOS_ENDPOINT"
echo "  COSMOS_KEY"
echo "  COSMOS_DATABASE"
echo "  COSMOS_CONTAINER_INFERENCE_RUNS"
echo "  COSMOS_CONTAINER_PROJECTS"
echo "  COSMOS_CONTAINER_EDITOR_DOCS"
echo "  COSMOS_CONTAINER_EDITOR_EVENTS"
echo "  REVEALBLOB_CONNECTION_STRING"
echo "  REVEALBLOB_CONTAINER"
echo "  AML_ENDPOINT"
echo "  AML_API_KEY"
