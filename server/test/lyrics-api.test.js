const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServerApp } = require('../index');
const { createRomajiClient } = require('../lib/romaji-client');

function createSilentLogger() {
  return {
    log() {},
    error() {},
    warn() {}
  };
}

function createMockMusixmatch(sequence) {
  let callIndex = 0;
  const calls = [];

  return {
    calls,
    async request(endpoint, params) {
      calls.push({ endpoint, params });
      const step = sequence[callIndex];
      callIndex += 1;
      if (!step) throw new Error(`Unexpected Musixmatch call: ${endpoint}`);
      assert.equal(step.endpoint, endpoint);
      if (step.assert) step.assert(params);
      if (step.error) throw step.error;
      return step.body;
    }
  };
}

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('lyrics endpoint uses the authoritative pipeline for final cues', async () => {
  const mock = createMockMusixmatch([
    {
      endpoint: 'track.search',
      body: {
        track_list: [
          {
            track: {
              track_name: 'Greeting Song',
              artist_name: 'Tester',
              commontrack_id: 101,
              has_subtitles: true
            }
          }
        ]
      }
    },
    {
      endpoint: 'track.subtitle.get',
      body: {
        subtitle: {
          subtitle_language: 'ja',
          subtitle_body: '[00:00.00]こんにちは\n[00:02.00]学校\n[00:04.00]東京'
        }
      }
    }
  ]);

  const { app } = createServerApp({
    logger: createSilentLogger(),
    mxmRequest: mock.request,
    romajiClient: createRomajiClient()
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/lyrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Tester - Greeting Song', artist: 'Tester', duration: 6 })
    });
    const payload = await response.json();

    assert.equal(payload.ok, true);
    assert.deepEqual(
      payload.cues.map((cue) => cue.text),
      ['konnichiwa', 'gakkou', 'toukyou']
    );
    assert.equal(payload.romajiEngine.name, 'python-pronunciation-pipeline');
  });
});

test('romanized search strategy uses the new pipeline instead of Kuroshiro', async () => {
  const mock = createMockMusixmatch([
    {
      endpoint: 'track.search',
      body: { track_list: [] }
    },
    {
      endpoint: 'matcher.track.get',
      body: { track: null }
    },
    {
      endpoint: 'track.search',
      assert(params) {
        assert.equal(params.q_track, 'toukyou');
      },
      body: {
        track_list: [
          {
            track: {
              track_name: '東京',
              artist_name: 'Tester',
              commontrack_id: 303,
              has_subtitles: true
            }
          }
        ]
      }
    },
    {
      endpoint: 'track.subtitle.get',
      body: {
        subtitle: {
          subtitle_language: 'ja',
          subtitle_body: '[00:00.00]東京'
        }
      }
    }
  ]);

  const { app } = createServerApp({
    logger: createSilentLogger(),
    mxmRequest: mock.request,
    romajiClient: createRomajiClient()
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/lyrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '東京', artist: 'Tester', duration: 4 })
    });
    const payload = await response.json();

    assert.equal(payload.ok, true);
    assert.equal(payload.cues[0].text, 'toukyou');
  });
});

test('health endpoint no longer reports Kuroshiro as the active engine', async () => {
  const { app } = createServerApp({
    logger: createSilentLogger(),
    mxmRequest: async () => ({ track_list: [] }),
    romajiClient: createRomajiClient()
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const payload = await response.json();

    assert.equal(payload.status, 'ok');
    assert.equal(payload.engine.name, 'python-pronunciation-pipeline');
    assert.ok(!('kuroshiro' in payload.engine));
  });
});
