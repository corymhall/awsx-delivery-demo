// Project names also appear in each Pulumi.yaml.
export const deployment = {
  region: 'us-east-2',
  app: {
    project: 'awsx-delivery-demo',
    stack: 'dev',
    directory: 'infra',
    environment: 'awsx-delivery-demo/dev',
  },
  identity: {
    project: 'awsx-delivery-demo-identity',
    stack: 'dev',
  },
  pipeline: {
    project: 'awsx-delivery-demo-pipeline',
    stack: 'dev',
    repository: 'corymhall/awsx-delivery-demo',
    branch: 'main',
  },
} as const;
