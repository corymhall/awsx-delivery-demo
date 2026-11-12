import assert from 'node:assert/strict';
import test from 'node:test';

const { TEST_URL, TEST_HEADER_NAME, TEST_HEADER_VALUE } = process.env;
if (!TEST_URL || !TEST_HEADER_NAME || !TEST_HEADER_VALUE) {
  throw new Error('TEST_URL, TEST_HEADER_NAME, and TEST_HEADER_VALUE are required');
}

for (const path of ['/hello', '/world']) {
  test(`${path} returns a greeting`, async () => {
    const response = await fetch(new URL(path, TEST_URL), {
      headers: { [TEST_HEADER_NAME]: TEST_HEADER_VALUE },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; message: string };
    assert.equal(body.status, 'OK');
    assert.equal(body.message, 'Hello from the ECS native deployment demo!');
  });
}
