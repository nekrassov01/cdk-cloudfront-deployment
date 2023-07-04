#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

for cmd in aws jq; do
  check_command "$cmd"
done

for var in SERVICE BUCKET_NAME PRODUCTION_DISTRIBUTION_ID STAGING_DISTRIBUTION_ID STAGING_DISTRIBUTION_CLEANUP_ENABLED CONTINUOUS_DEPLOYMENT_POLICY_CUSTOM_HEADER FRONTEND_VERSION; do
  check_variable "$var"
done

header_k=$(jq -r .header <<<"$CONTINUOUS_DEPLOYMENT_POLICY_CUSTOM_HEADER")
header_v=$(jq .value <<<"$CONTINUOUS_DEPLOYMENT_POLICY_CUSTOM_HEADER")

if [[ $STAGING_DISTRIBUTION_CLEANUP_ENABLED == true || $STAGING_DISTRIBUTION_ID == "dummy" || $STAGING_DISTRIBUTION_ID == "deleted" ]]; then
  echo "PROCESS: Checking for CloudFront staging distribution ID in SSM parameter store: not present"

  echo "PROCESS: Copying CloudFront production distribution for staging distribution."
  prod_distribution=$(get_distribution "$PRODUCTION_DISTRIBUTION_ID")
  prod_distribution_etag=$(jq -r '.ETag' <<<"$prod_distribution")
  stg_distribution=$(copy_distribution "$PRODUCTION_DISTRIBUTION_ID" "$prod_distribution_etag")
  STAGING_DISTRIBUTION_ID=$(jq -r '.Distribution.Id' <<<"$stg_distribution")
  echo "PROCESS: Checking environment variable '$(env | grep "STAGING_DISTRIBUTION_ID")'"

  echo "PROCESS: Creating CloudFront continuous deployment policy."
  continuous_deployment_policy_config=$(
    cat <<-EOS
{
    "StagingDistributionDnsNames": {
        "Quantity": 1,
        "Items": [
            $(jq '.Distribution.DomainName' <<<"$stg_distribution")
        ]
    },
    "Enabled": true,
    "TrafficConfig": {
        "SingleHeaderConfig": {
            "Header": "$header_k",
            "Value": "$header_v"
        },
        "Type": "SingleHeader"
    }
}
EOS
  )
  continuous_deployment_policy=$(create_continuous_deployment_policy "$continuous_deployment_policy_config")

  echo "PROCESS: Attaching continuous deployment policy to CloudFront production distribution."
  continuous_deployment_policy_id=$(jq '.ContinuousDeploymentPolicy.Id' <<<"$continuous_deployment_policy")
  prod_distribution_config=$(jq ".Distribution.DistributionConfig.ContinuousDeploymentPolicyId = $continuous_deployment_policy_id | .Distribution.DistributionConfig" <<<"$prod_distribution")
  update_distribution "$PRODUCTION_DISTRIBUTION_ID" "$prod_distribution_config" "$prod_distribution_etag"

  echo "PROCESS: Putting CloudFront staging distribution ID to SSM parameter store."
  put_ssm_parameter "/$SERVICE/cloudfront/cfcd-staging" "$STAGING_DISTRIBUTION_ID"
else
  echo "PROCESS: Checking for CloudFront staging distribution ID in SSM parameter store: exists"

  echo "PROCESS: Enable CloudFront continuous deployment policy."
  stg_distribution=$(get_distribution "$STAGING_DISTRIBUTION_ID")
  continuous_deployment_policy_id=$(get_continuous_deployment_policy_id_from_distribution "$STAGING_DISTRIBUTION_ID")
  continuous_deployment_policy=$(get_continuous_deployment_policy "$continuous_deployment_policy_id")
  continuous_deployment_policy_etag=$(jq -r '.ETag' <<<"$continuous_deployment_policy")
  continuous_deployment_policy_config=$(jq '.Enabled = true | .ContinuousDeploymentPolicy.ContinuousDeploymentPolicyConfig' <<<"$continuous_deployment_policy")
  update_continuous_deployment_policy "$continuous_deployment_policy_id" "$continuous_deployment_policy_etag" "$continuous_deployment_policy_config"
fi

echo "PROCESS: Get CloudFront latest configuration."
stg_distribution=$(get_distribution "$STAGING_DISTRIBUTION_ID")
stg_distribution_etag=$(jq -r '.ETag' <<<"$stg_distribution")

echo "PROCESS: Updating CloudFront staging distribution config for application frontend version: '$FRONTEND_VERSION'"
stg_distribution_config=$(
  jq --arg bucket "$BUCKET_NAME" --arg version "/$FRONTEND_VERSION" '
  .Distribution.DistributionConfig.Origins.Items[] |=
  if .DomainName | contains($bucket) then
    .OriginPath = $version
  else
    .
  end
  | .Distribution.DistributionConfig' <<<"$stg_distribution"
)
update_distribution "$STAGING_DISTRIBUTION_ID" "$stg_distribution_config" "$stg_distribution_etag"

echo "PROCESS: Tagging commit hash to CloudFront production distribution if exists CODEBUILD_RESOLVED_SOURCE_VERSION."
if [[ -n "${CODEBUILD_RESOLVED_SOURCE_VERSION:-}" ]]; then
  tag_distribution "$(get_distribution_arn "$STAGING_DISTRIBUTION_ID")" "CommitHash" "$CODEBUILD_RESOLVED_SOURCE_VERSION"
else
  echo "WARNING: CODEBUILD_RESOLVED_SOURCE_VERSION is not set."
fi

echo "SUCCESS: CloudFront deployment completed successfully."
exit 0
