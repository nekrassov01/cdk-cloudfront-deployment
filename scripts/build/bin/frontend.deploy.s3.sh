#!/usr/bin/env bash

set -euo pipefail

if [ -z "$1" ]; then
  echo "Required deploy target path!"
  exit 1
fi

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

for cmd in aws jq; do
  check_command "$cmd"
done

for var in BUCKET_NAME FRONTEND_VERSION; do
  check_variable "$var"
done

echo "PROCESS: Synchronizing contents to hosting bucket."

deploy_content "$1" "s3://$BUCKET_NAME/$FRONTEND_VERSION"

echo "SUCCESS: Application deployment completed successfully."
exit 0
