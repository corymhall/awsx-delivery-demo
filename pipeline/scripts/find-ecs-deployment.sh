#!/usr/bin/env bash
set -euo pipefail

# Prints one deployment ARN. Delivery supplies its pipeline, run, and stage.
: "${ECS_CLUSTER:?Set ECS_CLUSTER}"
: "${ECS_SERVICE:?Set ECS_SERVICE}"
: "${DELIVERY_PIPELINE:?Delivery pipeline identity is required}"
: "${DELIVERY_RUN:?Delivery run number is required}"
: "${DELIVERY_STAGE:?Delivery stage is required}"

if [[ ! "$DELIVERY_RUN" =~ ^[1-9][0-9]*$ ]]; then
  echo "DELIVERY_RUN must be a positive integer" >&2
  exit 1
fi

# Log to stderr so command substitution captures only the deployment ARN.
printf 'ECS_CLUSTER=%q\nECS_SERVICE=%q\nAWS_REGION=%q\n' \
  "$ECS_CLUSTER" "$ECS_SERVICE" "${AWS_REGION:-}" >&2

export AWS_PAGER=''
export AWS_CLI_AUTO_PROMPT=off
aws_options=(--output json --cli-connect-timeout 10 --cli-read-timeout 30)
token=''
matches=()

while :; do
  list_options=(--cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" --max-results 100 --no-paginate)
  if [[ -n "$token" ]]; then list_options+=(--next-token "$token"); fi
  page=$(aws ecs list-service-deployments "${list_options[@]}" "${aws_options[@]}")
  read -r -a arns <<< "$(jq -r '[.serviceDeployments[]?.serviceDeploymentArn] | join(" ")' <<< "$page")"

  # DescribeServiceDeployments accepts at most 20 ARNs at a time.
  for ((offset = 0; offset < ${#arns[@]}; offset += 20)); do
    deployments=$(aws ecs describe-service-deployments \
      --service-deployment-arns "${arns[@]:offset:20}" "${aws_options[@]}")
    if ! jq -e '(.failures // []) | length == 0' <<< "$deployments" > /dev/null; then
      echo "ECS could not describe all candidate deployments" >&2
      exit 1
    fi
    found=$(jq -r \
      --arg pipeline "$DELIVERY_PIPELINE" --arg run "$DELIVERY_RUN" --arg stage "$DELIVERY_STAGE" '
      .serviceDeployments[]?
      | select(any(.deploymentConfiguration.lifecycleHooks[]?;
          (.hookDetails // {} | if type == "string" then (fromjson? // {}) else . end)
          | select(type == "object")
          | .call
          | select(type == "object")
          | .service == "Delivery"
            and .action == "ContinueManualGate"
            and ([.parameters.organization, .parameters.project, .parameters.stack] | join("/")) == $pipeline
            and .parameters.stage == $stage
            and .request.runNumber == $run
        ))
      | .serviceDeploymentArn
    ' <<< "$deployments")
    while IFS= read -r arn; do
      if [[ -n "$arn" ]]; then matches+=("$arn"); fi
    done <<< "$found"
  done

  token=$(jq -r '.nextToken // empty' <<< "$page")
  if [[ -z "$token" ]]; then break; fi
done

if [[ ${#matches[@]} -ne 1 ]]; then
  echo "Expected one ECS deployment for $DELIVERY_PIPELINE run $DELIVERY_RUN stage $DELIVERY_STAGE; found ${#matches[@]}" >&2
  exit 1
fi
printf '%s\n' "${matches[0]}"
