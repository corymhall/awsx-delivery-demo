#!/usr/bin/env bash
set -euo pipefail

# Usage: wait-for-ecs-deployment.sh [deployment-arn] [timeout-seconds]
# The ARN defaults to ECS_DEPLOYMENT_ARN. AWS credentials and region must be set.
deployment_arn=${1:-${ECS_DEPLOYMENT_ARN:-}}
timeout_seconds=${2:-1800}

if [[ $# -gt 2 || -z "$deployment_arn" || ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "Usage: $0 [deployment-arn] [timeout-seconds]" >&2
  echo "Set ECS_DEPLOYMENT_ARN when omitting the deployment ARN." >&2
  exit 1
fi

deadline=$((SECONDS + timeout_seconds))
while ((SECONDS < deadline)); do
  deployment_status=$(aws ecs describe-service-deployments \
    --service-deployment-arns "$deployment_arn" \
    --query 'serviceDeployments[0].status' \
    --output text \
    --no-cli-pager \
    --cli-connect-timeout 10 \
    --cli-read-timeout 30)

  echo "$deployment_arn: $deployment_status"
  case "$deployment_status" in
  SUCCESSFUL) exit 0 ;;
  PENDING | IN_PROGRESS) ;;
  *)
    echo "Deployment did not succeed: $deployment_status" >&2
    exit 1
    ;;
  esac

  remaining=$((deadline - SECONDS))
  if ((remaining <= 0)); then break; fi
  if ((remaining > 15)); then remaining=15; fi
  sleep "$remaining"
done

echo "Timed out after ${timeout_seconds}s waiting for $deployment_arn" >&2
exit 1
