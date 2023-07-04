#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

for cmd in aws jq; do
  check_command "$cmd"
done

for var in PRODUCTION_DISTRIBUTION_ID STAGING_DISTRIBUTION_ID; do
  check_variable "$var"
done

echo "PROCESS: Waiting for CloudFront distribution changes to propagate to edge locations."
wait_distribution_deploy "$PRODUCTION_DISTRIBUTION_ID"
wait_distribution_deploy "$STAGING_DISTRIBUTION_ID"

echo "PROCESS: Overriding CloudFront production distribution config with staging config."
prod_distribution_etag=$(get_distribution_etag "$PRODUCTION_DISTRIBUTION_ID")
stg_distribution_etag=$(get_distribution_etag "$STAGING_DISTRIBUTION_ID")
update_distribution_with_staging_config "$PRODUCTION_DISTRIBUTION_ID" "$STAGING_DISTRIBUTION_ID" "$prod_distribution_etag" "$stg_distribution_etag"

echo "SUCCESS: Staging distribution promotion completed successfully."
exit 0
