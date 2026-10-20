import { execFileSync } from 'child_process';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';

// DynamoDB Local in Docker, so the Provider's conditional writes and transactions run against
// the real DynamoDB semantics, not a mock. Skipped (tests that need it skip too) without Docker.
const PORT = 8123;
const NAME = 'pact-test-ddb';

export default async function setup() {
  try {
    execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    execFileSync('docker', ['run', '-d', '--rm', '--name', NAME, '-p', `${PORT}:8000`, 'amazon/dynamodb-local', '-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'], { stdio: 'ignore' });
  } catch {
    console.warn('Docker unavailable: DynamoDB-backed PACT tests will be skipped');
    return () => {};
  }
  process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${PORT}`;
  process.env.PACT_TEST_DDB = '1';
  const client = new DynamoDBClient({ region: 'us-east-1', endpoint: process.env.DYNAMODB_ENDPOINT, credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });
  for (let i = 0; i < 60; i++) {
    try {
      await client.send(new CreateTableCommand({
        TableName: 'pact-test',
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      }));
      break;
    } catch (err) {
      if ((err as Error).name === 'ResourceInUseException') break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return () => {
    try { execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' }); } catch { /* already gone */ }
  };
}
