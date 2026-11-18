export const web = {
  region: 'us-east-2',
  functionName: 'awsx-delivery-sse-dashboard-dev',
  productionEndpointName: 'production',
  infraProject: 'awsx-delivery-demo-infra-web',
  stack: 'dev',
  repository: 'corymhall/awsx-delivery-demo',
  branch: 'demo/lambda-web',
  awsEnvironment: 'awsx-delivery-demo/dev',
} as const;
