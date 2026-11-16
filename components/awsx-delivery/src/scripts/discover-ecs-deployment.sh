#!/usr/bin/env bash
set -euo pipefail

: "${DELIVERY_OUTPUTS:?Delivery outputs file is required}"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# Recheck a no-op to allow time for ECS deployment history to become visible.
# Errors remain failures, never a reason to bypass approval.
for attempt in 1 2 3; do
  deployment_arn=$(bash "$script_dir/find-ecs-deployment.sh" --allow-no-deployment)
  if [[ -n "$deployment_arn" ]]; then
    jq -n --arg arn "$deployment_arn" '{result: "deployment", deploymentArn: $arn}' > "$DELIVERY_OUTPUTS"
    exit 0
  fi
  if [[ "$attempt" -lt 3 ]]; then sleep 10; fi
done

printf '%s\n' '{"result":"no-deployment","deploymentArn":""}' > "$DELIVERY_OUTPUTS"
