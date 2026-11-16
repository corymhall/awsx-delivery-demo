export interface CheckpointConfig {
  stageName: string;
  completion: 'AutomatedTest' | 'Approval';
  testHeaderName: string;
  testHeaderValue: string;
}

export const checkpointConfig = {
  stageName: 'checkpoint',
  completion: 'AutomatedTest',
  testHeaderName: 'X-Deployment-Test',
  testHeaderValue: 'green',
} satisfies CheckpointConfig;
