export interface CheckpointConfig {
  stageName: string;
  conditionName: string;
  completion: 'AutomatedTest' | 'Approval';
  testHeaderName: string;
  testHeaderValue: string;
}

export const checkpointConfig = {
  stageName: 'checkpoint',
  conditionName: 'pause-hook',
  completion: 'AutomatedTest',
  testHeaderName: 'X-Deployment-Test',
  testHeaderValue: 'green',
} satisfies CheckpointConfig;
