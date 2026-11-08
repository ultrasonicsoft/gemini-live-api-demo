// Runs the smoke test against tests/mock-gemini.mjs. No API key or network needed.
// This proves our wiring and our reading of the protocol. It cannot prove how the real model behaves.
import { spawn } from 'node:child_process';

const MOCK_PORT = 9099;
const BACKEND_PORT = 5299;
const children = [];

function start(command, args, env = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(child);
  return child;
}
const stopAll = () => children.forEach((child) => child.kill());
process.on('exit', stopAll);

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

start('node', ['tests/mock-gemini.mjs'], { MOCK_PORT: String(MOCK_PORT) });
start('dotnet', ['run', '--project', 'backend', '--no-launch-profile'], {
  GEMINI_API_KEY: 'mock-key',
  GEMINI_BASE_URL: `http://localhost:${MOCK_PORT}`,
  BACKEND_PORT: String(BACKEND_PORT),
});
await waitFor(`http://localhost:${BACKEND_PORT}/api/health`);

const smoke = spawn('node', ['scripts/smoke-test.mjs', ...process.argv.slice(2)], {
  env: { ...process.env, BACKEND_PORT: String(BACKEND_PORT), SMOKE_TIMEOUT_MS: '8000' },
  stdio: 'inherit',
});
smoke.on('exit', (code) => {
  stopAll();
  process.exit(code ?? 1);
});
