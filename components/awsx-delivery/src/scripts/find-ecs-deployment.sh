#!/usr/bin/env bash
set -euo pipefail

# Prints one deployment ARN, or nothing for a verified no-op with --allow-no-deployment.
allow_no_deployment=false
if [[ $# -eq 1 && "$1" == --allow-no-deployment ]]; then
  allow_no_deployment=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--allow-no-deployment]" >&2
  exit 1
fi
: "${ECS_CLUSTER:?Set ECS_CLUSTER}"
: "${ECS_SERVICE:?Set ECS_SERVICE}"
: "${DELIVERY_PIPELINE:?Delivery pipeline identity is required}"
: "${DELIVERY_RUN:?Delivery run number is required}"
: "${DELIVERY_STAGE:?Delivery stage is required}"
gate_stage=${ECS_GATE_STAGE:-$DELIVERY_STAGE}
: "${ECS_GATE_CONDITION:?Set ECS_GATE_CONDITION}"
if $allow_no_deployment; then
  : "${ECS_TASK_DEFINITION:?Set ECS_TASK_DEFINITION to the infra output}"
fi

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
# Keep caller identity out of the deployment ARN captured by the caller.
aws sts get-caller-identity "${aws_options[@]}" >&2
token=''
matches=()
latest='null'
has_active=false

while :; do
  list_options=(--cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" --max-results 100 --no-paginate)
  if [[ -n "$token" ]]; then list_options+=(--next-token "$token"); fi
  page=$(aws ecs list-service-deployments "${list_options[@]}" "${aws_options[@]}")
  latest=$(jq -cn --argjson latest "$latest" --argjson page "$page" '
    [$latest, $page.serviceDeployments[]?] | map(select(. != null)) | max_by(.createdAt)
  ')
  if jq -e 'any(.serviceDeployments[]?; .status == "PENDING" or .status == "IN_PROGRESS"
      or .status == "STOP_REQUESTED" or .status == "ROLLBACK_REQUESTED"
      or .status == "ROLLBACK_IN_PROGRESS")' <<< "$page" > /dev/null; then
    has_active=true
  fi
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
      --arg pipeline "$DELIVERY_PIPELINE" --arg run "$DELIVERY_RUN" --arg stage "$gate_stage" --arg condition "$ECS_GATE_CONDITION" '
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
            and .request.runNumber == $run and .request.condition == $condition
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

if [[ ${#matches[@]} -eq 0 ]] && $allow_no_deployment; then
  # Absence alone is not a no-op. Require a successful previous deployment, no
  # active deployments, and the expected task definition already serving traffic.
  if $has_active || ! jq -e '.status == "SUCCESSFUL"' <<< "$latest" > /dev/null; then
    echo "No matching deployment, but ECS deployment history is not settled successfully" >&2
    exit 1
  fi
  service=$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" "${aws_options[@]}")
  if ! jq -e --arg task "$ECS_TASK_DEFINITION" --arg run "$DELIVERY_RUN" \
    --arg pipeline "$DELIVERY_PIPELINE" --arg stage "$gate_stage" --arg condition "$ECS_GATE_CONDITION" '
    ((.failures // []) | length == 0) and (.services | length == 1)
    and (.services[0] |
      .status == "ACTIVE" and .taskDefinition == $task
      and .pendingCount == 0 and .runningCount == .desiredCount
      and any(.deploymentConfiguration.lifecycleHooks[]?;
        (.hookDetails // {} | if type == "string" then (fromjson? // {}) else . end)
        | .call | select(type == "object")
        | .service == "Delivery" and .action == "ContinueManualGate"
          and ([.parameters.organization, .parameters.project, .parameters.stack] | join("/")) == $pipeline
          and .parameters.stage == $stage and .request.runNumber == $run and .request.condition == $condition))
  ' <<< "$service" > /dev/null; then
    echo "No matching deployment, but service state does not confirm this run is a no-op" >&2
    exit 1
  fi
  revision_arn=$(jq -er '.targetServiceRevisionArn' <<< "$latest")
  revision=$(aws ecs describe-service-revisions --service-revision-arns "$revision_arn" "${aws_options[@]}")
  if ! jq -e --arg task "$ECS_TASK_DEFINITION" '
    ((.failures // []) | length == 0) and (.serviceRevisions | length == 1)
    and .serviceRevisions[0].taskDefinition == $task
  ' <<< "$revision" > /dev/null; then
    echo "The last successful deployment does not use the expected task definition" >&2
    exit 1
  fi
  echo "No deployment matches this run; the expected task definition is already deployed successfully" >&2
  exit 0
fi

if [[ ${#matches[@]} -ne 1 ]]; then
  echo "Expected one ECS deployment for $DELIVERY_PIPELINE run $DELIVERY_RUN stage $gate_stage; found ${#matches[@]}" >&2
  exit 1
fi
printf '%s\n' "${matches[0]}"
