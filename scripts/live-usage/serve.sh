#!/usr/bin/env bash
# Start a local dev server for usage measurement. Firestore and Auth point at the local
# emulators under a demo- project, and staging credentials are blanked so nothing can
# reach staging. See docs/live-updates.md.
set -euo pipefail

: "${USAGE_DIR:?Set USAGE_DIR to a scratch folder for counts and workflow data}"
PORT="${PORT:-3315}"
FIRESTORE_PORT="${FIRESTORE_PORT:-8185}"
AUTH_PORT="${AUTH_PORT:-9185}"
mkdir -p "$USAGE_DIR/workflow-data"

# Local development, whatever .env.local says, so fixture catalog and emulator sign-in
# are allowed and the review namespace is "development".
export VERCEL_ENV=development
export GCP_PROJECT_ID=demo-plate-curator
export NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-plate-curator
export NEXT_PUBLIC_FIREBASE_API_KEY=demo-key
export NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=demo-plate-curator.firebaseapp.com
export NEXT_PUBLIC_FIREBASE_APP_ID=demo-app
export FIRESTORE_EMULATOR_HOST="localhost:$FIRESTORE_PORT"
export FIREBASE_AUTH_EMULATOR_HOST="localhost:$AUTH_PORT"
export NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST="localhost:$FIRESTORE_PORT"
export NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST="localhost:$AUTH_PORT"
export CATALOG_SOURCE=fixture
export NEXT_PUBLIC_LOCAL_PIPELINE=1
export LOCAL_PIPELINE_SCOPE="${LOCAL_PIPELINE_SCOPE:-usage}"
export OWNER_UIDS=usage-owner
export USAGE_COUNTER_FILE="$USAGE_DIR/usage-counts.json"
export NEXT_PUBLIC_USAGE_COUNTER=1
export WORKFLOW_TARGET_WORLD=local
export WORKFLOW_LOCAL_BASE_URL="http://localhost:$PORT"
export WORKFLOW_LOCAL_DATA_DIR="$USAGE_DIR/workflow-data"
# Blank anything that could reach staging. Shell values take precedence over .env.local.
export GCP_PROJECT_NUMBER= GCP_SERVICE_ACCOUNT_EMAIL= GCP_WORKLOAD_IDENTITY_POOL_ID=
export GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID= VERCEL_OIDC_TOKEN= BLOB_READ_WRITE_TOKEN=
export FIREBASE_STORAGE_BUCKET= LOCAL_PIPELINE_WORKER_TOKEN= RESEARCH_ENABLE_MODEL_CALLS=

exec npx next dev -p "$PORT"
