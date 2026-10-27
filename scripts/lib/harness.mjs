// Shared helpers for integration scripts: free port, isolated data dirs, server lifecycle.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** Env with every real credential removed so tests never touch live AI/Supabase. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(OPENAI|GEMINI|ANTHROPIC|SUPABASE|VITE_SUPABASE|DOCAI_|AI_PROVIDER|VERCEL|APP_ORIGIN|TRUST_PROXY)/.test(k)) delete env[k];
  }
  return { ...env, NODE_ENV: 'development', DISABLE_HMR: 'true', ...extra };
}

export async function startServer(extraEnv = {}, { port } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), 'docai-it-'));
  const p = port || await freePort();
  const env = cleanEnv({
    PORT: String(p),
    HOST: '127.0.0.1',
    LOCAL_DATA_PATH: path.join(temp, 'data.json'),
    LOCAL_SETTINGS_DIR: path.join(temp, 'settings'),
    LOCAL_FILES_DIR: path.join(temp, 'files'),
    LOCAL_JOBS_PATH: path.join(temp, 'jobs.json'),
    ...extraEnv,
  });
  // dotenv must not re-inject the developer's .env.local keys: point it at an empty cwd copy is overkill; instead
  // we pass explicit empty values which dotenv never overrides.
  // dotenv never overrides variables that are already set (even to ''), so blanking them keeps a developer's
  // .env.local (real keys, DOCAI_DEMO_ADMIN, users, webhooks…) out of the tests.
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEY1', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY',
    'DOCAI_DEMO_ADMIN', 'DOCAI_USERS', 'DOCAI_INTEGRATION_KEY', 'DOCAI_INTEGRATION_KEYS', 'DOCAI_WEBHOOK_URL', 'DOCAI_WEBHOOK_SECRET',
    'DOCAI_SESSION_SECRET', 'DOCAI_CRON_SECRET', 'AI_PROVIDER', 'APP_ORIGIN', 'DOCAI_QUEUE']) if (!(k in env)) env[k] = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'app.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout\n' + output)), 45000);
    child.stdout.on('data', (d) => { output += d; if (String(d).includes('Server running')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (d) => { output += d; if (process.env.DEBUG_TESTS) process.stderr.write(d); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited: ${code}\n${output}`)); });
  });
  const base = `http://localhost:${p}`;
  return {
    base, port: p, temp, env,
    logs: () => output,
    async stop() { child.kill(); await new Promise((r) => setTimeout(r, 150)); await rm(temp, { recursive: true, force: true }); },
  };
}

/** Standalone worker process (`worker.ts`) sharing the same env/data dirs as a server. */
export async function startWorkerProcess(env) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'worker.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker startup timeout\n' + output)), 30000);
    child.stdout.on('data', (d) => { output += d; if (String(d).includes('[worker] started')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (d) => { output += d; if (process.env.DEBUG_TESTS) process.stderr.write(d); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`worker exited: ${code}\n${output}`)); });
  });
  return { logs: () => output, stop: async () => { child.kill(); await new Promise((r) => setTimeout(r, 150)); } };
}
