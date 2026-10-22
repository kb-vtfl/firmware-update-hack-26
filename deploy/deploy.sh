#!/usr/bin/env bash
# Builds the dashboard image and deploys it as a public Azure Container App.
# Usage: npm run deploy:azure   (or: bash deploy/deploy.sh)
# Overrides: RG, APP_NAME, ACR_NAME, ENV_NAME, IMAGE_NAME, TAG, ENV_FILE, BUILD_MODE=acr|local
set -euo pipefail

cd "$(dirname "$0")/.."

RG="${RG:-rg-vf-hack-user-19}"
APP_NAME="${APP_NAME:-firmware-rollout-ui}"
ACR_NAME="${ACR_NAME:-msagthackcrhaka5q7bkuwgk}"
ENV_NAME="${ENV_NAME:-msagthack-caenv-haka5q7bkuwgk}"
IMAGE_NAME="${IMAGE_NAME:-hackaton-26}"
TAG="${TAG:-$(date +%Y%m%d%H%M%S)}"
ENV_FILE="${ENV_FILE:-.env}"
BUILD_MODE="${BUILD_MODE:-acr}"
TARGET_PORT=3000

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Reads KEY=value from the env file without sourcing it, so values are never shell-expanded.
env_value() {
  local line value
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}

step "Pre-flight checks"
command -v az >/dev/null || fail "Azure CLI (az) is not installed"
[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE not found (copy .env.example and fill in the Foundry settings)"
az account show -o none 2>/dev/null || fail "Not logged in, run: az login"
az account show --query "{subscription:name, user:user.name}" -o table
az group show -n "$RG" -o none || fail "Resource group $RG not found or not accessible"
az extension add --name containerapp --upgrade --yes --only-show-errors

FOUNDRY_ENDPOINT="$(env_value AZURE_FOUNDRY_ENDPOINT)"
FOUNDRY_KEY="$(env_value AZURE_FOUNDRY_API_KEY)"
[[ -n "$FOUNDRY_ENDPOINT" && -n "$FOUNDRY_KEY" ]] || fail "AZURE_FOUNDRY_ENDPOINT and AZURE_FOUNDRY_API_KEY must be set in $ENV_FILE"

ENV_VARS=("UI_PORT=$TARGET_PORT" "AZURE_FOUNDRY_API_KEY=secretref:foundry-key")
for key in AZURE_FOUNDRY_ENDPOINT AZURE_FOUNDRY_DEPLOYMENT AZURE_FOUNDRY_RESPONSES_URL TARGET_FIRMWARE_VERSION \
  FIRMWARE_LOCATION_TEMPLATE UI_FIRMWARE_STEP_MS MOCK_OFFLINE_STATIONS MOCK_FIRMWARE_FAILURES; do
  value="$(env_value "$key")"
  if [[ -n "$value" ]]; then ENV_VARS+=("$key=$value"); fi
done

ACR_SERVER="$(az acr show -n "$ACR_NAME" -g "$RG" --query loginServer -o tsv)"
IMAGE="$ACR_SERVER/$IMAGE_NAME:$TAG"

step "Building image $IMAGE ($BUILD_MODE)"
if [[ "$BUILD_MODE" == "local" ]]; then
  command -v docker >/dev/null || fail "BUILD_MODE=local needs Docker (Docker Desktop or Colima)"
  docker build --platform linux/amd64 -t "$IMAGE" -t "$ACR_SERVER/$IMAGE_NAME:latest" .
  az acr login -n "$ACR_NAME"
  docker push "$IMAGE"
  docker push "$ACR_SERVER/$IMAGE_NAME:latest"
else
  az acr build -r "$ACR_NAME" -g "$RG" -t "$IMAGE_NAME:$TAG" -t "$IMAGE_NAME:latest" --platform linux/amd64 .
fi

if az containerapp show -n "$APP_NAME" -g "$RG" -o none 2>/dev/null; then
  step "Updating Container App $APP_NAME"
  az containerapp secret set -n "$APP_NAME" -g "$RG" --secrets "foundry-key=$FOUNDRY_KEY" -o none
  az containerapp update -n "$APP_NAME" -g "$RG" --image "$IMAGE" --set-env-vars "${ENV_VARS[@]}" -o none
else
  step "Creating Container App $APP_NAME in $ENV_NAME"
  ACR_USER="$(az acr credential show -n "$ACR_NAME" -g "$RG" --query username -o tsv)"
  ACR_PASSWORD="$(az acr credential show -n "$ACR_NAME" -g "$RG" --query 'passwords[0].value' -o tsv)"
  az containerapp create -n "$APP_NAME" -g "$RG" \
    --environment "$ENV_NAME" \
    --image "$IMAGE" \
    --registry-server "$ACR_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASSWORD" \
    --ingress external --target-port "$TARGET_PORT" \
    --min-replicas 1 --max-replicas 1 \
    --cpu 0.5 --memory 1Gi \
    --secrets "foundry-key=$FOUNDRY_KEY" \
    --env-vars "${ENV_VARS[@]}" \
    -o none
fi

FQDN="$(az containerapp show -n "$APP_NAME" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)"
step "Deployed"
echo "Dashboard: https://$FQDN"
echo "Logs:      az containerapp logs show -n $APP_NAME -g $RG --follow"
echo "Remove:    az containerapp delete -n $APP_NAME -g $RG --yes"
