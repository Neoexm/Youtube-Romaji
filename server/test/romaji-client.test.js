const test = require('node:test');
const assert = require('node:assert/strict');
const { createRomajiClient } = require('../lib/romaji-client');

test('python sidecar health reports the authoritative engine', async () => {
  const client = createRomajiClient();
  const health = await client.getHealth();

  assert.equal(health.name, 'python-pronunciation-pipeline');
  assert.match(health.mode, /full-stack|fallback/);
  assert.ok(!('kuroshiro' in health));
});

test('required pronunciation examples are produced through the Node client', async () => {
  const client = createRomajiClient();
  const examples = new Map([
    ['こんにちは', 'konnichiwa'],
    ['こんばんは', 'konbanwa'],
    ['学校', 'gakkou'],
    ['東京', 'toukyou'],
    ['大丈夫', 'daijoubu'],
    ['元気?', 'genki?'],
    ['コンピューター', 'konpyuutaa']
  ]);

  for (const [input, expected] of examples) {
    const result = await client.romanizeText(input, { source: 'node-test' });
    assert.equal(result.text, expected);
  }
});

test('batch romanization preserves order and line-oriented usage', async () => {
  const client = createRomajiClient();
  const batch = await client.romanizeBatch(['こんにちは', '東京', '元気?'], { source: 'batch-test' });

  assert.deepEqual(
    batch.items.map((item) => item.text),
    ['konnichiwa', 'toukyou', 'genki?']
  );
});
