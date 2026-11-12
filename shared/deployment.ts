// Project names also appear in each Pulumi.yaml.
export const deployment = {
  region: 'us-east-2',
  app: {
    project: 'awsx-delivery-demo',
    stack: 'dev',
    directory: 'infra',
    environment: 'awsx-delivery-demo/dev',
  },
  pipeline: {
    project: 'awsx-delivery-demo-pipeline',
    stack: 'dev',
    directory: 'pipeline',
    repository: 'corymhall/awsx-delivery-demo',
    branch: 'main',
  },
} as const;
