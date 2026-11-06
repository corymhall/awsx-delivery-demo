"""Exercise approval-bypass decisions without AWS credentials or a deployment."""

import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent
PIPELINE = "acme/pipeline/dev"
TASK = "arn:aws:ecs:us-east-2:123456789012:task-definition/app:1"
ARN = "arn:aws:ecs:us-east-2:123456789012:service-deployment/cluster/app/new"


def hook(run):
    return {"hookDetails": {"call": {
        "service": "Delivery", "action": "ContinueManualGate",
        "parameters": {"organization": "acme", "project": "pipeline", "stack": "dev", "stage": "checkpoint"},
        "request": {"runNumber": run},
    }}}


def responses():
    return {
        "list-service-deployments": {"serviceDeployments": [{
            "serviceDeploymentArn": ARN, "createdAt": 1,
            "status": "SUCCESSFUL", "targetServiceRevisionArn": "revision",
        }]},
        "describe-service-deployments": {"serviceDeployments": [{
            "serviceDeploymentArn": ARN,
            "deploymentConfiguration": {"lifecycleHooks": [hook("10")]},
        }]},
        "describe-services": {"services": [{
            "status": "ACTIVE", "taskDefinition": TASK, "desiredCount": 1,
            "runningCount": 1, "pendingCount": 0,
            "deploymentConfiguration": {"lifecycleHooks": [hook("11")]},
        }]},
        "describe-service-revisions": {"serviceRevisions": [{"taskDefinition": TASK}]},
    }


class DiscoveryTest(unittest.TestCase):
    def run_discovery(self, data, discover=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "responses.json").write_text(json.dumps(data))
            aws = root / "aws"
            aws.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ['MOCK_ROOT'])
with (root / 'calls').open('a') as f:
    f.write(sys.argv[2] + '\\n')
if sys.argv[1:3] == ['sts', 'get-caller-identity']:
    print('{}')
    sys.exit(0)
response = json.loads((root / 'responses.json').read_text())[sys.argv[2]]
if response == 'ERROR':
    sys.exit(254)
print(json.dumps(response))
""")
            aws.chmod(0o755)
            sleep = root / "sleep"
            sleep.write_text("#!/bin/sh\nexit 0\n")
            sleep.chmod(0o755)
            env = {
                **os.environ, "PATH": f"{root}:{os.environ['PATH']}", "MOCK_ROOT": directory,
                "ECS_CLUSTER": "cluster", "ECS_SERVICE": "app", "ECS_TASK_DEFINITION": TASK,
                "DELIVERY_PIPELINE": PIPELINE, "DELIVERY_RUN": "11", "DELIVERY_STAGE": "dev",
                "ECS_GATE_STAGE": "checkpoint", "DELIVERY_OUTPUTS": str(root / "outputs.json"),
            }
            command = ["bash", str(SCRIPTS / ("discover-ecs-deployment.sh" if discover else "find-ecs-deployment.sh"))]
            if not discover:
                command.append("--allow-no-deployment")
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=15)
            outputs = json.loads((root / "outputs.json").read_text()) if (root / "outputs.json").exists() else None
            calls = (root / "calls").read_text().splitlines()
            return result, outputs, calls

    def test_verified_noop_skips_approval_only_after_rechecks(self):
        result, outputs, calls = self.run_discovery(responses(), discover=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {"result": "no-deployment", "deploymentArn": ""})
        self.assertEqual(calls.count("list-service-deployments"), 3)

    def test_matching_deployment_requires_approval_and_preserves_arn(self):
        data = responses()
        data["describe-service-deployments"]["serviceDeployments"][0]["deploymentConfiguration"]["lifecycleHooks"] = [hook("11")]
        result, outputs, calls = self.run_discovery(data, discover=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {"result": "deployment", "deploymentArn": ARN})
        self.assertNotIn("describe-services", calls)

    def test_uncertain_states_never_publish_a_noop(self):
        mutations = {
            "active deployment": lambda d: d["list-service-deployments"]["serviceDeployments"][0].update(status="IN_PROGRESS"),
            "rollback": lambda d: d["list-service-deployments"]["serviceDeployments"][0].update(status="ROLLBACK_SUCCESSFUL"),
            "no history": lambda d: d["list-service-deployments"].update(serviceDeployments=[]),
            "stale service": lambda d: d["describe-services"]["services"][0].update(taskDefinition="old"),
            "unhealthy service": lambda d: d["describe-services"]["services"][0].update(runningCount=0),
            "stale hook": lambda d: d["describe-services"]["services"][0]["deploymentConfiguration"].update(lifecycleHooks=[hook("10")]),
            "old deployed task": lambda d: d["describe-service-revisions"]["serviceRevisions"][0].update(taskDefinition="old"),
            "AWS failure": lambda d: d.update({"list-service-deployments": "ERROR"}),
            "describe failure": lambda d: d["describe-service-deployments"].update(failures=[{"reason": "MISSING"}]),
            "multiple matches": lambda d: d["describe-service-deployments"].update(serviceDeployments=[
                {"serviceDeploymentArn": arn, "deploymentConfiguration": {"lifecycleHooks": [hook("11")]}}
                for arn in [ARN, ARN + "2"]
            ]),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                data = copy.deepcopy(responses())
                mutate(data)
                result, outputs, _ = self.run_discovery(data, discover=True)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIsNone(outputs)


if __name__ == "__main__":
    unittest.main()
