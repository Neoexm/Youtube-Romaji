const { spawn } = require('node:child_process');
const path = require('node:path');

const DEFAULT_ENGINE_VERSION = 'pronunciation-sidecar-v1';

function collectStream(stream) {
  return new Promise((resolve) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
    });
    stream.on('end', () => resolve(buffer));
  });
}

function runSidecar({ pythonBin, scriptPath, timeoutMs, env, payload }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: path.dirname(scriptPath),
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(new Error(`Python sidecar timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const stdoutPromise = collectStream(child.stdout);
    const stderrPromise = collectStream(child.stderr);

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`Failed to start python sidecar (${pythonBin}): ${error.message}`));
    });

    child.on('close', async (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Python sidecar exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (error) {
        reject(new Error(`Invalid JSON from python sidecar: ${error.message}\n${stdout}\n${stderr}`));
      }
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();
  });
}

function createRomajiClient(options = {}) {
  const pythonBin = options.pythonBin
    || process.env.ROMAJI_PYTHON_BIN
    || (process.platform === 'win32' ? 'python' : 'python3');
  const scriptPath = options.scriptPath || path.join(__dirname, '..', 'python', 'romanize_cli.py');
  const timeoutMs = Number(options.timeoutMs || process.env.ROMAJI_PYTHON_TIMEOUT_MS || 45000);
  const env = {
    ...process.env,
    PYTHONIOENCODING: process.env.PYTHONIOENCODING || 'utf-8',
    PYTHONUTF8: process.env.PYTHONUTF8 || '1',
    ...(options.env || {})
  };

  async function invoke(action, body = {}) {
    const response = await runSidecar({
      pythonBin,
      scriptPath,
      timeoutMs,
      env,
      payload: { action, ...body }
    });

    if (!response?.ok) {
      throw new Error(response?.error || `Python sidecar failed for ${action}`);
    }

    return response;
  }

  return {
    engineName: 'python-pronunciation-pipeline',
    engineVersion: DEFAULT_ENGINE_VERSION,
    async getHealth() {
      const response = await invoke('health');
      return response.health;
    },
    async romanizeText(text, context = {}) {
      const response = await invoke('romanize_text', { text, context });
      return response.result;
    },
    async romanizeBatch(texts, context = {}) {
      const response = await invoke('romanize_batch', { texts, context });
      return response.result;
    }
  };
}

module.exports = {
  DEFAULT_ENGINE_VERSION,
  createRomajiClient
};
